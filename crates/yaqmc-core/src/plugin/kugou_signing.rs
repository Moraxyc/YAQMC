use std::collections::BTreeMap;

use base64::Engine;
use md5::{Digest, Md5};
use rsa::{pkcs8::DecodePublicKey, traits::PublicKeyParts, BigUint, RsaPublicKey};
use serde_json::Value;

use super::{component_host::ComponentHostContext, network::component_request_origin};

pub(super) fn apply_credential_query_signing(
    host: &ComponentHostContext,
    allow_credentials: bool,
    payload: &mut Value,
) -> Result<(), String> {
    let Some(binding) = payload.get("credentialQuerySigning") else {
        return Ok(());
    };
    if !allow_credentials {
        return Err("component credentials were not granted".to_owned());
    }
    let scheme = binding
        .get("scheme")
        .and_then(Value::as_str)
        .unwrap_or_default();
    if !matches!(
        scheme,
        "kugou-android" | "kugou-user-info" | "kugou-cloud-list" | "kugou-play-history"
    ) {
        return Err("component credential signing scheme is not supported".to_owned());
    }
    let origin = component_request_origin(payload)?;
    let method = payload
        .get("method")
        .and_then(Value::as_str)
        .unwrap_or("GET");
    let mut url = reqwest::Url::parse(payload["url"].as_str().unwrap_or_default())
        .map_err(|_| "component network URL is invalid".to_owned())?;
    let user_info = scheme == "kugou-user-info";
    let cloud_list = scheme == "kugou-cloud-list";
    let play_history = scheme == "kugou-play-history";
    if !["https://gateway.kugou.com", "https://trackercdn.kugou.com"].contains(&origin.as_str())
        || (!user_info && !cloud_list && !play_history && method != "GET")
        || (play_history
            && (origin != "https://gateway.kugou.com"
                || method != "POST"
                || url.path() != "/playhistory/v1/get_songs"
                || payload
                    .get("headers")
                    .and_then(Value::as_object)
                    .is_some_and(|headers| {
                        headers
                            .keys()
                            .any(|key| key.eq_ignore_ascii_case("x-router"))
                    })
                || payload.get("body").and_then(Value::as_str).is_none()
                || payload.get("credentialBodyFields").is_some()))
        || (cloud_list
            && (origin != "https://gateway.kugou.com"
                || method != "POST"
                || !matches!(url.path(), "/v7/get_all_list" | "/v4/get_list_all_file_v3")
                || payload
                    .get("headers")
                    .and_then(|headers| headers.get("x-router"))
                    .and_then(Value::as_str)
                    != Some("cloudlist.service.kugou.com")
                || payload.get("body").and_then(Value::as_str).is_none()
                || payload.get("credentialBodyFields").is_some()))
        || (user_info
            && (origin != "https://gateway.kugou.com"
                || method != "POST"
                || url.path() != "/v3/get_my_info"
                || payload
                    .get("headers")
                    .and_then(|headers| headers.get("x-router"))
                    .and_then(Value::as_str)
                    != Some("usercenter.kugou.com")
                || payload
                    .get("body")
                    .is_some_and(|body| !body.is_null() && body.as_str() != Some(""))
                || payload.get("credentialBodyFields").is_some()))
    {
        return Err("component credential signing endpoint is not allowed".to_owned());
    }
    let handle = binding
        .get("handle")
        .and_then(Value::as_str)
        .ok_or_else(|| "component credential handle is required".to_owned())?;
    let fenced = payload
        .get("credentialHeaders")
        .and_then(Value::as_array)
        .is_some_and(|headers| {
            headers.iter().any(|header| {
                header.get("handle").and_then(Value::as_str) == Some(handle)
                    && header.get("name").and_then(Value::as_str) == Some("cookie")
            })
        });
    if !fenced {
        return Err("component signed credentials require an origin-bound header".to_owned());
    }
    let secret = host.credential_resolve(handle, &origin)?;
    let mut session = BTreeMap::new();
    for field in secret.split(';') {
        let Some((name, value)) = field.trim().split_once('=') else {
            continue;
        };
        if ["token", "userid"].contains(&name) && session.insert(name, value.trim()).is_some() {
            return Err("component KuGou credential is invalid".to_owned());
        }
    }
    let token = session
        .get("token")
        .copied()
        .filter(|value| {
            !value.is_empty() && value.len() <= 8192 && !value.chars().any(char::is_control)
        })
        .ok_or_else(|| "component KuGou credential is invalid".to_owned())?;
    let userid = session
        .get("userid")
        .copied()
        .filter(|value| value.parse::<u64>().is_ok_and(|value| value > 0))
        .ok_or_else(|| "component KuGou credential is invalid".to_owned())?;
    let mut params = BTreeMap::new();
    for (name, value) in url.query_pairs() {
        if params.len() >= 64
            || params
                .insert(name.into_owned(), value.into_owned())
                .is_some()
        {
            return Err("component signing query is invalid".to_owned());
        }
    }
    if params.get("appid").map(String::as_str) != Some("1005") {
        return Err("component signing app ID is not supported".to_owned());
    }
    params.insert("token".to_owned(), token.to_owned());
    params.insert("userid".to_owned(), userid.to_owned());
    params.remove("signature");
    let body = if user_info {
        if params.get("plat").map(String::as_str) != Some("1") {
            return Err("component user-info platform is not supported".to_owned());
        }
        let clienttime = params
            .get("clienttime")
            .and_then(|value| value.parse::<u64>().ok())
            .filter(|value| *value > 0)
            .ok_or_else(|| "component user-info time is invalid".to_owned())?;
        user_info_body(token, userid, clienttime)?
    } else if cloud_list {
        let raw = payload
            .get("body")
            .and_then(Value::as_str)
            .ok_or_else(|| "component cloud-list body is required".to_owned())?;
        cloud_list_body(raw, url.path(), token, userid)?
    } else if play_history {
        play_history_body(payload["body"].as_str().unwrap_or_default(), token, userid)?
    } else {
        String::new()
    };
    if params.contains_key("key") {
        let hash = params
            .get("hash")
            .map(String::as_str)
            .ok_or_else(|| "component signing hash is required".to_owned())?;
        let mid = params
            .get("mid")
            .map(String::as_str)
            .ok_or_else(|| "component signing device is required".to_owned())?;
        let key = md5_hex(&format!(
            "{hash}57ae12eb6890223e355ccfcb74edf70d1005{mid}{userid}"
        ));
        params.insert("key".to_owned(), key);
    }
    let mut signed = "OIlwieks28dk2k092lksi2UIkp".to_owned();
    for (name, value) in &params {
        signed.push_str(name);
        signed.push('=');
        signed.push_str(value);
    }
    signed.push_str(&body);
    signed.push_str("OIlwieks28dk2k092lksi2UIkp");
    params.insert("signature".to_owned(), md5_hex(&signed));
    url.query_pairs_mut().clear().extend_pairs(params);
    payload["url"] = Value::String(url.to_string());
    if user_info || cloud_list || play_history {
        payload["body"] = Value::String(body);
        payload["headers"]["content-type"] = Value::String("application/json".to_owned());
    }
    Ok(())
}

