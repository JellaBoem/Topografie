'use strict';
/* Topografietrainer - vanilla JS, geen frameworks, geen afhankelijkheden.
   Alles lokaal: kaart uit map-data.json, voortgang in localStorage. */

// ---------------------------------------------------------------- constanten
const STORE_KEY = 'topo_v1';
const INTERVALS = { 1: 1, 2: 3, 3: 10, 4: 30, 5: 90 }; // Leitner: bakje -> aantal sessies tot herhaling
const MAX_BOX = 5;
const MIN_TAP_PX = 22;        // kleinste tikcirkel op het scherm (voor mini-landen)
const MOVE_TOL = 10;          // pixels: meer beweging = schuiven i.p.v. tikken
const MIN_SHOW_PX = 28;       // zo groot moet het juiste land minstens in beeld staan
const ASK_MIN_PX = 46;        // zo groot moet het opgelichte land staan bij 'Omgekeerd'

// ---------------------------------------------------------------- state
let MAP = null;               // map-data.json
let INFO = {};                // land-info.json: tekst per land, mag leeg zijn
let byName = new Map();       // naam -> country object
let quizPolys = new Map();    // naam -> [ring[[x,y]...]...] voor klikdetectie
let state = null;             // opgeslagen voortgang
let session = null;           // huidige sessie (runtime)
let kijk = null;              // land dat je los opzoekt, buiten een sessie om
let view = null;              // {x,y,w,h} viewBox in wereldcoördinaten
let base = null;              // volledige kaart-viewBox

const $ = s => document.querySelector(s);
const el = id => document.getElementById(id);

// ---------------------------------------------------------------- opslag
function defaultState() {
  return { v: 1, sessionCounter: 0, items: {},
    settings: { soort: 'land', scope: { type: 'all', values: [] },
                scopeStad: { type: 'brok', values: [] },
                mode: 'point', newPerSession: 7, sessionLen: 20 } };
}
// Landen en hoofdsteden houden elk hun eigen selectie bij. Was het er één, dan
// verloor ze haar werelddeel-keuze bij de landen zodra ze een keer hoofdsteden
// deed. Oudere opslag kent scopeStad nog niet; die vullen we hier bij.
function scopeVan(s) {
  if ((s || soortNu()) !== 'stad') return state.settings.scope;
  if (!state.settings.scopeStad) state.settings.scopeStad = { type: 'brok', values: [] };
  return state.settings.scopeStad;
}
// Wat oefen je: landen, zeeën, gebergtes, of door elkaar. Opslag van vóór dit
// onderwerp mist het veld; die opent gewoon op landen, precies zoals ze het
// achterliet.
function soortNu() { return (state.settings && state.settings.soort) || 'land'; }
// Enkelvoud, meervoud en het/de per onderwerp, zodat de app "3 zeeën" zegt en
// niet "3 landen", en "1 nieuwe zee" naast "1 nieuw land". Zonder dat lidwoord
// wordt het "1 nieuwe land" - en dat leest als een fout, ook al klopt het getal.
const SOORTNAAM = {
  land:  { ev: 'land',      mv: 'landen',      het: true },
  zee:   { ev: 'zee',       mv: 'zeeën',       het: false },
  berg:  { ev: 'gebergte',  mv: 'gebergtes',   het: true },
  stad:  { ev: 'hoofdstad', mv: 'hoofdsteden', het: false },
  haven: { ev: 'haven',     mv: 'havens',      het: false },
  mix:   { ev: 'onderdeel', mv: 'onderdelen',  het: true }
};
const soortWoord = s => SOORTNAAM[s] || SOORTNAAM.land;
function noem(s, meervoud) { const w = soortWoord(s); return meervoud ? w.mv : w.ev; }
// "1 nieuw land" / "3 nieuwe landen" / "1 nieuwe zee"
function noemN(s, n) {
  const w = soortWoord(s);
  return `<b>${n}</b> ` + (n === 1 ? (w.het ? 'nieuw ' : 'nieuwe ') + w.ev : 'nieuwe ' + w.mv);
}
// Aanwijzen en omgekeerd zijn twee verschillende vaardigheden: je kunt Chili
// feilloos aanwijzen en toch niet herkennen als het oplicht. Daarom houdt elke
// stand zijn eigen bakjes bij. Anders zou de voortgangsbalk iets beweren wat
// niet waar is.
function fields(m) {
  return (m || state.settings.mode) === 'reverse'
    ? { box: 'rbox', due: 'rdue', seen: 'rseen', ok: 'rcorrect', no: 'rwrong' }
    : { box: 'box', due: 'due', seen: 'seen', ok: 'correct', no: 'wrong' };
}
// Welke oefenstand er nu echt geldt. Bij hoofdsteden is dat altijd de
// omgekeerde. Aanwijzen kan daar niet eerlijk: Kinshasa en Brazzaville liggen
// op een telefoonscherm 1 pixel uit elkaar en Jeruzalem en Ramallah 2, en geen
// enkele zoomstand haalt die uit elkaar. Dat is munten opgooien, geen oefening.
// Bovendien is wat je bij een hoofdstad leert wélke stad bij welk land hoort,
// niet waar precies in dat land hij ligt.
function modeNu() { return soortNu() === 'stad' ? 'reverse' : state.settings.mode; }
function load() {
  try { const raw = localStorage.getItem(STORE_KEY); state = raw ? JSON.parse(raw) : defaultState(); }
  catch (e) { state = defaultState(); }
  if (!state.items) state = defaultState();
}
function save() { try { localStorage.setItem(STORE_KEY, JSON.stringify(state)); } catch (e) {} }
function ensureItem(k) {
  const it = state.items[k] || (state.items[k] = {});
  if (it.box == null) { it.box = 0; it.due = 0; it.seen = false; it.correct = 0; it.wrong = 0; }
  if (it.rbox == null) { it.rbox = 0; it.rdue = 0; it.rseen = false; it.rcorrect = 0; it.rwrong = 0; }
}

// ---------------------------------------------------------------- data laden
async function boot() {
  load();
  const res = await fetch('map-data.json');
  MAP = await res.json();
  // Landinformatie staat apart van de kaart: die tekst groeit en wordt bijgesteld,
  // de kaart niet. Ontbreekt hij, dan werkt de app gewoon zonder.
  INFO = await fetch('land-info.json').then(r => r.json()).catch(() => ({}));
  // Zeeën en gebergtes komen uit een tweede bestand, gebouwd met exact dezelfde
  // projectie (map-data.json meta.proj). Ze krijgen dezelfde velden als een land
  // en worden hier gewoon achteraan geplakt: daarna weet de rest van de app niet
  // eens dat er verschil is. Ontbreekt het bestand, dan draait de app als
  // voorheen - net als land-info.json hierboven.
  const EX = await fetch('extra-data.json').then(r => r.json()).catch(() => null);
  if (EX && EX.items) {
    MAP.countries = MAP.countries.concat(EX.items);
    MAP.brokken = MAP.brokken.concat(EX.brokken || []);
  }
  MAP.countries.forEach(c => { if (!c.soort) c.soort = 'land'; });
  MAP.brokken.forEach(b => { if (!b.soort) b.soort = 'land'; });
  // Een hoofdstad heet "stad:Germany" en daar zit de sleutel van het land al in.
  // De vraag laat het land oplichten, dus die verwijzing is nodig; hem hier
  // afleiden scheelt dat hetzelfde nog eens in het databestand staat.
  MAP.countries.forEach(c => { if (c.soort === 'stad') c.land = c.name.slice(5); });
  MAP.countries.forEach(c => byName.set(c.name, c));
  MAP.countries.filter(c => c.quiz).forEach(c => quizPolys.set(c.name, parsePath(c.d)));
  drawMap();
  buildScopeUI();
  buildZoek();
  showMenu();
  bindEvents();
}

// path 'M x yL x y...Z M...' -> lijst van ringen [[x,y],...]
function parsePath(d) {
  const rings = [];
  for (const part of d.split('Z')) {
    if (!part.trim()) continue;
    const nums = part.replace('M', '').split(/[L\s]+/).map(parseFloat).filter(n => !isNaN(n));
    const ring = [];
    for (let i = 0; i + 1 < nums.length; i += 2) ring.push([nums[i], nums[i + 1]]);
    if (ring.length >= 3) rings.push(ring);
  }
  return rings;
}

