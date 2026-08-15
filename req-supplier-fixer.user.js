// ==UserScript==
// @name         REQ Supplier Auto-Fixer
// @namespace    userscript-req-supplier-fix
// @version      2.2
// @description  Scans a requisition page and reassigns line item(s) to a target supplier, optionally filtered to specific item SKU(s).
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
  const RESUME_MAX_AGE_MS = 3 * 60 * 1000; // ignore stale flags from abandoned runs

  function saveResumeState(targetId, skuFilters) {
    try {
      sessionStorage.setItem(RESUME_KEY, JSON.stringify({ targetId, skuFilters: skuFilters || [], ts: Date.now() }));
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
    editWin.document.getElementById('okclick').click(); // "Save"
    await waitForClosed(() => editWin).catch(() => {
      if (!editWin.closed) editWin.close();
    });

    await sleep(500);
    if (verifyLineSupplier(item, targetId)) {
      ui.setStatus(item.line, 'success', `Changed to ${targetId} (verified)`);
    } else {
      ui.setStatus(item.line, 'saved', `Saved — page should reload shortly to confirm`);
    }
  }

  // ---------- orchestration ----------

  async function run(targetId, skuFilters, ui) {
    running = true;
    stopRequested = false;

    const allItems = scanReqLines();
    const items = skuFilters && skuFilters.length
      ? allItems.filter((it) => skuFilters.includes(normalizeSku(it.sku)))
      : allItems;

    if (skuFilters && skuFilters.length && items.length === 0) {
      ui.renderRows([]);
      ui.setSummary(`No line(s) found matching SKU(s): ${skuFilters.join(', ')}`);
      clearResumeState();
      running = false;
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
      ui.setSummary(`All matching line(s) already on ${targetId}. Finished.`);
      running = false;
      return;
    }

    // Remember what we're doing BEFORE we touch anything that could trigger
    // a save - saving a line reloads this page out from under the script,
    // so this flag is what lets the next page load pick back up.
    saveResumeState(targetId, skuFilters);
    ui.setSummary(
      `${toFix.length} of ${items.length} line(s) need changing to ${targetId}. ` +
      `Note: this page reloads after each save - leave the tab open, the panel resumes itself.`
    );

    for (const item of toFix) {
      if (stopRequested) {
        ui.setStatus(item.line, 'pending', 'Stopped before running');
        continue;
      }
      try {
        await fixLine(item, targetId, ui);
      } catch (e) {
        ui.setStatus(item.line, 'error', e.message);
      }
      await sleep(400);
    }

    // If we ever get here, either nothing forced a reload (e.g. the
    // remaining items all hit not_found/error) or we finished naturally -
    // either way there's nothing left to resume.
    clearResumeState();
    ui.setSummary(stopRequested ? 'Stopped.' : 'Finished.');
    running = false;
  }

  // ---------- floating control panel ----------

  const STATUS_STYLES = {
    match:      { icon: '✅', color: '#1a7f37', bg: '#eafbea' },
    pending:    { icon: '⏳', color: '#666', bg: '#f2f2f2' },
    processing: { icon: '🔄', color: '#0969da', bg: '#eaf2fe' },
    success:    { icon: '✅', color: '#1a7f37', bg: '#eafbea' },
    saved:      { icon: '💾', color: '#0969da', bg: '#eaf2fe' },
    not_found:  { icon: '⚠️', color: '#9a6700', bg: '#fff6e0' },
    error:      { icon: '❌', color: '#cf222e', bg: '#ffecec' },
  };

  function buildUI() {
    const box = document.createElement('div');
    box.style.cssText =
      'position:fixed;top:10px;right:10px;z-index:999999;background:#fff;border:1px solid #333;' +
      'padding:10px;font:12px arial;width:340px;box-shadow:0 2px 8px rgba(0,0,0,.3);border-radius:6px;';
    box.innerHTML = `
      <div style="font-weight:bold;margin-bottom:6px;">REQ Supplier Fixer</div>
      <input id="rsf-supplier" placeholder="Supplier ID or name e.g. 2917 or Chef 2 Chef" style="width:100%;margin-bottom:6px;box-sizing:border-box;">
      <input id="rsf-sku" placeholder="Item SKU(s), comma-separated (blank = all lines)" style="width:100%;margin-bottom:6px;box-sizing:border-box;">
      <div style="margin-bottom:6px;">
        <button id="rsf-start" style="margin-right:6px;">Start</button>
        <button id="rsf-stop">Stop</button>
      </div>
      <div id="rsf-summary" style="margin-bottom:4px;color:#444;font-style:italic;"></div>
      <div id="rsf-rows" style="max-height:320px;overflow:auto;border-top:1px solid #ddd;padding-top:4px;"></div>
    `;
    document.body.appendChild(box);

    const rowsDiv = box.querySelector('#rsf-rows');
    const summaryDiv = box.querySelector('#rsf-summary');
    const rowEls = {};

    const ui = {
      renderRows(items) {
        rowsDiv.innerHTML = '';
        for (const key in rowEls) delete rowEls[key];
        items.forEach((it) => {
          const row = document.createElement('div');
          row.style.cssText =
            'display:flex;align-items:center;gap:6px;padding:4px 4px;border-radius:4px;margin-bottom:3px;';
          row.innerHTML = `
            <span class="rsf-icon">⏳</span>
            <span style="flex:1;">
              <div><b>Line ${it.line}</b> — ${it.supplierName || 'Unknown supplier'} (${it.supplierId})${it.sku ? ' — SKU ' + it.sku : ''}</div>
              <div class="rsf-text" style="font-size:11px;color:#555;">Waiting…</div>
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
        row.querySelector('.rsf-icon').textContent = style.icon;
        const textEl = row.querySelector('.rsf-text');
        textEl.textContent = text;
        textEl.style.color = style.color;
      },
      setSummary(text) {
        summaryDiv.textContent = text;
      },
    };

    box.querySelector('#rsf-start').addEventListener('click', () => {
      if (running) {
        ui.setSummary('Already running.');
        return;
      }
      const id = box.querySelector('#rsf-supplier').value.trim();
      if (!id) {
        ui.setSummary('Enter a supplier ID or name first.');
        return;
      }
      const skuRaw = box.querySelector('#rsf-sku').value.trim();
      const skuFilters = skuRaw
        ? skuRaw.split(',').map((s) => normalizeSku(s)).filter(Boolean)
        : [];
      run(id, skuFilters, ui);
    });

    box.querySelector('#rsf-stop').addEventListener('click', () => {
      stopRequested = true;
      clearResumeState();
      ui.setSummary('Stopping after current line…');
    });

    // Auto-resume: if a reload just happened mid-run (Save was clicked),
    // pick the target supplier (and SKU filter, if any) back up and keep
    // going without waiting for the user to click Start again.
    const resume = loadResumeState();
    if (resume) {
      box.querySelector('#rsf-supplier').value = resume.targetId;
      box.querySelector('#rsf-sku').value = resume.skuFilters.join(', ');
      ui.setSummary(
        `Resuming run for "${resume.targetId}"` +
        (resume.skuFilters.length ? ` (SKU filter: ${resume.skuFilters.join(', ')})` : '') +
        ` after page reload…`
      );
      run(resume.targetId, resume.skuFilters, ui);
    }
  }

  buildUI();
})();