fn play_history_body(raw: &str, token: &str, userid: &str) -> Result<String, String> {
    if raw.len() > 4096 {
        return Err("component play-history body is too large".to_owned());
    }
    let mut body: Value = serde_json::from_str(raw)
        .map_err(|_| "component play-history body is invalid".to_owned())?;
    let object = body
        .as_object_mut()
        .ok_or_else(|| "component play-history body must be an object".to_owned())?;
    if object
        .keys()
        .any(|key| !["source_classify", "to_subdivide_sr", "bp"].contains(&key.as_str()))
        || object.get("source_classify").and_then(Value::as_str) != Some("app")
        || object.get("to_subdivide_sr").and_then(Value::as_u64) != Some(1)
        || object.get("bp").is_some_and(|bp| {
            !bp.as_str().is_some_and(|s| {
                !s.is_empty() && s.len() <= 1024 && !s.chars().any(char::is_control)
            })
        })
    {
        return Err("component play-history parameters are invalid".to_owned());
    }
    object.insert("token".to_owned(), Value::String(token.to_owned()));
    object.insert("userid".to_owned(), Value::String(userid.to_owned()));
    serde_json::to_string(&body)
        .map_err(|_| "component play-history body could not be encoded".to_owned())
}

fn cloud_list_body(raw: &str, path: &str, token: &str, userid: &str) -> Result<String, String> {
    if raw.len() > 4096 {
        return Err("component cloud-list body is too large".to_owned());
    }
    let mut body: Value =
        serde_json::from_str(raw).map_err(|_| "component cloud-list body is invalid".to_owned())?;
    let object = body
        .as_object_mut()
        .ok_or_else(|| "component cloud-list body must be an object".to_owned())?;
    let fields: &[&str] = if path == "/v7/get_all_list" {
        &["total_ver", "type", "page", "pagesize"]
    } else {
        &[
            "listid",
            "type",
            "page",
            "pagesize",
            "area_code",
            "allplatform",
            "show_cover",
        ]
    };
    if object.len() != fields.len()
        || object.keys().any(|field| !fields.contains(&field.as_str()))
        || !object
            .get("page")
            .and_then(Value::as_u64)
            .is_some_and(|page| (1..=1_000_001).contains(&page))
        || !object
            .get("pagesize")
            .and_then(Value::as_u64)
            .is_some_and(|limit| (1..=50).contains(&limit))
    {
        return Err("component cloud-list parameters are invalid".to_owned());
    }
    if path == "/v7/get_all_list" {
        if object.get("total_ver").and_then(Value::as_u64) != Some(979)
            || object.get("type").and_then(Value::as_u64) != Some(2)
        {
            return Err("component cloud-list parameters are invalid".to_owned());
        }
    } else if !object
        .get("listid")
        .and_then(Value::as_str)
        .is_some_and(|id| id.parse::<u64>().is_ok_and(|id| id > 0))
        || object
            .get("type")
            .and_then(Value::as_u64)
            .is_none_or(|kind| kind > 1)
        || ["area_code", "allplatform", "show_cover"]
            .iter()
            .any(|field| object.get(*field).and_then(Value::as_u64) != Some(1))
    {
        return Err("component cloud-list parameters are invalid".to_owned());
    }
    object.insert("token".to_owned(), Value::String(token.to_owned()));
    object.insert("userid".to_owned(), Value::String(userid.to_owned()));
    serde_json::to_string(&body)
        .map_err(|_| "component cloud-list body could not be encoded".to_owned())
}

