// ==UserScript==
// @name         REQ Quantity Auto-Filler
// @namespace    roni2026.birchstreet.tools
// @version      4.0
// @description  Sequential one-by-one REQ filler: no skipped rows, wait-for-element pacing (fast but safe), scroll restore after UOM dialogs, cheap quantity verification.
// @author       roni2026
// @match        https://*.birchstreetsystems.com/*
// @grant        none
// @run-at       document-idle
// ==/UserScript==

(function () {
    'use strict';

    // ============================================================
    // v4.0 — full rewrite of the processing engine.
    //
    // What changed and why:
    //
    // 1) SEQUENTIAL, ONE-BY-ONE PROCESSING.
    //    v3.x snapshotted "currently visible SKUs" and then edited
    //    them one at a time. Any scroll jump in between (UOM zoom
    //    button focus, AG Grid auto-scroll on commit, dialog
    //    re-renders) recycled rows out from under that snapshot,
    //    which is exactly the "skips 4-5 rows" symptom. v4.0 has
    //    NO snapshot: it takes one row, finishes it completely
    //    (UOM check/correction + quantity + verification), and
    //    only then looks at anything else. A row can never be
    //    skipped, because the script never holds a stale list.
    //
    // 2) WAIT-FOR-ELEMENT, NOT FIXED SLEEPS.
    //    Every pause in v3.x was a fixed setTimeout (250ms here,
    //    220ms there, 350ms after commit...). That is both slow
    //    (you always pay the full sleep even when the app already
    //    responded) and brittle (you fail when the app is slower
    //    than the sleep). v4.0 polls for the actual element it
    //    needs (editor appeared? dialog open? dialog closed?
    //    quantity stuck?) and continues the instant it shows up,
    //    with generous timeouts as the safety net.
    //
    // 3) CHEAP QUANTITY VERIFICATION.
    //    v3.x verification re-ran full iframe discovery 5 times
    //    per row. v4.0 polls the quantity cell text directly in
    //    the already-known document — one comparison per ~70ms.
    //
    // 4) SCROLL-RESTORE + RELOCATE AFTER UOM DIALOGS.
    //    Same idea as v3.4 but now it's the only code path, and
    //    because processing is one-row-at-a-time there is no
    //    snapshot to invalidate — the worst case is one extra
    //    locate-by-SKU, which is cheap.
    //
    // 5) NOTHING IS WRITTEN OFF PREMATURELY.
    //    A SKU only lands in "failed" after its quantity retries
    //    are truly exhausted. Everything else stays in the
    //    remaining pool and is picked up by the automatic
    //    top-to-bottom recovery sweep when the grid hits bottom.
    // ============================================================

    const ORDER_SHEET_FRAME_NAME = 'OrderSheetTab';

    // ------------------------------------------------------------
    // Host-frame selection (unchanged logic from v3.x, condensed)
    // ------------------------------------------------------------

    const CONFIG_QTY_HEADER_TEXT = /^quantity$/i;
    const CONFIG_SKU_HEADER_TEXT = /^part\s*#?$/i;

    function looksLikeOrderSheetGrid(doc) {
        if (!doc) return false;
        try {
            const headers = Array.from(doc.querySelectorAll('.ag-header-cell-text'))
                .map(s => s.textContent.trim());
            return headers.some(t => CONFIG_QTY_HEADER_TEXT.test(t)) &&
                   headers.some(t => CONFIG_SKU_HEADER_TEXT.test(t));
        } catch (_) { return false; }
    }

    function findNamedFrameReachable(win, targetName, visited) {
        visited = visited || new Set();
        if (visited.has(win)) return false;
        visited.add(win);
        let doc = null;
        try { doc = win.document; } catch (_) { return false; }
        let direct = null;
        try {
            direct = doc.querySelector(`iframe[name="${targetName}"], iframe#${targetName}, frame[name="${targetName}"], frame#${targetName}`);
        } catch (_) { direct = null; }
        if (direct) return true;
        let childEls = [];
        try { childEls = Array.from(doc.querySelectorAll('iframe, frame')); } catch (_) { childEls = []; }
        for (const el of childEls) {
            let childWin = null;
            try {
                childWin = el.contentWindow;
                if (!childWin) continue;
                void childWin.document;
            } catch (_) { continue; }
            if (findNamedFrameReachable(childWin, targetName, visited)) return true;
        }
        return false;
    }

    function isHostFrame() {
        if (window.name === ORDER_SHEET_FRAME_NAME) return true;
        if (looksLikeOrderSheetGrid(document)) return true;
        if (findNamedFrameReachable(window, ORDER_SHEET_FRAME_NAME)) return false;
        return false;
    }

    if (!isHostFrame()) return;

    if (document.getElementById('reqFillerPanel')) {
        console.log('[REQ SKU/Qty Filler v4] Already running — skipping duplicate init.');
        return;
    }

    // ============================================================
    // CONFIG
    // ============================================================

    const CONFIG = {
        SKU_HEADER_TEXT: /^part\s*#?$/i,
        SKU_COL_ID_FALLBACK: '31239',
        QTY_HEADER_TEXT: /^quantity$/i,
        QTY_COL_ID_FALLBACK: '31242',
        UOM_HEADER_TEXT: /^req\s*uom$/i,
        UOM_COL_ID_FALLBACK: '31241',

        UOM_MISMATCH_COLOR: '#ff5555',
        UOM_PICKER_HEADER_TEXT: /^uom$/i,
        UOM_PICKER_SELECT_BUTTON_TEXT: /^select$/i,

        FILTER_INPUT_SELECTOR: 'input.ag-input-field-input.ag-text-field-input[type="text"]',
        FILTER_INPUT_PLACEHOLDER: 'Filter...',
        APPLY_BUTTON_SELECTOR: 'button.ag-standard-button.ag-filter-apply-panel-button',

        ROW_CONTAINER_SELECTOR: '.ag-center-cols-container',
        ROW_SELECTOR: '.ag-row',
        CELL_SELECTOR: '.ag-cell',
        GRID_VIEWPORT_SELECTOR: '.ag-body-viewport, .ag-center-cols-viewport',

        QTY_INPUT_ID_PREFIX: 'QUANTITY',
        UOM_INPUT_ID_PREFIX: 'REQUESTED_UOM',
        UOM_ZOOM_BTN_ID_SUFFIX: 'ZM',

        // ---- timing (poll-based, not fixed sleeps) ----
        POLL_FAST_MS: 60,
        POLL_MS: 100,

        EDITOR_WAIT_TIMEOUT_MS: 2500, // qty editor to appear after cell click
        DIALOG_OPEN_TIMEOUT_MS: 8000, // UOM picker to open
        DIALOG_CLOSE_TIMEOUT_MS: 8000, // UOM picker to close after Select
        VERIFY_TIMEOUT_MS: 2000, // qty to stick after commit
        FILTER_APPLY_SETTLE_MS: 1000, // grid refresh after Apply Filter
        POST_EDIT_SETTLE_MS: 120, // tiny breath between ops on same row
        ROW_TO_ROW_DELAY_MS: 60, // gap between rows (keeps UI responsive)

        QTY_EDIT_RETRY_ATTEMPTS: 3,
        UOM_OPEN_RETRY_ATTEMPTS: 3,

        SCROLL_RENDER_DELAY_MS: 350, // after a viewport scroll
        RECOVERY_PASSES: 2, // top-to-bottom re-scans at bottom
        MAX_SCROLL_ITERATIONS: 400,

        UOM_MARKER_REAPPLY_INTERVAL_MS: 500,

        formatQty(q) { return String(q); }
    };

    // ============================================================
    // GENERIC HELPERS
    // ============================================================

    const sleep = ms => new Promise(r => setTimeout(r, ms));

    // Poll `fn` until it returns a truthy value or timeout.
    async function waitFor(fn, timeoutMs, pollMs) {
        pollMs = pollMs || CONFIG.POLL_MS;
        const start = Date.now();
        while (Date.now() - start < timeoutMs) {
            try {
                const v = fn();
                if (v) return v;
            } catch (_) {}
            await sleep(pollMs);
        }
        return null;
    }

    function isVisible(el) {
        if (!el) return false;
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
    }

    function setNativeValue(el, value) {
        if (!el) return false;
        const s = String(value);
        let proto = el, setter = null;
        while (proto && !setter) {
            const d = Object.getOwnPropertyDescriptor(proto, 'value');
            if (d && d.set) { setter = d.set; break; }
            proto = Object.getPrototypeOf(proto);
        }
        try {
            if (setter) setter.call(el, s); else el.value = s;
        } catch (e) {
            try { el.value = s; } catch (_) { return false; }
        }
        el.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
        el.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
        return true;
    }

    function clickEl(el) {
        if (!el) return false;
        try { el.focus({ preventScroll: true }); } catch (_) {}
        try { el.click(); return true; } catch (_) { return false; }
    }

    function dispatchRealisticClick(el) {
        if (!el) return false;
        const rect = el.getBoundingClientRect();
        const view = el.ownerDocument.defaultView || window;
        const x = rect.left + rect.width / 2, y = rect.top + rect.height / 2;
        try { el.focus({ preventScroll: true }); } catch (_) {}
        for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
            const isPointer = type.startsWith('pointer');
            const isDown = type.endsWith('down');
            const Ctor = (isPointer && view.PointerEvent) ? view.PointerEvent : view.MouseEvent;
            try {
                el.dispatchEvent(new Ctor(type, {
                    bubbles: true, cancelable: true, composed: true, view,
                    clientX: x, clientY: y, button: 0,
                    buttons: isDown ? 1 : 0, pointerType: 'mouse', isPrimary: true
                }));
            } catch (_) {}
        }
        return true;
    }

    function pressEnter(el) {
        if (!el) return;
        for (const type of ['keydown', 'keyup']) {
            try {
                el.dispatchEvent(new KeyboardEvent(type, {
                    key: 'Enter', code: 'Enter', keyCode: 13, which: 13,
                    bubbles: true, cancelable: true
                }));
            } catch (_) {}
        }
    }

    function normalizeSku(v) {
        const d = String(v || '').trim().replace(/\D/g, '');
        return d ? String(parseInt(d, 10)) : '';
    }
    function normalizeUom(v) { return String(v || '').trim().toUpperCase(); }
    function normalizeQty(v) {
        if (v === null || v === undefined) return '';
        const s = String(v).trim().replace(/,/g, '');
        if (!s) return '';
        const n = Number(s);
        return Number.isNaN(n) ? s : String(n);
    }
    function qtyMatches(actual, wanted) {
        const a = parseFloat(actual), w = parseFloat(wanted);
        if (!Number.isNaN(a) && !Number.isNaN(w)) return Math.abs(a - w) < 1e-9;
        return normalizeQty(actual) === normalizeQty(wanted);
    }

    // ============================================================
    // UI
    // ============================================================

    const style = document.createElement('style');
    style.textContent = `
        #reqFillerPanel { position: fixed; top: 80px; right: 20px; width: 360px;
            background: #1e1f29; color: #f8f8f2; border: 1px solid #44475a; border-radius: 10px;
            box-shadow: 0 8px 24px rgba(0,0,0,0.45); z-index: 999999;
            font-family: "Segoe UI", Arial, sans-serif; font-size: 13px; overflow: hidden; }
        #reqFillerHeader { background: #282a36; padding: 8px 12px; cursor: move;
            display: flex; justify-content: space-between; align-items: center;
            border-bottom: 1px solid #44475a; user-select: none; }
        #reqFillerHeader span { font-weight: 600; color: #bd93f9; }
        #reqFillerHeader button { background: none; border: none; color: #f8f8f2;
            cursor: pointer; font-size: 15px; line-height: 1; }
        #reqFillerBody { padding: 10px 12px; }
        #reqFillerBody textarea { width: 100%; height: 150px; resize: vertical;
            background: #282a36; color: #f8f8f2; border: 1px solid #44475a; border-radius: 6px;
            padding: 6px; box-sizing: border-box; font-family: monospace; font-size: 11.5px; }
        .reqFillerBtnRow { display: flex; gap: 6px; margin-top: 8px; }
        .reqFillerBtnRow button { flex: 1; padding: 7px 6px; border: none; border-radius: 6px;
            cursor: pointer; font-weight: 600; font-size: 12px; }
        #reqFillerGenerate { background: #50fa7b; color: #1e1f29; }
        #reqFillerGenerate:hover { background: #6bffa0; }
        #reqFillerStop { background: #ff5555; color: #1e1f29; display: none; }
        #reqFillerClear { background: #44475a; color: #f8f8f2; }
        #reqFillerClear:hover { background: #565a70; }
        #reqFillerStatus { margin-top: 8px; max-height: 190px; overflow-y: auto;
            background: #14151c; border: 1px solid #44475a; border-radius: 6px;
            padding: 6px 8px; font-family: monospace; font-size: 11px; line-height: 1.5;
            white-space: pre-wrap; }
        #reqFillerStatus .ok { color: #50fa7b; }
        #reqFillerStatus .warn { color: #f1fa8c; }
        #reqFillerStatus .err { color: #ff5555; }
        #reqFillerStatus .info { color: #8be9fd; }
        #reqFillerToggleBtn { position: fixed; top: 80px; right: 20px; z-index: 999998;
            background: #bd93f9; color: #1e1f29; border: none; padding: 8px 12px;
            border-radius: 8px; font-weight: 700; cursor: pointer;
            box-shadow: 0 4px 12px rgba(0,0,0,0.4); }
    `;
    document.head.appendChild(style);

    const panel = document.createElement('div');
    panel.id = 'reqFillerPanel';
    panel.innerHTML = `
        <div id="reqFillerHeader">
            <span>REQ SKU/Qty Filler v4</span>
            <button id="reqFillerHide" title="Minimize">&minus;</button>
        </div>
        <div id="reqFillerBody">
            <textarea id="reqFillerInput" placeholder="Paste rows here, e.g.

32746    FRUIT - AMBARELLA    6.000    KG
16308    FRUIT - PINEAPPLE   40.000   KG
"></textarea>
            <div class="reqFillerBtnRow">
                <button id="reqFillerClear">Clear</button>
                <button id="reqFillerStop">Stop</button>
                <button id="reqFillerGenerate" style="flex:2;">Generate</button>
            </div>
            <div id="reqFillerStatus">Ready.</div>
        </div>`;
    document.body.appendChild(panel);

    const toggleBtn = document.createElement('button');
    toggleBtn.id = 'reqFillerToggleBtn';
    toggleBtn.textContent = 'REQ Filler';
    toggleBtn.style.display = 'none';
    document.body.appendChild(toggleBtn);

    document.getElementById('reqFillerHide').addEventListener('click', () => {
        panel.style.display = 'none'; toggleBtn.style.display = 'block';
    });
    toggleBtn.addEventListener('click', () => {
        panel.style.display = 'block'; toggleBtn.style.display = 'none';
    });

    (function makeDraggable() {
        const header = document.getElementById('reqFillerHeader');
        let dragging = false, offsetX = 0, offsetY = 0;
        header.addEventListener('mousedown', e => {
            if (e.target.tagName === 'BUTTON') return;
            dragging = true;
            const rect = panel.getBoundingClientRect();
            offsetX = e.clientX - rect.left; offsetY = e.clientY - rect.top;
        });
        document.addEventListener('mousemove', e => {
            if (!dragging) return;
            panel.style.left = (e.clientX - offsetX) + 'px';
            panel.style.top = (e.clientY - offsetY) + 'px';
            panel.style.right = 'auto';
        });
        document.addEventListener('mouseup', () => { dragging = false; });
    })();

    const statusEl = document.getElementById('reqFillerStatus');
    function log(message, kind = '') {
        const line = document.createElement('div');
        if (kind) line.className = kind;
        line.textContent = message;
        statusEl.appendChild(line);
        statusEl.scrollTop = statusEl.scrollHeight;
    }
    function clearLog() { statusEl.innerHTML = ''; }

    let aborted = false;
    document.getElementById('reqFillerClear').addEventListener('click', () => {
        document.getElementById('reqFillerInput').value = '';
        clearLog();
        log('Cleared. Paste your data and click Generate.', 'info');
    });
    document.getElementById('reqFillerStop').addEventListener('click', () => {
        aborted = true;
        log('Stop requested — finishing current row...', 'warn');
    });

    // ============================================================
    // GRID / FRAME DISCOVERY  (cached; refreshed only when stale)
    // ============================================================

    let gridDoc = null, gridFrame = null;
    let resolvedSkuColId = null, resolvedQtyColId = null, resolvedUomColId = null;

    function docHasGrid(doc) {
        if (!doc) return false;
        try { return !!doc.querySelector('.ag-root, #myGrid, .ag-center-cols-container'); }
        catch (_) { return false; }
    }

    function docHasQuantityColumn(doc) {
        if (!doc) return false;
        try {
            return Array.from(doc.querySelectorAll('.ag-header-cell-text'))
                .some(s => CONFIG.QTY_HEADER_TEXT.test(s.textContent.trim()));
        } catch (_) { return false; }
    }

    function findOrderSheetTabFrame(root) {
        const doc = root || document;
        let frame = null;
        try {
            frame = doc.querySelector(`iframe[name="${ORDER_SHEET_FRAME_NAME}"], iframe#${ORDER_SHEET_FRAME_NAME}, frame[name="${ORDER_SHEET_FRAME_NAME}"], frame#${ORDER_SHEET_FRAME_NAME}`);
        } catch (_) { frame = null; }
        if (!frame) return null;
        let innerDoc = null;
        try {
            innerDoc = frame.contentDocument || (frame.contentWindow && frame.contentWindow.document);
        } catch (_) { innerDoc = null; }
        if (!innerDoc) return null;
        if (docHasGrid(innerDoc)) return { doc: innerDoc, frame };
        return findOrderSheetTabFrame(innerDoc);
    }

    function discoverGridDocuments() {
        const named = findOrderSheetTabFrame(document);
        if (named) return [named];
        // Fallback: exhaustive search
        const results = [], visited = new Set();
        (function collect(doc) {
            if (!doc || visited.has(doc)) return;
            visited.add(doc);
            try { if (docHasGrid(doc)) results.push({ doc, frame: null }); } catch (_) {}
            let frames = [];
            try { frames = Array.from(doc.querySelectorAll('iframe, frame')); } catch (_) {}
            for (const f of frames) {
                let d = null;
                try { d = f.contentDocument || (f.contentWindow && f.contentWindow.document); } catch (_) { continue; }
                if (d && !visited.has(d)) collect(d);
            }
        })(document);
        return results;
    }

    // Full re-discovery — only call when the cached doc is provably stale.
    function rediscoverGridDoc() {
        const candidates = discoverGridDocuments();
        if (candidates.length === 0) { gridDoc = null; gridFrame = null; return null; }
        const best = candidates.find(c => docHasQuantityColumn(c.doc)) || candidates[0];
        const changed = best.doc !== gridDoc;
        gridDoc = best.doc; gridFrame = best.frame;
        if (changed) {
            resolvedSkuColId = null; resolvedQtyColId = null; resolvedUomColId = null;
            log('Reconnected to current Order Sheet document.', 'info');
        }
        return gridDoc;
    }

    // Cheap check: cached doc still good? Only if not, do full rediscovery.
    function ensureGridDoc() {
        if (gridDoc && gridFrame) {
            let cur = null;
            try {
                cur = gridFrame.contentDocument || (gridFrame.contentWindow && gridFrame.contentWindow.document);
            } catch (_) { cur = null; }
            if (cur && cur === gridDoc && docHasGrid(cur)) return gridDoc;
        } else if (gridDoc && !gridFrame) {
            if (docHasGrid(gridDoc)) return gridDoc;
        }
        return rediscoverGridDoc();
    }

    function findColIdByHeaderText(doc, regex) {
        if (!doc) return null;
        const spans = Array.from(doc.querySelectorAll('.ag-header-cell-text'));
        for (const span of spans) {
            if (regex.test(span.textContent.trim())) {
                const header = span.closest('.ag-header-cell');
                if (header) return header.getAttribute('col-id');
            }
        }
        return null;
    }

    function resolveColumnIds() {
        const doc = ensureGridDoc();
        const out = {
            skuColId: resolvedSkuColId || CONFIG.SKU_COL_ID_FALLBACK,
            qtyColId: resolvedQtyColId || CONFIG.QTY_COL_ID_FALLBACK,
            uomColId: resolvedUomColId || CONFIG.UOM_COL_ID_FALLBACK
        };
        if (!doc) return out;
        const sku = findColIdByHeaderText(doc, CONFIG.SKU_HEADER_TEXT);
        const qty = findColIdByHeaderText(doc, CONFIG.QTY_HEADER_TEXT);
        const uom = findColIdByHeaderText(doc, CONFIG.UOM_HEADER_TEXT);
        if (sku) { if (resolvedSkuColId !== sku) log(`Part # column: ${sku}`, 'ok'); resolvedSkuColId = sku; out.skuColId = sku; }
        if (qty) { if (resolvedQtyColId !== qty) log(`Quantity column: ${qty}`, 'ok'); resolvedQtyColId = qty; out.qtyColId = qty; }
        if (uom) { if (resolvedUomColId !== uom) log(`Req UOM column: ${uom}`, 'ok'); resolvedUomColId = uom; out.uomColId = uom; }
        return out;
    }

    // ============================================================
    // ROW / VIEWPORT HELPERS
    // ============================================================

    function getGridRows() {
        const doc = ensureGridDoc();
        if (!doc) return [];
        const container = doc.querySelector(CONFIG.ROW_CONTAINER_SELECTOR);
        if (!container) return [];
        return Array.from(container.querySelectorAll(':scope > .ag-row')).sort((a, b) => {
            const ai = parseInt(a.getAttribute('row-index'), 10);
            const bi = parseInt(b.getAttribute('row-index'), 10);
            return (Number.isNaN(ai) ? 0 : ai) - (Number.isNaN(bi) ? 0 : bi);
        });
    }

    function getSkuFromRow(row) {
        if (!row) return null;
        const cell = row.querySelector(`${CONFIG.CELL_SELECTOR}[col-id="${resolvedSkuColId}"]`);
        return cell ? normalizeSku(cell.textContent) : null;
    }
    function getQtyCellFromRow(row) {
        return row ? row.querySelector(`${CONFIG.CELL_SELECTOR}[col-id="${resolvedQtyColId}"]`) : null;
    }
    function getUomCellFromRow(row) {
        return row ? row.querySelector(`${CONFIG.CELL_SELECTOR}[col-id="${resolvedUomColId}"]`) : null;
    }
    function findRowBySku(sku) {
        const n = normalizeSku(sku);
        return getGridRows().find(r => getSkuFromRow(r) === n) || null;
    }

    function getGridViewport() {
        const doc = ensureGridDoc();
        if (!doc) return null;
        const candidates = Array.from(doc.querySelectorAll(CONFIG.GRID_VIEWPORT_SELECTOR));
        return candidates.find(el => el.scrollHeight > el.clientHeight + 5) || candidates[0] || null;
    }

    async function scrollViewportBy(amount) {
        const vp = getGridViewport();
        if (!vp) return { didScroll: false, atBottom: true, after: 0 };
        const before = vp.scrollTop;
        vp.scrollTop = Math.max(0, Math.min(vp.scrollHeight, vp.scrollTop + amount));
        try { vp.dispatchEvent(new Event('scroll', { bubbles: true })); } catch (_) {}
        await waitFor(() => {
            const rows = getGridRows();
            return rows.length > 0;
        }, CONFIG.SCROLL_RENDER_DELAY_MS, CONFIG.POLL_FAST_MS);
        const after = vp.scrollTop;
        const atBottom = after + vp.clientHeight >= vp.scrollHeight - 5;
        return { didScroll: after !== before, atBottom, after };
    }

    async function scrollViewportTo(top) {
        const vp = getGridViewport();
        if (!vp) return;
        vp.scrollTop = top;
        try { vp.dispatchEvent(new Event('scroll', { bubbles: true })); } catch (_) {}
        await sleep(CONFIG.SCROLL_RENDER_DELAY_MS);
    }

    // Minimal nudge so the cell is comfortably inside the viewport.
    // Never recenters the whole grid the way scrollIntoView did.
    async function ensureCellVisible(row, getCell) {
        const vp = getGridViewport();
        if (!vp) return row;
        let cell = getCell(row);
        if (!cell) return row;
        const cellRect = cell.getBoundingClientRect();
        const vpRect = vp.getBoundingClientRect();
        const MARGIN = 40;
        let delta = 0;
        if (cellRect.top < vpRect.top + MARGIN) delta = cellRect.top - vpRect.top - MARGIN;
        else if (cellRect.bottom > vpRect.bottom - MARGIN) delta = cellRect.bottom - vpRect.bottom + MARGIN;
        if (delta !== 0) {
            vp.scrollTop += delta;
            try { vp.dispatchEvent(new Event('scroll', { bubbles: true })); } catch (_) {}
            await sleep(CONFIG.SCROLL_RENDER_DELAY_MS);
        }
        return row; // caller re-reads cells from the row it already holds
    }

    // Locate a row by scrolling: prefer DOWN from current position (normal
    // processing order), then a full sweep from the top (recovery).
    async function locateRowWithScrolling(sku) {
        const n = normalizeSku(sku);
        let row = findRowBySku(n);
        if (row) return row;

        const vp = getGridViewport();
        if (!vp) return null;

        // Phase 1: downward scan
        let lastTop = -1;
        for (let i = 0; i < 60; i++) {
            row = findRowBySku(n);
            if (row) return row;
            const before = vp.scrollTop;
            if (before === lastTop && i > 0) break;
            lastTop = before;
            vp.scrollTop = Math.min(vp.scrollHeight, before + 350);
            try { vp.dispatchEvent(new Event('scroll', { bubbles: true })); } catch (_) {}
            await sleep(CONFIG.SCROLL_RENDER_DELAY_MS);
            if (vp.scrollTop + vp.clientHeight >= vp.scrollHeight - 5) {
                row = findRowBySku(n);
                if (row) return row;
                break;
            }
        }

        // Phase 2: full sweep from the top
        vp.scrollTop = 0;
        try { vp.dispatchEvent(new Event('scroll', { bubbles: true })); } catch (_) {}
        await sleep(CONFIG.SCROLL_RENDER_DELAY_MS);
        row = findRowBySku(n);
        if (row) return row;
        lastTop = -1;
        for (let i = 0; i < 120; i++) {
            row = findRowBySku(n);
            if (row) return row;
            const before = vp.scrollTop;
            if (before === lastTop && i > 0) break;
            lastTop = before;
            vp.scrollTop = Math.min(vp.scrollHeight, before + 500);
            try { vp.dispatchEvent(new Event('scroll', { bubbles: true })); } catch (_) {}
            await sleep(CONFIG.SCROLL_RENDER_DELAY_MS);
            if (vp.scrollTop + vp.clientHeight >= vp.scrollHeight - 5) {
                row = findRowBySku(n);
                if (row) return row;
                break;
            }
        }
        return null;
    }

    // ============================================================
    // UOM MARKERS (persist across AG Grid row recycling)
    // ============================================================

    const uomMarkerState = new Map();

    function setUomMarkerState(sku, kind, pastedUom) {
        if (sku) uomMarkerState.set(sku, { kind, pastedUom });
    }
    function clearUomMarkerState(sku) { if (sku) uomMarkerState.delete(sku); }

    function readUomMismatch(row, pastedUom) {
        if (!pastedUom) return { mismatch: false, gridUom: '' };
        const cell = getUomCellFromRow(row);
        if (!cell) return { mismatch: false, gridUom: '' };
        const marker = cell.querySelector('.reqFillerUomFlag, .reqFillerUomCorrected');
        let text = cell.textContent.trim();
        if (marker) text = text.replace(marker.textContent, '').trim();
        const gridUom = normalizeUom(text);
        return { mismatch: gridUom !== pastedUom, gridUom };
    }

    function clearUomMarkers(row) {
        const cell = getUomCellFromRow(row);
        if (!cell) return;
        const marker = cell.querySelector('.reqFillerUomFlag, .reqFillerUomCorrected');
        if (!marker) return;
        if (marker.classList.contains('reqFillerUomCorrected')) cell.textContent = marker.textContent;
        else marker.remove();
    }

    function markUomResult(row, pastedUom, corrected) {
        const cell = getUomCellFromRow(row);
        if (!cell) return;
        const old = cell.querySelector('.reqFillerUomFlag, .reqFillerUomCorrected');
        if (old) old.remove();
        const marker = cell.ownerDocument.createElement('span');
        marker.style.fontWeight = 'bold';
        if (corrected) {
            marker.className = 'reqFillerUomCorrected';
            marker.style.color = '#50fa7b';
            marker.textContent = cell.textContent.trim();
            cell.textContent = '';
            cell.appendChild(marker);
        } else {
            marker.className = 'reqFillerUomFlag';
            marker.style.color = CONFIG.UOM_MISMATCH_COLOR;
            marker.style.marginLeft = '0.3in';
            marker.textContent = ' ' + pastedUom;
            cell.appendChild(marker);
        }
        setUomMarkerState(getSkuFromRow(row), corrected ? 'corrected' : 'mismatch', pastedUom);
    }

    function applyStoredUomMarker(row) {
        const sku = getSkuFromRow(row);
        if (!sku) return;
        const state = uomMarkerState.get(sku);
        if (!state) return;
        const cell = getUomCellFromRow(row);
        if (!cell) return;
        if (cell.querySelector('.reqFillerUomFlag, .reqFillerUomCorrected')) return;
        const marker = cell.ownerDocument.createElement('span');
        marker.style.fontWeight = 'bold';
        if (state.kind === 'corrected') {
            marker.className = 'reqFillerUomCorrected';
            marker.style.color = '#50fa7b';
            marker.textContent = cell.textContent.trim();
            cell.textContent = '';
            cell.appendChild(marker);
        } else if (state.kind === 'mismatch') {
            marker.className = 'reqFillerUomFlag';
            marker.style.color = CONFIG.UOM_MISMATCH_COLOR;
            marker.style.marginLeft = '0.3in';
            marker.textContent = ' ' + state.pastedUom;
            cell.appendChild(marker);
        }
    }

    setInterval(() => {
        try {
            if (uomMarkerState.size === 0) return;
            if (!ensureGridDoc()) return;
            resolveColumnIds();
            for (const row of getGridRows()) applyStoredUomMarker(row);
        } catch (_) {}
    }, CONFIG.UOM_MARKER_REAPPLY_INTERVAL_MS);

    // ============================================================
    // UOM DIALOG
    // ============================================================

    function collectDialogs(doc) {
        let dialogs = [];
        try {
            dialogs = dialogs.concat(Array.from(doc.querySelectorAll('.ui-dialog[role="dialog"]')));
        } catch (_) {}
        try {
            const topDoc = doc.defaultView && doc.defaultView.top && doc.defaultView.top.document;
            if (topDoc && topDoc !== doc) {
                dialogs = dialogs.concat(Array.from(topDoc.querySelectorAll('.ui-dialog[role="dialog"]')));
            }
        } catch (_) {}
        return dialogs;
    }

    function getDialogRows(dialog) {
        if (!dialog) return [];
        const container = dialog.querySelector('.ag-center-cols-container');
        return container ? Array.from(container.querySelectorAll(':scope > .ag-row')) : [];
    }

    function findDialogUomColId(dialog) {
        const headers = Array.from(dialog.querySelectorAll('.ag-header-cell-text'));
        for (const span of headers) {
            if (CONFIG.UOM_PICKER_HEADER_TEXT.test(span.textContent.trim())) {
                const header = span.closest('.ag-header-cell');
                if (header) return header.getAttribute('col-id');
            }
        }
        return null;
    }

    async function pickUomInDialog(dialog, desiredUom) {
        const colId = await waitFor(() => findDialogUomColId(dialog), 3000, CONFIG.POLL_FAST_MS);
        if (!colId) return { ok: false, reason: 'UOM column not found in picker' };

        const target = await waitFor(() => {
            const rows = getDialogRows(dialog);
            return rows.find(r => {
                const cell = r.querySelector(`.ag-cell[col-id="${colId}"]`);
                return cell && normalizeUom(cell.textContent) === desiredUom;
            }) || null;
        }, 4000, CONFIG.POLL_FAST_MS);

        if (!target) return { ok: false, reason: `"${desiredUom}" not offered` };

        const targetCell = target.querySelector(`.ag-cell[col-id="${colId}"]`) || target;

        let selected = false;
        for (let attempt = 1; attempt <= 4 && !selected; attempt++) {
            dispatchRealisticClick(targetCell);
            selected = !!(await waitFor(
                () => target.classList.contains('ag-row-selected'),
                400, CONFIG.POLL_FAST_MS
            ));
        }
        if (!selected) return { ok: false, reason: `Could not select "${desiredUom}"` };

        const selectBtn = await waitFor(() =>
            Array.from(dialog.querySelectorAll('.ui-dialog-buttonpane button')).find(b =>
                isVisible(b) && CONFIG.UOM_PICKER_SELECT_BUTTON_TEXT.test(b.textContent.trim())
            ) || null, 2000, CONFIG.POLL_FAST_MS);

        if (!selectBtn) return { ok: false, reason: 'Select button not found' };

        dispatchRealisticClick(selectBtn);
        return { ok: true };
    }

    function closeDialogIfOpen(dialog) {
        if (!dialog || !isVisible(dialog)) return;
        const closeBtn = dialog.querySelector('.ui-dialog-titlebar-close') ||
            Array.from(dialog.querySelectorAll('.ui-dialog-buttonpane button')).find(b =>
                /^close$/i.test(b.textContent.trim()));
        if (closeBtn) dispatchRealisticClick(closeBtn);
    }

    // Correct the Req UOM for `sku` via the zoom picker.
    // Saves/restores scroll position; caller re-locates the row afterwards.
    async function correctReqUom(sku, desiredUom) {
        const doc = ensureGridDoc();
        if (!doc) return { ok: false, reason: 'grid unavailable' };

        const vpBefore = getGridViewport();
        const savedScrollTop = vpBefore ? vpBefore.scrollTop : null;

        let row = findRowBySku(sku);
        if (!row) return { ok: false, reason: 'row not rendered' };

        await ensureCellVisible(row, getUomCellFromRow);

        const uomCell = getUomCellFromRow(row);
        if (!uomCell) return { ok: false, reason: 'Req UOM cell not found' };
        const rowIndex = row.getAttribute('row-index');

        // Enter edit mode -> zoom button appears
        let zoomBtn = null;
        for (let attempt = 1; attempt <= CONFIG.UOM_OPEN_RETRY_ATTEMPTS && !zoomBtn; attempt++) {
            clickEl(uomCell);
            zoomBtn = await waitFor(() => {
                let b = null;
                if (rowIndex !== null && rowIndex !== undefined) {
                    b = doc.getElementById(`${CONFIG.UOM_INPUT_ID_PREFIX}${rowIndex}${CONFIG.UOM_ZOOM_BTN_ID_SUFFIX}`);
                }
                if (!b) b = getUomCellFromRow(findRowBySku(sku))?.querySelector('button');
                return (b && isVisible(b)) ? b : null;
            }, 1500, CONFIG.POLL_FAST_MS);
        }
        if (!zoomBtn) return { ok: false, reason: 'Req UOM zoom button not found' };

        // Open dialog (poll for a NEW visible dialog with rows)
        let dialog = null;
        for (let attempt = 1; attempt <= CONFIG.UOM_OPEN_RETRY_ATTEMPTS && !dialog; attempt++) {
            const before = new Set(collectDialogs(doc));
            clickEl(zoomBtn);
            dialog = await waitFor(() => {
                const d = collectDialogs(doc).find(x => !before.has(x) && isVisible(x) && getDialogRows(x).length > 0);
                return d || null;
            }, CONFIG.DIALOG_OPEN_TIMEOUT_MS, CONFIG.POLL_FAST_MS);
        }
        if (!dialog) return { ok: false, reason: 'UOM picker did not open' };

        const result = await pickUomInDialog(dialog, desiredUom);
        if (!result.ok) { closeDialogIfOpen(dialog); return result; }

        // Wait for the dialog to actually close
        await waitFor(() => !isVisible(dialog), CONFIG.DIALOG_CLOSE_TIMEOUT_MS, CONFIG.POLL_FAST_MS);
        await sleep(300);

        // Reconnect + restore scroll position
        ensureGridDoc();
        resolveColumnIds();
        const vpAfter = getGridViewport();
        if (vpAfter && savedScrollTop !== null) {
            vpAfter.scrollTop = savedScrollTop;
            try { vpAfter.dispatchEvent(new Event('scroll', { bubbles: true })); } catch (_) {}
            await sleep(CONFIG.SCROLL_RENDER_DELAY_MS);
        }

        // Re-locate the row and confirm the UOM stuck
        let relocated = findRowBySku(sku) || await locateRowWithScrolling(sku);
        if (!relocated) return { ok: false, reason: 'row disappeared after UOM refresh' };

        const check = readUomMismatch(relocated, desiredUom);
        if (check.gridUom !== desiredUom) {
            return { ok: false, reason: `Req UOM still reads "${check.gridUom}"` };
        }
        return { ok: true };
    }

    // ============================================================
    // QUANTITY EDIT (single row; retries internally)
    // ============================================================

    function readQuantityFromRow(row) {
        const cell = getQtyCellFromRow(row);
        if (!cell) return '';
        const input = cell.querySelector('input, textarea');
        return normalizeQty(input ? input.value : cell.textContent);
    }

    async function verifyQuantity(sku, wanted) {
        return !!(await waitFor(() => {
            const row = findRowBySku(sku);
            if (!row) return false;
            return qtyMatches(readQuantityFromRow(row), wanted);
        }, CONFIG.VERIFY_TIMEOUT_MS, CONFIG.POLL_FAST_MS));
    }

    async function editRowQuantity(sku, valueStr) {
        const wanted = normalizeQty(valueStr);

        for (let attempt = 1; attempt <= CONFIG.QTY_EDIT_RETRY_ATTEMPTS; attempt++) {
            if (aborted) return { ok: false, reason: 'stopped by user' };

            const doc = ensureGridDoc();
            if (!doc) { await sleep(300); continue; }
            resolveColumnIds();

            let row = findRowBySku(sku) || await locateRowWithScrolling(sku);
            if (!row) return { ok: false, reason: 'SKU row not available' };

            await ensureCellVisible(row, getQtyCellFromRow);

            let qtyCell = getQtyCellFromRow(row);
            if (!qtyCell) { await sleep(200); continue; }

            const rowIndex = row.getAttribute('row-index');
            const beforeInputs = new Set(doc.querySelectorAll('input, textarea'));

            clickEl(qtyCell);

            const editor = await waitFor(() => {
                if (rowIndex !== null && rowIndex !== undefined) {
                    const byId = doc.getElementById(`${CONFIG.QTY_INPUT_ID_PREFIX}${rowIndex}`);
                    if (byId && isVisible(byId)) return byId;
                }
                const cellNow = getQtyCellFromRow(findRowBySku(sku) || row);
                if (cellNow) {
                    const inside = cellNow.querySelector('input, textarea');
                    if (inside && isVisible(inside)) return inside;
                }
                const qtyInputs = Array.from(doc.querySelectorAll(
                    `input[id^="${CONFIG.QTY_INPUT_ID_PREFIX}"], textarea[id^="${CONFIG.QTY_INPUT_ID_PREFIX}"]`));
                const fresh = qtyInputs.find(el => !beforeInputs.has(el) && isVisible(el));
                if (fresh) return fresh;
                const all = Array.from(doc.querySelectorAll('input, textarea'));
                return all.find(el => !beforeInputs.has(el) && isVisible(el)) || null;
            }, CONFIG.EDITOR_WAIT_TIMEOUT_MS, CONFIG.POLL_FAST_MS);

            if (!editor) {
                log(`SKU ${sku}: quantity editor did not appear (attempt ${attempt}).`, 'warn');
                await sleep(250);
                continue;
            }

            try { editor.focus({ preventScroll: true }); } catch (_) {}
            setNativeValue(editor, wanted);
            await sleep(80);
            pressEnter(editor);
            try { editor.blur(); } catch (_) {}
            try { editor.dispatchEvent(new Event('blur', { bubbles: true })); } catch (_) {}

            if (await verifyQuantity(sku, wanted)) {
                return { ok: true };
            }

            log(`SKU ${sku}: quantity did not stick (attempt ${attempt}/${CONFIG.QTY_EDIT_RETRY_ATTEMPTS}).`, 'warn');
            await sleep(250);
        }

        return { ok: false, reason: 'quantity did not stick after retries' };
    }

    // ============================================================
    // ONE ROW, END TO END  (the heart of v4: strictly sequential)
    // ============================================================

    async function processOneRow(sku, item, done) {
        // 1. Locate the row (rendered, or scroll to it)
        let row = findRowBySku(sku) || await locateRowWithScrolling(sku);
        if (!row) {
            // Not available right now — do NOT mark failed; leave it in
            // the remaining pool so the recovery sweep finds it later.
            log(`SKU ${sku}: not rendered yet — deferring to recovery sweep.`, 'info');
            return;
        }

        // 2. UOM check / correction
        const uomCheck = readUomMismatch(row, item.uom);
        if (uomCheck.mismatch) {
            log(`SKU ${sku}: Req UOM "${uomCheck.gridUom}" vs "${item.uom}" — correcting...`, 'warn');
            let correction;
            try {
                correction = await correctReqUom(sku, item.uom);
            } catch (err) {
                correction = { ok: false, reason: err && err.message ? err.message : String(err) };
            }
            ensureGridDoc();
            resolveColumnIds();
            row = findRowBySku(sku) || await locateRowWithScrolling(sku);
            if (row) {
                markUomResult(row, item.uom, !!(correction && correction.ok));
            }
            log(correction && correction.ok
                ? `SKU ${sku}: Req UOM corrected to "${item.uom}".`
                : `SKU ${sku}: UOM correction failed — ${correction ? correction.reason : 'unknown'}.`,
                correction && correction.ok ? 'ok' : 'warn');
        } else {
            clearUomMarkers(row);
            clearUomMarkerState(sku);
        }

        if (aborted) return;

        // 3. Quantity
        const qtyStr = CONFIG.formatQty(item.qty);
        const qtyResult = await editRowQuantity(sku, qtyStr);
        if (qtyResult.ok) {
            done.filled.add(sku);
            log(`SKU ${sku} -> quantity ${qtyStr}`, 'ok');
        } else {
            done.failed.add(sku);
            log(`SKU ${sku}: quantity failed — ${qtyResult.reason}`, 'warn');
        }
    }

    // ============================================================
    // MAIN SCAN LOOP
    //
    // Walks the grid top -> bottom. Every rendered row that matches
    // an unprocessed SKU is completed fully before moving on.
    // At the bottom, any SKUs still pending get RECOVERY_PASSES
    // additional full top -> bottom sweeps before being reported.
    // ============================================================

    async function processAllRows(dataMap, skuList) {
        const done = { filled: new Set(), failed: new Set() };

        await scrollViewportTo(0);
        await sleep(CONFIG.SCROLL_RENDER_DELAY_MS);

        let recoveryPass = 0;
        let iterations = 0;

        while (iterations < CONFIG.MAX_SCROLL_ITERATIONS) {
            if (aborted) break;
            iterations++;

            ensureGridDoc();
            resolveColumnIds();

            const rows = getGridRows();
            for (const row of rows) {
                if (aborted) break;
                const sku = getSkuFromRow(row);
                if (!sku || !dataMap[sku]) continue;
                if (done.filled.has(sku) || done.failed.has(sku)) continue;
                await processOneRow(sku, dataMap[sku], done);
                await sleep(CONFIG.ROW_TO_ROW_DELAY_MS);
            }

            const remaining = skuList.filter(s => !done.filled.has(s) && !done.failed.has(s));
            if (remaining.length === 0) {
                log('All pasted SKUs processed.', 'ok');
                break;
            }
            if (aborted) break;

            const vp = getGridViewport();
            const atBottom = !vp || vp.scrollTop + vp.clientHeight >= vp.scrollHeight - 5;

            if (atBottom) {
                if (recoveryPass < CONFIG.RECOVERY_PASSES) {
                    recoveryPass++;
                    log(`Bottom reached with ${remaining.length} pending — recovery sweep ${recoveryPass}/${CONFIG.RECOVERY_PASSES} from top...`, 'warn');
                    await scrollViewportTo(0);
                    await sleep(CONFIG.SCROLL_RENDER_DELAY_MS);
                    continue;
                }
                log(`Finished. ${remaining.length} SKU(s) could not be located after all sweeps.`, 'warn');
                break;
            }

            await scrollViewportBy(Math.max(200, (vp ? vp.clientHeight : 400) - 60));
        }

        return done;
    }

    // ============================================================
    // FILTER
    // ============================================================

    function findVisibleFilterInput() {
        const doc = ensureGridDoc();
        if (!doc) return null;
        return Array.from(doc.querySelectorAll(CONFIG.FILTER_INPUT_SELECTOR)).find(input =>
            isVisible(input) &&
            (!CONFIG.FILTER_INPUT_PLACEHOLDER || input.placeholder === CONFIG.FILTER_INPUT_PLACEHOLDER)
        ) || null;
    }

    function findVisibleApplyButton() {
        const doc = ensureGridDoc();
        if (!doc) return null;
        const candidates = Array.from(doc.querySelectorAll(CONFIG.APPLY_BUTTON_SELECTOR));
        let btn = candidates.find(el => isVisible(el) && /^apply filter$/i.test(el.textContent.trim()));
        if (!btn) {
            btn = Array.from(doc.querySelectorAll('button')).find(b =>
                isVisible(b) && /apply filter/i.test(b.textContent));
        }
        return btn || null;
    }

    async function openPartNumberFilter() {
        const doc = ensureGridDoc();
        if (!doc) return false;
        const { skuColId } = resolveColumnIds();
        const header = doc.querySelector(`.ag-header-cell[col-id="${skuColId}"]`);
        if (!header) { log('Could not find Part # header.', 'err'); return false; }

        for (let attempt = 1; attempt <= 4; attempt++) {
            const menuBtn = header.querySelector('[ref="eMenu"], .ag-header-cell-menu-button');
            if (!menuBtn) { log('Part # filter/menu button not found.', 'warn'); return false; }
            dispatchRealisticClick(menuBtn);
            if (await waitFor(findVisibleFilterInput, 800, CONFIG.POLL_FAST_MS)) {
                log('Part # filter panel is open.', 'ok');
                return true;
            }
            // Some builds open a menu first — click the Filter tab in it
            const popup = doc.querySelector('.ag-popup:not(.ag-hidden) .ag-menu, .ag-popup .ag-menu');
            if (popup) {
                const filterIcon = popup.querySelector(
                    '.ag-tab-selector .ag-icon-filter, .ag-menu-header .ag-icon-filter, [aria-label="Filter"]');
                if (filterIcon) {
                    const clickable = filterIcon.closest('span, button, div');
                    if (clickable) {
                        dispatchRealisticClick(clickable);
                        if (await waitFor(findVisibleFilterInput, 800, CONFIG.POLL_FAST_MS)) {
                            log('Part # filter panel is open.', 'ok');
                            return true;
                        }
                    }
                }
            }
            await sleep(300);
        }
        log('Could not open the Part # filter popup.', 'err');
        return false;
    }

    async function fillFilterAndApply(skuList) {
        let input = findVisibleFilterInput();
        if (!input) { await openPartNumberFilter(); input = findVisibleFilterInput(); }
        if (!input) { log('Filter input not found.', 'err'); return false; }

        setNativeValue(input, skuList.join(','));
        log(`Filter filled with ${skuList.length} SKU(s).`, 'ok');
        await sleep(120);

        const applyBtn = findVisibleApplyButton();
        if (!applyBtn) { log('Apply Filter button not found.', 'err'); return false; }
        clickEl(applyBtn);
        log('Clicked Apply Filter.', 'ok');
        return true;
    }

    // ============================================================
    // PARSE INPUT
    // ============================================================

    function parseInput(raw) {
        const lines = String(raw || '').split(/\r?\n/);
        const rows = [];
        for (const rawLine of lines) {
            const line = rawLine.trim();
            if (!line) continue;
            let cols = line.split('\t').map(c => c.trim());
            if (cols.length < 4) cols = line.split(/\s{2,}/).map(c => c.trim());
            if (cols.length < 4) continue;
            const skuRaw = cols[0], descRaw = cols[1] || '',
                  qtyRaw = cols[2] || '', uomRaw = cols[3] || '';
            if (/^item\s*sku$/i.test(skuRaw)) continue;
            const sku = normalizeSku(skuRaw);
            if (!sku) continue;
            const qtyNum = parseFloat(qtyRaw.replace(/,/g, ''));
            if (Number.isNaN(qtyNum)) continue;
            rows.push({ sku, qty: qtyNum, description: descRaw.trim(), uom: normalizeUom(uomRaw) });
        }
        return rows;
    }

    // ============================================================
    // REPORT
    // ============================================================

    function describeSku(sku, dataMap) {
        const d = dataMap[sku] && dataMap[sku].description;
        return d ? `${sku} (${d})` : sku;
    }

    function reportResults(dataMap, skuList, done) {
        const notFound = skuList.filter(s => !done.filled.has(s) && !done.failed.has(s));
        const failedEdit = skuList.filter(s => done.failed.has(s));

        if (notFound.length === 0 && failedEdit.length === 0) {
            log(`SUCCESS: all ${skuList.length} item(s) filled.`, 'ok');
            alert(`SUCCESS\n\nAll ${skuList.length} item(s) were filled successfully.`);
            return;
        }

        log(`${notFound.length + failedEdit.length} of ${skuList.length} item(s) were NOT filled.`, 'err');

        const lines = [];
        if (notFound.length > 0) {
            log(`Not found in grid (${notFound.length}):`, 'err');
            lines.push(`Not found (${notFound.length}):`);
            notFound.forEach(sku => { log(`Missing: ${describeSku(sku, dataMap)}`, 'err'); lines.push(`  - ${describeSku(sku, dataMap)}`); });
        }
        if (failedEdit.length > 0) {
            log(`Found but quantity failed (${failedEdit.length}):`, 'err');
            lines.push(`Quantity failed (${failedEdit.length}):`);
            failedEdit.forEach(sku => { log(`Failed: ${describeSku(sku, dataMap)}`, 'err'); lines.push(`  - ${describeSku(sku, dataMap)}`); });
        }

        alert(`${notFound.length + failedEdit.length} item(s) were NOT filled.\n\n` + lines.join('\n'));
    }

    // ============================================================
    // MAIN
    // ============================================================

    document.getElementById('reqFillerGenerate').addEventListener('click', async () => {
        const button = document.getElementById('reqFillerGenerate');
        const stopBtn = document.getElementById('reqFillerStop');
        button.disabled = true;
        button.textContent = 'Running...';
        stopBtn.style.display = 'block';
        aborted = false;

        try {
            clearLog();
            const raw = document.getElementById('reqFillerInput').value;
            const parsed = parseInput(raw);
            if (parsed.length === 0) {
                log('No valid rows found. Expected: SKU / Description / Qty / UOM.', 'err');
                return;
            }
            log(`Parsed ${parsed.length} row(s). Processing strictly one-by-one.`, 'ok');

            const dataMap = Object.create(null);
            const skuList = [];
            for (const item of parsed) {
                dataMap[item.sku] = { qty: item.qty, description: item.description, uom: item.uom };
                if (!skuList.includes(item.sku)) skuList.push(item.sku);
            }

            log('Locating current BirchStreet Order Sheet...', 'info');
            if (!ensureGridDoc()) {
                log('Order Sheet grid not found. Open the Order Sheet and try again.', 'err');
                return;
            }
            resolveColumnIds();

            log('Opening Part # filter...', 'info');
            if (!(await openPartNumberFilter())) return;
            if (!(await fillFilterAndApply(skuList))) return;

            log('Waiting for the filtered grid to refresh...', 'info');
            await sleep(CONFIG.FILTER_APPLY_SETTLE_MS);
            ensureGridDoc();
            resolveColumnIds();

            const t0 = Date.now();
            const result = await processAllRows(dataMap, skuList);
            const secs = ((Date.now() - t0) / 1000).toFixed(1);
            log(`Done in ${secs}s — ${result.filled.size} filled, ${result.failed.size} failed.`, 'info');

            reportResults(dataMap, skuList, result);

        } catch (error) {
            console.error('[REQ Filler v4]', error);
            log(`Unexpected error: ${error && error.message ? error.message : String(error)}`, 'err');
            alert('REQ Filler encountered an unexpected error.\n\n' +
                (error && error.message ? error.message : String(error)));
        } finally {
            button.disabled = false;
            button.textContent = 'Generate';
            stopBtn.style.display = 'none';
        }
    });

    console.log('[REQ SKU/Qty Filler v4.0] loaded (host: ' +
        (window.name === ORDER_SHEET_FRAME_NAME ? 'OrderSheetTab' : 'standalone Order Sheet page') + ').');
})();