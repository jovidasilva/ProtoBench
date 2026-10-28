// @ts-nocheck
import { app } from '../state';
import { $, BJT, BPREFIX, DIO, MOS, SIZES, boardAt, boardDefault, boardDims, boardLabel, boardRect, boardRectAt, clamp, clone, esc, fromView, hasKind, hk, hname, holeExists, inBoard, kindAt, nextBoardName, toLocal, toView } from '../core/base';
import { CT, LIB, LIBMAP, QUICK } from '../parts/catalog';
import { MCU, analyze, compAABB, compById, epPos, makeComp, mcuById, mcuCfg, mcuPinPos, mcuRect, mk, mkSplit, nextName, nextTraceTag, objectFree, occupancy, overlapsBody, pinsOf, traceCover, validComp } from '../core/analysis';
import { simulate } from '../sim/solver';
import { lPath, rectView, renderBoard, renderItems, renderOverlay, segConflicts, svg } from './render';
import { changed, issueCache, itemsOnBoard, rangeFmt, renderAll, renderChrome, renderInspector, renderLib, renderStatus, renderTabs, say, setTool } from './panels';
import { RT, defaultCode, openCode, runCode, stopCode } from '../code/arduino';
import { flushSave, scheduleSave } from '../app/projects';

// ════════════════════════ Estado: desfazer, migração ════════════════════════
export function emptyState() { return { v: 3, boards: [], mcus: [], comps: [], traces: [], wires: [], solder: [], cuts: [], labels: [], links: [], nextId: 1 }; }

export function snapshot() { return JSON.stringify(app.S); }
export function commit(fn) { const snap = snapshot(); const ok = fn(); if (ok === false) return false; app.undoStack.push(snap); if (app.undoStack.length > 200) app.undoStack.shift(); app.redoStack = []; changed(); return true; }
export function restore(json) { app.S = JSON.parse(json); app.selected = null; app.multi = null; app.drawing = null; app.wireStart = null; app.linkStart = null; changed(); }
export function undo() { if (!app.undoStack.length) return; app.redoStack.push(snapshot()); restore(app.undoStack.pop()); }
export function redo() { if (!app.redoStack.length) return; app.undoStack.push(snapshot()); restore(app.redoStack.pop()); }

export function normalize(o) {
  const s = Object.assign(emptyState(), o);
  for (const k of ['boards', 'mcus', 'comps', 'traces', 'wires', 'solder', 'cuts', 'labels', 'links']) if (!Array.isArray(s[k])) s[k] = [];
  s.comps = s.comps.filter(c => CT[c.type]);
  s.mcus = s.mcus.filter(m => MCU[m.type]); for (const m of s.mcus) { m.pins = m.pins || {}; if (m.code == null) m.code = ''; }
  let tg = 0; for (const t of s.traces) { if (!t.tag) t.tag = ++tg; else tg = Math.max(tg, t.tag); if (t.color === undefined) t.color = null; if (!t.name) t.name = ''; }
  const maxId = [...s.comps, ...s.traces, ...s.wires, ...s.boards, ...s.mcus].reduce((m, x) => Math.max(m, x.id || 0), 0);
  s.nextId = Math.max(s.nextId || 1, maxId + 1);
  s.v = 3;
  return s;
}

// Itens que moram numa placa (para mover ou remover junto)
export function boardMembers(b) {
  const on = (c, r) => boardAt(c, r) === b;
  return {
    comps: app.S.comps.filter(c => { const p = pinsOf(c)[0]; return on(p.c, p.r); }).map(c => c.id),
    traces: app.S.traces.filter(t => on(t.pts[0][0], t.pts[0][1])).map(t => t.id),
    solder: app.S.solder.filter(([c, r]) => on(c, r)), cuts: app.S.cuts.filter(([c, r]) => on(c, r)), labels: app.S.labels.filter(l => on(l.h[0], l.h[1])),
    wireEnds: app.S.wires.flatMap(w => [w.a, w.b]).filter(ep => ep.h && on(ep.h[0], ep.h[1])),
  };
}

export function shiftMembers(m, dx, dy) {
  const cs = new Set(m.comps), ts = new Set(m.traces);
  for (const c of app.S.comps) if (cs.has(c.id)) { c.c += dx; c.r += dy; }
  for (const t of app.S.traces) if (ts.has(t.id)) t.pts = t.pts.map(p => [p[0] + dx, p[1] + dy]);
  for (const p of m.solder) { p[0] += dx; p[1] += dy; }
  for (const p of m.cuts) { p[0] += dx; p[1] += dy; }
  for (const l of m.labels) { l.h[0] += dx; l.h[1] += dy; }
  for (const ep of m.wireEnds) { ep.h[0] += dx; ep.h[1] += dy; }
}

export function removeBoard(id) {
  const b = app.S.boards.find(b => b.id === id); if (!b) return false;
  const m = boardMembers(b), cs = new Set(m.comps), ts = new Set(m.traces), sol = new Set(m.solder), cut = new Set(m.cuts), lab = new Set(m.labels), ends = new Set(m.wireEnds);
  app.S.comps = app.S.comps.filter(c => !cs.has(c.id)); app.S.traces = app.S.traces.filter(t => !ts.has(t.id));
  app.S.solder = app.S.solder.filter(p => !sol.has(p)); app.S.cuts = app.S.cuts.filter(p => !cut.has(p)); app.S.labels = app.S.labels.filter(l => !lab.has(l));
  const pinGone = ep => ep.pin && cs.has(ep.pin[0]);
  app.S.wires = app.S.wires.filter(w => !ends.has(w.a) && !ends.has(w.b) && !pinGone(w.a) && !pinGone(w.b));
  app.S.links = app.S.links.filter(l => !pinGone(l.a) && !pinGone(l.b));
  app.S.boards = app.S.boards.filter(x => x !== b);
  return m.comps.length + m.traces.length;
}

export function removeMcu(id) {
  if (typeof RT !== 'undefined' && RT.mid === id) stopCode();
  const has = ep => ep.mcu && ep.mcu[0] === id;
  app.S.wires = app.S.wires.filter(w => !has(w.a) && !has(w.b)); app.S.links = app.S.links.filter(l => !has(l.a) && !has(l.b));
  app.S.mcus = app.S.mcus.filter(m => m.id !== id);
}

export function setBoardProps(id, patch) {
  const b0 = app.S.boards.find(b => b.id === id); if (!b0) return;
  const nb = Object.assign({}, b0, patch);
  if (patch.kind && patch.kind !== b0.kind) { if (patch.kind === 'bread') nb.size = 830; else if (b0.kind === 'bread') { nb.size = '7x9'; nb.cols = 24; nb.rows = 30; } nb.name = nextBoardName(patch.kind); }
  if (patch.size && nb.kind !== 'bread') { const sz = SIZES.find(z => z[0] === patch.size); if (sz) { nb.cols = sz[2]; nb.rows = sz[3]; } }
  if (nb.kind === 'bread') nb.size = +nb.size;
  nb.cols = clamp(+nb.cols || 24, 4, 70); nb.rows = clamp(+nb.rows || 30, 4, 90); nb.sides = +nb.sides || 2;
  if (!objectFree(boardRect(nb), id)) { say('Com esse tamanho a placa encostaria em outro objeto. Afaste antes.', true); renderInspector(); return; }
  let removed = 0;
  commit(() => {
    const before = boardMembers(b0);
    Object.assign(b0, nb);
    const on = (c, r) => boardAt(c, r) === b0;
    const keep = new Set(app.S.comps.filter(c => pinsOf(c).every(p => holeExists(p.c, p.r) && on(p.c, p.r))).map(c => c.id));
    for (const id2 of before.comps) if (!keep.has(id2)) { deleteHit({ kind: 'comp', id: id2 }); removed++; }
    for (const tid of before.traces) { const t = app.S.traces.find(t => t.id === tid); if (t && (b0.kind === 'bread' || !t.pts.every(([c, r]) => on(c, r)))) { app.S.traces = app.S.traces.filter(x => x !== t); removed++; } }
    app.S.wires = app.S.wires.filter(w => { const ok = [w.a, w.b].every(ep => !ep.h || holeExists(ep.h[0], ep.h[1])); if (!ok) removed++; return ok; });
    app.S.solder = app.S.solder.filter(([c, r]) => inBoard(c, r)); app.S.cuts = app.S.cuts.filter(([c, r]) => kindAt(c, r) === 'strip'); app.S.labels = app.S.labels.filter(l => inBoard(l.h[0], l.h[1]));
  });
  if (removed) say(`${removed} ${removed > 1 ? 'itens ficaram' : 'item ficou'} fora da placa e ${removed > 1 ? 'foram removidos' : 'foi removido'} (Desfazer recupera).`);
}

