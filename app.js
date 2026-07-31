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
    settings: { scope: { type: 'all', values: [] }, mode: 'point', newPerSession: 7, sessionLen: 20 } };
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
  let html = '';
  for (const c of MAP.countries) html += `<path class="c" d="${c.d}" data-k="${enc(c.name)}"></path>`;
  vp.innerHTML = html;
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
  if (!keys.length || state.settings.scope.type === 'all') return full;
  // fit op de KERN: 5e-95e percentiel van de trefpunten, zodat uitschieters als
  // Rusland (tot in Siberie) of IJsland het beeld niet leegtrekken.
  const xs = keys.map(k => byName.get(k).cx).sort((a, b) => a - b);
  const ys = keys.map(k => byName.get(k).cy).sort((a, b) => a - b);
  const q = (arr, p) => arr[Math.min(arr.length - 1, Math.max(0, Math.round((arr.length - 1) * p)))];
  let x0 = q(xs, 0.05), x1 = q(xs, 0.95), y0 = q(ys, 0.05), y1 = q(ys, 0.95);
  // minimale omvang zodat een selectie van weinig landen niet te ver inzoomt
  const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
  const minW = base.w * 0.10, minH = base.h * 0.12;
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
function scopeKeys() {
  const all = MAP.countries.filter(c => c.quiz);
  const sc = state.settings.scope;
  let f = all;
  if (sc.type === 'continent' && sc.values.length) f = all.filter(c => sc.values.includes(c.continent));
  else if (sc.type === 'brok' && sc.values.length) f = all.filter(c => sc.values.includes(c.brok));
  return f.map(c => c.name);
}
function shuffle(a) { a = a.slice(); for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; }

function startSession() {
  const pool = scopeKeys();
  if (!pool.length) { alert('Kies eerst een werelddeel of brok met landen erin.'); return; }
  pool.forEach(ensureItem);
  const F = fields();
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
    alert('Niets te herhalen op dit moment — alles wat je koos ken je al goed. Kies meer landen, of kom later terug.');
    state.sessionCounter--; return;
  }
  kijk = null;
  el('stopBtn').textContent = 'Stop';
  session = { queue, idx: 0, correct: 0, results: [], now, answered: false, home: null, mode: state.settings.mode };
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
  if (session.mode === 'reverse') {
    el('qText').innerHTML = 'Welk land is <b>oranje</b>?';
    const p = pathEl(key); if (p) p.classList.add('ask');
    focusAsk(c);                      // land groot genoeg, met omgeving, in beeld
    buildOptions(key);
    el('fbMsg').innerHTML = 'Kies de juiste naam.';
  } else {
    el('qText').innerHTML = 'Waar ligt <b id="qName"></b>?';
    el('qName').textContent = c.nl;
    el('fbMsg').innerHTML = 'Tik op de kaart waar dit land ligt.';
  }
}

// De foute keuzes moeten geloofwaardig zijn. Little & Bjork lieten zien dat
// meerkeuze pas net zoveel oplevert als zelf het antwoord produceren wanneer de
// andere opties serieuze kanshebbers zijn: je haalt dan ook op waarom die niet
// kloppen. "Chili of Noorwegen" kun je raden zonder te kijken; "Chili of
// Argentinie of Peru" dwingt je de kaart te lezen.
function distractors(key, n) {
  const c = byName.get(key);
  const pool = MAP.countries.filter(x => x.quiz && x.name !== key);
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
  if (d.bron)  r.push('<p class="bron">' + esc(d.bron) + '</p>');
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
  el('fbMsg').innerHTML = c.nl + ' ligt in ' + plek(c) + '.';
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
  MAP.countries.filter(c => c.quiz && c.nl.toLowerCase().includes(t))
    .sort((a, b) => a.nl.localeCompare(b.nl, 'nl'))
    .forEach(c => box.appendChild(chip(c.nl, false, () => toonLand(c.name))));
}

// Welk land ligt onder dit punt? Eerst echt raak, anders het dichtstbijzijnde
// land binnen tikafstand (kleine landen zijn met een vinger niet te raken).
function countryAt(pt) {
  for (const k of quizPolys.keys()) if (inCountry(pt, quizPolys.get(k))) return k;
  const near = nearestQuiz(pt, [...quizPolys.keys()]);
  return near && near.d <= MIN_TAP_PX / screenScale() ? near.key : null;
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
    el('fbMsg').innerHTML = '<span class="no">Mis.</span> ' + target.nl + ' ligt hier (groen omlijnd): ' + plek(target) + '.' + hit;
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
  // ongeacht hoe ver ze ernaast zat.
  const m = Math.max(x1 - x0, y1 - y0) * 0.8 + base.w * 0.03;
  const box = { x0: x0 - m, y0: y0 - m, x1: x1 + m, y1: y1 + m };
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
  const groep = MAP.countries.filter(x => x.quiz && regioVan(x) === regio);
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
function plek(c) { return ligging(c) + ', brok ' + c.brok + ' (' + c.broknaam + ')'; }

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
  el('endWhat').textContent = session.mode === 'reverse' ? 'goed herkend' : 'goed aangewezen';
  const rows = session.results.map(r => {
    const c = byName.get(r.key);
    return `<div class="er"><span>${c.nl}</span><span>${r.correct ? '✓' : '✗'}</span></div>`;
  }).join('');
  el('endlist').innerHTML = rows;
  session = null;
}

