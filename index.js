/*
 * HTML Render Tavern
 * A focused, dependency-free HTML renderer for SillyTavern message code blocks.
 *
 * Inspired by the iframe rendering approach in N0VI028/JS-Slash-Runner.
 */
(() => {
    'use strict';

    const EXTENSION_ID = 'html-render-tavern';
    const SETTINGS_KEY = 'htmlRenderTavern';
    const DEFAULTS = Object.freeze({
        enabled: true,
        renderDepth: 0,
        hideSource: true,
        useBlobUrls: false,
        // JS-Slash-Runner-compatible cards use Tavern Helper / MVU globals.
        // That requires a same-origin iframe, so it is a trusted-card mode.
        parentBridge: true,
        sandbox: false,
    });
    const rendered = new WeakMap();
    let settings;
    let observer;
    let queued = false;

    function getSettings() {
        window.extension_settings ??= {};
        const stored = window.extension_settings[SETTINGS_KEY] ?? {};
        settings = { ...DEFAULTS, ...stored };
        // Version 1.0.0 saved `sandbox: true`; migrate it to the compatible
        // default on upgrade. Users can switch back to isolation in settings.
        if (stored.parentBridge === undefined) {
            settings.parentBridge = true;
            settings.sandbox = false;
        }
        window.extension_settings[SETTINGS_KEY] = settings;
        return settings;
    }

    function saveSettings() {
        window.extension_settings[SETTINGS_KEY] = settings;
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
        // This runs after the card markup, so its first measurement includes the
        // card's own styles and layout instead of the browser's 150px iframe default.
        return `<script>
(() => {
  const height = () => Math.max(
    document.documentElement.scrollHeight, document.documentElement.offsetHeight,
    document.body ? document.body.scrollHeight : 0, document.body ? document.body.offsetHeight : 0
  );
  const report = () => parent.postMessage({ type: 'html-render-tavern:height', height: height() }, '*');
  const observe = () => {
    new ResizeObserver(report).observe(document.documentElement);
    if (document.body) new ResizeObserver(report).observe(document.body);
    new MutationObserver(report).observe(document.documentElement, { childList: true, subtree: true, attributes: true, characterData: true });
  };
  observe();
  addEventListener('load', () => { report(); requestAnimationFrame(report); setTimeout(report, 100); });
  document.fonts?.ready?.then(report);
  addEventListener('message', event => { if (event.data?.type === 'html-render-tavern:measure') report(); });
  requestAnimationFrame(report);
})();
</script>`;
    }

    function parentBridgeScript() {
        // The card runs in its own document, but older Tavern Helper cards expect
        // its convenience globals. Keep DOM queries local while forwarding only
        // the explicit Tavern Helper / MVU functions and values from the parent.
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
    // Tavern Helper puts iframe-aware functions in its _bind map. Binding those to this
    // iframe window is essential: getAllVariables() can then resolve the message
    // that owns this card instead of reading the newest chat message.
    for (const [name, value] of Object.entries(api._bind || {})) {
      if (typeof value === 'function') window[name.replace(/^_/, '')] = value.bind(window);
    }
    for (const name of ['getAllVariables', 'waitGlobalInitialized', 'eventOn', 'errorCatched']) {
      if (typeof window[name] !== 'function' && typeof api[name] === 'function') {
        window[name] = api[name].bind(api);
      }
    }
    Object.defineProperty(window, 'Mvu', { configurable: true, get: () => host.Mvu || api.Mvu });
  } catch (error) {
    console.warn('[HTML Render Tavern] Parent API bridge is unavailable.', error);
  }
})();
</script>`;
    }

    function createDocument(source, inheritedStyle, useParentBridge) {
        const head = `<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">${useParentBridge ? parentBridgeScript() : ''}`;
        const script = viewportScript();
        // The closing-body injection intentionally comes after card CSS, including
        // CSS with !important. It removes only document-level scrolling; a card's
        // own scrollable panels remain functional.
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
        if (entry.url) URL.revokeObjectURL(entry.url);
        pre.classList.remove('hrt-source-hidden');
        rendered.delete(pre);
    }

    function renderPre(pre) {
        const code = pre.querySelector(':scope > code');
        if (!code || rendered.has(pre) || !settings.enabled || !messageIsInDepth(pre)) return;
        const source = code.textContent ?? '';
        if (!isHtmlDocument(source)) return;

        const frame = document.createElement('iframe');
        frame.className = 'hrt-frame';
        frame.title = 'Rendered HTML message';
        frame.loading = 'lazy';
        frame.setAttribute('frameborder', '0');
        const messageId = pre.closest('.mes')?.getAttribute('mesid');
        if (messageId !== null && messageId !== undefined) {
            // Tavern Helper identifies a rendered-card's owning message from this
            // stable iframe name/id. The bridge's bound helpers rely on it.
            frame.id = `TH-message--${messageId}`;
            frame.name = frame.id;
        }
        if (!settings.parentBridge) frame.setAttribute('sandbox', 'allow-scripts allow-forms allow-modals allow-popups');
        // An iframe does not inherit SillyTavern's typography or text colour.
        // Seed its defaults from the enclosing message without overriding a card's
        // explicit CSS, so unstyled text remains readable in the active theme.
        const messageText = pre.closest('.mes_text') ?? document.body;
        const inheritedStyle = getComputedStyle(messageText);
        const themeStyle = getComputedStyle(document.documentElement);
        // `mes_text` can intentionally be dimmed by a card/theme. Transparent
        // iframe documents should instead start with the app's normal foreground
        // colour, as if their text were written directly into the chat surface.
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
<div class="inline-drawer-toggle inline-drawer-header"><b>HTML Render Tavern</b><div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div></div>
<div class="inline-drawer-content">
  <label class="checkbox_label"><input data-setting="enabled" type="checkbox"> Enable HTML message rendering</label>
  <label class="checkbox_label"><input data-setting="hideSource" type="checkbox"> Hide rendered source blocks</label>
  <label class="checkbox_label"><input data-setting="useBlobUrls" type="checkbox"> Use Blob URLs (debug friendly)</label>
  <label class="checkbox_label"><input data-setting="parentBridge" type="checkbox"> Enable Tavern Helper / MVU bridge <small>(trusted cards only)</small></label>
  <label>Render newest <input data-setting="renderDepth" type="number" min="0" step="1" class="text_pole"> messages <small>(0 = all)</small></label>
  <p class="hrt-note">Only fenced code blocks containing a complete <code>&lt;body&gt;…&lt;/body&gt;</code> document are rendered. The MVU bridge intentionally allows trusted cards to access SillyTavern page APIs. Turn it off for untrusted HTML.</p>
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
        window.addEventListener('message', event => {
            if (event.data?.type !== 'html-render-tavern:height') return;
            const frame = [...document.querySelectorAll('.hrt-frame')].find(item => item.contentWindow === event.source);
            if (frame && Number.isFinite(event.data.height)) frame.style.height = `${Math.max(1, Math.ceil(event.data.height))}px`;
        });
        observer = new MutationObserver(scheduleRefresh);
        observer.observe(document.body, { childList: true, subtree: true, characterData: true });
        scheduleRefresh();
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true });
    else start();
})();
