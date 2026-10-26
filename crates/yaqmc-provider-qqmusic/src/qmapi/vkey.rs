//! Consume the library's typed clear/encrypted playback file resolver.
//! Entitlement and quality selection stay in the host; QQ filename, vkey
//! response identity and CDN rules belong to qm-api-rs.

use std::collections::HashMap;
#[cfg(test)]
use std::sync::Arc;

#[cfg(test)]
use qqmusic_api::models::song::UrlinfoItem;
#[cfg(test)]
use qqmusic_api::modules::song::SongQuality;
use qqmusic_api::Platform;
#[cfg(test)]
use yaqmc_provider_api::PlaybackLocation;

use crate::qmapi::cgi::map_qmapi_error;
use crate::qmapi::credential::credential_from_uin_and_cookie;
use crate::qmapi::qmapi_client_with;
#[cfg(test)]
use crate::qmc::EncryptedMediaKey;
#[cfg(test)]
use crate::qqmusic::normalize_cdn_url;
#[cfg(test)]
use crate::qqmusic::playback_headers;
use crate::qqmusic::QQMusicError;

/// Library unplayable result used when the account cannot stream this quality.
#[cfg(test)]
pub(crate) const QMAP_UNPLAYABLE_RESULT: i64 = 104_003;
#[cfg(test)]
pub(crate) fn playback_location_from_qmapi(
    result: i64,
    url: &str,
    ekey: &str,
    encrypted: bool,
) -> Result<PlaybackLocation, QQMusicError> {
    if result != 0 {
        return Err(QQMusicError::EntitlementUnavailable);
    }
    let url = url.trim();
    if url.is_empty() {
        return Err(QQMusicError::MalformedResponse);
    }
    let url = sanitize_qmapi_playback_url(url)?;
    if encrypted {
        if ekey.trim().is_empty() {
            return Err(QQMusicError::MalformedResponse);
        }
        let encryption =
            EncryptedMediaKey::new(ekey.to_owned()).map_err(|_| QQMusicError::MalformedResponse)?;
        Ok(PlaybackLocation::EncryptedHttp {
            url,
            headers: playback_headers(),
            encryption: Arc::new(encryption),
        })
    } else {
        Ok(PlaybackLocation::Http {
            url,
            headers: playback_headers(),
        })
    }
}

#[cfg(test)]
pub(crate) fn sanitize_qmapi_playback_url(url: &str) -> Result<String, QQMusicError> {
    let parsed = reqwest::Url::parse(url).map_err(|_| QQMusicError::MalformedResponse)?;
    let host = parsed.host_str().ok_or(QQMusicError::MalformedResponse)?;
    let origin = format!("{}://{}/", parsed.scheme(), host);
    let mut path = parsed.path().trim_start_matches('/').to_owned();
    if let Some(query) = parsed.query() {
        path.push('?');
        path.push_str(query);
    }
    normalize_cdn_url(&origin, &path)
}

/// Map host credentials and consume typed library playback sources.
pub(crate) async fn clear_playable_urls(
    track_id: &str,
    media_mid: &str,
    filenames: &[String],
    uin: Option<&str>,
    cookie_header: Option<&str>,
) -> Result<HashMap<String, String>, QQMusicError> {
    let credential = match (uin, cookie_header) {
        (Some(uin), Some(cookie)) => {
            Some(credential_from_uin_and_cookie(uin, cookie, None, u64::MAX)?)
        }
        _ => None,
    };
    let client =
        qmapi_client_with(credential.clone(), Some(Platform::Android)).map_err(map_qmapi_error)?;
    let sources = qqmusic_api::playback::resolve_files(
        &client.song,
        track_id,
        media_mid,
        filenames,
        credential.as_ref(),
        false,
    )
    .await
    .map_err(map_qmapi_error)?;
    Ok(sources
        .into_iter()
        .filter_map(|(filename, source)| source.url.map(|url| (filename, url)))
        .collect())
}