// ---------------------------------------------------------------- kaart tekenen
function drawMap() {
  const svg = el('map'), vp = el('viewport');
  svg.setAttribute('viewBox', MAP.meta.viewBox);
  const [, , W, H] = MAP.meta.viewBox.split(' ').map(Number);
  base = { x: 0, y: 0, w: W, h: H };
  view = { ...base };
  // Volgorde in de SVG is stapelvolgorde. Zeeën onderop (anders dekken ze de
  // kust af), dan het land, dan de gebergtes eroverheen - want een gebergte
  // ligt nu eenmaal óp een land.
  const laag = s => MAP.countries.filter(c => c.soort === s);
  let html = '';
  for (const c of laag('zee'))  html += `<path class="zee" data-soort="zee" d="${c.d}" data-k="${enc(c.name)}"></path>`;
  for (const c of laag('land')) html += `<path class="c" data-soort="land" d="${c.d}" data-k="${enc(c.name)}"></path>`;
  for (const c of laag('berg')) html += `<path class="berg" data-soort="berg" d="${c.d}" data-k="${enc(c.name)}"></path>`;
  // Een hoofdstad is een punt. Een pad zonder lengte met een ronde streepdop
  // tekent precies een rondje, en met vector-effect blijft dat rondje op het
  // scherm altijd even groot - ook als je inzoomt. Dat scheelt 168 sommetjes per
  // beeldje tijdens het slepen, en het blijft een <path> met data-k, dus alles
  // wat de app al kan (oplichten, opzoeken, focussen) werkt ongewijzigd.
  for (const c of laag('stad')) html += `<path class="stad" data-soort="stad" d="${c.d}" data-k="${enc(c.name)}"></path>`;
  vp.innerHTML = html;
  verfLagen();
}

// Een oceaan als groot gekleurd vlak is prachtig als je zeeën oefent, en pure
// afleiding als je landen oefent. Dus: de vormen staan er altijd (aantikken kan
// dan meteen), maar ze krijgen alleen kleur als het onderwerp erom vraagt.
// Twee losse klassen in plaats van een dubbele, zodat .target en .peek er in de
// stylesheet gewoon overheen kunnen - dat scheelt een specificiteitsgevecht.
function verfLagen() {
  const s = soortNu();
  const aan = { zee: s === 'zee' || s === 'mix', berg: s === 'berg' || s === 'mix', stad: s === 'stad' };
  // Zeeën en gebergtes zijn vlakken: aan of uit voor de hele laag.
  for (const k of ['zee', 'berg'])
    el('viewport').querySelectorAll(`path[data-soort="${k}"]`).forEach(p => {
      p.classList.toggle(k + 'aan', aan[k]);
      p.classList.toggle(k, !aan[k]);
    });
  // Hoofdsteden liggen dicht op elkaar, dus hier gaat het per stip: alleen de
  // hoofdsteden uit de gekozen brok krijgen kleur. Zoomde je in op de Benelux
  // met alle 168 stippen aan, dan stonden Bern, Londen, Praag en Kopenhagen
  // mee in beeld en werd het een puntenwolk. De andere paden blijven wel
  // staan, zodat opzoeken en inzoomen op een stad buiten de brok blijft werken.
  const inBrok = aan.stad ? new Set(scopeKeys()) : null;
  el('viewport').querySelectorAll('path[data-soort="stad"]').forEach(p => {
    const mee = !!inBrok && inBrok.has(p.dataset.k);
    p.classList.toggle('stadaan', mee);
    p.classList.toggle('stad', !mee);
  });
}
function enc(s) { return s.replace(/"/g, '&quot;'); }
function pathEl(name) { return el('viewport').querySelector(`path[data-k="${CSS.escape(name)}"]`); }

// ---------------------------------------------------------------- viewBox / zoom
// De view-verhouding volgt altijd de vorm van het kaartvak, zodat de kaart het
// vak exact vult (geen balken) en schermtikken 1-op-1 op wereldcoördinaten mappen.
function mapRect() { return el('map').getBoundingClientRect(); }
function aspect() { const r = mapRect(); return (r.width > 0 && r.height > 0) ? r.height / r.width : base.h / base.w; }
function applyView() { el('map').setAttribute('viewBox', `${view.x} ${view.y} ${view.w} ${view.h}`); }
function clampAxis(v, size, min0, span, pad) {
  const lo = min0 - pad, hi = min0 + span + pad;
  if (size >= hi - lo) return (lo + hi) / 2 - size / 2;      // groter dan inhoud: centreren
  return Math.max(lo, Math.min(hi - size, v));
}
function clampView() {
  view.w = Math.max(base.w * 0.045, Math.min(base.w * 1.8, view.w)); // tot ~22x inzoomen
  view.h = view.w * aspect();
  view.x = clampAxis(view.x, view.w, base.x, base.w, base.w * 0.15);
  view.y = clampAxis(view.y, view.h, base.y, base.h, base.h * 0.30);
}
function zoomAt(cx, cy, factor) { // cx,cy in wereldcoördinaten
  const oldW = view.w, oldH = view.h;
  view.w *= factor;
  view.h = view.w * aspect();
  view.x = cx - (cx - view.x) * (view.w / oldW);
  view.y = cy - (cy - view.y) * (view.h / oldH);
  clampView(); applyView();
}
function fitBounds(b, pad) {
  pad = pad == null ? 0.12 : pad;
  const cx = (b.x0 + b.x1) / 2, cy = (b.y0 + b.y1) / 2;
  let w = (b.x1 - b.x0) * (1 + pad * 2);
  const a = aspect();
  let h = w * a;
  const needH = (b.y1 - b.y0) * (1 + pad * 2);
  if (h < needH) { h = needH; w = h / a; }
  view = { x: cx - w / 2, y: cy - h / 2, w, h };
  clampView(); applyView();
}
function scopeBounds() {
  const full = { x0: base.x, y0: base.y, x1: base.x + base.w, y1: base.y + base.h };
  const keys = scopeKeys();
  // Bij zeeën en gebergtes altijd de hele wereld: negen gebergtes zijn zo
  // verspreid dat een kader om "de kern" de Andes buiten beeld zou duwen.
  // Hoofdsteden juist niet: die moeten ingezoomd staan, anders zijn de stippen
  // niet uit elkaar te houden.
  const s = soortNu();
  if (!keys.length || scopeVan(s).type === 'all' || (s !== 'land' && s !== 'stad')) return full;
  // fit op de KERN: 5e-95e percentiel van de trefpunten, zodat uitschieters als
  // Rusland (tot in Siberie) of IJsland het beeld niet leegtrekken.
  const xs = keys.map(k => byName.get(k).cx).sort((a, b) => a - b);
  const ys = keys.map(k => byName.get(k).cy).sort((a, b) => a - b);
  const q = (arr, p) => arr[Math.min(arr.length - 1, Math.max(0, Math.round((arr.length - 1) * p)))];
  let x0 = q(xs, 0.05), x1 = q(xs, 0.95), y0 = q(ys, 0.05), y1 = q(ys, 0.95);
  // Minimale omvang, zodat een selectie van weinig landen niet absurd ver
  // inzoomt. Bij hoofdsteden moet die ondergrens veel kleiner: de vijf steden
  // van brok 1 liggen 26 eenheden uit elkaar, dus een kader van 100 propte ze
  // in een derde van het scherm en lagen de stippen tegen elkaar aan.
  const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
  const krap = s === 'stad';
  const minW = base.w * (krap ? 0.05 : 0.10), minH = base.h * (krap ? 0.06 : 0.12);
  if (x1 - x0 < minW) { x0 = cx - minW / 2; x1 = cx + minW / 2; }
  if (y1 - y0 < minH) { y0 = cy - minH / 2; y1 = cy + minH / 2; }
  return { x0, y0, x1, y1 };
}
function fitScope() { fitBounds(scopeBounds()); }
function screenScale() { return mapRect().width / view.w; } // px per wereldeenheid
function toWorld(clientX, clientY) {
  const r = mapRect();
  return [view.x + (clientX - r.left) / r.width * view.w,
          view.y + (clientY - r.top) / r.height * view.h];
}

// ---------------------------------------------------------------- pointer: pan / pinch / tap
const pointers = new Map();
let gesture = null;
function onDown(e) {
  el('map').setPointerCapture(e.pointerId);
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (pointers.size === 1) gesture = { moved: 0, sx: e.clientX, sy: e.clientY, t: Date.now() };
  else if (pointers.size === 2) gesture = { pinch: true };
}
function onMove(e) {
  const p = pointers.get(e.pointerId); if (!p) return;
  const px = p.x, py = p.y; p.x = e.clientX; p.y = e.clientY;
  if (pointers.size === 1 && gesture && !gesture.pinch) {
    const dx = e.clientX - px, dy = e.clientY - py;
    gesture.moved += Math.hypot(e.clientX - gesture.sx, e.clientY - gesture.sy) > MOVE_TOL ? 1 : 0;
    const s = screenScale();
    view.x -= dx / s; view.y -= dy / s; clampView(); applyView();
  } else if (pointers.size === 2) {
    const pts = [...pointers.values()];
    const r = mapRect();
    const mx = (pts[0].x + pts[1].x) / 2, my = (pts[0].y + pts[1].y) / 2;
    if (!gesture.d0) {
      // Anker eenmalig vastleggen: het wereldpunt onder het midden van de twee
      // vingers blijft het hele gebaar onder dat midden. Daardoor zoomt en
      // verschuift de kaart mee met de vingers in plaats van weg te drijven.
      gesture.d0 = Math.max(1, dist2(pts));
      gesture.w0 = view.w;
      const [wx, wy] = toWorld(mx, my);
      gesture.wx = wx; gesture.wy = wy;
      return;
    }
    view.w = gesture.w0 * (gesture.d0 / Math.max(1, dist2(pts)));
    view.h = view.w * aspect();
    view.x = gesture.wx - (mx - r.left) / r.width * view.w;
    view.y = gesture.wy - (my - r.top) / r.height * view.h;
    clampView(); applyView();
  }
}
function onUp(e) {
  const wasTap = pointers.size === 1 && gesture && !gesture.pinch && gesture.moved === 0 && (Date.now() - gesture.t) < 500;
  const cx = e.clientX, cy = e.clientY;
  pointers.delete(e.pointerId);
  if (pointers.size === 1 && gesture && gesture.pinch) {
    // Van twee vingers terug naar een: gewoon verder schuiven, zonder eerst
    // helemaal los te laten. moved:1 zodat dit nooit als tik op een land telt.
    const p = [...pointers.values()][0];
    gesture = { moved: 1, sx: p.x, sy: p.y, t: Date.now() };
  } else if (pointers.size < 2 && gesture) gesture.d0 = null;
  // Ook ná het antwoord blijft tikken zinvol: dan is het rondkijken.
  if (pointers.size === 0) { gesture = null; if (wasTap && (session || kijk)) handleTap(cx, cy); }
}
function dist2(pts) { return Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y); }

// ---------------------------------------------------------------- klikdetectie
function inCountry(pt, rings) {
  let inside = false;
  for (const r of rings)
    for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
      const xi = r[i][0], yi = r[i][1], xj = r[j][0], yj = r[j][1];
      if (((yi > pt[1]) !== (yj > pt[1])) && (pt[0] < (xj - xi) * (pt[1] - yi) / (yj - yi) + xi)) inside = !inside;
    }
  return inside;
}
function nearestQuiz(pt, pool) {
  let best = null, bd = Infinity;
  for (const k of pool) { const c = byName.get(k); const d = Math.hypot(pt[0] - c.cx, pt[1] - c.cy); if (d < bd) { bd = d; best = k; } }
  return { key: best, d: bd };
}

