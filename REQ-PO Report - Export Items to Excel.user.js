// ==UserScript==
// @name         REQ/PO Report - Export Items to Excel
// @namespace    roni2026.birchstreet
// @version      1.8
// @description  Round floating icon (top-right) to export REQ line items or PO line items as a bordered, pre-sized table, ready to paste into Excel
// @author       roni2026
// @match        *://*/*REQReport.jsp*
// @match        https://*.birchstreetsystems.com/*
// @grant        GM_setClipboard
// @grant        GM_addStyle
// @run-at       document-idle
// ==/UserScript==

(function () {
    'use strict';

    // --- Styles for the floating round icon button + toast ---
    GM_addStyle(`
        #reqExportBtn {
            position: fixed;
            top: 12px;
            right: 12px;
            z-index: 999999;
            width: 40px;
            height: 40px;
            background: #1a7f37;
            color: #fff;
            font-size: 18px;
            line-height: 1;
            border: none;
            border-radius: 50%;
            box-shadow: 0 2px 8px rgba(0,0,0,0.35);
            cursor: pointer;
            user-select: none;
            display: flex;
            align-items: center;
            justify-content: center;
            padding: 0;
        }
        #reqExportBtn:hover { background: #166a2e; }
        #reqExportBtn:active { transform: scale(0.94); }

        #reqExportToast {
            position: fixed;
            top: 60px;
            right: 12px;
            z-index: 999999;
            background: #222;
            color: #fff;
            font-family: Arial, sans-serif;
            font-size: 13px;
            padding: 10px 16px;
            border-radius: 6px;
            box-shadow: 0 2px 8px rgba(0,0,0,0.35);
            opacity: 0;
            transition: opacity 0.25s ease;
            pointer-events: none;
        }
        #reqExportToast.show { opacity: 1; }
    `);

    // ---------------------------------------------------------------------
    // Shared helpers
    // ---------------------------------------------------------------------

    function cleanText(str) {
        return (str || '')
            .replace(/\u00A0/g, ' ') // non-breaking spaces
            .replace(/\s+/g, ' ')
            .trim();
    }

    function escapeHtml(str) {
        return String(str)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;');
    }

    // "REQ-MAM-000037427" -> "REQ - 37427" / "PO-MAM-000021345" -> "PO - 21345"
    function shortCode(full, label) {
        if (!full) return null;
        const digits = full.match(/(\d+)$/);
        return digits ? `${label} - ${parseInt(digits[1], 10)}` : full;
    }
    function reqShort(full) { return shortCode(full, 'REQ'); }
    function poShort(full) { return shortCode(full, 'PO'); }

    // 0.5pt = Excel's thin "All Borders" line weight
    const TD_BASE = 'border:0.5pt solid #000000; padding:2px 4px; font-family:Arial; font-size:10pt; white-space:nowrap;';

    // Build a cell with BOTH width attribute and inline width style —
    // Excel only reliably honors pasted column widths when both are present.
    // Headers are ALWAYS centered; data cells use the column's align setting.
    function makeCell(content, colIndex, isHeader, columns) {
        const col = columns[colIndex];
        const widthAttr = `width="${col.width}"`;
        const widthStyle = `width:${col.width}px;`;
        const bold = isHeader ? ' font-weight:bold;' : '';
        const align = isHeader ? 'center' : col.align;
        return `<td ${widthAttr} style="${TD_BASE}${widthStyle} text-align:${align};${bold}">${content}</td>`;
    }

    function showToast(message) {
        let toast = document.getElementById('reqExportToast');
        if (!toast) {
            toast = document.createElement('div');
            toast.id = 'reqExportToast';
            document.body.appendChild(toast);
        }
        toast.textContent = message;
        toast.classList.add('show');
        clearTimeout(toast._hideTimer);
        toast._hideTimer = setTimeout(() => toast.classList.remove('show'), 3500);
    }

    // Scan every <td> on the page. If labelRegex matches the cell's RAW
    // (non-whitespace-collapsed) text and captures a non-empty group, use it.
    // Otherwise, if the cell is just the bare label, fall back to the value
    // living in the very next sibling <td> (used by header tables where the
    // label and value sit in separate cells, e.g. "Subject:" | "...text...").
    function findAdjacentValue(labelRegex) {
        const tds = document.querySelectorAll('td');
        for (const td of tds) {
            const raw = td.innerText || '';
            const m = raw.match(labelRegex);
            if (m) {
                if (m[1] && cleanText(m[1])) return cleanText(m[1]);
                if (td.nextElementSibling) {
                    const val = cleanText(td.nextElementSibling.innerText);
                    if (val) return val;
                }
            }
        }
        return null;
    }

    // ---------------------------------------------------------------------
    // REQ report page
    // ---------------------------------------------------------------------

    const REQ_COLUMNS = [
        { width: 45,  align: 'center' }, // #
        { width: 155, align: 'left'   }, // Supplier (data left, header center)
        { width: 80,  align: 'center' }, // Item SKU
        { width: 365, align: 'left'   }, // Product Desc. (data left, header center)
        { width: 55,  align: 'center' }, // Qty
        { width: 55,  align: 'center' }, // UOM
        { width: 70,  align: 'center' }, // Price
        { width: 100, align: 'center' }, // REQ
    ];

    function hasReqItems() {
        return document.querySelectorAll('div[name="EditLine"]').length > 0;
    }

    function extractReqItems() {
        const items = [];
        const editDivs = document.querySelectorAll('div[name="EditLine"]');

        editDivs.forEach((editDiv) => {
            const row = editDiv.closest('tr');
            if (!row) return;

            const cells = row.querySelectorAll('td');
            if (cells.length < 7) return;

            const rowNum = cleanText(cells[0].innerText);
            const supplier = cleanText(cells[1].innerText);
            const skuRaw = cleanText(cells[2].innerText);
            const itemNum = skuRaw.replace(/^0+(?=\d)/, ''); // strip leading zeros

            let desc = cleanText(cells[3].innerText);
            // Remove leading "code / code" prefix, e.g. "1405.000031 / 8650000  BEEF BOLOR..."
            desc = desc.replace(/^\S+\s*\/\s*\S+\s+/, '').trim();

            const qty = cleanText(cells[4].innerText);
            const uom = cleanText(cells[5].innerText);

            const priceRaw = cleanText(cells[6].innerText);
            const priceNum = parseFloat(priceRaw.replace(/[^\d.]/g, ''));
            const price = isNaN(priceNum) ? priceRaw : priceNum.toFixed(2);

            if (!itemNum && !desc) return; // skip empty/malformed rows

            items.push({ rowNum, supplier, itemNum, desc, qty, uom, price });
        });

        return items;
    }

    // Find "REQ NUMBER : REQ-MAM-000037427" anywhere on the page
    function findReqNumber() {
        const tds = document.querySelectorAll('td');
        for (const td of tds) {
            if (/REQ NUMBER/i.test(td.innerText)) {
                const m = td.innerText.match(/REQ NUMBER\s*:\s*([A-Z0-9-]+)/i);
                if (m) return m[1];
            }
        }
        const m = document.body.innerText.match(/REQ NUMBER\s*:\s*([A-Z0-9-]+)/i);
        return m ? m[1] : null;
    }

    function buildReqHtmlTable(items, reqNum) {
        const reqHeader = reqNum ? escapeHtml(reqShort(reqNum)) : 'REQ #';

        let html = `<table border="1" cellspacing="0" cellpadding="2" style="border-collapse:collapse;">`;

        html += '<tr>';
        ['#', 'Supplier', 'Item SKU', 'Product Desc.', 'Qty', 'UOM', 'Price'].forEach((h, i) => {
            html += makeCell(escapeHtml(h), i, true, REQ_COLUMNS);
        });
        html += makeCell(reqHeader, 7, true, REQ_COLUMNS);
        html += '</tr>';

        items.forEach(i => {
            const row = [i.rowNum, i.supplier, i.itemNum, i.desc, i.qty, i.uom, i.price, '-'];
            html += '<tr>' + row.map((v, c) => makeCell(escapeHtml(v), c, false, REQ_COLUMNS)).join('') + '</tr>';
        });

        html += '</table>';
        return html;
    }

    function exportReqItems() {
        const items = extractReqItems();
        if (items.length === 0) {
            showToast('⚠️ No items found on this page.');
            return;
        }
        const reqNum = findReqNumber();
        const html = buildReqHtmlTable(items, reqNum);
        GM_setClipboard(html, 'html');
        showToast(`✅ Exported ${items.length} item${items.length === 1 ? '' : 's'}${reqNum ? ' (' + reqShort(reqNum) + ')' : ''} to clipboard!`);
    }

    // ---------------------------------------------------------------------
    // PO report page
    // ---------------------------------------------------------------------

    const PO_COLUMNS = [
        { width: 40,  align: 'center' }, // #
        { width: 160, align: 'left'   }, // Supplier
        { width: 80,  align: 'center' }, // Item SKU
        { width: 320, align: 'left'   }, // Product Desc.
        { width: 50,  align: 'center' }, // Qty
        { width: 50,  align: 'center' }, // UOM
        { width: 70,  align: 'center' }, // Price
        { width: 90,  align: 'center' }, // REQ - xxxxx
        { width: 90,  align: 'center' }, // PO - xxxxx
        { width: 220, align: 'left'   }, // Subject
    ];

    // PO pages don't use div[name="EditLine"] like REQ pages do — instead the
    // item rows are plain <tr> rows: #, Item SKU, Product Desc., Pack/Size,
    // Qty, UOM, Price, Extension. Identify them by a numeric row-number in
    // the first cell and a numeric SKU in the second (distinguishes them
    // from the header row and every other row on the page).
    function extractPoItems() {
        const items = [];
        const rows = document.querySelectorAll('tr');

        rows.forEach((row) => {
            const cells = row.querySelectorAll(':scope > td');
            if (cells.length < 8) return;

            const rowNum = cleanText(cells[0].innerText);
            if (!/^\d+$/.test(rowNum)) return;

            const skuRaw = cleanText(cells[1].innerText);
            if (!/^\d+$/.test(skuRaw)) return;

            const itemNum = skuRaw.replace(/^0+(?=\d)/, '');
            const desc = cleanText(cells[2].innerText);

            const qtyRaw = cleanText(cells[4].innerText);
            const qtyNum = parseFloat(qtyRaw.replace(/[^\d.]/g, ''));
            const qty = isNaN(qtyNum) ? qtyRaw : String(qtyNum);

            const uom = cleanText(cells[5].innerText);

            const priceRaw = cleanText(cells[6].innerText);
            const priceNum = parseFloat(priceRaw.replace(/[^\d.]/g, ''));
            const price = isNaN(priceNum) ? priceRaw : `$${priceNum.toFixed(2)}`;

            if (!itemNum && !desc) return;

            items.push({ rowNum, itemNum, desc, qty, uom, price });
        });

        return items;
    }

    function extractPoHeaderInfo() {
        const poNum = findAdjacentValue(/PO NUMBER\s*:\s*([A-Z0-9-]+)/i);
        const reqNum = findAdjacentValue(/REQ Num\s*:\s*([A-Z0-9-]+)/i);
        const supplier = findAdjacentValue(/Supplier:\s*([^\n\r]+)/i);
        const subject = findAdjacentValue(/^Subject:\s*([^\n\r]*)$/i);
        return { poNum, reqNum, supplier, subject };
    }

    function hasPoItems() {
        return /PURCHASE ORDER/i.test(document.body.innerText) && extractPoItems().length > 0;
    }

    function buildPoHtmlTable(items, header) {
        const reqHeader = header.reqNum ? escapeHtml(reqShort(header.reqNum)) : 'REQ #';
        const poHeader = header.poNum ? escapeHtml(poShort(header.poNum)) : 'PO #';
        const supplier = header.supplier || '';
        const subject = header.subject || '';

        let html = `<table border="1" cellspacing="0" cellpadding="2" style="border-collapse:collapse;">`;

        html += '<tr>';
        ['#', 'Supplier', 'Item SKU', 'Product Desc.', 'Qty', 'UOM', 'Price'].forEach((h, i) => {
            html += makeCell(escapeHtml(h), i, true, PO_COLUMNS);
        });
        html += makeCell(reqHeader, 7, true, PO_COLUMNS);
        html += makeCell(poHeader, 8, true, PO_COLUMNS);
        html += makeCell('Subject', 9, true, PO_COLUMNS);
        html += '</tr>';

        items.forEach(i => {
            const row = [i.rowNum, supplier, i.itemNum, i.desc, i.qty, i.uom, i.price, '-', '-', subject];
            html += '<tr>' + row.map((v, c) => makeCell(escapeHtml(v), c, false, PO_COLUMNS)).join('') + '</tr>';
        });

        html += '</table>';
        return html;
    }

    function exportPoItems() {
        const items = extractPoItems();
        if (items.length === 0) {
            showToast('⚠️ No items found on this page.');
            return;
        }
        const header = extractPoHeaderInfo();
        const html = buildPoHtmlTable(items, header);
        GM_setClipboard(html, 'html');
        const tag = header.poNum ? ' (' + poShort(header.poNum) + ')' : '';
        showToast(`✅ Exported ${items.length} item${items.length === 1 ? '' : 's'}${tag} to clipboard!`);
    }

    // ---------------------------------------------------------------------
    // Page-type detection + button wiring
    // ---------------------------------------------------------------------

    function detectPageType() {
        if (hasReqItems()) return 'req';
        if (hasPoItems()) return 'po';
        return null;
    }

    function exportItems() {
        const pageType = detectPageType();
        if (pageType === 'req') {
            exportReqItems();
        } else if (pageType === 'po') {
            exportPoItems();
        } else {
            showToast('⚠️ No items found on this page.');
        }
    }

    function addButton() {
        if (document.getElementById('reqExportBtn')) return; // already added
        const btn = document.createElement('button');
        btn.id = 'reqExportBtn';
        btn.textContent = '📋'; // icon only, no text
        btn.title = 'Export Items to Excel';
        btn.addEventListener('click', exportItems);
        document.body.appendChild(btn);
    }

    function init() {
        if (!detectPageType()) return;
        addButton();
    }

    // Try immediately, and retry briefly in case content loads a moment later
    init();
    let attempts = 0;
    const retry = setInterval(() => {
        attempts++;
        if (document.getElementById('reqExportBtn') || attempts > 10) {
            clearInterval(retry);
            return;
        }
        init();
    }, 500);
})();