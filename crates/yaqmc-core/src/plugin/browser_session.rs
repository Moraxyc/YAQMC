use std::collections::{BTreeMap, BTreeSet};

use yaqmc_provider_api::{
    BrowserSessionCookie, BrowserSessionFormat, BrowserSessionPolicy, ProviderCommandError,
    ProviderResult,
};

use super::component_host::ComponentHostContext;

fn invalid() -> ProviderCommandError {
    ProviderCommandError::invalid_request("provider browser session is invalid")
}

pub(super) fn validate_policy(
    host: &ComponentHostContext,
    policy: &BrowserSessionPolicy,
) -> ProviderResult<()> {
    let source = reqwest::Url::parse(&policy.url).map_err(|_| invalid())?;
    let source_host = source.host_str().ok_or_else(invalid)?;
    if source.as_str() != policy.url
        || source.scheme() != "https"
        || source.port().is_some()
        || !source.username().is_empty()
        || source.password().is_some()
        || source.path() != "/"
        || source.query().is_some()
        || source.fragment().is_some()
        || !host
            .allowed_origins()
            .contains(&source.origin().ascii_serialization())
        || policy.cookie_names.is_empty()
        || policy.cookie_names.len() > 8
        || policy.required_cookie_names.is_empty()
        || policy.credential_origins.is_empty()
        || policy.credential_origins.len() > 4
    {
        return Err(invalid());
    }
    let names: BTreeSet<_> = policy.cookie_names.iter().collect();
    if names.len() != policy.cookie_names.len()
        || policy.cookie_names.iter().any(|name| {
            name.is_empty()
                || name.len() > 64
                || !name
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'-'))
        })
        || policy
            .required_cookie_names
            .iter()
            .any(|name| !names.contains(name))
    {
        return Err(invalid());
    }
    for origin in &policy.credential_origins {
        let target = reqwest::Url::parse(origin).map_err(|_| invalid())?;
        if target.origin().ascii_serialization() != *origin
            || !host.allowed_origins().contains(origin)
        {
            return Err(invalid());
        }
        match policy.format {
            BrowserSessionFormat::Cookie
                if target.host_str().is_some_and(|name| {
                    name == source_host || name.ends_with(&format!(".{source_host}"))
                }) => {}
            BrowserSessionFormat::KugouWeb
                if source_host == "openplat-user.kugou.com"
                    && policy.cookie_names == ["KuGoo"]
                    && policy.required_cookie_names == ["KuGoo"]
                    && [
                        "https://gateway.kugou.com",
                        "https://login-user.kugou.com",
                        "https://trackercdn.kugou.com",
                    ]
                    .contains(&origin.as_str()) => {}
            _ => return Err(invalid()),
        }
    }
    Ok(())
}

fn cookie_value_valid(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 16_384
        && value
            .bytes()
            .all(|b| (0x21..=0x7e).contains(&b) && !matches!(b, b';' | b','))
}

fn session_secret(
    policy: &BrowserSessionPolicy,
    cookies: Vec<BrowserSessionCookie>,
) -> ProviderResult<String> {
    if cookies.is_empty() || cookies.len() > 8 {
        return Err(invalid());
    }
    let mut values = BTreeMap::new();
    for cookie in cookies {
        if !policy.cookie_names.contains(&cookie.name)
            || !cookie_value_valid(&cookie.value)
            || values.insert(cookie.name, cookie.value).is_some()
        {
            return Err(invalid());
        }
    }
    if policy
        .required_cookie_names
        .iter()
        .any(|name| !values.contains_key(name))
    {
        return Err(invalid());
    }
    if policy.format == BrowserSessionFormat::KugouWeb {
        let mut url =
            reqwest::Url::parse("https://openplat-user.kugou.com/").map_err(|_| invalid())?;
        url.set_query(values.get("KuGoo").map(String::as_str));
        let mut fields = BTreeMap::new();
        for (key, value) in url
            .query_pairs()
            .filter(|(key, _)| key == "t" || key == "KugooID")
        {
            if fields
                .insert(key.into_owned(), value.into_owned())
                .is_some()
            {
                return Err(invalid());
            }
        }
        let token = fields
            .get("t")
            .filter(|value| cookie_value_valid(value) && !value.contains('&'))
            .ok_or_else(invalid)?;
        let userid = fields
            .get("KugooID")
            .filter(|value| value.parse::<u64>().is_ok_and(|id| id > 0))
            .ok_or_else(invalid)?;
        return Ok(format!("token={token}; userid={userid}"));
    }
    Ok(values
        .into_iter()
        .map(|(name, value)| format!("{name}={value}"))
        .collect::<Vec<_>>()
        .join("; "))
}