// ---------------------------------------------------------------- sessie
// Alles wat bij dit onderwerp hoort. "Door elkaar" is bewust geen "alles wat er
// is": dan zou ze zeeën voor haar kiezen krijgen terwijl ze aan landen bezig
// was. Het is "alles wat ze al begon", dus zij bepaalt wat er in de mengbak zit
// door een onderwerp een keer te openen.
function alleVan(s) {
  const all = MAP.countries.filter(c => c.quiz);
  if (s !== 'mix') return all.filter(c => c.soort === s);
  const begonnen = new Set(all.filter(c => {
    const it = state.items[c.name];
    return it && (it.seen || it.rseen);
  }).map(c => c.soort));
  if (!begonnen.size) begonnen.add('land');   // eerste keer ooit: begin bij landen
  // Hoofdsteden doen bewust NIET mee in de mengbak. Een gemengde sessie staat
  // uitgezoomd op de hele wereld, en daar liggen de stippen van de hoofdsteden
  // op elkaar - dan is de vraag niet eerlijk te beantwoorden. Ze horen per brok,
  // ingezoomd, en dat kan alleen als je ze apart oefent.
  begonnen.delete('stad');
  return all.filter(c => begonnen.has(c.soort));
}
function scopeKeys() {
  const s = soortNu();
  const all = alleVan(s);
  // Werelddeel en brok gelden alleen bij landen. Bij tien zeeën of negen
  // gebergtes valt er niets te selecteren, en bij "door elkaar" zou een
  // werelddeel de helft van de mengbak stiekem weggooien.
  if (s !== 'land' && s !== 'stad') return all.map(c => c.name);
  const sc = scopeVan(s);
  // Hoofdsteden zijn stippen van negen pixels. Zet je ze alle 168 op de
  // wereldkaart, dan liggen er 139 boven op de stip van een buurland en is de
  // vraag niet eerlijk te beantwoorden. Daarom altijd per brok - en zonder
  // gekozen brok geen sessie, in plaats van er stiekem alles van te maken.
  if (s === 'stad') return sc.values.length ? all.filter(c => sc.values.includes(c.brok)).map(c => c.name) : [];
  let f = all;
  if (sc.type === 'continent' && sc.values.length) f = all.filter(c => sc.values.includes(c.continent));
  else if (sc.type === 'brok' && sc.values.length) f = all.filter(c => sc.values.includes(c.brok));
  return f.map(c => c.name);
}
function shuffle(a) { a = a.slice(); for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; }

function startSession() {
  const pool = scopeKeys();
  if (!pool.length) {
    alert(soortNu() === 'stad'
      ? 'Kies eerst een brok. Hoofdsteden oefen je per brok, want alle 168 stippen tegelijk liggen op elkaar.'
      : 'Kies eerst een werelddeel of brok met landen erin.');
    return;
  }
  verfLagen();
  pool.forEach(ensureItem);
  const F = fields(modeNu());
  state.sessionCounter++;
  const now = state.sessionCounter;
  const due = pool.filter(k => state.items[k][F.seen] && state.items[k][F.due] <= now)
    .sort((a, b) => (state.items[a][F.due] - state.items[b][F.due]) || (state.items[a][F.box] - state.items[b][F.box]));
  const unseen = pool.filter(k => !state.items[k][F.seen]);
  const newItems = shuffle(unseen).slice(0, Math.min(state.settings.newPerSession, unseen.length));
  // Herhalingen en nieuwe landen vechten om dezelfde plekken in de sessie. Zet je
  // de nieuwe landen achteraan en knip je de rij af, dan sneuvelen ze allemaal
  // zodra er sessionLen herhalingen klaarstaan - en blijf je hangen in wat je al
  // kent. Dus eerst plek vrijhouden voor de nieuwe landen; de herhalingen vullen
  // de rest. Er gaat niets verloren: due staat op volgorde van urgentie, dus wat
  // nu niet meepast staat de volgende sessie vooraan.
  const nieuwe = newItems.slice(0, state.settings.sessionLen);
  const herhaal = due.slice(0, Math.max(0, state.settings.sessionLen - nieuwe.length));
  const queue = shuffle(herhaal.concat(nieuwe));
  if (!queue.length) {
    // niets te herhalen en niets nieuws (alles ken je al en nog niet toe aan herhaling)
    alert('Niets te herhalen op dit moment — alles wat je koos ken je al goed. Kies meer ' + noem(soortNu(), true) + ', of kom later terug.');
    state.sessionCounter--; return;
  }
  kijk = null;
  el('stopBtn').textContent = 'Stop';
  session = { queue, idx: 0, correct: 0, results: [], now, answered: false, home: null, mode: modeNu() };
  save();
  showQuiz();
  requestAnimationFrame(() => { fitScope(); session.home = { ...view }; nextQuestion(); });
}

