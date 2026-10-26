# 插件场景 API

场景可选 `portraitScene`，结构与 `scene` 相同。竖屏优先采用该配置；未配置时由宿主自动重排，横屏坐标保持原样。
字体基准同时受场景高度和歌词可用宽度约束，再乘以用户设置的字号比例。

在 `scene.lyrics.wordAnimation`（或 `portraitScene.lyrics.wordAnimation`）声明逐字跳动样式：

```json
{
  "easing": "ease-in-out",
  "keyframes": [
    { "offset": 0, "y": 0, "scale": 1, "rotate": 0 },
    { "offset": 0.45, "y": -0.12, "scale": 1.08, "rotate": -3, "glow": 0.12 },
    { "offset": 1, "y": 0, "scale": 1, "rotate": 0 }
  ]
}
```

关键帧数量为 2–8，`offset` 严格递增且首尾为 0 和 1。`y` 为 ±0.5 em 内的位移，`scale` 为 0.5–1.5，
`rotate` 为 ±30 度，`glow` 为 0–0.5 em 的辉光半径；缺省值为 0，缩放缺省为 1。支持 `linear`、`ease-out`、
`ease-in-out` 缓动。无效时间线回退默认效果，不增加权限。

宿主继续管理歌词时间、填色、暂停和跳转；关闭「逐字跳动」或启用系统减少动态效果时也关闭自定义跳动。
Android 上配置自定义跳动的场景使用共用 Web 歌词渲染器。源码示例为
`examples/plugins/scene-pack/scenes/vinyl-glow.scene.json`，SDK 类型为 `PluginLyricWordAnimation`。
视口暴露 `[data-yaqmc="lyrics-viewport"]`，自定义跳动的词节点暴露 `[data-yaqmc="lyric-word"]`；不依赖 AMLL
生成的类名。停用插件后撤销其场景效果。

> **简体中文** | [English](../plugin-scene-api.md)

插件歌词页是 **Scene Schema + CSS + 可选脚本**，没有 HTML 场景文档。场景注册进现有的 LyricsPreset / LyricsScene /
Composer 运行时，不会再做一套歌词渲染器。

启用时，每个 `entrypoints.scenes` JSON 注册为 `plugin:<pluginId>:<sceneId>`。选择器显示场景名和“由某插件提供”。偏好
只保存引用，不会把场景复制进 `custom[]` 伪装成内置预设。

停用/卸载会注销场景。若当前选中的场景消失，回退到 `builtin.classic`。

场景 JSON 使用共享歌词场景定义（`schemaVersion` 2）：`id`、`name`、`layout`，以及可选控件图。缺失字段按该 layout 的
工厂值补齐。v1 不允许用编排器编辑插件场景，但仍可选择它们。

场景 CSS 使用 `@scope ([data-yaqmc-plugin-scene="<pluginId>/<sceneId>"])` 限定范围。不要用场景入口改整个应用；那需要样式入口。

稳定选择器：`[data-scene-widget]`、`[data-scene-widget-id]`、`[data-scene-widget-type]`、`[data-scene-state]`、
`[data-playback-state]`。稳定变量：`--scene-progress`、`--scene-duration`、`--scene-artwork-primary`、
`--scene-artwork-secondary`、`--scene-accent`、`--scene-font-scale`。

`data-widget` 仍是编辑器内部钩子，插件应优先使用 `data-scene-widget`。

场景文档仍是 schema v2。额外控件（text / image / video）、Color Field、渐变/视频背景为增量能力。现有 Classic /
Immersive / Vinyl / 用户自定义 / 插件 v1 场景继续加载。插件场景在编排器中只读，请使用「复制为我的场景」。

Linux 上会关闭歌词行和场景控件的实时 `filter: blur()`。`gpu-off` / 兼容图形模式不解码场景视频。`@scope`
依赖 Electron 内置的 Chromium；若引擎忽略该规则，样式不生效，也不会泄漏到设置页。
