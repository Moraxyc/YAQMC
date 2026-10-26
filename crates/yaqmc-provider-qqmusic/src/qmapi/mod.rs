//! Pinned `qqmusic-api` production integration.
//!
//! HTTP goes through [`transport::YaqmcReqwestTransport`] or the account's injected
//! `ApiTransport` adapter (YAQMC reqwest 0.13.4 in production).
//! QQ endpoint selection, request encoding, wire decoding, playback filenames,
//! CDN contracts and lyric syntax belong to the library. The host retains
//! credential storage/lifecycle, mutation reconciliation, quality selection,
//! cache policy and mapping into provider-neutral application DTOs.

#![cfg_attr(test, allow(dead_code))]

pub(crate) mod account;
pub(crate) mod artwork;
pub(crate) mod auth;
pub(crate) mod catalog;
pub(crate) mod cgi;
pub(crate) mod comments;
pub(crate) mod credential;
pub(crate) mod entitlement;
pub(crate) mod lyric;
pub(crate) mod qmc;
pub(crate) mod recommend;
pub(crate) mod transport;
pub(crate) mod vkey;

pub(crate) fn qmapi_client() -> Result<qqmusic_api::Client, qqmusic_api::QmError> {
    qmapi_client_with(None, Some(qqmusic_api::Platform::Web))
}

pub(crate) fn qmapi_client_with(
    credential: Option<qqmusic_api::Credential>,
    platform: Option<qqmusic_api::Platform>,
) -> Result<qqmusic_api::Client, qqmusic_api::QmError> {
    Ok(qqmusic_api::Client::new_with_transport(
        credential,
        platform,
        transport::qmapi_transport(qqmusic_api::TransportConfig::default())?,
    ))
}
