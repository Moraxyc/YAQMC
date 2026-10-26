//! Typed authentication/profile calls delegated to qm-api-rs.

use qqmusic_api::models::user::CurrentUserProfile;
use qqmusic_api::Platform;

use crate::qmapi::cgi::map_qmapi_error;
use crate::qmapi::credential::credential_from_session;
use crate::qmapi::qmapi_client_with;
use crate::qqmusic::{QQMusicError, SessionRecord};

/// Validate the current account and return a typed account profile. The upstream route and credential
/// injection are owned by qm-api-rs.
pub(crate) async fn fetch_profile(
    client: Option<&qqmusic_api::Client>,
    session: &SessionRecord,
    cancellation: tokio_util::sync::CancellationToken,
) -> Result<CurrentUserProfile, QQMusicError> {
    if cancellation.is_cancelled() {
        return Err(QQMusicError::Cancelled);
    }
    let credential = credential_from_session(session)?;
    let local_client;
    let client = match client {
        Some(client) => client,
        None => {
            local_client = qmapi_client_with(Some(credential.clone()), Some(Platform::Web))
                .map_err(map_qmapi_error)?;
            &local_client
        }
    };
    let data = tokio::select! {
        biased;
        _ = cancellation.cancelled() => return Err(QQMusicError::Cancelled),
        result = client.user.get_current_profile(&credential, cancellation.clone()) => result.map_err(map_qmapi_error)?,
    };
    if cancellation.is_cancelled() {
        return Err(QQMusicError::Cancelled);
    }

    Ok(data)
}
