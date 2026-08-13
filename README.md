# BirchPort Userscripts

Two Tampermonkey userscripts that make day-to-day work in Birchstreet (the procurement/ERP system) faster, by adding floating tools directly on top of its pages.

## Scripts

### Local Item Price Lookup

`birchstreet-local-item-lookup.user.js`

Adds a floating, draggable panel to Birchstreet where you can drop in a part number and instantly get back every supplier that carries it, with pricing pulled live from the Local Item Maintenance / Supplier Items tab. Paste a part number and hit fetch, or copy one to your clipboard and press `Ctrl+Alt+I` to have it filled in and looked up automatically. Saves the manual click-through of opening each item and checking its supplier list one at a time.

### REQ Supplier Auto-Fixer

`req-supplier-fixer.user.js`

Scans an open requisition and finds any line items that aren't assigned to the correct target supplier, then reassigns them automatically — showing live per-line status as it works through the page. Matches suppliers by fuzzy description matching so it isn't thrown off by small naming differences between what's on the requisition and what's in the supplier list.

Both scripts use `@match https://*.birchstreetsystems.com/*`, so they work regardless of which app node (app01, app02, app03, etc.) you happen to land on.

## Installing

1. Install the [Tampermonkey](https://www.tampermonkey.net/) browser extension.
2. Open either `.user.js` file in this repo and click "Raw" — Tampermonkey will pick it up and prompt to install.
3. Navigate to Birchstreet and the floating panel will appear automatically.

## Related

A full rewrite of this idea as a proper browser extension (not just userscripts) is in progress at [`KingVamp-Userscript-Browser-Extension`](https://github.com/roni2026/KingVamp-Userscript-Browser-Extension).
