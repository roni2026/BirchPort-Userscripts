// ==UserScript==
// @name         REQ GL Account Dept Destination Auto Filler
// @namespace    roni2026
// @version      1.0
// @description  Auto-fills Purchase Type, Department, GL Account and Destination based on the Subject field
// @match        https://*.birchstreetsystems.com/*
// @run-at       document-idle
// @grant        none
// ==/UserScript==

(function () {
    'use strict';

    // ---------------------------------------------------------------
    // Lookup table built from your Subject list.
    // "type" maps to the <select id="prodType"> option values:
    //   1 = Food, 2 = Beverage, 3 = General
    // ---------------------------------------------------------------
    const SUBJECT_MAP = {
        'MK FOOD':         { type: '1', dept: '8650390', gl: '6031', dest: '7732' },
        'SK FOOD':         { type: '1', dept: '8650900', gl: '6031', dest: '7733' },
        'OTC':             { type: '3', dept: '8650535', gl: '6090.501101', dest: '7725' },
        'SPA':             { type: '3', dept: '8650060', gl: '6090.501101', dest: '7734' },
        'STORE BEV BOND':       { type: '2', dept: '8650000', gl: '1405.000021', dest: '7737' },
        'STORE BEVERAGE BOND':  { type: '2', dept: '8650000', gl: '1405.000021', dest: '7737' }, // alt spelling of STORE BEV BOND
        'STORE BEV':            { type: '2', dept: '8650000', gl: '1405.000032', dest: '7737' },
        'STORE BEVERAGE':       { type: '2', dept: '8650000', gl: '1405.000032', dest: '7737' }, // alt spelling of STORE BEV
        'STORE FOOD':      { type: '1', dept: '8650000', gl: '1405.000031', dest: '7738' },
        'STORE GEN':       { type: '3', dept: '8650000', gl: '1415', dest: '7739' },
        'ENGINEERING':     { type: '3', dept: '8650000', gl: '1415', dest: '10528' },
        'HUMAN RESOURCES': { type: '3', dept: '8650000', gl: '1415', dest: '10528' },
        'HUMAN RESORCES':  { type: '3', dept: '8650000', gl: '1415', dest: '10528' }, // matches the typo in the source table
        'HOUSE KEEPING':   { type: '3', dept: '8650000', gl: '1415', dest: '10528' },
        'FRONT OFFICE':    { type: '3', dept: '8650000', gl: '1415', dest: '10528' },
        'CLINIC':          { type: '3', dept: '8650928', gl: '7010', dest: '7735' },
        'HOST SHOP':       { type: '3', dept: '8650536', gl: '6090.501101', dest: '7723' },
    };

    const DELAY_MS = 200; // gap between each field so the page's own AJAX lookups (ValFK_RetFKDesc) can finish

    function delay(ms) {
        return new Promise((resolve) => setTimeout(resolve, ms));
    }

    // Sets a value the "native" way (so any framework/getters on the element still see the change)
    // and fires a real change event so the page's inline onchange="..." handlers run.
    function setValueAndFireChange(el, value) {
        const proto = el.tagName === 'SELECT' ? window.HTMLSelectElement.prototype : window.HTMLInputElement.prototype;
        const nativeSetter = Object.getOwnPropertyDescriptor(proto, 'value').set;
        nativeSetter.call(el, value);
        el.dispatchEvent(new Event('change', { bubbles: true }));
    }

    function normalize(str) {
        return (str || '').trim().toUpperCase();
    }

    // Keys sorted longest-first so a more specific subject (e.g. "STORE BEV BOND")
    // is matched before a shorter one it contains (e.g. "STORE BEV").
    const SORTED_KEYS = Object.keys(SUBJECT_MAP).sort((a, b) => b.length - a.length);

    // Case-insensitive keyword search: finds the SUBJECT_MAP entry whose key
    // appears anywhere inside whatever the user typed (e.g. "For MK Food 14-09-26").
    function findMatch(rawText) {
        const normalizedInput = normalize(rawText);
        if (!normalizedInput) return null;
        for (const key of SORTED_KEYS) {
            if (normalizedInput.includes(key)) {
                return SUBJECT_MAP[key];
            }
        }
        return null;
    }

    async function autoFillFromSubject(subjectEl) {
        const match = findMatch(subjectEl.value);
        if (!match) return;

        const prodTypeEl = document.getElementById('prodType');
        const departmentEl = document.getElementById('department');
        const glAccountEl = document.getElementById('glaccount');
        const destLocEl = document.getElementById('DestLoc');

        if (prodTypeEl) {
            setValueAndFireChange(prodTypeEl, match.type);
            await delay(DELAY_MS);
        }
        if (departmentEl) {
            setValueAndFireChange(departmentEl, match.dept);
            await delay(DELAY_MS);
        }
        if (glAccountEl) {
            // Set after prodType's change handler (setDefaultGL) so our value wins over any default GL.
            setValueAndFireChange(glAccountEl, match.gl);
            await delay(DELAY_MS);
        }
        if (destLocEl) {
            setValueAndFireChange(destLocEl, match.dest);
        }
    }

    // Event delegation: works even if the form is (re)loaded via AJAX after this script runs.
    document.addEventListener(
        'change',
        (event) => {
            const target = event.target;
            if (target && target.id === 'subject') {
                autoFillFromSubject(target);
            }
        },
        true // capture phase, so we still catch it alongside the inline onchange handler
    );
})();