fn user_info_body(token: &str, userid: &str, clienttime: u64) -> Result<String, String> {
    let public_key_der = base64::engine::general_purpose::STANDARD.decode("MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQDIAG7QOELSYoIJvTFJhMpe1s/gbjDJX51HBNnEl5HXqTW6lQ7LC8jr9fWZTwusknp+sVGzwd40MwP6U5yDE27M/X1+UR4tvOGOqp94TJtQ1EPnWGWXngpeIW5GxoQGao1rmYWAu6oi1z9XkChrsUdC6DJE5E221wf/4WLFxwAtRQIDAQAB")
        .map_err(|_| "component user-info public key is invalid".to_owned())?;
    let public_key = RsaPublicKey::from_public_key_der(&public_key_der)
        .map_err(|_| "component user-info public key is invalid".to_owned())?;
    let token = serde_json::to_string(token)
        .map_err(|_| "component user-info token is invalid".to_owned())?;
    let plaintext = format!("{{\"token\":{token},\"clienttime\":{clienttime}}}");
    if plaintext.len() > public_key.size() {
        return Err("component user-info token is too large".to_owned());
    }
    let mut padded = vec![0_u8; public_key.size()];
    padded[..plaintext.len()].copy_from_slice(plaintext.as_bytes());
    let encrypted = BigUint::from_bytes_be(&padded).modpow(public_key.e(), public_key.n());
    let encrypted = format!("{encrypted:0width$X}", width = public_key.size() * 2);
    let userid = userid
        .parse::<u64>()
        .map_err(|_| "component user-info identity is invalid".to_owned())?;
    Ok(format!(
        "{{\"visit_time\":{clienttime},\"usertype\":1,\"p\":\"{encrypted}\",\"userid\":{userid}}}"
    ))
}