export function ghostObject(key, f) {
  const [, , type, props] = LIBMAP[key];
  if (type === 'board') { const b = Object.assign(boardDefault(), props); if (b.kind !== 'bread') { const sz = SIZES.find(z => z[0] === b.size); b.cols = sz[2]; b.rows = sz[3]; } b.x = Math.round(f[0]); b.y = Math.round(f[1]); b.id = -1; b.name = nextBoardName(b.kind); return b; }
  return { id: -1, type: props.type, name: MCU[props.type].label, pins: {}, x: Math.round(f[0] - 1), y: Math.round(f[1] - 1), code: '' };
}

export function placeObject(key, f) {
  const [, , type, props] = LIBMAP[key], g = ghostObject(key, f);
  if (!objectFree(type === 'board' ? boardRect(g) : mcuRect(g))) { say('Ali encosta em outro objeto. Escolha um espaço livre da bancada.', true); return; }
  g.id = app.S.nextId;
  if (type === 'mcu') { const same = app.S.mcus.filter(m => m.type === props.type).length; g.name = MCU[props.type].label + (same ? ' ' + (same + 1) : ''); g.code = defaultCode(props.type); }
  commit(() => { app.S.nextId++; (type === 'board' ? app.S.boards : app.S.mcus).push(g); });
  setTool('select'); app.selected = { kind: type, id: g.id }; renderOverlay(); renderInspector();
  say(type === 'board' ? `${g.name} adicionada. Arraste pela borda para mover.` : `${g.name} adicionado. Ligue fios aos pinos com a ferramenta Fio (J).`);
}

// ════════════════════════ Seleção múltipla, copiar e colar ════════════════════════
export function selSpec() {
  if (app.multi) return { comps: [...app.multi.comps], traces: [...app.multi.traces], wires: [...app.multi.wires] };
  if (app.selected && app.selected.kind === 'comp') return { comps: [app.selected.id], traces: [], wires: [] };
  if (app.selected && app.selected.kind === 'trace') return { comps: [], traces: [app.selected.id], wires: [] };
  if (app.selected && app.selected.kind === 'wire') { const w = app.S.wires.find(w => w.id === app.selected.id); return w && w.a.h && w.b.h ? { comps: [], traces: [], wires: [w.id] } : null; }
  return null;
}

export function setMulti(spec) {
  const n = spec.comps.length + spec.traces.length + spec.wires.length;
  if (!n) { app.multi = null; app.selected = null; return; }
  if (n === 1) { app.multi = null; app.selected = spec.comps.length ? { kind: 'comp', id: spec.comps[0] } : spec.traces.length ? { kind: 'trace', id: spec.traces[0] } : { kind: 'wire', id: spec.wires[0] }; return; }
  app.multi = { comps: new Set(spec.comps), traces: new Set(spec.traces), wires: new Set(spec.wires) }; app.selected = { kind: 'multi' };
}

// desloca um conjunto de itens (peças, trilhas, fios de placa) e a solda sob os pinos movidos
export function shiftSpec(spec, dx, dy) {
  const cs = new Set(spec.comps), ts = new Set(spec.traces), ws = new Set(spec.wires);
  const pinHoles = new Set(); for (const c of app.S.comps) if (cs.has(c.id)) for (const p of pinsOf(c)) pinHoles.add(p.c + ',' + p.r);
  for (const p of app.S.solder) if (pinHoles.has(p[0] + ',' + p[1])) { p[0] += dx; p[1] += dy; }
  for (const c of app.S.comps) if (cs.has(c.id)) { c.c += dx; c.r += dy; }
  for (const t of app.S.traces) if (ts.has(t.id)) t.pts = t.pts.map(p => [p[0] + dx, p[1] + dy]);
  for (const w of app.S.wires) if (ws.has(w.id)) for (const ep of [w.a, w.b]) if (ep.h) { ep.h[0] += dx; ep.h[1] += dy; }
}

export function specValid(spec) {
  const cs = new Set(spec.comps);
  for (const c of app.S.comps) if (cs.has(c.id) && !validComp(c)) return false;
  for (const t of app.S.traces) if (spec.traces.includes(t.id)) { const b = boardAt(t.pts[0][0], t.pts[0][1]); if (!b || b.kind === 'bread' || !traceCover(t).every(e => holeExists(e.c, e.r) && boardAt(e.c, e.r) === b)) return false; }
  for (const w of app.S.wires) if (spec.wires.includes(w.id)) for (const ep of [w.a, w.b]) if (ep.h && !holeExists(ep.h[0], ep.h[1])) return false;
  return true;
}

export function nudge(dx, dy) {
  if (app.selected && (app.selected.kind === 'board' || app.selected.kind === 'mcu')) {
    const snap = snapshot();
    if (app.selected.kind === 'board') { const b = app.S.boards.find(b => b.id === app.selected.id); const m = boardMembers(b); b.x += dx; b.y += dy; shiftMembers(m, dx, dy); if (!objectFree(boardRect(b), b.id)) { app.S = JSON.parse(snap); say('Encostaria em outro objeto.', true); return; } }
    else { const mo = mcuById(app.selected.id); mo.x += dx; mo.y += dy; if (!objectFree(mcuRect(mo), null, mo.id)) { app.S = JSON.parse(snap); say('Encostaria em outro objeto.', true); return; } }
    app.undoStack.push(snap); app.redoStack = []; changed(); return;
  }
  const spec = selSpec(); if (!spec) return;
  const snap = snapshot(); shiftSpec(spec, dx, dy);
  if (!specValid(spec)) { app.S = JSON.parse(snap); say('Não dá para mover para lá: algum pino cairia fora ou sobre outro.', true); return; }
  app.undoStack.push(snap); app.redoStack = []; changed();
}

export function copySel() {
  const spec = selSpec(); if (!spec) { say('Selecione peças ou trilhas para copiar (arraste uma caixa para pegar várias).', true); return false; }
  const comps = app.S.comps.filter(c => spec.comps.includes(c.id)).map(clone), traces = app.S.traces.filter(t => spec.traces.includes(t.id)).map(clone), wires = app.S.wires.filter(w => spec.wires.includes(w.id) && w.a.h && w.b.h).map(clone);
  const xs = [], ys = []; comps.forEach(c => pinsOf(c).forEach(p => { xs.push(p.c); ys.push(p.r); })); traces.forEach(t => t.pts.forEach(p => { xs.push(p[0]); ys.push(p[1]); })); wires.forEach(w => [w.a.h, w.b.h].forEach(p => { xs.push(p[0]); ys.push(p[1]); }));
  app.clipboard = { comps, traces, wires, ox: Math.min(...xs), oy: Math.min(...ys) };
  say(`${comps.length + traces.length + wires.length} ${comps.length + traces.length + wires.length === 1 ? 'item copiado' : 'itens copiados'}. Ctrl+V para colar.`);
  return true;
}

export function pastePreview(at) {
  const dx = at.c - app.clipboard.ox, dy = at.r - app.clipboard.oy;
  return app.clipboard.comps.map(c => Object.assign(clone(c), { id: -1 - c.id, c: c.c + dx, r: c.r + dy }));
}

export function pasteAt(at) {
  const dx = at.c - app.clipboard.ox, dy = at.r - app.clipboard.oy, idMap = {};
  const snap = snapshot(), spec = { comps: [], traces: [], wires: [] };
  for (const c0 of app.clipboard.comps) { const c = clone(c0); idMap[c0.id] = c.id = app.S.nextId++; c.c += dx; c.r += dy; c.p.name = nextName(CT[c.type].prefix); app.S.comps.push(c); spec.comps.push(c.id); }
  for (const t0 of app.clipboard.traces) { const t = clone(t0); t.id = app.S.nextId++; t.tag = nextTraceTag(); t.pts = t.pts.map(p => [p[0] + dx, p[1] + dy]); app.S.traces.push(t); spec.traces.push(t.id); }
  for (const w0 of app.clipboard.wires) { const w = clone(w0); w.id = app.S.nextId++; w.a.h = [w.a.h[0] + dx, w.a.h[1] + dy]; w.b.h = [w.b.h[0] + dx, w.b.h[1] + dy]; app.S.wires.push(w); spec.wires.push(w.id); }
  const occ = occupancy(null); let clash = false;
  for (const w of app.S.wires) if (spec.wires.includes(w.id)) for (const ep of [w.a, w.b]) { const o = occ.get(hk(ep.h[0], ep.h[1])); if (o && o.kind === 'pin') clash = true; }
  if (clash || !specValid(spec)) { app.S = JSON.parse(snap); return false; }
  const pins = new Set(app.clipboard.comps.flatMap(c => pinsOf(c).map(p => p.c + ',' + p.r)));
  // leva junto a solda que estava sob os pinos copiados
  const solderSrc = new Set(JSON.parse(snap).solder.map(p => p.join(',')));
  for (const k of pins) if (solderSrc.has(k)) { const [c, r] = k.split(',').map(Number); app.S.solder.push([c + dx, r + dy]); }
  app.undoStack.push(snap); app.redoStack = []; setMulti(spec); changed();
  return true;
}

