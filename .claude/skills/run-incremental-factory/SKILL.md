---
name: run-incremental-factory
description: Build nothing (static HTML), launch, screenshot, and drive Incrémental Factory (index.html + recherche.html) in a real headless Chromium. Use when asked to run, test, screenshot, or verify a change to the game, jump to a given stage, or buy a research-tree node to check its effect.
---

Static vanilla-JS game, no build step. Drive it via
`.claude/skills/run-incremental-factory/driver.mjs`, a Playwright script that
serves the repo over HTTP, launches headless Chromium, starts a game, and can
fast-forward to any stage or purchase specific research nodes. All paths
below are relative to the repo root (`index.html`, `recherche.html`).

## Prerequisites

Python 3 (for the static file server) and Node.js. No `apt-get` packages were
needed beyond what a normal dev container already has:

```bash
python3 --version   # or `python` on Windows — either is fine, driver tries `python` on win32
node --version
```

## Setup

One-time, inside the skill directory:

```bash
cd .claude/skills/run-incremental-factory
npm install
npx playwright install chromium
```

This installs Playwright as a private dependency of the skill (the game
itself has zero npm dependencies — nothing here touches the repo root).

## Run (agent path)

```bash
cd .claude/skills/run-incremental-factory
node driver.mjs                                    # stage 1 smoke test
node driver.mjs --stage=8                           # jump straight to stage 8
node driver.mjs --stage=8 --buy=X1,X2               # + buy research nodes in order
node driver.mjs --stage=8 --eval="cache.global"      # + read a live value from the top page
```

Screenshots land in `.claude/skills/run-incremental-factory/shots/NN-label.png`
(numbered in the order taken — always look at them, don't just trust the exit
code). Console/page errors are collected throughout and printed as
`ERRORS_JSON=[...]` on the last line; the process exits 1 if that array is
non-empty.

| flag | what it does |
|---|---|
| `--stage=N` (1-8) | Uses the in-game dev panel (`#devAll`, `#devRes`) plus a direct `state` write to reach stage N instantly. N>=6 also marks the whole research "spine" (B1..B5) done and sets science to 1e18 — there's no legitimate way to reach that in under ~2h of real play (see index.html's own calibration comment above `const RTREE`). |
| `--buy=ID1,ID2,...` | Once the research overlay is open (stage>=6), arms then confirms each RTREE node id in order via the page's own `onNodeClick()` — exercises the real `nodeState()`/`buyNode()` logic, not a forged state. Prints one `BUY_RESULT_JSON` line per node with the resulting level. |
| `--eval="expr"` | Extra JS evaluated in the **top** page after everything else; printed as `EVAL_RESULT_JSON`. Does NOT see research bought via `--buy` unless you also close the overlay yourself — see Gotchas. |
| `--port=N` | Static server port (default 8099). |
| `--headed` | Show the browser window instead of headless (only useful with a display attached). |

## Run (human path)

Open `index.html` directly in a browser (`file://` also mostly works for
manual play — the `iframe` origin issue below only bites automated same-page
verification of the shared save, not normal play through the intro screen).

## Test

No automated test suite in this project. `driver.mjs` at `--stage=8
--buy=X1,X2,X3,X4,X5,RX` is the closest thing to a regression check for the
research tree end-to-end; treat a clean `ERRORS_JSON=[]` plus a visual check
of the screenshots as "passing."

---

## Gotchas

- **Use an HTTP server, not `file://`, for automated verification.**
  `index.html` opens `recherche.html` in an `<iframe>` and both read/write the
  same `localStorage` save. Chromium gives each `file://` document its own
  opaque origin, so the iframe can't see the parent's save under `file://`.
  The driver spawns `python -m http.server` for exactly this reason.
- **The stage-1 welcome pop-up (`#popOk`) covers the whole screen** and
  intercepts every click underneath it. Close it right after `#introNew`,
  before touching the dev panel.
- **SVG research nodes have no `data-id` or visible text label on canvas** —
  the name only appears in the bottom sheet after a click. You can't select a
  node with a CSS/text locator; drive it via the page's own
  `onNodeClick(RBY['X1'])` inside the iframe instead (see driver.mjs).
- **Research purchases live in the iframe's own `SAVE` copy, not in the top
  page's `state`, until the overlay is closed.** Read `SAVE.state.research`
  (or the `BUY_RESULT_JSON` the driver prints) while the overlay is still
  open rather than closing it first.
- **(Fixed) Any `save()` while the research overlay was open could silently
  discard purchases made in the iframe.** While `researchOpen` is true, the
  iframe is the sole writer of the shared save (one `writeSave()` per
  purchase); the top page deliberately keeps a frozen `state` (game loop
  suspended, §1) until `closeResearch()` explicitly resyncs it. `save()` used
  to run unconditionally from four places — the 10s `setInterval`, `blur`,
  `visibilitychange`, `pagehide` — any of which firing while the tree was
  open would overwrite `localStorage` with that stale `state`, discarding
  everything bought since opening. Easiest real repro: open the tree, buy a
  node, `alt-tab` away and back, close normally — the purchase was gone.
  (An earlier theory pinned this on the close click's own focus-transfer
  triggering a blur; that specific path turned out to be a driver artifact —
  `onNodeClick()` calls in the buy loop are direct JS calls with no real
  focus movement, so the *first* real click ends up being `#closeBtn`, which
  is not representative of normal play. The `alt-tab`-while-open repro above
  is the real one and isn't specific to any test methodology.) Fixed in
  `index.html`'s `save()`: it now no-ops while `researchOpen` is true.

## Troubleshooting

- **`page.click: Timeout 30000ms exceeded` waiting for `#btnDev`, log shows
  `<div class="overlay pop"> intercepts pointer events`**: the stage-1
  welcome pop-up is still open. Click `#popOk` first.
- **`EVAL_RESULT_JSON` doesn't reflect a value just bought via `--buy`**:
  expected — see the closing-race Gotcha above. Read `BUY_RESULT_JSON`
  instead, or inspect `SAVE.state` inside the iframe before it closes.
