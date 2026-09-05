// ==UserScript==
// @name         REQ Report - Export Items to Excel
// @namespace    roni2026.birchstreet
// @version      1.7
// @description  Round floating icon (top-right) to export REQ line items as a bordered, pre-sized table (#, Supplier, Item SKU, Product Desc., Qty, UOM, Price, REQ), ready to paste into Excel
// @author       roni2026
// @match        *://*/*REQReport.jsp*
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

    // Only inject the button in the frame that actually has the item rows
    // (Birchstreet loads REQReport.jsp inside a frameset).
    function pageHasItems() {
        return document.querySelectorAll('div[name="EditLine"]').length > 0;
    }

    function extractItems() {
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

    // "REQ-MAM-000037427" -> "REQ - 37427" (leading zeros removed, same format as your Excel file)
    function reqShort(full) {
        const digits = full.match(/(\d+)$/);
        return digits ? `REQ - ${parseInt(digits[1], 10)}` : full;
    }

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

    // Column config: width (pixels) + DATA alignment — matches your Test.xlsx layout
    // # | Supplier | Item SKU | Product Desc. | Qty | UOM | Price | REQ
    // (All headers are centered regardless of the align set here.)
    const COLUMNS = [
        { width: 45,  align: 'center' }, // #
        { width: 155, align: 'left'   }, // Supplier (data left, header center)
        { width: 80,  align: 'center' }, // Item SKU
        { width: 365, align: 'left'   }, // Product Desc. (data left, header center)
        { width: 55,  align: 'center' }, // Qty
        { width: 55,  align: 'center' }, // UOM
        { width: 70,  align: 'center' }, // Price
        { width: 100, align: 'center' }, // REQ
    ];

    // 0.5pt = Excel's thin "All Borders" line weight
    const TD_BASE = 'border:0.5pt solid #000000; padding:2px 4px; font-family:Arial; font-size:10pt; white-space:nowrap;';

    // Build a cell with BOTH width attribute and inline width style —
    // Excel only reliably honors pasted column widths when both are present.
    // Headers are ALWAYS centered; data cells use the column's align setting.
    function makeCell(content, colIndex, isHeader) {
        const col = COLUMNS[colIndex];
        const widthAttr = `width="${col.width}"`;
        const widthStyle = `width:${col.width}px;`;
        const bold = isHeader ? ' font-weight:bold;' : '';
        const align = isHeader ? 'center' : col.align;
        return `<td ${widthAttr} style="${TD_BASE}${widthStyle} text-align:${align};${bold}">${content}</td>`;
    }

    function buildHtmlTable(items, reqNum) {
        const reqHeader = reqNum ? escapeHtml(reqShort(reqNum)) : 'REQ #';

        let html = `<table border="1" cellspacing="0" cellpadding="2" style="border-collapse:collapse;">`;

        // Header row (all headers centered)
        html += '<tr>';
        ['#', 'Supplier', 'Item SKU', 'Product Desc.', 'Qty', 'UOM', 'Price'].forEach((h, i) => {
            html += makeCell(escapeHtml(h), i, true);
        });
        html += makeCell(reqHeader, 7, true);
        html += '</tr>';

        // Data rows (alignment per column config)
        items.forEach(i => {
            const row = [i.rowNum, i.supplier, i.itemNum, i.desc, i.qty, i.uom, i.price, '-'];
            html += '<tr>' + row.map((v, c) => makeCell(escapeHtml(v), c, false)).join('') + '</tr>';
        });

        html += '</table>';
        return html;
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

    function exportItems() {
        const items = extractItems();

        if (items.length === 0) {
            showToast('⚠️ No items found on this page.');
            return;
        }

        const reqNum = findReqNumber();
        const html = buildHtmlTable(items, reqNum);

        GM_setClipboard(html, 'html');
        showToast(`✅ Exported ${items.length} item${items.length === 1 ? '' : 's'}${reqNum ? ' (' + reqShort(reqNum) + ')' : ''} to clipboard!`);
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
        if (!pageHasItems()) return;
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
