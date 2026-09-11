// ==UserScript==
// @name         Auto Highlight REQ / PO / Supplier / Subject
// @namespace    github.com/roni2026
// @version      1.7
// @description  Highlights REQ number, PO number & Subject by row Status (green=New, amber=Document generated, yellow=Approval pending, light blue=Approved / Approved w/changes, orange=Fax/email/csv accepted), plus generic Supplier/Subject highlighting on non-grid pages. REQ/PO number AND Subject highlight only apply when the row's REQ TYPE is "Standard" - Storeroom rows are never highlighted.
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

    // Is this row's REQ TYPE (or PO TYPE, if present) "Standard"?
    // If neither column exists on the row (e.g. detail/non-grid page), treat as not-restricted -> true.
    function isStandardTypeRow(node) {
        let type = getRowCellText(node, 'REQ_TYPE');
        if (type === null) type = getRowCellText(node, 'PO_TYPE');
        if (type === null) return true; // no type column on this row/page -> don't restrict
        return type.trim().toLowerCase() === 'standard';
    }

    // Decide which highlight applies, based on the row's Status.
    // Returns {cls, style} from STATUS_COLORS, or null if no row/no STATUS cell/unmapped status.
    function getStatusHighlight(node) {
        const status = getRowCellText(node, 'STATUS');
        if (status === null) return null;

        const key = status.trim().toLowerCase().replace(/\s+/g, ' ');
        const color = STATUS_COLORS[key];
        if (!color) return null; // unmapped status -> no highlight

        return { cls: HL_STATUS_CLASS, style: styleFor(color) };
    }

    let pendingSubject = false;  // set when a bare "Subject:" label is seen
    let pendingSupplier = false; // set when a bare "Supplier:" label is seen

    function processNode(node) {
        const text = node.nodeValue;
        const trimmed = text.trim();
        const parentEl = node.parentElement;

        // Grid Subject cell: <td id="SUBJECT1">Store General Order ...</td>
        if (parentEl && parentEl.tagName === 'TD' && /^SUBJECT\d*$/i.test(parentEl.id)) {
            if (!trimmed) return;
            if (!isStandardTypeRow(node)) return;
            const hl = getStatusHighlight(node);
            if (!hl) return;
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
        let m = text.match(/REQ-[A-Z0-9]+-0*(\d+)/);
        if (m) {
            if (!isStandardTypeRow(node)) return;
            const hl = getStatusHighlight(node) || { cls: HL_CLASS, style: HL_STYLE };
            const start = m.index + m[0].lastIndexOf(m[1]);
            highlight(node, start, start + m[1].length, hl.cls, hl.style);
            return;
        }

        // PO-MAM-000021308 -> highlight "21308". Same Standard-only restriction.
        m = text.match(/PO-[A-Z0-9]+-0*(\d+)/);
        if (m) {
            if (!isStandardTypeRow(node)) return;
            const hl = getStatusHighlight(node) || { cls: HL_CLASS, style: HL_STYLE };
            const start = m.index + m[0].lastIndexOf(m[1]);
            highlight(node, start, start + m[1].length, hl.cls, hl.style);
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
        pendingSubject = false;  // never carry state across scan passes
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