pub(crate) async fn encrypted_playable_sources(
    track_id: &str,
    media_mid: &str,
    filenames: &[String],
    uin: &str,
    cookie_header: &str,
) -> Result<HashMap<String, Option<(String, String)>>, QQMusicError> {
    let credential = credential_from_uin_and_cookie(uin, cookie_header, None, u64::MAX)?;
    let client = qmapi_client_with(Some(credential.clone()), Some(Platform::Android))
        .map_err(map_qmapi_error)?;
    let sources = qqmusic_api::playback::resolve_files(
        &client.song,
        track_id,
        media_mid,
        filenames,
        Some(&credential),
        true,
    )
    .await
    .map_err(map_qmapi_error)?;
    Ok(sources
        .into_iter()
        .map(|(filename, source)| (filename, source.url.zip(source.ekey)))
        .collect())
}

#[cfg(test)]
fn clear_file_type(
    filename: &str,
) -> Option<&'static (dyn qqmusic_api::modules::song::FileTypeLike + Send + Sync)> {
    let kind = qqmusic_api::playback::PlaybackFile::from_filename(filename)?;
    let file_type = kind.file_type();
    (!file_type.is_encrypted()).then_some(file_type)
}

#[cfg(test)]
fn encrypted_quality_for_filename(filename: &str) -> Option<SongQuality> {
    match qqmusic_api::playback::PlaybackFile::from_filename(filename)? {
        qqmusic_api::playback::PlaybackFile::Master => Some(SongQuality::Master),
        qqmusic_api::playback::PlaybackFile::EncryptedLossless => Some(SongQuality::Flac),
        _ => None,
    }
}

#[cfg(test)]
fn clear_urls_from_items(
    filenames: &[String],
    items: Vec<UrlinfoItem>,
) -> Result<HashMap<String, String>, QQMusicError> {
    Ok(
        qqmusic_api::playback::sources_from_items(filenames, items, false)
            .map_err(map_qmapi_error)?
            .into_iter()
            .filter_map(|(filename, source)| source.url.map(|url| (filename, url)))
            .collect(),
    )
}

#[cfg(test)]
mod tests {
    use yaqmc_provider_api::PlaybackLocation;

    use super::*;

    #[test]
    fn encrypted_filename_mapping_accepts_only_supported_shapes() {
        assert_eq!(
            encrypted_quality_for_filename("AIM0media.mflac"),
            Some(SongQuality::Master)
        );
        assert_eq!(
            encrypted_quality_for_filename("F0M0media.mflac"),
            Some(SongQuality::Flac)
        );
        assert!(encrypted_quality_for_filename("AIM0media.flac").is_none());
        assert!(encrypted_quality_for_filename("M800media.mp3").is_none());
    }

    const LIBRARY_FALLBACK: &str =
        "https://isure.stream.qqmusic.qq.com/C400fixture.m4a?vkey=redacted";
    const INTREE_SIP: &str =
        "https://aqqmusic.tc.qq.com/amobile.music.tc.qq.com/C400fixture.m4a?vkey=redacted";

    #[test]
    fn library_fallback_domain_is_on_the_intree_allowlist() {
        let url = sanitize_qmapi_playback_url(LIBRARY_FALLBACK).expect("allowed");
        assert!(url.starts_with("https://isure.stream.qqmusic.qq.com/"));
        assert!(url.contains("vkey=redacted"));
    }

    #[test]
    fn intree_sip_style_url_stays_allowed() {
        sanitize_qmapi_playback_url(INTREE_SIP).expect("allowed");
    }

    #[test]
    fn unknown_cdn_host_is_rejected() {
        assert!(matches!(
            sanitize_qmapi_playback_url("https://example.invalid/C400fixture.m4a?vkey=redacted"),
            Err(QQMusicError::MalformedResponse)
        ));
    }

    #[test]
    fn unplayable_result_does_not_become_a_fake_url() {
        assert!(matches!(
            playback_location_from_qmapi(QMAP_UNPLAYABLE_RESULT, "", "", false),
            Err(QQMusicError::EntitlementUnavailable)
        ));
    }