function nextQuestion() {
  session.answered = false;
  el('tapdot').classList.add('hidden');
  el('nextBtn').classList.add('hidden');
  el('opts').classList.add('hidden');
  clearMarks();
  if (session.home) { view = { ...session.home }; applyView(); } // elke vraag vanaf hetzelfde beeld
  if (session.idx >= session.queue.length) { endSession(); return; }
  const key = session.queue[session.idx];
  const c = byName.get(key);
  el('qCount').textContent = (session.idx + 1) + ' / ' + session.queue.length;
  // Het woord in de vraag is niet hetzelfde als de naam van het onderwerp: een
  // zee heet in de vraag "water" (anders klopt de vraag niet bij een oceaan).
  // Het tweede getal zegt of het "het" of "de" is, want "Welk stad" leest fout.
  const [wat, hetWoord] = { land: ['land', 1], zee: ['water', 1], berg: ['gebergte', 1],
    stad: ['stad', 0], haven: ['haven', 0] }[c.soort] || ['ding', 1];
  if (c.soort === 'stad') {
    // Niet de stip licht op maar het land eromheen. Een stip van zeven pixels
    // oranje maken tussen vijf andere stippen leest slecht, en bij twee steden
    // die tegen elkaar aan liggen is niet te zien wélke oranje is. Het land is
    // altijd groot genoeg om aan te wijzen, en zo zie je meteen wáár het ligt.
    const land = byName.get(c.land);
    el('qText').innerHTML = 'Wat is de hoofdstad van dit <b>oranje</b> land?';
    // De stippen gaan uit zolang de vraag loopt. Er staat geen naam bij, dus ze
    // helpen je niet - vijf blauwe puntjes die niets doen leiden alleen af. Na
    // het antwoord komt de juiste stip groen terug; dan zie je alsnog waar hij
    // ligt, zonder dat het getoetst wordt.
    el('viewport').querySelectorAll('path.stadaan')
      .forEach(q => { q.classList.remove('stadaan'); q.classList.add('stad'); });
    const p = pathEl(c.land); if (p) p.classList.add('ask');
    // Ruimer inzoomen dan bij landen. Daar is 46 pixels genoeg omdat je de vorm
    // alleen hoeft te herkennen; hier is het land het aanknopingspunt voor een
    // stad, dus mag het groter staan dan een oranje vlekje in een leeg werelddeel.
    focusAsk(land, 110);
    buildOptions(key);
    el('fbMsg').innerHTML = 'Kies de juiste stad.';
  } else if (session.mode === 'reverse') {
    el('qText').innerHTML = 'Welk' + (hetWoord ? '' : 'e') + ' ' + wat + ' is <b>oranje</b>?';
    const p = pathEl(key); if (p) p.classList.add('ask');
    focusAsk(c);                      // land groot genoeg, met omgeving, in beeld
    buildOptions(key);
    el('fbMsg').innerHTML = 'Kies de juiste naam.';
  } else {
    el('qText').innerHTML = 'Waar ligt <b id="qName"></b>?';
    el('qName').textContent = c.nl;
    el('fbMsg').innerHTML = 'Tik op de kaart waar ' + (hetWoord ? 'dit ' : 'deze ') + wat + ' ligt.';
  }
}

// De foute keuzes moeten geloofwaardig zijn. Little & Bjork lieten zien dat
// meerkeuze pas net zoveel oplevert als zelf het antwoord produceren wanneer de
// andere opties serieuze kanshebbers zijn: je haalt dan ook op waarom die niet
// kloppen. "Chili of Noorwegen" kun je raden zonder te kijken; "Chili of
// Argentinie of Peru" dwingt je de kaart te lezen.
function distractors(key, n) {
  const c = byName.get(key);
  // Alleen dezelfde soort. Bij "Welke zee is oranje?" horen er geen landen
  // tussen de keuzes: dan is het geen keuze meer maar een weggevertje.
  const pool = MAP.countries.filter(x => x.quiz && x.name !== key && x.soort === c.soort);
  const sameBrok = shuffle(pool.filter(x => x.brok === c.brok));
  const nearest = pool.filter(x => x.brok !== c.brok)
    .sort((a, b) => Math.hypot(a.cx - c.cx, a.cy - c.cy) - Math.hypot(b.cx - c.cx, b.cy - c.cy));
  return sameBrok.concat(nearest).slice(0, n).map(x => x.name);
}

function buildOptions(key) {
  const box = el('opts');
  box.innerHTML = '';
  for (const name of shuffle([key].concat(distractors(key, 3)))) {
    const b = document.createElement('button');
    b.textContent = byName.get(name).nl;
    b.onclick = () => answerReverse(name, key, b);
    box.appendChild(b);
  }
  box.classList.remove('hidden');
}

function answerReverse(chosen, key, btn) {
  if (session.answered) return;
  session.answered = true;
  const correct = chosen === key;
  recordResult(key, correct);
  const target = byName.get(key);
  el('opts').querySelectorAll('button').forEach(b => {
    b.disabled = true;
    if (b.textContent === target.nl) b.classList.add('good');
  });
  if (!correct) btn.classList.add('bad');
  // De vraag ging over het land, maar waar de stad ligt is ook het kijken
  // waard. Hij wordt daarom pas ná het antwoord groen: wél te zien, niet
  // getoetst.
  if (target.soort === 'stad') {
    const p = pathEl(key);
    if (p) { p.classList.remove('stad'); p.classList.add('stadaan', 'target'); }
  }
  el('fbMsg').innerHTML = correct
    ? '<span class="ok">Goed.</span> ' + target.nl + ' — ' + plek(target) + '.'
    : '<span class="no">Mis.</span> Niet ' + byName.get(chosen).nl + ' maar ' + target.nl + ' — ' + plek(target) + '.';
  el('nextBtn').classList.remove('hidden');
}

function recordResult(key, correct) {
  const F = fields(session.mode);
  const it = state.items[key];
  it[F.seen] = true;
  if (correct) {
    it[F.ok]++; it[F.box] = Math.min((it[F.box] || 0) + 1, MAX_BOX);
    it[F.due] = session.now + INTERVALS[it[F.box]]; session.correct++;
  } else { it[F.no]++; it[F.box] = 1; it[F.due] = session.now + 1; }
  session.results.push({ key, correct });
  el('peekMsg').textContent = 'Tik een land aan om te zien hoe het heet.';
  zetMeerKnop(byName.get(key));
  save();
}

const esc = s => String(s).replace(/[&<>]/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[m]));

// "A, B en C" leest als een zin; "A, B, C" leest als een lijstje. Voor de
// brokleden willen we het eerste, want het staat middenin een zin.
const opsomming = a => a.length < 2 ? (a[0] || '') : a.slice(0, -1).join(', ') + ' en ' + a[a.length - 1];

// Wat er niet is, laten we weg in plaats van een leeg kopje te tonen.
function meerRegels(c) {
  const d = INFO[c.name] || {};
  const brok = MAP.brokken.find(b => b.n === c.brok);
  const r = [];
  // Bij een zee of gebergte is "waar het ligt" het halve leerdoel, dus dat staat
  // bovenaan. Bij een land wordt het verderop uitgerekend uit de kaart zelf.
  if (c.waar) r.push('<p><b>Waar.</b> ' + esc(c.waar[0].toUpperCase() + c.waar.slice(1)) + '.</p>');
  if (d.naam)  r.push('<p><b>De naam.</b> ' + esc(d.naam) + '</p>');
  // De ankerzin gaat over de brok, niet over dit ene land. Noem de brok dus bij
  // naam en som de andere leden op. Stond er alleen "waarom deze landen bij
  // elkaar staan", dan wees "deze landen" nergens naar en las je het als de
  // buurlanden eronder -- en dat is een andere verzameling. Bij Niger scheelt
  // dat de helft.
  if (brok && brok.anker) {
    const anderen = brok.landen.filter(nl => nl !== c.nl).map(esc);
    r.push('<p><b>Hoort bij brok ' + brok.n + ', ' + esc(brok.naam) + '.</b>' +
      (anderen.length ? ' Samen met ' + opsomming(anderen) + '.' : '') +
      ' ' + esc(brok.anker) + '.</p>');
  }
  if (c.buren && c.buren.length)
    r.push('<p><b>Buurlanden.</b> ' + c.buren.map(esc).join(', ') + '.</p>');
  else if (c.buren)
    r.push('<p><b>Buurlanden.</b> Geen: dit land grenst nergens aan land.</p>');
  if (d.overzee) r.push('<p><b>Hoort er ook bij.</b> ' + esc(d.overzee) + '</p>');
  if (d.taal)  r.push('<p><b>Taal.</b> ' + esc(d.taal) + '</p>');
  if (d.feit)  r.push('<p>' + esc(d.feit) + '</p>');
  // De noot bij een hoofdstad staat in de kaartdata zelf (Sucre of La Paz,
  // Amsterdam of Den Haag), niet in land-info.json - die is met de hand
  // geschreven en dit wordt gebouwd.
  const bron = d.bron || c.bron;
  if (bron)    r.push('<p class="bron">' + esc(bron) + '</p>');
  return r;
}