export function duplicateSel() {
  if (!copySel()) return;
  const base = { c: app.clipboard.ox, r: app.clipboard.oy };
  for (let d = 2; d < 14; d++) for (const [dx, dy] of [[d, d], [d, 0], [0, d], [-d, 0], [0, -d]]) if (pasteAt({ c: base.c + dx, r: base.r + dy })) { say('Duplicado.'); return; }
  say('Não achei espaço livre perto para a cópia.', true);
}

export function selectAll() { setMulti({ comps: app.S.comps.map(c => c.id), traces: app.S.traces.map(t => t.id), wires: app.S.wires.filter(w => w.a.h && w.b.h).map(w => w.id) }); renderOverlay(); renderInspector(); }

// ════════════════════════ Vista: mover e zoom ════════════════════════
export const stage = $('stage');

export function setZoom(z, cx, cy) {
  const nz = clamp(Math.round(z * 100) / 100, 0.25, 3);
  const r0 = svg.getBoundingClientRect();
  if (cx == null) { const sr = stage.getBoundingClientRect(); cx = sr.left + sr.width / 2; cy = sr.top + sr.height / 2; }
  const vx = (cx - r0.left) / app.zoom, vy = (cy - r0.top) / app.zoom;
  app.zoom = nz; svg.style.width = (app.W * app.zoom) + 'px'; svg.style.height = (app.H * app.zoom) + 'px';
  const r1 = svg.getBoundingClientRect();
  stage.scrollLeft += r1.left + vx * app.zoom - cx; stage.scrollTop += r1.top + vy * app.zoom - cy;
  renderChrome();
}

export function fitAll() {
  const rs = app.S.boards.map(boardRect).concat(app.S.mcus.map(mcuRect)); if (!rs.length) return;
  const vr = rs.map(rectView), x0 = Math.min(...vr.map(r => r[0])), y0 = Math.min(...vr.map(r => r[1])), x1 = Math.max(...vr.map(r => r[0] + r[2])), y1 = Math.max(...vr.map(r => r[1] + r[3]));
  const z = clamp(Math.min((stage.clientWidth - 60) / (x1 - x0), (stage.clientHeight - 60) / (y1 - y0)), 0.25, 1.6);
  app.zoom = Math.round(z * 100) / 100; svg.style.width = (app.W * app.zoom) + 'px'; svg.style.height = (app.H * app.zoom) + 'px';
  const r = svg.getBoundingClientRect(), sr = stage.getBoundingClientRect();
  stage.scrollLeft += r.left + ((x0 + x1) / 2) * app.zoom - (sr.left + sr.width / 2);
  stage.scrollTop += r.top + ((y0 + y1) / 2) * app.zoom - (sr.top + sr.height / 2);
  renderChrome();
}

export function startPan(e) { app.pan = { x: e.clientX, y: e.clientY, sl: stage.scrollLeft, st: stage.scrollTop }; stage.classList.add('panning'); svg.setPointerCapture(e.pointerId); }

// ════════════════════════ Interação na bancada ════════════════════════
export function evtPoint(e) {
  const pt = svg.createSVGPoint(); pt.x = e.clientX; pt.y = e.clientY;
  const m = svg.getScreenCTM(); if (!m) return null;
  const p = pt.matrixTransform(m.inverse());
  return { f: fromView(p.x, p.y), v: [p.x, p.y] };
}

export function holeAt(f) { if (!f) return null; const c = Math.round(f[0]), r = Math.round(f[1]); if (!holeExists(c, r)) return null; if (Math.hypot(f[0] - c, f[1] - r) > 0.55) return null; return { c, r }; }
export function mcuPinAt(v) { if (!v) return null; let best = null, bd = 11; for (const mo of app.S.mcus) for (const p of MCU[mo.type].pins) { const q = mcuPinPos(mo.id, p.id), d = Math.hypot(q[0] - v[0], q[1] - v[1]); if (d < bd) { bd = d; best = [mo.id, p.id]; } } return best; }
export function mcuAt(f) { for (let i = app.S.mcus.length - 1; i >= 0; i--) { const R = mcuRect(app.S.mcus[i]); if (f[0] >= R[0] && f[0] <= R[1] && f[1] >= R[2] && f[1] <= R[3]) return app.S.mcus[i]; } return null; }
export function distSeg(px, py, ax, ay, bx, by) { const dx = bx - ax, dy = by - ay, L = dx * dx + dy * dy; let t = L ? ((px - ax) * dx + (py - ay) * dy) / L : 0; t = clamp(t, 0, 1); return Math.hypot(px - ax - t * dx, py - ay - t * dy); }

export function hitTest(pt, withObjects = true) {
  if (!pt) return null;
  const [x, y] = pt.f, v = pt.v;
  const hitComp = () => { for (let i = app.S.comps.length - 1; i >= 0; i--) { const c = app.S.comps[i]; const [a, b] = toLocal(c, x, y); const [a1, a2, b1, b2] = CT[c.type].box(c); if (a >= a1 && a <= a2 && b >= b1 && b <= b2) return { kind: 'comp', id: c.id }; } return null; };
  const hitW = () => { for (const w of app.S.wires) { const a = epPos(w.a), b = epPos(w.b); if (a && b && distSeg(v[0], v[1], a[0], a[1], b[0], b[1]) < 8) return { kind: 'wire', id: w.id }; } return null; };
  const hitT = () => { for (const t of app.S.traces) for (let i = 0; i < t.pts.length - 1; i++) if (distSeg(x, y, t.pts[i][0], t.pts[i][1], t.pts[i + 1][0], t.pts[i + 1][1]) < 0.3) return { kind: 'trace', id: t.id, seg: i }; return null; };
  const hitM = () => { const mo = mcuAt(pt.f); return mo ? { kind: 'mcu', id: mo.id } : null; };
  const hitB = () => { if (holeAt(pt.f)) return null; const b = boardRectAt(x, y); return b ? { kind: 'board', id: b.id } : null; };
  const first = app.view === 'top' ? (hitW() || hitComp() || (app.xray ? hitT() : null)) : (hitT() || hitW() || hitComp());
  return first || (withObjects ? (hitM() || hitB()) : null);
}

export function deleteHit(hit) {
  if (!hit) return false;
  if (hit.kind === 'multi') { if (!app.multi) return false; for (const id of app.multi.comps) deleteHit({ kind: 'comp', id }); for (const id of app.multi.traces) deleteHit({ kind: 'trace', id }); for (const id of app.multi.wires) deleteHit({ kind: 'wire', id }); app.multi = null; app.selected = null; return true; }
  if (hit.kind === 'comp') { app.S.comps = app.S.comps.filter(c => c.id !== hit.id); app.S.wires = app.S.wires.filter(w => !((w.a.pin && w.a.pin[0] === hit.id) || (w.b.pin && w.b.pin[0] === hit.id))); app.S.links = app.S.links.filter(l => !((l.a.pin && l.a.pin[0] === hit.id) || (l.b.pin && l.b.pin[0] === hit.id))); }
  else if (hit.kind === 'wire') app.S.wires = app.S.wires.filter(w => w.id !== hit.id);
  else if (hit.kind === 'trace') {
    const t = app.S.traces.find(t => t.id === hit.id); if (!t) return false;
    app.S.traces = app.S.traces.filter(x => x !== t);
    if (hit.seg != null) { const a = t.pts.slice(0, hit.seg + 1), b = t.pts.slice(hit.seg + 1); if (a.length >= 2) app.S.traces.push(Object.assign({}, t, { pts: a })); if (b.length >= 2) app.S.traces.push(Object.assign({}, t, { id: app.S.nextId++, tag: nextTraceTag(), pts: b })); }
  } else if (hit.kind === 'link') app.S.links.splice(hit.i, 1);
  else if (hit.kind === 'board') removeBoard(hit.id);
  else if (hit.kind === 'mcu') removeMcu(hit.id);
  if (app.selected && app.selected.id === hit.id && app.selected.kind === hit.kind) app.selected = null;
  return true;
}