fn md5_hex(value: &str) -> String {
    format!("{:x}", Md5::digest(value.as_bytes()))
}

#[cfg(test)]
mod tests {
    use std::{collections::HashSet, sync::Arc};

    use serde_json::json;

    use crate::{
        credentials::MemoryCredentialStore, plugin::component_host::ComponentHostServices,
    };

    use super::*;

    fn payload(origin: &str, handle: &str) -> Value {
        json!({
            "method": "GET",
            "url": format!("{origin}/v5/url?hash=abcdef&appid=1005&mid=1234&key=old&signature=old"),
            "credentialHeaders": [{"name": "cookie", "handle": handle}],
            "credentialQuerySigning": {"scheme": "kugou-android", "handle": handle}
        })
    }

    fn user_info_payload(handle: &str) -> Value {
        json!({
            "method": "POST",
            "url": "https://gateway.kugou.com/v3/get_my_info?appid=1005&clienttime=1700000000&mid=1234&plat=1",
            "headers": {"x-router": "usercenter.kugou.com"},
            "credentialHeaders": [{"name": "cookie", "handle": handle}],
            "credentialQuerySigning": {"scheme": "kugou-user-info", "handle": handle}
        })
    }

    fn cloud_list_payload(handle: &str, path: &str) -> Value {
        json!({
            "method": "POST",
            "url": format!("https://gateway.kugou.com{path}?appid=1005&clienttime=1700000000&mid=1234&plat=1"),
            "headers": {"x-router": "cloudlist.service.kugou.com"},
            "body": if path == "/v7/get_all_list" {
                "{\"total_ver\":979,\"type\":2,\"page\":1,\"pagesize\":20}"
            } else {
                "{\"listid\":\"42\",\"type\":0,\"page\":1,\"pagesize\":20,\"area_code\":1,\"allplatform\":1,\"show_cover\":1}"
            },
            "credentialHeaders": [{"name": "cookie", "handle": handle}],
            "credentialQuerySigning": {"scheme": "kugou-cloud-list", "handle": handle}
        })
    }

    fn play_history_payload(handle: &str) -> Value {
        json!({
            "method": "POST",
            "url": "https://gateway.kugou.com/playhistory/v1/get_songs?appid=1005&clienttime=1700000000&mid=1234",
            "headers": {},
            "body": "{\"source_classify\":\"app\",\"to_subdivide_sr\":1,\"bp\":\"page-2\"}",
            "credentialHeaders": [{"name": "cookie", "handle": handle}],
            "credentialQuerySigning": {"scheme": "kugou-play-history", "handle": handle}
        })
    }

    #[tokio::test]
    async fn play_history_signing_is_read_only_and_binds_body_and_credentials() {
        let root = tempfile::tempdir().unwrap();
        let services = ComponentHostServices::open(
            root.path().join("data"),
            root.path().join("cache"),
            Arc::new(MemoryCredentialStore::default()),
            tokio::runtime::Handle::current(),
        )
        .unwrap();
        let origin = "https://gateway.kugou.com";
        let allowed = HashSet::from([origin.to_owned(), "https://trackercdn.kugou.com".to_owned()]);
        let host = services.for_plugin("test.music", "test.music.kugou", allowed.clone());
        let other = services.for_plugin("test.other", "test.other.kugou", allowed);
        let handle = host
            .credential_create(origin, "token=synthetic-token; userid=42")
            .unwrap();
        let mut request = play_history_payload(&handle);
        apply_credential_query_signing(&host, true, &mut request).unwrap();
        let body: Value = serde_json::from_str(request["body"].as_str().unwrap()).unwrap();
        assert_eq!(body["token"], "synthetic-token");
        assert_eq!(body["userid"], "42");
        assert_eq!(body["bp"], "page-2");
        let url = reqwest::Url::parse(request["url"].as_str().unwrap()).unwrap();
        let params: BTreeMap<_, _> = url.query_pairs().into_owned().collect();
        let mut signed = "OIlwieks28dk2k092lksi2UIkp".to_owned();
        for (key, value) in params.iter().filter(|(key, _)| key.as_str() != "signature") {
            signed.push_str(&format!("{key}={value}"));
        }
        signed.push_str(request["body"].as_str().unwrap());
        signed.push_str("OIlwieks28dk2k092lksi2UIkp");
        assert_eq!(params["signature"], md5_hex(&signed));
        assert!(
            apply_credential_query_signing(&host, false, &mut play_history_payload(&handle))
                .is_err()
        );
        assert!(
            apply_credential_query_signing(&other, true, &mut play_history_payload(&handle))
                .is_err()
        );
        for (field, value) in [
            ("method", json!("GET")),
            (
                "url",
                json!("https://gateway.kugou.com/playhistory/v1/upload_songs?appid=1005"),
            ),
            (
                "url",
                json!("https://trackercdn.kugou.com/playhistory/v1/get_songs?appid=1005"),
            ),
            ("headers", json!({"x-router":"other.kugou.com"})),
            ("headers", json!({"X-Router":"other.kugou.com"})),
            (
                "body",
                json!("{\"source_classify\":\"app\",\"to_subdivide_sr\":1,\"token\":\"forged\"}"),
            ),
            (
                "body",
                json!("{\"source_classify\":\"app\",\"to_subdivide_sr\":1,\"bp\":3}"),
            ),
            ("credentialHeaders", json!([])),
            ("credentialBodyFields", json!([])),
        ] {
            let mut invalid = play_history_payload(&handle);
            invalid[field] = value;
            let original = invalid.clone();
            assert!(
                apply_credential_query_signing(&host, true, &mut invalid).is_err(),
                "{field}"
            );
            assert_eq!(invalid, original);
        }
    }

