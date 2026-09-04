#!/usr/bin/env node
/*
 * Driver for Incrémental Factory (index.html + recherche.html, static vanilla-JS
 * game, no build step). Serves the repo root over HTTP, launches Chromium via
 * Playwright, starts a fresh game, closes the stage-1 welcome pop-up, and
 * optionally fast-forwards to any stage / research node so an agent can see a
 * change working without grinding the real (multi-hour) progression curve.
 *
 * Usage:
 *   node driver.mjs [--stage=N] [--buy=ID1,ID2,...] [--eval="js expression"] [--port=8099] [--headed]
 *
 * --stage=N   Jump to stage N (1-8). N>=2 uses the in-game dev panel
 *             (#devAll + #devRes) to unlock stages/resources, then a direct
 *             state write for stage/tab. N>=6 additionally marks the whole
 *             research "spine" (B1..B5) as done and sets science to 1e18 --
 *             there is no legitimate way to reach that state quickly, the
 *             backbone alone is calibrated at ~2 real hours of play.
 *   --buy=... Comma-separated RTREE node ids to purchase in order, once the
 *             research overlay is open (stage>=6). Each id is armed then
 *             bought (mirrors the real double-click UX) via the page's own
 *             onNodeClick(), not by forging state -- this exercises the real
 *             nodeState()/buyNode() logic inside the recherche.html iframe.
 *   --eval="expr"  Extra JS evaluated in the TOP page after everything else
 *             (e.g. --eval="cache.global" to read a live multiplier). Printed
 *             as EVAL_RESULT_JSON.
 *   --port=N  Static server port (default 8099).
 *   --headed  Show the browser window instead of running headless.
 *
 * Screenshots land in shots/<NN-label>.png (numbered in the order taken).
 * Console/page errors are collected throughout and printed as ERRORS_JSON at
 * the end; the process exits 1 if that array is non-empty.
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../../..'); // .claude/skills/run-incremental-factory/ -> repo root
const SHOT_DIR = path.join(__dirname, 'shots');
mkdirSync(SHOT_DIR, { recursive: true });

const args = Object.fromEntries(process.argv.slice(2).map(a => {
  const m = a.match(/^--([^=]+)(?:=(.*))?$/);
  return m ? [m[1], m[2] ?? true] : [a, true];
}));
const PORT = Number(args.port || 8099);
const STAGE = Math.max(1, Math.min(8, Number(args.stage || 1)));
const BUY = args.buy ? String(args.buy).split(',').filter(Boolean) : [];
const HEADED = !!args.headed;

// Buying B5 by hand costs ~2e16 science across 8 nodes -- calibrated at ~2h of
// real play (see index.html's own comment above const RTREE). This mirrors
// only the *end state* of that chain so tests of stage 6-8 content don't have
// to simulate hours of production first.
const RESEARCH_SPINE = { B1: 1, B1b: 1, B2: 1, B3: 1, B3b: 1, B4: 1, B4b: 1, B5: 1 };

let shotN = 0;
function shotPath(label) {
  shotN += 1;
  return path.join(SHOT_DIR, String(shotN).padStart(2, '0') + '-' + label + '.png');
}

function waitForServer(url, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    (function poll() {
      fetch(url).then(() => resolve()).catch(() => {
        if (Date.now() > deadline) return reject(new Error('static server did not start in time'));
        setTimeout(poll, 300);
      });
    })();
  });
}

async function main() {
  // Deliberately NOT file://: index.html opens recherche.html in an <iframe>
  // and both read/write the same localStorage save. Chromium treats each
  // file:// document as its own opaque origin, so the iframe can't see the
  // parent's save under file://. A same-origin http server is required.
  const server = spawn(process.platform === 'win32' ? 'python' : 'python3',
    ['-m', 'http.server', String(PORT)], { cwd: REPO_ROOT, stdio: 'ignore' });
  let exitCode = 0;

  try {
    await waitForServer(`http://localhost:${PORT}/index.html`);

    const browser = await chromium.launch({ headless: !HEADED, args: ['--no-sandbox'] });
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    const errors = [];
    page.on('pageerror', e => errors.push('PAGE ERROR: ' + e.message));
    page.on('console', msg => { if (msg.type() === 'error') errors.push('CONSOLE ERROR: ' + msg.text()); });

    await page.goto(`http://localhost:${PORT}/index.html`);
    await page.waitForSelector('#introNew', { state: 'visible' });
    await page.click('#introNew');
    await page.waitForSelector('#btnDev');
    // The stage-1 tutorial pop-up (#popOk) covers the whole screen and
    // intercepts every click underneath it -- close it before anything else.
    const popOk = await page.$('#popOk');
    if (popOk) await popOk.click();
    await page.screenshot({ path: shotPath('start') });

    if (STAGE > 1) {
      await page.click('#btnDev');
      await page.click('#devAll'); // stage=8, +1e12 all resources, all veins/tabs unlocked
      await page.click('#devRes'); await page.click('#devRes'); await page.click('#devRes');
      await page.evaluate(({ stage, spine }) => {
        state.stage = stage; state.tab = stage;
        if (stage >= 6) {
          state.recherche = { root: true };
          state.research = Object.assign({}, spine);
          state.res.science = 1e18;
        }
        recompute(); structuralDirty = true; render();
      }, { stage: STAGE, spine: RESEARCH_SPINE });
      await page.waitForTimeout(200);
      await page.screenshot({ path: shotPath('stage-' + STAGE) });
    }

    if (STAGE >= 6) {
      const openBtn = await page.$('[data-openresearch]');
      if (!openBtn) {
        errors.push('MISSING: [data-openresearch] button not found in the stage panel');
      } else {
        await openBtn.click();
        const frame = page.frameLocator('#rechercheFrame');
        await frame.locator('#top').waitFor({ state: 'visible', timeout: 10000 });
        await page.waitForTimeout(300);
        await page.screenshot({ path: shotPath('research-tree') });

        const rechercheFrame = page.frames().find(f => f.url().includes('recherche.html'));
        if (rechercheFrame) {
          for (const id of BUY) {
            const exists = await rechercheFrame.evaluate((nodeId) => !!RBY[nodeId], id);
            if (!exists) { errors.push('BUY FAILED: node "' + id + '" not found in RTREE'); continue; }
            await rechercheFrame.evaluate((nodeId) => onNodeClick(RBY[nodeId]), id); // arm
            await page.waitForTimeout(150);
            const result = await rechercheFrame.evaluate(async (nodeId) => {
              const before = nodeState(RBY[nodeId]);
              await onNodeClick(RBY[nodeId]); // confirm (buys if buyable)
              return { id: nodeId, stateBeforeConfirm: before, level: SAVE.state.research[nodeId] || 0 };
            }, id);
            console.log('BUY_RESULT_JSON=' + JSON.stringify(result));
            await page.waitForTimeout(150);
            await page.screenshot({ path: shotPath('bought-' + id) });
          }
        }
        // Deliberately NOT closing the overlay here: SAVE.state (read above via
        // BUY_RESULT_JSON) is the reliable source for what was bought. Closing
        // via #closeBtn races the top page's blur-triggered autosave against
        // closeResearch()'s own resync and can silently discard everything
        // bought this session -- see Gotchas in SKILL.md. --eval therefore
        // only sees purchases if you close the overlay yourself and accept
        // that risk; it is not done automatically.
      }
    }

    if (args.eval) {
      const evalResult = await page.evaluate(args.eval); // evaluated as a raw expression in the page
      console.log('EVAL_RESULT_JSON=' + JSON.stringify(evalResult));
    }

    console.log('ERRORS_JSON=' + JSON.stringify(errors));
    exitCode = errors.length ? 1 : 0;
    await browser.close();
  } finally {
    try { server.kill(); } catch { /* already dead */ }
  }
  process.exit(exitCode);
}

main().catch(e => { console.error('FATAL', e); process.exit(1); });
