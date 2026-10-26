//! Read-only, provider-neutral song comments. Cursors are opaque to the host.
use async_trait::async_trait;
use serde::{Deserialize, Serialize};

use crate::{ProviderCommandError, ProviderResult, SongComment};

#[derive(Clone, Copy, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum CommentSort {
    #[default]
    Hot,
    New,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SongCommentsRequest {
    pub song_id: String,
    #[serde(default)]
    pub sort: CommentSort,
    #[serde(default)]
    pub cursor: Option<String>,
    /// Preferred batch size (1–50), not a strict bound on returned rows.
    pub limit: u32,
    #[serde(default)]
    pub parent_id: Option<String>,
}

impl SongCommentsRequest {
    pub fn validate(&self) -> ProviderResult<()> {
        if self.song_id.trim().is_empty()
            || self.song_id.len() > 4096
            || !(1..=50).contains(&self.limit)
            || self.cursor.as_ref().is_some_and(|v| v.len() > 1024)
            || self
                .parent_id
                .as_ref()
                .is_some_and(|v| v.trim().is_empty() || v.len() > 256)
        {
            return Err(ProviderCommandError::invalid_request(
                "invalid comment request",
            ));
        }
        Ok(())
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SongCommentsPage {
    pub items: Vec<SongComment>,
    pub next_cursor: Option<String>,
    pub total: Option<u64>,
    pub supported_sorts: Vec<CommentSort>,
    #[serde(default)]
    pub replies_supported: bool,
}

impl SongComment {
    /// Bound untrusted display fields for both comment pages and legacy lyrics.
    /// Comment identity validation remains the caller's responsibility.
    pub fn sanitize(&mut self) {
        self.content = self.content.chars().take(4000).collect();
        self.author = self.author.chars().take(100).collect();
        self.liked_count = self.liked_count.min(9_007_199_254_740_991);
        self.reply_count = self.reply_count.map(|v| v.min(9_007_199_254_740_991));
        self.time_ms = self.time_ms.filter(|v| *v <= 8_640_000_000_000_000);
        self.avatar_url = self.avatar_url.take().filter(|v| {
            v.len() <= 4096
                && reqwest::Url::parse(v).is_ok_and(|url| {
                    url.scheme() == "https"
                        && url.host_str().is_some()
                        && url.username().is_empty()
                        && url.password().is_none()
                })
        });
        if let Some(reply) = &mut self.reply_to {
            reply.author = reply.author.chars().take(100).collect();
            reply.content = reply.content.chars().take(4000).collect();
        }
    }
}

impl SongCommentsPage {
    /// Validate identity and sanitize display fields without truncating a page.
    /// Transport/IPC byte limits protect resources independently of batch size.
    pub fn bounded(mut self) -> ProviderResult<Self> {
        if self
            .next_cursor
            .as_ref()
            .is_some_and(|v| v.is_empty() || v.len() > 1024)
            || self.supported_sorts.is_empty()
            || self.supported_sorts.len() > 2
        {
            return Err(ProviderCommandError::adapter("invalid comment page"));
        }
        let mut ids = std::collections::HashSet::new();
        for item in &mut self.items {
            if item.id.trim().is_empty() || item.id.len() > 256 || !ids.insert(item.id.clone()) {
                return Err(ProviderCommandError::adapter("invalid comment identity"));
            }
            item.sanitize();
        }
        self.total = self.total.map(|v| v.min(9_007_199_254_740_991));
        Ok(self)
    }
}

#[async_trait]
pub trait CommentsProvider: Send + Sync {
    async fn song_comments(&self, request: SongCommentsRequest)
        -> ProviderResult<SongCommentsPage>;

    async fn song_comments_with_cancellation(
        &self,
        request: SongCommentsRequest,
        cancellation: tokio_util::sync::CancellationToken,
    ) -> ProviderResult<SongCommentsPage> {
        tokio::select! {
            biased;
            _ = cancellation.cancelled() => Err(ProviderCommandError::adapter("comment read cancelled")),
            result = self.song_comments(request) => result,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn validates_page_request_and_preserves_opaque_cursors() {
        let mut request: SongCommentsRequest = serde_json::from_value(json!({
            "songId":"track/1", "sort":"new", "limit":20, "cursor":"opaque#2", "parentId":"comment1"
        }))
        .unwrap();
        assert!(request.validate().is_ok());
        request.limit = 51;
        assert!(request.validate().is_err());
        request.limit = 20;
        request.parent_id = Some(" ".to_owned());
        assert!(request.validate().is_err());
    }

    #[test]
    fn bounds_untrusted_comment_data_and_rejects_ambiguous_identities() {
        let page: SongCommentsPage = serde_json::from_value(json!({
            "items":[{"id":"1", "author":"Listener", "content":"text", "likedCount":u64::MAX,
                "avatarUrl":"javascript:alert(1)", "timeMs":u64::MAX}],
            "nextCursor":null, "total":u64::MAX, "supportedSorts":["hot"], "repliesSupported":false
        }))
        .unwrap();
        let mut bounded = page.bounded().unwrap();
        assert_eq!(bounded.items[0].liked_count, 9_007_199_254_740_991);
        assert!(bounded.items[0].avatar_url.is_none());
        assert!(bounded.items[0].time_ms.is_none());
        bounded.items.push(bounded.items[0].clone());
        assert!(bounded.bounded().is_err());
    }

    #[test]
    fn preserves_extra_rows_and_the_provider_cursor() {
        let page: SongCommentsPage = serde_json::from_value(json!({
            "items":(0..21).map(|i| json!({
                "id":i.to_string(), "author":"Listener", "content":"text", "likedCount":0
            })).collect::<Vec<_>>(),
            "nextCursor":"opaque-after-row-21", "total":1000, "supportedSorts":["hot"]
        }))
        .unwrap();
        let bounded = page.bounded().unwrap();
        assert_eq!(bounded.items.len(), 21);
        assert_eq!(bounded.next_cursor.as_deref(), Some("opaque-after-row-21"));
        let mut invalid = bounded;
        invalid.next_cursor = Some("x".repeat(1025));
        assert!(invalid.bounded().is_err());
    }

    #[test]
    fn accepts_legacy_four_field_comments() {
        let comment: SongComment = serde_json::from_value(
            json!({"id":"1", "content":"old", "author":"A", "likedCount":0}),
        )
        .unwrap();
        assert!(comment.reply_count.is_none());
        assert!(comment.reply_to.is_none());
    }
}