export const WIREORDER = ['vermelho', 'preto', 'amarelo', 'azul', 'verde', 'laranja', 'branco', 'roxo'];
export function nextWireColor() { return WIREORDER[app.S.wires.length % WIREORDER.length]; }

export function pickWireEp(pt) {
  const pr = mcuPinAt(pt.v); if (pr) return { mcu: pr };
  const h = holeAt(pt.f); if (!h) return null;
  const o = app.AN.occ.get(hk(h.c, h.r));
  if (o && o.kind === 'pin') { if (o.comp.type === 'term' || o.comp.type === 'header') return { pin: [o.comp.id, o.pin.i] }; say(`Esse furo já tem o pino ${o.comp.p.name}.${o.pin.name}. Ligue o fio num furo livre ao lado e una com trilha ou solda.`, true); return false; }
  if (o) { say('Esse furo já tem a ponta de outro fio.', true); return false; }
  return { h: [h.c, h.r] };
}

export function pickLinkEp(pt) {
  const pr = mcuPinAt(pt.v); if (pr) return { mcu: pr };
  const h = holeAt(pt.f); if (!h) return null;
  const o = app.AN.occ.get(hk(h.c, h.r)); if (o && o.kind === 'pin') return { pin: [o.comp.id, o.pin.i] };
  return null;
}

export const sameEp = (a, b) => JSON.stringify(a) === JSON.stringify(b);

export function finishTrace() {
  if (app.drawing && app.drawing.pts.length >= 2) { const pts = app.drawing.pts; let tag; commit(() => { tag = nextTraceTag(); app.S.traces.push({ id: app.S.nextId++, tag, pts, color: null, name: '' }); }); say(`Trilha T${tag} soldada`); }
  app.drawing = null; renderOverlay(); renderStatus();
}

export function rotateSelected() {
  if (app.tool === 'place') { app.ghostRot = (app.ghostRot + 1) & 3; renderOverlay(); return; }
  if (!app.selected || app.selected.kind !== 'comp') { if (app.multi) say('Girar funciona com uma peça por vez.', true); return; }
  const c = compById(app.selected.id); if (!c) return;
  const cen = cc => { const ps = pinsOf(cc); return [ps.reduce((s, p) => s + p.c, 0) / ps.length, ps.reduce((s, p) => s + p.r, 0) / ps.length]; };
  const before = cen(c), n = clone(c); n.rot = (n.rot + 1) & 3;
  const after = cen(n); n.c += Math.round(before[0] - after[0]); n.r += Math.round(before[1] - after[1]);
  const ok = [n, Object.assign({}, n, { c: c.c, r: c.r })].find(x => validComp(x));
  if (!ok) { say('Sem espaço para girar aqui', true); return; }
  commit(() => { Object.assign(c, { rot: ok.rot, c: ok.c, r: ok.r }); });
}

export let pressBtn = null;
export let rafMove = 0;

export function applyDrag(pt) {
  const d = [Math.round(pt.f[0]) - app.drag.f0[0], Math.round(pt.f[1]) - app.drag.f0[1]];
  if (d[0] === app.drag.d[0] && d[1] === app.drag.d[1]) return;
  app.drag.d = d; app.drag.moved = true;
  app.S = JSON.parse(app.drag.snap);
  if (app.drag.kind === 'items') shiftSpec(app.drag.spec, d[0], d[1]);
  else if (app.drag.kind === 'board') { const b = app.S.boards.find(b => b.id === app.drag.id), m = boardMembers(b); b.x += d[0]; b.y += d[1]; shiftMembers(m, d[0], d[1]); app.drag.ok = objectFree(boardRect(b), b.id); }
  else { const mo = mcuById(app.drag.id); mo.x += d[0]; mo.y += d[1]; app.drag.ok = objectFree(mcuRect(mo), null, mo.id); }
  if (app.drag.kind === 'board') renderBoard();
  renderItems(); renderOverlay();
}

// ─── menu do botão direito ───
export const ctx = document.createElement('div');

export function hideCtx() { ctx.hidden = true; }
export let ctxActs = [];

export function showCtx(x, y, items) {
  ctxActs = items.filter(Boolean);
  ctx.innerHTML = ctxActs.map((it, i) => it === '-' ? '<hr>' : `<button role="menuitem" data-ci="${i}"${it.dis ? ' disabled' : ''}${it.danger ? ' class="danger"' : ''}><span>${esc(it.t)}</span>${it.k ? `<kbd>${esc(it.k)}</kbd>` : ''}</button>`).join('');
  ctx.hidden = false;
  const r = ctx.getBoundingClientRect();
  ctx.style.left = Math.min(x, innerWidth - r.width - 8) + 'px'; ctx.style.top = Math.min(y, innerHeight - r.height - 8) + 'px';
  const b = ctx.querySelector('button:not([disabled])'); if (b) b.focus();
}

// ════════════════════════ Eventos dos painéis ════════════════════════
export let liveSnap = null;

export function targetObj() {
  if (!app.selected) return null;
  if (app.selected.kind === 'comp') { const c = compById(app.selected.id); return c ? { obj: c.p, comp: c } : null; }
  if (app.selected.kind === 'trace') { const t = app.S.traces.find(t => t.id === app.selected.id); return t ? { obj: t } : null; }
  if (app.selected.kind === 'wire') { const w = app.S.wires.find(w => w.id === app.selected.id); return w ? { obj: w } : null; }
  if (app.selected.kind === 'mcu') { const mo = mcuById(app.selected.id); return mo ? { obj: mo } : null; }
  if (app.selected.kind === 'board') { const b = app.S.boards.find(b => b.id === app.selected.id); return b ? { obj: b } : null; }
  return null;
}

export function parseVal(el) { if (el.dataset.num) { const v = parseFloat(el.value); return isFinite(v) ? v : null; } if (el.dataset.bool) return el.value === 'true'; return el.value; }

export function applyField(k, v) {
  const tg = targetObj(); if (!tg || v == null) return false;
  const { obj, comp } = tg;
  if (k === 'valx') { if (!(v > 0)) return false; k = 'val'; }
  if (k === 'preset') { if (v === '' || v == null) return false; k = 'v'; v = +v; }
  if (k === 'v') v = clamp(v, 0, 60);
  if (k === 'rload' || k === 'r') v = Math.max(0.1, v);
  const before = clone(obj);
  obj[k] = v;
  if (k === 'name') obj.name = String(v).trim().slice(0, 24) || before.name;
  if (comp) {
    if (k === 'model' && (comp.type === 'bjt' || comp.type === 'mos')) comp.p.pinout = (comp.type === 'bjt' ? BJT : MOS)[v].pinout;
    if (k === 'model' && comp.type === 'diode') comp.p.span = DIO[v].span;
    if (!validComp(comp)) { Object.assign(obj, before); for (const kk of Object.keys(obj)) if (!(kk in before)) delete obj[kk]; say('Com essa mudança algum pino cairia fora da placa ou sobre outro. Mova a peça antes.', true); return false; }
  }
  return true;
}

export function mcuPinSet(key, k, val) { const [mid, pid] = mkSplit(key), mo = mcuById(mid); if (!mo) return; mo.pins[pid] = Object.assign({ mode: 'in', level: 0, duty: 50 }, mo.pins[pid]); mo.pins[pid][k] = val; }

export function panelChange(e) {
  const el = e.target;
  if (el.dataset.board != null && app.selected && app.selected.kind === 'board') { const k = el.dataset.board; setBoardProps(app.selected.id, { [k]: k === 'cols' || k === 'rows' || k === 'sides' ? +el.value : el.value }); return; }
  if (el.dataset.net != null) { const [c, r] = el.dataset.net.split(',').map(Number), name = el.value.trim().slice(0, 16); commit(() => { app.S.labels = app.S.labels.filter(l => !(l.h[0] === c && l.h[1] === r)); if (name) { const k = app.AN.holeKey(hk(c, r)); app.S.labels = app.S.labels.filter(l => app.AN.holeKey(hk(l.h[0], l.h[1])) !== k); app.S.labels.push({ h: [c, r], name }); } }); return; }
  if (el.dataset.mpin) { const key = el.dataset.mpin, k = el.dataset.mk; const run = () => mcuPinSet(key, k, k === 'duty' ? +el.value : el.value);
    if (el.dataset.live) { if (liveSnap) { app.undoStack.push(liveSnap); app.redoStack = []; liveSnap = null; } run(); changed(); } else commit(run); return; }
  if (el.dataset.f) {
    const v = parseVal(el);
    if (el.dataset.live) { if (liveSnap) { app.undoStack.push(liveSnap); app.redoStack = []; liveSnap = null; changed(); } return; }
    const snap = snapshot();
    if (applyField(el.dataset.f, v)) { app.undoStack.push(snap); app.redoStack = []; changed(); } else renderInspector();
  }
}

