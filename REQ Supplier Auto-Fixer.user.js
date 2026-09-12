// ==UserScript==
// @name         REQ Supplier Auto-Fixer
// @namespace    userscript-req-supplier-fix
// @version      4.1
// @description  Smart REQ supplier fixer: skips lines already on the requested supplier, learns when a supplier is not offered for a SKU so it never retries that impossible selection after reloads, supports SKU→Supplier Excel paste, robust supplier-name matching, confirmation, dry-run, audit log, and the guided tax-code NA fix. Faster: no arbitrary fixed delays, waits only for content to populate. No "clear unavailable" button (close the tab to reset).
// @match        https://*.birchstreetsystems.com/*
// @grant        unsafeWindow
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';

  // ------------------------------------------------------------------
  // IMPORTANT: this script is injected into every birchstreetsystems.com
  // page, including the Edit Line and Change Supplier popups it opens.
  // ------------------------------------------------------------------
  if (!/REQReport\.jsp/i.test(location.pathname)) {
    return;
  }

  const uw = unsafeWindow;
  let running = false;
  let stopRequested = false;

  function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }

  // Faster polling: check every 100ms instead of 200ms.
  function waitFor(checkFn, { timeout = 15000, interval = 100 } = {}) {
    return new Promise((resolve, reject) => {
      const start = Date.now();
      const timer = setInterval(() => {
        let val;
        try {
          val = checkFn();
        } catch (e) {
          val = null;
        }

        if (val) {
          clearInterval(timer);
          resolve(val);
        } else if (Date.now() - start > timeout) {
          clearInterval(timer);
          reject(new Error('Timed out waiting for condition'));
        }
      }, interval);
    });
  }

  function waitForWindowLoaded(getWin, extraCheck, opts) {
    return waitFor(() => {
      const w = getWin();

      if (!w || w.closed) return null;
      if (!w.document || w.document.readyState !== 'complete') return null;
      if (extraCheck && !extraCheck(w)) return null;

      return w;
    }, opts);
  }

  function waitForClosed(getWin, opts) {
    return waitFor(() => {
      const w = getWin();
      return !w || w.closed ? true : null;
    }, opts);
  }

  function isVisible(el) {
    if (!el) return false;

    const view = el.ownerDocument &&
      el.ownerDocument.defaultView;

    if (!view) return false;

    const style = view.getComputedStyle(el);

    if (
      style.display === 'none' ||
      style.visibility === 'hidden'
    ) {
      return false;
    }

    return true;
  }

  // ------------------------------------------------------------------
  // Resume state
  // ------------------------------------------------------------------

  const RESUME_KEY = 'rsf_resume_state_v2';
  const LOG_KEY = 'rsf_audit_log_v1';
  const UNAVAILABLE_KEY = 'rsf_unavailable_suppliers_v1';

  const RESUME_MAX_AGE_MS = 3 * 60 * 1000;
  const UNAVAILABLE_MAX_AGE_MS = 30 * 60 * 1000;

  function unavailableKey(item, target) {
    const sku =
      normalizeSku(item && item.sku) ||
      `LINE:${item && item.line ? item.line : ''}`;

    return `${sku}::${String(target || '').trim().toLowerCase()}`;
  }

  function loadUnavailable() {
    try {
      const raw = sessionStorage.getItem(UNAVAILABLE_KEY);

      if (!raw) return {};

      const data = JSON.parse(raw);

      if (!data || typeof data !== 'object') {
        return {};
      }

      const now = Date.now();
      let changed = false;

      Object.keys(data).forEach((k) => {
        if (
          !data[k] ||
          now - data[k].ts > UNAVAILABLE_MAX_AGE_MS
        ) {
          delete data[k];
          changed = true;
        }
      });

      if (changed) {
        sessionStorage.setItem(
          UNAVAILABLE_KEY,
          JSON.stringify(data)
        );
      }

      return data;
    } catch (e) {
      return {};
    }
  }

  function isUnavailable(item, target) {
    return !!loadUnavailable()[
      unavailableKey(item, target)
    ];
  }

  function rememberUnavailable(item, target, reason) {
    try {
      const data = loadUnavailable();

      data[unavailableKey(item, target)] = {
        ts: Date.now(),
        line: item && item.line,
        sku: item && item.sku,
        target: String(target || ''),
        reason: reason || 'not offered'
      };

      sessionStorage.setItem(
        UNAVAILABLE_KEY,
        JSON.stringify(data)
      );
    } catch (e) {
      // Ignore storage errors.
    }
  }

  function saveResumeState(
    mode,
    maxLines,
    remainingBudget
  ) {
    try {
      const serializedMode =
        mode.type === 'mapping'
          ? {
              type: 'mapping',
              entries: Array.from(mode.map.entries())
            }
          : {
              type: 'single',
              targetId: mode.targetId,
              skuFilters: mode.skuFilters || []
            };

      sessionStorage.setItem(
        RESUME_KEY,
        JSON.stringify({
          mode: serializedMode,
          maxLines,
          remainingBudget,
          ts: Date.now()
        })
      );
    } catch (e) {
      // Ignore storage errors.
    }
  }

  function clearResumeState() {
    try {
      sessionStorage.removeItem(RESUME_KEY);
    } catch (e) {
      // Ignore.
    }
  }

  function loadResumeState() {
    try {
      const raw =
        sessionStorage.getItem(RESUME_KEY);

      if (!raw) return null;

      const parsed = JSON.parse(raw);

      if (
        !parsed ||
        !parsed.mode ||
        Date.now() - parsed.ts >
          RESUME_MAX_AGE_MS
      ) {
        clearResumeState();
        return null;
      }

      const mode =
        parsed.mode.type === 'mapping'
          ? {
              type: 'mapping',
              map: new Map(
                parsed.mode.entries || []
              )
            }
          : {
              type: 'single',
              targetId: parsed.mode.targetId,
              skuFilters:
                parsed.mode.skuFilters || []
            };

      return {
        mode,
        maxLines: parsed.maxLines,
        remainingBudget:
          parsed.remainingBudget
      };
    } catch (e) {
      return null;
    }
  }

  // ------------------------------------------------------------------
  // Audit log
  // ------------------------------------------------------------------

  function loadLog() {
    try {
      const raw = sessionStorage.getItem(LOG_KEY);
      return raw ? JSON.parse(raw) : [];
    } catch (e) {
      return [];
    }
  }

  function appendLog(entry) {
    try {
      const log = loadLog();

      log.push(
        Object.assign(
          {
            time: new Date().toISOString()
          },
          entry
        )
      );

      sessionStorage.setItem(
        LOG_KEY,
        JSON.stringify(log)
      );

      return log;
    } catch (e) {
      return loadLog();
    }
  }

  function clearLogStorage() {
    try {
      sessionStorage.removeItem(LOG_KEY);
    } catch (e) {
      // Ignore.
    }
  }

  // ------------------------------------------------------------------
  // Automatic tax-code NA
  // ------------------------------------------------------------------

  const AUTO_TAX_NA_KEY =
    'rsf_auto_tax_na_v1';

  function getAutoTaxNa() {
    try {
      return (
        sessionStorage.getItem(
          AUTO_TAX_NA_KEY
        ) === '1'
      );
    } catch (e) {
      return false;
    }
  }

  function setAutoTaxNa(on) {
    try {
      if (on) {
        sessionStorage.setItem(
          AUTO_TAX_NA_KEY,
          '1'
        );
      } else {
        sessionStorage.removeItem(
          AUTO_TAX_NA_KEY
        );
      }
    } catch (e) {
      // Ignore.
    }
  }

  // ------------------------------------------------------------------
  // Promise helpers
  // ------------------------------------------------------------------

  function raceFirstResolved(promises) {
    return new Promise((resolve, reject) => {
      let remaining = promises.length;
      let lastErr;

      promises.forEach((p) => {
        p.then(resolve).catch((e) => {
          lastErr = e;
          remaining -= 1;

          if (remaining === 0) {
            reject(lastErr);
          }
        });
      });
    });
  }

  function hookNextOpen(winCtx) {
    return new Promise((resolve, reject) => {
      const orig = winCtx.open;

      const timer = setTimeout(() => {
        winCtx.open = orig;

        reject(
          new Error(
            'Timed out waiting for a popup to open (check popup blocker!)'
          )
        );
      }, 15000);

      winCtx.open = function (...args) {
        const w = orig.apply(this, args);

        winCtx.open = orig;
        clearTimeout(timer);

        resolve(w);

        return w;
      };
    });
  }

  // ------------------------------------------------------------------
  // Supplier matching
  // ------------------------------------------------------------------

  function isNumericId(s) {
    return /^\d+$/.test(
      String(s || '').trim()
    );
  }

  function normalizeSupplierName(s) {
    return String(
      s == null ? '' : s
    )
      .replace(/&nbsp;/gi, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .toLowerCase()
      .replace(
        /[.,/\\()[\]{}:_-]+/g,
        ' '
      )
      .replace(/\s+/g, ' ')
      .trim();
  }

  function supplierNameMatches(actual, target) {
    const a = normalizeSupplierName(actual);
    const t = normalizeSupplierName(target);

    if (!a || !t) return false;

    if (a === t) return true;

    if (
      t.length >= 4 &&
      (a.includes(t) || t.includes(a))
    ) {
      return true;
    }

    const at = new Set(
      a.split(' ').filter(Boolean)
    );

    const tt =
      t.split(' ').filter(Boolean);

    if (
      tt.length >= 2 &&
      tt.every((x) => at.has(x))
    ) {
      return true;
    }

    return false;
  }

  function itemMatchesTarget(item, target) {
    if (isNumericId(target)) {
      return (
        String(
          item && item.supplierId || ''
        ).trim() ===
        String(target).trim()
      );
    }

    if (
      supplierNameMatches(
        item && item.supplierName,
        target
      )
    ) {
      return true;
    }

    const candidates =
      item &&
      Array.isArray(
        item.supplierNameCandidates
      )
        ? item.supplierNameCandidates
        : [];

    return candidates.some(
      (name) =>
        supplierNameMatches(
          name,
          target
        )
    );
  }

  function findMatchingInfoCell(
    suppWinDoc,
    target
  ) {
    const infoCells =
      Array.from(
        suppWinDoc.querySelectorAll(
          'td[id^="info"]'
        )
      );

    if (isNumericId(target)) {
      return (
        infoCells.find(
          (td) =>
            td.getAttribute(
              'supplier_comp_id'
            ) ===
            String(target).trim()
        ) || null
      );
    }

    return (
      infoCells.find((td) => {
        const idx =
          td.id.replace(
            'info',
            ''
          );

        const nameCell =
          suppWinDoc.getElementById(
            'compName' + idx
          );

        const name =
          (
            nameCell &&
            (
              nameCell.getAttribute(
                'compname'
              ) ||
              nameCell.textContent
            )
          ) ||
          td.getAttribute(
            'compname'
          ) ||
          td.textContent ||
          '';

        return supplierNameMatches(
          name,
          target
        );
      }) || null
    );
  }

  // ------------------------------------------------------------------
  // SKU normalization
  // ------------------------------------------------------------------

  function normalizeSku(s) {
    if (
      s === undefined ||
      s === null
    ) {
      return '';
    }

    const digits =
      String(s).replace(
        /\D/g,
        ''
      );

    if (!digits) return '';

    return digits.replace(
      /^0+(?=\d)/,
      ''
    );
  }

  function skuKeysEqual(a, b) {
    if (a === b) return true;

    if (!a || !b) return false;

    const len =
      Math.max(
        a.length,
        b.length
      );

    if (
      a.padStart(len, '0') ===
      b.padStart(len, '0')
    ) {
      return true;
    }

    const MIN_SUFFIX_LEN = 5;

    if (
      a.length >= MIN_SUFFIX_LEN &&
      b.length >= MIN_SUFFIX_LEN &&
      (
        a.endsWith(b) ||
        b.endsWith(a)
      )
    ) {
      return true;
    }

    return false;
  }

  function lookupMappingEntry(
    map,
    sku
  ) {
    if (!sku) return null;

    if (map.has(sku)) {
      return {
        key: sku,
        target: map.get(sku)
      };
    }

    for (const [k, v] of map) {
      if (skuKeysEqual(k, sku)) {
        return {
          key: k,
          target: v
        };
      }
    }

    return null;
  }

  // ------------------------------------------------------------------
  // SKU → Supplier mapping
  // ------------------------------------------------------------------

  function isMappingPaste(text) {
    return /\t/.test(text);
  }

  function parseMappingPaste(text) {
    let rows =
      text
        .split(/\r\n|\r|\n/)
        .map((l) => l.trim())
        .filter(Boolean)
        .map((l) => l.split('\t'));

    if (!rows.length) {
      return {
        map: new Map(),
        totalRows: 0,
        blankSkipped: 0,
        badRows: 0,
        skuCol: -1,
        suppCol: -1
      };
    }

    const maxCols =
      Math.max.apply(
        null,
        rows.map(
          (r) => r.length
        )
      );

    let skuCol = -1;
    let bestScore = 0;

    for (
      let c = 0;
      c < maxCols;
      c++
    ) {
      let score = 0;

      rows.forEach((r) => {
        const v =
          (r[c] || '').trim();

        if (/^\d+$/.test(v)) {
          score += v.length;
        }
      });

      if (score > bestScore) {
        bestScore = score;
        skuCol = c;
      }
    }

    if (skuCol < 0) {
      skuCol = 2;
    }

    if (
      !/^\d+$/.test(
        (rows[0][skuCol] || '')
          .trim()
      )
    ) {
      rows = rows.slice(1);
    }

    if (!rows.length) {
      return {
        map: new Map(),
        totalRows: 0,
        blankSkipped: 0,
        badRows: 0,
        skuCol,
        suppCol: -1
      };
    }

    const pickSuppCol = (cols) => {
      let c = cols.length - 1;

      if (
        /^\s*edit\s*line\s*$/i.test(
          cols[c] || ''
        ) &&
        cols.length >= 7
      ) {
        c = 6;
      }

      return c;
    };

    const suppCol =
      pickSuppCol(rows[0]);

    const map = new Map();

    let totalRows = 0;
    let blankSkipped = 0;
    let badRows = 0;

    rows.forEach((cols) => {
      totalRows += 1;

      const sku =
        normalizeSku(
          cols[skuCol]
        );

      const correctSupplier =
        (
          cols[
            pickSuppCol(cols)
          ] || ''
        ).trim();

      if (!sku) {
        badRows += 1;
        return;
      }

      if (!correctSupplier) {
        blankSkipped += 1;
        return;
      }

      map.set(
        sku,
        correctSupplier
      );
    });

    return {
      map,
      totalRows,
      blankSkipped,
      badRows,
      skuCol,
      suppCol
    };
  }

  // ------------------------------------------------------------------
  // Build plan
  // ------------------------------------------------------------------

  function buildPlan(
    allItems,
    mode
  ) {
    const matched = [];
    const toFix = [];
    const unavailable = [];
    const notOnPage = [];

    if (
      mode.type === 'mapping'
    ) {
      const usedKeys =
        new Set();

      allItems.forEach((it) => {
        const sku =
          normalizeSku(it.sku);

        const hit =
          lookupMappingEntry(
            mode.map,
            sku
          );

        if (!hit) return;

        usedKeys.add(hit.key);

        if (
          itemMatchesTarget(
            it,
            hit.target
          )
        ) {
          matched.push({
            item: it,
            target: hit.target
          });
        } else if (
          isUnavailable(
            it,
            hit.target
          )
        ) {
          unavailable.push({
            item: it,
            target: hit.target
          });
        } else {
          toFix.push({
            item: it,
            target: hit.target
          });
        }
      });

      mode.map.forEach(
        (target, key) => {
          if (!usedKeys.has(key)) {
            notOnPage.push(key);
          }
        }
      );
    } else {
      const candidates =
        mode.skuFilters &&
        mode.skuFilters.length
          ? allItems.filter(
              (it) =>
                mode.skuFilters.some(
                  (f) =>
                    skuKeysEqual(
                      f,
                      normalizeSku(
                        it.sku
                      )
                    )
                )
            )
          : allItems;

      candidates.forEach((it) => {
        if (
          itemMatchesTarget(
            it,
            mode.targetId
          )
        ) {
          matched.push({
            item: it,
            target: mode.targetId
          });
        } else if (
          isUnavailable(
            it,
            mode.targetId
          )
        ) {
          unavailable.push({
            item: it,
            target: mode.targetId
          });
        } else {
          toFix.push({
            item: it,
            target: mode.targetId
          });
        }
      });
    }

    return {
      matched,
      toFix,
      unavailable,
      notOnPage
    };
  }

  // ------------------------------------------------------------------
  // Extract SKU
  // ------------------------------------------------------------------

  function extractSku(row) {
    if (!row) return '';

    for (
      let i = 0;
      i < row.children.length;
      i++
    ) {
      const text =
        (
          row.children[i]
            .textContent || ''
        ).trim();

      const m =
        text.match(
          /^\d{9,}$/
        );

      if (m) {
        return m[0];
      }
    }

    const text =
      row.textContent || '';

    const m =
      text.match(
        /\b\d{9,}\b/
      );

    return m ? m[0] : '';
  }

  function escapeHtml(s) {
    return String(
      s == null ? '' : s
    ).replace(
      /[&<>"']/g,
      (c) =>
        ({
          '&': '&amp;',
          '<': '&lt;',
          '>': '&gt;',
          '"': '&quot;',
          "'": '&#39;'
        }[c])
    );
  }

  // ------------------------------------------------------------------
  // Tax code validation
  // ------------------------------------------------------------------

  const TAX_CODE_ALERT_RE =
    /tax code/i;

  function installAlertInterceptor(
    win,
    onAlert
  ) {
    try {
      win.alert = function (msg) {
        onAlert(String(msg));
      };
    } catch (e) {
      // Ignore.
    }
  }

  function applyTaxCodeNaFix(
    editWin
  ) {
    if (editWin.closed) return;

    const doc =
      editWin.document;

    const fill = (id) => {
      const el =
        doc.getElementById(id);

      if (!el) return;

      el.value = 'NA';

      el.dispatchEvent(
        new editWin.Event(
          'change',
          { bubbles: true }
        )
      );
    };

    fill('TaxCode1');
    fill('TaxCode2');

    const saveBtn =
      doc.getElementById(
        'okclick'
      );

    if (saveBtn) {
      saveBtn.click();
    }
  }

  function showTaxCodeFix(
    editWin,
    item,
    alertMsg
  ) {
    return new Promise(
      (resolve) => {
        if (editWin.closed) {
          resolve();
          return;
        }

        const overlay =
          document.createElement(
            'div'
          );

        overlay.id =
          'rsf-tax-overlay';

        overlay.innerHTML = `
          <div id="rsf-tax-box">
            <div class="rsf-c-head">
              ⚠ Tax code required — line ${escapeHtml(item.line)}
            </div>

            <div class="rsf-c-body">
              Birchstreet blocked the save:
              <b>${escapeHtml(alertMsg)}</b>
              <br><br>

              Click <b>NA</b> to set both tax code
              fields to "NA" and retry Save.

              <div class="rsf-c-warn">
                This is remembered for the rest of this run.
              </div>
            </div>

            <div class="rsf-c-btns">
              <button id="rsf-tax-na">
                NA
              </button>
            </div>
          </div>
        `;

        document.body.appendChild(
          overlay
        );

        const cleanup = () => {
          overlay.remove();
          resolve();
        };

        overlay
          .querySelector(
            '#rsf-tax-na'
          )
          .addEventListener(
            'click',
            () => {
              try {
                applyTaxCodeNaFix(
                  editWin
                );
              } catch (e) {
                // Best effort.
              }

              setAutoTaxNa(true);
              cleanup();
            }
          );
      }
    );
  }

  // ------------------------------------------------------------------
  // REQ page parsing
  // ------------------------------------------------------------------

  function findSupplierColumnIndex(
    row
  ) {
    if (
      !row ||
      !row.parentElement
    ) {
      return -1;
    }

    const table =
      row.closest('table');

    if (!table) return -1;

    const headerRows =
      Array.from(
        table.querySelectorAll(
          'thead tr, tr'
        )
      ).slice(0, 8);

    for (const hr of headerRows) {
      const cells =
        Array.from(
          hr.children
        );

      const idx =
        cells.findIndex(
          (cell) => {
            const t =
              (
                cell.textContent ||
                ''
              )
                .replace(
                  /\s+/g,
                  ' '
                )
                .trim()
                .toLowerCase();

            return (
              /^(supplier|supplier name|vendor|vendor name|company|company name)$/.test(t) ||
              /\b(supplier|vendor)\b/.test(t)
            );
          }
        );

      if (idx >= 0) {
        return idx;
      }
    }

    return -1;
  }

  function extractSupplierName(
    row
  ) {
    if (!row) return '';

    const cells =
      Array.from(
        row.children
      );

    const headerIdx =
      findSupplierColumnIndex(
        row
      );

    if (
      headerIdx >= 0 &&
      cells[headerIdx]
    ) {
      const text =
        (
          cells[headerIdx]
            .textContent || ''
        )
          .replace(
            /\s+/g,
            ' '
          )
          .trim();

      if (text) {
        return text;
      }
    }

    if (cells[1]) {
      const text =
        (
          cells[1]
            .textContent || ''
        )
          .replace(
            /\s+/g,
            ' '
          )
          .trim();

      if (text) {
        return text;
      }
    }

    return '';
  }

  function extractSupplierCandidates(
    row
  ) {
    if (!row) return [];

    const cells =
      Array.from(
        row.children
      );

    const preferred = [];

    const headerIdx =
      findSupplierColumnIndex(
        row
      );

    if (
      headerIdx >= 0 &&
      cells[headerIdx]
    ) {
      preferred.push(
        (
          cells[headerIdx]
            .textContent || ''
        )
          .replace(
            /\s+/g,
            ' '
          )
          .trim()
      );
    }

    if (cells[1]) {
      preferred.push(
        (
          cells[1]
            .textContent || ''
        )
          .replace(
            /\s+/g,
            ' '
          )
          .trim()
      );
    }

    return Array.from(
      new Set(
        preferred.filter(Boolean)
      )
    );
  }

  function scanReqLines() {
    const anchors =
      uw.document.querySelectorAll(
        'div[name="EditLine"] a[onclick^="ItemEdit"]'
      );

    const items = [];

    anchors.forEach((a) => {
      const onclick =
        a.getAttribute(
          'onclick'
        ) || '';

      const m =
        onclick.match(
          /ItemEdit\('([^']+)','([^']+)','([^']+)'\)/
        );

      if (!m) return;

      const row =
        a.closest('tr');

      const supplierName =
        extractSupplierName(
          row
        );

      const supplierNameCandidates =
        extractSupplierCandidates(
          row
        );

      const sku =
        extractSku(row);

      items.push({
        reqNumber: m[1],
        line: m[2],
        supplierId: m[3],
        supplierName,
        supplierNameCandidates,
        sku,
        link: a
      });
    });

    return items;
  }

  function verifyLineSupplier(
    item,
    targetId
  ) {
    const current =
      scanReqLines().find(
        (it) =>
          it.line === item.line
      );

    return (
      !!current &&
      itemMatchesTarget(
        current,
        targetId
      )
    );
  }

  // ------------------------------------------------------------------
  // Supplier swap
  // ------------------------------------------------------------------

  async function fixLine(
    item,
    targetId,
    ui
  ) {
    ui.setStatus(
      item.line,
      'processing',
      'Opening line…'
    );

    const editWinPromise =
      hookNextOpen(uw);

    item.link.click();

    const editWin =
      await editWinPromise;

    ui.setStatus(
      item.line,
      'processing',
      'Waiting for line editor…'
    );

    // Wait only until the Change Supplier button is actually
    // present and visible — no extra fixed delay.
    await waitForWindowLoaded(
      () => editWin,
      (w) => {
        const btn =
          w.document.getElementById(
            'PartChgSupp'
          );

        return (
          btn &&
          isVisible(btn)
        );
      }
    );

    let taxAlertMsg = null;

    installAlertInterceptor(
      editWin,
      (msg) => {
        taxAlertMsg = msg;
      }
    );

    ui.setStatus(
      item.line,
      'processing',
      'Opening supplier list…'
    );

    const suppWinPromise =
      hookNextOpen(editWin);

    editWin.document
      .getElementById(
        'PartChgSupp'
      )
      .click();

    const suppWin =
      await suppWinPromise;

    // Wait until the supplier list radios are populated.
    await waitForWindowLoaded(
      () => suppWin,
      (w) =>
        w.document.querySelector(
          'input[name="R1"]'
        )
    );

    const infoCell =
      findMatchingInfoCell(
        suppWin.document,
        targetId
      );

    if (!infoCell) {
      rememberUnavailable(
        item,
        targetId,
        'supplier not offered in Select Supplier list'
      );

      suppWin.close();

      await sleep(100);

      if (!editWin.closed) {
        editWin.close();
      }

      ui.setStatus(
        item.line,
        'not_found',
        `Supplier "${targetId}" is not offered — will not retry automatically`
      );

      appendLog({
        line: item.line,
        sku: item.sku,
        from: item.supplierId,
        to: targetId,
        status: 'not_found',
        note:
          'Remembered as unavailable for this SKU'
      });

      return;
    }

    ui.setStatus(
      item.line,
      'processing',
      'Selecting supplier…'
    );

    const row =
      infoCell.closest('tr');

    const radio =
      row
        ? row.querySelector(
            'input[type="radio"]'
          )
        : null;

    if (!radio) {
      suppWin.close();

      await sleep(100);

      if (!editWin.closed) {
        editWin.close();
      }

      ui.setStatus(
        item.line,
        'error',
        'Could not find the radio button for the matched supplier row'
      );

      appendLog({
        line: item.line,
        sku: item.sku,
        from: item.supplierId,
        to: targetId,
        status: 'error',
        note:
          'radio not found'
      });

      return;
    }

    radio.click();

    ui.setStatus(
      item.line,
      'processing',
      'Clicking Select Supplier…'
    );

    const selectSupplierBtn =
      await waitFor(() => {
        const btn =
          suppWin.document.getElementById(
            'ReleaseInvoice'
          );

        return (
          btn &&
          isVisible(btn)
        )
          ? btn
          : null;
      });

    selectSupplierBtn.click();

    await raceFirstResolved([
      waitForClosed(
        () => suppWin,
        { timeout: 10000 }
      ),

      waitFor(
        () => {
          if (editWin.closed) {
            return null;
          }

          const btn =
            editWin.document.getElementById(
              'okclick'
            );

          return (
            btn &&
            isVisible(btn)
          )
            ? true
            : null;
        },
        { timeout: 10000 }
      )
    ]);

    if (!suppWin.closed) {
      suppWin.close();
    }

    ui.setStatus(
      item.line,
      'processing',
      'Waiting for Save button…'
    );

    // Wait only until Save is present and visible.
    await waitFor(() => {
      if (editWin.closed) {
        return null;
      }

      const btn =
        editWin.document.getElementById(
          'okclick'
        );

      return (
        btn &&
        isVisible(btn)
      )
        ? btn
        : null;
    });

    ui.setStatus(
      item.line,
      'processing',
      'Saving…'
    );

    const originalSupplierId =
      item.supplierId;

    editWin.document
      .getElementById(
        'okclick'
      )
      .click();

    // The tax-code alert fires synchronously during the save
    // click handler, so a short settle is all that's needed.
    await sleep(150);

    if (taxAlertMsg) {
      const msg =
        taxAlertMsg;

      if (
        !TAX_CODE_ALERT_RE.test(
          msg
        )
      ) {
        ui.setStatus(
          item.line,
          'error',
          `Blocked by alert: ${msg}`
        );

        appendLog({
          line: item.line,
          sku: item.sku,
          from: originalSupplierId,
          to: targetId,
          status: 'error',
          note:
            `Unexpected alert: ${msg}`
        });

        if (!editWin.closed) {
          editWin.close();
        }

        return;
      }

      taxAlertMsg = null;

      if (getAutoTaxNa()) {
        ui.setStatus(
          item.line,
          'tax_error',
          `Blocked: ${msg} — auto-filling NA (remembered)`
        );

        try {
          applyTaxCodeNaFix(
            editWin
          );
        } catch (e) {
          // Ignore.
        }

        appendLog({
          line: item.line,
          sku: item.sku,
          from: originalSupplierId,
          to: targetId,
          status: 'tax_auto_na',
          note: msg
        });
      } else {
        ui.setStatus(
          item.line,
          'tax_error',
          `Blocked: ${msg}`
        );

        await showTaxCodeFix(
          editWin,
          item,
          msg
        );
      }

      await sleep(150);

      if (taxAlertMsg) {
        ui.setStatus(
          item.line,
          'error',
          `Still blocked after NA fix: ${taxAlertMsg}`
        );

        appendLog({
          line: item.line,
          sku: item.sku,
          from: originalSupplierId,
          to: targetId,
          status: 'error',
          note:
            `Still blocked: ${taxAlertMsg}`
        });

        if (!editWin.closed) {
          editWin.close();
        }

        return;
      }
    }

    await waitForClosed(
      () => editWin
    ).catch(() => {
      if (!editWin.closed) {
        editWin.close();
      }
    });

    // Give the parent page a moment to reload/refresh its rows.
    await sleep(300);

    if (
      verifyLineSupplier(
        item,
        targetId
      )
    ) {
      ui.setStatus(
        item.line,
        'success',
        `Changed to ${targetId} (verified)`
      );

      appendLog({
        line: item.line,
        sku: item.sku,
        from: originalSupplierId,
        to: targetId,
        status: 'verified'
      });
    } else {
      ui.setStatus(
        item.line,
        'saved',
        'Saved — page should reload shortly to confirm'
      );

      appendLog({
        line: item.line,
        sku: item.sku,
        from: originalSupplierId,
        to: targetId,
        status: 'saved_unverified'
      });
    }
  }

  // ------------------------------------------------------------------
  // Orchestration
  // ------------------------------------------------------------------

  async function run(
    mode,
    maxLines,
    dryRun,
    ui,
    budgetOverride
  ) {
    running = true;
    stopRequested = false;

    ui.setRunningState(true);

    const allItems =
      scanReqLines();

    const {
      matched,
      toFix,
      unavailable,
      notOnPage
    } =
      buildPlan(
        allItems,
        mode
      );

    const inScope =
      matched.concat(
        toFix,
        unavailable
      );

    if (
      inScope.length === 0
    ) {
      ui.renderRows([]);

      ui.setSummary(
        mode.type === 'mapping'
          ? 'None of the pasted SKUs matched a line on this page.'
          : `No line(s) found matching SKU(s): ${(mode.skuFilters || []).join(', ')}`,
        'warn'
      );

      clearResumeState();

      running = false;
      ui.setRunningState(false);

      return;
    }

    const inScopeLines =
      new Set(
        inScope.map(
          (x) => x.item.line
        )
      );

    const orderedItems =
      allItems.filter(
        (it) =>
          inScopeLines.has(
            it.line
          )
      );

    ui.renderRows(
      orderedItems
    );

    matched.forEach(
      ({ item }) =>
        ui.setStatus(
          item.line,
          'match',
          'Already correct — no change needed'
        )
    );

    unavailable.forEach(
      ({ item, target }) =>
        ui.setStatus(
          item.line,
          'not_found',
          `Supplier "${target}" was previously unavailable — skipped`
        )
    );

    toFix.forEach(
      ({ item, target }) =>
        ui.setStatus(
          item.line,
          'pending',
          `Queued → ${target}`
        )
    );

    if (
      toFix.length === 0
    ) {
      clearResumeState();

      ui.setSummary(
        `Nothing to change. ${matched.length} already correct` +
          (
            unavailable.length
              ? `, ${unavailable.length} unavailable and safely skipped.`
              : '.'
          ),
        unavailable.length
          ? 'warn'
          : 'ok'
      );

      running = false;
      ui.setRunningState(false);

      return;
    }

    const budget =
      typeof budgetOverride ===
      'number'
        ? budgetOverride
        : maxLines;

    const queued =
      toFix.slice(
        0,
        budget
      );

    const overCap =
      toFix.slice(
        budget
      );

    overCap.forEach(
      ({ item }) =>
        ui.setStatus(
          item.line,
          'capped',
          `Skipped — over the ${maxLines}-line cap for this run`
        )
    );

    if (dryRun) {
      queued.forEach(
        ({ item, target }) =>
          ui.setStatus(
            item.line,
            'would_change',
            `Would change ${item.supplierId} → ${target}`
          )
      );

      clearResumeState();

      ui.setSummary(
        `Dry run: ${queued.length} of ${inScope.length} line(s) would change.` +
          (
            overCap.length
              ? ` ${overCap.length} more exceed the ${maxLines}-line cap.`
              : ''
          ) +
          (
            notOnPage.length
              ? ` ${notOnPage.length} pasted SKU(s) not found on this page.`
              : ''
          ) +
          ' No changes were made.',
        'info'
      );

      running = false;
      ui.setRunningState(false);

      return;
    }

    saveResumeState(
      mode,
      maxLines,
      budget
    );

    ui.setSummary(
      `${queued.length} of ${inScope.length} line(s) changing` +
        (
          overCap.length
            ? ` (${overCap.length} over the ${maxLines}-line cap, skipped)`
            : ''
        ) +
        '. This page reloads after each save — leave the tab open, the panel resumes itself.',
      'info'
    );

    let remaining =
      budget;

    for (
      const { item, target }
      of queued
    ) {
      if (stopRequested) {
        ui.setStatus(
          item.line,
          'pending',
          'Stopped before running'
        );

        continue;
      }

      try {
        await fixLine(
          item,
          target,
          ui
        );
      } catch (e) {
        ui.setStatus(
          item.line,
          'error',
          e.message
        );

        appendLog({
          line: item.line,
          sku: item.sku,
          from: item.supplierId,
          to: target,
          status: 'error',
          note: e.message
        });
      }

      remaining -= 1;

      saveResumeState(
        mode,
        maxLines,
        remaining
      );

      // Short settle before the next line — the next popup-open
      // also re-validates state, so this is just a safety gap.
      await sleep(150);
    }

    clearResumeState();

    ui.setSummary(
      stopRequested
        ? 'Stopped by user.'
        : 'Finished.',
      stopRequested
        ? 'warn'
        : 'ok'
    );

    running = false;

    ui.setRunningState(
      false
    );
  }

  // ------------------------------------------------------------------
  // Floating UI
  // ------------------------------------------------------------------

  const STATUS_STYLES = {
    match: {
      icon: '✓',
      label: 'OK',
      color: '#1a7f37',
      bg: '#eafbea'
    },

    pending: {
      icon: '…',
      label: 'Queued',
      color: '#57606a',
      bg: '#f3f4f6'
    },

    processing: {
      icon: '↻',
      label: 'Working',
      color: '#0969da',
      bg: '#eaf2fe'
    },

    success: {
      icon: '✓',
      label: 'Done',
      color: '#1a7f37',
      bg: '#eafbea'
    },

    saved: {
      icon: '⤓',
      label: 'Saved',
      color: '#0969da',
      bg: '#eaf2fe'
    },

    not_found: {
      icon: '!',
      label: 'Not offered',
      color: '#9a6700',
      bg: '#fff6e0'
    },

    error: {
      icon: '✕',
      label: 'Error',
      color: '#cf222e',
      bg: '#ffecec'
    },

    capped: {
      icon: '⊘',
      label: 'Capped',
      color: '#9a6700',
      bg: '#fff6e0'
    },

    would_change: {
      icon: '→',
      label: 'Preview',
      color: '#8250df',
      bg: '#f5eeff'
    },

    tax_error: {
      icon: '⚠',
      label: 'Tax code',
      color: '#9a6700',
      bg: '#fff6e0'
    }
  };

  const SUMMARY_STYLES = {
    info: {
      color: '#0969da',
      bg: '#eaf2fe'
    },

    ok: {
      color: '#1a7f37',
      bg: '#eafbea'
    },

    warn: {
      color: '#9a6700',
      bg: '#fff6e0'
    },

    err: {
      color: '#cf222e',
      bg: '#ffecec'
    }
  };

  // ------------------------------------------------------------------
  // UI styles
  // ------------------------------------------------------------------

  function injectStyles() {
    if (
      document.getElementById(
        'rsf-styles'
      )
    ) {
      return;
    }

    const style =
      document.createElement(
        'style'
      );

    style.id =
      'rsf-styles';

    style.textContent = `
      #rsf-panel {
        position: fixed;
        top: 16px;
        right: 16px;
        z-index: 999999;
        width: 380px;
        max-width: calc(100vw - 32px);
        background: #ffffff;
        color: #1f2328;
        border: 1px solid #d0d7de;
        border-radius: 10px;
        box-shadow:
          0 8px 24px rgba(140,149,159,0.3),
          0 1px 3px rgba(0,0,0,0.1);
        font:
          12.5px/1.4
          -apple-system,
          BlinkMacSystemFont,
          "Segoe UI",
          Roboto,
          Arial,
          sans-serif;
        overflow: hidden;
      }

      #rsf-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        background: #24292f;
        color: #fff;
        padding: 10px 12px;
        cursor: move;
        user-select: none;
      }

      #rsf-header .rsf-title {
        font-weight: 600;
        font-size: 13px;
        display: flex;
        align-items: center;
        gap: 6px;
      }

      #rsf-header .rsf-dot {
        width: 7px;
        height: 7px;
        border-radius: 50%;
        background: #8b949e;
        display: inline-block;
      }

      #rsf-header .rsf-dot.on {
        background: #3fb950;
      }

      #rsf-header button {
        background: transparent;
        border: none;
        color: #d0d7de;
        cursor: pointer;
        font-size: 14px;
        padding: 2px 6px;
        border-radius: 4px;
        line-height: 1;
      }

      #rsf-header button:hover {
        background: rgba(255,255,255,0.15);
        color: #fff;
      }

      #rsf-body {
        padding: 12px;
      }

      #rsf-panel.rsf-collapsed #rsf-body {
        display: none;
      }

      .rsf-field {
        margin-bottom: 8px;
      }

      .rsf-field label {
        display: block;
        font-weight: 600;
        margin-bottom: 3px;
        color: #57606a;
        font-size: 11px;
        text-transform: uppercase;
        letter-spacing: .03em;
      }

      .rsf-field input[type="text"],
      .rsf-field input:not([type]),
      .rsf-field textarea {
        width: 100%;
        box-sizing: border-box;
        padding: 6px 8px;
        border: 1px solid #d0d7de;
        border-radius: 6px;
        font-size: 12.5px;
        font-family: inherit;
        resize: vertical;
      }

      .rsf-field input:focus,
      .rsf-field textarea:focus {
        outline: none;
        border-color: #0969da;
        box-shadow:
          0 0 0 3px
          rgba(9,105,218,0.15);
      }

      .rsf-row2 {
        display: flex;
        gap: 8px;
      }

      .rsf-row2 > div {
        flex: 1;
      }

      .rsf-checkline {
        display: flex;
        align-items: center;
        gap: 6px;
        margin: 8px 0;
      }

      .rsf-checkline label {
        font-size: 12px;
        color: #1f2328;
      }

      #rsf-btnrow {
        display: flex;
        gap: 8px;
        margin-top: 4px;
        margin-bottom: 8px;
      }

      #rsf-btnrow button {
        flex: 1;
        padding: 7px 10px;
        border-radius: 6px;
        border: 1px solid transparent;
        font-size: 12.5px;
        font-weight: 600;
        cursor: pointer;
      }

      #rsf-start {
        background: #1f883d;
        color: #fff;
      }

      #rsf-start:hover:not(:disabled) {
        background: #1a7f37;
      }

      #rsf-start:disabled {
        background: #94d3a2;
        cursor: not-allowed;
      }

      #rsf-stop {
        background: #fff;
        color: #cf222e;
        border-color: #d0d7de;
      }

      #rsf-stop:hover:not(:disabled) {
        background: #ffecec;
        border-color: #cf222e;
      }

      #rsf-stop:disabled {
        color: #c9c9c9;
        cursor: not-allowed;
      }

      #rsf-summary {
        padding: 7px 9px;
        border-radius: 6px;
        margin-bottom: 8px;
        font-size: 12px;
        display: none;
      }

      #rsf-rows {
        max-height: 280px;
        overflow: auto;
        border-top: 1px solid #eaeef2;
        padding-top: 6px;
      }

      .rsf-row {
        display: flex;
        align-items: flex-start;
        gap: 8px;
        padding: 5px 6px;
        border-radius: 6px;
        margin-bottom: 3px;
      }

      .rsf-row .rsf-icon {
        flex: none;
        width: 18px;
        height: 18px;
        border-radius: 50%;
        display: flex;
        align-items: center;
        justify-content: center;
        font-size: 11px;
        font-weight: 700;
        color: #fff;
      }

      .rsf-row .rsf-main {
        flex: 1;
        min-width: 0;
      }

      .rsf-row .rsf-line {
        font-weight: 600;
      }

      .rsf-row .rsf-sub {
        font-size: 11px;
        color: #57606a;
      }

      .rsf-row .rsf-status-text {
        font-size: 11px;
        margin-top: 1px;
      }

      #rsf-log-toggle {
        font-size: 11px;
        color: #0969da;
        cursor: pointer;
        text-decoration: underline;
        background: none;
        border: none;
        padding: 0;
        margin-top: 6px;
      }

      #rsf-log {
        max-height: 140px;
        overflow: auto;
        font-family:
          ui-monospace,
          SFMono-Regular,
          Menlo,
          monospace;
        font-size: 10.5px;
        background: #f6f8fa;
        border-radius: 6px;
        padding: 6px;
        margin-top: 6px;
        display: none;
        white-space: pre-wrap;
      }

      #rsf-log.rsf-log-open {
        display: block;
      }

      .rsf-hint {
        font-size: 11px;
        color: #6e7781;
        margin-top: 2px;
      }

      .rsf-resume-banner {
        background: #fff6e0;
        color: #9a6700;
        border: 1px solid #eac54f;
        border-radius: 6px;
        padding: 6px 8px;
        font-size: 11.5px;
        margin-bottom: 8px;
      }

      #rsf-confirm-overlay {
        position: fixed;
        inset: 0;
        background: rgba(31,35,40,0.5);
        z-index: 1000000;
        display: flex;
        align-items: center;
        justify-content: center;
      }

      #rsf-confirm-box {
        background: #fff;
        border-radius: 10px;
        width: 360px;
        max-width: calc(100vw - 40px);
        box-shadow:
          0 12px 32px rgba(0,0,0,0.35);
        font:
          12.5px/1.5
          -apple-system,
          BlinkMacSystemFont,
          "Segoe UI",
          Roboto,
          Arial,
          sans-serif;
        color: #1f2328;
        overflow: hidden;
      }

      #rsf-confirm-box .rsf-c-head {
        padding: 14px 16px 6px;
        font-weight: 700;
        font-size: 14px;
      }

      #rsf-confirm-box .rsf-c-body {
        padding: 4px 16px 14px;
      }

      #rsf-confirm-box .rsf-c-body b {
        color: #0969da;
      }

      #rsf-confirm-box .rsf-c-warn {
        background: #fff6e0;
        color: #9a6700;
        border-radius: 6px;
        padding: 8px;
        margin-top: 8px;
        font-size: 11.5px;
      }

      #rsf-confirm-box .rsf-c-btns {
        display: flex;
        gap: 8px;
        padding: 0 16px 16px;
      }

      #rsf-confirm-box .rsf-c-btns button {
        flex: 1;
        padding: 8px 10px;
        border-radius: 6px;
        font-weight: 600;
        font-size: 12.5px;
        cursor: pointer;
      }

      #rsf-confirm-cancel {
        background: #fff;
        border: 1px solid #d0d7de;
      }

      #rsf-confirm-cancel:hover {
        background: #f3f4f6;
      }

      #rsf-confirm-go {
        background: #1f883d;
        color: #fff;
        border: 1px solid transparent;
      }

      #rsf-confirm-go:hover {
        background: #1a7f37;
      }

      #rsf-tax-overlay {
        position: fixed;
        inset: 0;
        background: rgba(31,35,40,0.5);
        z-index: 1000001;
        display: flex;
        align-items: center;
        justify-content: center;
      }

      #rsf-tax-box {
        background: #fff;
        border-radius: 10px;
        width: 340px;
        max-width: calc(100vw - 40px);
        box-shadow:
          0 12px 32px rgba(0,0,0,0.35);
        font:
          12.5px/1.5
          -apple-system,
          BlinkMacSystemFont,
          "Segoe UI",
          Roboto,
          Arial,
          sans-serif;
        color: #1f2328;
        overflow: hidden;
      }

      #rsf-tax-box .rsf-c-head {
        padding: 14px 16px 6px;
        font-weight: 700;
        font-size: 14px;
        color: #9a6700;
      }

      #rsf-tax-box .rsf-c-body {
        padding: 4px 16px 14px;
      }

      #rsf-tax-box .rsf-c-body b {
        color: #0969da;
      }

      #rsf-tax-box .rsf-c-btns {
        display: flex;
        gap: 8px;
        padding: 0 16px 16px;
      }

      #rsf-tax-na {
        flex: 1;
        padding: 9px 10px;
        border-radius: 6px;
        font-weight: 700;
        font-size: 13px;
        cursor: pointer;
        background: #9a6700;
        color: #fff;
        border: 1px solid transparent;
      }

      #rsf-tax-na:hover {
        background: #7d5500;
      }
    `;

    document.head.appendChild(style);
  }

  // ------------------------------------------------------------------
  // Drag panel
  // ------------------------------------------------------------------

  function makeDraggable(
    panel,
    handle
  ) {
    let dragging = false;
    let startX = 0;
    let startY = 0;
    let startRight = 0;
    let startTop = 0;

    handle.addEventListener(
      'mousedown',
      (e) => {
        if (
          e.target.closest(
            'button'
          )
        ) {
          return;
        }

        dragging = true;

        startX =
          e.clientX;

        startY =
          e.clientY;

        const rect =
          panel.getBoundingClientRect();

        startRight =
          window.innerWidth -
          rect.right;

        startTop =
          rect.top;

        e.preventDefault();
      }
    );

    window.addEventListener(
      'mousemove',
      (e) => {
        if (!dragging) return;

        const dx =
          e.clientX -
          startX;

        const dy =
          e.clientY -
          startY;

        panel.style.right =
          Math.max(
            4,
            startRight - dx
          ) + 'px';

        panel.style.top =
          Math.max(
            4,
            startTop + dy
          ) + 'px';
      }
    );

    window.addEventListener(
      'mouseup',
      () => {
        dragging = false;
      }
    );
  }

  // ------------------------------------------------------------------
  // Confirmation
  // ------------------------------------------------------------------

  function showConfirmPlan({
    mode,
    toFixCount,
    totalCount,
    cap,
    notOnPageCount,
    unavailableCount = 0
  }) {
    const bodyDesc =
      mode.type === 'mapping'
        ? `This will reassign <b>${toFixCount}</b> of ${totalCount} matched line item(s) on this requisition, each to its own supplier from the pasted mapping (${mode.map.size} SKU(s) mapped${notOnPageCount ? `, ${notOnPageCount} not found on this page` : ''}).`
        : `This will reassign <b>${toFixCount}</b> of ${totalCount} line item(s) on this requisition to <b>${escapeHtml(mode.targetId)}</b>${mode.skuFilters.length ? ` (SKU filter: ${escapeHtml(mode.skuFilters.join(', '))})` : ''}.`;

    return new Promise(
      (resolve) => {
        const overlay =
          document.createElement(
            'div'
          );

        overlay.id =
          'rsf-confirm-overlay';

        overlay.innerHTML = `
          <div id="rsf-confirm-box">
            <div class="rsf-c-head">
              Confirm supplier change
            </div>

            <div class="rsf-c-body">
              ${bodyDesc}

              ${
                unavailableCount
                  ? `<div class="rsf-c-warn">
                      ${unavailableCount} line(s) were previously confirmed as unavailable for the requested supplier and will be skipped without retrying.
                    </div>`
                  : ''
              }

              ${
                toFixCount > cap
                  ? `<div class="rsf-c-warn">
                      ${toFixCount - cap} line(s) exceed your ${cap}-line cap and will be skipped this run.
                    </div>`
                  : ''
              }

              <div class="rsf-c-warn">
                Each change is saved live in Birchstreet as it runs — this is not reversible by this tool.
                Double-check the ${mode.type === 'mapping' ? 'pasted mapping' : 'target supplier'} before continuing.
              </div>
            </div>

            <div class="rsf-c-btns">
              <button id="rsf-confirm-cancel">
                Cancel
              </button>

              <button id="rsf-confirm-go">
                Confirm &amp; run
              </button>
            </div>
          </div>
        `;

        document.body.appendChild(
          overlay
        );

        const cleanup =
          (result) => {
            overlay.remove();
            resolve(result);
          };

        overlay
          .querySelector(
            '#rsf-confirm-cancel'
          )
          .addEventListener(
            'click',
            () =>
              cleanup(false)
          );

        overlay.addEventListener(
          'click',
          (e) => {
            if (
              e.target ===
              overlay
            ) {
              cleanup(false);
            }
          }
        );

        overlay
          .querySelector(
            '#rsf-confirm-go'
          )
          .addEventListener(
            'click',
            () =>
              cleanup(true)
          );
      }
    );
  }

  // ------------------------------------------------------------------
  // Build UI
  // ------------------------------------------------------------------

  function buildUI() {
    injectStyles();

    const panel =
      document.createElement(
        'div'
      );

    panel.id =
      'rsf-panel';

    panel.innerHTML = `
      <div id="rsf-header">
        <span class="rsf-title">
          <span
            class="rsf-dot"
            id="rsf-dot"
          ></span>
          REQ Supplier Fixer
        </span>

        <span>
          <button
            id="rsf-collapse"
            title="Collapse"
          >–</button>

          <button
            id="rsf-close"
            title="Close"
          >×</button>
        </span>
      </div>

      <div id="rsf-body">

        <div
          id="rsf-resume-banner"
          class="rsf-resume-banner"
          style="display:none;"
        ></div>

        <div class="rsf-field">
          <label>
            Target supplier
          </label>

          <input
            id="rsf-supplier"
            type="text"
            placeholder="ID (e.g. 2917) or name fragment (e.g. Chef 2 Chef)"
          >
        </div>

        <div class="rsf-field">
          <label>
            SKU filter — or paste SKU→Supplier rows
          </label>

          <textarea
            id="rsf-sku"
            rows="3"
            placeholder="Comma-separated SKUs to filter, blank = all lines.
Or paste tab-separated rows copied from Excel to fix each SKU to its own correct supplier in one run."
          ></textarea>

          <div
            id="rsf-map-hint"
            class="rsf-hint"
            style="display:none;"
          ></div>
        </div>

        <div class="rsf-row2">

          <div class="rsf-field">
            <label>
              Max lines this run
            </label>

            <input
              id="rsf-cap"
              type="text"
              value="25"
            >
          </div>

          <div
            class="rsf-field"
            style="display:flex; align-items:flex-end;"
          >
            <div
              class="rsf-checkline"
              style="margin-bottom:8px;"
            >
              <input
                type="checkbox"
                id="rsf-dryrun"
              >

              <label
                for="rsf-dryrun"
              >
                Dry run
              </label>
            </div>
          </div>

        </div>

        <div class="rsf-hint">
          Smart behavior:
          lines already on the requested supplier
          are skipped.
          If Birchstreet does not offer a requested
          supplier for an SKU, that SKU→supplier pair
          is remembered and will not be retried after
          page reloads. (Close this tab to reset that memory.)
        </div>

        <div id="rsf-btnrow">
          <button id="rsf-start">
            Start
          </button>

          <button
            id="rsf-stop"
            disabled
          >
            Stop
          </button>
        </div>

        <div id="rsf-summary"></div>

        <div id="rsf-rows"></div>

        <div
          id="rsf-autona-status"
          style="display:none;"
        ></div>

        <button
          id="rsf-log-toggle"
        >
          Show activity log
        </button>

        <div id="rsf-log"></div>

      </div>
    `;

    document.body.appendChild(
      panel
    );

    const header =
      panel.querySelector(
        '#rsf-header'
      );

    makeDraggable(
      panel,
      header
    );

    panel
      .querySelector(
        '#rsf-collapse'
      )
      .addEventListener(
        'click',
        () => {
          panel.classList.toggle(
            'rsf-collapsed'
          );

          panel
            .querySelector(
              '#rsf-collapse'
            )
            .textContent =
              panel.classList.contains(
                'rsf-collapsed'
              )
                ? '+'
                : '–';
        }
      );

    panel
      .querySelector(
        '#rsf-close'
      )
      .addEventListener(
        'click',
        () => {
          if (running) {
            if (
              !confirm(
                'A run is in progress. Close the panel anyway?'
              )
            ) {
              return;
            }
          }

          panel.remove();
        }
      );

    const rowsDiv =
      panel.querySelector(
        '#rsf-rows'
      );

    const summaryDiv =
      panel.querySelector(
        '#rsf-summary'
      );

    const logDiv =
      panel.querySelector(
        '#rsf-log'
      );

    const logToggle =
      panel.querySelector(
        '#rsf-log-toggle'
      );

    const dot =
      panel.querySelector(
        '#rsf-dot'
      );

    const startBtn =
      panel.querySelector(
        '#rsf-start'
      );

    const stopBtn =
      panel.querySelector(
        '#rsf-stop'
      );

    const supplierInput =
      panel.querySelector(
        '#rsf-supplier'
      );

    const skuInput =
      panel.querySelector(
        '#rsf-sku'
      );

    const capInput =
      panel.querySelector(
        '#rsf-cap'
      );

    const dryrunInput =
      panel.querySelector(
        '#rsf-dryrun'
      );

    const resumeBanner =
      panel.querySelector(
        '#rsf-resume-banner'
      );

    const autoNaStatus =
      panel.querySelector(
        '#rsf-autona-status'
      );

    const mapHint =
      panel.querySelector(
        '#rsf-map-hint'
      );

    const rowEls = {};

    const initialItemCount =
      scanReqLines().length;

    if (
      initialItemCount > 0
    ) {
      capInput.value =
        String(
          initialItemCount
        );
    }

    function applyFieldEnablement() {
      const mapping =
        isMappingPaste(
          skuInput.value
        );

      supplierInput.disabled =
        running ||
        mapping;

      supplierInput.placeholder =
        mapping
          ? 'Ignored — using the pasted per-item mapping below'
          : 'ID (e.g. 2917) or name fragment (e.g. Chef 2 Chef)';
    }

    function updateMapHint() {
      const raw =
        skuInput.value;

      if (
        !isMappingPaste(raw)
      ) {
        mapHint.style.display =
          'none';

        mapHint.textContent =
          '';

        applyFieldEnablement();

        return;
      }

      applyFieldEnablement();

      const parsed =
        parseMappingPaste(
          raw
        );

      if (
        parsed.map.size === 0
      ) {
        mapHint.style.display =
          'block';

        mapHint.textContent =
          'Pasted text looks tab-separated but no usable rows were found.';

        return;
      }

      const {
        matched,
        toFix,
        notOnPage
      } =
        buildPlan(
          scanReqLines(),
          {
            type: 'mapping',
            map: parsed.map
          }
        );

      mapHint.style.display =
        'block';

      mapHint.textContent =
        `Parsed ${parsed.totalRows} row(s): ${parsed.map.size} mapped` +
        (
          parsed.blankSkipped
            ? `, ${parsed.blankSkipped} skipped`
            : ''
        ) +
        (
          parsed.badRows
            ? `, ${parsed.badRows} unparsable`
            : ''
        ) +
        ` → ${toFix.length} will change, ${matched.length} already correct` +
        (
          notOnPage.length
            ? `, ${notOnPage.length} not found on this page`
            : ''
        ) +
        '.';
    }

    skuInput.addEventListener(
      'input',
      updateMapHint
    );

    updateMapHint();

    function renderAutoNaStatus() {
      if (
        getAutoTaxNa()
      ) {
        autoNaStatus.style.display =
          'block';

        autoNaStatus.innerHTML =
          '⚠ Tax-code fix remembered: NA will auto-fill on any tax-code alert.';

      } else {
        autoNaStatus.style.display =
          'none';

        autoNaStatus.innerHTML =
          '';
      }
    }

    renderAutoNaStatus();

    function renderLog() {
      const log =
        loadLog();

      if (!log.length) {
        logDiv.textContent =
          '(no changes logged yet this session)';

        return;
      }

      logDiv.textContent =
        log
          .map(
            (e) =>
              `[${e.time.replace('T', ' ').slice(0, 19)}] line ${e.line}${e.sku ? ' (SKU ' + e.sku + ')' : ''}: ${e.from} → ${e.to} — ${e.status}${e.note ? ' (' + e.note + ')' : ''}`
          )
          .join('\n');
    }

    renderLog();

    logToggle.addEventListener(
      'click',
      () => {
        const open =
          logDiv.classList.toggle(
            'rsf-log-open'
          );

        logToggle.textContent =
          open
            ? 'Hide activity log'
            : 'Show activity log';

        if (open) {
          renderLog();
        }
      }
    );

    const ui = {
      renderRows(items) {
        rowsDiv.innerHTML =
          '';

        Object.keys(
          rowEls
        ).forEach(
          (key) =>
            delete rowEls[key]
        );

        items.forEach(
          (it) => {
            const row =
              document.createElement(
                'div'
              );

            row.className =
              'rsf-row';

            row.style.background =
              STATUS_STYLES
                .pending
                .bg;

            row.innerHTML = `
              <span
                class="rsf-icon"
                style="background:${STATUS_STYLES.pending.color}"
              >…</span>

              <span class="rsf-main">

                <div class="rsf-line">
                  Line ${escapeHtml(it.line)}

                  <span class="rsf-sub">
                    —
                    ${escapeHtml(
                      it.supplierName ||
                      'Unknown supplier'
                    )}

                    (${escapeHtml(
                      it.supplierId
                    )})

                    ${
                      it.sku
                        ? ' · SKU ' +
                          escapeHtml(
                            it.sku
                          )
                        : ''
                    }
                  </span>
                </div>

                <div class="rsf-status-text">
                  Waiting…
                </div>

              </span>
            `;

            rowsDiv.appendChild(
              row
            );

            rowEls[it.line] =
              row;
          }
        );
      },

      setStatus(
        line,
        status,
        text
      ) {
        const row =
          rowEls[line];

        if (!row) return;

        const style =
          STATUS_STYLES[
            status
          ] ||
          STATUS_STYLES.pending;

        row.style.background =
          style.bg;

        row
          .querySelector(
            '.rsf-icon'
          )
          .style.background =
          style.color;

        row
          .querySelector(
            '.rsf-icon'
          )
          .textContent =
          style.icon;

        const textEl =
          row.querySelector(
            '.rsf-status-text'
          );

        textEl.textContent =
          text;

        textEl.style.color =
          style.color;

        renderLog();
        renderAutoNaStatus();
      },

      setSummary(
        text,
        kind
      ) {
        const style =
          SUMMARY_STYLES[
            kind
          ] ||
          SUMMARY_STYLES.info;

        summaryDiv.style.display =
          'block';

        summaryDiv.style.background =
          style.bg;

        summaryDiv.style.color =
          style.color;

        summaryDiv.textContent =
          text;
      },

      setRunningState(
        isRunning
      ) {
        dot.classList.toggle(
          'on',
          isRunning
        );

        startBtn.disabled =
          isRunning;

        stopBtn.disabled =
          !isRunning;

        applyFieldEnablement();

        skuInput.disabled =
          isRunning;

        capInput.disabled =
          isRunning;

        dryrunInput.disabled =
          isRunning;
      }
    };

    function parsedCap() {
      const n =
        parseInt(
          capInput.value,
          10
        );

      return Number.isFinite(n) &&
        n > 0
        ? n
        : 25;
    }

    async function startClicked() {
      if (running) {
        ui.setSummary(
          'Already running.',
          'warn'
        );

        return;
      }

      const skuRaw =
        skuInput.value;

      const cap =
        parsedCap();

      const dryRun =
        dryrunInput.checked;

      let mode;

      if (
        isMappingPaste(
          skuRaw
        )
      ) {
        const parsed =
          parseMappingPaste(
            skuRaw
          );

        if (
          parsed.map.size ===
          0
        ) {
          ui.setSummary(
            'No usable rows found in the pasted data.',
            'err'
          );

          return;
        }

        mode = {
          type: 'mapping',
          map: parsed.map
        };
      } else {
        const id =
          supplierInput.value.trim();

        if (!id) {
          ui.setSummary(
            'Enter a target supplier ID or name, or paste SKU→Supplier rows.',
            'err'
          );

          return;
        }

        const skuFilters =
          skuRaw.trim()
            ? skuRaw
                .split(',')
                .map(
                  (s) =>
                    normalizeSku(s)
                )
                .filter(Boolean)
            : [];

        mode = {
          type: 'single',
          targetId: id,
          skuFilters
        };
      }

      const allItems =
        scanReqLines();

      const {
        matched,
        toFix,
        unavailable,
        notOnPage
      } =
        buildPlan(
          allItems,
          mode
        );

      const totalCount =
        matched.length +
        toFix.length +
        unavailable.length;

      if (
        totalCount === 0
      ) {
        ui.setSummary(
          mode.type === 'mapping'
            ? 'None of the pasted SKUs matched a line on this page.'
            : 'No lines on this page match that SKU filter.',
          'warn'
        );

        return;
      }

      if (
        toFix.length === 0
      ) {
        const inScopeLines =
          new Set(
            matched
              .concat(
                unavailable
              )
              .map(
                (m) =>
                  m.item.line
              )
          );

        const orderedItems =
          allItems.filter(
            (it) =>
              inScopeLines.has(
                it.line
              )
          );

        ui.renderRows(
          orderedItems
        );

        matched.forEach(
          ({ item }) =>
            ui.setStatus(
              item.line,
              'match',
              'Already correct — no change needed'
            )
        );

        unavailable.forEach(
          ({
            item,
            target
          }) =>
            ui.setStatus(
              item.line,
              'not_found',
              `Supplier "${target}" was previously unavailable — skipped`
            )
        );

        ui.setSummary(
          `Nothing to change. ${matched.length} already correct` +
            (
              unavailable.length
                ? `, ${unavailable.length} unavailable and safely skipped.`
                : '.'
            ),
          unavailable.length
            ? 'warn'
            : 'ok'
        );

        return;
      }

      if (dryRun) {
        run(
          mode,
          cap,
          true,
          ui
        );

        return;
      }

      const confirmed =
        await showConfirmPlan({
          mode,
          toFixCount:
            toFix.length,
          totalCount,
          cap,
          notOnPageCount:
            notOnPage.length,
          unavailableCount:
            unavailable.length
        });

      if (!confirmed) {
        ui.setSummary(
          'Cancelled — no changes made.',
          'warn'
        );

        return;
      }

      run(
        mode,
        cap,
        false,
        ui
      );
    }

    startBtn.addEventListener(
      'click',
      () => {
        startClicked();
      }
    );

    stopBtn.addEventListener(
      'click',
      () => {
        stopRequested =
          true;

        clearResumeState();

        ui.setSummary(
          'Stopping after the current line…',
          'warn'
        );
      }
    );

    const resume =
      loadResumeState();

    if (resume) {
      if (
        resume.mode.type ===
        'mapping'
      ) {
        resumeBanner.style.display =
          'block';

        resumeBanner.textContent =
          `Resuming an in-progress mapped run (${resume.mode.map.size} SKU→supplier mapping(s)) after a page reload. ${resume.remainingBudget} line(s) left in this run's budget.`;

        skuInput.value =
          `(resumed — ${resume.mode.map.size} pasted mapping row(s) in memory)`;

        skuInput.disabled =
          true;

        supplierInput.disabled =
          true;

        supplierInput.placeholder =
          'Ignored — using the pasted per-item mapping (resumed)';
      } else {
        supplierInput.value =
          resume.mode.targetId;

        skuInput.value =
          resume.mode.skuFilters.join(
            ', '
          );

        resumeBanner.style.display =
          'block';

        resumeBanner.textContent =
          `Resuming an in-progress run for "${resume.mode.targetId}" after a page reload. ${resume.remainingBudget} line(s) left in this run's budget.`;
      }

      if (
        resume.maxLines
      ) {
        capInput.value =
          String(
            resume.maxLines
          );
      }

      run(
        resume.mode,
        resume.maxLines ||
          25,
        false,
        ui,
        resume.remainingBudget
      );
    }
  }

  buildUI();

})();