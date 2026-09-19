/*
 * HTML Render Tavern
 * 一个专注且无依赖的 SillyTavern 消息代码块 HTML 渲染器。
 *
 * 灵感来自 N0VI028/JS-Slash-Runner 的 iframe 渲染方案。
 */
(() => {
    'use strict';

    // SillyTavern can reload an extension script without a full page reload.
    // Tear down the previous instance before installing a new one.
    window.__HTML_RENDER_TAVERN__?.destroy?.();
    let startupCancelled = false;

    const EXTENSION_ID = 'html-render-tavern';
    const SETTINGS_KEY = 'htmlRenderTavern';
    const DEFAULTS = Object.freeze({
        enabled: true,
        renderDepth: 0,
        hideSource: true,
        useBlobUrls: false,
        // 兼容 JS-Slash-Runner 的卡片会使用 Tavern Helper / MVU 全局对象。
        // 这需要同源 iframe，因此该模式只适用于受信任的卡片。
        parentBridge: true,
        sandbox: false,
    });
    const rendered = new WeakMap();
    let settings;
    let observer;
    let queued = false;

    function getLocalSettings() {
        try {
            const stored = localStorage.getItem(`${SETTINGS_KEY}:backup`);
            return stored ? JSON.parse(stored) : {};
        } catch {
            return {};
        }
    }

    function saveLocalSettings() {
        try {
            localStorage.setItem(`${SETTINGS_KEY}:backup`, JSON.stringify(settings));
        } catch {
            // localStorage can be unavailable in privacy-restricted contexts.
        }
    }

    function getSettings() {
        window.extension_settings ??= {};
        const stored = window.extension_settings[SETTINGS_KEY] ?? {};
        const localStored = getLocalSettings();
        const persisted = stored && Object.keys(stored).length > 0 ? stored : localStored;
        settings = { ...DEFAULTS, ...persisted };
        // 1.0.0 版本保存过 `sandbox: true`；升级时将其迁移到兼容的默认值。
        // 用户可以在设置中切换回隔离模式。
        if (persisted.parentBridge === undefined) {
            settings.parentBridge = true;
            settings.sandbox = false;
        }
        window.extension_settings[SETTINGS_KEY] = settings;
        saveLocalSettings();
        return settings;
    }

    function saveSettings() {
        window.extension_settings[SETTINGS_KEY] = settings;
        saveLocalSettings();
        window.saveSettingsDebounced?.();
    }

    function isHtmlDocument(source) {
        return /<body(?:\s[^>]*)?>[\s\S]*<\/body\s*>/i.test(source);
    }

    function messageIsInDepth(pre) {
        if (!settings.renderDepth) return true;
        const message = pre.closest('.mes');
        if (!message) return true;
        const messages = [...document.querySelectorAll('#chat .mes')];
        return messages.slice(-settings.renderDepth).includes(message);
    }

    function viewportScript() {
        // 此脚本在卡片标记之后运行，因此首次测量会包含卡片自身的样式和布局，
        // 而不是使用浏览器默认的 150px iframe 高度。
        return `<script>
(() => {
  const height = () => {
    const body = document.body;
    const html = document.documentElement;
    if (!body || !html) return 1;

    // 卡片从长标签页切换到短标签页后，scrollHeight 可能仍等于旧的 iframe 视口高度。
    // 因此改为测量可见内容的底部边缘，这样高度既能增加，也能缩小。
    const bodyTop = body.getBoundingClientRect().top;
    let contentBottom = 0;
    for (const child of body.children) {
      const rect = child.getBoundingClientRect();
      if (rect.width || rect.height) contentBottom = Math.max(contentBottom, rect.bottom - bodyTop);
    }
    if (contentBottom > 0) return Math.ceil(contentBottom + 1);
    return Math.max(1, body.scrollHeight);
  };
  const report = () => parent.postMessage({ type: 'html-render-tavern:height', height: height() }, '*');
  const resizeObservers = [];
  const mutationObservers = [];
  const observe = () => {
    const documentObserver = new ResizeObserver(report);
    documentObserver.observe(document.documentElement);
    resizeObservers.push(documentObserver);
    if (document.body) {
      const bodyObserver = new ResizeObserver(report);
      bodyObserver.observe(document.body);
      resizeObservers.push(bodyObserver);
    }
    const mutationObserver = new MutationObserver(report);
    mutationObserver.observe(document.documentElement, { childList: true, subtree: true, attributes: true, characterData: true });
    mutationObservers.push(mutationObserver);
  };
  const stop = () => {
    resizeObservers.forEach(observer => observer.disconnect());
    mutationObservers.forEach(observer => observer.disconnect());
  };
  observe();
  addEventListener('pagehide', stop, { once: true });
  addEventListener('load', () => { report(); requestAnimationFrame(report); setTimeout(report, 100); });
  document.fonts?.ready?.then(report);
  addEventListener('message', event => { if (event.data?.type === 'html-render-tavern:measure') report(); });
  addEventListener('message', event => {
    if (event.data?.type === 'html-render-tavern:dispose') stop();
  });
  requestAnimationFrame(report);
})();
</script>`;
    }

    function parentBridgeScript() {
        // 卡片运行在自己的文档中，但较旧的 Tavern Helper 卡片需要其便捷的全局对象。
        // DOM 查询保持在本地，同时只从父页面转发明确的 Tavern Helper / MVU 函数和值。
        return `<script>
(() => {
  try {
    const host = window.parent;
    const api = host.TavernHelper || host;
    const hostJQuery = host.jQuery || host.$;
    if (hostJQuery) {
      const localJQuery = (selector, context) => typeof selector === 'function'
        ? hostJQuery(selector)
        : hostJQuery(selector, context || document);
      localJQuery.fn = hostJQuery.fn;
      window.$ = window.jQuery = localJQuery;
    }
    if (host._) window._ = host._;
    // Tavern Helper 会把支持 iframe 的函数放在 _bind 映射中。将这些函数绑定到此 iframe
    // 的 window 至关重要：这样 getAllVariables() 才能解析拥有此卡片的消息，
    // 而不是读取最新的聊天消息。
    for (const [name, value] of Object.entries(api._bind || {})) {
      if (typeof value === 'function') window[name.replace(/^_/, '')] = value.bind(window);
    }
    for (const name of ['getAllVariables', 'waitGlobalInitialized', 'eventOn', 'eventClearAll', 'errorCatched']) {
      if (typeof window[name] !== 'function' && typeof api[name] === 'function') {
        window[name] = api[name].bind(api);
      }
    }
    Object.defineProperty(window, 'Mvu', { configurable: true, get: () => host.Mvu || api.Mvu });
    addEventListener('pagehide', () => window.eventClearAll?.(), { once: true });
    addEventListener('message', event => {
      if (event.data?.type === 'html-render-tavern:dispose') window.eventClearAll?.();
    });
  } catch (error) {
    console.warn('[HTML Render Tavern] 父页面 API 桥接不可用。', error);
  }
})();
</script>`;
    }

    function createDocument(source, inheritedStyle, useParentBridge) {
        const head = `<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">${useParentBridge ? parentBridgeScript() : ''}`;
        const script = viewportScript();
        // closing-body 注入会特意放在卡片 CSS（包括带有 !important 的 CSS）之后。
        // 它只移除文档级滚动，卡片自身可滚动的面板仍然正常工作。
        const finalStyle = `<style id="hrt-document-style">
html{color:${inheritedStyle.color};font-family:${inheritedStyle.fontFamily};font-size:${inheritedStyle.fontSize};line-height:${inheritedStyle.lineHeight};}
html,body{margin:0!important;padding:0!important;max-width:100%!important;overflow:hidden!important;}
*,*::before,*::after{box-sizing:border-box;}
html{scrollbar-width:none;-ms-overflow-style:none;}
html::-webkit-scrollbar,body::-webkit-scrollbar{width:0!important;height:0!important;display:none!important;}
</style>`;
        let documentSource = source;
        if (/<head(?:\s[^>]*)?>/i.test(source)) {
            documentSource = source.replace(/<head(\s[^>]*)?>/i, match => `${match}${head}`);
        } else {
            documentSource = source.replace(/<body(\s[^>]*)?>/i, match => `<!doctype html><html><head>${head}</head>${match}`);
        }
        return documentSource.replace(/<\/body\s*>/i, `${finalStyle}${script}</body>`);
    }

    function clearRendered(pre) {
        const entry = rendered.get(pre);
        if (!entry) return;
        entry.frame.remove();
        const blobUrl = entry.url || entry.frame.dataset.hrtBlobUrl;
        if (blobUrl) URL.revokeObjectURL(blobUrl);
        pre.classList.remove('hrt-source-hidden');
        rendered.delete(pre);
    }

    function renderKey(pre) {
        const message = pre.closest('.mes');
        const messageId = message?.getAttribute('mesid');
        if (messageId === null || messageId === undefined) return null;
        const blockIndex = [...message.querySelectorAll('pre')].indexOf(pre);
        return `${messageId}:${Math.max(0, blockIndex)}`;
    }

    function removeDuplicateFrames() {
        const seen = new Set();
        document.querySelectorAll('.hrt-frame[data-hrt-key]').forEach(frame => {
            const key = frame.dataset.hrtKey;
            if (!key) return;
            if (seen.has(key)) {
                disposeFrame(frame);
            } else {
                seen.add(key);
            }
        });
    }

    function disposeFrame(frame) {
        try {
            frame.contentWindow?.postMessage({ type: 'html-render-tavern:dispose' }, '*');
            frame.contentWindow?.eventClearAll?.();
        } catch {
            // The iframe may already be detached or navigating.
        }
        const blobUrl = frame.dataset.hrtBlobUrl;
        if (blobUrl) URL.revokeObjectURL(blobUrl);
        frame.src = 'about:blank';
        frame.remove();
    }

    function renderPre(pre) {
        const code = pre.querySelector(':scope > code');
        if (!code || !settings.enabled || !messageIsInDepth(pre)) return;
        const currentEntry = rendered.get(pre);
        if (currentEntry?.frame.isConnected) return;
        if (currentEntry) {
            if (currentEntry.frame.dataset.hrtBlobUrl) URL.revokeObjectURL(currentEntry.frame.dataset.hrtBlobUrl);
            rendered.delete(pre);
        }
        const source = code.textContent ?? '';
        if (!isHtmlDocument(source)) return;

        // SillyTavern 可能会在聊天水合期间重新创建相同的消息节点。
        // 复用现有 iframe，而不是再次渲染一份副本。
        const key = renderKey(pre);
        const existing = key
            ? [...document.querySelectorAll('.hrt-frame[data-hrt-key]')].find(frame => frame.dataset.hrtKey === key)
            : null;
        if (existing) {
            if (settings.hideSource) pre.classList.add('hrt-source-hidden');
            rendered.set(pre, { frame: existing, url: null });
            return;
        }

        const frame = document.createElement('iframe');
        frame.className = 'hrt-frame';
        frame.title = '已渲染的 HTML 消息';
        frame.loading = 'lazy';
        frame.setAttribute('frameborder', '0');
        const message = pre.closest('.mes');
        const messageId = message?.getAttribute('mesid');
        if (messageId !== null && messageId !== undefined) {
            // Tavern Helper 通过稳定的 iframe name/id 识别渲染卡片所属的消息。
            // 所需格式为：
            // TH-message--<message-id>--<code-block-index>.
            const blockIndex = [...message.querySelectorAll('pre')].indexOf(pre);
            frame.id = `TH-message--${messageId}--${Math.max(0, blockIndex)}`;
            frame.name = frame.id;
        }
        if (key) frame.dataset.hrtKey = key;
        if (!settings.parentBridge) frame.setAttribute('sandbox', 'allow-scripts allow-forms allow-modals allow-popups');
        // iframe 不会继承 SillyTavern 的字体或文字颜色。
        // 从外层消息设置默认值，但不覆盖卡片明确指定的 CSS，
        // 这样未设置样式的文字在当前主题中仍然清晰可读。
        const messageText = pre.closest('.mes_text') ?? document.body;
        const inheritedStyle = getComputedStyle(messageText);
        const themeStyle = getComputedStyle(document.documentElement);
        // 卡片或主题可能会有意调暗 `mes_text`。透明的 iframe 文档应改用应用的正常前景色，
        // 就像文字直接写在聊天区域上一样。
        const themeForeground = themeStyle.getPropertyValue('--SmartThemeBodyColor').trim();
        const defaultColor = themeForeground && CSS.supports('color', themeForeground)
            ? themeForeground
            : inheritedStyle.color;
        const documentSource = createDocument(source, {
            color: defaultColor,
            fontFamily: inheritedStyle.fontFamily,
            fontSize: inheritedStyle.fontSize,
            lineHeight: inheritedStyle.lineHeight,
        }, settings.parentBridge);
        let url;
        if (settings.useBlobUrls) {
            url = URL.createObjectURL(new Blob([documentSource], { type: 'text/html' }));
            frame.dataset.hrtBlobUrl = url;
            frame.src = url;
        } else {
            frame.srcdoc = documentSource;
        }

        pre.insertAdjacentElement('afterend', frame);
        frame.addEventListener('load', () => frame.contentWindow?.postMessage({ type: 'html-render-tavern:measure' }, '*'));
        if (settings.hideSource) pre.classList.add('hrt-source-hidden');
        rendered.set(pre, { frame, url });
    }

    function refresh() {
        removeDuplicateFrames();
        document.querySelectorAll('pre').forEach(pre => {
            if (!settings.enabled || !messageIsInDepth(pre)) clearRendered(pre);
            else renderPre(pre);
        });
    }

    function scheduleRefresh() {
        if (queued) return;
        queued = true;
        requestAnimationFrame(() => {
            queued = false;
            refresh();
        });
    }

    function redraw() {
        document.querySelectorAll('pre').forEach(clearRendered);
        scheduleRefresh();
    }

    function addSettingsUi() {
        const host = document.querySelector('#extensions_settings2, #extensions_settings');
        if (!host || document.getElementById('hrt-settings')) return;
        const section = document.createElement('div');
        section.id = 'hrt-settings';
        section.className = 'inline-drawer';
        section.innerHTML = `
<div class="inline-drawer-toggle inline-drawer-header"><b>酒馆渲染器</b><div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div></div>
<div class="inline-drawer-content">
    <label class="checkbox_label"><input data-setting="enabled" type="checkbox"> 启用 HTML 消息渲染</label>
    <label class="checkbox_label"><input data-setting="hideSource" type="checkbox"> 隐藏已渲染的源代码块</label>
    <label class="checkbox_label"><input data-setting="useBlobUrls" type="checkbox"> 使用 Blob URL（便于调试）</label>
    <label class="checkbox_label"><input data-setting="parentBridge" type="checkbox"> 启用 Tavern Helper / MVU 桥接 <small>（仅限受信任的卡片）</small></label>
    <label>渲染最新的 <input data-setting="renderDepth" type="number" min="0" step="1" class="text_pole"> 条消息 <small>（0 = 全部）</small></label>
    <p class="hrt-note">只有包含完整 <code>&lt;body&gt;…&lt;/body&gt;</code> 文档的 fenced code block 才会被渲染。MVU 桥接会特意允许受信任的卡片访问 SillyTavern 页面 API。对于不受信任的 HTML，请将其关闭。</p>
</div>`;
        host.append(section);
        section.querySelectorAll('[data-setting]').forEach(input => {
            const key = input.dataset.setting;
            input.checked = typeof settings[key] === 'boolean' ? settings[key] : false;
            if (input.type === 'number') input.value = settings[key];
            input.addEventListener('change', () => {
                settings[key] = input.type === 'checkbox' ? input.checked : Math.max(0, Number(input.value) || 0);
                if (key === 'parentBridge') settings.sandbox = !settings.parentBridge;
                saveSettings();
                redraw();
            });
        });
    }

    function start() {
        getSettings();
        addSettingsUi();
        const onMessage = event => {
            if (event.data?.type !== 'html-render-tavern:height') return;
            const frame = [...document.querySelectorAll('.hrt-frame')].find(item => item.contentWindow === event.source);
            if (frame && Number.isFinite(event.data.height)) frame.style.height = `${Math.max(1, Math.ceil(event.data.height))}px`;
        };
        window.addEventListener('message', onMessage);
        observer = new MutationObserver(scheduleRefresh);
        observer.observe(document.body, { childList: true, subtree: true, characterData: true });
        window.__HTML_RENDER_TAVERN__ = {
            destroy() {
                observer?.disconnect();
                window.removeEventListener('message', onMessage);
                document.querySelectorAll('.hrt-frame').forEach(disposeFrame);
                document.querySelectorAll('pre.hrt-source-hidden').forEach(pre => pre.classList.remove('hrt-source-hidden'));
            },
        };
        scheduleRefresh();
    }

    if (document.readyState === 'loading') {
        const onReady = () => {
            if (!startupCancelled) start();
        };
        window.__HTML_RENDER_TAVERN__ = {
            destroy() {
                startupCancelled = true;
                document.removeEventListener('DOMContentLoaded', onReady);
            },
        };
        document.addEventListener('DOMContentLoaded', onReady, { once: true });
    } else {
        start();
    }
})();