export function panelInput(e) {
  const el = e.target; if (!el.dataset.live) return;
  if (!liveSnap) liveSnap = snapshot();
  if (el.dataset.mpin) { mcuPinSet(el.dataset.mpin, 'duty', +el.value); if (el.nextElementSibling) el.nextElementSibling.textContent = el.value + '%'; }
  else { const v = parseVal(el); if (!applyField(el.dataset.f, v)) return; const lab = $('f_' + el.dataset.f + '_v'); if (lab && rangeFmt[el.dataset.f]) lab.textContent = rangeFmt[el.dataset.f](v); }
  app.AN = analyze(); app.SIM = simulate(app.AN); renderItems(); renderOverlay(); renderTabs(); renderStatus(); scheduleSave();
}

export function panelClick(e) {
  const q = s => e.target.closest(s);
  let el;
  if ((el = q('[data-tab]'))) { app.tab = el.dataset.tab; if (app.tab !== 'guide') app.guideStep = -1; renderTabs(); renderOverlay(); return; }
  if ((el = q('[data-toggle]'))) { const c = compById(+el.dataset.toggle); if (c) commit(() => { c.p.on = !c.p.on; }); return; }
  if ((el = q('[data-press]'))) { const c = compById(+el.dataset.press); if (c) commit(() => { c.p.pressed = !c.p.pressed; }); return; }
  if ((el = q('[data-flip]'))) { const c = compById(+el.dataset.flip); if (c) commit(() => { c.p.pos = c.p.pos ? 0 : 1; }); return; }
  if ((el = q('[data-tog]'))) { const tg = targetObj(); if (tg) { const k = el.dataset.tog; commit(() => { tg.obj[k] = !tg.obj[k]; }); } return; }
  if ((el = q('[data-mlev]'))) { const key = el.dataset.mlev; commit(() => { const [mid, pid] = mkSplit(key); mcuPinSet(key, 'level', mcuCfg(mid, pid).level ? 0 : 1); }); return; }
  if ((el = q('[data-sel]'))) { app.selected = { kind: 'comp', id: +el.dataset.sel }; app.multi = null; const c = compById(app.selected.id); if (c) { app.flash = { c: c.c, r: c.r, t: Date.now() }; scrollToHole(c.c, c.r); } renderOverlay(); renderInspector(); setTimeout(renderOverlay, 2600); return; }
  if ((el = q('[data-mcusel]')) || (el = q('[data-selmcu]'))) { if (e.target.closest('[data-rmmcu]')) { const id = +e.target.closest('[data-rmmcu]').dataset.rmmcu; commit(() => { removeMcu(id); }); return; } const id = +(el.dataset.mcusel || el.dataset.selmcu); app.selected = { kind: 'mcu', id }; app.multi = null; const mo = mcuById(id); if (mo) scrollToWorld(mo.x + 4, mo.y + 6); renderOverlay(); renderInspector(); renderTabs(); return; }
  if ((el = q('[data-selboard]'))) { if (e.target.closest('[data-rmboard]')) { const id = +e.target.closest('[data-rmboard]').dataset.rmboard; commit(() => { removeBoard(id); }); return; } const id = +el.dataset.selboard; app.selected = { kind: 'board', id }; app.multi = null; const b = app.S.boards.find(b => b.id === id); if (b) scrollToWorld(b.x + boardDims(b)[0] / 2, b.y + boardDims(b)[1] / 2); renderOverlay(); renderInspector(); renderTabs(); return; }
  if ((el = q('[data-lib]'))) { setTool('place', el.dataset.lib); say('Clique num espaço livre da bancada.'); return; }
  if ((el = q('[data-trace]'))) { const t = app.S.traces.find(t => t.id === +el.dataset.trace); if (t) { app.selected = { kind: 'trace', id: t.id }; app.multi = null; scrollToHole(t.pts[0][0], t.pts[0][1]); } renderOverlay(); renderInspector(); renderTabs(); return; }
  if ((el = q('[data-issue]'))) { const is = issueCache[+el.dataset.issue]; if (is) { app.multi = null; if (is.tids && is.tids.length) app.selected = { kind: 'trace', id: is.tids[0] }; if (is.at) { app.flash = { c: is.at.c, r: is.at.r, t: Date.now() }; scrollToHole(is.at.c, is.at.r); } else if (is.mcu) { app.selected = { kind: 'mcu', id: is.mcu }; const mo = mcuById(is.mcu); if (mo) scrollToWorld(mo.x + 4, mo.y + 6); } else if (is.code) { openCode(is.mcu || (RT.mid)); } renderOverlay(); renderInspector(); setTimeout(renderOverlay, 2600); } return; }
  if ((el = q('[data-dellink]'))) { const i = +el.dataset.dellink; commit(() => deleteHit({ kind: 'link', i })); return; }
  if ((el = q('[data-guide]'))) { app.guideStep = +el.dataset.guide; renderTabs(); renderOverlay(); return; }
  if ((el = q('[data-act]'))) {
    const a = el.dataset.act;
    if (a === 'rot') rotateSelected();
    else if (a === 'del' && app.selected) { const sel = Object.assign({}, app.selected, { seg: null }); commit(() => deleteHit(sel)); }
    else if (a === 'dup' || a === 'dupsel') duplicateSel();
    else if (a === 'copy') copySel();
    else if (a === 'code' && app.selected && app.selected.kind === 'mcu') openCode(app.selected.id);
    else if (a === 'unlabel') { const { c, r } = app.selected, pk = app.AN.holeKey(hk(c, r)); commit(() => { app.S.labels = app.S.labels.filter(l => app.AN.holeKey(hk(l.h[0], l.h[1])) !== pk); }); }
    else if (a === 'block') { app.blockCross = !app.blockCross; renderTabs(); }
    else if (a === 'tags') { app.showTags = !app.showTags; renderAll(); }
    else if (a === 'netcol') { app.netColors = !app.netColors; renderAll(); }
    else if (a === 'capture') captureLinks();
    else if (a === 'clearlinks') commit(() => { app.S.links = []; });
  }
}

export function captureLinks() {
  const links = [];
  for (const [, mem] of app.AN.nodeMembers) {
    const eps = mem.map(m => m.mcu ? { mcu: mkSplit(m.mcu) } : { pin: [m.comp.id, m.i] }).filter(ep => !(ep.mcu && !app.AN.mcuUsed.has(mk(ep.mcu[0], ep.mcu[1]))));
    const uniq = []; for (const ep of eps) if (!(ep.mcu && ep.mcu[1].startsWith('GND') && uniq.some(u => u.mcu && u.mcu[0] === ep.mcu[0] && u.mcu[1].startsWith('GND')))) uniq.push(ep);
    for (let i = 1; i < uniq.length; i++) links.push({ a: uniq[0], b: uniq[i] });
  }
  if (!links.length) { say('A bancada ainda não tem pinos ligados entre si para capturar.', true); return; }
  commit(() => { app.S.links = links; }); say(`${links.length} ligações capturadas. Daqui em diante a montagem é conferida contra esse esquema.`);
}

export function scrollToWorld(x, y) {
  const [vx, vy] = toView(x, y), rect = svg.getBoundingClientRect(), sr = stage.getBoundingClientRect();
  stage.scrollTo({ left: stage.scrollLeft + rect.left - sr.left + vx * app.zoom - stage.clientWidth / 2, top: stage.scrollTop + rect.top - sr.top + vy * app.zoom - stage.clientHeight / 2, behavior: 'smooth' });
}

export const scrollToHole = (c, r) => scrollToWorld(c, r);