    #[tokio::test]
    async fn user_info_body_and_signature_match_the_upstream_golden_vector() {
        let root = tempfile::tempdir().expect("root");
        let services = ComponentHostServices::open(
            root.path().join("data"),
            root.path().join("cache"),
            Arc::new(MemoryCredentialStore::default()),
            tokio::runtime::Handle::current(),
        )
        .expect("services");
        let origin = "https://gateway.kugou.com";
        let host = services.for_plugin(
            "test.music",
            "test.music.kugou",
            HashSet::from([origin.to_owned()]),
        );
        let handle = host
            .credential_create(origin, "token=synthetic-token; userid=42")
            .expect("credential");
        let mut request = user_info_payload(&handle);
        apply_credential_query_signing(&host, true, &mut request).expect("user info signing");
        let body = request["body"].as_str().expect("body");
        let decoded: Value = serde_json::from_str(body).expect("JSON body");
        assert_eq!(
            decoded["p"],
            "963C633E27C6F793E67C78EF9B3EF9D62E50740BF09F38B5C6D79B2B7BE701902722446E801580FB5790EF12BAA4A9CC70E033229741614637E9B35CCA90BE7A25F78A3DEE7FCD658EE7C3E9BA3846385583191F381E6227816DF591C70B5668E142E9EA0FC60C7376C399126AB63A27DC22FA94E6155E61DC0D2F00AFC37DDC"
        );
        assert_eq!(decoded["userid"], 42);
        assert_eq!(decoded["visit_time"], 1700000000_u64);
        assert!(!body.contains("synthetic-token"));
        assert_eq!(request["headers"]["content-type"], "application/json");
        let url = reqwest::Url::parse(request["url"].as_str().expect("URL")).expect("URL");
        let params: BTreeMap<_, _> = url.query_pairs().into_owned().collect();
        assert_eq!(params["signature"], "39eb51b0f73c29898d010d0f4750a0c4");
    }

