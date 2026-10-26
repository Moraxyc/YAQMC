//! Read-only QQ comments through the pinned client's CGI/transport boundary.
use qqmusic_api::{
    models::comment::{
        SongCommentSort, SongCommentsPage as QqCommentsPage,
        SongCommentsRequest as QqCommentsRequest,
    },
    Client,
};
#[cfg(test)]
use serde_json::json;
use yaqmc_provider_api::{
    CommentReplyTarget, CommentSort, SongComment, SongCommentsPage, SongCommentsRequest,
};

use super::cgi::map_qmapi_error;
use crate::qqmusic::QQMusicError;

fn library_request(
    song_id: i64,
    request: &SongCommentsRequest,
) -> Result<QqCommentsRequest, QQMusicError> {
    QqCommentsRequest::new(
        song_id,
        if request.sort == CommentSort::Hot {
            SongCommentSort::Hot
        } else {
            SongCommentSort::New
        },
        request.limit,
        request.parent_id.clone(),
    )
    .with_cursor(request.cursor.as_deref())
    .map_err(map_qmapi_error)
}

#[cfg(test)]
pub(crate) async fn song_comments(
    client: &Client,
    song_id: i64,
    request: &SongCommentsRequest,
) -> Result<SongCommentsPage, QQMusicError> {
    song_comments_with_cancellation(
        client,
        song_id,
        request,
        tokio_util::sync::CancellationToken::new(),
    )
    .await
}

pub(crate) async fn song_comments_with_cancellation(
    client: &Client,
    song_id: i64,
    request: &SongCommentsRequest,
    cancellation: tokio_util::sync::CancellationToken,
) -> Result<SongCommentsPage, QQMusicError> {
    request
        .validate()
        .map_err(|_| QQMusicError::InvalidRequest)?;
    let query = library_request(song_id, request)?;
    let data = client
        .comment
        .get_song_comments_with_cancellation(&query, cancellation)
        .await
        .map_err(map_qmapi_error)?;
    decode_page(data, &query)
}

fn decode_page(
    data: QqCommentsPage,
    request: &QqCommentsRequest,
) -> Result<SongCommentsPage, QQMusicError> {
    let raw = data;
    let next_cursor = raw.next_cursor(request).map_err(map_qmapi_error)?;
    let mut items = Vec::new();
    for item in raw.comments {
        // Deleted/image-only rows have no text to render or use as danmaku.
        if item.content.trim().is_empty() {
            continue;
        }
        let avatar_url = item.avatar_url();
        let time_ms = item.timestamp_ms();
        items.push(SongComment {
            id: item.cmid,
            content: item.content,
            author: item.nick,
            avatar_url,
            time_ms,
            liked_count: u64::try_from(item.praise_num).unwrap_or(0),
            reply_count: Some(u64::try_from(item.reply_cnt).unwrap_or(0)),
            reply_to: item
                .replied_comments
                .into_iter()
                .find(|quoted| !quoted.content.trim().is_empty())
                .map(|quoted| CommentReplyTarget {
                    author: quoted.nick,
                    content: quoted.content,
                }),
        });
    }
    SongCommentsPage {
        items,
        next_cursor,
        total: if request.parent_id.is_some() {
            raw.total
        } else {
            raw.total_comments.or(raw.total)
        },
        supported_sorts: vec![CommentSort::Hot, CommentSort::New],
        replies_supported: true,
    }
    .bounded()
    .map_err(|_| QQMusicError::SchemaChanged)
}

#[cfg(test)]
mod tests {
    use super::*;
    use qqmusic_api::{ApiTransport, HttpBody, Platform, TransportRequest, TransportResponse};
    use std::sync::{Arc, Mutex};

    #[tokio::test]
    async fn cancelled_comment_reads_never_reach_the_transport() {
        let transport = Arc::new(FixtureTransport::default());
        let client = Client::new_with_transport(None, Some(Platform::Web), transport.clone());
        let cancellation = tokio_util::sync::CancellationToken::new();
        cancellation.cancel();
        assert!(matches!(
            song_comments_with_cancellation(&client, 123, &request(), cancellation).await,
            Err(QQMusicError::Cancelled)
        ));
        assert!(transport.calls.lock().unwrap().is_empty());
    }

