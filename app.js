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
let byName = new Map();       // naam -> country object
let quizPolys = new Map();    // naam -> [ring[[x,y]...]...] voor klikdetectie
let state = null;             // opgeslagen voortgang
let session = null;           // huidige sessie (runtime)
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
  MAP.countries.forEach(c => byName.set(c.name, c));
  MAP.countries.filter(c => c.quiz).forEach(c => quizPolys.set(c.name, parsePath(c.d)));
  drawMap();
  buildScopeUI();
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
  if (pointers.size === 0) { gesture = null; if (wasTap && session) handleTap(cx, cy); }
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
  let queue = shuffle(due).concat(newItems);
  if (queue.length > state.settings.sessionLen) queue = queue.slice(0, state.settings.sessionLen);
  if (!queue.length) {
    // niets te herhalen en niets nieuws (alles zit vast en nog niet toe aan herhaling)
    alert('Niets te herhalen op dit moment — alles wat je koos zit goed vast. Kies meer landen, of kom later terug.');
    state.sessionCounter--; return;
  }
  queue = shuffle(queue);
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
    ? '<span class="ok">Goed.</span> ' + target.nl + ' — ' + target.continent + ', brok ' + target.brok + ' (' + target.broknaam + ').'
    : '<span class="no">Mis.</span> Dit is ' + target.nl + ', niet ' + byName.get(chosen).nl + '.';
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
  save();
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
  el('peekMsg').textContent = c.nl + ' · ' + c.continent + ', brok ' + c.brok + ' (' + c.broknaam + ')';
}

function handleTap(clientX, clientY) {
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
    el('fbMsg').innerHTML = '<span class="ok">Goed.</span> ' + target.nl + ' — ' + target.continent + ', brok ' + target.brok + ' (' + target.broknaam + ').';
  } else {
    let hit = '';
    // wat tikte ze aan?
    let hitKey = null;
    for (const k of quizPolys.keys()) if (inCountry(pt, quizPolys.get(k))) { hitKey = k; break; }
    if (!hitKey && near.d <= effR) hitKey = near.key;
    if (hitKey && hitKey !== key) hit = ' Je wees ' + byName.get(hitKey).nl + ' aan.';
    el('fbMsg').innerHTML = '<span class="no">Mis.</span> ' + target.nl + ' ligt hier (groen omlijnd).' + hit;
    // zoom licht naar het juiste land toe zodat ze het ziet
    focusOn(target, pt);
  }
  el('nextBtn').classList.remove('hidden');
}

function boundsOf(name) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const r of quizPolys.get(name)) for (const p of r) {
    if (p[0] < x0) x0 = p[0]; if (p[0] > x1) x1 = p[0];
    if (p[1] < y0) y0 = p[1]; if (p[1] > y1) y1 = p[1];
  }
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
function focusAsk(c) {
  focusOn(c);
  const b = boundsOf(c.name);
  const mid = [(b.x0 + b.x1) / 2, (b.y0 + b.y1) / 2];
  for (let i = 0; i < 12 && showPx(b) < ASK_MIN_PX; i++) {
    const w = view.w;
    zoomAt(mid[0], mid[1], 0.8);
    if (view.w === w) break;   // zoomgrens bereikt
  }
}

function clearMarks() {
  el('viewport').querySelectorAll('.target,.wrong,.ask,.peek')
    .forEach(p => p.classList.remove('target', 'wrong', 'ask', 'peek'));
  el('peekMsg').textContent = '';
}

function endSession() {
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
  updateProgress();
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
  let nieuw = 0, leren = 0, vast = 0, onzichtbaar = 0;
  for (const k of keys) {
    const it = state.items[k];
    if (!it || !it[F.seen]) onzichtbaar++;
    else if (it[F.box] >= 4) vast++;
    else if (it[F.box] >= 1) leren++;
    else nieuw++;
  }
  const total = keys.length || 1;
  const seg = (n, col) => n ? `<span style="width:${(n / total * 100).toFixed(1)}%;background:${col}"></span>` : '';
  el('progBar').innerHTML = seg(vast, '#7bc98a') + seg(leren, '#f0b46b') + seg(nieuw, '#c9cf99') + seg(onzichtbaar, '#eef2f2');
  el('progText').innerHTML = `<b class="num">${vast}</b> zitten vast · <b class="num">${leren}</b> aan het leren · <b class="num">${keys.length - vast - leren}</b> nog te doen · <span class="num">${keys.length}</span> landen in selectie.`;
  const sc = state.settings.scope;
  const waar = sc.type === 'all' ? 'alle landen' : sc.type === 'continent' ? (sc.values.join(', ') || 'kies werelddeel') : ('brok ' + (sc.values.join(', ') || '—'));
  el('scopeName').textContent = '(' + (state.settings.mode === 'reverse' ? 'omgekeerd' : 'aanwijzen') + ' · ' + waar + ')';
  const due = keys.filter(k => state.items[k] && state.items[k][F.seen] && state.items[k][F.due] <= state.sessionCounter + 1).length;
  const unseen = keys.filter(k => !state.items[k] || !state.items[k][F.seen]).length;
  el('startInfo').innerHTML = `Volgende sessie: tot <b>${Math.min(state.settings.newPerSession, unseen)}</b> nieuwe landen en <b>${due}</b> herhalingen (max ${state.settings.sessionLen} per keer).`;
}

// ---------------------------------------------------------------- schermen
function showMenu() { updateProgress(); toggle('menu'); }
function showQuiz() { toggle('quiz'); }
function showEnd() { toggle('end'); }
function toggle(id) { ['menu', 'quiz', 'end'].forEach(s => el(s).classList.toggle('hidden', s !== id)); }
function resetView() { if (session && session.home) { view = { ...session.home }; applyView(); } else fitScope(); }

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
  el('stopBtn').onclick = () => { if (confirm('Sessie stoppen? Je antwoorden tot nu toe zijn al bewaard.')) { session = null; showMenu(); } };
  el('nextBtn').onclick = () => { session.idx++; nextQuestion(); };

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
