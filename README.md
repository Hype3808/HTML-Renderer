# HTML Render Tavern

A small SillyTavern extension that renders a complete HTML document found in a fenced message code block in an auto-sizing iframe. It is a focused implementation of the renderer behavior popularized by [JS-Slash-Runner / Tavern Helper](https://github.com/N0VI028/JS-Slash-Runner): the source remains a normal SillyTavern message, while its visual UI runs in an isolated iframe.

## Install

Copy this folder to:

`SillyTavern/public/scripts/extensions/third-party/html-render-tavern/`

Then refresh SillyTavern and enable **HTML Render Tavern** in Extensions settings.

## Message format

Only a fenced code block that contains a closed `<body>` tag becomes a UI. The fence language is optional.

````markdown
```
<!doctype html>
<html>
  <head><style>body { font-family: sans-serif; padding: 1rem }</style></head>
  <body>
    <button onclick="this.textContent = 'Clicked!'">Click me</button>
  </body>
</html>
```
````

## Security

HTML messages can execute JavaScript. Sandboxing is enabled by default and deliberately does **not** grant same-origin access. Leave it enabled unless you trust the card/message and specifically need its scripts to access its original origin.

## Features

- Detects complete HTML documents in message code blocks.
- Renders with `srcdoc` (or optional Blob URLs) in a responsive iframe.
- Automatically adjusts iframe height when content, images, or fonts change; document-level scrollbars are suppressed.
- Works with dynamically added/re-rendered message nodes using a `MutationObserver`.
- Lets users limit rendering to the newest N messages and optionally keep source visible.
