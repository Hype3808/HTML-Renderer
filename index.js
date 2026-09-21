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
    let isDestroyed = false;
    let refreshRafId = null;

    // 流式传输与生成状态跟踪
    let isGenerating = false;
    let streamingMessageId = null;
    let streamTokenTimer = null;
    const activeMutatingMesIds = new Set();

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
        settings.renderDepth = Math.max(0, Number(settings.renderDepth) || 0);
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
        const saveFn = window.saveSettingsDebounced || window.SillyTavern?.getContext?.()?.saveSettingsDebounced || window.saveSettings;
        saveFn?.();
    }

    function isSupportedLanguage(code) {
        const className = code.className || '';
        const match = className.match(/(?:^|\s)(?:language|lang)-([a-zA-Z0-9_-]+)(?:\s|$)/i);
        if (!match) return true; // 未指定语言，允许匹配
        const lang = match[1].toLowerCase();
        return ['html', 'htm', 'xhtml', 'xml'].includes(lang);
    }

    function isHtmlDocument(source) {
        return /<body(?:\s[^>]*)?>[\s\S]*<\/body\s*>/i.test(source);
    }

    function checkContextIsGenerating() {
        try {
            const context = window.SillyTavern?.getContext?.();
            if (typeof context?.isGenerating === 'boolean') {
                return context.isGenerating;
            }
        } catch {}
        return false;
    }

    function isGenerationInProgress() {
        const stopBtn = document.getElementById('mes_stop') || document.querySelector('.mes_stop');
        const isStopVisible = Boolean(stopBtn && (stopBtn.offsetParent !== null || getComputedStyle(stopBtn).display !== 'none'));
        const sendBtn = document.getElementById('send_but');
        const isSendVisible = Boolean(sendBtn && (sendBtn.offsetParent !== null || getComputedStyle(sendBtn).display !== 'none'));

        // 如果停止按钮已隐藏且发送按钮可见，说明生成已结束
        if (stopBtn && !isStopVisible && isSendVisible) {
            if (isGenerating) {
                isGenerating = false;
                streamingMessageId = null;
                activeMutatingMesIds.clear();
            }
            return false;
        }

        if (isStopVisible) return true;
        if (isGenerating) return true;
        if (checkContextIsGenerating()) return true;

        const loading = document.getElementById('loading_mes') || document.querySelector('.typing_indicator, .loading_mes');
        if (loading && (loading.offsetParent !== null || getComputedStyle(loading).display !== 'none')) {
            return true;
        }

        return false;
    }

    function isMessageStreaming(message) {
        if (!message) return false;
        if (message.getAttribute('is_streaming') === 'true' ||
            message.classList.contains('streaming') ||
            message.classList.contains('is_streaming')) {
            return true;
        }
        if (isGenerationInProgress()) {
            const mesId = message.getAttribute('mesid');
            if (streamingMessageId !== null && mesId !== null && mesId === String(streamingMessageId)) {
                return true;
            }
            if (mesId !== null && activeMutatingMesIds.has(mesId)) {
                return true;
            }
            const lastMes = document.querySelector('#chat .mes:last-child');
            if (message === lastMes) {
                return true;
            }
        }
        return false;
    }

    function viewportScript() {
        // 此脚本在卡片标记之后运行，负责实时精确测量内容尺寸并向宿主窗口回报。
        return `<script>
(() => {
  let lastReportedHeight = 0;
  let rafId = null;

  const height = () => {
    const body = document.body;
    const html = document.documentElement;
    if (!body || !html) return 1;

    // 测量可见内容的底部边缘，准确计算增加与缩小，并兼容底部 margin 与 padding
    const bodyTop = body.getBoundingClientRect().top;
    let contentBottom = 0;
    for (const child of body.children) {
      if (child.tagName === 'SCRIPT' || child.tagName === 'STYLE' || child.tagName === 'LINK') continue;
      const style = window.getComputedStyle(child);
      if (style.display === 'none' || style.position === 'fixed') continue;
      const rect = child.getBoundingClientRect();
      const marginBottom = parseFloat(style.marginBottom) || 0;
      if (rect.width || rect.height) {
        contentBottom = Math.max(contentBottom, rect.bottom - bodyTop + marginBottom);
      }
    }
    const bodyPaddingBottom = parseFloat(window.getComputedStyle(body).paddingBottom) || 0;
    if (contentBottom > 0) return Math.ceil(contentBottom + bodyPaddingBottom);
    return Math.max(1, body.scrollHeight);
  };

  const report = () => {
    if (rafId) cancelAnimationFrame(rafId);
    rafId = requestAnimationFrame(() => {
      rafId = null;
      const h = height();
      if (Math.abs(h - lastReportedHeight) >= 1) {
        lastReportedHeight = h;
        try {
          parent.postMessage({ type: 'html-render-tavern:height', height: h }, '*');
        } catch {}
      }
    });
  };

  const resizeObservers = [];
  const mutationObservers = [];
  const observe = () => {
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
    if (rafId) cancelAnimationFrame(rafId);
    resizeObservers.forEach(observer => observer.disconnect());
    mutationObservers.forEach(observer => observer.disconnect());
  };

  // 外链处理：哈希锚点与 javascript 留在内部，外部链接自动新标签打开
  document.addEventListener('click', event => {
    const link = event.target.closest('a');
    if (!link) return;
    const href = link.getAttribute('href');
    if (href && !href.startsWith('#') && !href.startsWith('javascript:') && !link.target) {
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
    }
  });

  observe();
  addEventListener('pagehide', stop, { once: true });
  addEventListener('resize', report);
  addEventListener('load', () => { report(); setTimeout(report, 100); });
  document.fonts?.ready?.then(report);
  document.querySelectorAll('img').forEach(img => {
    if (!img.complete) {
      img.addEventListener('load', report, { once: true });
      img.addEventListener('error', report, { once: true });
    }
  });
  addEventListener('message', event => { if (event.data?.type === 'html-render-tavern:measure') report(); });
  addEventListener('message', event => {
    if (event.data?.type === 'html-render-tavern:dispose') stop();
  });
  report();
})();
</script>`;
    }

    function parentBridgeScript() {
        // 卡片运行在自己的文档中，但 Tavern Helper / MVU 卡片需要便捷的全局对象与 API。
        return `<script>
(() => {
  try {
    const host = window.parent;
    const api = host.TavernHelper || host;
    const hostJQuery = host.jQuery || host.$;
    if (hostJQuery) {
      const localJQuery = function(selector, context) {
        if (typeof selector === 'function') {
          if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', () => selector(localJQuery), { once: true });
          } else {
            selector(localJQuery);
          }
          return localJQuery(document);
        }
        return hostJQuery(selector, context || document);
      };
      Object.assign(localJQuery, hostJQuery);
      localJQuery.fn = hostJQuery.fn;
      window.$ = window.jQuery = localJQuery;
    }
    if (host._) window._ = host._;
    if (host.toastr) window.toastr = host.toastr;
    if (host.TavernHelper || api) window.TavernHelper = host.TavernHelper || api;

    // 绑定 Tavern Helper 的 _bind 函数（以 iframe window 作为调用上下文）
    for (const [name, value] of Object.entries(api._bind || {})) {
      if (typeof value === 'function') window[name.replace(/^_/, '')] = value.bind(window);
    }
    const standardApis = [
      'getAllVariables', 'getVariable', 'getVariables', 'setVariable', 'setVariables',
      'updateVariable', 'deleteVariable', 'waitGlobalInitialized', 'eventOn', 'eventOnce',
      'eventEmit', 'eventClearAll', 'getButtonEvent', 'getIframeName', 'errorCatched',
      'triggerSlash', 'executeSlashCommands', 'sendSystemMessage', 'insertUserMessage',
      'saveChat', 'getChat', 'reloadCurrentChat', 'replaceTavernRegexes'
    ];
    for (const name of standardApis) {
      if (typeof window[name] !== 'function' && typeof api[name] === 'function') {
        window[name] = typeof api._bind?.[name] === 'function'
          ? api._bind[name].bind(window)
          : api[name].bind(window);
      }
    }
    const getMvu = () => {
      try {
        return host.Mvu || api.Mvu || host.mvu || api.mvu;
      } catch {
        return undefined;
      }
    };
    Object.defineProperty(window, 'Mvu', { configurable: true, get: getMvu });
    Object.defineProperty(window, 'mvu', { configurable: true, get: getMvu });

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
        const headContent = `<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style id="hrt-initial-style">
html,body{margin:0;padding:0;background-color:transparent;color:${inheritedStyle.color};font-family:${inheritedStyle.fontFamily};font-size:${inheritedStyle.fontSize};line-height:${inheritedStyle.lineHeight};}
*,*::before,*::after{box-sizing:border-box;}
</style>${useParentBridge ? parentBridgeScript() : ''}`;
        const script = viewportScript();
        const finalStyle = `<style id="hrt-document-style">
html,body{max-width:100%!important;overflow:hidden!important;}
html{scrollbar-width:none;-ms-overflow-style:none;}
html::-webkit-scrollbar,body::-webkit-scrollbar{width:0!important;height:0!important;display:none!important;}
</style>`;

        let documentSource = source;
        if (/<head(?:\s[^>]*)?>/i.test(source)) {
            documentSource = source.replace(/<head(\s[^>]*)?>/i, match => `${match}${headContent}`);
        } else if (/<html(?:\s[^>]*)?>/i.test(source)) {
            documentSource = source.replace(/<html(\s[^>]*)?>/i, match => `${match}<head>${headContent}</head>`);
        } else {
            documentSource = `<!doctype html><html><head>${headContent}</head>${source}`;
        }

        const lastBodyIndex = documentSource.toLowerCase().lastIndexOf('</body>');
        if (lastBodyIndex !== -1) {
            documentSource = documentSource.slice(0, lastBodyIndex) + finalStyle + script + documentSource.slice(lastBodyIndex);
        } else {
            documentSource = documentSource + finalStyle + script;
        }

        if (!/<\/html\s*>/i.test(documentSource)) {
            documentSource += '</html>';
        }

        return documentSource;
    }

    function renderKey(pre) {
        const message = pre.closest('.mes');
        const messageId = message?.getAttribute('mesid');
        if (messageId === null || messageId === undefined) return null;
        const htmlPres = [...message.querySelectorAll('pre')].filter(p => {
            const c = p.querySelector(':scope > code');
            return c && isSupportedLanguage(c) && isHtmlDocument(c.textContent ?? '');
        });
        const blockIndex = htmlPres.indexOf(pre);
        return `${messageId}:${Math.max(0, blockIndex)}`;
    }

    function disposeFrame(frame) {
        if (!frame || frame.__hrt_disposed) return;
        frame.__hrt_disposed = true;
        try {
            frame.contentWindow?.postMessage({ type: 'html-render-tavern:dispose' }, '*');
            frame.contentWindow?.eventClearAll?.();
        } catch {
            // The iframe may already be detached or cross-origin.
        }
        const blobUrl = frame.dataset.hrtBlobUrl;
        if (blobUrl) URL.revokeObjectURL(blobUrl);
        try {
            frame.src = 'about:blank';
        } catch {
            // Frame might be detached
        }
        frame.remove();
    }

    function clearRendered(pre) {
        const entry = rendered.get(pre);
        if (!entry) return;
        disposeFrame(entry.frame);
        pre.classList.remove('hrt-source-hidden');
        rendered.delete(pre);
    }

    function cleanOrphanAndDuplicateFrames() {
        const seen = new Set();
        document.querySelectorAll('.hrt-frame').forEach(frame => {
            const key = frame.dataset.hrtKey;
            const prev = frame.previousElementSibling;
            // 孤儿 frame 清理：若前驱不是 pre，说明源代码块已被编辑或移除
            if (!prev || prev.tagName !== 'PRE') {
                disposeFrame(frame);
                return;
            }
            if (key) {
                if (seen.has(key)) {
                    disposeFrame(frame);
                } else {
                    seen.add(key);
                }
            }
        });
    }

    function renderPre(pre, allowedMessages) {
        const code = pre.querySelector(':scope > code');
        if (!code || !settings.enabled) return;
        if (!isSupportedLanguage(code)) return;

        const message = pre.closest('.mes');
        if (!message || isMessageStreaming(message)) return;
        if (allowedMessages && !allowedMessages.has(message)) return;

        const source = code.textContent ?? '';
        if (!isHtmlDocument(source)) return;

        const currentEntry = rendered.get(pre);
        if (currentEntry?.frame.isConnected && currentEntry.source === source) return;

        if (currentEntry) {
            disposeFrame(currentEntry.frame);
            rendered.delete(pre);
        }

        const key = renderKey(pre);
        // 若已有紧跟当前 pre 的同 key iframe，直接复用
        const nextElem = pre.nextElementSibling;
        if (nextElem?.classList.contains('hrt-frame') && nextElem.dataset.hrtKey === key) {
            if (settings.hideSource) pre.classList.add('hrt-source-hidden');
            rendered.set(pre, { frame: nextElem, url: null, source });
            return;
        }

        const frame = document.createElement('iframe');
        frame.className = 'hrt-frame';
        frame.title = '已渲染的 HTML 消息';
        frame.loading = 'eager';
        frame.setAttribute('frameborder', '0');
        frame.setAttribute('scrolling', 'no');
        frame.setAttribute('allowtransparency', 'true');

        const messageId = message.getAttribute('mesid');
        if (messageId !== null && messageId !== undefined) {
            // Tavern Helper 格式：TH-message--楼层号--前端界面是该楼层第几个界面
            const blockIndex = key ? key.split(':')[1] : '0';
            frame.id = `TH-message--${messageId}--${blockIndex}`;
            frame.name = frame.id;
        }
        if (key) frame.dataset.hrtKey = key;
        if (!settings.parentBridge) {
            frame.setAttribute('sandbox', 'allow-scripts allow-forms allow-modals allow-popups allow-downloads');
        }

        // iframe 默认样式与主题继承
        const messageText = pre.closest('.mes_text') ?? document.body;
        const inheritedStyle = getComputedStyle(messageText);
        const themeStyle = getComputedStyle(document.documentElement);
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

        let url = null;
        const useBlob = settings.useBlobUrls || /<!--\s*enable-blob-url-render\s*-->/i.test(source);
        if (useBlob) {
            url = URL.createObjectURL(new Blob([documentSource], { type: 'text/html' }));
            frame.dataset.hrtBlobUrl = url;
            frame.src = url;
        } else {
            frame.srcdoc = documentSource;
        }

        pre.insertAdjacentElement('afterend', frame);
        frame.addEventListener('load', () => frame.contentWindow?.postMessage({ type: 'html-render-tavern:measure' }, '*'), { once: true });
        if (settings.hideSource) pre.classList.add('hrt-source-hidden');
        rendered.set(pre, { frame, url, source });
    }

    function refresh() {
        if (isDestroyed) return;
        cleanOrphanAndDuplicateFrames();
        if (!document.getElementById('hrt-settings')) addSettingsUi();

        const chat = document.getElementById('chat');
        if (!chat) return;

        const chatMessages = settings.renderDepth > 0 ? [...chat.querySelectorAll('.mes')] : null;
        const allowedMessages = chatMessages ? new Set(chatMessages.slice(-settings.renderDepth)) : null;

        chat.querySelectorAll('pre').forEach(pre => {
            const message = pre.closest('.mes');
            if (isMessageStreaming(message)) {
                return; // 流式传输期间暂不渲染，避免频繁创建/销毁 iframe 导致界面卡顿、重置与动画闪烁
            }
            if (!settings.enabled || (allowedMessages && !allowedMessages.has(message))) {
                clearRendered(pre);
            } else {
                renderPre(pre, allowedMessages);
            }
        });
    }

    function scheduleRefresh() {
        if (isDestroyed || queued) return;
        queued = true;
        refreshRafId = requestAnimationFrame(() => {
            queued = false;
            refreshRafId = null;
            if (!isDestroyed) refresh();
        });
    }

    function redraw() {
        if (isDestroyed) return;
        const chat = document.getElementById('chat') || document;
        chat.querySelectorAll('pre').forEach(clearRendered);
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
            const onChange = () => {
                settings[key] = input.type === 'checkbox' ? input.checked : Math.max(0, Number(input.value) || 0);
                if (key === 'parentBridge') settings.sandbox = !settings.parentBridge;
                saveSettings();
                redraw();
            };
            input.addEventListener('change', onChange);
            if (input.type === 'number') input.addEventListener('input', onChange);
        });
    }

    function start() {
        getSettings();
        addSettingsUi();

        const onMessage = event => {
            if (event.data?.type !== 'html-render-tavern:height') return;
            const frame = [...document.querySelectorAll('.hrt-frame')].find(item => item.contentWindow === event.source);
            if (frame && Number.isFinite(event.data.height)) {
                const targetHeight = `${Math.max(1, Math.ceil(event.data.height))}px`;
                if (frame.style.height !== targetHeight) {
                    frame.style.height = targetHeight;
                }
                if (!frame.classList.contains('hrt-ready')) {
                    frame.classList.add('hrt-ready');
                }
            }
        };
        window.addEventListener('message', onMessage);

        observer = new MutationObserver(mutations => {
            const generating = isGenerationInProgress();
            for (const mutation of mutations) {
                if (generating) {
                    const targetEl = mutation.target.nodeType === Node.ELEMENT_NODE
                        ? mutation.target
                        : mutation.target.parentElement;
                    const mes = targetEl?.closest?.('.mes');
                    const mesId = mes?.getAttribute('mesid');
                    if (mesId !== null && mesId !== undefined) {
                        activeMutatingMesIds.add(mesId);
                    }
                }
                for (const node of mutation.removedNodes) {
                    if (node.nodeType === Node.ELEMENT_NODE) {
                        if (node.classList?.contains('hrt-frame')) {
                            disposeFrame(node);
                        } else if (node.querySelectorAll) {
                            node.querySelectorAll('.hrt-frame').forEach(disposeFrame);
                        }
                    }
                }
            }
            scheduleRefresh();
        });
        observer.observe(document.body, { childList: true, subtree: true });

        // 绑定 SillyTavern 事件系统（如果可用）
        const eventSource = window.eventSource || window.SillyTavern?.getContext?.()?.eventSource;
        const event_types = window.event_types || window.SillyTavern?.getContext?.()?.event_types;
        const onChatEvent = () => scheduleRefresh();

        const onGenStarted = () => {
            isGenerating = true;
        };

        const onTokenReceived = data => {
            isGenerating = true;
            const id = data?.messageId ?? data?.mesId ?? (typeof data === 'number' ? data : null);
            if (id !== null && id !== undefined) {
                streamingMessageId = String(id);
            }
            if (streamTokenTimer) clearTimeout(streamTokenTimer);
            streamTokenTimer = setTimeout(() => {
                if (!isGenerationInProgress()) {
                    onGenEnded();
                }
            }, 600);
        };

        const onGenEnded = () => {
            if (streamTokenTimer) {
                clearTimeout(streamTokenTimer);
                streamTokenTimer = null;
            }
            isGenerating = false;
            streamingMessageId = null;
            activeMutatingMesIds.clear();
            scheduleRefresh();
        };

        if (eventSource && event_types) {
            if (event_types.GENERATION_STARTED) eventSource.on(event_types.GENERATION_STARTED, onGenStarted);
            if (event_types.STREAM_TOKEN_RECEIVED) eventSource.on(event_types.STREAM_TOKEN_RECEIVED, onTokenReceived);
            if (event_types.GENERATION_ENDED) eventSource.on(event_types.GENERATION_ENDED, onGenEnded);
            if (event_types.GENERATION_STOPPED) eventSource.on(event_types.GENERATION_STOPPED, onGenEnded);
            if (event_types.CHARACTER_MESSAGE_RENDERED) eventSource.on(event_types.CHARACTER_MESSAGE_RENDERED, onGenEnded);
            if (event_types.USER_MESSAGE_RENDERED) eventSource.on(event_types.USER_MESSAGE_RENDERED, onChatEvent);
            if (event_types.CHAT_CHANGED) eventSource.on(event_types.CHAT_CHANGED, onChatEvent);
            if (event_types.MESSAGE_DELETED) eventSource.on(event_types.MESSAGE_DELETED, onChatEvent);
            if (event_types.MESSAGE_SWIPED) eventSource.on(event_types.MESSAGE_SWIPED, onChatEvent);
            if (event_types.MESSAGE_UPDATED) eventSource.on(event_types.MESSAGE_UPDATED, onChatEvent);
        }

        window.__HTML_RENDER_TAVERN__ = {
            destroy() {
                isDestroyed = true;
                if (refreshRafId) {
                    cancelAnimationFrame(refreshRafId);
                    refreshRafId = null;
                }
                if (streamTokenTimer) {
                    clearTimeout(streamTokenTimer);
                    streamTokenTimer = null;
                }
                isGenerating = false;
                streamingMessageId = null;
                activeMutatingMesIds.clear();

                observer?.disconnect();
                window.removeEventListener('message', onMessage);
                if (eventSource && event_types) {
                    const remove = (ev, fn) => {
                        eventSource.removeListener?.(ev, fn);
                        eventSource.off?.(ev, fn);
                    };
                    if (event_types.GENERATION_STARTED) remove(event_types.GENERATION_STARTED, onGenStarted);
                    if (event_types.STREAM_TOKEN_RECEIVED) remove(event_types.STREAM_TOKEN_RECEIVED, onTokenReceived);
                    if (event_types.GENERATION_ENDED) remove(event_types.GENERATION_ENDED, onGenEnded);
                    if (event_types.GENERATION_STOPPED) remove(event_types.GENERATION_STOPPED, onGenEnded);
                    if (event_types.CHARACTER_MESSAGE_RENDERED) remove(event_types.CHARACTER_MESSAGE_RENDERED, onGenEnded);
                    if (event_types.USER_MESSAGE_RENDERED) remove(event_types.USER_MESSAGE_RENDERED, onChatEvent);
                    if (event_types.CHAT_CHANGED) remove(event_types.CHAT_CHANGED, onChatEvent);
                    if (event_types.MESSAGE_DELETED) remove(event_types.MESSAGE_DELETED, onChatEvent);
                    if (event_types.MESSAGE_SWIPED) remove(event_types.MESSAGE_SWIPED, onChatEvent);
                    if (event_types.MESSAGE_UPDATED) remove(event_types.MESSAGE_UPDATED, onChatEvent);
                }
                document.getElementById('hrt-settings')?.remove();
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
