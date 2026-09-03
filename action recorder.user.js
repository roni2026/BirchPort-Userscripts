// ==UserScript==
// @name         Action Recorder (clicks/typing/selects, cross-frame)
// @namespace    roni2026.tools
// @version      1.0
// @description  Record clicks, typed values, and selections (including same-origin iframes), then generate a readable + JSON log you can hand to an assistant to build a script.
// @match        *://*/*
// @grant        none
// @run-at       document-idle
// ==/UserScript==

(function () {
    'use strict';

    // ============================================================
    // State
    // ============================================================
    let recording = false;
    let events = [];
    let startTime = 0;
    let attachedListeners = []; // {doc, type, handler, capture}
    let observedFrames = new WeakSet();
    let frameCounter = 0;
    const framePaths = new WeakMap(); // document -> label

    // ============================================================
    // Persistence — survives page reloads/navigations (same tab, same origin)
    // ============================================================
    const STORAGE_KEY = 'actRecorderPersistedState_v1';

    function saveState() {
        try {
            sessionStorage.setItem(STORAGE_KEY, JSON.stringify({
                recording, events, startTime, frameCounter
            }));
        } catch (e) { /* storage unavailable — recording just won't survive a reload */ }
    }

    function loadState() {
        try {
            const raw = sessionStorage.getItem(STORAGE_KEY);
            return raw ? JSON.parse(raw) : null;
        } catch (e) { return null; }
    }

    function clearState() {
        try { sessionStorage.removeItem(STORAGE_KEY); } catch (e) {}
    }

    window.addEventListener('beforeunload', () => { if (recording) saveState(); });

    // ============================================================
    // UI
    // ============================================================
    const style = document.createElement('style');
    style.textContent = `
        #actRecorderPanel {
            position: fixed; top: 20px; right: 20px; width: 320px;
            background: #1e1f29; color: #f8f8f2; border: 1px solid #44475a;
            border-radius: 10px; box-shadow: 0 8px 24px rgba(0,0,0,0.45);
            z-index: 2147483647; font-family: "Segoe UI", Arial, sans-serif;
            font-size: 13px; overflow: hidden;
        }
        #actRecorderHeader {
            background: #282a36; padding: 8px 12px; cursor: move;
            display: flex; justify-content: space-between; align-items: center;
            border-bottom: 1px solid #44475a; user-select: none;
        }
        #actRecorderHeader span { font-weight: 600; color: #ff79c6; }
        #actRecorderHeader button { background: none; border: none; color: #f8f8f2; cursor: pointer; font-size: 15px; }
        #actRecorderBody { padding: 10px 12px; }
        .actRecorderBtnRow { display: flex; gap: 6px; margin-bottom: 8px; }
        .actRecorderBtnRow button {
            flex: 1; padding: 8px 6px; border: none; border-radius: 6px;
            cursor: pointer; font-weight: 700; font-size: 12px;
        }
        #actRecorderStart { background: #50fa7b; color: #1e1f29; }
        #actRecorderStop { background: #ff5555; color: #1e1f29; }
        #actRecorderCopy { background: #8be9fd; color: #1e1f29; }
        #actRecorderClear { background: #44475a; color: #f8f8f2; }
        #actRecorderStatus {
            font-size: 12px; margin-bottom: 6px; color: #f1fa8c;
        }
        #actRecorderOutput {
            width: 100%; height: 180px; resize: vertical;
            background: #14151c; color: #f8f8f2; border: 1px solid #44475a;
            border-radius: 6px; padding: 6px; box-sizing: border-box;
            font-family: monospace; font-size: 11px;
        }
        #actRecorderToggleBtn {
            position: fixed; top: 20px; right: 20px; z-index: 2147483646;
            background: #ff79c6; color: #1e1f29; border: none; padding: 8px 12px;
            border-radius: 8px; font-weight: 700; cursor: pointer;
            box-shadow: 0 4px 12px rgba(0,0,0,0.4); display: none;
        }
    `;
    document.head.appendChild(style);

    const panel = document.createElement('div');
    panel.id = 'actRecorderPanel';
    panel.innerHTML = `
        <div id="actRecorderHeader">
            <span>Action Recorder</span>
            <button id="actRecorderHide" title="Minimize">&minus;</button>
        </div>
        <div id="actRecorderBody">
            <div id="actRecorderStatus">Idle. Click Start, then use the page normally.</div>
            <div class="actRecorderBtnRow">
                <button id="actRecorderStart">Start</button>
                <button id="actRecorderStop" disabled>Stop</button>
            </div>
            <div class="actRecorderBtnRow">
                <button id="actRecorderCopy">Copy Log</button>
                <button id="actRecorderClear">Clear</button>
            </div>
            <textarea id="actRecorderOutput" placeholder="Recorded steps will appear here after Stop..." readonly></textarea>
        </div>
    `;
    document.body.appendChild(panel);

    const toggleBtn = document.createElement('button');
    toggleBtn.id = 'actRecorderToggleBtn';
    toggleBtn.textContent = 'Recorder';
    document.body.appendChild(toggleBtn);

    document.getElementById('actRecorderHide').addEventListener('click', () => {
        panel.style.display = 'none';
        toggleBtn.style.display = 'block';
    });
    toggleBtn.addEventListener('click', () => {
        panel.style.display = 'block';
        toggleBtn.style.display = 'none';
    });

    (function makeDraggable() {
        const header = document.getElementById('actRecorderHeader');
        let dragging = false, offsetX = 0, offsetY = 0;
        header.addEventListener('mousedown', (e) => {
            if (e.target.tagName === 'BUTTON') return;
            dragging = true;
            const rect = panel.getBoundingClientRect();
            offsetX = e.clientX - rect.left;
            offsetY = e.clientY - rect.top;
        });
        document.addEventListener('mousemove', (e) => {
            if (!dragging) return;
            panel.style.left = (e.clientX - offsetX) + 'px';
            panel.style.top = (e.clientY - offsetY) + 'px';
            panel.style.right = 'auto';
        });
        document.addEventListener('mouseup', () => { dragging = false; });
    })();

    const statusEl = document.getElementById('actRecorderStatus');
    const outputEl = document.getElementById('actRecorderOutput');
    function setStatus(msg) { statusEl.textContent = msg; }

    // ============================================================
    // Selector generation
    // ============================================================
    function shortText(el) {
        if (!el) return '';
        let t = (el.getAttribute && (el.getAttribute('aria-label') || el.getAttribute('placeholder'))) || el.textContent || '';
        t = t.trim().replace(/\s+/g, ' ');
        return t.length > 60 ? t.slice(0, 60) + '...' : t;
    }

    function buildSelector(el) {
        if (!el || el.nodeType !== 1) return null;
        if (el.id) return `#${CSS.escape(el.id)}`;

        // Prefer stable data-ish attributes commonly used by grid frameworks
        const preferredAttrs = ['col-id', 'row-id', 'data-testid', 'data-id', 'name', 'aria-label', 'placeholder', 'role', 'type'];
        for (const attr of preferredAttrs) {
            const val = el.getAttribute && el.getAttribute(attr);
            if (val) return `${el.tagName.toLowerCase()}[${attr}="${val}"]`;
        }

        // Fallback: short CSS path with nth-of-type, walking up a few levels
        const path = [];
        let node = el;
        let depth = 0;
        while (node && node.nodeType === 1 && depth < 6) {
            if (node.id) {
                path.unshift(`#${CSS.escape(node.id)}`);
                break;
            }
            let segment = node.tagName.toLowerCase();
            const cls = (node.className && typeof node.className === 'string')
                ? node.className.trim().split(/\s+/).filter(Boolean).slice(0, 2).join('.')
                : '';
            if (cls) segment += '.' + cls;
            let sibIndex = 1, sib = node;
            while ((sib = sib.previousElementSibling)) {
                if (sib.tagName === node.tagName) sibIndex++;
            }
            segment += `:nth-of-type(${sibIndex})`;
            path.unshift(segment);
            node = node.parentElement;
            depth++;
        }
        return path.join(' > ');
    }

    // ============================================================
    // Frame handling (same-origin only, by browser security)
    // ============================================================
    function getFrameLabel(doc) {
        if (framePaths.has(doc)) return framePaths.get(doc);
        const label = doc === document ? 'Main page' : `iframe #${frameCounter++}`;
        framePaths.set(doc, label);
        return label;
    }

    function scanForIframes(doc) {
        let frames;
        try {
            frames = doc.querySelectorAll('iframe');
        } catch (e) {
            return;
        }
        frames.forEach((frame) => {
            if (observedFrames.has(frame)) return;
            observedFrames.add(frame);
            try {
                const innerDoc = frame.contentDocument;
                if (!innerDoc) return; // not loaded yet or cross-origin
                attachListenersToDoc(innerDoc);
                scanForIframes(innerDoc); // nested iframes
            } catch (e) {
                setStatus(`Note: an iframe (src: ${frame.src ? frame.src.slice(0, 40) : 'unknown'}) is cross-origin — cannot record inside it.`);
            }
        });
    }

    // ============================================================
    // Event recording
    // ============================================================
    function isOwnUI(el) {
        return !!(el && el.closest && (el.closest('#actRecorderPanel') || el.closest('#actRecorderToggleBtn')));
    }

    function recordEvent(entry) {
        entry.t = Date.now() - startTime;
        events.push(entry);
        saveState(); // persist immediately — a click may trigger navigation right after this
        setStatus(`Recording... ${events.length} action(s) captured.`);
    }

    function handleClick(e, doc) {
        if (!recording) return;
        const el = e.target;
        if (isOwnUI(el)) return;
        recordEvent({
            type: 'click',
            frame: getFrameLabel(doc),
            tag: el.tagName ? el.tagName.toLowerCase() : '',
            text: shortText(el),
            selector: buildSelector(el),
        });
    }

    function handleChange(e, doc) {
        if (!recording) return;
        const el = e.target;
        if (isOwnUI(el)) return;
        let value;
        if (el.tagName === 'SELECT') {
            value = el.options[el.selectedIndex] ? el.options[el.selectedIndex].text : el.value;
        } else if (el.type === 'checkbox' || el.type === 'radio') {
            value = el.checked;
        } else {
            value = el.value;
        }
        recordEvent({
            type: el.tagName === 'SELECT' ? 'select' : (el.type === 'checkbox' || el.type === 'radio' ? 'toggle' : 'type'),
            frame: getFrameLabel(doc),
            tag: el.tagName ? el.tagName.toLowerCase() : '',
            value: value,
            selector: buildSelector(el),
        });
    }

    function handleKeydown(e, doc) {
        if (!recording) return;
        if (e.key !== 'Enter') return;
        const el = e.target;
        if (isOwnUI(el)) return;
        if (!('value' in el)) return;
        recordEvent({
            type: 'enter-key',
            frame: getFrameLabel(doc),
            tag: el.tagName ? el.tagName.toLowerCase() : '',
            value: el.value,
            selector: buildSelector(el),
        });
    }

    function attachListenersToDoc(doc) {
        const clickHandler = (e) => handleClick(e, doc);
        const changeHandler = (e) => handleChange(e, doc);
        const keydownHandler = (e) => handleKeydown(e, doc);

        doc.addEventListener('click', clickHandler, true);
        doc.addEventListener('change', changeHandler, true);
        doc.addEventListener('keydown', keydownHandler, true);

        attachedListeners.push({ doc, type: 'click', handler: clickHandler, capture: true });
        attachedListeners.push({ doc, type: 'change', handler: changeHandler, capture: true });
        attachedListeners.push({ doc, type: 'keydown', handler: keydownHandler, capture: true });
    }

    let mutationObserver = null;
    function startMutationWatch() {
        mutationObserver = new MutationObserver(() => {
            scanForIframes(document);
        });
        mutationObserver.observe(document.documentElement, { childList: true, subtree: true });
    }

    // ============================================================
    // Start / Stop
    // ============================================================
    document.getElementById('actRecorderStart').addEventListener('click', () => {
        events = [];
        attachedListeners = [];
        observedFrames = new WeakSet();
        frameCounter = 0;
        startTime = Date.now();
        recording = true;

        attachListenersToDoc(document);
        scanForIframes(document);
        startMutationWatch();
        saveState();

        document.getElementById('actRecorderStart').disabled = true;
        document.getElementById('actRecorderStop').disabled = false;
        outputEl.value = '';
        setStatus('Recording... 0 action(s) captured.');
    });

    document.getElementById('actRecorderStop').addEventListener('click', () => {
        recording = false;
        attachedListeners.forEach(({ doc, type, handler, capture }) => {
            try { doc.removeEventListener(type, handler, capture); } catch (e) {}
        });
        if (mutationObserver) { mutationObserver.disconnect(); mutationObserver = null; }

        document.getElementById('actRecorderStart').disabled = false;
        document.getElementById('actRecorderStop').disabled = true;

        saveState(); // recording is now false, but keep the events around in case of an accidental reload

        const output = buildOutput();
        outputEl.value = output;
        setStatus(`Stopped. ${events.length} action(s) recorded — log copied to clipboard.`);

        navigator.clipboard.writeText(output).catch(() => {
            setStatus(`Stopped. ${events.length} action(s) recorded. Clipboard copy failed — select the text manually.`);
        });
    });

    document.getElementById('actRecorderCopy').addEventListener('click', () => {
        if (!outputEl.value) { setStatus('Nothing to copy yet.'); return; }
        navigator.clipboard.writeText(outputEl.value).then(
            () => setStatus('Copied to clipboard.'),
            () => setStatus('Copy failed — select the text manually.')
        );
    });

    document.getElementById('actRecorderClear').addEventListener('click', () => {
        events = [];
        outputEl.value = '';
        clearState();
        setStatus('Cleared. Click Start to record again.');
    });

    function buildOutput() {
        let text = `Recorded ${events.length} action(s):\n\n`;
        events.forEach((ev, i) => {
            let line = `${i + 1}. [${ev.frame}] `;
            if (ev.type === 'click') {
                line += `Clicked <${ev.tag}> "${ev.text}"`;
            } else if (ev.type === 'type') {
                line += `Typed "${ev.value}" into <${ev.tag}>`;
            } else if (ev.type === 'select') {
                line += `Selected "${ev.value}" in <${ev.tag}>`;
            } else if (ev.type === 'toggle') {
                line += `Set <${ev.tag}> checked=${ev.value}`;
            } else if (ev.type === 'enter-key') {
                line += `Pressed Enter in <${ev.tag}> (value: "${ev.value}")`;
            }
            line += `\n   selector: ${ev.selector}\n   +${ev.t}ms`;
            text += line + '\n\n';
        });
        text += '--- JSON (paste this if asking an assistant to build a script) ---\n';
        text += JSON.stringify(events, null, 2);
        return text;
    }

    // ============================================================
    // Resume after reload
    // ============================================================
    (function resumeIfNeeded() {
        const saved = loadState();
        if (!saved) return;

        events = saved.events || [];
        startTime = saved.startTime || Date.now();
        frameCounter = saved.frameCounter || 0;

        if (saved.recording) {
            recording = true;
            attachListenersToDoc(document);
            scanForIframes(document);
            startMutationWatch();

            document.getElementById('actRecorderStart').disabled = true;
            document.getElementById('actRecorderStop').disabled = false;
            setStatus(`Resumed after page reload — ${events.length} action(s) captured so far. Keep going.`);
        } else if (events.length) {
            // Not recording, but there's a finished log from before the reload — restore it for convenience
            outputEl.value = buildOutput();
            setStatus(`Restored last recording (${events.length} action(s)) after reload.`);
        }
    })();

    console.log('[Action Recorder] loaded.');
})();
