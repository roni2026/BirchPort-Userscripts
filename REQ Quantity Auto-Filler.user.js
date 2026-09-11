// ==UserScript==
// @name         REQ Quantity Auto-Filler
// @namespace    roni2026.birchstreet.tools
// @version      2.2
// @description  Paste SKU + Qty rows, auto-filter the Order Sheet grid by SKU (Part #), auto-fill quantities into matching rows in top-to-bottom order, auto-correct any Req UOM mismatch via the UOM picker dialog (flagging in red when it can't), scroll and repeat until all items are filled, and alert on any pasted item that didn't get filled
// @author       roni2026
// @match        https://*.birchstreetsystems.com/*
// @grant        none
// @run-at       document-idle
// ==/UserScript==

(function () {
    'use strict';

    // ============================================================
    // CONFIG
    // ============================================================
    const CONFIG = {
        // Header text used to auto-detect the SKU (Part #) and Quantity columns.
        // col-ids in Birchstreet are session/instance-specific, so header text is the
        // primary detection method; hardcoded col-ids below are only a last-resort fallback.
        SKU_HEADER_TEXT: /^part\s*#?$/i,
        SKU_COL_ID_FALLBACK: '31239',

        QTY_HEADER_TEXT: /^quantity$/i,
        QTY_COL_ID_FALLBACK: '31242',

        // "Req UOM" column — used to flag/correct a mismatch against the UOM the user pasted in.
        UOM_HEADER_TEXT: /^req\s*uom$/i,
        UOM_COL_ID_FALLBACK: '31241',

        // Color used for the floating "your UOM differs" flag text, and for the
        // "this was auto-corrected" marker, next to/on Req UOM.
        UOM_MISMATCH_COLOR: '#ff5555',

        // ag-grid text filter input (appears in the column filter popup, placeholder "Filter...")
        FILTER_INPUT_SELECTOR: 'input.ag-input-field-input.ag-text-field-input[type="text"]',
        FILTER_INPUT_PLACEHOLDER: 'Filter...',

        // Apply Filter button in that same popup (NOTE: "Clear Filter" shares the same classes,
        // so matching is done by text, not just this selector)
        APPLY_BUTTON_SELECTOR: 'button.ag-standard-button.ag-filter-apply-panel-button',

        // Real row/cell selectors, scoped to the center (non-pinned) column container
        ROW_CONTAINER_SELECTOR: '.ag-center-cols-container',
        ROW_SELECTOR: '.ag-row',
        CELL_SELECTOR: '.ag-cell',

        // ag-grid scrollable viewport (where virtual scrolling happens)
        GRID_VIEWPORT_SELECTOR: '.ag-body-viewport, .ag-center-cols-viewport',

        // Confirmed from a real recorded session: clicking a quantity cell swaps it to
        // <input id="QUANTITY{row-index}">, e.g. #QUANTITY0, #QUANTITY1, ...
        QTY_INPUT_ID_PREFIX: 'QUANTITY',

        // Confirmed from the Req UOM cell markup: clicking it swaps to
        // <input id="REQUESTED_UOM{row-index}" disabled> + <button id="REQUESTED_UOM{row-index}ZM">
        // (the "ZM" = zoom button that opens the UOM picker dialog).
        UOM_INPUT_ID_PREFIX: 'REQUESTED_UOM',
        UOM_ZOOM_BTN_ID_SUFFIX: 'ZM',

        // In the UOM picker dialog's own ag-grid, the plain "UOM" column (not "Inventory UOM",
        // "Default Inv UOM", etc.) is what we match the pasted UOM against. Confirmed from a real
        // recorded session: you click the cell under this column for the desired row (which then
        // shows ag-row-selected on that row), then click Select.
        UOM_PICKER_HEADER_TEXT: /^uom$/i,
        UOM_PICKER_SELECT_BUTTON_TEXT: /^select$/i,
        UOM_PICKER_CLOSE_BUTTON_TEXT: /^close$/i,

        // How many times / how often to poll for the picker dialog to appear, and for it
        // to disappear again after clicking Select.
        UOM_DIALOG_WAIT_ATTEMPTS: 20,
        UOM_DIALOG_POLL_MS: 150,

        // Retry count/delay for clicking a picker row and confirming ag-grid actually
        // registered the selection (ag-row-selected) before we trust it and hit Select.
        UOM_ROW_SELECT_RETRY_ATTEMPTS: 3,
        UOM_ROW_SELECT_CHECK_DELAY_MS: 200,

        // How many times to retry opening the UOM picker dialog if it flashes open and
        // instantly closes again (a toggle-close issue, separate from it not opening at all).
        UOM_DIALOG_OPEN_RETRY_ATTEMPTS: 3,

        // Extra settle time after a UOM correction, since changing Req UOM can trigger the
        // underlying app to refresh/re-render the Order Sheet grid.
        UOM_POST_SELECT_DELAY_MS: 1200,

        // Set to false to go back to just flagging UOM mismatches in red without attempting
        // to open the picker and correct them.
        UOM_CORRECTION_ENABLED: true,

        // Delay after clicking Apply Filter before we start filling quantities (ms)
        FILTER_APPLY_DELAY_MS: 800,

        // Delay after clicking a qty cell before we look for its input (ms)
        CELL_EDIT_DELAY_MS: 200,

        // Delay between processing each row (ms)
        ROW_PROCESS_DELAY_MS: 150,

        // Delay after each scroll to let ag-grid render new virtual rows (ms)
        SCROLL_RENDER_DELAY_MS: 600,

        // How many pixels to scroll each time
        SCROLL_AMOUNT_PX: 600,

        // Safety cap on scroll iterations
        MAX_SCROLL_ITERATIONS: 100,

        // How many times to retry opening the Part # filter menu if it closes on us before
        // the filter input is usable, and how long to wait between attempts / before
        // deciding it actually opened. Also reused for retrying "click the Req UOM cell
        // until its zoom button actually appears".
        FILTER_OPEN_RETRY_ATTEMPTS: 3,
        FILTER_OPEN_CHECK_DELAY_MS: 300,
        FILTER_OPEN_RETRY_DELAY_MS: 400,

        // How to format the qty before typing it in.
        // Default: strips the ".000" padding -> "6.000" becomes "6" (matches the plain
        // "5", "10", "15" values seen in the recorded session).
        formatQty(qtyNumber) {
            return String(qtyNumber);
        }
    };

    // ============================================================
    // UI (always attached to the top-level page, regardless of where the grid lives)
    // ============================================================
    const style = document.createElement('style');
    style.textContent = `
        #reqFillerPanel {
            position: fixed;
            top: 80px;
            right: 20px;
            width: 340px;
            background: #1e1f29;
            color: #f8f8f2;
            border: 1px solid #44475a;
            border-radius: 10px;
            box-shadow: 0 8px 24px rgba(0,0,0,0.45);
            z-index: 999999;
            font-family: "Segoe UI", Arial, sans-serif;
            font-size: 13px;
            overflow: hidden;
        }
        #reqFillerHeader {
            background: #282a36;
            padding: 8px 12px;
            cursor: move;
            display: flex;
            justify-content: space-between;
            align-items: center;
            border-bottom: 1px solid #44475a;
            user-select: none;
        }
        #reqFillerHeader span { font-weight: 600; color: #bd93f9; }
        #reqFillerHeader button {
            background: none; border: none; color: #f8f8f2;
            cursor: pointer; font-size: 15px; line-height: 1;
        }
        #reqFillerBody { padding: 10px 12px; }
        #reqFillerBody textarea {
            width: 100%; height: 150px; resize: vertical;
            background: #282a36; color: #f8f8f2;
            border: 1px solid #44475a; border-radius: 6px;
            padding: 6px; box-sizing: border-box; font-family: monospace;
            font-size: 11.5px;
        }
        .reqFillerBtnRow { display: flex; gap: 6px; margin-top: 8px; }
        .reqFillerBtnRow button {
            flex: 1; padding: 7px 6px; border: none; border-radius: 6px;
            cursor: pointer; font-weight: 600; font-size: 12px;
        }
        #reqFillerOpenFilter { background: #8be9fd; color: #1e1f29; }
        #reqFillerOpenFilter:hover { background: #a4eeff; }
        #reqFillerGenerate { background: #50fa7b; color: #1e1f29; }
        #reqFillerGenerate:hover { background: #6bffa0; }
        #reqFillerClear { background: #44475a; color: #f8f8f2; }
        #reqFillerClear:hover { background: #565a70; }
        #reqFillerStatus {
            margin-top: 8px; max-height: 160px; overflow-y: auto;
            background: #14151c; border: 1px solid #44475a; border-radius: 6px;
            padding: 6px 8px; font-family: monospace; font-size: 11px;
            line-height: 1.5; white-space: pre-wrap;
        }
        #reqFillerStatus .ok { color: #50fa7b; }
        #reqFillerStatus .warn { color: #f1fa8c; }
        #reqFillerStatus .err { color: #ff5555; }
        #reqFillerToggleBtn {
            position: fixed; top: 80px; right: 20px; z-index: 999998;
            background: #bd93f9; color: #1e1f29; border: none;
            padding: 8px 12px; border-radius: 8px; font-weight: 700;
            cursor: pointer; box-shadow: 0 4px 12px rgba(0,0,0,0.4);
        }
    `;
    document.head.appendChild(style);

    const panel = document.createElement('div');
    panel.id = 'reqFillerPanel';
    panel.innerHTML = `
        <div id="reqFillerHeader">
            <span>REQ SKU/Qty Filler</span>
            <button id="reqFillerHide" title="Minimize">&minus;</button>
        </div>
        <div id="reqFillerBody">
            <textarea id="reqFillerInput" placeholder="Paste rows here, e.g.&#10;32746&#9;FRUIT - AMBARELLA&#9; 6.000 &#9;KG&#10;16308&#9;FRUIT - PINEAPPLE&#9; 40.000 &#9;KG"></textarea>
            <div class="reqFillerBtnRow">
                <button id="reqFillerClear">Clear</button>
                <button id="reqFillerGenerate" style="flex:2;">Generate</button>
            </div>
            <div id="reqFillerStatus">Paste your data, then click Generate.</div>
        </div>
    `;
    document.body.appendChild(panel);

    const toggleBtn = document.createElement('button');
    toggleBtn.id = 'reqFillerToggleBtn';
    toggleBtn.textContent = 'REQ Filler';
    toggleBtn.style.display = 'none';
    document.body.appendChild(toggleBtn);

    document.getElementById('reqFillerHide').addEventListener('click', () => {
        panel.style.display = 'none';
        toggleBtn.style.display = 'block';
    });
    toggleBtn.addEventListener('click', () => {
        panel.style.display = 'block';
        toggleBtn.style.display = 'none';
    });

    // Draggable header
    (function makeDraggable() {
        const header = document.getElementById('reqFillerHeader');
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

    const statusEl = document.getElementById('reqFillerStatus');
    function log(msg, kind = '') {
        const line = document.createElement('div');
        if (kind) line.className = kind;
        line.textContent = msg;
        statusEl.appendChild(line);
        statusEl.scrollTop = statusEl.scrollHeight;
    }
    function clearLog() {
        statusEl.innerHTML = '';
    }

    document.getElementById('reqFillerClear').addEventListener('click', () => {
        document.getElementById('reqFillerInput').value = '';
        clearLog();
        log('Cleared. Paste new data and click Generate.');
    });

    // ============================================================
    // Generic helpers
    // ============================================================
    const sleep = (ms) => new Promise((res) => setTimeout(res, ms));

    // Properly set a value on a React/Angular-controlled input so the
    // framework's change detection actually picks it up.
    function setNativeValue(el, value) {
        const proto = Object.getPrototypeOf(el);
        const desc = Object.getOwnPropertyDescriptor(proto, 'value');
        if (desc && desc.set) {
            desc.set.call(el, value);
        } else {
            el.value = value;
        }
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
    }

    function isVisible(el) {
        return !!(el && (el.offsetWidth || el.offsetHeight || el.getClientRects().length));
    }

    function clickEl(el) {
        // Using the browser's native click() instead of manually dispatching
        // mousedown/mouseup/click as separate synthetic events. Kept for the
        // plain qty-cell/input-commit flow, where a single 'click' event is
        // enough. NOT used for anything that opens a popup/dialog or drives
        // ag-grid row selection — see dispatchRealisticClick() below for those.
        el.focus({ preventScroll: true });
        el.click();
    }

    // Fuller, coordinate-correct pointer/mouse event sequence (pointerdown, mousedown,
    // pointerup, mouseup, click) instead of just el.click(). Plain .click() only ever
    // fires a single 'click' event — it never fires mousedown/mouseup/pointerdown/up —
    // so any UI code that opens/tracks a popup or drives row-selection based on those
    // events (common for dropdown/menu widgets and ag-grid row selection) can behave
    // differently than it does for a real click. This can't fake event.isTrusted (no
    // page script can), but it gets much closer to what a real click actually
    // dispatches, which is what these widgets typically listen for. Confirmed needed
    // for: the Part # filter menu button, the Req UOM cell's zoom button, selecting a
    // row in the UOM picker dialog, and the picker's Select/Close buttons — a plain
    // click() on any of those either failed to open the popup or failed to register
    // the row as selected, which is why the UOM correction wasn't sticking.
    function dispatchRealisticClick(el) {
        const rect = el.getBoundingClientRect();
        const x = rect.left + rect.width / 2;
        const y = rect.top + rect.height / 2;
        const view = el.ownerDocument.defaultView || window;

        try { el.focus({ preventScroll: true }); } catch (e) { /* not focusable, ignore */ }

        ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click'].forEach((type) => {
            const isDown = type.endsWith('down');
            const isPointerType = type.startsWith('pointer');
            const EventCtor = (isPointerType && view.PointerEvent) ? view.PointerEvent : view.MouseEvent;
            const evt = new EventCtor(type, {
                bubbles: true,
                cancelable: true,
                composed: true,
                view,
                clientX: x,
                clientY: y,
                button: 0,
                buttons: isDown ? 1 : 0,
                pointerType: 'mouse',
                isPrimary: true
            });
            el.dispatchEvent(evt);
        });
    }

    // Normalize a SKU string for comparison — strips leading zeros so
    // "32746" matches the grid's "000000000032746"
    function normalizeSku(str) {
        const digits = String(str).trim().replace(/\D/g, '');
        if (!digits) return '';
        return String(parseInt(digits, 10));
    }

    // Normalize a UOM string for comparison — trims and uppercases so
    // "btl" / "Btl" / "BTL " all compare equal.
    function normalizeUom(str) {
        return String(str || '').trim().toUpperCase();
    }

    // ============================================================
    // Find the document that actually contains the RIGHT ag-grid.
    // IMPORTANT: this page can have more than one ag-grid instance at once
    // (e.g. a small item-search grid sharing the same generic id="myGrid"
    // alongside the real Order Sheet grid). We can't just grab the first
    // .ag-root we find — we specifically require a "Quantity" column header,
    // since that's what distinguishes the real Order Sheet grid from any
    // other grid-like widget on the page.
    // ============================================================
    let gridDoc = null;

    function docHasGrid(doc) {
        try {
            return !!doc.querySelector('.ag-root, #myGrid, .ag-center-cols-container');
        } catch (e) {
            return false;
        }
    }

    function docHasQuantityColumn(doc) {
        try {
            const headerTexts = Array.from(doc.querySelectorAll('.ag-header-cell-text'));
            return headerTexts.some(span => CONFIG.QTY_HEADER_TEXT.test(span.textContent.trim()));
        } catch (e) {
            return false;
        }
    }

    // Collects every document on the page (main + same-origin iframes, recursively)
    // that contains an ag-grid, so we can pick the best one rather than the first one.
    function collectGridDocuments(doc, visited, results) {
        if (!doc || visited.has(doc)) return;
        visited.add(doc);

        if (docHasGrid(doc)) results.push(doc);

        let frames = [];
        try {
            frames = Array.from(doc.querySelectorAll('iframe, frame'));
        } catch (e) {
            return;
        }

        for (const frameEl of frames) {
            let innerDoc = null;
            try {
                innerDoc = frameEl.contentDocument || (frameEl.contentWindow && frameEl.contentWindow.document);
            } catch (e) {
                continue; // cross-origin — can't access, skip
            }
            collectGridDocuments(innerDoc, visited, results);
        }
    }

    function ensureGridDoc() {
        // Reuse the cached doc if it's still valid AND still has the Quantity column
        if (gridDoc && docHasGrid(gridDoc) && docHasQuantityColumn(gridDoc)) return gridDoc;

        const candidates = [];
        collectGridDocuments(document, new Set(), candidates);

        if (candidates.length === 0) {
            gridDoc = null;
            log('Could not locate any ag-grid (checked main page and same-origin iframes).', 'err');
            return null;
        }

        // Prefer a candidate that actually has the Quantity column — that's the real Order Sheet.
        const best = candidates.find(docHasQuantityColumn) || candidates[0];

        if (best !== gridDoc) {
            if (!docHasQuantityColumn(best)) {
                log(`Found ${candidates.length} grid(s) on the page, but none has a "Quantity" column — using the first one, results may be wrong.`, 'warn');
            } else if (candidates.length > 1) {
                log(`Found ${candidates.length} grid(s) on the page — using the one with a "Quantity" column (the Order Sheet).`, 'ok');
            } else {
                log(best === document ? 'Grid found in the main page.' : 'Grid found inside an iframe — operating there.', 'ok');
            }
        }
        gridDoc = best;
        return gridDoc;
    }

    // ============================================================
    // Dynamic column detection (col-ids can differ per session/report)
    // ============================================================
    let resolvedSkuColId = null;
    let resolvedQtyColId = null;
    let resolvedUomColId = null;

    function findColIdByHeaderText(doc, regex) {
        const headerTexts = Array.from(doc.querySelectorAll('.ag-header-cell-text'));
        for (const span of headerTexts) {
            if (regex.test(span.textContent.trim())) {
                const headerCell = span.closest('.ag-header-cell');
                if (headerCell) return headerCell.getAttribute('col-id');
            }
        }
        return null;
    }

    function resolveColumnIds() {
        const doc = ensureGridDoc();
        if (!doc) {
            resolvedSkuColId = resolvedSkuColId || CONFIG.SKU_COL_ID_FALLBACK;
            resolvedQtyColId = resolvedQtyColId || CONFIG.QTY_COL_ID_FALLBACK;
            resolvedUomColId = resolvedUomColId || CONFIG.UOM_COL_ID_FALLBACK;
            return { skuColId: resolvedSkuColId, qtyColId: resolvedQtyColId, uomColId: resolvedUomColId };
        }

        const foundSku = findColIdByHeaderText(doc, CONFIG.SKU_HEADER_TEXT);
        const foundQty = findColIdByHeaderText(doc, CONFIG.QTY_HEADER_TEXT);
        const foundUom = findColIdByHeaderText(doc, CONFIG.UOM_HEADER_TEXT);

        if (foundSku) {
            if (foundSku !== resolvedSkuColId) log(`Detected Part # column (col-id="${foundSku}").`, 'ok');
            resolvedSkuColId = foundSku;
        } else if (!resolvedSkuColId) {
            log(`Could not detect the Part # column by header text — falling back to col-id="${CONFIG.SKU_COL_ID_FALLBACK}".`, 'warn');
            resolvedSkuColId = CONFIG.SKU_COL_ID_FALLBACK;
        }

        if (foundQty) {
            if (foundQty !== resolvedQtyColId) log(`Detected Quantity column (col-id="${foundQty}").`, 'ok');
            resolvedQtyColId = foundQty;
        } else if (!resolvedQtyColId) {
            log(`Could not detect the Quantity column by header text — falling back to col-id="${CONFIG.QTY_COL_ID_FALLBACK}".`, 'warn');
            resolvedQtyColId = CONFIG.QTY_COL_ID_FALLBACK;
        }

        if (foundUom) {
            if (foundUom !== resolvedUomColId) log(`Detected Req UOM column (col-id="${foundUom}").`, 'ok');
            resolvedUomColId = foundUom;
        } else if (!resolvedUomColId) {
            log(`Could not detect the Req UOM column by header text — falling back to col-id="${CONFIG.UOM_COL_ID_FALLBACK}".`, 'warn');
            resolvedUomColId = CONFIG.UOM_COL_ID_FALLBACK;
        }

        return { skuColId: resolvedSkuColId, qtyColId: resolvedQtyColId, uomColId: resolvedUomColId };
    }

    // ============================================================
    // Parsing pasted data (tab-separated, or Excel-style multi-space)
    // Expected columns: SKU, Description, Qty, UOM
    // ============================================================
    function parseInput(raw) {
        const lines = raw.split('\n');
        const rows = [];
        for (const rawLine of lines) {
            const line = rawLine.trim();
            if (!line) continue;

            let cols = line.split('\t').map(c => c.trim());
            if (cols.length < 4) {
                cols = line.split(/\s{2,}/).map(c => c.trim());
            }
            if (cols.length < 4) continue;

            const skuRaw = cols[0].trim();
            const descRaw = (cols[1] || '').trim();
            const qtyRaw = cols[2].trim();
            const uomRaw = (cols[3] || '').trim();

            if (/^item\s*sku$/i.test(skuRaw)) continue; // skip header row
            const sku = normalizeSku(skuRaw);
            if (!sku) continue;

            const qtyNum = parseFloat(qtyRaw.replace(/,/g, ''));
            if (isNaN(qtyNum)) continue;

            rows.push({ sku, qty: qtyNum, description: descRaw, uom: normalizeUom(uomRaw) });
        }
        return rows;
    }

    // ============================================================
    // Optional convenience: auto-open the Part# filter popup
    // ============================================================
    function findVisibleFilterInput() {
        const doc = ensureGridDoc();
        if (!doc) return null;
        const candidates = Array.from(doc.querySelectorAll(CONFIG.FILTER_INPUT_SELECTOR));
        return candidates.find(el =>
            isVisible(el) &&
            (!CONFIG.FILTER_INPUT_PLACEHOLDER || el.placeholder === CONFIG.FILTER_INPUT_PLACEHOLDER)
        );
    }

    // One open attempt: click the menu icon, then only if the filter input still isn't
    // visible do we go looking for a separate "Filter" tab to click — scoped to the
    // popup that's actually open right now, so we never click something unrelated that
    // could itself be the thing closing the popup.
    async function attemptOpenFilterMenu(doc, header) {
        const menuBtn = header.querySelector('[ref="eMenu"], .ag-header-cell-menu-button');
        if (!menuBtn) {
            log('Could not find the filter/menu icon on the Part # header.', 'warn');
            return false;
        }

        dispatchRealisticClick(menuBtn);
        await sleep(CONFIG.FILTER_OPEN_CHECK_DELAY_MS);

        if (findVisibleFilterInput()) return true;

        const openPopup = doc.querySelector('.ag-popup:not(.ag-hidden) .ag-menu, .ag-popup .ag-menu');
        if (openPopup) {
            const filterTabIcon = openPopup.querySelector('.ag-tab-selector .ag-icon-filter, .ag-menu-header .ag-icon-filter, [aria-label="Filter"]');
            if (filterTabIcon) {
                const clickable = filterTabIcon.closest('span, button, div');
                if (clickable) {
                    dispatchRealisticClick(clickable);
                    await sleep(200);
                    if (findVisibleFilterInput()) return true;
                }
            }
        }

        return false;
    }

    async function openPartNumberFilter() {
        const doc = ensureGridDoc();
        if (!doc) return false;

        const { skuColId } = resolveColumnIds();
        const header = doc.querySelector(`.ag-header-cell[col-id="${skuColId}"]`);
        if (!header) {
            log('Could not find the Part # column header.', 'err');
            return false;
        }

        for (let attempt = 1; attempt <= CONFIG.FILTER_OPEN_RETRY_ATTEMPTS; attempt++) {
            const opened = await attemptOpenFilterMenu(doc, header);
            if (opened) {
                log('Part # filter panel is open.', 'ok');
                return true;
            }
            if (attempt < CONFIG.FILTER_OPEN_RETRY_ATTEMPTS) {
                log(`Filter popup closed before it could be used (attempt ${attempt}/${CONFIG.FILTER_OPEN_RETRY_ATTEMPTS}) — retrying...`, 'warn');
                await sleep(CONFIG.FILTER_OPEN_RETRY_DELAY_MS);
            }
        }

        log('The filter popup isn\'t staying open on its own — open it manually with a real click, then click Generate.', 'warn');
        return false;
    }

    // ============================================================
    // Step 1: Fill the ag-grid filter input with comma-joined SKUs
    // ============================================================
    function findVisibleApplyButton() {
        const doc = ensureGridDoc();
        if (!doc) return null;
        // NOTE: the filter popup has both "Clear Filter" and "Apply Filter" buttons
        // sharing the exact same CSS classes, so we must match by text, not just class/order.
        const candidates = Array.from(doc.querySelectorAll(CONFIG.APPLY_BUTTON_SELECTOR));
        let btn = candidates.find(el => isVisible(el) && /^apply filter$/i.test(el.textContent.trim()));
        if (!btn) {
            btn = Array.from(doc.querySelectorAll('button')).find(
                b => isVisible(b) && /apply filter/i.test(b.textContent)
            );
        }
        return btn;
    }

    async function fillFilterAndApply(skuList) {
        let input = findVisibleFilterInput();

        if (!input) {
            log('Filter input not visible yet — trying to auto-open the Part # filter...', 'warn');
            await openPartNumberFilter();
            input = findVisibleFilterInput();
        }

        if (!input) {
            log('Still could not find the filter input. Open the Part # column filter manually, then click Generate again.', 'err');
            return false;
        }

        const joined = skuList.join(',');
        setNativeValue(input, joined);
        log(`Filter input filled with ${skuList.length} SKUs.`, 'ok');

        await sleep(100);

        const applyBtn = findVisibleApplyButton();
        if (!applyBtn) {
            log('Could not find the Apply Filter button.', 'err');
            return false;
        }
        clickEl(applyBtn);
        log('Clicked Apply Filter.', 'ok');
        return true;
    }

    // ============================================================
    // Step 2: Walk filtered rows and fill in quantities, top-to-bottom.
    // Confirmed behavior from a real recording: a single click on the
    // quantity cell swaps it to <input id="QUANTITY{row-index}">, and
    // clicking elsewhere commits the value.
    // ============================================================

    // IMPORTANT: ag-grid recycles row DOM nodes for virtual scrolling, so the
    // order nodes appear in the container's child list does NOT reliably match
    // their visual top-to-bottom row-index order. We must sort by row-index
    // ourselves to guarantee first-row-to-last-row processing.
    function getGridRows() {
        const doc = ensureGridDoc();
        if (!doc) return [];
        const container = doc.querySelector(CONFIG.ROW_CONTAINER_SELECTOR);
        if (!container) return [];
        const rows = Array.from(container.querySelectorAll(`:scope > ${CONFIG.ROW_SELECTOR}`));
        rows.sort((a, b) => {
            const ai = parseInt(a.getAttribute('row-index'), 10);
            const bi = parseInt(b.getAttribute('row-index'), 10);
            return (isNaN(ai) ? 0 : ai) - (isNaN(bi) ? 0 : bi);
        });
        return rows;
    }

    function getSkuFromRow(row) {
        const cell = row.querySelector(`${CONFIG.CELL_SELECTOR}[col-id="${resolvedSkuColId}"]`);
        if (!cell) return null;
        return normalizeSku(cell.textContent);
    }

    function getQtyCellFromRow(row) {
        return row.querySelector(`${CONFIG.CELL_SELECTOR}[col-id="${resolvedQtyColId}"]`);
    }

    function getUomCellFromRow(row) {
        return row.querySelector(`${CONFIG.CELL_SELECTOR}[col-id="${resolvedUomColId}"]`);
    }

    // Reads the grid's current Req UOM for a row (ignoring any flag/marker we previously
    // added ourselves) and compares it against the pasted UOM.
    function readUomMismatch(row, pastedUom) {
        if (!pastedUom) return { mismatch: false, gridUom: '' };
        const cell = getUomCellFromRow(row);
        if (!cell) return { mismatch: false, gridUom: '' };

        const existingMarker = cell.querySelector('.reqFillerUomFlag, .reqFillerUomCorrected');
        const baseText = existingMarker
            ? cell.textContent.replace(existingMarker.textContent, '').trim()
            : cell.textContent.trim();
        const gridUom = normalizeUom(baseText);

        return { mismatch: gridUom !== pastedUom, gridUom };
    }

    // Removes any previously-added flag/marker (used when a re-run finds the mismatch
    // no longer applies).
    function clearUomMarkers(row) {
        const cell = getUomCellFromRow(row);
        if (!cell) return;
        const marker = cell.querySelector('.reqFillerUomFlag, .reqFillerUomCorrected');
        if (!marker) return;
        if (marker.classList.contains('reqFillerUomCorrected')) {
            cell.textContent = marker.textContent;
        } else {
            marker.remove();
        }
    }

    // corrected=true: we successfully changed the grid's Req UOM to match the pasted one —
    //   show the (now-matching) value in red as a "this was auto-corrected" confirmation.
    // corrected=false: couldn't correct it — append the pasted UOM in red next to the
    //   grid's existing value, same as the original mismatch flag.
    // IMPORTANT: `row` must be a *currently attached* row element — ag-grid recycles row
    // DOM nodes whenever the grid refreshes (which a UOM change can trigger even when it
    // fails partway through), so writing into a stale/detached node is a silent no-op.
    // Callers must re-locate the row by SKU right before calling this if a dialog was
    // opened in between.
    function markUomResult(row, pastedUom, corrected) {
        const cell = getUomCellFromRow(row);
        if (!cell) return;

        const oldMarker = cell.querySelector('.reqFillerUomFlag, .reqFillerUomCorrected');
        if (oldMarker) oldMarker.remove();

        const marker = cell.ownerDocument.createElement('span');
        marker.style.color = corrected ? '#50fa7b' : CONFIG.UOM_MISMATCH_COLOR;
        marker.style.fontWeight = '700';

        if (corrected) {
            marker.className = 'reqFillerUomCorrected';
            marker.textContent = cell.textContent.trim();
            cell.textContent = '';
            cell.appendChild(marker);
        } else {
            marker.className = 'reqFillerUomFlag';
            marker.textContent = ' ' + pastedUom;
            cell.appendChild(marker);
        }
    }

    // ============================================================
    // Req UOM auto-correction via the UOM picker ("zoom") dialog
    // ============================================================

    // Clicks the Req UOM cell to enter edit mode, then returns its zoom/search button
    // (the input itself is disabled — only the button opens the picker). Retries the
    // click a few times, since a single plain click can land before the cell has
    // finished swapping into its editor and never produce a zoom button at all.
    // Uses a plain click (not dispatchRealisticClick) — the fuller event sequence was
    // found to make this cell's editor toggle straight back closed on some attempts.
    async function enterUomEditMode(doc, row, rowIndex) {
        const uomCell = getUomCellFromRow(row);
        if (!uomCell) return null;

        uomCell.scrollIntoView({ block: 'center', behavior: 'instant' });
        await sleep(80);

        const before = new Set(doc.querySelectorAll('button'));
        let zoomBtn = null;

        for (let attempt = 1; attempt <= CONFIG.FILTER_OPEN_RETRY_ATTEMPTS; attempt++) {
            clickEl(uomCell);
            await sleep(CONFIG.CELL_EDIT_DELAY_MS);

            zoomBtn = rowIndex !== null
                ? doc.getElementById(`${CONFIG.UOM_INPUT_ID_PREFIX}${rowIndex}${CONFIG.UOM_ZOOM_BTN_ID_SUFFIX}`)
                : null;

            if (!zoomBtn) {
                zoomBtn = uomCell.querySelector('button');
            }
            if (!zoomBtn) {
                const after = Array.from(doc.querySelectorAll('button'));
                zoomBtn = after.find(b => !before.has(b) && isVisible(b));
            }

            if (zoomBtn && isVisible(zoomBtn)) break;
            zoomBtn = null;
            if (attempt < CONFIG.FILTER_OPEN_RETRY_ATTEMPTS) await sleep(CONFIG.FILTER_OPEN_RETRY_DELAY_MS);
        }

        return zoomBtn;
    }

    // jQuery UI dialogs are commonly appended to the top-level document body rather than
    // wherever they were triggered from, so we check both the grid's own document and the
    // top window's document (when reachable) for open ".ui-dialog[role=dialog]" elements.
    function collectDialogs(doc) {
        let dialogs = [];
        try {
            dialogs = dialogs.concat(Array.from(doc.querySelectorAll('.ui-dialog[role="dialog"]')));
        } catch (e) { /* ignore */ }
        try {
            const topDoc = doc.defaultView && doc.defaultView.top && doc.defaultView.top.document;
            if (topDoc && topDoc !== doc) {
                dialogs = dialogs.concat(Array.from(topDoc.querySelectorAll('.ui-dialog[role="dialog"]')));
            }
        } catch (e) { /* cross-origin top, ignore */ }
        return dialogs;
    }

    // Opens the UOM picker dialog and waits until a genuinely new dialog is not just
    // visible but has picker rows actually loaded — the dialog element can appear
    // before its own ag-grid finishes populating (or get torn down and rebuilt once
    // the real data arrives), so grabbing it too early leaves pickUomInDialog looking
    // at an empty grid and wrongly reporting the UOM as "not offered". Requires the
    // same populated dialog to show up on two consecutive polls before trusting it,
    // and retries the whole click if nothing ever stabilizes within the wait budget.
    async function openReqUomDialog(doc, zoomBtn) {
        for (let attempt = 1; attempt <= CONFIG.UOM_DIALOG_OPEN_RETRY_ATTEMPTS; attempt++) {
            const beforeDialogs = new Set(collectDialogs(doc));
            clickEl(zoomBtn);

            let lastCandidate = null;
            let stableHits = 0;

            for (let i = 0; i < CONFIG.UOM_DIALOG_WAIT_ATTEMPTS; i++) {
                await sleep(CONFIG.UOM_DIALOG_POLL_MS);

                const dialogs = collectDialogs(doc);
                const candidate = dialogs.find(d => !beforeDialogs.has(d) && isVisible(d) && getDialogRows(d).length > 0);

                if (candidate && candidate === lastCandidate) {
                    stableHits++;
                    if (stableHits >= 2) return candidate;
                } else if (candidate) {
                    lastCandidate = candidate;
                    stableHits = 1;
                } else {
                    lastCandidate = null;
                    stableHits = 0;
                }
            }

            if (attempt < CONFIG.UOM_DIALOG_OPEN_RETRY_ATTEMPTS) await sleep(CONFIG.FILTER_OPEN_RETRY_DELAY_MS);
        }
        return null;
    }

    // The picker's own ag-grid has several UOM-ish columns (Inventory UOM, Default Inv UOM,
    // Default REQ UOM, Order UOM...) — we specifically want the plain "UOM" column.
    function findDialogUomColId(dialog) {
        const headerTexts = Array.from(dialog.querySelectorAll('.ag-header-cell-text'));
        for (const span of headerTexts) {
            if (CONFIG.UOM_PICKER_HEADER_TEXT.test(span.textContent.trim())) {
                const headerCell = span.closest('.ag-header-cell');
                if (headerCell) return headerCell.getAttribute('col-id');
            }
        }
        return null;
    }

    function getDialogRows(dialog) {
        const container = dialog.querySelector('.ag-center-cols-container');
        if (!container) return [];
        return Array.from(container.querySelectorAll(':scope > .ag-row'));
    }

    // Clicks the target row's UOM cell in the picker and confirms ag-grid actually
    // registered the selection (the row gets "ag-row-selected", same as a real click
    // does) before hitting Select. A plain click() here was the core bug: it fired a
    // 'click' event but never the mousedown/mouseup pair ag-grid's selection listens
    // for, so nothing got selected and Select had nothing to apply.
    async function pickUomInDialog(dialog, desiredUom) {
        const colId = findDialogUomColId(dialog);
        if (!colId) return { ok: false, reason: 'UOM column not found in picker' };

        // Poll for the matching row rather than a single-shot check — openReqUomDialog
        // already waits for rows to exist, but rows can still be trickling in (e.g. the
        // desired UOM's row loads a beat after the first one), so give it a bit more room.
        let target = null;
        for (let attempt = 0; attempt < CONFIG.UOM_DIALOG_WAIT_ATTEMPTS; attempt++) {
            const rows = getDialogRows(dialog);
            target = rows.find(r => {
                const cell = r.querySelector(`.ag-cell[col-id="${colId}"]`);
                return cell && normalizeUom(cell.textContent) === desiredUom;
            });
            if (target) break;
            await sleep(CONFIG.UOM_DIALOG_POLL_MS);
        }
        if (!target) return { ok: false, reason: `"${desiredUom}" not offered in the picker list` };

        const targetCell = target.querySelector(`.ag-cell[col-id="${colId}"]`) || target;

        let rowSelected = false;
        for (let attempt = 1; attempt <= CONFIG.UOM_ROW_SELECT_RETRY_ATTEMPTS; attempt++) {
            dispatchRealisticClick(targetCell);
            await sleep(CONFIG.UOM_ROW_SELECT_CHECK_DELAY_MS);
            if (target.classList.contains('ag-row-selected')) {
                rowSelected = true;
                break;
            }
        }
        if (!rowSelected) {
            return { ok: false, reason: `couldn't select "${desiredUom}" row in the picker` };
        }

        const selectBtn = Array.from(dialog.querySelectorAll('.ui-dialog-buttonpane button'))
            .find(b => isVisible(b) && CONFIG.UOM_PICKER_SELECT_BUTTON_TEXT.test(b.textContent.trim()));
        if (!selectBtn) return { ok: false, reason: 'Select button not found in picker' };

        dispatchRealisticClick(selectBtn);
        return { ok: true };
    }

    function closeDialogIfOpen(dialog) {
        if (!dialog || !isVisible(dialog)) return;
        const closeBtn = dialog.querySelector('.ui-dialog-titlebar-close')
            || Array.from(dialog.querySelectorAll('.ui-dialog-buttonpane button')).find(b => CONFIG.UOM_PICKER_CLOSE_BUTTON_TEXT.test(b.textContent.trim()));
        if (closeBtn) dispatchRealisticClick(closeBtn);
    }

    // Full flow: open the cell editor -> click the zoom button -> wait for the picker
    // dialog -> click the matching UOM row -> click Select -> wait for the dialog to
    // close and the grid to settle (changing Req UOM can trigger a grid refresh) ->
    // re-read the grid's actual Req UOM and confirm it matches what we picked, instead
    // of trusting the click sequence succeeded just because no error was thrown.
    async function correctReqUom(doc, row, desiredUom) {
        const rowIndex = row.getAttribute('row-index');
        const sku = getSkuFromRow(row);

        const zoomBtn = await enterUomEditMode(doc, row, rowIndex);
        if (!zoomBtn) return { ok: false, reason: 'zoom (search) button not found on Req UOM cell' };

        const dialog = await openReqUomDialog(doc, zoomBtn);
        if (!dialog) return { ok: false, reason: 'UOM picker dialog did not open' };

        const pickResult = await pickUomInDialog(dialog, desiredUom);
        if (!pickResult.ok) {
            closeDialogIfOpen(dialog);
            return pickResult;
        }

        for (let i = 0; i < CONFIG.UOM_DIALOG_WAIT_ATTEMPTS; i++) {
            await sleep(CONFIG.UOM_DIALOG_POLL_MS);
            if (!isVisible(dialog)) break;
        }

        // The grid can refresh/re-render after a UOM change — give it time to settle
        // before re-locating the row and reading it back.
        await sleep(CONFIG.UOM_POST_SELECT_DELAY_MS);

        const freshRows = getGridRows();
        const relocated = sku ? freshRows.find(r => getSkuFromRow(r) === sku) : null;
        const checkRow = relocated || row;
        const { gridUom } = readUomMismatch(checkRow, desiredUom);

        if (gridUom !== desiredUom) {
            return { ok: false, reason: `Req UOM still reads "${gridUom}" after selecting "${desiredUom}"` };
        }

        return { ok: true };
    }

    async function editRowQuantity(row, valueStr) {
        const doc = ensureGridDoc();
        if (!doc) return { ok: false, reason: 'grid document lost' };

        const qtyCell = getQtyCellFromRow(row);
        if (!qtyCell) return { ok: false, reason: 'qty cell not found' };

        const rowIndex = row.getAttribute('row-index');

        // Scroll the row into view so ag-grid doesn't virtualize it away while we edit
        qtyCell.scrollIntoView({ block: 'center', behavior: 'instant' });
        await sleep(80);

        // Snapshot inputs already present, to support a fallback diff if the ID pattern doesn't match
        const before = new Set(doc.querySelectorAll('input, textarea'));

        clickEl(qtyCell);
        await sleep(CONFIG.CELL_EDIT_DELAY_MS);

        // 1) Primary: the confirmed #QUANTITY{row-index} pattern
        let editorInput = rowIndex !== null
            ? doc.getElementById(`${CONFIG.QTY_INPUT_ID_PREFIX}${rowIndex}`)
            : null;

        // 2) Fallback: an input/textarea inside the qty cell itself
        if (!editorInput) {
            editorInput = qtyCell.querySelector('input, textarea');
        }

        // 3) Fallback: any input whose id starts with the QUANTITY prefix, newly appeared
        if (!editorInput) {
            const after = Array.from(doc.querySelectorAll(`input[id^="${CONFIG.QTY_INPUT_ID_PREFIX}"], textarea[id^="${CONFIG.QTY_INPUT_ID_PREFIX}"]`));
            editorInput = after.find(el => !before.has(el) && isVisible(el));
        }

        // 4) Last resort: any newly appeared visible input anywhere in the grid document
        if (!editorInput) {
            const after = Array.from(doc.querySelectorAll('input, textarea'));
            editorInput = after.find(el => !before.has(el) && isVisible(el));
        }

        if (!editorInput) {
            return { ok: false, reason: 'no editor input appeared' };
        }

        setNativeValue(editorInput, valueStr);
        await sleep(80);

        // Commit by clicking elsewhere in the same row (matches the recorded "click next cell" pattern)
        const skuCell = getSkuFromRow(row) !== null ? row.querySelector(`${CONFIG.CELL_SELECTOR}[col-id="${resolvedSkuColId}"]`) : null;
        if (skuCell) {
            clickEl(skuCell);
        } else {
            editorInput.dispatchEvent(new Event('blur', { bubbles: true }));
        }

        return { ok: true };
    }

    // Process all currently visible rows in strict top-to-bottom (row-index) order,
    // skipping SKUs already handled in previous scrolls.
    // Returns the SKUs that were successfully filled and those that matched but failed.
    async function fillQuantities(dataMap, alreadyFilledSkus = new Set()) {
        const doc = ensureGridDoc();
        const rows = getGridRows(); // already sorted top-to-bottom by row-index

        if (!doc || rows.length === 0) {
            return { filledSkus: new Set(), foundButFailedSkus: new Set(), newRowsFound: false };
        }

        let filled = 0;
        let unmatched = 0;
        let skipped = 0;
        const filledSkus = new Set();
        const foundButFailedSkus = new Set();
        let atLeastOneNewRow = false;

        for (const row of rows) {
            const sku = getSkuFromRow(row);
            if (!sku) {
                unmatched++;
                continue;
            }

            if (alreadyFilledSkus.has(sku)) {
                skipped++;
                continue;
            }

            atLeastOneNewRow = true;

            if (!(sku in dataMap)) {
                unmatched++;
                continue;
            }

            const item = dataMap[sku];
            let workingRow = row;

            const uomCheck = readUomMismatch(workingRow, item.uom);
            if (uomCheck.mismatch) {
                if (CONFIG.UOM_CORRECTION_ENABLED) {
                    log(`SKU ${sku}: Req UOM is "${uomCheck.gridUom}", pasted "${item.uom}" — attempting to correct...`, 'warn');

                    let correction;
                    try {
                        correction = await correctReqUom(doc, workingRow, item.uom);
                    } catch (err) {
                        correction = { ok: false, reason: `unexpected error (${err && err.message ? err.message : err})` };
                    }

                    // Re-locate the row before marking either way — a dialog open/close
                    // can refresh the grid and recycle the DOM node `workingRow` points
                    // to, and writing a marker into a detached node is a silent no-op.
                    const freshRows = getGridRows();
                    const relocated = freshRows.find(r => getSkuFromRow(r) === sku);
                    if (relocated) workingRow = relocated;

                    if (correction.ok) {
                        markUomResult(workingRow, item.uom, true);
                        log(`SKU ${sku}: Req UOM corrected to "${item.uom}".`, 'ok');
                    } else {
                        markUomResult(workingRow, item.uom, false);
                        log(`SKU ${sku}: couldn't auto-correct Req UOM (${correction.reason}) — flagged in red instead.`, 'warn');
                    }
                } else {
                    markUomResult(workingRow, item.uom, false);
                }
            } else {
                clearUomMarkers(workingRow);
            }

            const qtyStr = CONFIG.formatQty(item.qty);
            const result = await editRowQuantity(workingRow, qtyStr);

            if (result.ok) {
                filled++;
                filledSkus.add(sku);
                log(`SKU ${sku} -> qty ${qtyStr}`, 'ok');
            } else {
                foundButFailedSkus.add(sku);
                log(`SKU ${sku} matched but couldn't fill qty (${result.reason}).`, 'warn');
            }

            await sleep(CONFIG.ROW_PROCESS_DELAY_MS);
        }

        if (filled > 0) {
            log(`Batch: filled ${filled}, skipped ${skipped}, unmatched ${unmatched}.`, 'ok');
        }

        return { filledSkus, foundButFailedSkus, newRowsFound: atLeastOneNewRow };
    }

    // ============================================================
    // SCROLLING: keep scrolling the ag-grid viewport until we reach
    // the bottom or every SKU has been filled.
    // ============================================================
    function getGridViewport() {
        const doc = ensureGridDoc();
        if (!doc) return null;
        // ag-grid classic DOM: the viewport is usually .ag-body-viewport
        let vp = doc.querySelector(CONFIG.GRID_VIEWPORT_SELECTOR);
        if (!vp) {
            // Fallback: the scrollable parent of the row container
            const container = doc.querySelector(CONFIG.ROW_CONTAINER_SELECTOR);
            if (container) vp = container.closest('.ag-body-viewport, .ag-center-cols-viewport, .ag-body-horizontal-scroll-viewport') || container.parentElement;
        }
        return vp;
    }

    async function scrollGridDown() {
        const vp = getGridViewport();
        if (!vp) return { didScroll: false, scrollTop: 0, scrollHeight: 0, clientHeight: 0 };

        const before = vp.scrollTop;
        vp.scrollTop += CONFIG.SCROLL_AMOUNT_PX;
        await sleep(CONFIG.SCROLL_RENDER_DELAY_MS);

        const after = vp.scrollTop;
        const atBottom = (vp.scrollTop + vp.clientHeight) >= (vp.scrollHeight - 5); // 5px tolerance

        return {
            didScroll: after !== before,
            scrollTop: after,
            scrollHeight: vp.scrollHeight,
            clientHeight: vp.clientHeight,
            atBottom
        };
    }

    function describeSku(sku, dataMap) {
        const desc = dataMap[sku] && dataMap[sku].description;
        return desc ? `${sku} (${desc})` : sku;
    }

    function reportMissingSkus(dataMap, filledSkus, foundButFailedSkus) {
        const allSkus = Object.keys(dataMap);
        const neverFound = allSkus.filter(s => !filledSkus.has(s) && !foundButFailedSkus.has(s));
        const failedEdit = allSkus.filter(s => foundButFailedSkus.has(s));
        const missing = [...neverFound, ...failedEdit];

        if (missing.length === 0) {
            log(`All ${allSkus.length} pasted item(s) were filled successfully.`, 'ok');
            return;
        }

        const lines = [];
        if (neverFound.length > 0) {
            lines.push(`Not found in the filtered grid (${neverFound.length}):`);
            neverFound.forEach(s => lines.push('  • ' + describeSku(s, dataMap)));
        }
        if (failedEdit.length > 0) {
            lines.push(`Found but quantity couldn't be entered (${failedEdit.length}):`);
            failedEdit.forEach(s => lines.push('  • ' + describeSku(s, dataMap)));
        }

        log(`${missing.length} of ${allSkus.length} pasted item(s) were NOT filled — see below.`, 'err');
        missing.forEach(s => log('Missing: ' + describeSku(s, dataMap), 'err'));

        alert(`${missing.length} item(s) were NOT filled in:\n\n${lines.join('\n')}`);
    }

    // ============================================================
    // Main run
    // ============================================================
    document.getElementById('reqFillerGenerate').addEventListener('click', async () => {
        clearLog();
        gridDoc = null; // force a fresh search each run, in case the frame reloaded

        const raw = document.getElementById('reqFillerInput').value;
        const parsed = parseInput(raw);

        if (parsed.length === 0) {
            log('No valid rows parsed. Check that you pasted SKU / Desc / Qty / UOM rows (tab- or multi-space-separated).', 'err');
            return;
        }

        log(`Parsed ${parsed.length} row(s).`, 'ok');

        if (!ensureGridDoc()) return;
        resolveColumnIds();

        const dataMap = {};
        const skuList = [];
        for (const r of parsed) {
            dataMap[r.sku] = { qty: r.qty, description: r.description, uom: r.uom };
            skuList.push(r.sku);
        }

        log('Opening the Part # filter...');
        await openPartNumberFilter();

        const filterOk = await fillFilterAndApply(skuList);
        if (!filterOk) return;

        log(`Waiting ${CONFIG.FILTER_APPLY_DELAY_MS}ms for the grid to refresh...`);
        await sleep(CONFIG.FILTER_APPLY_DELAY_MS);

        // ========================================================
        // SCROLL & FILL LOOP (each batch processes rows top-to-bottom)
        // ========================================================
        const totalFilledSkus = new Set();
        const totalFailedSkus = new Set();
        let iterations = 0;
        let stagnantIterations = 0;

        while (iterations < CONFIG.MAX_SCROLL_ITERATIONS) {
            iterations++;

            const { filledSkus, foundButFailedSkus, newRowsFound } = await fillQuantities(dataMap, totalFilledSkus);

            filledSkus.forEach(s => totalFilledSkus.add(s));
            foundButFailedSkus.forEach(s => totalFailedSkus.add(s));

            const remaining = skuList.filter(s => !totalFilledSkus.has(s) && !totalFailedSkus.has(s));
            if (remaining.length === 0) {
                log('All SKUs have been processed.', 'ok');
                break;
            }

            // Try to scroll down and load more virtual rows
            const scrollResult = await scrollGridDown();

            if (!scrollResult.didScroll && scrollResult.atBottom) {
                log('Reached the bottom of the grid.', 'ok');
                break;
            }

            if (!newRowsFound && !scrollResult.didScroll) {
                stagnantIterations++;
                if (stagnantIterations >= 3) {
                    log('No new rows appearing after multiple scroll attempts — stopping.', 'warn');
                    break;
                }
            } else {
                stagnantIterations = 0;
            }

            log(`Scrolled down (${iterations}). Remaining SKUs: ${remaining.length}.`);
        }

        if (iterations >= CONFIG.MAX_SCROLL_ITERATIONS) {
            log('Stopped: reached maximum scroll iterations.', 'warn');
        }

        reportMissingSkus(dataMap, totalFilledSkus, totalFailedSkus);
    });

    console.log('[REQ SKU/Qty Filler v2.2] loaded.');
})();