# Song comments

> [简体中文](zh-CN/song-comments.md) | **English**

YAQMC renders song comments in a side drawer on landscape windows and a bottom sheet on portrait/narrow windows. Open it from the player, lyrics controls, song detail, or track actions. Popular/latest sorting, pagination, full text, author/avatar/date, like counts and expandable reply threads are read-only. Availability depends on the source provider.

The lyrics comment overlay uses the same popular-comment cache. It scrolls during playback, pauses with playback, resets on song changes, and respects the saved Lyrics → Comment overlay switch. Scrolling stays enabled for comments when the system reduces decorative motion; other lyric effects continue to follow their own motion rules. The lyrics toolbar also offers an immediate toggle. Comments load independently of lyrics; tracks without lyrics can still have comments.

The built-in QQ Music provider supports popular/latest comments, pagination and reply threads without a plugin. Timestamps are converted from service seconds to milliseconds; HTTP avatar URLs are upgraded to HTTPS. `qm-api-rs` owns continuation encoding, scope validation and page advancement; YAQMC only forwards its opaque tokens and maps display data. Tokens are bound to the song, sort, parent comment and page size. Reading comments does not post, like or modify the account.

## Provider plugin contract

API v3 Wasm components opt in to `provider.comments` in both the individual provider's `capabilities` and plugin `permissions`. This is a read capability. Network origins still need their usual explicit grants. The WIT `invoke` signature and `0.1.0` world are unchanged. Existing components need no changes unless they opt in.

Core calls `invoke("provider.comments", "comments.list", payloadJson)`:

```json
{ "songId": "native-track-id", "sort": "hot", "cursor": null, "limit": 20, "parentId": null }
```

- `songId`: original source track ID, including through federated catalogs. Core selects the exact provider/profile before invocation.
- `sort`: `hot` or `new`. Return your supported values in `supportedSorts`; `new` means descending chronological order, not recommendation order.
- `cursor`: opaque continuation token, at most 1024 bytes. Return `null` at the end. Keep subsequent pages in the same song/sort/parent scope.
- `limit`: preferred batch size, 1–50. Sources may return extra rows; preserve the complete page and advance from its actual end. Core does not equate this hint with a response-row cap. Transport/IPC byte limits and display sanitization still apply. `parentId` selects replies to one comment; omit or use `null` for top-level comments.

```json
{
  "items": [
    {
      "id": "comment-1",
      "author": "Listener",
      "content": "A story about this song.",
      "likedCount": 42,
      "avatarUrl": "https://example.com/avatar.jpg",
      "timeMs": 1760000000000,
      "replyCount": 2,
      "replyTo": { "author": "Other listener", "content": "Original comment" }
    }
  ],
  "nextCursor": "opaque-page-2",
  "total": 120,
  "supportedSorts": ["hot", "new"],
  "repliesSupported": true
}
```

Only `id`, `author`, `content`, and `likedCount` are required on each comment. Optional fields may be omitted or null at the component boundary. `total` may be null. IDs must be nonempty, unique within a page, at most 256 bytes and stable across pages. Content is plain text. Core bounds content to 4000 characters, names to 100 characters, validates HTTPS avatars, and clamps counters to JavaScript safe integers. No provider HTML or executable styles are rendered. Posting, liking, and account mutations are outside this contract.

Renderer IPC is `provider_comments({providerId, profileId, request})`, available to the main window/host under the normal ACL. `PluginSongCommentsRequest`, `PluginSongComment`, and `PluginSongCommentsPage` are documented in the plugin SDK. The Rust contract is `CommentsProvider::song_comments` in `yaqmc-provider-api`.

## Compatibility and lifecycle

Old `LyricDocument.comments` data remains a fallback, with popular-only sorting and no reply pagination. It is fetched through the selected provider/profile rather than reused from the global lyrics document. Legacy comments receive the same date, avatar and counter validation as comment pages, with the existing 15-comment, 160-character content and 60-character author limits. Invalid dates are also omitted by the renderer.

Unsupported providers show a clear state. Opening a viewer revalidates the first page while preserving cached comments; a successful refresh replaces old pagination. Concurrent viewers share the request. Errors can be retried at the failed page, including first-page refresh failures. Unsubscribing the last viewer cancels the native read through a scoped request ID and late responses are ignored. Provider, profile, song, sort and parent identity partition caches; lyrics and the drawer share requests. Up to 40 inactive entries retain a sliding display window of 500 comments, with no total browsing cap. Earlier rows leave the window as new rows arrive; a button returns to the first page. Extra rows from a single oversized page are buffered and displayed before requesting another page. Danmaku keeps the original first 15 popular comments. Merging a batch takes O(n + m) time and space, with n at most 500 and the pending buffer bounded by one transport-limited response. Avatars are fetched near the viewport through a four-request queue; shared image memory uses LRU eviction with 128 entries and a 16 MiB string-storage budget.

Native cancellation uses `provider_comments({providerId, profileId, request, requestId?})` and `provider_comments_cancel({providerId, profileId, requestId})`. IDs are opaque, unique per read, at most 64 ASCII alphanumeric/hyphen characters, and bound to the profile and authorized window origin. Both methods retain the main-window/host ACL. Early cancellation races and duplicate IDs are handled in Core; QQ reads forward the token to qm-api-rs. Existing callers may omit the ID.

Legacy `provider_lyrics` and `qqmusic_lyrics` reads accept the same optional request ID and cancellation operation, so providers that supply comments inside lyrics also stop their in-flight read when the last viewer leaves.

The companion music-provider plugin 0.2.1 implements NetEase comments through `/api/v2/resource/comments` and replies through `/api/resource/comment/floor/get`; it requires a host with this capability. The upstream service can restrict results or return historical comments for closed resources.