// Titel en tekst horen bij hetzelfde land en worden altijd samen gezet, zodat
// er nooit een kop boven de tekst van een ander land kan blijven staan.
function vulSheet(c) {
  el('sheetTitel').textContent = 'Meer over ' + c.nl;
  el('sheetBody').innerHTML = meerRegels(c).join('');
  el('sheetBody').scrollTop = 0;
}
function openSheet(c) {
  vulSheet(c);
  el('sheet').classList.remove('hidden');
  document.body.classList.add('paneel');
  schuifOnderPaneel(c);
}
function sluitSheet() {
  el('sheet').classList.add('hidden');
  document.body.classList.remove('paneel');
}
function sheetOpen() { return !el('sheet').classList.contains('hidden'); }

// Het paneel dekt de onderkant af. Schuif de kaart zo dat het land in de strook
// komt die vrij blijft: anders lees je over buurlanden die achter het paneel
// liggen.
function vrijeHoogte() {
  const r = mapRect(), sh = el('sheet').getBoundingClientRect();
  return Math.max(0, Math.min(r.bottom, sh.top) - r.top);
}
// Schuiven alleen is niet genoeg. Bij landen onderaan de wereldkaart, zoals
// Nieuw-Zeeland of Chili, houdt clampView de kaart tegen aan de rand: het land
// blijft dan achter het paneel steken. Daarom na elke schuif nameten en zo
// nodig verder inzoomen, want ingezoomd is er wel schuifruimte.
function schuifOnderPaneel(c) {
  const vrij = vrijeHoogte();
  if (vrij < 60) return;
  for (let i = 0; i < 12; i++) {
    const r = mapRect();
    const nu = r.top + (c.cy - view.y) / view.h * r.height;
    view.y += (nu - (r.top + vrij / 2)) / r.height * view.h;
    clampView(); applyView();
    const na = r.top + (c.cy - view.y) / view.h * r.height;
    if (na > r.top && na < r.top + vrij) return;
    const w = view.w;
    zoomAt(c.cx, c.cy, 0.85);
    if (view.w === w) return;   // zoomgrens bereikt, verder kan niet
  }
}

// De aanzet onder de melding: één regel, geen tekst. Pas na een tik lees je.
function zetMeerKnop(c) {
  const b = el('meerBtn');
  if (!meerRegels(c).length) { b.classList.add('hidden'); return; }
  b.textContent = 'Meer over ' + c.nl;
  b.onclick = () => openSheet(c);
  b.classList.remove('hidden');
}

// Buiten de oefening om: een land opzoeken en lezen zonder overhoord te worden.
function toonLand(key) {
  const c = byName.get(key);
  kijk = key; session = null;
  showQuiz();
  el('opts').classList.add('hidden');
  el('nextBtn').classList.add('hidden');
  el('meerBtn').classList.add('hidden');
  el('tapdot').classList.add('hidden');
  el('qCount').textContent = '';
  el('qText').innerHTML = 'Opzoeken: <b>' + esc(c.nl) + '</b>';
  el('stopBtn').textContent = 'Terug';
  el('fbMsg').innerHTML = c.nl + ligtIn(c) + '.';
  clearMarks();
  requestAnimationFrame(() => {
    focusAsk(c);
    const p = pathEl(key); if (p) p.classList.add('peek');
    el('peekMsg').textContent = 'Tik een land aan om te zien hoe het heet.';
    openSheet(c);
    // Bij opzoeken valt er niets te raden, dus het land mag ruimer in beeld dan
    // in de oefening. Maat: ruim een kwart van de strook die het paneel vrijlaat.
    focusAsk(c, Math.min(mapRect().width, vrijeHoogte()) * 0.3);
    schuifOnderPaneel(c);
  });
}

function buildZoek() {
  const t = el('zoek').value.trim().toLowerCase();
  const box = el('zoekLijst');
  box.innerHTML = '';
  const treffers = MAP.countries.filter(c => c.quiz && c.nl.toLowerCase().includes(t));
  // Luxemburg en Djibouti heten allebei net zo als hun land. Twee gelijke chips
  // naast elkaar waarvan je niet weet welke welke is, is geen zoeklijst. Alleen
  // bij die botsing komt het soort erachter, anders blijft de lijst rustig.
  const dubbel = new Set();
  const gezien = new Set();
  treffers.forEach(c => { if (gezien.has(c.nl)) dubbel.add(c.nl); gezien.add(c.nl); });
  treffers.sort((a, b) => a.nl.localeCompare(b.nl, 'nl'))
    .forEach(c => box.appendChild(chip(
      c.nl + (dubbel.has(c.nl) ? ' (' + noem(c.soort) + ')' : ''),
      false, () => toonLand(c.name))));
}

// Welk land ligt onder dit punt? Eerst echt raak, anders het dichtstbijzijnde
// land binnen tikafstand (kleine landen zijn met een vinger niet te raken).
function countryAt(pt) {
  // Gaat het over hoofdsteden, dan wint een stip vlakbij van het land eronder:
  // daar gaat de vraag over, en anders zou rondkijken na het antwoord altijd
  // "Nederland" zeggen waar ze "Amsterdam" wil lezen.
  // Alleen de stippen die op dat moment ook echt gekleurd op de kaart staan.
  // Anders tik je op een leeg stuk kaart en leest er de naam van een hoofdstad
  // die daar helemaal niet te zien is.
  const s = soortNu();
  if (s === 'stad') {
    const zichtbaar = scopeKeys().filter(k => {
      const p = pathEl(k); return p && p.classList.contains('stadaan');
    });
    const stip = nearestQuiz(pt, zichtbaar);
    if (stip.key && stip.d <= MIN_TAP_PX / screenScale()) return stip.key;
  }
  // Landen staan vóór de zeeën en gebergtes in de lijst, dus bij overlap wint
  // het land - precies wat je wilt als je op Italië tikt en de Middellandse Zee
  // er met zijn rand overheen ligt.
  for (const k of quizPolys.keys()) if (inCountry(pt, quizPolys.get(k))) return k;
  // Het vangnet voor mini-landjes kijkt alleen naar landen. Zou een oceaan
  // meedoen, dan zou een misser vlak naast Malta "Middellandse Zee" opleveren,
  // want het middelpunt van een zee ligt altijd wel ergens in de buurt.
  const near = nearestQuiz(pt, [...quizPolys.keys()].filter(k => byName.get(k).soort === 'land'));
  return near.key && near.d <= MIN_TAP_PX / screenScale() ? near.key : null;
}

// Na het antwoord mag je rondkijken: tik een buurland aan en je ziet hoe het
// heet. Een naam die je ophaalt naast een land dat je net leerde, hangt aan
// iets vast; een los rijtje hangt nergens aan.
function peek(pt) {
  const k = countryAt(pt);
  el('viewport').querySelectorAll('.peek').forEach(p => p.classList.remove('peek'));
  if (!k) { el('peekMsg').textContent = ''; return; }
  const c = byName.get(k);
  const p = pathEl(k); if (p) p.classList.add('peek');
  el('peekMsg').textContent = c.nl + ' · ' + plek(c);
  // Staat het paneel open, dan gaat het mee met wat je aantikt. Zo hoort de kop
  // altijd bij de tekst en kun je van buurland naar buurland doorlezen.
  if (sheetOpen()) vulSheet(c);
}

function handleTap(clientX, clientY) {
  if (kijk) { peek(toWorld(clientX, clientY)); return; }
  if (session.answered) { peek(toWorld(clientX, clientY)); return; }
  if (session.mode !== 'point') return;   // bij 'Omgekeerd' antwoord je met de knoppen
  const key = session.queue[session.idx];
  const target = byName.get(key);
  const pt = toWorld(clientX, clientY);
  const rings = quizPolys.get(key);
  const effR = Math.max(target.r, MIN_TAP_PX / screenScale());
  const near = nearestQuiz(pt, scopeKeys());
  // Een hoofdstad heeft geen oppervlak: parsePath maakt van een pad zonder
  // lengte geen ring, dus inCountry zegt altijd nee en alleen de tweede helft
  // telt. Daar staat dan precies de regel die je wilt: binnen tikafstand én
  // dichter bij deze hoofdstad dan bij elke andere in de brok.
  const correct = inCountry(pt, rings) ||
    (Math.hypot(pt[0] - target.cx, pt[1] - target.cy) <= effR && near.key === key);

  session.answered = true;
  recordResult(key, correct);

  // markeren
  const tp = pathEl(key); if (tp) tp.classList.add('target');
  const dot = el('tapdot'); dot.setAttribute('cx', pt[0]); dot.setAttribute('cy', pt[1]);
  dot.setAttribute('r', 9 / screenScale()); dot.classList.remove('hidden');
  if (correct) {
    el('fbMsg').innerHTML = '<span class="ok">Goed.</span> ' + target.nl + ' — ' + plek(target) + '.';
  } else {
    let hit = '';
    // wat tikte ze aan?
    let hitKey = null;
    for (const k of quizPolys.keys()) if (inCountry(pt, quizPolys.get(k))) { hitKey = k; break; }
    if (!hitKey && near.d <= effR) hitKey = near.key;
    if (hitKey && hitKey !== key) hit = ' Je wees ' + byName.get(hitKey).nl + ' aan.';
    const merk = target.soort === 'stad' ? 'de groene stip' : 'groen omlijnd';
    el('fbMsg').innerHTML = '<span class="no">Mis.</span> ' + target.nl + ' ligt hier (' + merk + '): ' + plek(target) + '.' + hit;
    // zoom licht naar het juiste land toe zodat ze het ziet
    focusOn(target, pt);
  }
  el('nextBtn').classList.remove('hidden');
}