    #[tokio::test]
    async fn user_info_signing_is_pinned_to_a_read_only_origin_path_method_and_router() {
        let root = tempfile::tempdir().expect("root");
        let services = ComponentHostServices::open(
            root.path().join("data"),
            root.path().join("cache"),
            Arc::new(MemoryCredentialStore::default()),
            tokio::runtime::Handle::current(),
        )
        .expect("services");
        let origin = "https://gateway.kugou.com";
        let allowed = HashSet::from([origin.to_owned(), "https://trackercdn.kugou.com".to_owned()]);
        let host = services.for_plugin("test.music", "test.music.kugou", allowed.clone());
        let other = services.for_plugin("test.other", "test.other.kugou", allowed);
        let handle = host
            .credential_create(origin, "token=synthetic-token; userid=42")
            .expect("credential");
        assert!(
            apply_credential_query_signing(&host, false, &mut user_info_payload(&handle)).is_err()
        );
        assert!(
            apply_credential_query_signing(&other, true, &mut user_info_payload(&handle)).is_err()
        );
        for (field, value) in [
            ("method", json!("GET")),
            ("method", json!("PUT")),
            (
                "url",
                json!(
                    "https://trackercdn.kugou.com/v3/get_my_info?appid=1005&clienttime=1700000000&plat=1"
                ),
            ),
            (
                "url",
                json!(
                    "https://gateway.kugou.com/v3/set_my_info?appid=1005&clienttime=1700000000&plat=1"
                ),
            ),
            (
                "url",
                json!(
                    "https://gateway.kugou.com/v3/get_my_info?appid=1005&clienttime=invalid&plat=1"
                ),
            ),
            (
                "url",
                json!(
                    "https://gateway.kugou.com/v3/get_my_info?appid=1005&clienttime=1700000000&plat=2"
                ),
            ),
            ("headers", json!({"x-router": "other.kugou.com"})),
            ("headers", Value::Null),
            ("body", json!("{\"token\":\"chosen-plaintext\"}")),
            ("credentialBodyFields", json!([])),
            ("credentialHeaders", json!([])),
        ] {
            let mut request = user_info_payload(&handle);
            request[field] = value;
            let original = request.clone();
            assert!(
                apply_credential_query_signing(&host, true, &mut request).is_err(),
                "{field}"
            );
            assert_eq!(request, original);
        }
        assert!(user_info_body(&"x".repeat(129), "42", 1700000000).is_err());
        host.revoke();
        assert!(
            apply_credential_query_signing(&host, true, &mut user_info_payload(&handle)).is_err()
        );
    }

    #[tokio::test]
    async fn cloud_list_signing_injects_credentials_only_into_allowed_json_requests() {
        let root = tempfile::tempdir().expect("root");
        let services = ComponentHostServices::open(
            root.path().join("data"),
            root.path().join("cache"),
            Arc::new(MemoryCredentialStore::default()),
            tokio::runtime::Handle::current(),
        )
        .expect("services");
        let origin = "https://gateway.kugou.com";
        let host = services.for_plugin(
            "test.music",
            "test.music.kugou",
            HashSet::from([origin.to_owned()]),
        );
        let handle = host
            .credential_create(origin, "token=synthetic-token; userid=42")
            .expect("credential");
        let mut request = cloud_list_payload(&handle, "/v7/get_all_list");
        apply_credential_query_signing(&host, true, &mut request).expect("cloud list signing");
        let body = request["body"].as_str().expect("body");
        let body: Value = serde_json::from_str(body).expect("JSON body");
        assert_eq!(body["token"], "synthetic-token");
        assert_eq!(body["userid"], "42");
        assert!(request["url"]
            .as_str()
            .expect("url")
            .contains("token=synthetic-token"));
        assert!(request["url"].as_str().expect("url").contains("signature="));

        let mut forged = cloud_list_payload(&handle, "/v7/get_all_list");
        forged["body"] = json!("{\"token\":\"caller-token\"}");
        assert!(apply_credential_query_signing(&host, true, &mut forged).is_err());

        let mut wrong_path = cloud_list_payload(&handle, "/v7/other");
        assert!(apply_credential_query_signing(&host, true, &mut wrong_path).is_err());

        for (field, value) in [
            ("method", json!("GET")),
            (
                "url",
                json!("https://evil.example/v7/get_all_list?appid=1005"),
            ),
            ("headers", json!({"x-router": "other.kugou.com"})),
            ("credentialBodyFields", json!([])),
            (
                "body",
                json!("{\"total_ver\":979,\"type\":3,\"page\":1,\"pagesize\":20}"),
            ),
            (
                "body",
                json!("{\"total_ver\":979,\"type\":2,\"page\":0,\"pagesize\":20}"),
            ),
        ] {
            let mut invalid = cloud_list_payload(&handle, "/v7/get_all_list");
            invalid[field] = value;
            let original = invalid.clone();
            assert!(
                apply_credential_query_signing(&host, true, &mut invalid).is_err(),
                "{field}"
            );
            assert_eq!(invalid, original);
        }
        let mut oversized = cloud_list_payload(&handle, "/v7/get_all_list");
        oversized["body"] = json!("x".repeat(4097));
        let original = oversized.clone();
        assert!(apply_credential_query_signing(&host, true, &mut oversized).is_err());
        assert_eq!(oversized, original);
    }

