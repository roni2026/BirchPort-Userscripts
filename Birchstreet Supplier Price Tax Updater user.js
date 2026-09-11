// ==UserScript==
// @name         Birchstreet Supplier Price/Tax Updater
// @namespace    rick.birchstreet.tools
// @version      1.9
// @description  Floating, draggable, minimizable panel: fill Item SKU + Supplier + optional Trx Currency + Unit Price + optional Tax Code 1/2, then auto-drives the search list + entry form across the frameset.
// @author       roni2026
// @match        https://*.birchstreetsystems.com/*
// @grant        GM_setValue
// @grant        GM_getValue
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';

  // -----------------------------------------------------------------------
  // v1.9 changes:
  //
  //  1. FALSE "Unit Price" FAILURE: Birchstreet auto-prefixes the Unit
  //     Price field with "$" (and may insert thousands separators) the
  //     moment the field is committed (blur/change), turning a typed
  //     "1.9500" into "$1.9500" on screen. The old fillLikeUser()
  //     comparison did a plain norm() check (lowercase/trim/collapse
  //     whitespace only), so "$1.9500" != "1.9500" and it threw
  //     "field ended with ... instead of ..." even though the value
  //     entered correctly. The comparison now also strips currency
  //     symbols/commas from both sides before comparing, so
  //     Birchstreet's auto-formatting no longer trips a false failure.
  //
  //  2. DRAGGABLE PANEL: added a header bar (title + minimize button)
  //     that you can grab and drag anywhere on the page. Position is
  //     tracked in left/top (converted from the old fixed top/right
  //     placement) and persisted via GM_setValue so it remembers where
  //     you left it.
  //
  //  3. MINIMIZE: clicking the minimize button (–/+) collapses the
  //     panel down to just the header bar; clicking again restores it.
  //     State is also persisted via GM_setValue.
  // -----------------------------------------------------------------------

  console.log('[BSK Price Updater] script loaded on', location.href);

  // =====================================================================
  // ONLY CREATE UI IN HIGHEST REACHABLE FRAME
  // =====================================================================

  function isHighestReachableFrame() {
    if (window.top === window.self) {
      return true;
    }

    try {
      void window.top.document;
      return false;
    } catch (e) {
      return true;
    }
  }

  if (!isHighestReachableFrame()) {
    console.log(
      '[BSK Price Updater] not the highest reachable frame here, skipping.'
    );
    return;
  }

  try {
    initPanel();
  } catch (err) {
    console.error(
      '[BSK Price Updater] failed to initialize:',
      err
    );
  }

  // =====================================================================
  // MAIN
  // =====================================================================

  function initPanel() {

    console.log('[BSK Price Updater] initializing UI...');

    // ===================================================================
    // FIELD IDS
    // ===================================================================

    const FIELD = {
      row:      'FIELD101R1',
      price:    'FIELD118R1',
      currency: 'FIELD119R1',
      tax1:     'FIELD123R1',
      tax2:     'FIELD124R1'
    };

    const SEARCH_FIELD_VALUE = 'SUPER_SKU_CODE';

    // ===================================================================
    // TIMING
    // ===================================================================

    const STEP_DELAY_MS = 450;
    const KEY_DELAY_MS = 45;
    const CLICK_SETTLE_MS = 150;

    // ===================================================================
    // ASYNC HELPERS
    // ===================================================================

    const sleep = (ms) =>
      new Promise(resolve => setTimeout(resolve, ms));

    async function waitFor(
      condition,
      timeout = 10000,
      interval = 200
    ) {
      const start = Date.now();

      while (Date.now() - start < timeout) {

        try {
          const result = condition();

          if (result) {
            return result;
          }

        } catch (e) {
          // Keep polling.
        }

        await sleep(interval);
      }

      return null;
    }

    // ===================================================================
    // STRING HELPERS
    // ===================================================================

    function norm(s) {
      return String(s || '')
        .replace(/\u00A0/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .toLowerCase();
    }

    // Strips currency symbols / thousands separators so a value like
    // "$1,950.00" normalizes the same as "1950.00" for comparison
    // purposes. Only used to decide "did the field actually take the
    // value", never used to overwrite what's displayed on screen.
    function normForCompare(s) {
      return norm(s)
        .replace(/[$£€₹]/g, '')
        .replace(/,/g, '')
        .trim();
    }

    // ===================================================================
    // LOGGING
    // ===================================================================

    const logBox = document.createElement('textarea');

    function log(message) {

      console.log('[BSK Price Updater]', message);

      if (logBox) {

        const time =
          new Date().toLocaleTimeString();

        logBox.value +=
          `[${time}] ${message}\n`;

        logBox.scrollTop =
          logBox.scrollHeight;
      }
    }

    // ===================================================================
    // EVENT HELPERS
    // ===================================================================

    function fire(el, type) {

      if (!el) return;

      try {

        el.dispatchEvent(
          new Event(type, {
            bubbles: true,
            cancelable: true
          })
        );

      } catch (e) {
        // Ignore.
      }
    }

    function fireKeyboard(
      el,
      type,
      key,
      code,
      keyCode
    ) {

      if (!el) return;

      try {

        const event =
          new KeyboardEvent(type, {
            key,
            code,
            keyCode,
            which: keyCode,
            bubbles: true,
            cancelable: true
          });

        el.dispatchEvent(event);

      } catch (e) {
        // Ignore.
      }
    }

    function fireMouse(
      el,
      type
    ) {

      if (!el) return;

      try {

        const view =
          el.ownerDocument &&
          el.ownerDocument.defaultView
            ? el.ownerDocument.defaultView
            : window;

        el.dispatchEvent(
          new MouseEvent(type, {
            bubbles: true,
            cancelable: true,
            view
          })
        );

      } catch (e) {
        // Ignore.
      }
    }

    // ===================================================================
    // VISIBILITY
    // ===================================================================

    function isVisible(el) {

      if (!el) return false;

      try {

        const doc =
          el.ownerDocument;

        const view =
          doc &&
          doc.defaultView
            ? doc.defaultView
            : window;

        const style =
          view.getComputedStyle(el);

        if (!style) {
          return false;
        }

        if (
          style.display === 'none' ||
          style.visibility === 'hidden' ||
          style.visibility === 'collapse'
        ) {
          return false;
        }

        if (
          parseFloat(style.opacity || '1') === 0
        ) {
          return false;
        }

        return true;

      } catch (e) {

        return false;
      }
    }

    // ===================================================================
    // CLICK
    // ===================================================================

    function click(el) {

      if (!el) {
        throw new Error(
          'Cannot click null element.'
        );
      }

      try {

        el.scrollIntoView({
          block: 'center',
          inline: 'center'
        });

      } catch (e) {
        // Ignore.
      }

      fireMouse(el, 'mousedown');
      fireMouse(el, 'mouseup');
      fireMouse(el, 'click');

      try {

        if (
          typeof el.click === 'function'
        ) {
          el.click();
        }

      } catch (e) {
        // Ignore.
      }
    }

    // ===================================================================
    // FOCUS / TYPE
    // ===================================================================

    async function clickInto(el) {

      if (!el) {
        throw new Error(
          'Cannot focus missing field.'
        );
      }

      fireMouse(el, 'mousedown');

      try {
        el.focus();
      } catch (e) {
        // Ignore.
      }

      fireMouse(el, 'mouseup');
      fireMouse(el, 'click');

      await sleep(
        CLICK_SETTLE_MS
      );
    }

    async function clearField(el) {

      if (!el) return;

      await clickInto(el);

      fireKeyboard(
        el,
        'keydown',
        'Control',
        'ControlLeft',
        17
      );

      fireKeyboard(
        el,
        'keydown',
        'a',
        'KeyA',
        65
      );

      fireKeyboard(
        el,
        'keyup',
        'a',
        'KeyA',
        65
      );

      fireKeyboard(
        el,
        'keyup',
        'Control',
        'ControlLeft',
        17
      );

      await sleep(30);

      fireKeyboard(
        el,
        'keydown',
        'Backspace',
        'Backspace',
        8
      );

      try {
        el.value = '';
      } catch (e) {
        // Ignore.
      }

      fire(el, 'input');

      fireKeyboard(
        el,
        'keyup',
        'Backspace',
        'Backspace',
        8
      );

      await sleep(50);
    }

    function getKeyInfo(ch) {

      if (
        ch >= '0' &&
        ch <= '9'
      ) {
        return {
          code: `Digit${ch}`,
          keyCode: ch.charCodeAt(0)
        };
      }

      if (
        ch >= 'a' &&
        ch <= 'z'
      ) {
        return {
          code: `Key${ch.toUpperCase()}`,
          keyCode:
            ch.toUpperCase().charCodeAt(0)
        };
      }

      if (
        ch >= 'A' &&
        ch <= 'Z'
      ) {
        return {
          code: `Key${ch}`,
          keyCode:
            ch.charCodeAt(0)
        };
      }

      if (ch === '.') {
        return {
          code: 'Period',
          keyCode: 190
        };
      }

      if (ch === '-') {
        return {
          code: 'Minus',
          keyCode: 189
        };
      }

      if (ch === '/') {
        return {
          code: 'Slash',
          keyCode: 191
        };
      }

      if (ch === ' ') {
        return {
          code: 'Space',
          keyCode: 32
        };
      }

      return {
        code: '',
        keyCode:
          ch.charCodeAt(0)
      };
    }

    async function typeValue(
      el,
      value
    ) {

      value =
        String(value ?? '');

      for (
        const ch of value
      ) {

        const info =
          getKeyInfo(ch);

        fireKeyboard(
          el,
          'keydown',
          ch,
          info.code,
          info.keyCode
        );

        try {
          el.value += ch;
        } catch (e) {
          // Ignore.
        }

        fire(
          el,
          'input'
        );

        fireKeyboard(
          el,
          'keyup',
          ch,
          info.code,
          info.keyCode
        );

        await sleep(
          KEY_DELAY_MS
        );
      }
    }

    async function fillLikeUser(
      el,
      value,
      label
    ) {

      if (!el) {
        throw new Error(
          `${label}: field element is missing.`
        );
      }

      value =
        String(value ?? '');

      log(
        `${label}: changing value to "${value}"...`
      );

      await clearField(el);

      await typeValue(
        el,
        value
      );

      await sleep(100);

      try {
        el.blur();
      } catch (e) {
        // Ignore.
      }

      fire(
        el,
        'change'
      );

      await sleep(
        STEP_DELAY_MS
      );

      const actual =
        String(
          el.value ?? ''
        ).trim();

      // Compare tolerant of Birchstreet's own auto-formatting (e.g. the
      // Unit Price field gets a "$" prefix and possibly thousands
      // separators appended on blur/change). We only ever compare - we
      // never rewrite el.value ourselves, so whatever Birchstreet
      // displays stays exactly as Birchstreet formatted it.
      if (
        normForCompare(actual) !==
        normForCompare(value)
      ) {

        throw new Error(
          `${label}: field ended with "${actual}" instead of "${value}".`
        );
      }

      log(
        `${label}: entered successfully as "${actual}".`
      );
    }

    // ===================================================================
    // FRAME TRAVERSAL
    // ===================================================================

    function getReachableFrames(win) {

      const result = [];

      function walk(currentWin) {

        if (!currentWin) {
          return;
        }

        result.push(
          currentWin
        );

        let frames;

        try {
          frames =
            currentWin.frames;
        } catch (e) {
          return;
        }

        for (
          let i = 0;
          i < frames.length;
          i++
        ) {

          try {
            walk(
              frames[i]
            );
          } catch (e) {
            // Cross-origin/unreachable.
          }
        }
      }

      walk(win);

      return result;
    }

    function findWindowWithSelectorWithin(
      rootWin,
      selector
    ) {

      const frames =
        getReachableFrames(
          rootWin
        );

      for (
        const win of frames
      ) {

        try {

          const el =
            win.document.querySelector(
              selector
            );

          if (el) {

            return {
              win,
              document:
                win.document,
              element: el
            };
          }

        } catch (e) {
          // Continue.
        }
      }

      return null;
    }

    // ===================================================================
    // FIND DISPLAYED ELEMENT
    // ===================================================================

    function findDisplayedElementWithin(
      rootWin,
      selector
    ) {

      const frames =
        getReachableFrames(
          rootWin
        );

      for (
        const win of frames
      ) {

        try {

          const candidates =
            win.document.querySelectorAll(
              selector
            );

          for (
            const candidate
              of candidates
          ) {

            if (
              isVisible(candidate)
            ) {

              return {
                win,
                document:
                  win.document,
                element:
                  candidate
              };
            }
          }

        } catch (e) {
          // Continue.
        }
      }

      return null;
    }

    // ===================================================================
    // FIND ACTIVE LINE DIALOG
    // ===================================================================

    function findOpenSupplierDialogWithin(
      rootWin
    ) {

      const frames =
        getReachableFrames(
          rootWin
        );

      for (
        const win of frames
      ) {

        try {

          const dialogs =
            win.document.querySelectorAll(
              '[id^="LineDialog"]'
            );

          for (
            const dlg of dialogs
          ) {

            if (
              !isVisible(dlg)
            ) {
              continue;
            }

            const match =
              String(
                dlg.id || ''
              ).match(
                /^LineDialog(\d+)$/
              );

            if (!match) {
              continue;
            }

            return {
              win,
              element: dlg,
              index:
                Number(match[1])
            };
          }

        } catch (e) {
          // Continue.
        }
      }

      return null;
    }

    // ===================================================================
    // SEARCH / OPEN ITEM
    // ===================================================================

    async function searchAndOpenItem(
      sku
    ) {

      log(
        `Searching for item SKU "${sku}"...`
      );

      const searchFieldInfo =
        await waitFor(
          () =>
            findWindowWithSelectorWithin(
              window.top,
              '#SearchField'
            ),
          10000,
          250
        );

      if (!searchFieldInfo) {

        throw new Error(
          'Could not find Birchstreet SearchField.'
        );
      }

      const searchWin =
        searchFieldInfo.win;

      const searchField =
        searchWin.document.querySelector(
          '#SearchField'
        );

      if (!searchField) {

        throw new Error(
          'SearchField disappeared before it could be used.'
        );
      }

      // ---------------------------------------------------------------
      // Select Part #
      // ---------------------------------------------------------------

      try {

        searchField.value =
          SEARCH_FIELD_VALUE;

        fire(
          searchField,
          'change'
        );

        fire(
          searchField,
          'input'
        );

      } catch (e) {

        throw new Error(
          'Could not set Birchstreet search type to Part #.'
        );
      }

      await sleep(500);

      // ---------------------------------------------------------------
      // Search textbox
      // ---------------------------------------------------------------

      let textField = null;

      const possibleSearchSelectors = [

        '#SearchValue',

        '#SearchText',

        '#SearchTextBox',

        '#SearchString',

        'input[name="SearchValue"]',

        'input[name="SearchText"]',

        'input[type="text"]'
      ];

      for (
        const selector
          of possibleSearchSelectors
      ) {

        try {

          const candidate =
            searchWin.document.querySelector(
              selector
            );

          if (
            candidate &&
            isVisible(candidate)
          ) {

            textField =
              candidate;

            break;
          }

        } catch (e) {
          // Continue.
        }
      }

      if (!textField) {

        throw new Error(
          'Could not locate Birchstreet search text box.'
        );
      }

      await fillLikeUser(
        textField,
        sku,
        'Item Search'
      );

      // ---------------------------------------------------------------
      // Search button
      // ---------------------------------------------------------------

      let searchButton = null;

      const searchButtonSelectors = [

        '#Search',

        '#SearchButton',

        '#SearchToolBarButton',

        'input[value="Search"]',

        'button[value="Search"]',

        'input[type="button"][value*="Search"]',

        'button'
      ];

      for (
        const selector
          of searchButtonSelectors
      ) {

        try {

          const buttons =
            searchWin.document.querySelectorAll(
              selector
            );

          for (
            const button
              of buttons
          ) {

            if (
              !isVisible(button)
            ) {
              continue;
            }

            const text =
              norm(
                button.value ||
                button.textContent ||
                button.title ||
                button.alt
              );

            if (

              selector === '#Search' ||

              selector === '#SearchButton' ||

              selector === '#SearchToolBarButton' ||

              text === 'search' ||

              text.includes('search')

            ) {

              searchButton =
                button;

              break;
            }
          }

        } catch (e) {
          // Continue.
        }

        if (searchButton) {
          break;
        }
      }

      if (!searchButton) {

        log(
          'Search button not found; attempting Enter.'
        );

        fireKeyboard(
          textField,
          'keydown',
          'Enter',
          'Enter',
          13
        );

        fireKeyboard(
          textField,
          'keyup',
          'Enter',
          'Enter',
          13
        );

      } else {

        log(
          'Clicking Search...'
        );

        click(
          searchButton
        );
      }

      // ---------------------------------------------------------------
      // Wait for result
      // ---------------------------------------------------------------

      await sleep(1000);

      const result =
        await waitFor(
          () => {

            const frames =
              getReachableFrames(
                searchWin
              );

            for (
              const win
                of frames
            ) {

              try {

                const body =
                  win.document.body;

                if (!body) {
                  continue;
                }

                const rows =
                  body.querySelectorAll(
                    'tr[id^="ROW"], tr'
                  );

                for (
                  const row
                    of rows
                ) {

                  if (
                    !isVisible(row)
                  ) {
                    continue;
                  }

                  const text =
                    norm(
                      row.textContent
                    );

                  if (
                    text.includes(
                      norm(sku)
                    )
                  ) {

                    return {
                      win,
                      row
                    };
                  }
                }

              } catch (e) {
                // Continue.
              }
            }

            return null;

          },
          15000,
          300
        );

      if (!result) {

        throw new Error(
          `Could not find search result for SKU "${sku}".`
        );
      }

      log(
        `Found item result for "${sku}".`
      );

      // ---------------------------------------------------------------
      // Click result
      // ---------------------------------------------------------------

      const row =
        result.row;

      let clickable = null;

      try {

        const candidates =
          row.querySelectorAll(
            'a, span, td'
          );

        for (
          const candidate
            of candidates
        ) {

          if (
            !isVisible(candidate)
          ) {
            continue;
          }

          const text =
            norm(
              candidate.textContent
            );

          if (

            text.includes(
              norm(sku)
            ) ||

            text.length > 3

          ) {

            clickable =
              candidate;

            break;
          }
        }

      } catch (e) {
        // Ignore.
      }

      if (!clickable) {
        clickable = row;
      }

      log(
        'Opening item...'
      );

      click(
        clickable
      );

      await sleep(1200);
    }

    // ===================================================================
    // SUPPLIER ITEMS TAB
    // ===================================================================

    async function goToSupplierTab() {

      log(
        'Opening Supplier Items tab...'
      );

      const tabInfo =
        await waitFor(
          () =>
            findWindowWithSelectorWithin(
              window.top,
              '#tab3'
            ),
          15000,
          200
        );

      if (!tabInfo) {

        throw new Error(
          'Could not find the Supplier Items tab (#tab3) in any reachable frame. Make sure the item entry form is open.'
        );
      }

      const mainWin =
        tabInfo.win;

      const tab =
        tabInfo.element;

      log(
        'Found exact tab: #tab3'
      );

      log(
        `Tab text="${String(tab.textContent || '').trim()}"`
      );

      log(
        `Tab class="${tab.className}"`
      );

      const tabDoc =
        tab.ownerDocument;

      const tabWin =
        tabDoc.defaultView ||
        mainWin;

      let onclickHandler = null;

      try {

        if (
          typeof tab.onclick ===
          'function'
        ) {

          onclickHandler =
            tab.onclick;

          log(
            'Found actual #tab3 onclick handler.'
          );

        } else {

          log(
            '#tab3.onclick is not exposed as a function.'
          );
        }

      } catch (e) {

        log(
          `Could not read #tab3.onclick: ${e.message || e}`
        );
      }

      try {

        log(
          `#tab3 onclick attribute="${tab.getAttribute('onclick') || '(none)'}"`
        );

      } catch (e) {
        // Ignore.
      }

      try {

        tab.scrollIntoView({
          block: 'center',
          inline: 'center'
        });

      } catch (e) {
        // Ignore.
      }

      await sleep(150);

      if (onclickHandler) {

        try {

          log(
            'Method 1: executing #tab3.onclick.call(#tab3)...'
          );

          onclickHandler.call(
            tabWin,
            new MouseEvent(
              'click',
              {
                bubbles: true,
                cancelable: true,
                view: tabWin
              }
            )
          );

          log(
            'Method 1: onclick handler executed.'
          );

        } catch (e) {

          log(
            `Method 1 failed: ${e.message || e}`
          );
        }

        await sleep(500);
      }

      let setTabFunction = null;

      try {

        if (
          typeof tabWin.setTab ===
          'function'
        ) {

          setTabFunction =
            tabWin.setTab;

          log(
            'Found setTab() in tab owner window.'
          );

        } else {

          log(
            'setTab() not directly available in tab owner window.'
          );
        }

      } catch (e) {

        log(
          `Could not access setTab(): ${e.message || e}`
        );
      }

      function supplierTabLooksActive() {

        try {

          const currentTab =
            tabDoc.getElementById(
              'tab3'
            );

          const supplierDiv =
            tabDoc.getElementById(
              'div3'
            );

          if (
            !currentTab ||
            !supplierDiv
          ) {
            return false;
          }

          const currentClass =
            String(
              currentTab.className || ''
            );

          const divStyle =
            tabWin.getComputedStyle(
              supplierDiv
            );

          const display =
            String(
              divStyle.display || ''
            ).toLowerCase();

          const visibility =
            String(
              divStyle.visibility || ''
            ).toLowerCase();

          const selected =
            currentClass
              .split(/\s+/)
              .includes(
                'SelectedTab'
              );

          const unselected =
            currentClass
              .split(/\s+/)
              .includes(
                'UnselectedTab'
              );

          const visible =
            display !== 'none' &&
            visibility !== 'hidden';

          return (
            selected ||
            (
              !unselected &&
              visible
            )
          );

        } catch (e) {

          return false;
        }
      }

      if (
        !supplierTabLooksActive() &&
        setTabFunction
      ) {

        try {

          log(
            'Method 2: directly calling setTab(#tab3, "div3")...'
          );

          setTabFunction.call(
            tabWin,
            tab,
            'div3'
          );

          log(
            'Method 2: setTab() executed.'
          );

        } catch (e) {

          log(
            `Method 2 failed: ${e.message || e}`
          );
        }

        await sleep(500);
      }

      if (
        !supplierTabLooksActive()
      ) {

        try {

          log(
            'Method 3: native #tab3.click()...'
          );

          if (
            typeof tab.click ===
            'function'
          ) {

            tab.click();

            log(
              'Method 3: native click executed.'
            );
          }

        } catch (e) {

          log(
            `Method 3 failed: ${e.message || e}`
          );
        }

        await sleep(500);
      }

      if (
        !supplierTabLooksActive()
      ) {

        try {

          log(
            'Method 4: dispatching mousedown → mouseup → click...'
          );

          fireMouse(
            tab,
            'mousedown'
          );

          fireMouse(
            tab,
            'mouseup'
          );

          fireMouse(
            tab,
            'click'
          );

          log(
            'Method 4: mouse events dispatched.'
          );

        } catch (e) {

          log(
            `Method 4 failed: ${e.message || e}`
          );
        }

        await sleep(500);
      }

      const activated =
        await waitFor(
          () => {

            try {

              const currentTab =
                tabDoc.getElementById(
                  'tab3'
                );

              const supplierDiv =
                tabDoc.getElementById(
                  'div3'
                );

              if (
                !currentTab ||
                !supplierDiv
              ) {
                return false;
              }

              const classText =
                String(
                  currentTab.className || ''
                );

              const style =
                tabWin.getComputedStyle(
                  supplierDiv
                );

              const display =
                String(
                  style.display || ''
                ).toLowerCase();

              const visibility =
                String(
                  style.visibility || ''
                ).toLowerCase();

              const tabSelected =
                classText
                  .split(/\s+/)
                  .includes(
                    'SelectedTab'
                  );

              const divVisible =
                display !== 'none' &&
                visibility !== 'hidden';

              if (
                tabSelected &&
                divVisible
              ) {

                return true;
              }

              if (
                divVisible &&
                !classText
                  .split(/\s+/)
                  .includes(
                    'UnselectedTab'
                  )
              ) {

                return true;
              }

            } catch (e) {
              // Continue waiting.
            }

            return false;

          },
          10000,
          150
        );

      try {

        const finalTab =
          tabDoc.getElementById(
            'tab3'
          );

        const finalDiv =
          tabDoc.getElementById(
            'div3'
          );

        const finalStyle =
          finalDiv
            ? tabWin.getComputedStyle(
                finalDiv
              )
            : null;

        log(
          `FINAL #tab3 class="${finalTab ? finalTab.className : '(missing)'}"`
        );

        log(
          `FINAL #div3 display="${finalStyle ? finalStyle.display : '(missing)'}"`
        );

        log(
          `FINAL #div3 visibility="${finalStyle ? finalStyle.visibility : '(missing)'}"`
        );

      } catch (e) {
        // Ignore.
      }

      if (!activated) {

        throw new Error(
          'Supplier Items #tab3 was found and click/setTab was attempted, but Birchstreet did not activate #div3.'
        );
      }

      log(
        '================================================'
      );

      log(
        'Supplier Items activated successfully.'
      );

      log(
        '#tab3 = SelectedTab'
      );

      log(
        '#div3 = visible'
      );

      log(
        '================================================'
      );

      await sleep(1200);

      return mainWin;
    }

    // ===================================================================
    // SUPPLIER ROW
    // ===================================================================

    async function openSupplierRow(
      entryWin,
      supplierName
    ) {

      log(
        `Looking for supplier "${supplierName}"...`
      );

      const supplierGrid =
        await waitFor(
          () => {

            const frames =
              getReachableFrames(
                entryWin
              );

            for (
              const win of frames
            ) {

              try {

                const header =
                  win.document.querySelector(
                    'th[colname="SUPPLIER_COMPANY_ID"]'
                  );

                if (header) {

                  return {
                    win,
                    header
                  };
                }

              } catch (e) {
                // Continue.
              }
            }

            return null;

          },
          10000,
          250
        );

      if (!supplierGrid) {

        throw new Error(
          'Could not find the Supplier Items grid.'
        );
      }

      const gridWin =
        supplierGrid.win;

      log(
        'Supplier Items grid found.'
      );

      const rowInfo =
        await waitFor(
          () => {

            try {

              const rows =
                gridWin.document.querySelectorAll(
                  'tr[id^="ROW"]'
                );

              for (
                const row of rows
              ) {

                if (
                  !isVisible(row)
                ) {
                  continue;
                }

                const text =
                  norm(
                    row.textContent
                  );

                if (
                  text.includes(
                    norm(supplierName)
                  )
                ) {

                  return row;
                }
              }

            } catch (e) {
              // Continue.
            }

            return null;

          },
          10000,
          250
        );

      if (!rowInfo) {

        try {

          const rows =
            gridWin.document.querySelectorAll(
              'tr[id^="ROW"]'
            );

          log(
            `Supplier "${supplierName}" was not found. Visible supplier rows:`
          );

          for (
            const row of rows
          ) {

            if (
              isVisible(row)
            ) {

              log(
                `  ${row.id}: ${norm(row.textContent)}`
              );
            }
          }

        } catch (e) {
          // Ignore.
        }

        throw new Error(
          `Supplier "${supplierName}" was not found in Supplier Items.`
        );
      }

      log(
        `Found supplier row ${rowInfo.id || '(no id)'}.`
      );

      let opened = false;

      try {

        if (
          typeof rowInfo.ondblclick ===
          'function'
        ) {

          log(
            'Opening supplier row through ondblclick handler...'
          );

          rowInfo.ondblclick();

          opened = true;
        }

      } catch (e) {

        log(
          `ondblclick handler failed: ${e.message || e}`
        );
      }

      if (!opened) {

        try {

          const editSpan =
            rowInfo.querySelector(
              'span.NavListHyperLinks'
            );

          if (
            editSpan &&
            norm(
              editSpan.textContent
            ).includes('edit')
          ) {

            log(
              'Opening supplier row through Edit link...'
            );

            click(
              editSpan
            );

            opened = true;
          }

        } catch (e) {
          // Continue.
        }
      }

      if (!opened) {

        throw new Error(
          'Could not trigger Edit for the selected supplier row.'
        );
      }

      const dialogInfo =
        await waitFor(
          () =>
            findOpenSupplierDialogWithin(
              entryWin
            ),
          10000,
          200
        );

      if (!dialogInfo) {

        throw new Error(
          'Edit was triggered, but no displayed LineDialog was found.'
        );
      }

      const dialogEl =
        dialogInfo.element;

      const dialogIndex =
        dialogInfo.index;

      log(
        `Active supplier dialog: ${dialogEl.id} (index ${dialogIndex}).`
      );

      const rowField =
        await waitFor(
          () => {

            try {

              const fields =
                dialogEl.querySelectorAll(
                  `#${FIELD.row}`
                );

              for (
                const field
                  of fields
              ) {

                if (
                  isVisible(field) &&
                  String(
                    field.value || ''
                  ).trim()
                ) {

                  return field;
                }
              }

            } catch (e) {
              // Continue.
            }

            return null;

          },
          10000,
          200
        );

      if (!rowField) {

        throw new Error(
          `Supplier dialog ${dialogEl.id} opened, but its Row field (#${FIELD.row}) was not populated within 10s.`
        );
      }

      log(
        `Supplier dialog ${dialogEl.id} fully loaded. Row=${rowField.value}`
      );

      let priceEl = null;

      try {

        const fields =
          dialogEl.querySelectorAll(
            `#${FIELD.price}`
          );

        for (
          const candidate
            of fields
        ) {

          if (
            isVisible(candidate)
          ) {

            priceEl =
              candidate;

            break;
          }
        }

      } catch (e) {
        // Ignore.
      }

      if (!priceEl) {

        throw new Error(
          `Could not find displayed Unit Price field (#${FIELD.price}) inside ${dialogEl.id}.`
        );
      }

      log(
        `Unit Price field found: #${FIELD.price}. Current="${priceEl.value || ''}"`
      );

      return {
        win:
          dialogInfo.win,

        el:
          dialogEl,

        index:
          dialogIndex,

        priceEl
      };
    }

    // ===================================================================
    // DIRECT FIELD
    // ===================================================================

    async function setDirectField(
      root,
      fieldId,
      value,
      label
    ) {

      if (!value) {

        log(
          `${label}: blank, skipping.`
        );

        return;
      }

      let el = null;

      try {

        const fields =
          root.querySelectorAll(
            `#${fieldId}`
          );

        for (
          const candidate
            of fields
        ) {

          if (
            isVisible(candidate)
          ) {

            el =
              candidate;

            break;
          }
        }

      } catch (e) {
        // Continue.
      }

      if (!el) {

        throw new Error(
          `Could not find displayed ${label} field (#${fieldId}) inside the active dialog.`
        );
      }

      const current =
        String(
          el.value || ''
        ).trim();

      if (
        current &&
        normForCompare(current) ===
        normForCompare(value)
      ) {

        log(
          `${label}: already "${current}", leaving unchanged.`
        );

        await sleep(
          STEP_DELAY_MS
        );

        return;
      }

      await fillLikeUser(
        el,
        value,
        label
      );

      let descEl = null;
      let flagEl = null;

      try {

        const descFields =
          root.querySelectorAll(
            `#${fieldId}_Desc`
          );

        for (
          const candidate
            of descFields
        ) {

          if (
            isVisible(candidate)
          ) {

            descEl =
              candidate;

            break;
          }
        }

        const flags =
          root.querySelectorAll(
            `#img_${fieldId}`
          );

        for (
          const candidate
            of flags
        ) {

          if (
            isVisible(candidate)
          ) {

            flagEl =
              candidate;

            break;
          }
        }

      } catch (e) {
        // Continue.
      }

      const enteredNorm =
        normForCompare(value);

      const outcome =
        await waitFor(
          () => {

            const currentValue =
              normForCompare(
                el.value
              );

            if (
              flagEl &&
              isVisible(flagEl)
            ) {
              return 'error';
            }

            if (
              descEl &&
              String(
                descEl.value || ''
              ).trim()
            ) {
              return 'ok';
            }

            if (
              currentValue ===
              enteredNorm
            ) {
              return 'entered';
            }

            return null;

          },
          5000,
          200
        );

      if (
        outcome === 'ok'
      ) {

        log(
          `${label}: validated as "${descEl.value.trim()}".`
        );

      } else if (
        outcome === 'error'
      ) {

        throw new Error(
          `${label}: "${value}" triggered a Birchstreet validation flag.`
        );

      } else if (
        outcome === 'entered'
      ) {

        log(
          `${label}: entered "${value}" and field retained the value.`
        );

      } else {

        throw new Error(
          `${label}: Birchstreet did not confirm "${value}" within 5 seconds.`
        );
      }

      await sleep(
        STEP_DELAY_MS
      );
    }

    // ===================================================================
    // FILL + OK + SAVE
    // ===================================================================

    async function fillFieldsAndSave(
      entryWin,
      dialogInfo,
      inputs
    ) {

      const dialogEl =
        dialogInfo.el;

      const dialogIndex =
        dialogInfo.index;

      if (!dialogEl) {

        throw new Error(
          'Active supplier dialog is missing.'
        );
      }

      let priceEl = null;

      try {

        const fields =
          dialogEl.querySelectorAll(
            `#${FIELD.price}`
          );

        for (
          const candidate
            of fields
        ) {

          if (
            isVisible(candidate)
          ) {

            priceEl =
              candidate;

            break;
          }
        }

      } catch (e) {
        // Continue.
      }

      if (!priceEl) {

        throw new Error(
          `Could not find displayed Unit Price field (#${FIELD.price}) inside ${dialogEl.id}.`
        );
      }

      await fillLikeUser(
        priceEl,
        inputs.price,
        'Unit Price'
      );

      await setDirectField(
        dialogEl,
        FIELD.currency,
        inputs.currency,
        'Trx Currency'
      );

      await setDirectField(
        dialogEl,
        FIELD.tax1,
        inputs.tax1,
        'Tax Code 1'
      );

      await setDirectField(
        dialogEl,
        FIELD.tax2,
        inputs.tax2,
        'Tax Code 2'
      );

      await sleep(
        STEP_DELAY_MS
      );

      let okBtn = null;

      if (
        dialogIndex !== null &&
        Number.isFinite(dialogIndex)
      ) {

        okBtn =
          await waitFor(
            () => {

              try {

                const candidate =
                  dialogEl.querySelector(
                    `#OKforGrid${dialogIndex}`
                  );

                if (
                  candidate &&
                  isVisible(candidate)
                ) {

                  return candidate;
                }

              } catch (e) {
                // Continue.
              }

              return null;

            },
            5000,
            200
          );
      }

      if (!okBtn) {

        try {

          const buttons =
            dialogEl.querySelectorAll(
              'button[id^="OKforGrid"], input[id^="OKforGrid"], [id^="OKforGrid"]'
            );

          for (
            const candidate
              of buttons
          ) {

            if (
              isVisible(candidate)
            ) {

              okBtn =
                candidate;

              break;
            }
          }

        } catch (e) {
          // Continue.
        }
      }

      if (!okBtn) {

        throw new Error(
          `Could not find OK button for active ${dialogEl.id}.`
        );
      }

      log(
        `Clicking ${okBtn.id || 'OK'} to commit supplier row...`
      );

      click(
        okBtn
      );

      const closed =
        await waitFor(
          () => {

            try {
              return !isVisible(
                dialogEl
              );
            } catch (e) {
              return true;
            }

          },
          10000,
          200
        );

      if (!closed) {

        throw new Error(
          `Clicked ${okBtn.id || 'OK'}, but ${dialogEl.id} is still displayed after 10 seconds. Save was NOT clicked.`
        );
      }

      log(
        `${dialogEl.id} closed - supplier row committed.`
      );

      await sleep(700);

      const saveInfo =
        await waitFor(
          () =>
            findWindowWithSelectorWithin(
              entryWin,
              '#SaveRecPanelToolTab'
            ),
          8000,
          200
        );

      if (!saveInfo) {

        throw new Error(
          'Could not find page-level Save button (#SaveRecPanelToolTab) after committing supplier row.'
        );
      }

      const saveEl =
        saveInfo.document.querySelector(
          '#SaveRecPanelToolTab'
        );

      if (!saveEl) {

        throw new Error(
          'Save button disappeared before it could be clicked.'
        );
      }

      if (
        saveEl.disabled
      ) {

        throw new Error(
          'Page-level Save button is disabled. Birchstreet may not have registered the supplier edit.'
        );
      }

      log(
        'Clicking page-level Save...'
      );

      click(
        saveEl
      );

      log(
        'Page-level Save clicked.'
      );

      await sleep(1000);
    }

    // ===================================================================
    // UI
    // ===================================================================

    const panel =
      document.createElement('div');

    panel.id =
      'bskPriceUpdaterPanel';

    panel.style.cssText = `
      position: fixed;
      top: 20px;
      right: 20px;
      width: 360px;
      z-index: 2147483647;
      background: #ffffff;
      color: #222222;
      border: 1px solid #999999;
      border-radius: 8px;
      box-shadow: 0 8px 30px rgba(0,0,0,.25);
      font-family: Arial, sans-serif;
      font-size: 13px;
      overflow: hidden;
    `;

    panel.innerHTML = `
      <div id="bskHeader" style="
        cursor: move;
        user-select: none;
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 10px 12px;
        background: #f0f0f0;
        border-bottom: 1px solid #ccc;
      ">
        <span style="font-size:15px; font-weight:bold;">
          Birchstreet Price Updater
        </span>
        <button
          id="bskMinBtn"
          title="Minimize"
          style="
            width:24px;
            height:24px;
            line-height:1;
            font-weight:bold;
            font-size:15px;
            cursor:pointer;
            border:1px solid #999;
            border-radius:4px;
            background:#fff;
          "
        >–</button>
      </div>

      <div id="bskBody" style="padding: 14px;">

        <div style="margin-bottom:7px;">
          <label>Item SKU</label>
          <input
            id="bskSku"
            type="text"
            style="
              width:100%;
              box-sizing:border-box;
              padding:7px;
              margin-top:3px;
            "
          >
        </div>

        <div style="margin-bottom:7px;">
          <label>Supplier Name</label>
          <input
            id="bskSupplier"
            type="text"
            style="
              width:100%;
              box-sizing:border-box;
              padding:7px;
              margin-top:3px;
            "
          >
        </div>

        <div style="margin-bottom:7px;">
          <label>Unit Price</label>
          <input
            id="bskPrice"
            type="text"
            value="2.0000"
            style="
              width:100%;
              box-sizing:border-box;
              padding:7px;
              margin-top:3px;
            "
          >
        </div>

        <div style="margin-bottom:7px;">
          <label>Trx Currency</label>
          <input
            id="bskCurrency"
            type="text"
            value="USD"
            style="
              width:100%;
              box-sizing:border-box;
              padding:7px;
              margin-top:3px;
            "
          >
        </div>

        <div style="margin-bottom:7px;">
          <label>Tax Code 1</label>
          <input
            id="bskTax1"
            type="text"
            value="GGST"
            style="
              width:100%;
              box-sizing:border-box;
              padding:7px;
              margin-top:3px;
            "
          >
        </div>

        <div style="margin-bottom:10px;">
          <label>Tax Code 2</label>
          <input
            id="bskTax2"
            type="text"
            value="NA"
            style="
              width:100%;
              box-sizing:border-box;
              padding:7px;
              margin-top:3px;
            "
          >
        </div>

        <button
          id="bskRun"
          style="
            width:100%;
            padding:9px;
            cursor:pointer;
            font-weight:bold;
          "
        >
          Run Update
        </button>

        <div
          id="bskStatus"
          style="
            margin-top:9px;
            font-weight:bold;
          "
        >
          Ready
        </div>

      </div>
    `;

    document.documentElement.appendChild(
      panel
    );

    // ===================================================================
    // LOG BOX (lives inside the body, so it hides/shows with minimize)
    // ===================================================================

    logBox.id =
      'bskLog';

    logBox.readOnly =
      true;

    logBox.style.cssText = `
      width:100%;
      height:180px;
      box-sizing:border-box;
      margin-top:10px;
      resize:vertical;
      font-family:monospace;
      font-size:11px;
      background:#f7f7f7;
      color:#222;
      border:1px solid #aaa;
    `;

    document
      .getElementById('bskBody')
      .appendChild(
        logBox
      );

    // ===================================================================
    // POSITION: convert the initial fixed top/right into left/top so
    // dragging can update a single consistent pair of coordinates, then
    // restore any previously saved position.
    // ===================================================================

    function clampToViewport(left, top) {

      const rect =
        panel.getBoundingClientRect();

      const maxLeft =
        Math.max(
          0,
          window.innerWidth - rect.width
        );

      const maxTop =
        Math.max(
          0,
          window.innerHeight - 40
        );

      return {
        left: Math.min(
          Math.max(0, left),
          maxLeft
        ),
        top: Math.min(
          Math.max(0, top),
          maxTop
        )
      };
    }

    function applyPosition(left, top) {

      panel.style.left = `${left}px`;
      panel.style.top = `${top}px`;
      panel.style.right = 'auto';
    }

    try {

      const savedLeft =
        GM_getValue('bskPosLeft', null);

      const savedTop =
        GM_getValue('bskPosTop', null);

      if (
        savedLeft !== null &&
        savedTop !== null
      ) {

        const clamped =
          clampToViewport(
            Number(savedLeft),
            Number(savedTop)
          );

        applyPosition(
          clamped.left,
          clamped.top
        );

      } else {

        // First run: compute left from the original top:20/right:20
        // placement so it starts in the same spot as before.
        const rect =
          panel.getBoundingClientRect();

        applyPosition(
          window.innerWidth - rect.width - 20,
          20
        );
      }

    } catch (e) {

      console.warn(
        '[BSK Price Updater] Could not restore saved position.',
        e
      );
    }

    // ===================================================================
    // DRAG
    // ===================================================================

    const headerEl =
      document.getElementById('bskHeader');

    let dragging = false;
    let dragOffsetX = 0;
    let dragOffsetY = 0;

    headerEl.addEventListener(
      'mousedown',
      (e) => {

        // Let the minimize button handle its own click.
        if (
          e.target &&
          e.target.id === 'bskMinBtn'
        ) {
          return;
        }

        dragging = true;

        const rect =
          panel.getBoundingClientRect();

        dragOffsetX =
          e.clientX - rect.left;

        dragOffsetY =
          e.clientY - rect.top;

        e.preventDefault();
      }
    );

    document.addEventListener(
      'mousemove',
      (e) => {

        if (!dragging) {
          return;
        }

        const clamped =
          clampToViewport(
            e.clientX - dragOffsetX,
            e.clientY - dragOffsetY
          );

        applyPosition(
          clamped.left,
          clamped.top
        );
      }
    );

    document.addEventListener(
      'mouseup',
      () => {

        if (!dragging) {
          return;
        }

        dragging = false;

        try {

          const rect =
            panel.getBoundingClientRect();

          GM_setValue(
            'bskPosLeft',
            rect.left
          );

          GM_setValue(
            'bskPosTop',
            rect.top
          );

        } catch (e) {
          // Ignore.
        }
      }
    );

    // ===================================================================
    // MINIMIZE
    // ===================================================================

    const bodyEl =
      document.getElementById('bskBody');

    const minBtn =
      document.getElementById('bskMinBtn');

    function setMinimized(minimized) {

      bodyEl.style.display =
        minimized ? 'none' : 'block';

      minBtn.textContent =
        minimized ? '+' : '–';

      minBtn.title =
        minimized ? 'Restore' : 'Minimize';

      panel.style.width =
        minimized ? '260px' : '360px';

      try {

        GM_setValue(
          'bskMinimized',
          minimized
        );

      } catch (e) {
        // Ignore.
      }
    }

    minBtn.addEventListener(
      'click',
      (e) => {

        e.stopPropagation();

        const currentlyMinimized =
          bodyEl.style.display === 'none';

        setMinimized(
          !currentlyMinimized
        );
      }
    );

    try {

      const savedMinimized =
        GM_getValue('bskMinimized', false);

      if (savedMinimized) {
        setMinimized(true);
      }

    } catch (e) {
      // Ignore.
    }

    // ===================================================================
    // LOAD SAVED VALUES
    // ===================================================================

    try {

      document.getElementById(
        'bskSupplier'
      ).value =
        GM_getValue(
          'bskSupplier',
          ''
        );

      document.getElementById(
        'bskCurrency'
      ).value =
        GM_getValue(
          'bskCurrency',
          'USD'
        );

      document.getElementById(
        'bskTax1'
      ).value =
        GM_getValue(
          'bskTax1',
          'GGST'
        );

      document.getElementById(
        'bskTax2'
      ).value =
        GM_getValue(
          'bskTax2',
          'NA'
        );

    } catch (e) {

      console.warn(
        '[BSK Price Updater] Could not load saved values.',
        e
      );
    }

    // ===================================================================
    // STATUS
    // ===================================================================

    function setStatus(text) {

      const status =
        document.getElementById(
          'bskStatus'
        );

      if (status) {
        status.textContent =
          text;
      }
    }

    // ===================================================================
    // RUN BUTTON
    // ===================================================================

    const runBtn =
      document.getElementById(
        'bskRun'
      );

    runBtn.addEventListener(
      'click',
      async () => {

        const sku =
          document.getElementById(
            'bskSku'
          ).value.trim();

        const supplier =
          document.getElementById(
            'bskSupplier'
          ).value.trim();

        const price =
          document.getElementById(
            'bskPrice'
          ).value.trim();

        const currency =
          document.getElementById(
            'bskCurrency'
          ).value.trim();

        const tax1 =
          document.getElementById(
            'bskTax1'
          ).value.trim();

        const tax2 =
          document.getElementById(
            'bskTax2'
          ).value.trim();

        if (
          !sku ||
          !supplier ||
          !price
        ) {

          setStatus(
            'SKU, Supplier and Unit Price are required.'
          );

          return;
        }

        try {

          GM_setValue(
            'bskSupplier',
            supplier
          );

          GM_setValue(
            'bskCurrency',
            currency
          );

          GM_setValue(
            'bskTax1',
            tax1
          );

          GM_setValue(
            'bskTax2',
            tax2
          );

        } catch (e) {

          console.warn(
            '[BSK Price Updater] Could not persist values.',
            e
          );
        }

        runBtn.disabled =
          true;

        setStatus(
          'Running...'
        );

        logBox.value =
          '';

        try {

          log(
            `Starting update: SKU=${sku}`
          );

          log(
            `Supplier="${supplier}"`
          );

          log(
            `Price=${price}`
          );

          log(
            `Currency="${currency || '(unchanged)'}"`
          );

          log(
            `Tax1="${tax1 || '(skip)'}"`
          );

          log(
            `Tax2="${tax2 || '(skip)'}"`
          );

          await searchAndOpenItem(
            sku
          );

          const entryWin =
            await goToSupplierTab();

          const dialogInfo =
            await openSupplierRow(
              entryWin,
              supplier
            );

          await fillFieldsAndSave(
            entryWin,
            dialogInfo,
            {
              currency,
              price,
              tax1,
              tax2
            }
          );

          setStatus(
            'Done - saved.'
          );

          log(
            '================================================'
          );

          log(
            'Finished successfully.'
          );

        } catch (err) {

          setStatus(
            'Error - see log.'
          );

          log(
            '================================================'
          );

          log(
            'ERROR: ' +
            (
              err &&
              err.message
                ? err.message
                : err
            )
          );

          console.error(
            '[BSK Price Updater]',
            err
          );

        } finally {

          runBtn.disabled =
            false;
        }
      }
    );

    // ===================================================================
    // READY
    // ===================================================================

    log(
      'UI ready.'
    );

    log(
      'Enter SKU + Supplier and click Run Update.'
    );
  }

})();
