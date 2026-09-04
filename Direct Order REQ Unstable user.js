// ==UserScript==
// @name         REQ SKU/Qty Auto-Filler
// @namespace    roni2026.birchstreet.tools
// @version      1.5
// @description  Paste SKU + Qty rows, auto-filter the Order Sheet grid by SKU (Part #), auto-fill quantities into matching rows, and alert on any pasted item that didn't get filled
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

        // Confirmed from a real recorded session: clicking a quantity cell swaps it to
        // <input id="QUANTITY{row-index}">, e.g. #QUANTITY0, #QUANTITY1, ...
        QTY_INPUT_ID_PREFIX: 'QUANTITY',

        // Delay after clicking Apply Filter before we start filling quantities (ms)
        FILTER_APPLY_DELAY_MS: 800,

        // Delay after clicking a qty cell before we look for its input (ms)
        CELL_EDIT_DELAY_MS: 200,

        // Delay between processing each row (ms)
        ROW_PROCESS_DELAY_MS: 150,

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
            <textarea id="reqFillerInput" placeholder="Paste rows here, e.g.&#10;32746&#9;FRUIT - AMBARELLA&#9;KG&#9; 6.000 &#10;16308&#9;FRUIT - PINEAPPLE&#9;KG&#9; 40.000 "></textarea>
            <div class="reqFillerBtnRow">
                <button id="reqFillerOpenFilter">Open Part# Filter</button>
                <button id="reqFillerClear">Clear</button>
            </div>
            <div class="reqFillerBtnRow">
                <button id="reqFillerGenerate" style="flex:2;">Generate</button>
            </div>
            <div id="reqFillerStatus">Paste your data. Optionally click "Open Part# Filter" first, then click Generate.</div>
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
        // mousedown/mouseup/click as separate synthetic events. The manual
        // 3-event sequence was observed to make the Part# filter popup open
        // and instantly close again (likely a toggle bound to mousedown that
        // then also reacts to the separate synthetic click). Native .click()
        // fires a single real click the way a physical click does.
        el.focus({ preventScroll: true });
        el.click();
    }

    // Normalize a SKU string for comparison — strips leading zeros so
    // "32746" matches the grid's "000000000032746"
    function normalizeSku(str) {
        const digits = String(str).trim().replace(/\D/g, '');
        if (!digits) return '';
        return String(parseInt(digits, 10));
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
            return { skuColId: resolvedSkuColId, qtyColId: resolvedQtyColId };
        }

        const foundSku = findColIdByHeaderText(doc, CONFIG.SKU_HEADER_TEXT);
        const foundQty = findColIdByHeaderText(doc, CONFIG.QTY_HEADER_TEXT);

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

        return { skuColId: resolvedSkuColId, qtyColId: resolvedQtyColId };
    }

    // ============================================================
    // Parsing pasted data (tab-separated, or Excel-style multi-space)
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
            const qtyRaw = cols[3].trim();

            if (/^item\s*sku$/i.test(skuRaw)) continue; // skip header row
            const sku = normalizeSku(skuRaw);
            if (!sku) continue;

            const qtyNum = parseFloat(qtyRaw.replace(/,/g, ''));
            if (isNaN(qtyNum)) continue;

            rows.push({ sku, qty: qtyNum, description: descRaw });
        }
        return rows;
    }

    // ============================================================
    // Optional convenience: auto-open the Part# filter popup
    // ============================================================
    async function openPartNumberFilter() {
        const doc = ensureGridDoc();
        if (!doc) return false;

        const { skuColId } = resolveColumnIds();
        const header = doc.querySelector(`.ag-header-cell[col-id="${skuColId}"]`);
        if (!header) {
            log('Could not find the Part # column header.', 'err');
            return false;
        }
        const menuBtn = header.querySelector('[ref="eMenu"], .ag-header-cell-menu-button');
        if (!menuBtn) {
            log('Could not find the filter/menu icon on the Part # header.', 'warn');
            return false;
        }
        clickEl(menuBtn);
        await sleep(300);

        // The popup usually opens directly on the Filter tab, but just in case, try clicking it
        const filterTab = doc.querySelector('.ag-tab-selector .ag-icon-filter, .ag-menu-header .ag-icon-filter, [aria-label="Filter"]');
        if (filterTab) {
            const clickable = filterTab.closest('span, button, div');
            if (clickable) {
                clickEl(clickable);
                await sleep(200);
            }
        }

        const input = findVisibleFilterInput();
        if (input) {
            log('Part # filter panel is open.', 'ok');
            return true;
        }
        log('Clicked the menu icon, but the filter input isn\'t visible yet — you may need to open it manually.', 'warn');
        return false;
    }

    document.getElementById('reqFillerOpenFilter').addEventListener('click', async () => {
        clearLog();
        gridDoc = null; // force a fresh search in case the page/frame has changed
        await openPartNumberFilter();
    });

    // ============================================================
    // Step 1: Fill the ag-grid filter input with comma-joined SKUs
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
    // Step 2: Walk filtered rows and fill in quantities.
    // Confirmed behavior from a real recording: a single click on the
    // quantity cell swaps it to <input id="QUANTITY{row-index}">, and
    // clicking elsewhere commits the value.
    // ============================================================
    function getGridRows() {
        const doc = ensureGridDoc();
        if (!doc) return [];
        const container = doc.querySelector(CONFIG.ROW_CONTAINER_SELECTOR);
        if (!container) return [];
        return Array.from(container.querySelectorAll(`:scope > ${CONFIG.ROW_SELECTOR}`));
    }

    function getSkuFromRow(row) {
        const cell = row.querySelector(`${CONFIG.CELL_SELECTOR}[col-id="${resolvedSkuColId}"]`);
        if (!cell) return null;
        return normalizeSku(cell.textContent);
    }

    function getQtyCellFromRow(row) {
        return row.querySelector(`${CONFIG.CELL_SELECTOR}[col-id="${resolvedQtyColId}"]`);
    }

    async function editRowQuantity(row, valueStr) {
        const doc = ensureGridDoc();
        if (!doc) return { ok: false, reason: 'grid document lost' };

        const qtyCell = getQtyCellFromRow(row);
        if (!qtyCell) return { ok: false, reason: 'qty cell not found' };

        const rowIndex = row.getAttribute('row-index');

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

    async function fillQuantities(dataMap) {
        const rows = getGridRows();

        if (rows.length === 0) {
            log('No grid rows found after filtering. Nothing to fill.', 'warn');
            return { filledSkus: new Set(), foundButFailedSkus: new Set() };
        }

        log(`Found ${rows.length} row(s) in the grid. Matching against ${Object.keys(dataMap).length} SKUs...`);

        let filled = 0;
        let unmatched = 0;
        const filledSkus = new Set();
        const foundButFailedSkus = new Set();

        for (const row of rows) {
            const sku = getSkuFromRow(row);
            if (!sku || !(sku in dataMap)) {
                unmatched++;
                continue;
            }

            const qtyStr = CONFIG.formatQty(dataMap[sku].qty);
            const result = await editRowQuantity(row, qtyStr);

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

        log(`Done. Filled ${filled} row(s). ${unmatched} visible row(s) didn't match a pasted SKU.`, filled > 0 ? 'ok' : 'warn');
        return { filledSkus, foundButFailedSkus };
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
            log('No valid rows parsed. Check that you pasted SKU / Desc / UOM / Qty rows (tab- or multi-space-separated).', 'err');
            return;
        }

        log(`Parsed ${parsed.length} row(s).`, 'ok');

        if (!ensureGridDoc()) return;
        resolveColumnIds();

        const dataMap = {};
        const skuList = [];
        for (const r of parsed) {
            dataMap[r.sku] = { qty: r.qty, description: r.description };
            skuList.push(r.sku);
        }

        const filterOk = await fillFilterAndApply(skuList);
        if (!filterOk) return;

        log(`Waiting ${CONFIG.FILTER_APPLY_DELAY_MS}ms for the grid to refresh...`);
        await sleep(CONFIG.FILTER_APPLY_DELAY_MS);

        const { filledSkus, foundButFailedSkus } = await fillQuantities(dataMap);
        reportMissingSkus(dataMap, filledSkus, foundButFailedSkus);
    });

    console.log('[REQ SKU/Qty Filler v1.5] loaded.');
})();
