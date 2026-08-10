// ==UserScript==
// @name         REQ Supplier Auto-Fixer
// @namespace    userscript-req-supplier-fix
// @version      2.0
// @description  Scans a requisition page, shows live per-line status, and reassigns any line item not on the target supplier to that supplier automatically.
// @match        https://YOUR-PROCUREMENT-DOMAIN/*
// @grant        unsafeWindow
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';

  // ------------------------------------------------------------------
  // EDIT THIS: change the @match line above to your actual procurement
  // domain (e.g. https://yourcompany.birchstreet.net/*), otherwise the
  // script will never load on the page.
  // ------------------------------------------------------------------

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

  // ---------- REQ page parsing ----------

  // Collect { line, reqNumber, supplierId, supplierName, link } for every row.
  // supplierId is the 3rd arg of ItemEdit(reqNumber, line, supplierId) - the
  // supplier company ID currently assigned to that line.
  function scanReqLines() {
    const anchors = uw.document.querySelectorAll('div[name="EditLine"] a[onclick^="ItemEdit"]');
    const items = [];
    anchors.forEach((a) => {
      const m = a.getAttribute('onclick').match(/ItemEdit\('([^']+)','([^']+)','([^']+)'\)/);
      if (!m) return;
      const row = a.closest('tr');
      const supplierName = row ? (row.children[1] ? row.children[1].textContent.trim() : '') : '';
      items.push({
        reqNumber: m[1],
        line: m[2],
        supplierId: m[3],
        supplierName,
        link: a,
      });
    });
    return items;
  }

  // ---------- the 3-window supplier-swap flow ----------

  async function fixLine(item, targetId, ui) {
    ui.setStatus(item.line, 'processing', 'Opening line…');

    const editWinPromise = hookNextOpen(uw);
    item.link.click();
    const editWin = await editWinPromise;

    ui.setStatus(item.line, 'processing', 'Waiting for line editor…');
    await waitForWindowLoaded(() => editWin, (w) => w.document.getElementById('PartChgSupp'));
    await sleep(300);

    ui.setStatus(item.line, 'processing', 'Opening supplier list…');
    const suppWinPromise = hookNextOpen(editWin);
    editWin.document.getElementById('PartChgSupp').click();
    const suppWin = await suppWinPromise;

    await waitForWindowLoaded(() => suppWin, (w) => w.document.querySelector('input[name="R1"]'));
    await sleep(300);

    const infoCell = Array.from(suppWin.document.querySelectorAll('td[id^="info"]')).find(
      (td) => td.getAttribute('supplier_comp_id') === targetId
    );

    if (!infoCell) {
      suppWin.close();
      await sleep(200);
      if (!editWin.closed) editWin.close();
      ui.setStatus(item.line, 'not_found', `Supplier ${targetId} not offered for this item`);
      return;
    }

    ui.setStatus(item.line, 'processing', 'Selecting supplier…');
    const idx = infoCell.id.replace('info', '');
    const radio = suppWin.document.getElementById('RB' + idx);
    radio.click();
    await sleep(150);

    suppWin.document.getElementById('ReleaseInvoice').click();
    await waitForClosed(() => suppWin);

    await sleep(300);
    if (!editWin.closed) editWin.close();
    await waitForClosed(() => editWin);

    ui.setStatus(item.line, 'success', `Changed to ${targetId}`);
  }

  // ---------- orchestration ----------

  async function run(targetId, ui) {
    running = true;
    stopRequested = false;

    const items = scanReqLines();
    ui.renderRows(items);

    const toFix = [];
    items.forEach((it) => {
      if (it.supplierId === targetId) {
        ui.setStatus(it.line, 'match', 'Already correct');
      } else {
        ui.setStatus(it.line, 'pending', 'Queued');
        toFix.push(it);
      }
    });

    ui.setSummary(`${toFix.length} of ${items.length} line(s) need changing to ${targetId}`);

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

    ui.setSummary(stopRequested ? 'Stopped.' : 'Finished.');
    running = false;
  }

  // ---------- floating control panel ----------

  const STATUS_STYLES = {
    match:      { icon: '✅', color: '#1a7f37', bg: '#eafbea' },
    pending:    { icon: '⏳', color: '#666',    bg: '#f2f2f2' },
    processing: { icon: '🔄', color: '#0969da', bg: '#eaf2fe' },
    success:    { icon: '✅', color: '#1a7f37', bg: '#eafbea' },
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
      <input id="rsf-supplier" placeholder="Target supplier ID e.g. 3976" style="width:100%;margin-bottom:6px;box-sizing:border-box;">
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
              <div><b>Line ${it.line}</b> — ${it.supplierName || 'Unknown supplier'} (${it.supplierId})</div>
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
        ui.setSummary('Enter a supplier ID first.');
        return;
      }
      run(id, ui);
    });

    box.querySelector('#rsf-stop').addEventListener('click', () => {
      stopRequested = true;
      ui.setSummary('Stopping after current line…');
    });
  }

  buildUI();
})();