// Het kader waar de app naartoe zoomt is het KERN-kader uit de kaartbouwer: het
// hoofdland met alles wat eraan vastligt, zonder de overzeese gebieden. Zouden
// we alle stukken meetellen, dan werd Nederland een gebied van Groningen tot
// Bonaire en zoomde de app uit naar de halve wereld.
function boundsOf(name) {
  const [x0, y0, x1, y1] = byName.get(name).bb;
  return { x0, y0, x1, y1 };
}
function showPx(b) { // hoe groot staat dit land nu op het scherm, in pixels
  const r = mapRect();
  return Math.max((b.x1 - b.x0) / view.w * r.width, (b.y1 - b.y0) / view.h * r.height);
}

function focusOn(c, tap) {
  // Na een fout antwoord moet het juiste land ALTIJD in beeld komen, met de buren
  // eromheen. Ook als ze ver ingezoomd op een heel ander werelddeel zat; dan is
  // uitzoomen nodig. Het kader volgt de echte vorm van het land, zodat een lang
  // en smal land als Chili niet in een veel te ruim vierkant verdwijnt.
  const { x0, y0, x1, y1 } = boundsOf(c.name);
  // Marge op basis van het land zelf, zodat de omgeving even ruim blijft
  // ongeacht hoe ver ze ernaast zat. Maar een hoofdstad is een punt, en dan
  // klopt die formule niet meer: hij telt een vaste ruimte OP bij de eigen
  // omvang, dus bij omvang nul blijft er een kader over van bijna heel Europa.
  // Voor stippen daarom een vast kader, even groot als het overzicht van een
  // brok, zodat de stippen bij elke vraag even ver uit elkaar staan.
  const stip = c.soort === 'stad';
  const m = stip ? base.w * 0.025
                 : Math.max(x1 - x0, y1 - y0) * 0.8 + base.w * 0.03;
  const box = stip
    ? { x0: c.cx - m, y0: c.cy - m, x1: c.cx + m, y1: c.cy + m }
    : { x0: x0 - m, y0: y0 - m, x1: x1 + m, y1: y1 + m };
  if (tap) {
    // Ook het aangewezen punt in beeld, zodat ze in een oogopslag ziet hoe ver
    // ernaast het zat. Maar niet ten koste van alles: als het juiste land
    // daardoor een groen streepje van niks wordt, gaat het antwoord voor.
    const p = base.w * 0.02;
    fitBounds({ x0: Math.min(box.x0, tap[0] - p), y0: Math.min(box.y0, tap[1] - p),
                x1: Math.max(box.x1, tap[0] + p), y1: Math.max(box.y1, tap[1] + p) }, 0.12);
    if (showPx({ x0, y0, x1, y1 }) >= MIN_SHOW_PX) return;
  }
  fitBounds(box, 0.12);
}

// Bij 'Omgekeerd' moet je kunnen ZIEN welk land oplicht. Met de gewone marge
// haalt Luxemburg zo'n twaalf pixels: dat is een stipje, geen vraag. Daarom
// zoomen we door tot het herkenbaar groot staat. Verder inzoomen dan de app
// toestaat kan niet, dus voor de allerkleinste landen blijft het krap.
function focusAsk(c, minPx) {
  focusOn(c);
  // Een stip is op het scherm altijd even groot, hoe ver je ook inzoomt.
  // Doorzoomen tot hij "groot genoeg" staat lukt dus nooit en eindigt altijd
  // tegen de zoomgrens. Het vaste kader hierboven is al wat we willen.
  if (c.soort === 'stad') return;
  const b = boundsOf(c.name);
  const mid = [(b.x0 + b.x1) / 2, (b.y0 + b.y1) / 2];
  const doel = minPx || ASK_MIN_PX;
  for (let i = 0; i < 12 && showPx(b) < doel; i++) {
    const w = view.w;
    zoomAt(mid[0], mid[1], 0.8);
    if (view.w === w) break;   // zoomgrens bereikt
  }
}

// Het leerplan gooit Amerika en Oceanie op een hoop. Voor een zin als "in het
// westen van ..." is dat onbruikbaar: die hoop beslaat 788 van de 1000
// kaarteenheden, bijna de hele wereld. Alleen voor de omschrijving splitsen we
// hem daarom naar de regio's zoals ze werkelijk liggen. De brokindeling van het
// leerplan blijft ongemoeid.
const REGIO = { 27: 'Noord- en Midden-Amerika', 28: 'Noord- en Midden-Amerika',
                29: 'Noord- en Midden-Amerika', 30: 'Zuid-Amerika',
                31: 'Zuid-Amerika', 32: 'Oceanië' };
const regioVan = c => REGIO[c.brok] || c.continent;

// Waar ligt dit land binnen zijn regio? Gemeten aan een kader om de regio, maar
// de buitenste vijf procent valt buiten dat kader. Zonder die trim rekt een
// uitschieter als Rusland het kader in zijn eentje op en schuift alles wat er
// binnen ligt naar het westen; Rusland zelf valt er nu buiten en krijgt gewoon
// 'oost', wat klopt. Tellen hoeveel landen er westelijker liggen werkt niet:
// Afrika heeft veel landen in het westen opeengepakt, waardoor Tanzania dan in
// 'de zuidoosthoek' belandt in plaats van in het oosten.
function ligging(c) {
  const regio = regioVan(c);
  const groep = MAP.countries.filter(x => x.quiz && x.soort === 'land' && regioVan(x) === regio);
  if (groep.length < 6) return regio;            // te klein om richtingen zinvol te maken
  const deel = f => {
    const v = groep.map(f).sort((a, b) => a - b), i = Math.floor(v.length * 0.05);
    const a = v[i], b = v[v.length - 1 - i];
    return Math.min(1, Math.max(0, (f(c) - a) / (b - a)));
  };
  const nz = deel(x => x.cy), wo = deel(x => x.cx);
  const ns = nz < 0.25 ? 'noord' : nz > 0.75 ? 'zuid' : '';
  const we = wo < 0.25 ? 'west' : wo > 0.75 ? 'oost' : '';
  if (ns && we) return 'de ' + ns + we + 'hoek van ' + regio;
  if (ns) return 'het ' + ns + 'en van ' + regio;
  if (we) return 'het ' + we + 'en van ' + regio;
  return 'het midden van ' + regio;
}
// Bij een land rekenen we de ligging uit ("het westen van Europa"). Bij een zee
// of een gebergte staat er een handgeschreven zin in de data ("tussen Nederland,
// België en Engeland") - bruikbaarder dan een uitgerekende windrichting, want
// een oceaan ligt niet in een werelddeel.
function plek(c) {
  if (c.waar) return c.waar;
  return ligging(c) + ', brok ' + c.brok + ' (' + c.broknaam + ')';
}
// Voor zinnen die met "ligt" beginnen. Een land ligt ÍN iets, een zee ligt
// TUSSEN iets - dat voorzetsel zit al in de handgeschreven zin. Een stad ligt
// nergens in: die IS de hoofdstad van een land.
function ligtIn(c) {
  if (c.soort === 'stad') return ' is ' + c.waar;
  return c.waar ? ' ligt ' + c.waar : ' ligt in ' + plek(c);
}

function clearMarks() {
  el('viewport').querySelectorAll('.target,.wrong,.ask,.peek')
    .forEach(p => p.classList.remove('target', 'wrong', 'ask', 'peek'));
  el('peekMsg').textContent = '';
  el('meerBtn').classList.add('hidden');
  sluitSheet();
}