// ---------------------------------------------------------------- menu / scope UI
function buildScopeUI() {
  const sc = state.settings.scope;
  const m = state.settings.mode;
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
      MAP.brokken.forEach(b => box.appendChild(chip(b.n + '. ' + b.naam, sc.values.includes(b.n), () => toggleScope(b.n))));
    }
  }
  scopeHint();
  brokUitleg();
  updateProgress();
}

// De ankerzin hoort bij de brok, niet bij één land. Hier kies je je brok, dus
// hier hoort hij ook: eerst zien wat een groepje is en waarom het bij elkaar
// hoort, en dan pas oefenen. Zonder dit koos je een nummer met een naam en
// kreeg je de uitleg pas ná je eerste antwoord, verstopt bij één land.
function brokUitleg() {
  const box = el('brokUitleg'), sc = state.settings.scope;
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
  const F = fields();
  const s = new Set();
  for (const c of MAP.countries)
    if (c.quiz && state.items[c.name] && state.items[c.name][F.seen]) s.add(c.brok);
  return [...s].sort((a, b) => a - b);
}

// Eén brok tegelijk oefenen voelt fijn: het gaat vlot en je hebt het snel goed.
// Maar dat vlotte gevoel komt doordat je binnen die brok niet hoeft te kiezen.
// Door elkaar oefenen voelt trager en rommeliger, en blijft juist beter hangen.
// De app kon dat al (meerdere brokken aantikken), maar zei het nergens.
function scopeHint() {
  const sc = state.settings.scope;
  const info = el('scopeInfo'), mix = el('mixBtn');
  mix.classList.add('hidden');
  if (sc.type === 'all') {
    info.textContent = 'Alle ' + MAP.countries.filter(c => c.quiz).length +
      ' landen door elkaar. Je krijgt vanzelf eerst terug wat aan herhaling toe is.';
    return;
  }
  if (sc.type === 'continent') {
    info.textContent = 'Tik een of meer werelddelen aan. Dit is de indeling van je leerplan, ' +
      'dus Amerika en Oceanië staan samen.';
    return;
  }
  info.textContent = 'Je kunt meerdere brokken tegelijk aantikken. Dat voelt trager en ' +
    'rommeliger dan brok voor brok, en dat is precies waarom het beter blijft hangen: ' +
    'je moet elke keer opnieuw kiezen uit alles wat je kent.';
  const gestart = startedBroks();
  if (gestart.length >= 2 && gestart.some(n => !sc.values.includes(n))) {
    mix.textContent = 'Alle ' + gestart.length + ' brokken erbij die je al begon';
    mix.classList.remove('hidden');
    mix.onclick = () => {
      state.settings.scope.values = [...new Set(sc.values.concat(gestart))].sort((a, b) => a - b);
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
  const vals = state.settings.scope.values;
  const i = vals.indexOf(v); if (i >= 0) vals.splice(i, 1); else vals.push(v);
  save(); buildScopeUI();
}
function setScopeType(t) {
  state.settings.scope = { type: t, values: [] }; save(); buildScopeUI();
}

function updateProgress() {
  const keys = scopeKeys();
  const F = fields();
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
  el('progText').innerHTML = `<b class="num">${kent}</b> ken je · <b class="num">${leren}</b> aan het leren · <b class="num">${nietGehad}</b> nog niet gehad · <span class="num">${keys.length}</span> landen in deze selectie.`;
  const sc = state.settings.scope;
  const waar = sc.type === 'all' ? 'alle landen' : sc.type === 'continent' ? (sc.values.join(', ') || 'kies werelddeel') : ('brok ' + (sc.values.join(', ') || '—'));
  el('scopeName').textContent = '(' + (state.settings.mode === 'reverse' ? 'omgekeerd' : 'aanwijzen') + ' · ' + waar + ')';
  const due = keys.filter(k => state.items[k] && state.items[k][F.seen] && state.items[k][F.due] <= state.sessionCounter + 1).length;
  const unseen = keys.filter(k => !state.items[k] || !state.items[k][F.seen]).length;
  // Precies dezelfde verdeling als startSession maakt, anders belooft dit scherm
  // iets wat je niet krijgt.
  const nieuwN = Math.min(state.settings.newPerSession, unseen, state.settings.sessionLen);
  const herhaalN = Math.min(due, Math.max(0, state.settings.sessionLen - nieuwN));
  const wacht = due - herhaalN;
  const nw = `<b>${nieuwN}</b> ` + (nieuwN === 1 ? 'nieuw land' : 'nieuwe landen');
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
