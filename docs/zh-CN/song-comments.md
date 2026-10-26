# 歌曲评论

> **简体中文** | [English](../song-comments.md)

YAQMC 在横屏窗口使用评论侧栏，在竖屏或窄窗口使用底部评论面板。播放器、歌词操作栏、歌曲详情和歌曲菜单均有入口。支持热门/最新排序、分页、全文展开、作者/头像/日期、点赞数和楼中楼回复，均为只读展示。实际可用能力由歌曲的音源提供器决定。

歌词弹幕共用热门评论缓存，播放时滚动、暂停时停止，切歌时重置，遵循“设置 → 歌词 → 评论弹幕”开关。系统减少装饰动效时，评论弹幕仍保留滚动；其他歌词动效继续遵循各自的动效规则。歌词操作栏也提供即时开关。评论与歌词独立加载，没有歌词的歌曲也能显示评论。

内置 QQ 音乐无需插件即可读取热门/最新评论、分页及楼中楼回复。时间戳由服务端秒数转换为毫秒，HTTP 头像地址升级为 HTTPS。`qm-api-rs` 负责游标编码、作用域校验和翻页推进，YAQMC 仅转交不透明游标并映射显示数据。翻页游标绑定歌曲、排序、父评论与每页条数。读取评论不会发表、点赞或修改账号数据。

## 提供器插件接口

API v3 Wasm 插件在对应提供器的 `capabilities` 和插件的 `permissions` 中声明 `provider.comments`。这是读取能力；网络域名仍须单独授权。WIT 的 `invoke` 签名和 `0.1.0` world 无需变更。没有声明该能力的旧插件保持兼容。

宿主调用 `invoke("provider.comments", "comments.list", payloadJson)`：

```json
{ "songId": "原始音源歌曲ID", "sort": "hot", "cursor": null, "limit": 20, "parentId": null }
```

- `songId`：原始音源歌曲 ID；联合平台也会转发回原始音源。Core 先选择准确的提供器和账号配置，再调用插件。
- `sort`：`hot` 或 `new`。通过 `supportedSorts` 声明支持的排序；`new` 必须表示时间倒序，不应返回推荐排序。
- `cursor`：最长 1024 字节的不透明分页游标，末页返回 `null`。后续页面应保持歌曲、排序、父评论作用域一致。
- `limit`：期望批次大小，1–50。音源可能多返回条目，应保留完整页面并从实际末条继续；Core 不将期望大小作为响应条数上限。传输/IPC 字节限制和显示字段清洗仍然生效。`parentId` 指定一条评论的回复，省略或 `null` 表示顶级评论。

```json
{
  "items": [
    {
      "id": "comment-1",
      "author": "听众",
      "content": "与这首歌有关的故事。",
      "likedCount": 42,
      "avatarUrl": "https://example.com/avatar.jpg",
      "timeMs": 1760000000000,
      "replyCount": 2,
      "replyTo": { "author": "另一位听众", "content": "被回复的内容" }
    }
  ],
  "nextCursor": "opaque-page-2",
  "total": 120,
  "supportedSorts": ["hot", "new"],
  "repliesSupported": true
}
```

单条评论只要求 `id`、`author`、`content`、`likedCount`；其余字段在组件边界可省略或为 null。`total` 可为 null。评论 ID 必须非空、页内唯一、最长 256 字节，并在分页间保持稳定。内容为纯文本。Core 将正文限制为 4000 字符、作者为 100 字符，校验 HTTPS 头像，并将计数限制在 JavaScript 安全整数范围内。提供器 HTML 和可执行样式不会被渲染。该接口不包含发评、点赞或账号写操作。

渲染层 IPC 为 `provider_comments({providerId, profileId, request})`，按现有 ACL 仅开放给主窗口和宿主。插件 SDK 提供 `PluginSongCommentsRequest`、`PluginSongComment` 和 `PluginSongCommentsPage` 类型；Rust 接口为 `yaqmc-provider-api` 的 `CommentsProvider::song_comments`。

## 兼容与生命周期

旧 `LyricDocument.comments` 保留为降级路径，只支持热门排序，没有回复分页。它通过选定的提供器和账号配置读取，不再复用全局歌词文档。旧式评论与新评论页共用日期、头像和计数校验，并保留原有的 15 条评论、正文 160 字符和作者 60 字符上限。渲染层也会省略无效日期。

不支持评论的提供器会明确提示。打开查看者时重新验证第一页，期间保留已有评论；刷新成功后替换旧分页状态，并发查看者共享请求。失败后重试对应的失败页，也包括第一页刷新失败。最后一个查看者离开时通过作用域内的请求 ID 取消原生读取，迟到响应会被忽略。缓存按提供器、账号配置、歌曲、排序、父评论隔离，歌词弹幕和评论面板共享请求。最多保留 40 个闲置条目，每条目使用 500 条滑动显示窗口，不限制累计浏览数量。新条目进入时释放较早条目，并提供返回第一页按钮；超大单页的剩余条目会暂存并先行显示，再读取后续页。弹幕保留第一页的 15 条热门评论。批次合并时间、空间均为 O(n + m)，n 最多 500，待显示缓冲受单页传输字节限制。头像在接近视口时读取，原生请求最多并发 4 个；共享图片内存按 LRU 淘汰，最多 128 条、字符串存储预算 16 MiB。

原生取消接口为 `provider_comments({providerId, profileId, request, requestId?})` 与 `provider_comments_cancel({providerId, profileId, requestId})`。ID 每次读取唯一、不透明，最多 64 个 ASCII 字母、数字或连字符，并绑定账号配置和已授权的窗口来源。两接口仅允许主窗口和宿主；Core 处理提前取消与重复 ID，QQ 提供器将取消令牌传入 qm-api-rs。旧调用方可省略 ID。

兼容接口 `provider_lyrics`、`qqmusic_lyrics` 也接受相同的可选请求 ID 和取消操作；将评论放在歌词中的旧提供器，在最后一个查看者退出时同样中止进行中的读取。

配套音乐提供器插件 0.2.1 使用 `/api/v2/resource/comments` 读取网易云评论，使用 `/api/resource/comment/floor/get` 读取回复，需要支持该能力的新版宿主。上游可能限制返回结果，已关闭评论的资源也可能只返回历史评论。