function endSession() {
  sluitSheet();
  showEnd();
  el('endScore').textContent = session.correct + '/' + session.queue.length;
  el('endWhat').textContent = soortNu() === 'stad' ? 'goed benoemd'
    : session.mode === 'reverse' ? 'goed herkend' : 'goed aangewezen';
  const rows = session.results.map(r => {
    const c = byName.get(r.key);
    return `<div class="er"><span>${c.nl}</span><span>${r.correct ? '✓' : '✗'}</span></div>`;
  }).join('');
  el('endlist').innerHTML = rows;
  session = null;
}

// ---------------------------------------------------------------- menu / scope UI
function buildScopeUI() {
  const s = soortNu();
  const sc = scopeVan(s);
  const m = state.settings.mode;
  el('soortSeg').querySelectorAll('button').forEach(b => b.classList.toggle('on', b.dataset.s === s));
  el('soortInfo').textContent = soortUitleg(s);
  // Tien zeeën of negen gebergtes: daar valt geen werelddeel in te kiezen, dus
  // die kaart gaat weg in plaats van er nutteloos te staan. Bij hoofdsteden
  // blijft hij staan maar zonder de knoppen Alles / Werelddeel: die zouden zo
  // ver uitzoomen dat de stippen op elkaar liggen.
  el('scopeCard').classList.toggle('hidden', s !== 'land' && s !== 'stad');
  el('scopeSeg').classList.toggle('hidden', s === 'stad');
  verfLagen();
  // Bij hoofdsteden valt er geen oefening te kiezen: er is er maar één die
  // eerlijk is. Die kaart gaat dus weg in plaats van een keuze voor te spiegelen
  // die niets doet. De uitleg staat bij "Wat oefen je?".
  el('modeCard').classList.toggle('hidden', s === 'stad');
  el('modeSeg').querySelectorAll('button').forEach(b => b.classList.toggle('on', b.dataset.m === m));
  el('modeInfo').textContent = m === 'reverse'
    ? 'De kaart licht een land op, jij kiest de naam uit vier. De foute keuzes zijn buren of landen uit dezelfde brok, dus goed kijken loont. Elke stand houdt zijn eigen voortgang bij.'
    : 'Je krijgt een naam en wijst de plek aan op de kaart.';
  el('scopeSeg').querySelectorAll('button').forEach(b => b.classList.toggle('on', b.dataset.t === sc.type));
  const box = el('scopeList'); box.innerHTML = '';
  if (sc.type === 'all') { box.classList.add('hidden'); }
  else {
    box.classList.remove('hidden');
    if (sc.type === 'continent') {
      MAP.continenten.forEach(name => box.appendChild(chip(name, sc.values.includes(name), () => toggleScope(name))));
    } else {
      MAP.brokken.filter(b => b.soort === 'land')
        .forEach(b => box.appendChild(chip(b.n + '. ' + b.naam, sc.values.includes(b.n), () => toggleScope(b.n))));
    }
  }
  scopeHint();
  brokUitleg();
  updateProgress();
}

// Bij zeeën en gebergtes is de "Welke landen?"-kaart weg, en daarmee ook de
// plek waar de ankerzin van de brok stond. Die zin is juist het aangrijppunt
// waarom die dingen bij elkaar horen, dus hij verhuist hierheen.
function soortUitleg(s) {
  const n = alleVan(s).length;
  if (s === 'land') return 'De ' + n + ' landen van je leerplan, verdeeld over 32 brokken.';
  if (s === 'mix') {
    const soorten = [...new Set(alleVan('mix').map(c => c.soort))].map(x => noem(x, true));
    return n + ' door elkaar: ' + opsomming(soorten) + '. Alleen wat je al eens ' +
      'begon telt mee — open een onderwerp één keer en het schuift vanzelf aan. ' +
      'Een werelddeel kiezen kan hier niet: dat zou de helft van de mengbak weggooien.';
  }
  if (s === 'stad') {
    const gekozen = scopeVan('stad').values.length;
    return n + ' hoofdsteden, één per land, in de brok van hun eigen land. ' +
      'Er licht steeds een land op en jij kiest de stad die erbij hoort; ' +
      'na je antwoord zie je als groene stip waar hij ligt. ' +
      'Aanwijzen op de kaart zit er niet bij: sommige hoofdsteden liggen zo ' +
      'dicht bij een buurland (Kinshasa en Brazzaville, Jeruzalem en Ramallah) ' +
      'dat het gokken zou worden. ' +
      'Het gaat per brok, en om dezelfde reden doen hoofdsteden niet mee in "Door elkaar". ' +
      (gekozen ? '' : 'Kies hieronder een brok om te beginnen.');
  }
  const b = MAP.brokken.find(x => x.soort === s);
  return n + ' ' + noem(s, true) + '.' + (b && b.anker ? ' ' + b.anker + '.' : '');
}

// De ankerzin hoort bij de brok, niet bij één land. Hier kies je je brok, dus
// hier hoort hij ook: eerst zien wat een groepje is en waarom het bij elkaar
// hoort, en dan pas oefenen. Zonder dit koos je een nummer met een naam en
// kreeg je de uitleg pas ná je eerste antwoord, verstopt bij één land.
function brokUitleg() {
  const box = el('brokUitleg'), sc = scopeVan();
  if (sc.type !== 'brok') { box.innerHTML = ''; return; }
  const gekozen = MAP.brokken.filter(b => sc.values.includes(b.n));
  if (!gekozen.length) {
    box.innerHTML = '<p class="tiny" style="margin:0;">Tik een brok aan: ' +
      'je ziet dan welke landen erin zitten en waarom ze bij elkaar horen.</p>';
    return;
  }
  box.innerHTML = gekozen.map(b =>
    '<div class="bu"><b>' + b.n + '. ' + esc(b.naam) + '</b>' +
    '<div class="landen">' + b.landen.map(esc).join(', ') + '</div>' +
    '<div class="waarom">' + esc(b.anker) + '.</div></div>').join('');
}

// Welke brokken heb je in deze stand al aangeraakt? Alleen die kun je zinvol
// door elkaar oefenen; een brok die je nog nooit zag valt er niets aan te halen.
function startedBroks() {
  const F = fields(modeNu());
  const s = new Set();
  for (const c of alleVan(soortNu()))
    if (state.items[c.name] && state.items[c.name][F.seen]) s.add(c.brok);
  return [...s].sort((a, b) => a - b);
}

// Eén brok tegelijk oefenen voelt fijn: het gaat vlot en je hebt het snel goed.
// Maar dat vlotte gevoel komt doordat je binnen die brok niet hoeft te kiezen.
// Door elkaar oefenen voelt trager en rommeliger, en blijft juist beter hangen.
// De app kon dat al (meerdere brokken aantikken), maar zei het nergens.
function scopeHint() {
  const sc = scopeVan();
  const info = el('scopeInfo'), mix = el('mixBtn');
  mix.classList.add('hidden');
  if (sc.type === 'all') {
    info.textContent = 'Alle ' + alleVan('land').length +
      ' landen door elkaar. Je krijgt vanzelf eerst terug wat aan herhaling toe is.';
    return;
  }
  if (sc.type === 'continent') {
    info.textContent = 'Tik een of meer werelddelen aan. Dit is de indeling van je leerplan, ' +
      'dus Amerika en Oceanië staan samen.';
    return;
  }
  info.textContent = (soortNu() === 'stad'
      ? 'Hoofdsteden gaan per brok, want alle 168 stippen tegelijk op de wereldkaart ' +
        'liggen op elkaar. Kies de brok waarvan je de landen al kent. '
      : '') +
    'Je kunt meerdere brokken tegelijk aantikken. Dat voelt trager en ' +
    'rommeliger dan brok voor brok, en dat is precies waarom het beter blijft hangen: ' +
    'je moet elke keer opnieuw kiezen uit alles wat je kent.';
  const gestart = startedBroks();
  if (gestart.length >= 2 && gestart.some(n => !sc.values.includes(n))) {
    mix.textContent = 'Alle ' + gestart.length + ' brokken erbij die je al begon';
    mix.classList.remove('hidden');
    mix.onclick = () => {
      scopeVan().values = [...new Set(sc.values.concat(gestart))].sort((a, b) => a - b);
      save(); buildScopeUI();
    };
  }
}

