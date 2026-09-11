// ==UserScript==
// @name         BirchStreet Action Recorder (iframe + DOM changes)
// @namespace    roni2026.tools
// @version      2.0
// @description  Record clicks, typing, selects, keyboard actions, iframe paths, element details, and DOM changes for automation development.
// @match        *://*/*
// @grant        none
// @run-at       document-idle
// ==/UserScript==

(function () {
    'use strict';

    // ============================================================
    // STATE
    // ============================================================

    let recording = false;
    let events = [];
    let startTime = 0;

    let attachedListeners = [];
    let observedFrames = new WeakSet();
    let frameDocuments = new WeakMap();

    let mutationObservers = [];
    let frameScanTimer = null;

    const STORAGE_KEY = 'birchStreetActionRecorder_v2';

    // ============================================================
    // STORAGE
    // ============================================================

    function saveState() {
        try {
            sessionStorage.setItem(STORAGE_KEY, JSON.stringify({
                recording,
                events,
                startTime
            }));
        } catch (e) {
            console.warn('[Recorder] Could not save state:', e);
        }
    }

    function loadState() {
        try {
            const raw = sessionStorage.getItem(STORAGE_KEY);
            return raw ? JSON.parse(raw) : null;
        } catch (e) {
            return null;
        }
    }

    function clearState() {
        try {
            sessionStorage.removeItem(STORAGE_KEY);
        } catch (e) {}
    }

    window.addEventListener('beforeunload', () => {
        if (recording) saveState();
    });

    // ============================================================
    // UI
    // ============================================================

    const style = document.createElement('style');

    style.textContent = `
        #bsRecorderPanel {
            position: fixed;
            top: 20px;
            right: 20px;
            width: 370px;
            background: #1e1f29;
            color: #f8f8f2;
            border: 1px solid #44475a;
            border-radius: 10px;
            box-shadow: 0 8px 24px rgba(0,0,0,.45);
            z-index: 2147483647;
            font-family: "Segoe UI", Arial, sans-serif;
            font-size: 13px;
            overflow: hidden;
        }

        #bsRecorderHeader {
            background: #282a36;
            padding: 9px 12px;
            cursor: move;
            display: flex;
            justify-content: space-between;
            align-items: center;
            border-bottom: 1px solid #44475a;
            user-select: none;
        }

        #bsRecorderHeader span {
            font-weight: 700;
            color: #ff79c6;
        }

        #bsRecorderHeader button {
            background: none;
            border: none;
            color: #f8f8f2;
            cursor: pointer;
            font-size: 15px;
        }

        #bsRecorderBody {
            padding: 10px 12px;
        }

        .bsBtnRow {
            display: flex;
            gap: 6px;
            margin-bottom: 8px;
        }

        .bsBtnRow button {
            flex: 1;
            padding: 8px 6px;
            border: none;
            border-radius: 6px;
            cursor: pointer;
            font-weight: 700;
            font-size: 12px;
        }

        #bsStart {
            background: #50fa7b;
            color: #1e1f29;
        }

        #bsStop {
            background: #ff5555;
            color: #1e1f29;
        }

        #bsCopy {
            background: #8be9fd;
            color: #1e1f29;
        }

        #bsClear {
            background: #44475a;
            color: #f8f8f2;
        }

        #bsStatus {
            font-size: 12px;
            margin-bottom: 8px;
            color: #f1fa8c;
        }

        #bsOutput {
            width: 100%;
            height: 230px;
            resize: vertical;
            background: #14151c;
            color: #f8f8f2;
            border: 1px solid #44475a;
            border-radius: 6px;
            padding: 7px;
            box-sizing: border-box;
            font-family: monospace;
            font-size: 10px;
        }

        #bsRecorderToggle {
            position: fixed;
            top: 20px;
            right: 20px;
            z-index: 2147483646;
            background: #ff79c6;
            color: #1e1f29;
            border: none;
            padding: 8px 12px;
            border-radius: 8px;
            font-weight: 700;
            cursor: pointer;
            display: none;
        }
    `;

    document.head.appendChild(style);

    const panel = document.createElement('div');
    panel.id = 'bsRecorderPanel';

    panel.innerHTML = `
        <div id="bsRecorderHeader">
            <span>BirchStreet Action Recorder</span>
            <button id="bsHide">&minus;</button>
        </div>

        <div id="bsRecorderBody">

            <div id="bsStatus">
                Idle. Click Start, then perform your workflow.
            </div>

            <div class="bsBtnRow">
                <button id="bsStart">Start</button>
                <button id="bsStop" disabled>Stop</button>
            </div>

            <div class="bsBtnRow">
                <button id="bsCopy">Copy Log</button>
                <button id="bsClear">Clear</button>
            </div>

            <textarea
                id="bsOutput"
                placeholder="Recording will appear here..."
                readonly
            ></textarea>

        </div>
    `;

    document.body.appendChild(panel);

    const toggle = document.createElement('button');
    toggle.id = 'bsRecorderToggle';
    toggle.textContent = 'Recorder';

    document.body.appendChild(toggle);

    const statusEl = document.getElementById('bsStatus');
    const outputEl = document.getElementById('bsOutput');

    function setStatus(text) {
        statusEl.textContent = text;
    }

    document.getElementById('bsHide').addEventListener('click', () => {
        panel.style.display = 'none';
        toggle.style.display = 'block';
    });

    toggle.addEventListener('click', () => {
        panel.style.display = 'block';
        toggle.style.display = 'none';
    });

    // ============================================================
    // DRAG PANEL
    // ============================================================

    (() => {
        const header = document.getElementById('bsRecorderHeader');

        let dragging = false;
        let offsetX = 0;
        let offsetY = 0;

        header.addEventListener('mousedown', e => {

            if (e.target.tagName === 'BUTTON') return;

            dragging = true;

            const rect = panel.getBoundingClientRect();

            offsetX = e.clientX - rect.left;
            offsetY = e.clientY - rect.top;
        });

        document.addEventListener('mousemove', e => {

            if (!dragging) return;

            panel.style.left = `${e.clientX - offsetX}px`;
            panel.style.top = `${e.clientY - offsetY}px`;
            panel.style.right = 'auto';
        });

        document.addEventListener('mouseup', () => {
            dragging = false;
        });
    })();

    // ============================================================
    // ELEMENT INFORMATION
    // ============================================================

    function cleanText(text) {

        if (!text) return '';

        return String(text)
            .replace(/\s+/g, ' ')
            .trim()
            .slice(0, 150);
    }

    function getElementText(el) {

        if (!el) return '';

        const aria = el.getAttribute?.('aria-label');

        if (aria) return cleanText(aria);

        const placeholder = el.getAttribute?.('placeholder');

        if (placeholder) return cleanText(placeholder);

        return cleanText(el.innerText || el.textContent || '');
    }

    function getAttributes(el) {

        const result = {};

        if (!el || !el.attributes) return result;

        for (const attr of el.attributes) {

            const name = attr.name;

            // Avoid massive / irrelevant attributes.
            if (name.length > 100) continue;

            result[name] = attr.value.slice(0, 300);
        }

        return result;
    }

    // ============================================================
    // SELECTOR
    // ============================================================

    function buildSelector(el) {

        if (!el || el.nodeType !== 1) {
            return null;
        }

        try {

            if (el.id) {
                return `#${CSS.escape(el.id)}`;
            }

            const preferred = [
                'data-testid',
                'data-test',
                'data-id',
                'data-key',
                'name',
                'aria-label',
                'placeholder',
                'col-id',
                'row-id'
            ];

            for (const attr of preferred) {

                const value = el.getAttribute(attr);

                if (value) {

                    return `${el.tagName.toLowerCase()}[${attr}="${CSS.escape(value)}"]`;
                }
            }

            // Build a more complete CSS path.
            const path = [];

            let node = el;

            for (let depth = 0; node && node.nodeType === 1 && depth < 8; depth++) {

                let part = node.tagName.toLowerCase();

                if (node.id) {

                    part += `#${CSS.escape(node.id)}`;
                    path.unshift(part);
                    break;
                }

                const classes = [...node.classList]
                    .filter(x => x.length < 50)
                    .slice(0, 2);

                if (classes.length) {

                    part += '.' + classes
                        .map(x => CSS.escape(x))
                        .join('.');
                }

                let index = 1;

                let sibling = node.previousElementSibling;

                while (sibling) {

                    if (sibling.tagName === node.tagName) {
                        index++;
                    }

                    sibling = sibling.previousElementSibling;
                }

                part += `:nth-of-type(${index})`;

                path.unshift(part);

                node = node.parentElement;
            }

            return path.join(' > ');

        } catch (e) {

            return null;
        }
    }

    // ============================================================
    // VALUE
    // ============================================================

    function getValue(el) {

        if (!el) return null;

        try {

            const tag = el.tagName?.toLowerCase();

            if (tag === 'select') {

                return {
                    value: el.value,
                    text: el.options?.[el.selectedIndex]?.text || ''
                };
            }

            if (el.type === 'checkbox' || el.type === 'radio') {

                return {
                    checked: el.checked,
                    value: el.value
                };
            }

            if ('value' in el) {

                return el.value;
            }

        } catch (e) {}

        return null;
    }

    // ============================================================
    // FRAME PATH
    // ============================================================

    function getFramePath(doc) {

        if (doc === window.document) {
            return [];
        }

        const path = [];

        let currentDoc = doc;

        try {

            while (currentDoc && currentDoc !== window.document) {

                const frame = currentDoc.defaultView?.frameElement;

                if (!frame) break;

                path.unshift({
                    tag: 'iframe',
                    id: frame.id || null,
                    name: frame.getAttribute('name'),
                    title: frame.getAttribute('title'),
                    src: frame.getAttribute('src'),
                    selector: buildSelector(frame)
                });

                currentDoc = frame.ownerDocument;
            }

        } catch (e) {

            path.push({
                error: 'Unable to inspect iframe hierarchy'
            });
        }

        return path;
    }

    function getFrameDescription(doc) {

        if (doc === window.document) {
            return 'MAIN DOCUMENT';
        }

        const path = getFramePath(doc);

        if (!path.length) {
            return 'IFRAME';
        }

        return path.map((frame, index) => {

            const name =
                frame.id ||
                frame.name ||
                frame.title ||
                `iframe[${index}]`;

            return name;

        }).join(' > ');
    }

    // ============================================================
    // ELEMENT SNAPSHOT
    // ============================================================

    function getElementSnapshot(el) {

        if (!el || el.nodeType !== 1) {
            return null;
        }

        return {
            tag: el.tagName?.toLowerCase() || '',
            id: el.id || null,
            name: el.getAttribute('name'),
            type: el.getAttribute('type'),
            role: el.getAttribute('role'),
            text: getElementText(el),
            value: getValue(el),
            selector: buildSelector(el),
            attributes: getAttributes(el)
        };
    }

    // ============================================================
    // OWN UI
    // ============================================================

    function isOwnUI(el) {

        try {

            return !!(
                el &&
                el.closest &&
                (
                    el.closest('#bsRecorderPanel') ||
                    el.closest('#bsRecorderToggle')
                )
            );

        } catch (e) {

            return false;
        }
    }

    // ============================================================
    // RECORD
    // ============================================================

    function recordEvent(event) {

        event.time = Date.now() - startTime;

        events.push(event);

        saveState();

        setStatus(
            `Recording... ${events.length} event(s)`
        );
    }

    // ============================================================
    // CLICK
    // ============================================================

    function handleClick(e, doc) {

        if (!recording) return;

        const el = e.target;

        if (!el || isOwnUI(el)) return;

        recordEvent({

            type: 'click',

            frame: getFrameDescription(doc),

            framePath: getFramePath(doc),

            element: getElementSnapshot(el),

            mouse: {
                button: e.button,
                x: e.clientX,
                y: e.clientY
            }

        });
    }

    // ============================================================
    // INPUT
    // ============================================================

    function handleInput(e, doc) {

        if (!recording) return;

        const el = e.target;

        if (!el || isOwnUI(el)) return;

        // Don't record every individual character.
        // Change event will capture the final value.
    }

    // ============================================================
    // CHANGE
    // ============================================================

    function handleChange(e, doc) {

        if (!recording) return;

        const el = e.target;

        if (!el || isOwnUI(el)) return;

        const tag = el.tagName?.toLowerCase();

        let type = 'change';

        if (tag === 'select') {

            type = 'select';

        } else if (
            el.type === 'checkbox' ||
            el.type === 'radio'
        ) {

            type = 'toggle';

        } else if (
            tag === 'input' ||
            tag === 'textarea'
        ) {

            type = 'type';
        }

        recordEvent({

            type,

            frame: getFrameDescription(doc),

            framePath: getFramePath(doc),

            element: getElementSnapshot(el),

            value: getValue(el)

        });
    }

    // ============================================================
    // KEYBOARD
    // ============================================================

    function handleKeydown(e, doc) {

        if (!recording) return;

        const el = e.target;

        if (!el || isOwnUI(el)) return;

        if (
            e.key !== 'Enter' &&
            e.key !== 'Tab' &&
            e.key !== 'Escape'
        ) {
            return;
        }

        recordEvent({

            type: 'key',

            key: e.key,

            frame: getFrameDescription(doc),

            framePath: getFramePath(doc),

            element: getElementSnapshot(el)

        });
    }

    // ============================================================
    // FOCUS
    // ============================================================

    function handleFocus(e, doc) {

        if (!recording) return;

        const el = e.target;

        if (!el || isOwnUI(el)) return;

        // Focus is useful for understanding complex forms,
        // but only record form controls.

        const tag = el.tagName?.toLowerCase();

        if (
            tag !== 'input' &&
            tag !== 'textarea' &&
            tag !== 'select'
        ) {
            return;
        }

        recordEvent({

            type: 'focus',

            frame: getFrameDescription(doc),

            framePath: getFramePath(doc),

            element: getElementSnapshot(el)

        });
    }

    // ============================================================
    // MUTATION OBSERVER
    // ============================================================

    function attachMutationObserver(doc) {

        try {

            const observer = new MutationObserver(mutations => {

                if (!recording) return;

                for (const mutation of mutations) {

                    if (
                        mutation.type === 'attributes' &&
                        mutation.target
                    ) {

                        const el = mutation.target;

                        if (!el || isOwnUI(el)) continue;

                        const importantAttributes = [
                            'value',
                            'class',
                            'style',
                            'disabled',
                            'checked',
                            'selected',
                            'aria-hidden',
                            'aria-expanded',
                            'display'
                        ];

                        if (
                            mutation.attributeName &&
                            !importantAttributes.includes(
                                mutation.attributeName
                            )
                        ) {
                            continue;
                        }

                        recordEvent({

                            type: 'dom-attribute-change',

                            frame: getFrameDescription(doc),

                            framePath: getFramePath(doc),

                            attribute: mutation.attributeName,

                            newValue:
                                el.getAttribute(
                                    mutation.attributeName
                                ),

                            element:
                                getElementSnapshot(el)

                        });
                    }

                    if (
                        mutation.type === 'childList' &&
                        (
                            mutation.addedNodes.length ||
                            mutation.removedNodes.length
                        )
                    ) {

                        const target = mutation.target;

                        if (!target || isOwnUI(target)) continue;

                        // Only record useful DOM additions.
                        // Ignore huge framework changes.

                        if (
                            mutation.addedNodes.length <= 5 &&
                            mutation.removedNodes.length <= 5
                        ) {

                            const added = [];

                            mutation.addedNodes.forEach(node => {

                                if (
                                    node.nodeType === 1 &&
                                    !isOwnUI(node)
                                ) {

                                    added.push(
                                        getElementSnapshot(node)
                                    );
                                }
                            });

                            if (added.length) {

                                recordEvent({

                                    type: 'dom-added',

                                    frame:
                                        getFrameDescription(doc),

                                    framePath:
                                        getFramePath(doc),

                                    target:
                                        getElementSnapshot(target),

                                    added

                                });
                            }
                        }
                    }
                }

            });

            observer.observe(
                doc.documentElement,
                {
                    subtree: true,
                    childList: true,
                    attributes: true,
                    attributeOldValue: true
                }
            );

            mutationObservers.push(observer);

        } catch (e) {

            console.warn(
                '[Recorder] Mutation observer failed:',
                e
            );
        }
    }

    // ============================================================
    // ATTACH LISTENERS
    // ============================================================

    function attachListenersToDoc(doc) {

        if (!doc || observedFrames.has(doc)) {
            return;
        }

        observedFrames.add(doc);

        const handlers = [

            ['click', e => handleClick(e, doc)],

            ['change', e => handleChange(e, doc)],

            ['keydown', e => handleKeydown(e, doc)],

            ['focusin', e => handleFocus(e, doc)],

            ['input', e => handleInput(e, doc)]

        ];

        for (const [type, handler] of handlers) {

            try {

                doc.addEventListener(
                    type,
                    handler,
                    true
                );

                attachedListeners.push({
                    doc,
                    type,
                    handler
                });

            } catch (e) {}
        }

        attachMutationObserver(doc);

        scanForIframes(doc);
    }

    // ============================================================
    // SCAN IFRAMES
    // ============================================================

    function scanForIframes(doc) {

        if (!doc) return;

        let frames;

        try {

            frames = doc.querySelectorAll('iframe');

        } catch (e) {

            return;
        }

        frames.forEach(frame => {

            try {

                const innerDoc =
                    frame.contentDocument;

                if (!innerDoc) return;

                if (
                    frameDocuments.has(frame) &&
                    frameDocuments.get(frame) === innerDoc
                ) {
                    return;
                }

                frameDocuments.set(
                    frame,
                    innerDoc
                );

                attachListenersToDoc(
                    innerDoc
                );

            } catch (e) {

                console.warn(
                    '[Recorder] Cannot access iframe:',
                    frame.src
                );
            }
        });
    }

    // ============================================================
    // CONTINUOUS FRAME SCAN
    // ============================================================

    function startFrameScanner() {

        if (frameScanTimer) {
            clearInterval(frameScanTimer);
        }

        frameScanTimer = setInterval(() => {

            if (!recording) return;

            scanForIframes(document);

        }, 500);
    }

    function stopFrameScanner() {

        if (frameScanTimer) {

            clearInterval(
                frameScanTimer
            );

            frameScanTimer = null;
        }
    }

    // ============================================================
    // OUTPUT
    // ============================================================

    function buildOutput() {

        let text = '';

        text += '====================================================\n';
        text += 'BIRCHSTREET ACTION RECORDING\n';
        text += '====================================================\n\n';

        text += `Total events: ${events.length}\n\n`;

        events.forEach((ev, i) => {

            text += `${i + 1}. [${ev.type}]\n`;

            text += `   Time: +${ev.time}ms\n`;

            text += `   Frame: ${ev.frame}\n`;

            if (ev.framePath) {

                text += `   Frame path:\n`;

                ev.framePath.forEach((frame, index) => {

                    text += `      ${index + 1}. ` +
                        `id=${frame.id || '-'} ` +
                        `name=${frame.name || '-'} ` +
                        `title=${frame.title || '-'}\n`;

                    if (frame.selector) {

                        text +=
                            `         selector=${frame.selector}\n`;
                    }
                });
            }

            if (ev.key) {

                text += `   Key: ${ev.key}\n`;
            }

            if (ev.attribute) {

                text +=
                    `   Attribute changed: ${ev.attribute}\n`;

                text +=
                    `   New value: ${ev.newValue}\n`;
            }

            if (ev.value !== undefined) {

                text +=
                    `   Value: ${JSON.stringify(ev.value)}\n`;
            }

            if (ev.element) {

                text += `   Element:\n`;
                text +=
                    `      <${ev.element.tag}>`;

                if (ev.element.id) {

                    text +=
                        ` id="${ev.element.id}"`;
                }

                if (ev.element.name) {

                    text +=
                        ` name="${ev.element.name}"`;
                }

                if (ev.element.type) {

                    text +=
                        ` type="${ev.element.type}"`;
                }

                text += '\n';

                text +=
                    `      Text: ${JSON.stringify(ev.element.text)}\n`;

                text +=
                    `      Selector: ${ev.element.selector}\n`;

                text +=
                    `      Current value: ${JSON.stringify(ev.element.value)}\n`;

                text +=
                    `      Attributes: ${JSON.stringify(ev.element.attributes)}\n`;
            }

            if (ev.mouse) {

                text +=
                    `   Mouse: button=${ev.mouse.button}, ` +
                    `x=${ev.mouse.x}, y=${ev.mouse.y}\n`;
            }

            text += '\n';
        });

        text +=
            '====================================================\n';

        text +=
            'RAW JSON — GIVE THIS PART TO THE ASSISTANT\n';

        text +=
            '====================================================\n\n';

        text += JSON.stringify(
            events,
            null,
            2
        );

        return text;
    }

    // ============================================================
    // START
    // ============================================================

    document.getElementById('bsStart')
        .addEventListener('click', () => {

            events = [];

            attachedListeners = [];

            mutationObservers = [];

            observedFrames = new WeakSet();

            frameDocuments = new WeakMap();

            startTime = Date.now();

            recording = true;

            attachListenersToDoc(
                document
            );

            scanForIframes(
                document
            );

            startFrameScanner();

            saveState();

            document.getElementById(
                'bsStart'
            ).disabled = true;

            document.getElementById(
                'bsStop'
            ).disabled = false;

            outputEl.value = '';

            setStatus(
                'Recording... Perform your BirchStreet workflow.'
            );
        });

    // ============================================================
    // STOP
    // ============================================================

    document.getElementById('bsStop')
        .addEventListener('click', () => {

            recording = false;

            stopFrameScanner();

            attachedListeners.forEach(
                ({ doc, type, handler }) => {

                    try {

                        doc.removeEventListener(
                            type,
                            handler,
                            true
                        );

                    } catch (e) {}
                }
            );

            attachedListeners = [];

            mutationObservers.forEach(
                observer => {

                    try {
                        observer.disconnect();
                    } catch (e) {}

                }
            );

            mutationObservers = [];

            document.getElementById(
                'bsStart'
            ).disabled = false;

            document.getElementById(
                'bsStop'
            ).disabled = true;

            const output =
                buildOutput();

            outputEl.value =
                output;

            saveState();

            setStatus(
                `Stopped. ${events.length} event(s) recorded.`
            );

            navigator.clipboard
                .writeText(output)
                .then(() => {

                    setStatus(
                        `Stopped. ${events.length} events recorded and copied to clipboard.`
                    );

                })
                .catch(() => {

                    setStatus(
                        `Stopped. ${events.length} events recorded. Clipboard copy failed; use Copy Log.`
                    );

                });
        });

    // ============================================================
    // COPY
    // ============================================================

    document.getElementById('bsCopy')
        .addEventListener('click', () => {

            if (!outputEl.value) {

                setStatus(
                    'Nothing to copy.'
                );

                return;
            }

            navigator.clipboard
                .writeText(
                    outputEl.value
                )
                .then(() => {

                    setStatus(
                        'Recording copied to clipboard.'
                    );

                })
                .catch(() => {

                    setStatus(
                        'Clipboard failed. Select and copy the text manually.'
                    );

                });
        });

    // ============================================================
    // CLEAR
    // ============================================================

    document.getElementById('bsClear')
        .addEventListener('click', () => {

            events = [];

            outputEl.value = '';

            clearState();

            setStatus(
                'Cleared. Click Start to record again.'
            );
        });

    // ============================================================
    // RESUME AFTER RELOAD
    // ============================================================

    (() => {

        const saved =
            loadState();

        if (!saved) return;

        events =
            saved.events || [];

        startTime =
            saved.startTime || Date.now();

        if (saved.recording) {

            recording = true;

            attachListenersToDoc(
                document
            );

            scanForIframes(
                document
            );

            startFrameScanner();

            document.getElementById(
                'bsStart'
            ).disabled = true;

            document.getElementById(
                'bsStop'
            ).disabled = false;

            setStatus(
                `Resumed recording after reload — ${events.length} event(s) captured.`
            );

        } else if (events.length) {

            outputEl.value =
                buildOutput();

            setStatus(
                `Restored previous recording — ${events.length} event(s).`
            );
        }

    })();

    console.log(
        '[BirchStreet Action Recorder v2] loaded.'
    );

})();