    #[test]
    fn clear_playable_url_maps_to_http_location() {
        let location =
            playback_location_from_qmapi(0, LIBRARY_FALLBACK, "", false).expect("mapped");
        match location {
            PlaybackLocation::Http { url, .. } => {
                assert!(url.starts_with("https://isure.stream.qqmusic.qq.com/"));
            }
            other => panic!("expected HTTP location, got {other:?}"),
        }
    }

    #[test]
    fn encrypted_playable_url_keeps_ekey_and_allowlisted_host() {
        let location = playback_location_from_qmapi(0, LIBRARY_FALLBACK, "fixture-ekey", true)
            .expect("mapped");
        match location {
            PlaybackLocation::EncryptedHttp {
                url, encryption, ..
            } => {
                assert!(url.starts_with("https://isure.stream.qqmusic.qq.com/"));
                assert_eq!(encryption.key_len(), "fixture-ekey".len());
            }
            other => panic!("expected encrypted HTTP location, got {other:?}"),
        }
    }

    #[test]
    fn clear_file_types_match_intree_candidate_prefixes() {
        assert!(clear_file_type("RS01MEDIA.flac").is_some());
        assert!(clear_file_type("F000MEDIA.flac").is_some());
        assert!(clear_file_type("M800MEDIA.mp3").is_some());
        assert!(clear_file_type("M500MEDIA.mp3").is_some());
        assert!(clear_file_type("C400MEDIA.m4a").is_some());
        assert!(clear_file_type("RS02MEDIA.mp3").is_some());
        assert!(clear_file_type("AIM0MEDIA.mflac").is_none());
    }

    fn urlinfo(filename: &str, purl: &str, result: i64) -> UrlinfoItem {
        UrlinfoItem {
            filename: filename.to_owned(),
            purl: purl.to_owned(),
            result,
            ..UrlinfoItem::default()
        }
    }

    #[test]
    fn clear_urls_are_correlated_by_response_filename_not_position() {
        let requested = vec!["M500MEDIA.mp3".to_owned(), "C400MEDIA.m4a".to_owned()];
        let urls = clear_urls_from_items(
            &requested,
            vec![
                urlinfo("C400MEDIA.m4a", "C400MEDIA.m4a?vkey=redacted", 0),
                urlinfo("M500MEDIA.mp3", "M500MEDIA.mp3?vkey=redacted", 0),
            ],
        )
        .expect("response order is not authoritative");

        assert!(urls["M500MEDIA.mp3"].contains("M500MEDIA.mp3"));
        assert!(urls["C400MEDIA.m4a"].contains("C400MEDIA.m4a"));
    }

    #[test]
    fn clear_urls_fail_closed_for_unknown_or_duplicate_response_filenames() {
        let requested = vec!["M500MEDIA.mp3".to_owned()];
        assert!(matches!(
            clear_urls_from_items(
                &requested,
                vec![urlinfo("M800OTHER.mp3", "M800OTHER.mp3?vkey=redacted", 0)]
            ),
            Err(QQMusicError::MalformedResponse)
        ));
        assert!(matches!(
            clear_urls_from_items(
                &requested,
                vec![
                    urlinfo("M500MEDIA.mp3", "M500MEDIA.mp3?vkey=one", 0),
                    urlinfo("M500MEDIA.mp3", "M500MEDIA.mp3?vkey=two", 0),
                ]
            ),
            Err(QQMusicError::MalformedResponse)
        ));
    }

    #[test]
    fn missing_or_unplayable_clear_results_remain_unavailable() {
        let requested = vec!["M500MEDIA.mp3".to_owned(), "C400MEDIA.m4a".to_owned()];
        let urls = clear_urls_from_items(
            &requested,
            vec![urlinfo("M500MEDIA.mp3", "", QMAP_UNPLAYABLE_RESULT)],
        )
        .expect("missing and rejected candidates are safely unavailable");

        assert!(urls.is_empty());
    }
}
