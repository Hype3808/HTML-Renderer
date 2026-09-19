# HTML Render Tavern

这是一个小型 SillyTavern 扩展：它会将消息 fenced code block 中的完整 HTML 文档渲染到一个可自动调整大小的 iframe 中。它专注实现了 [JS-Slash-Runner / Tavern Helper](https://github.com/N0VI028/JS-Slash-Runner) 推广的渲染方式：源代码仍保留为普通的 SillyTavern 消息，而可视化界面则运行在隔离的 iframe 中。

## 安装

将此文件夹复制到：

`SillyTavern/public/scripts/extensions/third-party/html-render-tavern/`

然后刷新 SillyTavern，并在扩展设置中启用 **HTML Render Tavern**。

## 消息格式

只有包含闭合 `<body>` 标签的 fenced code block 才会变成界面。代码块语言标记是可选的。

````markdown
```
<!doctype html>
<html>
  <head><style>body { font-family: sans-serif; padding: 1rem }</style></head>
  <body>
    <button onclick="this.textContent = '已点击！'">点击我</button>
  </body>
</html>
```
````

## 安全性

HTML 消息可以执行 JavaScript。为了兼容为 JS-Slash-Runner 制作的卡片，默认启用 **Tavern Helper / MVU 桥接**。它会特意授予 iframe 访问宿主 SillyTavern 页面的权限，并公开 `getAllVariables`、`waitGlobalInitialized`、`eventOn`、`Mvu`、`$` 和 `_` 等常用 API。请仅对受信任的卡片使用此功能。关闭桥接后即可改用沙箱 iframe。

## 功能

- 检测消息代码块中的完整 HTML 文档。
- 使用 `srcdoc`（或可选的 Blob URL）在响应式 iframe 中渲染。
- 内容、图片或字体变化时自动调整 iframe 高度，并隐藏文档级滚动条。
- 使用 `MutationObserver` 支持动态添加或重新渲染的消息节点。
- 允许用户限制只渲染最新的 N 条消息，也可以选择保留源代码可见。
- 支持 Tavern Helper 的 iframe 绑定 API，包括 MVU 的 `getAllVariables()` 和变量更新事件。
