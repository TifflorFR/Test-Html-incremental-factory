/*
 * Vérification de bout en bout de la restructuration à budget (index.html, §5).
 * Complète driver.mjs : celui-ci pilote le jeu, celui-là vérifie un système précis.
 *
 *   node pres-test.mjs        # sortie 1 si une assertion échoue
 *
 * Couvre le calcul du budget, les plafonds de licence, le prix des actifs en pourcentage,
 * le périmètre exact de chaque actif (ce qui survit ET ce qui doit disparaître), le cycle
 * sauvegarde/rechargement, des scénarios multi-runs (ce qu'une répartition laisse au run
 * suivant, dont trois runs joués au bot), et la migration des sauvegardes antérieures à 0.10.0 — laquelle
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
  // ligne 12 % -> 8, reseau de convois 8 % -> 5 (l'oleoduc se paie desormais a part)
  check('cout actifs = 12% + 8% de 60 = 8 + 5', alloc.spent === 20 + 10 + 8 + 5, alloc);

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
  check('libres = 60 - 30 - 13', after.libres === 17, after.libres);
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
  check('brevets libres stables apres rechargement', reloaded.libres === 17, reloaded.libres);

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

  // ---------- 8. licences et actifs de transport / oleoduc
  await page.goto(`http://localhost:${PORT}/nope`);
  await page.evaluate(() => localStorage.removeItem('if:save'));
  await startFresh();
  await page.click('#btnDev');
  await page.click('#devAll');
  await page.evaluate(() => {
    state.stage = 5; state.tab = 5;
    state.cnt = { cap_s4: 6, xfer_s4: 5, spd_s4: 2, fleet_s4: 1,
                  pipe_dia: 11, pipe_pump: 9, hf: 1 };
    state.buf = { p4_moteur: 40, pipe_petrole: 25 };
    state.valeur = 1e12;
    recompute(); structuralDirty = true; render();
  });
  await closePops();

  // effet mesure des deux licences, licences posees puis retirees sur le meme etat
  const eff = await page.evaluate(() => {
    const lire = () => {
      tick(0.1);
      const p4 = PATHS.find(p => p.dest === 4 && p.res !== 'petrole');
      const st = pipeStats();
      return { cap: p4.cap, xfer: p4.xfer, dia: st.dia, pump: st.pump, rate: st.rate };
    };
    state.licences = {}; recompute(); const sans = lire();
    state.licences = { convois: 15, oleoduc: 12 }; recompute(); const avec = lire();
    state.licences = {}; recompute();
    return { sans, avec, cCap: Math.pow(1.08, 15), cPipe: Math.pow(1.10, 12) };
  });
  const proche = (a, b) => Math.abs(a / b - 1) < 1e-9;
  check('convois : capacite des vehicules x1,08^15', proche(eff.avec.cap / eff.sans.cap, eff.cCap), [eff.avec.cap, eff.sans.cap]);
  check('convois : debit de transfert x1,08^15', proche(eff.avec.xfer / eff.sans.xfer, eff.cCap), [eff.avec.xfer, eff.sans.xfer]);
  check('oleoduc : diametre x1,10^12', proche(eff.avec.dia / eff.sans.dia, eff.cPipe), [eff.avec.dia, eff.sans.dia]);
  check('oleoduc : pompage x1,10^12', proche(eff.avec.pump / eff.sans.pump, eff.cPipe), [eff.avec.pump, eff.sans.pump]);
  check('oleoduc : debit reel (min des deux) suit', proche(eff.avec.rate / eff.sans.rate, eff.cPipe), [eff.avec.rate, eff.sans.rate]);
  check('convois : plafond a 15 niveaux', await page.evaluate(() => LICBY.convois.max) === 15, null);
  check('oleoduc : plafond a 12 niveaux', await page.evaluate(() => LICBY.oleoduc.max) === 12, null);

  // les deux actifs sont bien disjoints : convois ne rachete pas l'oleoduc, et vice versa
  await page.click('#btnPrestige');
  await page.waitForSelector('#presOverlay', { state: 'visible' });
  await page.click('#presBody [data-actif="logistique"]');
  await page.screenshot({ path: shot('actifs-transport') });
  const coutT = await page.evaluate(() => ({
    log: actifCost(ACTBY.logistique, presBudget()),
    ole: actifCost(ACTBY.oleoduc, presBudget()),
    budget: presBudget(),
  }));
  check('reseau de convois = 8 % de 60', coutT.log === 5, coutT);   // ceil(0.08*60) = 5
  check('oleoduc = 6 % de 60', coutT.ole === 4, coutT);             // ceil(0.06*60) = 4
  await page.click('#presBody [data-presgo]');
  await page.waitForTimeout(300);
  const seulConvois = await page.evaluate(() => ({
    cap: state.cnt.cap_s4, fleet: state.cnt.fleet_s4,
    dia: state.cnt.pipe_dia, pump: state.cnt.pipe_pump,
    bufPath: state.buf.p4_moteur, bufPipe: state.buf.pipe_petrole,
  }));
  check('convois seul : vehicules conserves', seulConvois.cap === 6 && seulConvois.fleet === 1, seulConvois);
  check('convois seul : oleoduc PERDU', seulConvois.dia === undefined && seulConvois.pump === undefined, seulConvois);
  check('convois seul : tampon de chemin conserve', seulConvois.bufPath === 40, seulConvois);
  check('convois seul : tampon d\'oleoduc NON repris', !seulConvois.bufPipe, seulConvois.bufPipe);

  // meme scenario, actif oleoduc seul
  await page.goto(`http://localhost:${PORT}/nope`);
  await page.evaluate(() => localStorage.removeItem('if:save'));
  await startFresh();
  await page.click('#btnDev');
  await page.click('#devAll');
  await page.evaluate(() => {
    state.stage = 5; state.tab = 5;
    state.cnt = { cap_s4: 6, pipe_dia: 11, pipe_pump: 9 };
    state.buf = { p4_moteur: 40, pipe_petrole: 25 };
    state.valeur = 1e12;
    recompute(); structuralDirty = true; render();
  });
  await closePops();
  await page.click('#btnPrestige');
  await page.waitForSelector('#presOverlay', { state: 'visible' });
  await page.click('#presBody [data-actif="oleoduc"]');
  await page.click('#presBody [data-presgo]');
  await page.waitForTimeout(300);
  const seulPipe = await page.evaluate(() => ({
    cap: state.cnt.cap_s4, dia: state.cnt.pipe_dia, pump: state.cnt.pipe_pump,
    bufPath: state.buf.p4_moteur, bufPipe: state.buf.pipe_petrole,
  }));
  check('oleoduc seul : diametre et pompage conserves', seulPipe.dia === 11 && seulPipe.pump === 9, seulPipe);
  check('oleoduc seul : vehicules PERDUS', seulPipe.cap === undefined, seulPipe);
  check('oleoduc seul : tampon de chemin NON repris', !seulPipe.bufPath, seulPipe.bufPath);
  check('oleoduc seul : petrole en transit conserve', seulPipe.bufPipe === 25, seulPipe);

  // ---------- 9. scenarios multi-runs : ce qu'une repartition laisse au run suivant
  const nouvellePartie = async () => {
    await page.goto(`http://localhost:${PORT}/nope`);
    await page.evaluate(() => localStorage.removeItem('if:save'));
    await startFresh();
    await page.click('#btnDev');
    await page.click('#devAll');
    await closePops();
  };
  // Pose l'etat voulu puis ouvre le panneau. Les pop-ups d'etape se rejouent a chaque saut d'etape.
  const panneau = async (setup) => {
    await page.evaluate(setup);
    await page.evaluate(() => { recompute(); structuralDirty = true; render(); });
    await page.waitForTimeout(250);
    await closePops();
    await page.click('#btnPrestige');
    await page.waitForSelector('#presOverlay', { state: 'visible' });
  };
  const restructurer = async () => {
    await page.click('#presBody [data-presgo]');
    await page.waitForTimeout(250);
    await closePops();
  };
  const lignes = () => page.evaluate(() => ({
    lic: [...document.querySelectorAll('#presBody [data-lic][data-d="1"]')].map(x => x.dataset.lic),
    act: [...document.querySelectorAll('#presBody [data-actif]')].map(x => x.dataset.actif),
  }));

  // 9a. Run 1 a l'etape 7 : licence Recherche + portefeuille scientifique, puis reprise reglee sur 7
  //     et decochee (le choix d'etape reste dans la repartition). Run 2 restructure a l'etape 4,
  //     ou ces deux lignes ne sont normalement pas encore revelees.
  await nouvellePartie();
  await panneau(() => { state.stage = 7; state.tab = 7; state.cnt = {}; state.research = { B1: 1, B2: 1 }; state.valeur = 1e14; });
  for (let i = 0; i < 10; i++) await page.click('#presBody [data-lic="recherche"][data-d="1"]');
  await page.click('#presBody [data-actif="science"]');
  await page.click('#presBody [data-actif="reprise"]');
  await page.click('#presBody [data-apick="reprise"][data-n="7"]');
  await page.click('#presBody [data-actif="reprise"]');
  await restructurer();
  const r1 = await page.evaluate(() => ({ stage: state.stage, lic: state.licences, act: state.actifs, pick: state.actifPick }));
  check('multi-run 1 : Recherche 10 + science, reprise decochee (choix 7 garde)',
        r1.stage === 1 && r1.lic.recherche === 10 && r1.act.science && !r1.act.reprise && r1.pick.reprise === 7, r1);

  await panneau(() => { state.stage = 4; state.tab = 4; state.valeur = 1e15; });
  const vis2 = await lignes();
  check('multi-run 2 (etape 4) : licence Recherche allouee reste visible', vis2.lic.includes('recherche'), vis2.lic);
  check('multi-run 2 (etape 4) : actif science pris reste visible', vis2.act.includes('science'), vis2.act);
  await page.click('#presBody [data-lic="recherche"][data-d="-10"]');
  await page.click('#presBody [data-actif="science"]');
  const vis2b = await lignes();
  check('multi-run 2 : une ligne ramenee a zero ne disparait pas', vis2b.lic.includes('recherche') && vis2b.act.includes('science'), vis2b);
  await page.click('#presBody [data-actif="reprise"]');
  const rep2 = await page.evaluate(() => ({
    pick: presDraft.pick.reprise, budget: presBudget(),
    cost: actifCost(ACTBY.reprise, presBudget(), pickClamp(ACTBY.reprise, presDraft.pick.reprise)),
    on: [...document.querySelectorAll('#presBody [data-apick="reprise"].on')].map(x => x.dataset.n),
    spent: allocSpent(presDraft.lic, presDraft.act, presDraft.pick, presBudget()),
  }));
  check('multi-run 2 : reprise rabattue sur l\'etape atteinte (4, pas 7)', rep2.pick === 4 && rep2.on.join() === '4', rep2);
  check('multi-run 2 : reprise facturee 16 %, pas 40 %', rep2.cost === Math.ceil(.16 * rep2.budget), rep2);
  check('multi-run 2 : seule la reprise est immobilisee', rep2.spent === rep2.cost, rep2);
  await page.screenshot({ path: shot('multirun-reprise-rabattue') });
  await restructurer();
  const r2 = await page.evaluate(() => ({ stage: state.stage, lic: state.licences, act: state.actifs, research: state.research, lab: cache.mach.lab }));
  check('multi-run 2 : reprise a l\'etape 4, pas a l\'etape 7', r2.stage === 4, r2.stage);
  check('multi-run 2 : licence Recherche retiree', !r2.lic.recherche && r2.lab === 1, r2);
  check('multi-run 2 : science decoche -> arbre de recherche perdu', !r2.act.science && Object.keys(r2.research).length === 0, r2);

  // 9b. Ligne conservee au-dessus de son plafond (Optimisations superieures non conservees) :
  //     l'effectif doit survivre au rechargement, pas etre converti en niveaux de Production.
  await nouvellePartie();
  await panneau(() => {
    state.stage = 6; state.tab = 6;
    state.cnt = { hf: 16, hf_for: 5, wagon: 1, camion: 1, train: 1, avion: 1, navette: 1 };
    state.valeur = 1e17;
  });
  await page.click('#presBody [data-actif="ligne"]');
  await page.click('#presBody [data-apick="ligne"][data-n="2"]');
  await restructurer();
  const lireHf = () => page.evaluate(() => ({ hf: state.cnt.hf, hf_for: state.cnt.hf_for, cap: capOf(M.hf), debit: state.cnt.hf * cache.force.hf }));
  const avantR = await lireHf();
  check('ligne au-dessus du plafond : 16 hauts-fourneaux, plafond 1', avantR.hf === 16 && avantR.cap === 1, avantR);
  await page.evaluate(() => save());
  await page.waitForTimeout(200);
  await page.goto(`http://localhost:${PORT}/index.html`);
  await page.waitForSelector('#introResume', { state: 'visible' });
  await page.click('#introResume');
  await page.waitForSelector('#btnDev');
  await closePops();
  const apresR = await lireHf();
  check('ligne au-dessus du plafond : effectif intact apres rechargement', apresR.hf === 16 && apresR.hf_for === 5, apresR);
  check('ligne au-dessus du plafond : debit intact apres rechargement', Math.abs(apresR.debit / avantR.debit - 1) < 1e-9, [avantR.debit, apresR.debit]);

  // 9c. Trois runs joues au bot de reference (meme logique que bot.txt, mais rejouable sans
  //     repartir d'une page neuve), jusqu'a l'etape 5 ET au moins 1 brevet a gagner -- apres deux
  //     restructurations, l'etape 5 ne suffit plus a depasser le total deja encaisse. Chacun
  //     restructure avec une repartition differente. A chaque
  //     restructuration : brevets = formule, libres = budget - immobilise, et chaque licence
  //     applique exactement son taux (recompute avec puis sans la repartition).
  // partie vierge, sans le panneau de dev : c'est la valeur reellement produite qui fait le budget
  await page.goto(`http://localhost:${PORT}/nope`);
  await page.evaluate(() => localStorage.removeItem('if:save'));
  await startFresh();
  await page.evaluate(() => {
    window.__jouer = (jusqua, maxMin) => {
      const val = c => Object.keys(c).reduce((a, k) => a + c[k] * (RES[k].v || 1), 0);
      const acheter = () => { for (let g = 0; g < 40; g++) { let best = null;
        MACH.forEach(m => { if (remainingCap(m) <= 0 || (m.need && state.stage < m.need) || m.s > state.stage) return;
          const c = bulkCost(m, 1); if (!afford(c)) return; const v = val(c); if (!best || v < best.v) best = { t: 'm', m, c, v }; });
        UP.forEach(u => { if (state.ups[u.id] || u.s > state.stage || !afford(u.c)) return;
          const v = val(u.c); if (!best || v < best.v) best = { t: 'u', m: u, c: u.c, v }; });
        if (!best) return; pay(best.c);
        if (best.t === 'm') state.cnt[best.m.id] = (state.cnt[best.m.id] || 0) + 1; else state.ups[best.m.id] = true;
        recompute(); } };
      let t = 0;
      for (let i = 0; i < maxMin * 120 && (state.stage < jusqua || brevetsGain() < 1); i++) {
        const veines = CLICKABLE.filter(cl => clickUnlocked(cl)), gain = state.click * cache.click * cache.prestige;
        for (let c = 0; c < 3; c++) { const cl = veines[c % veines.length]; if (cl) { state.res[cl.r] += gain; state.valeur += gain * RES[cl.r].v; } }
        tick(0.5); t += 0.5; if (i % 4 === 0) acheter();
      }
      return { min: t / 60, stage: state.stage, gain: brevetsGain() };
    };
    window.__ratios = () => {
      const L = state.licences, avec = JSON.parse(JSON.stringify(cache));
      state.licences = {}; recompute(); const sans = JSON.parse(JSON.stringify(cache));
      state.licences = L; recompute();
      const P = (x, n) => Math.pow(x, n || 0), ecarts = [];
      const cmp = (nom, a, b, att) => { if (Math.abs(a / b / att - 1) > 1e-9) ecarts.push(nom + ' ' + (a / b) + ' != ' + att); };
      cmp('global', avec.global, sans.global, P(1.06, L.cadence));
      cmp('manuel', avec.prestige, sans.prestige, P(1.15, L.outillage));
      cmp('etape1', avec.stage[1], sans.stage[1], P(1.2, L.extraction));
      [2, 3].forEach(s => cmp('etape' + s, avec.stage[s], sans.stage[s], P(1.12, L.metallurgie)));
      [4, 5].forEach(s => cmp('etape' + s, avec.stage[s], sans.stage[s], P(1.12, L.reseau)));
      [2, 3, 4, 5, 7].forEach(s => { cmp('cap' + s, avec.cap[s], sans.cap[s], P(1.08, L.convois)); cmp('xfer' + s, avec.xfer[s], sans.xfer[s], P(1.08, L.convois)); });
      cmp('oleoduc', avec.pipe, sans.pipe, P(1.1, L.oleoduc));
      cmp('labo', avec.mach.lab, sans.mach.lab, P(1.1, L.recherche));
      return ecarts;
    };
  });
  const plans = [
    { nom: 'extraction + cadence', lic: { extraction: 20, cadence: 99 }, act: [] },
    { nom: 'cadence/outillage/metallurgie + stock/outils/ameliorations', lic: { cadence: 20, outillage: 10, metallurgie: 10 }, act: ['stock', 'outils', 'ameliorations'] },
    { nom: 'transport + reseau', lic: { convois: 15, oleoduc: 12, reseau: 10, cadence: 99 }, act: [] },
  ];
  const durees = [];
  for (let run = 0; run < plans.length; run++) {
    const jeu = await page.evaluate(() => __jouer(5, 60));
    durees.push(jeu.min);
    check(`bot run ${run + 1} : etape 5 atteinte, au moins 1 brevet a gagner`, jeu.stage >= 5 && jeu.gain >= 1, jeu);
    if (!(jeu.gain >= 1)) break;
    await panneau(() => {});
    await page.evaluate(() => { presDraft.lic = {}; presDraft.act = {}; presRender(); });
    const plan = plans[run];
    // actifs d'abord : Cadence a 99 absorberait sinon tout le budget
    for (const id of plan.act) await page.click(`#presBody [data-actif="${id}"]`);
    for (const [id, n] of Object.entries(plan.lic))
      for (let i = 0; i < n; i++) {
        const sel = `#presBody [data-lic="${id}"][data-d="1"]`;
        if (await page.$eval(sel, e => e.disabled)) break;
        await page.click(sel);
      }
    const pre = await page.evaluate(() => ({ budget: presBudget(), spent: allocSpent(presDraft.lic, presDraft.act, presDraft.pick, presBudget()) }));
    await restructurer();
    const post = await page.evaluate(() => ({
      brevets: state.brevets, formule: Math.floor(10 * Math.log10(state.valeurTot / 1e6)),
      libres: brevetsLibres(), hdr: document.getElementById('hBrevets').textContent, ecarts: __ratios(),
    }));
    check(`bot restructuration ${run + 1} (${plan.nom}) : brevets = formule`, post.brevets === post.formule && post.brevets === pre.budget, [post, pre]);
    check(`bot restructuration ${run + 1} : libres = budget - immobilise`, post.libres === pre.budget - pre.spent && post.hdr.startsWith(post.libres + ' / '), [post, pre]);
    check(`bot restructuration ${run + 1} : chaque licence applique son taux`, post.ecarts.length === 0, post.ecarts);
  }
  check('bot : le run 2 (apres brevets) atteint l\'etape 5 plus vite que le run 1', durees[1] < durees[0], durees);

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
