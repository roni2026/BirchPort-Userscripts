// ==UserScript==
// @name         Birchstreet - Local Item Price Lookup (Floating UI)
// @namespace    kingvamp-tools
// @version      2.1
// @description  Floating panel: enter a part number, click Fetch Price, get supplier names + prices from Supplier Items tab. Ctrl+Alt+I fills from clipboard and runs automatically.
// @author       Rick
// @match        https://*.birchstreetsystems.com/*
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_deleteValue
// @grant        GM_addValueChangeListener
// @run-at       document-idle
// ==/UserScript==

(function () {
    'use strict';

    const STATE_KEY = 'bsLookup_state';
    const RESULT_KEY = 'bsLookup_result';
    const POS_KEY = 'bsLookup_panelPos';
    const STATE_TTL_MS = 90 * 1000;
    const RESULT_TTL_MS = 10 * 60 * 1000; // stale results (e.g. left over from an aborted run) shouldn't render as fresh
    const LOG_PREFIX = '[BS-Lookup]';

    // ---------------- generic helpers ----------------

    function log(...args) { console.log(LOG_PREFIX, ...args); }

    function getState() {
        const raw = GM_getValue(STATE_KEY, null);
        if (!raw) return null;
        try {
            const s = JSON.parse(raw);
            if (Date.now() - s.ts > STATE_TTL_MS) { GM_deleteValue(STATE_KEY); return null; }
            return s;
        } catch (e) { GM_deleteValue(STATE_KEY); return null; }
    }

    function setState(step, partNumber, status) {
        GM_setValue(STATE_KEY, JSON.stringify({ step, partNumber, status, ts: Date.now() }));
        updatePanelStatus(status);
    }

    function clearState() { GM_deleteValue(STATE_KEY); }

    // A run is "in flight" if there's a live (non-expired) state entry -
    // used to stop overlapping runs from stomping on each other's
    // STATE_KEY/RESULT_KEY (e.g. hitting Fetch Price twice, or the
    // clipboard hotkey firing mid-run).
    function isRunning() { return !!getState(); }

    function getResult() {
        const raw = GM_getValue(RESULT_KEY, null);
        if (!raw) return null;
        try {
            const r = JSON.parse(raw);
            if (Date.now() - (r.ts || 0) > RESULT_TTL_MS) { GM_deleteValue(RESULT_KEY); return null; }
            return r;
        } catch (e) { return null; }
    }

    function setResult(partNumber, rows) {
        GM_setValue(RESULT_KEY, JSON.stringify({ partNumber, rows, ts: Date.now() }));
    }

    function clearResult() { GM_deleteValue(RESULT_KEY); }

    function fireChange(el) { el.dispatchEvent(new Event('change', { bubbles: true })); }
    function fireInput(el) { el.dispatchEvent(new Event('input', { bubbles: true })); }

    // Checks real visibility (display / visibility), not just presence in
    // the DOM - Birchstreet often has elements sitting in the DOM before
    // they're actually interactive (tabs/popups toggle inline styles as
    // they finish populating), so existence alone isn't enough to click.
    function isVisible(el) {
        if (!el) return false;
        const view = el.ownerDocument && el.ownerDocument.defaultView;
        if (!view) return false;
        const style = view.getComputedStyle(el);
        if (style.display === 'none' || style.visibility === 'hidden') return false;
        return true;
    }

    function waitFor(finderFn, { timeout = 15000, interval = 250 } = {}) {
        return new Promise((resolve, reject) => {
            const start = Date.now();
            const tryFind = () => { const el = finderFn(); if (el) { resolve(el); return true; } return false; };
            if (tryFind()) return;
            const observer = new MutationObserver(() => { if (tryFind()) observer.disconnect(); });
            observer.observe(document.documentElement || document.body, { childList: true, subtree: true });
            const poll = setInterval(() => {
                if (Date.now() - start > timeout) {
                    clearInterval(poll); observer.disconnect();
                    reject(new Error('waitFor timeout'));
                    return;
                }
                if (tryFind()) { clearInterval(poll); observer.disconnect(); }
            }, interval);
        });
    }

    // ---------------- Birchstreet element finders ----------------
    // Each finder now also requires the element to be visible, not just
    // present, before waitFor() will resolve on it.

    const findLocalItemMaintenanceLeaf = () => {
        const el = document.querySelector('[title="Local Item Maintenance"]') || document.getElementById('HN7');
        return el && isVisible(el) ? el : null;
    };
    const findSearchFieldSelect = () => {
        const el = document.getElementById('SearchField');
        return el && isVisible(el) ? el : null;
    };
    const findSearchValueInput = () => {
        const el = document.getElementById('SearchValue');
        return el && isVisible(el) ? el : null;
    };
    const findSearchButton = () => {
        const el = document.getElementById('searchButton');
        return el && isVisible(el) ? el : null;
    };
    const findFirstResultRow = () => {
        const el = document.querySelector('tr[id^="tb"]');
        return el && isVisible(el) ? el : null;
    };

    const findSupplierItemsTab = () => {
        const byId = document.getElementById('tab3');
        if (byId && byId.textContent.trim() === 'Supplier Items' && isVisible(byId)) return byId;
        const candidates = Array.from(document.querySelectorAll('td[onclick*="setTab"]'));
        const match = candidates.find((td) => td.textContent.trim() === 'Supplier Items');
        return match && isVisible(match) ? match : null;
    };

    const findSupplierGridTable = () => {
        const el = document.getElementById('TABLE_GRID');
        return el && isVisible(el) ? el : null;
    };

    // ---------------- Supplier grid parsing ----------------

    function parseSupplierGrid() {
        const table = findSupplierGridTable();
        if (!table) return [];

        const headerRow = table.querySelector('tr');
        const ths = Array.from(headerRow.querySelectorAll('th'));
        const colMap = [];
        ths.forEach((th) => {
            const colspan = parseInt(th.getAttribute('colspan') || '1', 10);
            const colname = th.getAttribute('colname') || null;
            for (let i = 0; i < colspan; i++) colMap.push(colname);
        });

        const firstIndexOf = (name) => colMap.indexOf(name);
        const lastIndexOf = (name) => {
            let idx = -1;
            colMap.forEach((c, i) => { if (c === name) idx = i; });
            return idx;
        };

        const nameIdx = lastIndexOf('SUPPLIER_COMPANY_ID');
        const priceIdx = firstIndexOf('UNIT_TRX_PRICE');
        const currencyIdx = firstIndexOf('TRX_CURRENCY');
        const prefIdx = firstIndexOf('PREFERRED_SUPPLIER');
        const inactiveIdx = firstIndexOf('DEACTIVE');
        const descIdx = firstIndexOf('ITEM_DESCRIPTION');
        const uomIdx = firstIndexOf('ORDER_UOM');
        const skuIdx = firstIndexOf('SUPPLIER_SKU');

        const dataRows = Array.from(table.querySelectorAll('tr[id^="ROW"]')).filter((tr) => tr.id !== 'ROW-1');

        const cellAt = (tds, idx) => {
            if (idx < 0 || !tds[idx]) return '';
            return tds[idx].textContent.replace(/\u00a0/g, ' ').trim();
        };

        return dataRows
            .map((tr) => {
                const tds = Array.from(tr.children);
                return {
                    supplier: cellAt(tds, nameIdx),
                    price: cellAt(tds, priceIdx),
                    currency: cellAt(tds, currencyIdx),
                    preferred: cellAt(tds, prefIdx),
                    inactive: cellAt(tds, inactiveIdx),
                    description: cellAt(tds, descIdx),
                    uom: cellAt(tds, uomIdx),
                    sku: cellAt(tds, skuIdx),
                };
            })
            .filter((r) => r.supplier);
    }

    // ---------------- automation steps ----------------

    async function step1_clickLocalItemMaintenance(partNumber) {
        setState('await_search_page', partNumber, 'Opening Local Item Maintenance...');
        const leaf = await waitFor(findLocalItemMaintenanceLeaf, { timeout: 8000 });
        leaf.click();
    }

    async function step2_performSearch(partNumber) {
        setState('await_results', partNumber, 'Searching for part #' + partNumber + '...');
        const select = await waitFor(findSearchFieldSelect, { timeout: 15000 });
        select.value = 'SUPER_SKU_CODE';
        fireChange(select);

        const input = await waitFor(findSearchValueInput, { timeout: 8000 });
        input.focus();
        input.value = partNumber;
        fireInput(input);
        fireChange(input);

        const btn = await waitFor(findSearchButton, { timeout: 8000 });
        btn.click();
    }

    async function step3_openFirstResult(partNumber) {
        setState('await_item_page', partNumber, 'Opening item...');
        let row;
        try {
            row = await waitFor(findFirstResultRow, { timeout: 15000 });
        } catch (err) {
            clearState();
            updatePanelStatus('No results found for part #' + partNumber + '.');
            throw err;
        }
        row.click();
    }

    async function step4_openSupplierGrid(partNumber) {
        setState('await_supplier_grid', partNumber, 'Loading supplier prices...');
        const tab = await waitFor(findSupplierItemsTab, { timeout: 15000 });
        tab.click();

        const table = await waitFor(findSupplierGridTable, { timeout: 15000 });
        // small settle delay in case rows render after the table shell appears
        await new Promise((r) => setTimeout(r, 400));
        const rows = parseSupplierGrid();
        setResult(partNumber, rows);
        clearState();
        renderResults(partNumber, rows);
    }

    async function resumeIfNeeded() {
        const state = getState();
        if (!state) return;
        log('Resuming step:', state.step, 'part #', state.partNumber);
        try {
            switch (state.step) {
                case 'await_search_page': await step2_performSearch(state.partNumber); break;
                case 'await_results': await step3_openFirstResult(state.partNumber); break;
                case 'await_item_page': await step4_openSupplierGrid(state.partNumber); break;
                case 'await_supplier_grid': await step4_openSupplierGrid(state.partNumber); break;
                default: clearState();
            }
        } catch (err) {
            log('Automation error:', err);
            updatePanelStatus('Error: ' + err.message + ' (try again)');
            clearState();
        }
    }

    if (typeof GM_addValueChangeListener === 'function') {
        GM_addValueChangeListener(STATE_KEY, (name, oldValue, newValue, remote) => { if (remote) resumeIfNeeded(); });
        GM_addValueChangeListener(RESULT_KEY, (name, oldValue, newValue, remote) => {
            if (remote) {
                const r = getResult();
                if (r) renderResults(r.partNumber, r.rows);
            }
        });
    }

    async function startFetch(partNumber) {
        partNumber = (partNumber || '').trim();
        if (!partNumber) { updatePanelStatus('Enter a part number first.'); return; }
        if (isRunning()) { updatePanelStatus('Already fetching - wait for the current lookup to finish.'); return; }
        clearState();
        clearResult();
        renderResults(partNumber, null); // clear old table, show "fetching"
        try {
            await step1_clickLocalItemMaintenance(partNumber);
        } catch (err) {
            log('Could not find Local Item Maintenance link on this page:', err);
            updatePanelStatus('Go to the Birchstreet home screen first, then click Fetch Price.');
            clearState();
        }
    }

    document.addEventListener('keydown', async (e) => {
        if (e.ctrlKey && e.altKey && (e.key === 'i' || e.key === 'I')) {
            e.preventDefault();
            if (isRunning()) { updatePanelStatus('Already fetching - wait for the current lookup to finish.'); return; }
            let text = '';
            try { text = (await navigator.clipboard.readText()).trim(); }
            catch (err) { updatePanelStatus('Clipboard read blocked - click the page then retry.'); return; }
            if (!text) { updatePanelStatus('Clipboard is empty.'); return; }
            const input = document.getElementById('bsLookupPartInput');
            if (input) input.value = text;
            startFetch(text);
        }
    });

    // ---------------- floating panel UI (Dracula themed) ----------------

    const COLORS = {
        bg: '#282a36',
        bgAlt: '#21222c',
        fg: '#f8f8f2',
        comment: '#6272a4',
        purple: '#bd93f9',
        green: '#50fa7b',
        pink: '#ff79c6',
        red: '#ff5555',
        orange: '#ffb86c',
        cyan: '#8be9fd',
        yellow: '#f1fa8c',
    };

    let panelEl = null;
    let statusEl = null;
    let resultsEl = null;
    let inputEl = null;

    function injectStyles() {
        if (document.getElementById('bsLookupStyles')) return;
        const style = document.createElement('style');
        style.id = 'bsLookupStyles';
        style.textContent = `
            #bsLookupPanel {
                position: fixed;
                z-index: 2147483647;
                width: 360px;
                max-height: 70vh;
                background: ${COLORS.bg};
                color: ${COLORS.fg};
                border: 1px solid ${COLORS.purple};
                border-radius: 10px;
                box-shadow: 0 8px 24px rgba(0,0,0,0.5);
                font-family: 'Segoe UI', Consolas, monospace;
                font-size: 13px;
                display: flex;
                flex-direction: column;
                overflow: hidden;
            }
            #bsLookupHeader {
                background: ${COLORS.bgAlt};
                padding: 8px 10px;
                cursor: move;
                display: flex;
                align-items: center;
                justify-content: space-between;
                border-bottom: 1px solid ${COLORS.comment};
                user-select: none;
            }
            #bsLookupHeader span.title { color: ${COLORS.green}; font-weight: 600; }
            #bsLookupHeader .btns { display: flex; gap: 6px; }
            #bsLookupHeader button {
                background: transparent; border: none; color: ${COLORS.comment};
                cursor: pointer; font-size: 14px; line-height: 1;
            }
            #bsLookupHeader button:hover { color: ${COLORS.red}; }
            #bsLookupBody { padding: 10px; overflow-y: auto; }
            #bsLookupBody.collapsed { display: none; }
            #bsLookupPartInput {
                width: 100%; box-sizing: border-box;
                background: ${COLORS.bgAlt}; color: ${COLORS.fg};
                border: 1px solid ${COLORS.comment}; border-radius: 6px;
                padding: 6px 8px; font-size: 13px; margin-bottom: 6px;
            }
            #bsLookupPartInput:focus { outline: none; border-color: ${COLORS.purple}; }
            #bsLookupFetchBtn {
                width: 100%; padding: 7px; border: none; border-radius: 6px;
                background: ${COLORS.purple}; color: ${COLORS.bg}; font-weight: 600;
                cursor: pointer; margin-bottom: 8px;
            }
            #bsLookupFetchBtn:hover { background: ${COLORS.pink}; }
            #bsLookupStatus { color: ${COLORS.cyan}; margin-bottom: 8px; min-height: 16px; }
            #bsLookupResults table { width: 100%; border-collapse: collapse; font-size: 12px; }
            #bsLookupResults th {
                text-align: left; color: ${COLORS.comment}; font-weight: 600;
                border-bottom: 1px solid ${COLORS.comment}; padding: 4px;
            }
            #bsLookupResults td { padding: 4px; border-bottom: 1px solid ${COLORS.bgAlt}; vertical-align: top; }
            #bsLookupResults tr.preferred td { color: ${COLORS.green}; }
            #bsLookupResults tr.inactive td { color: ${COLORS.red}; text-decoration: line-through; }
            #bsLookupResults .empty { color: ${COLORS.comment}; font-style: italic; }
        `;
        document.head.appendChild(style);
    }

    function renderResults(partNumber, rows) {
        if (!resultsEl) return;
        if (rows === null) {
            resultsEl.innerHTML = '<div class="empty">Fetching...</div>';
            return;
        }
        if (!rows.length) {
            resultsEl.innerHTML = '<div class="empty">No suppliers found for part #' + escapeHtml(partNumber) + '</div>';
            return;
        }
        const desc = rows[0].description ? ' - ' + escapeHtml(rows[0].description) : '';
        let html = '<div style="color:' + COLORS.orange + ';margin-bottom:6px;">Part #' + escapeHtml(partNumber) + desc + '</div>';
        html += '<table><thead><tr><th>Supplier</th><th>Price</th><th>UOM</th></tr></thead><tbody>';
        rows.forEach((r) => {
            const cls = r.inactive === 'Yes' ? 'inactive' : (r.preferred === 'Yes' ? 'preferred' : '');
            html += '<tr class="' + cls + '">'
                + '<td>' + escapeHtml(r.supplier) + '</td>'
                + '<td>' + escapeHtml(r.price) + ' ' + escapeHtml(r.currency) + '</td>'
                + '<td>' + escapeHtml(r.uom) + '</td>'
                + '</tr>';
        });
        html += '</tbody></table>';
        resultsEl.innerHTML = html;
        updatePanelStatus('Done.');
    }

    function updatePanelStatus(msg) {
        if (statusEl) statusEl.textContent = msg || '';
    }

    function escapeHtml(str) {
        return String(str || '').replace(/[&<>"']/g, (c) => ({
            '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
        }[c]));
    }

    function makeDraggable(panel, handle) {
        let dragging = false, offsetX = 0, offsetY = 0;
        handle.addEventListener('mousedown', (e) => {
            dragging = true;
            offsetX = e.clientX - panel.getBoundingClientRect().left;
            offsetY = e.clientY - panel.getBoundingClientRect().top;
            e.preventDefault();
        });
        document.addEventListener('mousemove', (e) => {
            if (!dragging) return;
            const x = Math.max(0, e.clientX - offsetX);
            const y = Math.max(0, e.clientY - offsetY);
            panel.style.left = x + 'px';
            panel.style.top = y + 'px';
            panel.style.right = 'auto';
        });
        document.addEventListener('mouseup', () => {
            if (!dragging) return;
            dragging = false;
            try {
                GM_setValue(POS_KEY, JSON.stringify({
                    left: panel.style.left, top: panel.style.top,
                }));
            } catch (e) {
                log('Could not save panel position:', e);
            }
        });
    }

    function createPanel() {
        injectStyles();

        panelEl = document.createElement('div');
        panelEl.id = 'bsLookupPanel';

        const savedPos = (() => {
            try { return JSON.parse(GM_getValue(POS_KEY, 'null')); } catch (e) { return null; }
        })();
        if (savedPos && savedPos.left && savedPos.top) {
            panelEl.style.left = savedPos.left;
            panelEl.style.top = savedPos.top;
        } else {
            panelEl.style.top = '80px';
            panelEl.style.right = '20px';
        }

        panelEl.innerHTML = `
            <div id="bsLookupHeader">
                <span class="title">Birchstreet Price Lookup</span>
                <div class="btns">
                    <button id="bsLookupCollapseBtn" title="Collapse">-</button>
                </div>
            </div>
            <div id="bsLookupBody">
                <input type="text" id="bsLookupPartInput" placeholder="Enter part number...">
                <button id="bsLookupFetchBtn">Fetch Price</button>
                <div id="bsLookupStatus"></div>
                <div id="bsLookupResults"></div>
            </div>
        `;
        document.body.appendChild(panelEl);

        const header = panelEl.querySelector('#bsLookupHeader');
        const body = panelEl.querySelector('#bsLookupBody');
        const collapseBtn = panelEl.querySelector('#bsLookupCollapseBtn');
        inputEl = panelEl.querySelector('#bsLookupPartInput');
        statusEl = panelEl.querySelector('#bsLookupStatus');
        resultsEl = panelEl.querySelector('#bsLookupResults');

        makeDraggable(panelEl, header);

        collapseBtn.addEventListener('click', () => {
            body.classList.toggle('collapsed');
            collapseBtn.textContent = body.classList.contains('collapsed') ? '+' : '-';
        });

        panelEl.querySelector('#bsLookupFetchBtn').addEventListener('click', () => startFetch(inputEl.value));
        inputEl.addEventListener('keydown', (e) => { if (e.key === 'Enter') startFetch(inputEl.value); });

        // restore in-progress part number / prior results on fresh page loads
        const state = getState();
        const result = getResult();
        if (state) {
            inputEl.value = state.partNumber || '';
            updatePanelStatus(state.status || 'Working...');
        } else if (result) {
            inputEl.value = result.partNumber || '';
            renderResults(result.partNumber, result.rows);
        }
    }

    createPanel();
    resumeIfNeeded();
})();
