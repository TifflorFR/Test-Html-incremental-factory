/*
 * Vérification de bout en bout de la restructuration à budget (index.html, §5).
 * Complète driver.mjs : celui-ci pilote le jeu, celui-là vérifie un système précis.
 *
 *   node pres-test.mjs        # 42 assertions, sortie 1 si l'une échoue
 *
 * Couvre le calcul du budget, les plafonds de licence, le prix des actifs en pourcentage,
 * le périmètre exact de chaque actif (ce qui survit ET ce qui doit disparaître), le cycle
 * sauvegarde/rechargement, et la migration des sauvegardes antérieures à 0.10.0 — laquelle
 * a déjà attrapé une régression silencieuse (le test de migration portait sur `state`, que
 * restore() vient de compléter par freshState(), au lieu de porter sur la sauvegarde lue).
 * Les captures partent dans shots/pres-NN-*.png.
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../../..');
const SHOT_DIR = path.join(__dirname, 'shots');
mkdirSync(SHOT_DIR, { recursive: true });
const PORT = 8123;
let n = 0;
const shot = l => path.join(SHOT_DIR, 'pres-' + String(++n).padStart(2, '0') + '-' + l + '.png');

function waitForServer(url, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((res, rej) => {
    (function poll() {
      fetch(url).then(() => res()).catch(() => {
        if (Date.now() > deadline) return rej(new Error('server timeout'));
        setTimeout(poll, 300);
      });
    })();
  });
}

const CLICKABLE_N = 4;   // bois, pierre, fer, charbon
const results = [];
const check = (name, ok, detail) => { results.push({ name, ok, detail }); };

const server = spawn(process.platform === 'win32' ? 'python' : 'python3',
  ['-m', 'http.server', String(PORT)], { cwd: REPO_ROOT, stdio: 'ignore' });
let code = 0;
try {
  await waitForServer(`http://localhost:${PORT}/index.html`);
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  const page = await browser.newPage({ viewport: { width: 1280, height: 980 } });
  const errors = [];
  page.on('pageerror', e => errors.push('PAGE ERROR: ' + e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push('CONSOLE: ' + m.text()); });

  // queuePop() rejoue une pop-up par étape déjà atteinte au chargement : elles couvrent l'écran
  // et interceptent tous les clics tant qu'on ne les a pas toutes fermées.
  const closePops = async () => {
    for (let i = 0; i < 10; i++) {
      const ok = await page.$('#popOk');
      if (!ok || !(await ok.isVisible())) return;
      await ok.click(); await page.waitForTimeout(120);
    }
  };

  const startFresh = async () => {
    await page.goto(`http://localhost:${PORT}/index.html`);
    await page.waitForSelector('#introNew', { state: 'visible' });
    await page.click('#introNew');
    await page.waitForSelector('#btnDev');
    const ok = await page.$('#popOk'); if (ok) await ok.click();
  };

  // ---------- 1. mise en place : étape 5, machines et améliorations achetées
  await startFresh();
  await page.click('#btnDev');
  await page.click('#devAll');
  await page.evaluate(() => {
    state.stage = 5; state.tab = 5;
    state.cnt = { assem: 1, assem_for: 12, assem_cad: 4, circ: 1, circ_for: 8,
                  hf: 1, hf_for: 20, outil_frappe: 15,
                  cap_s3: 9, xfer_s3: 7, spd_s3: 3, fleet_s3: 2 };
    state.ups = { u1a: true, u2b: true, u3c: true };
    state.res.bois = 12345; state.res.acier = 9999;
    state.valeur = 1e12;          // -> 10*log10(1e12/1e6) = 60 brevets
    recompute(); structuralDirty = true; render();
  });
  const gain = await page.evaluate(() => brevetsGain());
  check('gain de brevets = 60 pour 1e12 de valeur', gain === 60, gain);

  // ---------- 2. panneau
  await page.click('#btnPrestige');
  await page.waitForSelector('#presOverlay', { state: 'visible' });
  await page.screenshot({ path: shot('panneau-vierge') });
  const vis = await page.evaluate(() => ({
    lic: [...document.querySelectorAll('#presBody [data-lic][data-d="1"]')].map(b => b.dataset.lic),
    act: [...document.querySelectorAll('#presBody [data-actif]')].map(b => b.dataset.actif),
  }));
  check('licence recherche masquée avant étape 6', !vis.lic.includes('recherche'), vis.lic);
  check('actif science masqué avant étape 6', !vis.act.includes('science'), vis.act);
  check('actif reprise visible à l\'étape 5', vis.act.includes('reprise'), vis.act);

  // ---------- 3. allocation : 20 extraction, 10 cadence, actifs ligne(3) + logistique
  const clickLic = async (id, d, times) => {
    for (let i = 0; i < times; i++) await page.click(`#presBody [data-lic="${id}"][data-d="${d}"]`);
  };
  await clickLic('extraction', 10, 2);           // 0 -> 10 -> 20 (plafond)
  await clickLic('cadence', 10, 1);
  await page.click('#presBody [data-actif="ligne"]');
  await page.click('#presBody [data-apick="ligne"][data-n="3"]');
  await page.click('#presBody [data-actif="logistique"]');
  await page.screenshot({ path: shot('panneau-reparti') });
  const alloc = await page.evaluate(() => ({
    lic: presDraft.lic, act: presDraft.act, pick: presDraft.pick,
    budget: presBudget(),
    spent: allocSpent(presDraft.lic, presDraft.act, presDraft.pick, presBudget()),
  }));
  check('plafond extraction respecté (20)', alloc.lic.extraction === 20, alloc.lic);
  check('coût actifs = 12% + 10% de 60 = 8 + 6', alloc.spent === 20 + 10 + 8 + 6, alloc);

  // ---------- 4. restructuration
  await page.click('#presBody [data-presgo]');
  await page.waitForTimeout(300);
  const after = await page.evaluate(() => ({
    brevets: state.brevets, stage: state.stage, gain: brevetsGain(),
    lic: state.licences, act: state.actifs, pick: state.actifPick,
    libres: brevetsLibres(),
    cnt: state.cnt, ups: state.ups, bois: state.res.bois,
    stage1: cache.stage[1], global: cache.global, prestige: cache.prestige,
    open: document.getElementById('presOverlay').style.display,
  }));
  check('budget crédité (60)', after.brevets === 60, after.brevets);
  check('gain remis à zéro', after.gain === 0, after.gain);
  check('libres = 60 - 30 - 14', after.libres === 16, after.libres);
  check('retour à l\'étape 1', after.stage === 1, after.stage);
  check('machines étape 3 conservées', after.cnt.assem === 1 && after.cnt.assem_for === 12 && after.cnt.circ_for === 8, after.cnt);
  check('machines étape 2 PERDUES (hors périmètre)', after.cnt.hf === undefined && after.cnt.hf_for === undefined, after.cnt);
  check('véhicules conservés (réseau logistique)', after.cnt.cap_s3 === 9 && after.cnt.fleet_s3 === 2, after.cnt);
  check('Force de frappe PERDUE (actif non pris)', after.cnt.outil_frappe === undefined, after.cnt);
  check('améliorations perdues (actif non pris)', Object.keys(after.ups).length === 0, after.ups);
  check('ressources remises à zéro (stock non pris)', after.bois === 0, after.bois);
  check('extraction x1,20^20 appliquée', Math.abs(after.stage1 - Math.pow(1.2, 20)) < 1e-6, after.stage1);
  check('cadence x1,06^10 dans global', Math.abs(after.global - Math.pow(1.06, 10)) < 1e-9, after.global);
  check('outillage non alloué -> report manuel neutre', after.prestige === 1, after.prestige);
  check('panneau refermé', after.open === 'none', after.open);
  await page.screenshot({ path: shot('apres-restructuration') });

  // ---------- 5. sauvegarde / rechargement
  await page.evaluate(() => save());
  await page.waitForTimeout(200);
  await page.goto(`http://localhost:${PORT}/index.html`);
  await page.waitForSelector('#introResume', { state: 'visible' });
  await page.click('#introResume');
  await page.waitForSelector('#btnDev');
  await closePops();
  const reloaded = await page.evaluate(() => ({
    lic: state.licences, act: state.actifs, brevets: state.brevets,
    stage1: cache.stage[1], libres: brevetsLibres(), presV: state.presV,
  }));
  check('allocation survit au rechargement', reloaded.lic.extraction === 20 && reloaded.lic.cadence === 10, reloaded.lic);
  check('actifs survivent au rechargement', !!reloaded.act.ligne && !!reloaded.act.logistique, reloaded.act);
  check('brevets libres stables après rechargement', reloaded.libres === 16, reloaded.libres);

  // ---------- 6. migration d'une sauvegarde antérieure à 0.10.0
  // On quitte index.html AVANT de trafiquer la sauvegarde : son handler `pagehide` appelle
  // save(), qui réécrirait l'état courant par-dessus. /nope est une 404 de même origine, donc
  // le localStorage reste accessible sans qu'aucun code du jeu ne tourne.
  await page.goto(`http://localhost:${PORT}/nope`);
  const old = await page.evaluate(() => {
    const d = JSON.parse(localStorage.getItem('if:save'));
    delete d.state.licences; delete d.state.actifs; delete d.state.actifPick; delete d.state.presV;
    d.state.brevets = 42; d.state.stage = 4; d.state.tab = 4;
    // valeur calee pour que le total gagne retombe exactement sur 42 : gain nul, donc
    // panneau en lecture seule -- l'etat d'un joueur qui recharge sans pouvoir restructurer
    d.state.valeur = 0; d.state.valeurTot = 1e6 * Math.pow(10, 4.25);
    localStorage.setItem('if:save', JSON.stringify(d));
    return d.state.brevets;
  });
  await page.goto(`http://localhost:${PORT}/index.html`);
  await page.waitForSelector('#introResume', { state: 'visible' });
  await page.click('#introResume');
  await page.waitForSelector('#btnDev');
  await closePops();
  const migrated = await page.evaluate(() => ({
    lic: state.licences, global: cache.global, libres: brevetsLibres(),
    attendu: Math.pow(1.06, 42), presV: state.presV,
    hdr: document.getElementById('hBrevets').textContent,
  }));
  check('migration : 42 brevets versés en Cadence', migrated.lic.cadence === 42, migrated.lic);
  check('migration : production globale identique à l\'ancien 1,06^42',
        Math.abs(migrated.global - migrated.attendu) < 1e-9, [migrated.global, migrated.attendu]);
  check('migration : 0 brevet libre (tout alloué)', migrated.libres === 0, migrated.libres);
  await page.click('#btnPrestige');
  await page.waitForSelector('#presOverlay', { state: 'visible' });
  await page.screenshot({ path: shot('lecture-seule') });
  const ro = await page.evaluate(() => ({
    go: !!document.querySelector('#presBody [data-presgo]'),
    plus: document.querySelector('#presBody [data-lic="cadence"][data-d="1"]').disabled,
  }));
  check('hors restructuration : pas de bouton restructurer', ro.go === false, ro);
  check('hors restructuration : steppers désactivés', ro.plus === true, ro);

  // ---------- 7. actifs de fin de partie : stock, outils, ameliorations, science, reprise
  await page.goto(`http://localhost:${PORT}/nope`);
  await page.evaluate(() => localStorage.removeItem('if:save'));
  await startFresh();
  await page.click('#btnDev');
  await page.click('#devAll');
  await page.evaluate(() => {
    state.stage = 7; state.tab = 7;
    state.cnt = { outil_frappe: 40, hf: 1, hf_for: 30 };
    state.ups = { u1a: true, u6a: true };
    state.research = { B1: 1, B1b: 1, B2: 1, ND1: 1 };
    state.dyson = { D1: { open: true, paid: 5, running: true, done: true } };
    state.planets = { mars: true };
    for (const k in RES) state.res[k] = 0;
    state.res.acier = 5000; state.res.science = 77777;
    state.valeur = 1e13; state.valeurTot = 0;
    recompute(); structuralDirty = true; render();
  });
  await closePops();
  await page.click('#btnPrestige');
  await page.waitForSelector('#presOverlay', { state: 'visible' });
  for (const id of ['stock', 'outils', 'ameliorations', 'science', 'reprise'])
    await page.click(`#presBody [data-actif="${id}"]`);
  await page.click('#presBody [data-apick="reprise"][data-n="6"]');
  await page.screenshot({ path: shot('actifs-fin-de-partie') });
  const budget2 = await page.evaluate(() => presBudget());
  const spent2 = await page.evaluate(() => allocSpent(presDraft.lic, presDraft.act, presDraft.pick, presBudget()));
  check('budget = 70 brevets pour 1e13 de valeur', budget2 === 70, budget2);
  // 4% + 5% + 18% + 30% de 70 = 3 + 4 + 13 + 21 ; reprise etape 6 = 8%*4 = 32% -> 23
  check('cout des cinq actifs = 64', spent2 === 3 + 4 + 13 + 21 + 23, spent2);
  await page.click('#presBody [data-presgo]');
  await page.waitForTimeout(300);
  const end = await page.evaluate(() => ({
    stage: state.stage, tab: state.tab,
    acier: state.res.acier, science: state.res.science,
    outil: state.cnt.outil_frappe, hf: state.cnt.hf,
    ups: state.ups, research: state.research, dyson: state.dyson,
    planets: state.planets, astro: cache.astro,
    veines: Object.keys(unlockedClicks).length,
    libres: brevetsLibres(),
  }));
  check('reprise : redemarrage a l\'etape 6', end.stage >= 6 && end.tab === 6, end);
  // L'etape 7 se rouvre aussitot : son jalon est un noeud de recherche (B2), pas un debit a
  // tenir, et le portefeuille scientifique vient d'etre rachete. Payer science + reprise donne
  // donc l'etape suivante par-dessus le marche -- comportement voulu, pas un effet de bord.
  check('reprise + science : jalon B2 deja franchi, etape 7 rouverte', end.stage === 7, end.stage);
  check('reprise : toutes les veines rouvertes', end.veines === CLICKABLE_N, end.veines);
  check('stock : 10 % de l\'acier conserve', Math.abs(end.acier - 500) < 8, end.acier);   // la chaine consomme deja pendant les 300 ms
  check('stock : 10 % de la science conservee', end.science === 7777, end.science);
  check('outils : Force de frappe conservee', end.outil === 40, end.outil);
  check('machines de production perdues (ligne non prise)', end.hf === undefined, end.hf);
  check('ameliorations conservees', end.ups.u1a === true && end.ups.u6a === true, end.ups);
  check('arbre de recherche conserve', end.research.B2 === 1 && end.research.ND1 === 1, end.research);
  check('segment Dyson conserve', end.dyson.D1 && end.dyson.D1.done === true, end.dyson);
  check('colonies PERDUES (aucun actif ne les couvre)',
        Object.keys(end.planets).length === 0 && end.astro === 1, [end.planets, end.astro]);
  check('libres = 70 - 64', end.libres === 6, end.libres);
  await page.screenshot({ path: shot('apres-reprise') });

  await browser.close();
  const bad = results.filter(r => !r.ok);
  for (const r of results) console.log((r.ok ? 'OK   ' : 'ECHEC') + '  ' + r.name + (r.ok ? '' : '  -> ' + JSON.stringify(r.detail)));
  console.log('\nERRORS_JSON=' + JSON.stringify(errors.filter(e => !e.includes('404'))));   // /nope est volontaire
  console.log(bad.length ? `\n${bad.length} ECHEC(S)` : `\n${results.length} verifications OK`);
  if (bad.length || errors.filter(e => !e.includes('404')).length) code = 1;
} catch (e) {
  console.error('FATAL', e);
  code = 1;
} finally {
  server.kill();
  process.exit(code);
}
