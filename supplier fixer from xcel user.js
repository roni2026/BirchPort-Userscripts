// ==UserScript==
// @name         REQ Supplier Auto-Fixer
// @namespace    userscript-req-supplier-fix
// @version      3.2
// @description  Scans a requisition page and reassigns line item(s) to a target supplier, optionally filtered to specific item SKU(s). Adds confirmation, dry-run, change cap, audit log, and a guided (then remembered) fix for the "Tax code is invalid or blank" (1555) save-blocking alert.
// @match        https://*.birchstreetsystems.com/*
// @grant        unsafeWindow
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';

  // ------------------------------------------------------------------
  // IMPORTANT: this script is injected into every birchstreetsystems.com
  // page, including the Edit Line and Change Supplier popups it opens.
  // window.opener isn't a reliable way to tell them apart, since the REQ
  // page itself is often opened via window.open() from an upstream page
  // (dashboard, search results, etc.) and would also have an opener.
  // Instead, only run on the actual REQ report page, identified by its
  // URL - the Edit Line / Change Supplier popups live on different .jsp
  // pages, so this naturally excludes them without touching REQ pages.
  // ------------------------------------------------------------------
  if (!/REQReport\.jsp/i.test(location.pathname)) {
    return;
  }

  const uw = unsafeWindow;
  let running = false;
  let stopRequested = false;

  // ---------- small helpers ----------

  function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }

  function waitFor(checkFn, { timeout = 15000, interval = 200 } = {}) {
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

  // Checks real visibility (display / visibility), not just presence in the
  // DOM - Birchstreet toggles these buttons with inline styles as the popup
  // finishes populating, so an element existing isn't enough to click it yet.
  function isVisible(el) {
    if (!el) return false;
    const view = el.ownerDocument && el.ownerDocument.defaultView;
    if (!view) return false;
    const style = view.getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden') return false;
    return true;
  }

  // ------------------------------------------------------------------
  // Resume-across-reload support.
  //
  // Clicking "Save" on a line doesn't just close the Edit Line popup - it
  // makes the underlying REQ page (this very page, window.opener from the
  // popup's point of view) navigate to REQReport.jsp to show the updated
  // data. That kills this whole script instance mid-run. Since the reload
  // always gives us a fresh, authoritative view of which lines still need
  // fixing, we don't need to preserve exact progress - just remember which
  // supplier ID we were targeting, and auto-resume on the next load until
  // there's nothing left to fix.
  // ------------------------------------------------------------------
  const RESUME_KEY = 'rsf_resume_state_v1';
  const LOG_KEY = 'rsf_audit_log_v1';
  const RESUME_MAX_AGE_MS = 3 * 60 * 1000; // ignore stale flags from abandoned runs

  function saveResumeState(targetId, skuFilters, maxLines, remainingBudget) {
    try {
      sessionStorage.setItem(
        RESUME_KEY,
        JSON.stringify({ targetId, skuFilters: skuFilters || [], maxLines, remainingBudget, ts: Date.now() })
      );
    } catch (e) {
      /* ignore storage errors */
    }
  }

  function clearResumeState() {
    try {
      sessionStorage.removeItem(RESUME_KEY);
    } catch (e) {
      /* ignore storage errors */
    }
  }

  function loadResumeState() {
    try {
      const raw = sessionStorage.getItem(RESUME_KEY);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      if (!parsed || !parsed.targetId || Date.now() - parsed.ts > RESUME_MAX_AGE_MS) {
        clearResumeState();
        return null;
      }
      parsed.skuFilters = parsed.skuFilters || [];
      return parsed;
    } catch (e) {
      return null;
    }
  }

  // ------------------------------------------------------------------
  // Audit log - persisted in sessionStorage so entries survive the page
  // reloads that happen mid-run (see resume-state note above). This is a
  // record of what the script did, not an undo mechanism.
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
      log.push(Object.assign({ time: new Date().toISOString() }, entry));
      sessionStorage.setItem(LOG_KEY, JSON.stringify(log));
      return log;
    } catch (e) {
      return loadLog();
    }
  }

  function clearLogStorage() {
    try {
      sessionStorage.removeItem(LOG_KEY);
    } catch (e) {
      /* ignore */
    }
  }

  // ------------------------------------------------------------------
  // "Remember NA" for the tax-code alert.
  //
  // A native alert() can't be dismissed with a click - we can only
  // intercept it (see installAlertInterceptor below) so it never appears.
  // The first time that happens we ask the user once via the NA button.
  // Once they answer, we remember that choice in sessionStorage (same
  // storage the resume-state uses, so it survives the page reloads that
  // happen after every Save) and auto-apply NA on every later tax-code
  // alert in this run/session without asking again.
  // ------------------------------------------------------------------
  const AUTO_TAX_NA_KEY = 'rsf_auto_tax_na_v1';

  function getAutoTaxNa() {
    try {
      return sessionStorage.getItem(AUTO_TAX_NA_KEY) === '1';
    } catch (e) {
      return false;
    }
  }

  function setAutoTaxNa(on) {
    try {
      if (on) sessionStorage.setItem(AUTO_TAX_NA_KEY, '1');
      else sessionStorage.removeItem(AUTO_TAX_NA_KEY);
    } catch (e) {
      /* ignore storage errors */
    }
  }

  // Resolves as soon as ANY of the given promises resolves; only rejects if
  // every one of them rejects. Used so we don't get stuck depending on a
  // single, potentially unreliable signal (e.g. "did the popup close?").
  function raceFirstResolved(promises) {
    return new Promise((resolve, reject) => {
      let remaining = promises.length;
      let lastErr;
      promises.forEach((p) => {
        p.then(resolve).catch((e) => {
          lastErr = e;
          remaining -= 1;
          if (remaining === 0) reject(lastErr);
        });
      });
    });
  }

  // Resolves the next time winCtx.open(...) is called, with the new window handle.
  function hookNextOpen(winCtx) {
    return new Promise((resolve, reject) => {
      const orig = winCtx.open;
      const timer = setTimeout(() => {
        winCtx.open = orig;
        reject(new Error('Timed out waiting for a popup to open (check popup blocker!)'));
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

  function isNumericId(s) {
    return /^\d+$/.test(s);
  }

  // Lets the "target" field be either a numeric supplier company ID (e.g.
  // "2917") or a case-insensitive fragment of the supplier's name (e.g.
  // "chef 2 chef"), since IDs aren't something users normally have handy.
  function itemMatchesTarget(item, target) {
    if (isNumericId(target)) {
      return item.supplierId === target;
    }
    const needle = target.trim().toLowerCase();
    return (item.supplierName || '').toLowerCase().includes(needle);
  }

  // Finds the matching row's info cell inside the Select Supplier popup,
  // by ID or by name fragment (see itemMatchesTarget above).
  function findMatchingInfoCell(suppWinDoc, target) {
    const infoCells = Array.from(suppWinDoc.querySelectorAll('td[id^="info"]'));
    if (isNumericId(target)) {
      return infoCells.find((td) => td.getAttribute('supplier_comp_id') === target) || null;
    }
    const needle = target.trim().toLowerCase();
    return (
      infoCells.find((td) => {
        const idx = td.id.replace('info', '');
        const nameCell = suppWinDoc.getElementById('compName' + idx);
        const name = nameCell ? nameCell.getAttribute('compname') || nameCell.textContent || '' : '';
        return name.toLowerCase().includes(needle);
      }) || null
    );
  }

  function normalizeSku(s) {
    if (s === undefined || s === null) return '';
    const digits = String(s).replace(/\D/g, '');
    return digits ? String(parseInt(digits, 10)) : '';
  }

  // Item SKUs on the REQ page render as long zero-padded numbers (e.g.
  // "000000000019056"). Rather than depend on a specific column index that
  // could shift between page layouts, just pull the first long digit run
  // out of the row's visible text - line numbers and quantities are far
  // shorter, so this reliably finds the SKU cell.
  function extractSku(row) {
    if (!row) return '';
    const text = row.textContent || '';
    const m = text.match(/\b\d{9,}\b/);
    return m ? m[0] : '';
  }

  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    ));
  }

  // ------------------------------------------------------------------
  // Tax code validation popup handling.
  //
  // When Save is clicked on the Edit Line popup, Birchstreet sometimes runs
  // client-side validation (checkParameter()) that calls
  // alert('1555- Tax code is invalid or blank.') and blocks the save. A
  // native alert() has no clickable DOM element - it's rendered by the
  // browser chrome, not the page - so it can't be dismissed with a
  // click(). Instead we override window.alert on the Edit Line popup
  // BEFORE clicking Save. That prevents the native dialog from ever
  // appearing at all (functionally equivalent to it being instantly
  // dismissed / "OK" pressed) and lets us capture the message so the panel
  // can offer a one-click fix.
  // ------------------------------------------------------------------
  const TAX_CODE_ALERT_RE = /tax code/i;

  function installAlertInterceptor(win, onAlert) {
    try {
      win.alert = function (msg) {
        onAlert(String(msg));
      };
    } catch (e) {
      /* ignore - if we can't override it, the native dialog will just show
         and the user can dismiss it manually */
    }
  }

  // Sets both tax code fields on the Edit Line popup to "NA", fires their
  // onchange handlers (Birchstreet's CheckTaxCode(...) / checkParameter()
  // logic depends on those actually firing, not just the value changing),
  // and retries Save. Used both for the manual NA button and for the
  // remembered auto-fill path below.
  function applyTaxCodeNaFix(editWin) {
    if (editWin.closed) return;
    const doc = editWin.document;
    const fill = (id) => {
      const el = doc.getElementById(id);
      if (!el) return;
      el.value = 'NA';
      el.dispatchEvent(new editWin.Event('change', { bubbles: true }));
    };
    fill('TaxCode1');
    fill('TaxCode2');
    const saveBtn = doc.getElementById('okclick');
    if (saveBtn) saveBtn.click();
  }

  // Shows a small "NA" fix prompt over the page for the FIRST tax-code
  // alert in a run. Clicking it applies the NA fix and remembers the
  // choice (via setAutoTaxNa) so every later tax-code alert in this run
  // is fixed automatically without asking again. Resolves once the user
  // has acted.
  function showTaxCodeFix(editWin, item, alertMsg) {
    return new Promise((resolve) => {
      if (editWin.closed) { resolve(); return; }
      const overlay = document.createElement('div');
      overlay.id = 'rsf-tax-overlay';
      overlay.innerHTML = `
        <div id="rsf-tax-box">
          <div class="rsf-c-head">⚠ Tax code required — line ${escapeHtml(item.line)}</div>
          <div class="rsf-c-body">
            Birchstreet blocked the save: <b>${escapeHtml(alertMsg)}</b><br><br>
            Click <b>NA</b> to set both tax code fields to "NA" and retry Save.
            <div class="rsf-c-warn">This is remembered for the rest of this run — any later tax-code alert will auto-fill NA without asking again.</div>
          </div>
          <div class="rsf-c-btns">
            <button id="rsf-tax-na">NA</button>
          </div>
        </div>
      `;
      document.body.appendChild(overlay);

      const cleanup = () => { overlay.remove(); resolve(); };

      overlay.querySelector('#rsf-tax-na').addEventListener('click', () => {
        try {
          applyTaxCodeNaFix(editWin);
        } catch (e) {
          /* best effort - if this throws, the line will just surface as an
             error status and the user can fix it manually in Birchstreet */
        }
        setAutoTaxNa(true);
        cleanup();
      });
    });
  }

  // ---------- REQ page parsing ----------

  // Collect { line, reqNumber, supplierId, supplierName, sku, link } for
  // every row. supplierId is the 3rd arg of ItemEdit(reqNumber, line,
  // supplierId) - the supplier company ID currently assigned to that line.
  function scanReqLines() {
    const anchors = uw.document.querySelectorAll('div[name="EditLine"] a[onclick^="ItemEdit"]');
    const items = [];
    anchors.forEach((a) => {
      const m = a.getAttribute('onclick').match(/ItemEdit\('([^']+)','([^']+)','([^']+)'\)/);
      if (!m) return;
      const row = a.closest('tr');
      const supplierName = row ? (row.children[1] ? row.children[1].textContent.trim() : '') : '';
      const sku = extractSku(row);
      items.push({
        reqNumber: m[1],
        line: m[2],
        supplierId: m[3],
        supplierName,
        sku,
        link: a,
      });
    });
    return items;
  }

  // Best-effort re-check after a save: re-scans the REQ page for this line
  // and confirms the assigned supplier id now matches. Note: if Birchstreet
  // reloads the REQ page itself after a save, this instance of the script
  // will be torn down along with it - in that case just click Start again
  // once the fresh page loads; already-correct lines will show as such.
  function verifyLineSupplier(item, targetId) {
    const current = scanReqLines().find((it) => it.line === item.line);
    return !!current && itemMatchesTarget(current, targetId);
  }

  // ---------- the supplier-swap flow ----------

  async function fixLine(item, targetId, ui) {
    ui.setStatus(item.line, 'processing', 'Opening line…');

    const editWinPromise = hookNextOpen(uw);
    item.link.click();
    const editWin = await editWinPromise;

    ui.setStatus(item.line, 'processing', 'Waiting for line editor…');
    await waitForWindowLoaded(() => editWin, (w) => {
      const btn = w.document.getElementById('PartChgSupp');
      return btn && isVisible(btn);
    });
    await sleep(200);

    // Install the tax-code alert interceptor as soon as the Edit Line
    // popup is ready, so it's in place for whenever Save gets clicked
    // later (see the checkParameter() note above Save, below).
    let taxAlertMsg = null;
    installAlertInterceptor(editWin, (msg) => { taxAlertMsg = msg; });

    ui.setStatus(item.line, 'processing', 'Opening supplier list…');
    const suppWinPromise = hookNextOpen(editWin);
    editWin.document.getElementById('PartChgSupp').click();
    const suppWin = await suppWinPromise;

    await waitForWindowLoaded(() => suppWin, (w) => w.document.querySelector('input[name="R1"]'));
    await sleep(300);

    const infoCell = findMatchingInfoCell(suppWin.document, targetId);

    if (!infoCell) {
      suppWin.close();
      await sleep(200);
      if (!editWin.closed) editWin.close();
      ui.setStatus(item.line, 'not_found', `Supplier "${targetId}" not offered for this item`);
      appendLog({ line: item.line, sku: item.sku, from: item.supplierId, to: targetId, status: 'not_found' });
      return;
    }

    ui.setStatus(item.line, 'processing', 'Selecting supplier…');
    // NOTE: Birchstreet reuses id="RB1" for every row's radio (a bug in
    // their markup - it doesn't increment per row), so getElementById can't
    // be trusted to grab the right one. Instead select the radio that lives
    // inside the SAME <tr> as the matched info cell.
    const row = infoCell.closest('tr');
    const radio = row ? row.querySelector('input[type="radio"]') : null;
    if (!radio) {
      suppWin.close();
      await sleep(200);
      if (!editWin.closed) editWin.close();
      ui.setStatus(item.line, 'error', 'Could not find the radio button for the matched supplier row');
      appendLog({ line: item.line, sku: item.sku, from: item.supplierId, to: targetId, status: 'error', note: 'radio not found' });
      return;
    }
    radio.click();
    await sleep(250);

    // Step 1 of 2: click "Select Supplier" (#ReleaseInvoice).
    ui.setStatus(item.line, 'processing', 'Clicking Select Supplier…');
    const selectSupplierBtn = await waitFor(() => {
      const btn = suppWin.document.getElementById('ReleaseInvoice');
      return btn && isVisible(btn) ? btn : null;
    });
    selectSupplierBtn.click();

    // The supplier popup should close itself after this, and the Edit Line
    // window's Save button should light up. We don't rely on just one of
    // these signals - whichever appears first is enough to move on, and we
    // force the popup shut afterward if it's still lingering.
    await raceFirstResolved([
      waitForClosed(() => suppWin, { timeout: 10000 }),
      waitFor(() => {
        if (editWin.closed) return null;
        const btn = editWin.document.getElementById('okclick');
        return btn && isVisible(btn) ? true : null;
      }, { timeout: 10000 }),
    ]);
    if (!suppWin.closed) {
      suppWin.close();
    }

    // Step 2 of 2: wait for Save (#okclick) to actually be populated/enabled
    // in the Edit Line window, then click it.
    ui.setStatus(item.line, 'processing', 'Waiting for Save button…');
    await waitFor(() => {
      if (editWin.closed) return null;
      const btn = editWin.document.getElementById('okclick');
      return btn && isVisible(btn) ? btn : null;
    });
    await sleep(200);

    ui.setStatus(item.line, 'processing', 'Saving…');
    // NOTE: clicking Save normally makes THIS page (window.opener from the
    // popup's perspective) navigate to REQReport.jsp to show the updated
    // REQ - which destroys this running script instance almost immediately.
    // That's expected and is exactly what the resume-state logic above
    // handles: the next page load picks the run back up automatically. Any
    // code below this point is best-effort only for the rare case Save
    // doesn't trigger that reload.
    const originalSupplierId = item.supplierId;
    editWin.document.getElementById('okclick').click(); // "Save"

    // Give Birchstreet's client-side validation a moment to run. If the tax
    // code fields are blank/invalid, checkParameter() calls alert('1555-
    // Tax code is invalid or blank.') instead of actually saving - our
    // interceptor above swallows the native dialog and records the message
    // here rather than letting it block the tab.
    await sleep(400);
    if (taxAlertMsg) {
      const msg = taxAlertMsg;
      if (!TAX_CODE_ALERT_RE.test(msg)) {
        // Some other validation message we don't have specific handling
        // for - don't guess at a fix, just report it and move on.
        ui.setStatus(item.line, 'error', `Blocked by alert: ${msg}`);
        appendLog({ line: item.line, sku: item.sku, from: originalSupplierId, to: targetId, status: 'error', note: `Unexpected alert: ${msg}` });
        if (!editWin.closed) editWin.close();
        return;
      }

      taxAlertMsg = null;

      if (getAutoTaxNa()) {
        // Already answered once earlier in this run - apply NA straight
        // away without asking again.
        ui.setStatus(item.line, 'tax_error', `Blocked: ${msg} — auto-filling NA (remembered)`);
        try {
          applyTaxCodeNaFix(editWin);
        } catch (e) { /* falls through to the still-blocked check below */ }
        appendLog({ line: item.line, sku: item.sku, from: originalSupplierId, to: targetId, status: 'tax_auto_na', note: msg });
      } else {
        ui.setStatus(item.line, 'tax_error', `Blocked: ${msg}`);
        await showTaxCodeFix(editWin, item, msg);
      }
      await sleep(400);

      // If it's still blocked after filling NA and retrying, don't loop
      // forever - report it and move on to the next line.
      if (taxAlertMsg) {
        ui.setStatus(item.line, 'error', `Still blocked after NA fix: ${taxAlertMsg}`);
        appendLog({ line: item.line, sku: item.sku, from: originalSupplierId, to: targetId, status: 'error', note: `Still blocked: ${taxAlertMsg}` });
        if (!editWin.closed) editWin.close();
        return;
      }
    }

    await waitForClosed(() => editWin).catch(() => {
      if (!editWin.closed) editWin.close();
    });

    await sleep(500);
    if (verifyLineSupplier(item, targetId)) {
      ui.setStatus(item.line, 'success', `Changed to ${targetId} (verified)`);
      appendLog({ line: item.line, sku: item.sku, from: originalSupplierId, to: targetId, status: 'verified' });
    } else {
      ui.setStatus(item.line, 'saved', `Saved — page should reload shortly to confirm`);
      appendLog({ line: item.line, sku: item.sku, from: originalSupplierId, to: targetId, status: 'saved_unverified' });
    }
  }

  // ---------- orchestration ----------

  async function run(targetId, skuFilters, maxLines, dryRun, ui, budgetOverride) {
    running = true;
    stopRequested = false;
    ui.setRunningState(true);

    const allItems = scanReqLines();
    const items = skuFilters && skuFilters.length
      ? allItems.filter((it) => skuFilters.includes(normalizeSku(it.sku)))
      : allItems;

    if (skuFilters && skuFilters.length && items.length === 0) {
      ui.renderRows([]);
      ui.setSummary(`No line(s) found matching SKU(s): ${skuFilters.join(', ')}`, 'warn');
      clearResumeState();
      running = false;
      ui.setRunningState(false);
      return;
    }

    ui.renderRows(items);

    const toFix = [];
    items.forEach((it) => {
      if (itemMatchesTarget(it, targetId)) {
        ui.setStatus(it.line, 'match', 'Already correct');
      } else {
        ui.setStatus(it.line, 'pending', 'Queued');
        toFix.push(it);
      }
    });

    if (toFix.length === 0) {
      clearResumeState();
      ui.setSummary(`All matching line(s) already on ${targetId}. Nothing to do.`, 'ok');
      running = false;
      ui.setRunningState(false);
      return;
    }

    // Safety cap: refuse to silently blow past the line budget the user
    // approved. If more lines need changing than the cap allows, only the
    // first N (by budget) are queued and the rest are left untouched with
    // a clear "over cap" status so nothing is changed without the user
    // explicitly raising the limit.
    const budget = typeof budgetOverride === 'number' ? budgetOverride : maxLines;
    const queued = toFix.slice(0, budget);
    const overCap = toFix.slice(budget);
    overCap.forEach((it) => ui.setStatus(it.line, 'capped', `Skipped — over the ${maxLines}-line cap for this run`));

    if (dryRun) {
      queued.forEach((it) => ui.setStatus(it.line, 'would_change', `Would change ${it.supplierId} → ${targetId}`));
      clearResumeState();
      ui.setSummary(
        `Dry run: ${queued.length} of ${items.length} line(s) would change to ${targetId}.` +
        (overCap.length ? ` ${overCap.length} more exceed the ${maxLines}-line cap.` : '') +
        ' No changes were made.',
        'info'
      );
      running = false;
      ui.setRunningState(false);
      return;
    }

    // Remember what we're doing BEFORE we touch anything that could trigger
    // a save - saving a line reloads this page out from under the script,
    // so this flag is what lets the next page load pick back up. We store
    // the remaining budget so a resumed run can't exceed the cap the user
    // originally approved.
    saveResumeState(targetId, skuFilters, maxLines, budget);
    ui.setSummary(
      `${queued.length} of ${items.length} line(s) changing to ${targetId}` +
      (overCap.length ? ` (${overCap.length} over the ${maxLines}-line cap, skipped)` : '') +
      '. This page reloads after each save — leave the tab open, the panel resumes itself.',
      'info'
    );

    let remaining = budget;
    for (const item of queued) {
      if (stopRequested) {
        ui.setStatus(item.line, 'pending', 'Stopped before running');
        continue;
      }
      try {
        await fixLine(item, targetId, ui);
      } catch (e) {
        ui.setStatus(item.line, 'error', e.message);
        appendLog({ line: item.line, sku: item.sku, from: item.supplierId, to: targetId, status: 'error', note: e.message });
      }
      remaining -= 1;
      saveResumeState(targetId, skuFilters, maxLines, remaining);
      await sleep(400);
    }

    // If we ever get here, either nothing forced a reload (e.g. the
    // remaining items all hit not_found/error) or we finished naturally -
    // either way there's nothing left to resume.
    clearResumeState();
    ui.setSummary(stopRequested ? 'Stopped by user.' : 'Finished.', stopRequested ? 'warn' : 'ok');
    running = false;
    ui.setRunningState(false);
  }

  // ---------- floating control panel ----------

  const STATUS_STYLES = {
    match:        { icon: '✓', label: 'OK', color: '#1a7f37', bg: '#eafbea' },
    pending:      { icon: '…', label: 'Queued', color: '#57606a', bg: '#f3f4f6' },
    processing:   { icon: '↻', label: 'Working', color: '#0969da', bg: '#eaf2fe' },
    success:      { icon: '✓', label: 'Done', color: '#1a7f37', bg: '#eafbea' },
    saved:        { icon: '⤓', label: 'Saved', color: '#0969da', bg: '#eaf2fe' },
    not_found:    { icon: '!', label: 'Not offered', color: '#9a6700', bg: '#fff6e0' },
    error:        { icon: '✕', label: 'Error', color: '#cf222e', bg: '#ffecec' },
    capped:       { icon: '⊘', label: 'Capped', color: '#9a6700', bg: '#fff6e0' },
    would_change: { icon: '→', label: 'Preview', color: '#8250df', bg: '#f5eeff' },
    tax_error:    { icon: '⚠', label: 'Tax code', color: '#9a6700', bg: '#fff6e0' },
  };

  const SUMMARY_STYLES = {
    info: { color: '#0969da', bg: '#eaf2fe' },
    ok:   { color: '#1a7f37', bg: '#eafbea' },
    warn: { color: '#9a6700', bg: '#fff6e0' },
    err:  { color: '#cf222e', bg: '#ffecec' },
  };

  function injectStyles() {
    if (document.getElementById('rsf-styles')) return;
    const style = document.createElement('style');
    style.id = 'rsf-styles';
    style.textContent = `
      #rsf-panel {
        position: fixed; top: 16px; right: 16px; z-index: 999999;
        width: 380px; max-width: calc(100vw - 32px);
        background: #ffffff; color: #1f2328;
        border: 1px solid #d0d7de; border-radius: 10px;
        box-shadow: 0 8px 24px rgba(140,149,159,0.3), 0 1px 3px rgba(0,0,0,0.1);
        font: 12.5px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Arial, sans-serif;
        overflow: hidden;
      }
      #rsf-header {
        display: flex; align-items: center; justify-content: space-between;
        background: #24292f; color: #fff; padding: 10px 12px; cursor: move; user-select: none;
      }
      #rsf-header .rsf-title { font-weight: 600; font-size: 13px; display:flex; align-items:center; gap:6px; }
      #rsf-header .rsf-dot { width:7px; height:7px; border-radius:50%; background:#8b949e; display:inline-block; }
      #rsf-header .rsf-dot.on { background:#3fb950; }
      #rsf-header button {
        background: transparent; border: none; color: #d0d7de; cursor: pointer;
        font-size: 14px; padding: 2px 6px; border-radius: 4px; line-height:1;
      }
      #rsf-header button:hover { background: rgba(255,255,255,0.15); color:#fff; }
      #rsf-body { padding: 12px; }
      #rsf-panel.rsf-collapsed #rsf-body { display: none; }
      .rsf-field { margin-bottom: 8px; }
      .rsf-field label { display:block; font-weight:600; margin-bottom:3px; color:#57606a; font-size:11px; text-transform:uppercase; letter-spacing:.03em; }
      .rsf-field input[type="text"], .rsf-field input:not([type]) {
        width: 100%; box-sizing: border-box; padding: 6px 8px;
        border: 1px solid #d0d7de; border-radius: 6px; font-size: 12.5px;
      }
      .rsf-field input:focus { outline: none; border-color:#0969da; box-shadow:0 0 0 3px rgba(9,105,218,0.15); }
      .rsf-row2 { display:flex; gap:8px; }
      .rsf-row2 > div { flex: 1; }
      .rsf-checkline { display:flex; align-items:center; gap:6px; margin: 8px 0; }
      .rsf-checkline label { font-size: 12px; color:#1f2328; }
      #rsf-btnrow { display: flex; gap: 8px; margin-top: 4px; margin-bottom: 8px; }
      #rsf-btnrow button {
        flex: 1; padding: 7px 10px; border-radius: 6px; border: 1px solid transparent;
        font-size: 12.5px; font-weight: 600; cursor: pointer;
      }
      #rsf-start { background: #1f883d; color: #fff; }
      #rsf-start:hover:not(:disabled) { background: #1a7f37; }
      #rsf-start:disabled { background:#94d3a2; cursor:not-allowed; }
      #rsf-stop { background: #fff; color: #cf222e; border-color: #d0d7de; }
      #rsf-stop:hover:not(:disabled) { background: #ffecec; border-color:#cf222e; }
      #rsf-stop:disabled { color:#c9c9c9; cursor:not-allowed; }
      #rsf-summary {
        padding: 7px 9px; border-radius: 6px; margin-bottom: 8px; font-size: 12px;
        display: none;
      }
      #rsf-rows { max-height: 280px; overflow: auto; border-top: 1px solid #eaeef2; padding-top: 6px; }
      .rsf-row { display:flex; align-items:flex-start; gap:8px; padding:5px 6px; border-radius:6px; margin-bottom:3px; }
      .rsf-row .rsf-icon {
        flex: none; width:18px; height:18px; border-radius:50%;
        display:flex; align-items:center; justify-content:center; font-size:11px; font-weight:700;
        color:#fff;
      }
      .rsf-row .rsf-main { flex:1; min-width:0; }
      .rsf-row .rsf-line { font-weight:600; }
      .rsf-row .rsf-sub { font-size:11px; color:#57606a; }
      .rsf-row .rsf-status-text { font-size:11px; margin-top:1px; }
      #rsf-log-toggle { font-size: 11px; color:#0969da; cursor:pointer; text-decoration: underline; background:none; border:none; padding:0; margin-top:6px; }
      #rsf-log { max-height: 140px; overflow:auto; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 10.5px; background:#f6f8fa; border-radius:6px; padding:6px; margin-top:6px; display:none; white-space:pre-wrap; }
      #rsf-log.rsf-log-open { display:block; }
      .rsf-hint { font-size: 11px; color: #6e7781; margin-top: 2px; }
      .rsf-resume-banner { background:#fff6e0; color:#9a6700; border:1px solid #eac54f; border-radius:6px; padding:6px 8px; font-size:11.5px; margin-bottom:8px; }

      /* Confirmation overlay */
      #rsf-confirm-overlay {
        position: fixed; inset: 0; background: rgba(31,35,40,0.5); z-index: 1000000;
        display: flex; align-items: center; justify-content: center;
      }
      #rsf-confirm-box {
        background: #fff; border-radius: 10px; width: 360px; max-width: calc(100vw - 40px);
        box-shadow: 0 12px 32px rgba(0,0,0,0.35); font: 12.5px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Arial, sans-serif;
        color: #1f2328; overflow:hidden;
      }
      #rsf-confirm-box .rsf-c-head { padding: 14px 16px 6px; font-weight: 700; font-size: 14px; }
      #rsf-confirm-box .rsf-c-body { padding: 4px 16px 14px; }
      #rsf-confirm-box .rsf-c-body b { color:#0969da; }
      #rsf-confirm-box .rsf-c-warn { background:#fff6e0; color:#9a6700; border-radius:6px; padding:8px; margin-top:8px; font-size:11.5px; }
      #rsf-confirm-box .rsf-c-btns { display:flex; gap:8px; padding: 0 16px 16px; }
      #rsf-confirm-box .rsf-c-btns button { flex:1; padding: 8px 10px; border-radius:6px; font-weight:600; font-size:12.5px; cursor:pointer; }
      #rsf-confirm-cancel { background:#fff; border:1px solid #d0d7de; }
      #rsf-confirm-cancel:hover { background:#f3f4f6; }
      #rsf-confirm-go { background:#1f883d; color:#fff; border:1px solid transparent; }
      #rsf-confirm-go:hover { background:#1a7f37; }

      /* Tax code fix overlay - same look as the confirm overlay, own ids so
         both could theoretically coexist without clashing */
      #rsf-tax-overlay {
        position: fixed; inset: 0; background: rgba(31,35,40,0.5); z-index: 1000001;
        display: flex; align-items: center; justify-content: center;
      }
      #rsf-tax-box {
        background: #fff; border-radius: 10px; width: 340px; max-width: calc(100vw - 40px);
        box-shadow: 0 12px 32px rgba(0,0,0,0.35); font: 12.5px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Arial, sans-serif;
        color: #1f2328; overflow:hidden;
      }
      #rsf-tax-box .rsf-c-head { padding: 14px 16px 6px; font-weight: 700; font-size: 14px; color:#9a6700; }
      #rsf-tax-box .rsf-c-body { padding: 4px 16px 14px; }
      #rsf-tax-box .rsf-c-body b { color:#0969da; }
      #rsf-tax-box .rsf-c-btns { display:flex; gap:8px; padding: 0 16px 16px; }
      #rsf-tax-na { flex:1; padding: 9px 10px; border-radius:6px; font-weight:700; font-size:13px; cursor:pointer; background:#9a6700; color:#fff; border:1px solid transparent; }
      #rsf-tax-na:hover { background:#7d5500; }
    `;
    document.head.appendChild(style);
  }

  function makeDraggable(panel, handle) {
    let dragging = false, startX = 0, startY = 0, startRight = 0, startTop = 0;
    handle.addEventListener('mousedown', (e) => {
      if (e.target.closest('button')) return;
      dragging = true;
      startX = e.clientX;
      startY = e.clientY;
      const rect = panel.getBoundingClientRect();
      startRight = window.innerWidth - rect.right;
      startTop = rect.top;
      e.preventDefault();
    });
    window.addEventListener('mousemove', (e) => {
      if (!dragging) return;
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;
      panel.style.right = Math.max(4, startRight - dx) + 'px';
      panel.style.top = Math.max(4, startTop + dy) + 'px';
    });
    window.addEventListener('mouseup', () => { dragging = false; });
  }

  function showConfirm({ targetId, skuFilters, count, total, cap }) {
    return new Promise((resolve) => {
      const overlay = document.createElement('div');
      overlay.id = 'rsf-confirm-overlay';
      overlay.innerHTML = `
        <div id="rsf-confirm-box">
          <div class="rsf-c-head">Confirm supplier change</div>
          <div class="rsf-c-body">
            This will reassign <b>${count}</b> of ${total} line item(s) on this requisition to
            <b>${escapeHtml(targetId)}</b>${skuFilters.length ? ` (SKU filter: ${escapeHtml(skuFilters.join(', '))})` : ''}.
            ${count > cap ? `<div class="rsf-c-warn">${count - cap} line(s) exceed your ${cap}-line cap and will be skipped this run.</div>` : ''}
            <div class="rsf-c-warn">Each change is saved live in Birchstreet as it runs — this is not reversible by this tool. Double-check the target supplier before continuing.</div>
          </div>
          <div class="rsf-c-btns">
            <button id="rsf-confirm-cancel">Cancel</button>
            <button id="rsf-confirm-go">Confirm &amp; run</button>
          </div>
        </div>
      `;
      document.body.appendChild(overlay);
      const cleanup = (result) => { overlay.remove(); resolve(result); };
      overlay.querySelector('#rsf-confirm-cancel').addEventListener('click', () => cleanup(false));
      overlay.addEventListener('click', (e) => { if (e.target === overlay) cleanup(false); });
      overlay.querySelector('#rsf-confirm-go').addEventListener('click', () => cleanup(true));
    });
  }

  function buildUI() {
    injectStyles();

    const panel = document.createElement('div');
    panel.id = 'rsf-panel';
    panel.innerHTML = `
      <div id="rsf-header">
        <span class="rsf-title"><span class="rsf-dot" id="rsf-dot"></span>REQ Supplier Fixer</span>
        <span>
          <button id="rsf-collapse" title="Collapse">–</button>
          <button id="rsf-close" title="Close">×</button>
        </span>
      </div>
      <div id="rsf-body">
        <div id="rsf-resume-banner" class="rsf-resume-banner" style="display:none;"></div>

        <div class="rsf-field">
          <label>Target supplier</label>
          <input id="rsf-supplier" type="text" placeholder="ID (e.g. 2917) or name fragment (e.g. Chef 2 Chef)">
        </div>
        <div class="rsf-field">
          <label>SKU filter (optional)</label>
          <input id="rsf-sku" type="text" placeholder="Comma-separated SKUs, blank = all lines">
        </div>
        <div class="rsf-row2">
          <div class="rsf-field">
            <label>Max lines this run</label>
            <input id="rsf-cap" type="text" value="25">
          </div>
          <div class="rsf-field" style="display:flex; align-items:flex-end;">
            <div class="rsf-checkline" style="margin-bottom:8px;">
              <input type="checkbox" id="rsf-dryrun">
              <label for="rsf-dryrun">Dry run (preview only)</label>
            </div>
          </div>
        </div>
        <div class="rsf-hint">A safety cap and a confirmation step apply before any line is changed. Dry run scans and previews without touching anything. If Birchstreet blocks a save with "Tax code is invalid or blank", a one-click NA fix prompt appears automatically.</div>

        <div id="rsf-btnrow">
          <button id="rsf-start">Start</button>
          <button id="rsf-stop" disabled>Stop</button>
        </div>

        <div id="rsf-summary"></div>
        <div id="rsf-rows"></div>
        <div id="rsf-autona-status" style="display:none; font-size:11px; color:#9a6700; margin-top:6px;"></div>
        <button id="rsf-log-toggle">Show activity log</button>
        <div id="rsf-log"></div>
      </div>
    `;
    document.body.appendChild(panel);

    const header = panel.querySelector('#rsf-header');
    makeDraggable(panel, header);

    panel.querySelector('#rsf-collapse').addEventListener('click', () => {
      panel.classList.toggle('rsf-collapsed');
      panel.querySelector('#rsf-collapse').textContent = panel.classList.contains('rsf-collapsed') ? '+' : '–';
    });
    panel.querySelector('#rsf-close').addEventListener('click', () => {
      if (running) {
        if (!confirm('A run is in progress. Close the panel anyway? The run will keep going but you will lose visibility into it.')) return;
      }
      panel.remove();
    });

    const rowsDiv = panel.querySelector('#rsf-rows');
    const summaryDiv = panel.querySelector('#rsf-summary');
    const logDiv = panel.querySelector('#rsf-log');
    const logToggle = panel.querySelector('#rsf-log-toggle');
    const dot = panel.querySelector('#rsf-dot');
    const startBtn = panel.querySelector('#rsf-start');
    const stopBtn = panel.querySelector('#rsf-stop');
    const supplierInput = panel.querySelector('#rsf-supplier');
    const skuInput = panel.querySelector('#rsf-sku');
    const capInput = panel.querySelector('#rsf-cap');
    const dryrunInput = panel.querySelector('#rsf-dryrun');
    const resumeBanner = panel.querySelector('#rsf-resume-banner');
    const autoNaStatus = panel.querySelector('#rsf-autona-status');
    const rowEls = {};

    function renderAutoNaStatus() {
      if (getAutoTaxNa()) {
        autoNaStatus.style.display = 'block';
        autoNaStatus.innerHTML = '⚠ Tax-code fix remembered: NA will auto-fill on any tax-code alert. <a href="#" id="rsf-autona-clear" style="color:#0969da;">Forget</a>';
        const clearLink = autoNaStatus.querySelector('#rsf-autona-clear');
        if (clearLink) {
          clearLink.addEventListener('click', (e) => {
            e.preventDefault();
            setAutoTaxNa(false);
            renderAutoNaStatus();
          });
        }
      } else {
        autoNaStatus.style.display = 'none';
        autoNaStatus.innerHTML = '';
      }
    }
    renderAutoNaStatus();

    function renderLog() {
      const log = loadLog();
      if (!log.length) {
        logDiv.textContent = '(no changes logged yet this session)';
        return;
      }
      logDiv.textContent = log
        .map((e) => `[${e.time.replace('T', ' ').slice(0, 19)}] line ${e.line}${e.sku ? ' (SKU ' + e.sku + ')' : ''}: ${e.from} → ${e.to} — ${e.status}${e.note ? ' (' + e.note + ')' : ''}`)
        .join('\n');
    }
    renderLog();

    logToggle.addEventListener('click', () => {
      const open = logDiv.classList.toggle('rsf-log-open');
      logToggle.textContent = open ? 'Hide activity log' : 'Show activity log';
      if (open) renderLog();
    });

    const ui = {
      renderRows(items) {
        rowsDiv.innerHTML = '';
        for (const key in rowEls) delete rowEls[key];
        items.forEach((it) => {
          const row = document.createElement('div');
          row.className = 'rsf-row';
          row.style.background = STATUS_STYLES.pending.bg;
          row.innerHTML = `
            <span class="rsf-icon" style="background:${STATUS_STYLES.pending.color}">…</span>
            <span class="rsf-main">
              <div class="rsf-line">Line ${escapeHtml(it.line)} <span class="rsf-sub">— ${escapeHtml(it.supplierName || 'Unknown supplier')} (${escapeHtml(it.supplierId)})${it.sku ? ' · SKU ' + escapeHtml(it.sku) : ''}</span></div>
              <div class="rsf-status-text">Waiting…</div>
            </span>
          `;
          rowsDiv.appendChild(row);
          rowEls[it.line] = row;
        });
      },
      setStatus(line, status, text) {
        const row = rowEls[line];
        if (!row) return;
        const style = STATUS_STYLES[status] || STATUS_STYLES.pending;
        row.style.background = style.bg;
        row.querySelector('.rsf-icon').style.background = style.color;
        row.querySelector('.rsf-icon').textContent = style.icon;
        const textEl = row.querySelector('.rsf-status-text');
        textEl.textContent = text;
        textEl.style.color = style.color;
        renderLog();
        renderAutoNaStatus();
      },
      setSummary(text, kind) {
        const style = SUMMARY_STYLES[kind] || SUMMARY_STYLES.info;
        summaryDiv.style.display = 'block';
        summaryDiv.style.background = style.bg;
        summaryDiv.style.color = style.color;
        summaryDiv.textContent = text;
      },
      setRunningState(isRunning) {
        dot.classList.toggle('on', isRunning);
        startBtn.disabled = isRunning;
        stopBtn.disabled = !isRunning;
        supplierInput.disabled = isRunning;
        skuInput.disabled = isRunning;
        capInput.disabled = isRunning;
        dryrunInput.disabled = isRunning;
      },
    };

    function parsedCap() {
      const n = parseInt(capInput.value, 10);
      return Number.isFinite(n) && n > 0 ? n : 25;
    }

    async function startClicked() {
      if (running) {
        ui.setSummary('Already running.', 'warn');
        return;
      }
      const id = supplierInput.value.trim();
      if (!id) {
        ui.setSummary('Enter a target supplier ID or name first.', 'err');
        return;
      }
      const skuRaw = skuInput.value.trim();
      const skuFilters = skuRaw ? skuRaw.split(',').map((s) => normalizeSku(s)).filter(Boolean) : [];
      const cap = parsedCap();
      const dryRun = dryrunInput.checked;

      // Preview the scope so the confirmation dialog can show real numbers,
      // without touching anything yet.
      const allItems = scanReqLines();
      const items = skuFilters.length ? allItems.filter((it) => skuFilters.includes(normalizeSku(it.sku))) : allItems;
      const toFixCount = items.filter((it) => !itemMatchesTarget(it, id)).length;

      if (toFixCount === 0) {
        ui.renderRows(items);
        items.forEach((it) => ui.setStatus(it.line, 'match', 'Already correct'));
        ui.setSummary(`All matching line(s) already on ${id}. Nothing to do.`, 'ok');
        return;
      }

      if (dryRun) {
        run(id, skuFilters, cap, true, ui);
        return;
      }

      const confirmed = await showConfirm({ targetId: id, skuFilters, count: toFixCount, total: items.length, cap });
      if (!confirmed) {
        ui.setSummary('Cancelled — no changes made.', 'warn');
        return;
      }
      run(id, skuFilters, cap, false, ui);
    }

    startBtn.addEventListener('click', () => { startClicked(); });

    stopBtn.addEventListener('click', () => {
      stopRequested = true;
      clearResumeState();
      ui.setSummary('Stopping after the current line…', 'warn');
    });

    // Auto-resume: if a reload just happened mid-run (Save was clicked),
    // pick the target supplier (and SKU filter / cap, if any) back up and
    // keep going without waiting for the user to click Start again. The
    // remaining budget from before the reload is honored so a resumed run
    // still can't exceed the cap the user originally confirmed.
    const resume = loadResumeState();
    if (resume) {
      supplierInput.value = resume.targetId;
      skuInput.value = resume.skuFilters.join(', ');
      if (resume.maxLines) capInput.value = String(resume.maxLines);
      resumeBanner.style.display = 'block';
      resumeBanner.textContent =
        `Resuming an in-progress run for "${resume.targetId}"` +
        (resume.skuFilters.length ? ` (SKU filter: ${resume.skuFilters.join(', ')})` : '') +
        ` after a page reload. ${resume.remainingBudget} line(s) left in this run's budget.`;
      run(resume.targetId, resume.skuFilters, resume.maxLines || 25, false, ui, resume.remainingBudget);
    }
  }

  buildUI();
})();
