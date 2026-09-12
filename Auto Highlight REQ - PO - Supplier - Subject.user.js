// ==UserScript==
// @name         Auto Highlight REQ / PO / Supplier / Subject
// @namespace    github.com/roni2026
// @version      2.0
// @description  Highlights REQ number, PO number & Subject by row Status (green=New, amber=Document generated, yellow=Approval pending, light blue=Approved / Approved w/changes, orange=Fax/email/csv accepted), plus generic Supplier/Subject highlighting on non-grid pages. REQ/PO number AND Subject highlight only apply when the row's REQ TYPE (or PO TYPE) is "Standard" - Storeroom rows are never highlighted. Works on both REQ list grids and PO list grids; on PO grids the Subject column is really "Subj / Supplier" (Subject text plus a bold supplier name), so both pieces get highlighted.
// @match        https://*.birchstreetsystems.com/*
// @run-at       document-idle
// @grant        none
// ==/UserScript==
(function () {
    'use strict';

    // Generic highlight (Supplier, bare "Subject:" value, REQ/PO with no status row)
    const HL_CLASS = 'tm-auto-highlight';
    const HL_STYLE = 'background-color: #b5ff36; padding: 0 2px; border-radius: 2px;';

    // Status-based highlight for REQ number / PO number / Subject on grid rows.
    const HL_STATUS_CLASS = 'tm-auto-highlight-status';

    const STATUS_COLORS = {
        'new': '#b5ff36', // green
        'document generated': '#ffb347', // amber
        'approval pending': '#ffff00', // yellow
        'approved': '#87cefa', // light blue
        'approved w/changes': '#87cefa', // light blue
        'approved w/ changes': '#87cefa', // light blue (space variant, just in case)
        'fax/email/csv accepted': '#ffa500', // orange
    };

    const ALL_HL_CLASSES = [HL_CLASS, HL_STATUS_CLASS];

    function styleFor(color) {
        return `background-color: ${color}; padding: 0 2px; border-radius: 2px;`;
    }

    function highlight(node, start, end, cls, style) {
        if (end <= start) return;
        const range = document.createRange();
        range.setStart(node, start);
        range.setEnd(node, end);
        const span = document.createElement('span');
        span.className = cls;
        span.style.cssText = style;
        range.surroundContents(span);
    }

    // Look up a labeled cell (e.g. STATUS, REQ_TYPE, PO_TYPE) for the row this text node lives in.
    function getRowCellText(node, idPrefix) {
        const el = node.parentElement;
        const row = el && el.closest('tr');
        if (!row) return null;
        const cell = row.querySelector(`td[id^="${idPrefix}"]`);
        if (!cell) return null;
        return cell.textContent.trim();
    }

    // Which kind of grid is this row from?
    // REQ grids: row has a (visible) REQ_NUMBER cell and no PO_NUMBER cell.
    // PO grids: row has a PO_NUMBER cell (REQ_NUMBER, if present, is a hidden reference column).
    // Check PO_NUMBER first since PO rows carry both.
    function getRowGridType(row) {
        if (!row) return null;
        if (row.querySelector('td[id^="PO_NUMBER"]')) return 'po';
        if (row.querySelector('td[id^="REQ_NUMBER"]')) return 'req';
        return null;
    }

    function getGridTypeForNode(node) {
        const row = node.parentElement && node.parentElement.closest('tr');
        return getRowGridType(row);
    }

    // Is this row's REQ TYPE "Standard"?
    // This restriction is a REQ-grid concept only - Storeroom REQs are never highlighted.
    // PO grids don't carry a real Standard/Storeroom signal on PO_TYPE, so PO rows are
    // never restricted by this check; only their Status color/mapping decides.
    function isStandardTypeRow(node) {
        const gridType = getGridTypeForNode(node);
        if (gridType === 'po') return true; // no Standard/Storeroom restriction on PO grids
        const type = getRowCellText(node, 'REQ_TYPE');
        if (type === null) return true; // no REQ_TYPE column on this row/page -> don't restrict
        return type.trim().toLowerCase() === 'standard';
    }

    // Decide which highlight applies, based on the row's Status.
    // Returns:
    //   {cls, style}      - status found and mapped -> use this color
    //   {blocked: true}   - a STATUS cell exists but its value isn't in STATUS_COLORS
    //                       (e.g. "PO Closed", "Partially received") -> never highlight, no fallback
    //   null              - no STATUS cell/row at all (non-grid context) -> caller may use a generic fallback
    function getStatusHighlight(node) {
        const status = getRowCellText(node, 'STATUS');
        if (status === null) return null;

        const key = status.trim().toLowerCase().replace(/\s+/g, ' ');
        const color = STATUS_COLORS[key];
        if (!color) return { blocked: true }; // unmapped status -> explicitly no highlight, ever

        return { cls: HL_STATUS_CLASS, style: styleFor(color) };
    }

    let pendingSubject = false; // set when a bare "Subject:" label is seen
    let pendingSupplier = false; // set when a bare "Supplier:" label is seen

    function processNode(node) {
        const text = node.nodeValue;
        const trimmed = text.trim();
        const parentEl = node.parentElement;

        // Grid Subject cell.
        // REQ grids:  <td id="SUBJECT1">Store General Order ...</td>            -> one text node, direct child of the TD.
        // PO grids:   <td id="SUBJECT141">Main Kitchen Food REQ...<br><b>SUPPLIER NAME</b></td>
        //             -> this column is really "Subj / Supplier", so the supplier name is a second
        //             text node sitting inside a <b>, not a direct child of the TD. closest() finds
        //             the SUBJECT td either way, so the same status-color logic covers both grid types.
        const subjectTd = parentEl && parentEl.closest && parentEl.closest('td[id^="SUBJECT"]');
        if (subjectTd) {
            if (!trimmed) return;
            if (!isStandardTypeRow(node)) return;
            const hl = getStatusHighlight(node);
            if (!hl || hl.blocked) return;
            const lead = text.length - text.trimStart().length;
            const trail = text.length - text.trimEnd().length;
            highlight(node, lead, text.length - trail, hl.cls, hl.style);
            return;
        }

        // Previous node was a bare "Supplier:" label -> highlight this (the value) node
        if (pendingSupplier) {
            if (!trimmed) return;
            const lead = text.length - text.trimStart().length;
            highlight(node, lead, text.length, HL_CLASS, HL_STYLE);
            pendingSupplier = false;
            return;
        }
        // This node is ONLY the "Supplier:" label -> wait for the value node
        if (/^Supplier:\s*$/i.test(trimmed)) {
            pendingSupplier = true;
            return;
        }

        // Previous node was a bare "Subject:" label -> highlight this (the value) node
        if (pendingSubject) {
            if (!trimmed) return;
            const lead = text.length - text.trimStart().length;
            highlight(node, lead, text.length, HL_CLASS, HL_STYLE);
            pendingSubject = false;
            return;
        }
        // This node is ONLY the "Subject:" label -> wait for the value node
        if (/^Subject:\s*$/i.test(trimmed)) {
            pendingSubject = true;
            return;
        }

        // REQ-MAM-000037578 -> highlight "37578". Only highlighted when this row's
        // REQ TYPE is "Standard" - Storeroom rows are left completely untouched.
        // On a PO grid, REQ_NUMBER is only a hidden cross-reference column - skip it there.
        let m = text.match(/REQ-[A-Z0-9]+-0*(\d+)/);
        if (m) {
            if (getGridTypeForNode(node) === 'po') return;
            if (!isStandardTypeRow(node)) return;
            const hl = getStatusHighlight(node);
            if (hl && hl.blocked) return; // status found but unmapped (e.g. PO Closed) -> never highlight
            const finalHl = hl || { cls: HL_CLASS, style: HL_STYLE }; // no STATUS column at all -> generic fallback
            const start = m.index + m[0].lastIndexOf(m[1]);
            highlight(node, start, start + m[1].length, finalHl.cls, finalHl.style);
            return;
        }

        // PO-MAM-000021308 -> highlight "21308". Same Standard-only restriction.
        // (On a REQ grid there's no PO number column, so this is effectively a no-op there anyway.)
        m = text.match(/PO-[A-Z0-9]+-0*(\d+)/);
        if (m) {
            if (getGridTypeForNode(node) === 'req') return;
            if (!isStandardTypeRow(node)) return;
            const hl = getStatusHighlight(node);
            if (hl && hl.blocked) return; // status found but unmapped (e.g. PO Closed, Partially received) -> never highlight
            const finalHl = hl || { cls: HL_CLASS, style: HL_STYLE }; // no STATUS column at all -> generic fallback
            const start = m.index + m[0].lastIndexOf(m[1]);
            highlight(node, start, start + m[1].length, finalHl.cls, finalHl.style);
            return;
        }

        // Supplier:  NAME -> highlight name only (same-node case, generic)
        m = text.match(/Supplier:\s*\u00A0*\s*(.+)$/);
        if (m) {
            const start = m.index + m[0].length - m[1].length;
            highlight(node, start, text.length, HL_CLASS, HL_STYLE);
            return;
        }

        // "Subject: value" in the same node -> highlight after the colon (generic)
        m = text.match(/Subject:\s*(.+)$/);
        if (m && m[1].trim()) {
            const start = m.index + m[0].length - m[1].length;
            highlight(node, start, text.length, HL_CLASS, HL_STYLE);
            return;
        }
    }

    function scan(root) {
        pendingSubject = false; // never carry state across scan passes
        pendingSupplier = false;
        const walker = document.createTreeWalker(root || document.body, NodeFilter.SHOW_TEXT, {
            acceptNode(n) {
                const p = n.parentElement;
                if (!p) return NodeFilter.FILTER_REJECT;
                if (/^(SCRIPT|STYLE|NOSCRIPT)$/.test(p.tagName)) return NodeFilter.FILTER_REJECT;
                if (p.classList && ALL_HL_CLASSES.some(c => p.classList.contains(c))) return NodeFilter.FILTER_REJECT;
                return NodeFilter.FILTER_ACCEPT;
            }
        });
        const nodes = [];
        let n;
        while ((n = walker.nextNode())) nodes.push(n);
        for (const node of nodes) {
            try { processNode(node); } catch (e) { /* ignore */ }
        }
    }

    scan(document.body); // first pass

    // Re-scan only the subtrees that actually changed, batched with a debounce.
    const pendingRoots = new Set();
    let timer = null;

    new MutationObserver((muts) => {
        let found = false;
        for (const mu of muts) {
            for (const nd of mu.addedNodes) {
                if (nd.nodeType === 1) {
                    pendingRoots.add(nd);
                    found = true;
                } else if (nd.nodeType === 3 && nd.parentElement) {
                    pendingRoots.add(nd.parentElement);
                    found = true;
                }
            }
        }
        if (!found) return;
        clearTimeout(timer);
        timer = setTimeout(() => {
            const roots = [...pendingRoots];
            pendingRoots.clear();
            for (const root of roots) {
                if (root && document.body.contains(root)) scan(root);
            }
        }, 300);
    }).observe(document.body, { childList: true, subtree: true });
})();