function chip(label, on, fn) {
  const b = document.createElement('button');
  b.className = 'chip' + (on ? ' on' : ''); b.textContent = label;
  b.onclick = () => { fn(); };
  return b;
}
function toggleScope(v) {
  const vals = scopeVan().values;
  const i = vals.indexOf(v); if (i >= 0) vals.splice(i, 1); else vals.push(v);
  save(); buildScopeUI();
}
function setScopeType(t) {
  state.settings.scope = { type: t, values: [] }; save(); buildScopeUI();
}

function updateProgress() {
  const keys = scopeKeys();
  const F = fields(modeNu());
  // Drie categorieen, meer bestaan er niet: na een antwoord staat een land altijd
  // in bakje 1 t/m MAX_BOX, dus "wel gezien maar nog in bakje 0" kan niet voorkomen.
  let leren = 0, kent = 0, nietGehad = 0;
  for (const k of keys) {
    const it = state.items[k];
    if (!it || !it[F.seen]) nietGehad++;
    else if (it[F.box] >= 4) kent++;
    else leren++;
  }
  const total = keys.length || 1;
  const seg = (n, col) => n ? `<span style="width:${(n / total * 100).toFixed(1)}%;background:${col}"></span>` : '';
  // #d5dcdc moet donkerder zijn dan de baan waar de balk in ligt (#f6f9f9 in
  // index.html), anders valt "nog niet gehad" weg tegen de achtergrond en lijkt
  // de balk leeg terwijl hij bijna vol staat.
  el('progBar').innerHTML = seg(kent, '#7bc98a') + seg(leren, '#f0b46b') + seg(nietGehad, '#d5dcdc');
  const s = soortNu();
  // Bij "door elkaar" telt de balk verschillende dingen bij elkaar op. Dat mag
  // niet verstopt worden: dan lees je "20 van de 30" en denk je dat het over
  // landen gaat. Dus staat er letterlijk waaruit de optelsom bestaat.
  const wat = s === 'mix'
    ? opsomming([...new Set(keys.map(k => byName.get(k).soort))].map(x => noem(x, true))) + ' bij elkaar'
    : noem(s, true) + ' in deze selectie';
  el('progText').innerHTML = `<b class="num">${kent}</b> ken je · <b class="num">${leren}</b> aan het leren · <b class="num">${nietGehad}</b> nog niet gehad · <span class="num">${keys.length}</span> ${wat}.`;
  const sc = scopeVan();
  const waar = s === 'mix' ? 'door elkaar'
    : (s === 'zee' || s === 'berg') ? 'alle ' + noem(s, true)
    : sc.type === 'all' ? 'alle landen'
    : sc.type === 'continent' ? (sc.values.join(', ') || 'kies werelddeel')
    : ('brok ' + (sc.values.join(', ') || '—'));
  el('scopeName').textContent = '(' + (s === 'stad' ? 'naam kiezen'
    : modeNu() === 'reverse' ? 'omgekeerd' : 'aanwijzen') + ' · ' + waar + ')';
  const due = keys.filter(k => state.items[k] && state.items[k][F.seen] && state.items[k][F.due] <= state.sessionCounter + 1).length;
  const unseen = keys.filter(k => !state.items[k] || !state.items[k][F.seen]).length;
  // Precies dezelfde verdeling als startSession maakt, anders belooft dit scherm
  // iets wat je niet krijgt.
  const nieuwN = Math.min(state.settings.newPerSession, unseen, state.settings.sessionLen);
  const herhaalN = Math.min(due, Math.max(0, state.settings.sessionLen - nieuwN));
  const wacht = due - herhaalN;
  const nw = noemN(s, nieuwN);
  const hh = `<b>${herhaalN}</b> ` + (herhaalN === 1 ? 'herhaling' : 'herhalingen');
  el('startInfo').innerHTML = `Volgende sessie: ${nw} en ${hh}.` +
    (wacht ? ` Nog <b>${wacht}</b> ` + (wacht === 1 ? 'herhaling wacht' : 'herhalingen wachten') +
      ' op een volgende keer.' : '');
}

// ---------------------------------------------------------------- schermen
function showMenu() { kijk = null; sluitSheet(); updateProgress(); toggle('menu'); }
function showQuiz() { toggle('quiz'); }
function showEnd() { toggle('end'); }
function toggle(id) { ['menu', 'quiz', 'end'].forEach(s => el(s).classList.toggle('hidden', s !== id)); }
function resetView() {
  if (kijk) { focusAsk(byName.get(kijk)); if (sheetOpen()) schuifOnderPaneel(byName.get(kijk)); return; }
  if (session && session.home) { view = { ...session.home }; applyView(); } else fitScope();
}

// ---------------------------------------------------------------- export / import
function doExport() {
  const blob = new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  const d = new Date().toISOString().slice(0, 10);
  a.href = url; a.download = 'topografie-voortgang-' + d + '.json';
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function doImport(file) {
  const rd = new FileReader();
  rd.onload = () => {
    try {
      const obj = JSON.parse(rd.result);
      if (!obj || typeof obj !== 'object' || !obj.items) throw 0;
      if (!confirm('Voortgang uit dit bestand overnemen? Je huidige voortgang op dit toestel wordt vervangen.')) return;
      state = obj; if (!state.settings) state.settings = defaultState().settings;
      save(); buildScopeUI(); alert('Voortgang geïmporteerd.');
    } catch (e) { alert('Dat bestand kon ik niet lezen. Kies een eerder geëxporteerd voortgang-bestand.'); }
  };
  rd.readAsText(file);
}

// ---------------------------------------------------------------- events
function bindEvents() {
  const map = el('map');
  // Het kaartvak verandert van vorm zodra de antwoordknoppen verschijnen, en
  // ook als je de telefoon draait. De view onthoudt dan nog de oude verhouding
  // en de kaart wordt in een brievenbus geperst: je ziet meer dan de bedoeling
  // was en een tik landt naast waar je hem zet. Daarom hier opnieuw meten.
  if (window.ResizeObserver) {
    let vorige = 0;
    new ResizeObserver(() => {
      const r = map.getBoundingClientRect();
      if (!r.width || !r.height || !view.w) return;
      const nu = r.height / r.width;
      if (Math.abs(nu - vorige) < 0.002) return;
      vorige = nu;
      // Om het midden van het beeld heen herrekenen, anders schuift alles
      // omhoog zodra het vak lager wordt.
      const mid = view.y + view.h / 2;
      clampView();
      view.y = mid - view.h / 2;
      clampView(); applyView();
    }).observe(map);
  }
  map.addEventListener('pointerdown', onDown);
  map.addEventListener('pointermove', onMove);
  map.addEventListener('pointerup', onUp);
  map.addEventListener('pointercancel', onUp);
  map.addEventListener('wheel', e => { e.preventDefault(); const [wx, wy] = toWorld(e.clientX, e.clientY); zoomAt(wx, wy, e.deltaY > 0 ? 1.15 : 0.87); }, { passive: false });

  el('startBtn').onclick = startSession;
  el('againBtn').onclick = startSession;
  el('menuBtn').onclick = showMenu;
  el('stopBtn').onclick = () => {
    if (kijk) { el('stopBtn').textContent = 'Stop'; showMenu(); return; }
    if (confirm('Sessie stoppen? Je antwoorden tot nu toe zijn al bewaard.')) { session = null; showMenu(); }
  };
  el('nextBtn').onclick = () => { session.idx++; nextQuestion(); };
  el('sheetClose').onclick = sluitSheet;
  el('zoek').oninput = buildZoek;

  el('zoomIn').onclick = () => zoomAt(view.x + view.w / 2, view.y + view.h / 2, 0.7);
  el('zoomOut').onclick = () => zoomAt(view.x + view.w / 2, view.y + view.h / 2, 1.43);
  el('zoomReset').onclick = resetView;

  el('soortSeg').querySelectorAll('button').forEach(b => b.onclick = () => {
    state.settings.soort = b.dataset.s; save(); buildScopeUI(); buildZoek();
  });
  el('scopeSeg').querySelectorAll('button').forEach(b => b.onclick = () => setScopeType(b.dataset.t));
  el('modeSeg').querySelectorAll('button').forEach(b => b.onclick = () => { state.settings.mode = b.dataset.m; save(); buildScopeUI(); });
  el('exportBtn').onclick = doExport;
  el('importBtn').onclick = () => el('importFile').click();
  el('importFile').onchange = e => { if (e.target.files[0]) doImport(e.target.files[0]); e.target.value = ''; };

  // toon zoom-hint kort bij eerste vraag
  let hinted = false;
  el('mapwrap').addEventListener('pointerdown', () => { if (!hinted) { hinted = true; } });
}

// service worker
if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});

boot();