    #[derive(Default)]
    struct FixtureTransport {
        calls: Mutex<Vec<serde_json::Value>>,
        extra_rows: bool,
    }

    #[async_trait::async_trait]
    impl ApiTransport for FixtureTransport {
        async fn execute(
            &self,
            request: TransportRequest,
        ) -> qqmusic_api::Result<TransportResponse> {
            let HttpBody::Json(payload) = request.body else {
                panic!("JSON CGI request expected")
            };
            self.calls.lock().unwrap().push(payload.clone());
            let p = &payload["req_0"]["param"];
            assert_eq!(p["BizType"], 1);
            assert_eq!(p["BizId"], "123");
            assert_eq!(p["BizSubType"], 2);
            let page = p["PageNum"].as_u64().unwrap();
            if page == 1 {
                assert_eq!(
                    p["LastCommentSeqNo"],
                    if self.extra_rows { "seq-0-20" } else { "seq-0" }
                );
            }
            let rows = if self.extra_rows {
                if page == 0 {
                    21
                } else {
                    20
                }
            } else {
                1
            };
            let data = json!({"SubCode":0, "TotalCmNum":100, "CommentList":{
                "Comments":(0..rows).map(|i| json!({"CmId":format!("comment-{page}-{i}"),
                    "SeqNo":if self.extra_rows {format!("seq-{page}-{i}")} else {format!("seq-{page}")},
                    "Nick":"Listener", "Content":"Text", "PubTime":1700000000,
                    "PraiseNum":12, "ReplyCnt":3, "Avatar":"http://thirdqq.qlogo.cn/avatar",
                    "RepliedComments":[{"Nick":"Other", "Content":"Quoted text"}]})).collect::<Vec<_>>(),
                "Total":3, "HasMore":if page == 0 {1} else {0}
            }});
            Ok(TransportResponse {
                status: 200,
                final_url: request.url,
                headers: vec![],
                body: serde_json::to_vec(&json!({"code":0,"req_0":{"code":0,"data":data}}))
                    .unwrap(),
            })
        }
    }

    fn request() -> SongCommentsRequest {
        SongCommentsRequest {
            song_id: "qqmusic:track:MID".into(),
            sort: CommentSort::Hot,
            cursor: None,
            limit: 20,
            parent_id: None,
        }
    }

    #[tokio::test]
    async fn comments_wire_mapping_sorts_replies_and_pagination() {
        let transport = Arc::new(FixtureTransport::default());
        let client = Client::new_with_transport(None, Some(Platform::Web), transport.clone());
        let mut request = request();
        let first = song_comments(&client, 123, &request).await.unwrap();
        assert_eq!(first.total, Some(100));
        assert_eq!(first.items[0].time_ms, Some(1_700_000_000_000));
        assert_eq!(first.items[0].liked_count, 12);
        assert_eq!(first.items[0].reply_count, Some(3));
        assert_eq!(
            first.items[0].avatar_url.as_deref(),
            Some("https://thirdqq.qlogo.cn/avatar")
        );
        assert_eq!(
            first.items[0].reply_to.as_ref().unwrap().content,
            "Quoted text"
        );
        request.cursor = first.next_cursor;
        let second = song_comments(&client, 123, &request).await.unwrap();
        assert_eq!(second.items[0].id, "comment-1-0");
        assert!(second.next_cursor.is_none());
        request.cursor = None;
        request.sort = CommentSort::New;
        song_comments(&client, 123, &request).await.unwrap();
        request.parent_id = Some("parent-1".into());
        let replies = song_comments(&client, 123, &request).await.unwrap();
        assert_eq!(replies.total, Some(3));
        request.cursor = replies.next_cursor;
        song_comments(&client, 123, &request).await.unwrap();
        let calls = transport.calls.lock().unwrap();
        assert_eq!(calls[0]["req_0"]["method"], "GetHotCommentList");
        assert_eq!(calls[2]["req_0"]["method"], "GetNewCommentList");
        assert_eq!(calls[3]["req_0"]["method"], "GetReplyCommentList");
        assert_eq!(calls[3]["req_0"]["param"]["RootCmId"], "parent-1");
    }