pub(super) fn import_session(
    host: &ComponentHostContext,
    policy: &BrowserSessionPolicy,
    cookies: Vec<BrowserSessionCookie>,
) -> ProviderResult<Vec<(String, String)>> {
    validate_policy(host, policy)?;
    let secret = session_secret(policy, cookies)?;
    let mut handles = Vec::new();
    for origin in &policy.credential_origins {
        match host.credential_create(origin, &secret) {
            Ok(handle) => handles.push((origin.clone(), handle)),
            Err(_) => {
                for (_, handle) in &handles {
                    let _ = host.credential_delete(handle);
                }
                return Err(ProviderCommandError::adapter(
                    "provider browser session could not be saved",
                ));
            }
        }
    }
    Ok(handles)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn policy() -> BrowserSessionPolicy {
        BrowserSessionPolicy {
            url: "https://music.163.com/".to_owned(),
            cookie_names: vec!["MUSIC_U".to_owned(), "__csrf".to_owned()],
            required_cookie_names: vec!["MUSIC_U".to_owned()],
            credential_origins: vec!["https://interfacepc.music.163.com".to_owned()],
            format: BrowserSessionFormat::Cookie,
        }
    }
    fn cookie(name: &str, value: &str) -> BrowserSessionCookie {
        BrowserSessionCookie {
            name: name.to_owned(),
            value: value.to_owned(),
        }
    }
    #[test]
    fn captures_only_declared_unique_nonempty_cookies() {
        assert_eq!(
            session_secret(&policy(), vec![cookie("MUSIC_U", "synthetic")]).unwrap(),
            "MUSIC_U=synthetic"
        );
        for cookies in [
            vec![],
            vec![cookie("__csrf", "synthetic")],
            vec![cookie("MUSIC_U", "a"), cookie("MUSIC_U", "b")],
            vec![cookie("qq_token", "synthetic")],
            vec![cookie("MUSIC_U", "x;other=y")],
            vec![cookie("MUSIC_U", "x\r\ny")],
        ] {
            assert!(session_secret(&policy(), cookies).is_err());
        }
    }
    #[test]
    fn kugou_cookie_is_normalized_inside_core_without_revealing_fields_to_plugin() {
        let mut policy = policy();
        policy.format = BrowserSessionFormat::KugouWeb;
        policy.cookie_names = vec!["KuGoo".to_owned()];
        policy.required_cookie_names = policy.cookie_names.clone();
        assert_eq!(
            session_secret(
                &policy,
                vec![cookie("KuGoo", "KugooID=42&NickName=fixture&t=synthetic")]
            )
            .unwrap(),
            "token=synthetic; userid=42"
        );
        for raw in [
            "KugooID=0&t=synthetic",
            "KugooID=42&t=a&t=b",
            "KugooID=42",
            "KugooID=42&t=a%3Bother%3Db",
        ] {
            assert!(session_secret(&policy, vec![cookie("KuGoo", raw)]).is_err());
        }
    }

    #[tokio::test]
    async fn policy_requires_grants_and_cannot_forward_a_session_to_another_site() {
        let root = tempfile::tempdir().unwrap();
        let services = super::super::component_host::ComponentHostServices::open(
            root.path().join("data"),
            root.path().join("cache"),
            std::sync::Arc::new(crate::credentials::MemoryCredentialStore::default()),
            tokio::runtime::Handle::current(),
        )
        .unwrap();
        let host = services.for_plugin(
            "test.music",
            "test.music.netease",
            std::collections::HashSet::from([
                "https://music.163.com".to_owned(),
                "https://interfacepc.music.163.com".to_owned(),
                "https://other.example.com".to_owned(),
            ]),
        );
        validate_policy(&host, &policy()).unwrap();
        let handles =
            import_session(&host, &policy(), vec![cookie("MUSIC_U", "synthetic")]).unwrap();
        assert_eq!(handles.len(), 1);
        assert_eq!(
            host.credential_resolve(&handles[0].1, "https://interfacepc.music.163.com")
                .unwrap(),
            "MUSIC_U=synthetic"
        );
        assert!(host
            .credential_resolve(&handles[0].1, "https://other.example.com")
            .is_err());
        for url in [
            "http://music.163.com/",
            "https://music.163.com:444/",
            "https://music.163.com/login",
            "https://music.163.com/?secret=x",
            "https://user@music.163.com/",
            "https://ungranted.example.com/",
        ] {
            let mut invalid = policy();
            invalid.url = url.to_owned();
            assert!(validate_policy(&host, &invalid).is_err(), "{url}");
        }
        for origin in [
            "https://other.example.com",
            "https://ungranted.music.163.com",
            "https://interfacepc.music.163.com/path",
        ] {
            let mut invalid = policy();
            invalid.credential_origins = vec![origin.to_owned()];
            assert!(validate_policy(&host, &invalid).is_err(), "{origin}");
        }
    }
}
