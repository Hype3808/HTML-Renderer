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
        sandbox: true,
    });
    const rendered = new WeakMap();
    let settings;
    let observer;
    let queued = false;

    function getSettings() {
        window.extension_settings ??= {};
        const stored = window.extension_settings[SETTINGS_KEY] ?? {};
        settings = { ...DEFAULTS, ...stored };
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
        // This runs inside the iframe only. It reports document height to its host.
        return `<script>
(() => {
  const report = () => parent.postMessage({ type: 'html-render-tavern:height', height: Math.max(document.documentElement.scrollHeight, document.body ? document.body.scrollHeight : 0) }, '*');
  new ResizeObserver(report).observe(document.documentElement);
  addEventListener('load', report);
  setTimeout(report, 0);
})();
</script>`;
    }

    function createDocument(source) {
        const head = `<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<style>html,body{margin:0;padding:0;max-width:100%;overflow-x:hidden}*,*::before,*::after{box-sizing:border-box}</style>`;
        const script = viewportScript();
        if (/<head(?:\s[^>]*)?>/i.test(source)) {
            return source.replace(/<head(\s[^>]*)?>/i, match => `${match}${head}${script}`);
        }
        return source.replace(/<body(\s[^>]*)?>/i, match => `<!doctype html><html><head>${head}${script}</head>${match}`);
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
        if (settings.sandbox) frame.setAttribute('sandbox', 'allow-scripts allow-forms allow-modals allow-popups');
        const documentSource = createDocument(source);
        let url;
        if (settings.useBlobUrls) {
            url = URL.createObjectURL(new Blob([documentSource], { type: 'text/html' }));
            frame.src = url;
        } else {
            frame.srcdoc = documentSource;
        }

        pre.insertAdjacentElement('afterend', frame);
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
  <label class="checkbox_label"><input data-setting="sandbox" type="checkbox"> Sandbox rendered HTML (recommended)</label>
  <label>Render newest <input data-setting="renderDepth" type="number" min="0" step="1" class="text_pole"> messages <small>(0 = all)</small></label>
  <p class="hrt-note">Only fenced code blocks containing a complete <code>&lt;body&gt;…&lt;/body&gt;</code> document are rendered. HTML and scripts from a message are untrusted code.</p>
</div>`;
        host.append(section);
        section.querySelectorAll('[data-setting]').forEach(input => {
            const key = input.dataset.setting;
            input.checked = typeof settings[key] === 'boolean' ? settings[key] : false;
            if (input.type === 'number') input.value = settings[key];
            input.addEventListener('change', () => {
                settings[key] = input.type === 'checkbox' ? input.checked : Math.max(0, Number(input.value) || 0);
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