    #[tokio::test]
    async fn session_query_signature_matches_the_upstream_protocol() {
        let root = tempfile::tempdir().expect("root");
        let services = ComponentHostServices::open(
            root.path().join("data"),
            root.path().join("cache"),
            Arc::new(MemoryCredentialStore::default()),
            tokio::runtime::Handle::current(),
        )
        .expect("services");
        let origin = "https://trackercdn.kugou.com";
        let host = services.for_plugin(
            "test.music",
            "test.music.kugou",
            HashSet::from([origin.to_owned()]),
        );
        let handle = host
            .credential_create(origin, "token=synthetic-token; userid=42")
            .expect("credential");
        let mut request = payload(origin, &handle);
        apply_credential_query_signing(&host, true, &mut request).expect("signed query");
        let url = reqwest::Url::parse(request["url"].as_str().expect("URL")).expect("URL");
        let params: BTreeMap<_, _> = url.query_pairs().into_owned().collect();
        assert_eq!(params["token"], "synthetic-token");
        assert_eq!(params["userid"], "42");
        assert_eq!(params["key"], "f0f91b0b1ffae69adfcd9c8c4448d4e6");
        assert_eq!(params["signature"], "5d51df7ce3436fccbe85e63d28f3d115");
        host.revoke();
        assert!(apply_credential_query_signing(&host, true, &mut request).is_err());
    }

    #[tokio::test]
    async fn signing_requires_account_authority_and_exact_credential_origin() {
        let root = tempfile::tempdir().expect("root");
        let services = ComponentHostServices::open(
            root.path().join("data"),
            root.path().join("cache"),
            Arc::new(MemoryCredentialStore::default()),
            tokio::runtime::Handle::current(),
        )
        .expect("services");
        let origin = "https://trackercdn.kugou.com";
        let allowed = HashSet::from([origin.to_owned(), "https://gateway.kugou.com".to_owned()]);
        let host = services.for_plugin("test.music", "test.music.kugou", allowed.clone());
        let other = services.for_plugin("test.other", "test.other.kugou", allowed);
        let handle = host
            .credential_create(origin, "token=synthetic-token; userid=42")
            .expect("credential");
        assert!(
            apply_credential_query_signing(&host, false, &mut payload(origin, &handle)).is_err()
        );
        assert!(
            apply_credential_query_signing(&other, true, &mut payload(origin, &handle)).is_err()
        );
        assert!(apply_credential_query_signing(
            &host,
            true,
            &mut payload("https://gateway.kugou.com", &handle)
        )
        .is_err());
        assert!(apply_credential_query_signing(
            &host,
            true,
            &mut payload("https://evil.example", &handle)
        )
        .is_err());
        let mut request = payload(origin, &handle);
        request["method"] = json!("POST");
        assert!(apply_credential_query_signing(&host, true, &mut request).is_err());
        let mut request = payload(origin, &handle);
        request
            .as_object_mut()
            .expect("request")
            .remove("credentialHeaders");
        assert!(apply_credential_query_signing(&host, true, &mut request).is_err());
        let mut request = payload(origin, &handle);
        request["url"] = json!(format!("{origin}/v5/url?appid=1005&appid=1005"));
        assert!(apply_credential_query_signing(&host, true, &mut request).is_err());
        for secret in [
            "token=; userid=42",
            "token=synthetic-token; userid=0",
            "token=synthetic-token; userid=invalid",
            "token=first; token=second; userid=42",
        ] {
            let handle = host.credential_create(origin, secret).expect("credential");
            let mut request = payload(origin, &handle);
            let original = request.clone();
            assert!(apply_credential_query_signing(&host, true, &mut request).is_err());
            assert_eq!(request, original);
        }
    }
}