    #[tokio::test]
    async fn comments_preserve_overfull_pages_and_resume_without_losing_rows() {
        let transport = Arc::new(FixtureTransport {
            extra_rows: true,
            ..Default::default()
        });
        let client = Client::new_with_transport(None, Some(Platform::Web), transport.clone());
        let mut request = request();
        let first = song_comments(&client, 123, &request).await.unwrap();
        assert_eq!(first.items.len(), 21);
        assert_eq!(first.items.last().unwrap().id, "comment-0-20");
        request.cursor = first.next_cursor;
        let second = song_comments(&client, 123, &request).await.unwrap();
        assert_eq!(second.items.len(), 20);
        assert!(second.next_cursor.is_none());
        assert!(second
            .items
            .iter()
            .all(|row| first.items.iter().all(|old| old.id != row.id)));
        assert_eq!(transport.calls.lock().unwrap().len(), 2);
    }

    #[test]
    fn comments_reject_cross_scope_cursors_and_invalid_requests() {
        let mut request = request();
        request.cursor = Some(
            r#"{"version":1,"song":123,"sort":"hot","parent":null,"limit":20,"page":1,"seq":"s1"}"#
                .into(),
        );
        assert!(library_request(123, &request).is_ok());
        assert!(library_request(124, &request).is_err());
        request.sort = CommentSort::New;
        assert!(library_request(123, &request).is_err());
        request.sort = CommentSort::Hot;
        request.parent_id = Some("other-parent".into());
        assert!(library_request(123, &request).is_err());
        request.parent_id = None;
        request.limit = 10;
        assert!(library_request(123, &request).is_err());
        request.cursor = Some("garbage".into());
        assert!(library_request(123, &request).is_err());
    }

    #[test]
    fn comments_mapping_bounds_fields_and_skips_textless_rows() {
        let request = request();
        let page = QqCommentsPage {
            comments: vec![
                serde_json::from_value(json!({"CmId":"a","SeqNo":"1","Content":"Text","PubTime":-1,"PraiseNum":-5,"ReplyCnt":-2,"Avatar":"javascript:alert(1)"})).unwrap(),
                serde_json::from_value(json!({"CmId":"image-only","SeqNo":"2","Content":""})).unwrap(),
            ], has_more:true, total:None, total_comments:None,
        };
        let result = decode_page(page, &library_request(123, &request).unwrap()).unwrap();
        assert_eq!(result.items.len(), 1);
        assert!(result.items[0].time_ms.is_none());
        assert!(result.items[0].avatar_url.is_none());
        assert_eq!(result.items[0].liked_count, 0);
        assert!(result.next_cursor.is_some());
    }

    #[tokio::test]
    #[ignore = "live read-only QQ Music verification; requires network"]
    async fn comments_live_hot_new_replies() {
        let client = crate::qmapi::qmapi_client().unwrap();
        let mut request = request();
        let hot = song_comments(&client, 97773, &request).await.unwrap();
        assert!(!hot.items.is_empty());
        request.cursor = hot.next_cursor;
        let hot2 = song_comments(&client, 97773, &request).await.unwrap();
        assert!(hot2
            .items
            .iter()
            .all(|item| !hot.items.iter().any(|first| first.id == item.id)));
        request.cursor = None;
        request.sort = CommentSort::New;
        let new = song_comments(&client, 97773, &request).await.unwrap();
        assert!(!new.items.is_empty());
        request.cursor = new.next_cursor;
        let new2 = song_comments(&client, 97773, &request).await.unwrap();
        assert!(new2
            .items
            .iter()
            .all(|item| !new.items.iter().any(|first| first.id == item.id)));
        request.cursor = None;
        request.parent_id = Some(
            hot.items
                .iter()
                .find(|row| row.reply_count.unwrap_or(0) > 0)
                .unwrap()
                .id
                .clone(),
        );
        let replies = song_comments(&client, 97773, &request).await.unwrap();
        assert!(!replies.items.is_empty());
        request.cursor = replies.next_cursor;
        let replies2 = song_comments(&client, 97773, &request).await.unwrap();
        assert!(replies2
            .items
            .iter()
            .all(|item| !replies.items.iter().any(|first| first.id == item.id)));
        println!(
            "song=97773 hot={}/{} new={}/{} replies={}/{}; no repeated IDs across adjacent pages",
            hot.items.len(),
            hot2.items.len(),
            new.items.len(),
            new2.items.len(),
            replies.items.len(),
            replies2.items.len()
        );
    }
}