/** Efeitos de inicialização do módulo (eventos, DOM). Chamado por main.ts na ordem certa. */
export function mount() {
  stage.addEventListener('wheel', e => {
    e.preventDefault();
    if (e.shiftKey && !e.ctrlKey) { stage.scrollLeft += e.deltaY || e.deltaX; return; }
    const k = Math.exp(-(e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY) * (e.ctrlKey ? 0.01 : 0.0015));
    setZoom(app.zoom * k, e.clientX, e.clientY);
  }, { passive: false });
  stage.addEventListener('mousedown', e => { if (e.button === 1) e.preventDefault(); });
  svg.addEventListener('pointerdown', e => {
    hideCtx();
    if (e.button === 2) return;
    const pt = evtPoint(e); if (!pt) return;
    if (e.button === 1 || (e.button === 0 && app.spaceDown)) { startPan(e); return; }
    const h = holeAt(pt.f);
    if (app.tool === 'select') {
      const pr = mcuPinAt(pt.v);
      const hit = pr ? { kind: 'mcu', id: pr[0] } : hitTest(pt);
      // botão apertado com o mouse enquanto o código roda
      if (hit && hit.kind === 'comp' && typeof RT !== 'undefined' && RT.running) { const c = compById(hit.id); if (c.type === 'btn') { pressBtn = c.id; c.p.pressed = true; changed({ noSave: true }); svg.setPointerCapture(e.pointerId); return; } if (c.type === 'sw') { c.p.pos = c.p.pos ? 0 : 1; changed({ noSave: true }); return; } }
      if (e.shiftKey && hit && ['comp', 'trace', 'wire'].includes(hit.kind)) {
        const spec = selSpec() || { comps: [], traces: [], wires: [] }, key = { comp: 'comps', trace: 'traces', wire: 'wires' }[hit.kind], arr = spec[key], i = arr.indexOf(hit.id);
        if (i >= 0) arr.splice(i, 1); else arr.push(hit.id);
        setMulti(spec); renderOverlay(); renderInspector(); return;
      }
      const inMulti = app.multi && hit && ((hit.kind === 'comp' && app.multi.comps.has(hit.id)) || (hit.kind === 'trace' && app.multi.traces.has(hit.id)) || (hit.kind === 'wire' && app.multi.wires.has(hit.id)));
      if (!inMulti) { app.multi = null; app.selected = hit || (h ? { kind: 'hole', c: h.c, r: h.r } : null); }
      if (hit && hit.kind === 'trace' && !inMulti) { app.tab = 'traces'; renderTabs(); }
      if (hit && (hit.kind === 'comp' || inMulti)) { const spec = inMulti ? selSpec() : { comps: [hit.id], traces: [], wires: [] }; app.drag = { kind: 'items', spec, ids: new Set(spec.comps), f0: [Math.round(pt.f[0]), Math.round(pt.f[1])], d: [0, 0], snap: snapshot() }; svg.setPointerCapture(e.pointerId); }
      else if (hit && hit.kind === 'board') { const b = app.S.boards.find(b => b.id === hit.id); app.drag = { kind: 'board', id: b.id, f0: [Math.round(pt.f[0]), Math.round(pt.f[1])], d: [0, 0], snap: snapshot(), ok: true }; svg.setPointerCapture(e.pointerId); }
      else if (hit && hit.kind === 'mcu') { app.drag = { kind: 'mcu', id: hit.id, f0: [Math.round(pt.f[0]), Math.round(pt.f[1])], d: [0, 0], snap: snapshot(), ok: true }; svg.setPointerCapture(e.pointerId); }
      else if (!hit && !h) { if (e.pointerType === 'touch') startPan(e); else { app.box = { x0: pt.v[0], y0: pt.v[1], x1: pt.v[0], y1: pt.v[1] }; svg.setPointerCapture(e.pointerId); } }
      renderOverlay(); renderInspector(); renderStatus();
    } else if (app.tool === 'place') {
      const it = LIBMAP[app.libKey];
      if (it[2] === 'board' || it[2] === 'mcu') { placeObject(app.libKey, pt.f); return; }
      if (!h) { say('Coloque a peça num furo de uma placa.', true); return; }
      const g = makeComp(app.libKey, h.c, h.r, app.ghostRot, true);
      if (!validComp(g)) { say('Algum pino cai fora da placa ou num furo ocupado.', true); return; }
      commit(() => { app.S.comps.push(makeComp(app.libKey, h.c, h.r, app.ghostRot, false)); });
      if (overlapsBody(g)) say('Colocado, mas o corpo encosta em outra peça.', true);
    } else if (app.tool === 'paste') {
      if (!h) return;
      if (pasteAt(h)) { setTool('select'); app.selected = app.multi ? { kind: 'multi' } : app.selected; renderInspector(); renderOverlay(); say('Colado.'); } else say('Não cabe aí: algum pino cairia fora da placa ou sobre outro.', true);
    } else if (app.tool === 'trace') {
      if (!h) return;
      const b = boardAt(h.c, h.r);
      if (b.kind === 'bread') { say('No protoboard não se desenha trilha: use fios (J).', true); return; }
      const p = [h.c, h.r];
      if (!app.drawing) app.drawing = { pts: [p], board: b.id };
      else {
        if (b.id !== app.drawing.board) { say('Uma trilha fica numa placa só. Para ligar placas diferentes, use um fio (J).', true); return; }
        const last = app.drawing.pts[app.drawing.pts.length - 1];
        if (last[0] === p[0] && last[1] === p[1]) { finishTrace(); return; }
        const nx = lPath(last, p);
        let prev = last, conf = []; for (const q of nx) { conf = conf.concat(segConflicts(prev, q)); prev = q; }
        if (conf.length && app.blockCross) { say(`Trecho bloqueado: ${conf[0].why} em ${hname(Math.floor(conf[0].c), Math.floor(conf[0].r))}. Desvie, pare antes, ou clique no próprio furo para ligar de propósito.`, true); return; }
        app.drawing.pts.push(...nx);
      }
      renderOverlay(); renderStatus();
    } else if (app.tool === 'wire') {
      const ep = pickWireEp(pt); if (ep === false) return; if (!ep) { app.wireStart = null; renderOverlay(); return; }
      if (!app.wireStart) app.wireStart = ep;
      else if (sameEp(app.wireStart, ep)) app.wireStart = null;
      else {
        const a = app.wireStart, b = ep, pn = [a, b].filter(x => x.mcu).map(x => x.mcu[1]).join(' ');
        const color = /GND/.test(pn) ? 'preto' : /5V|3V3|VIN/.test(pn) ? 'vermelho' : nextWireColor();
        commit(() => { app.S.wires.push({ id: app.S.nextId++, a, b, color, name: '' }); }); app.wireStart = null;
      }
      renderOverlay(); renderStatus();
    } else if (app.tool === 'link') {
      const ep = pickLinkEp(pt); if (!ep) { app.linkStart = null; say('Clique num pino de componente ou do microcontrolador.', true); renderOverlay(); return; }
      if (!app.linkStart) app.linkStart = ep;
      else if (sameEp(app.linkStart, ep)) app.linkStart = null;
      else { const a = app.linkStart; commit(() => { app.S.links.push({ a, b: ep }); }); app.linkStart = ep; say('Ligação adicionada ao esquema. Continue clicando para encadear, ou Esc.'); }
      renderOverlay(); renderStatus();
    } else if (app.tool === 'solder') {
      if (!h) return;
      if (kindAt(h.c, h.r) === 'bread') { say('No protoboard não há solda: os pinos encostam nos contatos.', true); return; }
      commit(() => { const i = app.S.solder.findIndex(([c, r]) => c === h.c && r === h.r); if (i >= 0) app.S.solder.splice(i, 1); else app.S.solder.push([h.c, h.r]); });
    } else if (app.tool === 'cut') {
      if (!h) return;
      if (kindAt(h.c, h.r) !== 'strip') { say('Cortar trilha só vale no veroboard.', true); return; }
      if (app.AN.occ.has(hk(h.c, h.r))) { say('Não dá para cortar num furo ocupado por pino.', true); return; }
      commit(() => { const i = app.S.cuts.findIndex(([c, r]) => c === h.c && r === h.r); if (i >= 0) app.S.cuts.splice(i, 1); else app.S.cuts.push([h.c, h.r]); });
    } else if (app.tool === 'erase') {
      const hit = hitTest(pt, false);
      if (hit) { commit(() => deleteHit(hit)); return; }
      for (let i = 0; i < app.S.links.length; i++) { const l = app.S.links[i]; if (!app.AN.missing.includes(l)) continue; const a = epPos(l.a), b = epPos(l.b); if (a && b && distSeg(pt.v[0], pt.v[1], a[0], a[1], b[0], b[1]) < 6) { commit(() => deleteHit({ kind: 'link', i })); return; } }
      if (h) { const si = app.S.solder.findIndex(([c, r]) => c === h.c && r === h.r); if (si >= 0) { commit(() => { app.S.solder.splice(si, 1); }); return; } const ci = app.S.cuts.findIndex(([c, r]) => c === h.c && r === h.r); if (ci >= 0) { commit(() => { app.S.cuts.splice(ci, 1); }); return; } const li = app.S.labels.findIndex(l => l.h[0] === h.c && l.h[1] === h.r); if (li >= 0) commit(() => { app.S.labels.splice(li, 1); }); }
      else { const o = hitTest(pt); if (o && (o.kind === 'board' || o.kind === 'mcu')) say('Para remover uma placa ou microcontrolador, selecione e use Excluir, ou clique com o botão direito.', true); }
    }
  });
  svg.addEventListener('pointermove', e => {
    const pt = evtPoint(e); if (!pt) return;
    if (app.pan) { stage.scrollLeft = app.pan.sl - (e.clientX - app.pan.x); stage.scrollTop = app.pan.st - (e.clientY - app.pan.y); return; }
    if (app.box) { app.box.x1 = pt.v[0]; app.box.y1 = pt.v[1]; renderOverlay(); return; }
    const h = holeAt(pt.f);
    const changedHover = (h && app.hover) ? (h.c !== app.hover.c || h.r !== app.hover.r) : (h !== app.hover);
    app.hover = h; app.hoverV = pt.v; const fOld = app.hoverF; app.hoverF = pt.f;
    if (app.drag) { applyDrag(pt); return; }
    const objGhost = app.tool === 'place' && app.libKey && ['board', 'mcu'].includes(LIBMAP[app.libKey][2]) && (!fOld || Math.round(fOld[0]) !== Math.round(pt.f[0]) || Math.round(fOld[1]) !== Math.round(pt.f[1]));
    if (changedHover || objGhost || app.tool === 'wire' || app.tool === 'link' || (app.tool === 'select' && !h)) { cancelAnimationFrame(rafMove); rafMove = requestAnimationFrame(() => { renderOverlay(); renderStatus(); }); }
  });
  svg.addEventListener('pointerup', e => {
    if (app.pan) { app.pan = null; stage.classList.remove('panning'); return; }
    if (pressBtn != null) { const c = compById(pressBtn); if (c) c.p.pressed = false; pressBtn = null; changed({ noSave: true }); return; }
    if (app.box) {
      const a = fromView(app.box.x0, app.box.y0), b = fromView(app.box.x1, app.box.y1), R = [Math.min(a[0], b[0]), Math.max(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[1], b[1])];
      const inR = (x, y) => x >= R[0] && x <= R[1] && y >= R[2] && y <= R[3];
      const small = Math.abs(app.box.x1 - app.box.x0) < 4 && Math.abs(app.box.y1 - app.box.y0) < 4;
      app.box = null;
      if (small) { app.multi = null; app.selected = null; }
      else setMulti({ comps: app.S.comps.filter(c => { const A = compAABB(c); return inR((A[0] + A[1]) / 2, (A[2] + A[3]) / 2); }).map(c => c.id), traces: app.S.traces.filter(t => t.pts.every(p => inR(p[0], p[1]))).map(t => t.id), wires: app.S.wires.filter(w => w.a.h && w.b.h && inR(w.a.h[0], w.a.h[1]) && inR(w.b.h[0], w.b.h[1])).map(w => w.id) });
      renderOverlay(); renderInspector(); return;
    }
    if (!app.drag) return;
    const dg = app.drag; app.drag = null;
    if (!dg.moved) { app.S = JSON.parse(dg.snap); renderItems(); renderOverlay(); return; }
    if (dg.kind === 'items') { if (!specValid(dg.spec)) { app.S = JSON.parse(dg.snap); say('Posição inválida: algum pino ficaria fora da placa ou sobre outro.', true); changed({ noSave: true }); return; } }
    else if (!dg.ok) { app.S = JSON.parse(dg.snap); say('Encostaria em outro objeto da bancada.', true); changed({ noSave: true }); return; }
    app.undoStack.push(dg.snap); app.redoStack = []; changed();
    if (dg.kind === 'items' && dg.spec.comps.length === 1 && overlapsBody(compById(dg.spec.comps[0]))) say('O corpo encosta em outra peça.', true);
  });
  svg.addEventListener('pointerleave', () => { if (!app.drag && !app.pan && !app.box) { app.hover = null; app.hoverV = null; app.hoverF = null; renderOverlay(); renderStatus(); } });
  ctx.className = 'ctx';
  ctx.hidden = true;
  ctx.setAttribute('role', 'menu');
  document.body.appendChild(ctx);
  ctx.addEventListener('click', e => { const b = e.target.closest('[data-ci]'); if (!b) return; const it = ctxActs[+b.dataset.ci]; hideCtx(); if (it && it.f) it.f(); });
  ctx.addEventListener('keydown', e => { if (e.key === 'Escape') hideCtx(); if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); const bs = [...ctx.querySelectorAll('button:not([disabled])')], i = bs.indexOf(document.activeElement); bs[(i + (e.key === 'ArrowDown' ? 1 : -1) + bs.length) % bs.length].focus(); } });
  document.addEventListener('pointerdown', e => { if (!ctx.hidden && !ctx.contains(e.target)) hideCtx(); });
  svg.addEventListener('contextmenu', e => {
    e.preventDefault();
    if (app.tool === 'trace' && app.drawing) { finishTrace(); return; }
    if (app.wireStart || app.linkStart) { app.wireStart = null; app.linkStart = null; renderOverlay(); return; }
    if (app.tool !== 'select') setTool('select');
    const pt = evtPoint(e); if (!pt) return;
    const pr = mcuPinAt(pt.v), hit = pr ? { kind: 'mcu', id: pr[0] } : hitTest(pt), h = holeAt(pt.f);
    const inMulti = app.multi && hit && ((hit.kind === 'comp' && app.multi.comps.has(hit.id)) || (hit.kind === 'trace' && app.multi.traces.has(hit.id)) || (hit.kind === 'wire' && app.multi.wires.has(hit.id)));
    if (!inMulti) { app.multi = null; app.selected = hit || (h ? { kind: 'hole', c: h.c, r: h.r } : null); }
    renderOverlay(); renderInspector();
    const del = () => { const sel = Object.assign({}, app.selected, { seg: null }); commit(() => deleteHit(sel)); };
    let items;
    if (inMulti || (app.selected && app.selected.kind === 'multi')) items = [{ t: 'Copiar', k: 'Ctrl+C', f: copySel }, { t: 'Duplicar', k: 'Ctrl+D', f: duplicateSel }, '-', { t: 'Excluir seleção', k: 'Del', danger: true, f: del }];
    else if (hit && hit.kind === 'comp') { const c = compById(hit.id); items = [{ t: `${c.p.name} · ${CT[c.type].label(c)}`, dis: true }, '-', { t: 'Girar', k: 'R', f: rotateSelected }, { t: 'Duplicar', k: 'Ctrl+D', f: duplicateSel }, { t: 'Copiar', k: 'Ctrl+C', f: copySel }, c.type === 'btn' ? { t: c.p.pressed ? 'Soltar botão' : 'Apertar botão', f: () => commit(() => { c.p.pressed = !c.p.pressed; }) } : null, '-', { t: 'Excluir', k: 'Del', danger: true, f: del }]; }
    else if (hit && hit.kind === 'trace') { const t = app.S.traces.find(t => t.id === hit.id); items = [{ t: `Trilha T${t.tag}${t.name ? ' · ' + t.name : ''}`, dis: true }, '-', { t: 'Renomear / cor…', f: () => { const i = $('f_name'); if (i) { i.focus(); i.select(); } } }, { t: 'Copiar', k: 'Ctrl+C', f: copySel }, '-', { t: 'Excluir este trecho', danger: true, f: () => commit(() => deleteHit(hit)) }, { t: 'Excluir trilha inteira', k: 'Del', danger: true, f: del }]; }
    else if (hit && hit.kind === 'wire') items = [{ t: 'Fio', dis: true }, '-', { t: 'Renomear / cor…', f: () => { const i = $('f_name'); if (i) { i.focus(); i.select(); } } }, { t: 'Excluir fio', k: 'Del', danger: true, f: del }];
    else if (hit && hit.kind === 'board') { const b = app.S.boards.find(b => b.id === hit.id), n = itemsOnBoard(b); items = [{ t: `${b.name} · ${boardLabel(b)}`, dis: true }, '-', { t: 'Propriedades da placa…', f: () => { const i = $('b_size') || $('f_name'); if (i) i.focus(); } }, { t: 'Enquadrar tudo', k: 'F', f: fitAll }, '-', { t: `Remover placa${n ? ` e ${n} itens` : ''}`, k: 'Del', danger: true, f: del }]; }
    else if (hit && hit.kind === 'mcu') { const mo = mcuById(hit.id); items = [{ t: mo.name, dis: true }, '-', { t: 'Abrir código', f: () => openCode(mo.id) }, typeof RT !== 'undefined' && RT.running && RT.mid === mo.id ? { t: 'Parar código', f: stopCode } : { t: 'Rodar código', f: () => { openCode(mo.id); runCode(); } }, { t: 'Configurar pinos…', f: () => {} }, '-', { t: 'Remover microcontrolador', k: 'Del', danger: true, f: del }]; }
    else {
      const b = h ? boardAt(h.c, h.r) : null;
      items = [app.clipboard ? { t: 'Colar aqui', k: 'Ctrl+V', f: () => { if (h && pasteAt(h)) say('Colado.'); else if (!h) setTool('paste'); else say('Não cabe aí.', true); } } : null,
        h && b && b.kind !== 'bread' ? { t: 'Soldar / tirar solda neste furo', f: () => commit(() => { const i = app.S.solder.findIndex(([c, r]) => c === h.c && r === h.r); if (i >= 0) app.S.solder.splice(i, 1); else app.S.solder.push([h.c, h.r]); }) } : null,
        h ? { t: 'Nomear esta rede…', f: () => { const i = $('f_net'); if (i) i.focus(); } } : null,
        { t: 'Selecionar tudo', k: 'Ctrl+A', f: selectAll }, { t: 'Enquadrar tudo', k: 'F', f: fitAll }, '-',
        ...LIB[0][1].map(it => ({ t: `Adicionar ${it[1]}`, f: () => { setTool('place', it[0]); if (!h) placeObject(it[0], pt.f); } }))];
    }
    showCtx(e.clientX, e.clientY, items);
  });
  // ─── teclado ───
  document.addEventListener('keydown', e => {
    const t = e.target; if (t && (t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.tagName === 'TEXTAREA')) return;
    if (!$('projModal').hidden || !$('helpModal').hidden) { if (e.key === 'Escape') { $('projModal').hidden = true; $('helpModal').hidden = true; } return; }
    const k = e.key.toLowerCase(), mod = e.ctrlKey || e.metaKey;
    if (e.key === ' ') { e.preventDefault(); if (!app.spaceDown) { app.spaceDown = true; stage.classList.add('grab'); } return; }
    if (mod && k === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo(); return; }
    if (mod && k === 'y') { e.preventDefault(); redo(); return; }
    if (mod && k === 's') { e.preventDefault(); flushSave(); return; }
    if (mod && k === 'c') { e.preventDefault(); copySel(); return; }
    if (mod && k === 'x') { e.preventDefault(); if (copySel()) { const sel = Object.assign({}, app.selected, { seg: null }); commit(() => deleteHit(sel)); } return; }
    if (mod && k === 'v') { e.preventDefault(); if (!app.clipboard) { say('Nada copiado ainda.', true); return; } if (app.hover && pasteAt(app.hover)) { say('Colado.'); return; } setTool('paste'); say('Clique onde quer colar. Esc cancela.'); return; }
    if (mod && k === 'd') { e.preventDefault(); duplicateSel(); return; }
    if (mod && k === 'a') { e.preventDefault(); selectAll(); return; }
    if (mod && (k === '0')) { e.preventDefault(); fitAll(); return; }
    if (mod && (k === '=' || k === '+')) { e.preventDefault(); setZoom(app.zoom * 1.2); return; }
    if (mod && k === '-') { e.preventDefault(); setZoom(app.zoom / 1.2); return; }
    if (mod || e.altKey) return;
    if (k === '?' || (k === '/' && e.shiftKey)) { $('helpModal').hidden = false; return; }
    const arrows = { arrowleft: [-1, 0], arrowright: [1, 0], arrowup: [0, -1], arrowdown: [0, 1] };
    if (arrows[k]) { e.preventDefault(); const [dx, dy] = arrows[k], m = e.shiftKey ? 5 : 1; nudge(dx * m * (app.view === 'bottom' ? -1 : 1), dy * m); return; }
    const map = { v: 'select', t: 'trace', j: 'wire', s: 'solder', x: 'cut', l: 'link', e: 'erase' };
    if (map[k]) { setTool(map[k]); return; }
    if (QUICK[k]) { setTool('place', QUICK[k]); return; }
    if (k === 'f') { fitAll(); return; }
    if (k === '+' || k === '=') { setZoom(app.zoom * 1.2); return; }
    if (k === '-') { setZoom(app.zoom / 1.2); return; }
    if (k === 'b') { app.view = app.view === 'top' && (hasKind('perf') || hasKind('strip')) ? 'bottom' : 'top'; changed({ noSave: true }); return; }
    if (k === 'r') { rotateSelected(); return; }
    if (k === 'enter' && app.tool === 'trace') { finishTrace(); return; }
    if (k === 'escape') { hideCtx(); if (app.drawing || app.wireStart || app.linkStart) { app.drawing = null; app.wireStart = null; app.linkStart = null; renderOverlay(); renderStatus(); } else if (app.tool !== 'select') setTool('select'); else { app.selected = null; app.multi = null; renderOverlay(); renderInspector(); } return; }
    if ((k === 'delete' || k === 'backspace') && app.selected && app.selected.kind !== 'hole') { e.preventDefault(); const sel = Object.assign({}, app.selected, { seg: null }); commit(() => deleteHit(sel)); }
  });
  document.addEventListener('keyup', e => { if (e.key === ' ') { app.spaceDown = false; stage.classList.remove('grab'); } });
  window.addEventListener('blur', () => { app.spaceDown = false; stage.classList.remove('grab'); });
  for (const id of ['inspector', 'tabBody', 'tabs']) { $(id).addEventListener('change', panelChange); $(id).addEventListener('input', panelInput); $(id).addEventListener('click', panelClick); }
  $('tabBody').addEventListener('keydown', e => { if (e.key === 'Enter') panelClick(e); });
  $('tabBody').addEventListener('mouseover', e => { const r = e.target.closest('[data-trace]'); const id = r ? +r.dataset.trace : null; if (id !== app.hoverTrace) { app.hoverTrace = id; renderOverlay(); } });
  $('tabBody').addEventListener('mouseleave', () => { if (app.hoverTrace != null) { app.hoverTrace = null; renderOverlay(); } });
  $('tools').addEventListener('click', e => { const b = e.target.closest('[data-tool]'); if (b && !b.disabled) setTool(b.dataset.tool); });
  $('lib').addEventListener('click', e => { const b = e.target.closest('[data-lib]'); if (b) { setTool('place', b.dataset.lib); if (['board', 'mcu'].includes(LIBMAP[b.dataset.lib][2])) say('Clique num espaço livre da bancada para colocar.'); } });
  $('libSearch').addEventListener('input', renderLib);
  $('libChips').addEventListener('click', e => { const b = e.target.closest('button'); if (!b) return; if (b.dataset.used) { app.libUsed = !app.libUsed; app.libCat = ''; } else { app.libCat = b.dataset.cat; app.libUsed = false; } renderLib(); });
  $('bSolderAll').onclick = () => {
    const miss = []; for (const c of app.S.comps) for (const p of pinsOf(c)) if (inBoard(p.c, p.r) && kindAt(p.c, p.r) !== 'bread' && !app.AN.soldered.has(hk(p.c, p.r))) miss.push([p.c, p.r]);
    if (!miss.length) { say('Todos os pinos já estão soldados.'); return; }
    commit(() => { app.S.solder.push(...miss); }); say(`${miss.length} pino${miss.length > 1 ? 's' : ''} soldado${miss.length > 1 ? 's' : ''}.`);
  };
  $('bUndo').onclick = undo;
  $('bRedo').onclick = redo;
  $('vTop').onclick = () => { app.view = 'top'; changed({ noSave: true }); };
  $('vBot').onclick = () => { if (!hasKind('perf') && !hasKind('strip')) return; app.view = 'bottom'; changed({ noSave: true }); };
  $('bXray').onclick = () => { app.xray = !app.xray; renderAll(); };
  $('bTags').onclick = () => { app.showTags = !app.showTags; renderAll(); };
  $('bNetCol').onclick = () => { app.netColors = !app.netColors; renderAll(); };
  $('zIn').onclick = () => setZoom(app.zoom * 1.2);
  $('zOut').onclick = () => setZoom(app.zoom / 1.2);
  $('zFit').onclick = fitAll;
  $('bHelp').onclick = () => { $('helpModal').hidden = false; };
  $('helpClose').onclick = () => { $('helpModal').hidden = true; };
  $('helpModal').addEventListener('click', e => { if (e.target.id === 'helpModal') $('helpModal').hidden = true; });
}
