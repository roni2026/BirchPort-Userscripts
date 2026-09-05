// ==UserScript==
// @name         Auto Highlight REQ / PO / Supplier / Subject
// @namespace    github.com/roni2026
// @version      1.0
// @description  Highlights REQ number, PO number, supplier name and Subject text in light green
// @match        *://*/*
// @run-at       document-idle
// @grant        none
// ==/UserScript==

(function () {
    'use strict';

    const HL_CLASS = 'tm-auto-highlight';
    const HL_STYLE = 'background-color: #b5ff36; padding: 0 2px; border-radius: 2px;';

    function highlight(node, start, end) {
        if (end <= start) return;
        const range = document.createRange();
        range.setStart(node, start);
        range.setEnd(node, end);
        const span = document.createElement('span');
        span.className = HL_CLASS;
        span.style.cssText = HL_STYLE;
        range.surroundContents(span);
    }

    let pendingSubject = false; // set when a bare "Subject:" label is seen

    function processNode(node) {
        const text = node.nodeValue;
        const trimmed = text.trim();

        // Previous node was a bare "Subject:" label -> highlight this (the value) node
        if (pendingSubject) {
            if (!trimmed) return;
            const lead = text.length - text.trimStart().length;
            highlight(node, lead, text.length);
            pendingSubject = false;
            return;
        }

        // This node is ONLY the "Subject:" label -> wait for the value node
        if (/^Subject:\s*$/i.test(trimmed)) {
            pendingSubject = true;
            return;
        }

        // REQ-MAM-000037427 -> highlight "37427"
        let m = text.match(/REQ-[A-Z0-9]+-0*(\d+)/);
        if (m) {
            const start = m.index + m[0].lastIndexOf(m[1]);
            highlight(node, start, start + m[1].length);
            return;
        }

        // PO-MAM-000021194 -> highlight "21194"
        m = text.match(/PO-[A-Z0-9]+-0*(\d+)/);
        if (m) {
            const start = m.index + m[0].lastIndexOf(m[1]);
            highlight(node, start, start + m[1].length);
            return;
        }

        // Supplier:  NAME -> highlight name only
        m = text.match(/Supplier:\s*\u00A0*\s*(.+)$/);
        if (m) {
            const start = m.index + m[0].length - m[1].length;
            highlight(node, start, text.length);
            return;
        }

        // "Subject: value" in the same node -> highlight after the colon
        m = text.match(/Subject:\s*(.+)$/);
        if (m && m[1].trim()) {
            const start = m.index + m[0].length - m[1].length;
            highlight(node, start, text.length);
            return;
        }
    }

    function scan() {
        const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
            acceptNode(n) {
                const p = n.parentElement;
                if (!p) return NodeFilter.FILTER_REJECT;
                if (/^(SCRIPT|STYLE|NOSCRIPT)$/.test(p.tagName)) return NodeFilter.FILTER_REJECT;
                if (p.classList && p.classList.contains(HL_CLASS)) return NodeFilter.FILTER_REJECT;
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

    scan(); // first pass

    // re-scan on dynamic content changes
    let timer = null;
    new MutationObserver((muts) => {
        if (!muts.some(mu => [...mu.addedNodes].some(nd => nd.nodeType <= 3))) return;
        clearTimeout(timer);
        timer = setTimeout(scan, 300);
    }).observe(document.body, { childList: true, subtree: true });
})();
