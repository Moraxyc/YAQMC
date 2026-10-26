//! Scoped cancellation for comment reads, including cancel-before-dispatch races.
use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tokio_util::sync::CancellationToken;
use yaqmc_protocol::WindowOrigin;
use yaqmc_provider_api::{ProviderCommandError, ProviderProfileKey, ProviderResult};

type Key = (String, String, String, String);
struct Entry {
    token: CancellationToken,
    expires: Option<Instant>,
}

#[derive(Default)]
pub(crate) struct CommentRequests(Mutex<HashMap<Key, Entry>>);

pub(crate) struct ReadGuard<'a> {
    owner: &'a CommentRequests,
    key: Option<Key>,
    pub token: CancellationToken,
}

impl Drop for ReadGuard<'_> {
    fn drop(&mut self) {
        self.token.cancel();
        if let Some(key) = &self.key {
            self.owner
                .0
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .remove(key);
        }
    }
}

fn key(scope: &ProviderProfileKey, origin: WindowOrigin, id: &str) -> ProviderResult<Key> {
    if id.is_empty() || id.len() > 64 || !id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
    {
        return Err(ProviderCommandError::invalid_request(
            "invalid comment request ID",
        ));
    }
    Ok((
        scope.provider_id.to_string(),
        scope.profile_id.to_string(),
        origin.to_string(),
        id.to_owned(),
    ))
}

impl CommentRequests {
    pub fn cancel_all(&self) {
        for entry in self.0.lock().unwrap_or_else(|e| e.into_inner()).values() {
            entry.token.cancel();
        }
    }
    pub fn begin(
        &self,
        scope: &ProviderProfileKey,
        origin: WindowOrigin,
        id: Option<&str>,
    ) -> ProviderResult<ReadGuard<'_>> {
        let token = CancellationToken::new();
        let Some(id) = id else {
            return Ok(ReadGuard {
                owner: self,
                key: None,
                token,
            });
        };
        let key = key(scope, origin, id)?;
        let mut entries = self.0.lock().unwrap_or_else(|e| e.into_inner());
        entries.retain(|_, entry| entry.expires.is_none_or(|time| time > Instant::now()));
        if let Some(entry) = entries.get_mut(&key) {
            if entry.expires.take().is_none() {
                return Err(ProviderCommandError::invalid_request(
                    "duplicate comment request ID",
                ));
            }
            return Ok(ReadGuard {
                owner: self,
                key: Some(key),
                token: entry.token.clone(),
            });
        }
        if entries.len() >= 256 {
            return Err(ProviderCommandError::invalid_request(
                "too many pending comment reads",
            ));
        }
        entries.insert(
            key.clone(),
            Entry {
                token: token.clone(),
                expires: None,
            },
        );
        Ok(ReadGuard {
            owner: self,
            key: Some(key),
            token,
        })
    }

    pub fn cancel(
        &self,
        scope: &ProviderProfileKey,
        origin: WindowOrigin,
        id: &str,
    ) -> ProviderResult<()> {
        let key = key(scope, origin, id)?;
        let mut entries = self.0.lock().unwrap_or_else(|e| e.into_inner());
        entries.retain(|_, entry| entry.expires.is_none_or(|time| time > Instant::now()));
        if let Some(entry) = entries.get(&key) {
            entry.token.cancel();
        } else if entries.len() < 256 {
            let token = CancellationToken::new();
            token.cancel();
            entries.insert(
                key,
                Entry {
                    token,
                    expires: Some(Instant::now() + Duration::from_secs(30)),
                },
            );
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn cancellation_is_scoped_handles_early_cancel_and_releases_registration() {
        let requests = CommentRequests::default();
        let scope = ProviderProfileKey::default_profile("qqmusic").unwrap();
        requests
            .cancel(&scope, WindowOrigin::Main, "early")
            .unwrap();
        let early = requests
            .begin(&scope, WindowOrigin::Main, Some("early"))
            .unwrap();
        assert!(early.token.is_cancelled());
        drop(early);
        let read = requests
            .begin(&scope, WindowOrigin::Main, Some("active"))
            .unwrap();
        assert!(requests
            .begin(&scope, WindowOrigin::Main, Some("active"))
            .is_err());
        requests
            .cancel(&scope, WindowOrigin::Host, "active")
            .unwrap();
        assert!(!read.token.is_cancelled());
        requests
            .cancel(&scope, WindowOrigin::Main, "active")
            .unwrap();
        assert!(read.token.is_cancelled());
        drop(read);
        assert!(!requests
            .begin(&scope, WindowOrigin::Main, Some("active"))
            .unwrap()
            .token
            .is_cancelled());
    }
}
