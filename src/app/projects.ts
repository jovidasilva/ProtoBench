// @ts-nocheck
import { app } from '../state';
import { get as idbGet, set as idbSet, del as idbDel } from 'idb-keyval';
import { $, BPREFIX, SIZES, boardDefault, boardLabel, esc, uid } from '../core/base';
import { MCU, analyze, pinsOf } from '../core/analysis';
import { simulate } from '../sim/solver';
import { setDims, setupSvg } from '../ui/render';
import { buildThumbs, changed, renderChrome, renderLib, say } from '../ui/panels';
import { emptyState, fitAll, normalize, setZoom } from '../ui/interaction';
import { stopCode } from '../code/arduino';

// ════════════════════════ Projetos salvos ════════════════════════
// Projetos ficam no IndexedDB do navegador (idb-keyval). O localStorage só guarda um rascunho de emergência no pagehide.
export let PROJ = { id: null, name: 'Circuito sem nome' };

const K_IDX = 'pb:idx', K_LAST = 'pb:last', K_DRAFT = 'pb:draft', kp = id => 'pb:p:' + id;
const lget = k => { try { return localStorage.getItem(k); } catch (e) { return null; } };
const lset = (k, v) => { try { localStorage.setItem(k, v); return true; } catch (e) { return false; } };
const ldel = k => { try { localStorage.removeItem(k); } catch (e) {} };

export const Store = {
  idx: [], ok: true,
  async init() {
    try {
      this.idx = (await idbGet(K_IDX)) || [];
      // rascunho de emergência gravado no pagehide
      const d = JSON.parse(lget(K_DRAFT) || 'null');
      if (d && d.id) { const m = this.idx.find(x => x.id === d.id); if (!m || (m.updated || 0) < d.updated) await this.save(d.id, d.name, d.state, d.updated); ldel(K_DRAFT); }
      navigator.storage?.persist?.().catch(() => {});
    } catch (e) { this.ok = false; }
  },
  summary(st) { const bs = st.boards || (st.board ? [st.board] : []), ms = st.mcus || (st.mcu ? [st.mcu] : []); return { board: bs.map(b => boardLabel(Object.assign(boardDefault(), b))).join(' + ') || 'bancada vazia', parts: st.comps.length, traces: st.traces.length, mcu: ms.map(m => MCU[m.type].label).join(', ') }; },
  index() { return this.idx; },
  async save(id, name, state, updated = Date.now()) {
    const summary = this.summary(state);
    this.idx = this.idx.filter(m => m.id !== id); this.idx.push({ id, name, updated, summary });
    try { await idbSet(kp(id), JSON.parse(JSON.stringify(state))); await idbSet(K_IDX, this.idx); return { local: true }; }
    catch (e) { return { local: false, err: e }; }
  },
  async list() { return [...this.idx].sort((a, b) => (b.updated || 0) - (a.updated || 0)); },
  async load(id) { try { return (await idbGet(kp(id))) || null; } catch (e) { return null; } },
  async remove(id) { this.idx = this.idx.filter(m => m.id !== id); try { await idbDel(kp(id)); await idbSet(K_IDX, this.idx); } catch (e) {} },
  async rename(id, name) { const st = await this.load(id); if (st) await this.save(id, name, st); },
  setLast(id) { idbSet(K_LAST, id).catch(() => {}); },
  getLast() { return idbGet(K_LAST).catch(() => null); },
  draft() { if (PROJ.id) lset(K_DRAFT, JSON.stringify({ id: PROJ.id, name: PROJ.name, updated: Date.now(), state: app.S })); },
};

export let saveTimer = null, saving = false;
export function setSaveState(txt, cls) { const el = $('saveState'); el.textContent = txt; el.className = 'savestate' + (cls ? ' ' + cls : ''); }

export function scheduleSave() {
  if (!PROJ.id) { PROJ.id = uid(); Store.setLast(PROJ.id); }
  setSaveState('alterações não salvas');
  clearTimeout(saveTimer); saveTimer = setTimeout(flushSave, 1200);
}

export async function flushSave() {
  clearTimeout(saveTimer); saveTimer = null;
  if (!PROJ.id) { PROJ.id = uid(); Store.setLast(PROJ.id); }
  setSaveState('salvando…');
  const r = await Store.save(PROJ.id, PROJ.name, app.S);
  if (r.local) setSaveState('salvo neste navegador ✓', 'ok');
  else setSaveState('não foi possível salvar', 'warn');
}

export function openState(st, meta) {
  app.S = normalize(st); PROJ = { id: meta.id || null, name: meta.name || 'Circuito sem nome' };
  if (PROJ.id) Store.setLast(PROJ.id);
  app.undoStack = []; app.redoStack = []; app.selected = null; app.drawing = null; app.wireStart = null; app.linkStart = null; app.guideStep = -1;
  app.view = 'top';
  if (typeof stopCode === 'function') stopCode(true);
  changed({ noSave: true }); renderLib(); requestAnimationFrame(fitAll);
  setSaveState(PROJ.id ? 'salvo ✓' : 'exemplo (edite para salvar como projeto)', PROJ.id ? 'ok' : '');
}

// ─── janela de projetos ───
export const NEWBOARDS = [['perf:7x9', 'Perfurada 7×9 cm'], ['perf:5x7', 'Perfurada 5×7 cm'], ['perf:9x15', 'Perfurada 9×15 cm'], ['strip:7x9', 'Veroboard 7×9 cm'], ['bread:830', 'Protoboard 830'], ['bread:400', 'Protoboard 400']];

export let pConfirm = null, pRename = null;

export async function renderProjects() {
  $('storeMode').textContent = Store.ok ? '· salvos neste navegador (IndexedDB)' : '· armazenamento indisponível: exporte seus projetos';
  $('plist').innerHTML = '<p class="note">Carregando…</p>';
  const list = await Store.list();
  if (!list.length) { $('plist').innerHTML = '<p class="note">Nenhum projeto salvo ainda. Qualquer alteração na placa cria um projeto automaticamente.</p>'; return; }
  $('plist').innerHTML = list.map(m => {
    const s = m.summary || {}, d = m.updated ? new Date(m.updated).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' }) : '';
    const title = pRename === m.id ? `<input id="renameIn" value="${esc(m.name)}" maxlength="60" aria-label="Novo nome">` : `<div class="t">${esc(m.name)}</div>`;
    const acts = pConfirm === m.id ? `<span class="small">Excluir de vez?</span><button class="btn sm danger" data-pa="delok" data-id="${m.id}">Excluir</button><button class="btn sm" data-pa="cancel">Cancelar</button>` : pRename === m.id ? `<button class="btn sm primary" data-pa="renok" data-id="${m.id}">Salvar nome</button><button class="btn sm" data-pa="cancel">Cancelar</button>` : `<button class="btn sm primary" data-pa="open" data-id="${m.id}">Abrir</button><button class="btn sm" data-pa="ren" data-id="${m.id}">Renomear</button><button class="btn sm" data-pa="dup" data-id="${m.id}">Duplicar</button><button class="btn sm" data-pa="exp" data-id="${m.id}">Exportar</button><button class="btn sm danger" data-pa="del" data-id="${m.id}">Excluir</button>`;
    return `<div class="pitem${m.id === PROJ.id ? ' cur' : ''}"><div>${title}<div class="m">${esc([s.board, s.parts != null ? s.parts + ' peças' : '', s.traces ? s.traces + ' trilhas' : '', s.mcu, d].filter(Boolean).join(' · '))}${m.id === PROJ.id ? ' · <b>aberto</b>' : ''}</div></div><div class="acts">${acts}</div></div>`;
  }).join('');
  const ri = $('renameIn'); if (ri) { ri.focus(); ri.select(); }
}

export function pmsg(t, ok) { $('pMsg').textContent = t; $('pMsg').style.color = ok ? 'var(--ok)' : 'var(--err)'; }

export function exportProject(name, st) {
  const text = JSON.stringify(Object.assign({ app: 'protobench', name }, st), null, 1);
  $('jsonBox').value = text;
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
  a.download = (name || 'circuito').replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, '-') + '.protobench.json';
  a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  pmsg('Arquivo exportado.', true);
}

export function importText(text, fallbackName) {
  try {
    const o = JSON.parse(text); if (!o || !Array.isArray(o.comps) || !Array.isArray(o.boards)) throw 0;
    const name = (o.name || fallbackName || 'Projeto importado').slice(0, 60); delete o.app; delete o.name;
    openState(o, { id: uid(), name }); flushSave(); $('projModal').hidden = true; say(`Projeto "${name}" importado.`);
  } catch (e) { pmsg('Esse arquivo não é um projeto válido do ProtoBench.', false); }
}

// ════════════════════════ Exemplos ════════════════════════
export function exBuilder(board) {
  const s = { v: 2, board: board || boardDefault(), comps: [], traces: [], wires: [], solder: [], cuts: [], labels: [], links: [], mcu: null, nextId: 1 }; let tg = 0;
  const b = {
    s,
    add(type, c, r, rot, p) { const o = { id: s.nextId++, type, c, r, rot, p: Object.assign({ desc: '' }, p) }; s.comps.push(o); return o.id; },
    tr(pts, name, color) { s.traces.push({ id: s.nextId++, tag: ++tg, pts, name: name || '', color: color || null }); },
    wire(a, bb, color, name) { s.wires.push({ id: s.nextId++, a, b: bb, color, name: name || '' }); },
    label(c, r, name) { s.labels.push({ h: [c, r], name }); },
    solderPins() { const saveS = app.S; app.S = Object.assign({ boards: [] }, s); const set = new Set(); for (const c of s.comps) for (const p of pinsOf(c)) set.add(p.c + ',' + p.r); app.S = saveS; s.solder = [...set].map(x => x.split(',').map(Number)); },
  };
  return b;
}

export const EXAMPLES = {
  led: { name: 'Exemplo: LED chaveado pelo 2N2222', build() {
    const b = exBuilder(boardDefault());
    b.add('term', 2, 3, 0, { name: 'J1', ways: 2, mode: 'src', v: 5, on: true, duty: 50, rload: 1000, kind: 'res', color: 'azul', desc: 'Alimentação 5 V' });
    b.add('term', 12, 26, 2, { name: 'J2', ways: 2, mode: 'src', v: 3.3, on: true, duty: 50, rload: 1000, kind: 'res', color: 'verde', desc: 'Sinal 3,3 V' });
    b.add('res', 2, 8, 0, { name: 'R2', val: 330, span: 4, watt: 0.25, desc: 'Limita o LED' });
    b.add('led', 6, 11, 0, { name: 'D1', color: 'red', size: 5 });
    b.add('bjt', 9, 14, 0, { name: 'Q1', model: '2N2222', pinout: 'EBC' });
    b.add('res', 10, 18, 1, { name: 'R1', val: 1000, span: 4, watt: 0.25, desc: 'Resistor de base' });
    b.tr([[2, 3], [2, 8]], 'VCC'); b.tr([[4, 3], [4, 24], [9, 24]], 'GND'); b.tr([[6, 8], [6, 11]]); b.tr([[7, 11], [11, 11], [11, 14]], 'Coletor');
    b.tr([[10, 14], [10, 18]], 'Base'); b.tr([[10, 22], [12, 24], [12, 26]], 'Sinal'); b.tr([[9, 14], [9, 26], [10, 26]], 'GND');
    b.label(2, 5, '5V'); b.label(4, 10, 'GND'); b.label(12, 25, 'SINAL');
    return b.s; } },
  relay: { name: 'Exemplo: relé e botão com Arduino (protoboard)', code: `// Cada toque no botão (D2) liga ou desliga o relé (D7).
// O LED no D13 pisca para mostrar que o programa está rodando.
const int BOTAO = 2;
const int RELE = 7;
const int LED = 13;

bool releLigado = false;
int ultimoEstado = HIGH;
unsigned long ultimoPisca = 0;

void setup() {
  pinMode(BOTAO, INPUT_PULLUP);
  pinMode(RELE, OUTPUT);
  pinMode(LED, OUTPUT);
  Serial.begin(9600);
  Serial.println("Pronto. Aperte o botao (clique e segure nele na placa).");
}

void loop() {
  int estado = digitalRead(BOTAO);
  if (estado == LOW && ultimoEstado == HIGH) {
    releLigado = !releLigado;
    digitalWrite(RELE, releLigado ? HIGH : LOW);
    Serial.print("Rele: ");
    Serial.println(releLigado ? "ligado" : "desligado");
    delay(50);
  }
  ultimoEstado = estado;

  if (millis() - ultimoPisca >= 500) {
    ultimoPisca = millis();
    digitalWrite(LED, !digitalRead(LED));
  }
}
`, build() {
    const bd = boardDefault(); bd.kind = 'bread'; bd.size = 830;
    const b = exBuilder(bd); const s = b.s;
    s.mcu = { type: 'uno', name: 'Arduino Uno', pins: { D2: { mode: 'pullup', level: 0, duty: 50 }, D7: { mode: 'out', level: 1, duty: 50 }, D13: { mode: 'out', level: 1, duty: 50 } } };
    const K1 = b.add('relay', 20, 5, 0, { name: 'K1', desc: 'Liga a carga' });
    b.add('diode', 17, 11, 3, { name: 'D1', model: '1N4007', span: 4, desc: 'Proteção da bobina' });
    b.add('bjt', 30, 11, 0, { name: 'Q1', model: '2N2222', pinout: 'EBC' });
    b.add('res', 31, 9, 0, { name: 'R1', val: 470, span: 4, watt: 0.25, desc: 'Base do Q1' });
    b.add('btn', 10, 7, 0, { name: 'SW1', pressed: false, color: 'vermelho', desc: 'Entrada D2' });
    b.add('led', 40, 5, 0, { name: 'D2', color: 'green', size: 5, desc: 'Indicador D13' });
    b.add('res', 41, 3, 0, { name: 'R2', val: 330, span: 4, watt: 0.25 });
    b.wire({ mcu: '5V' }, { h: [2, 0] }, 'vermelho', '5V'); b.wire({ mcu: 'GND' }, { h: [2, 1] }, 'preto', 'GND');
    b.wire({ h: [60, 1] }, { h: [60, 16] }, 'preto'); b.wire({ h: [21, 4] }, { h: [21, 0] }, 'vermelho');
    b.wire({ h: [17, 3] }, { h: [21, 3] }, 'laranja'); b.wire({ h: [17, 13] }, { h: [21, 13] }, 'laranja');
    b.wire({ h: [32, 12] }, { h: [21, 12] }, 'azul'); b.wire({ h: [30, 13] }, { h: [30, 16] }, 'preto');
    b.wire({ mcu: 'D7' }, { h: [35, 13] }, 'amarelo', 'D7'); b.wire({ mcu: 'D2' }, { h: [10, 5] }, 'verde', 'D2');
    b.wire({ h: [13, 11] }, { h: [13, 16] }, 'preto'); b.wire({ mcu: 'D13' }, { h: [40, 7] }, 'branco', 'D13'); b.wire({ h: [45, 4] }, { h: [45, 1] }, 'preto');
    b.label(21, 3, 'BOBINA+'); b.label(21, 11, 'BOBINA−');
    void K1; return s; } },
  motor: { name: 'Exemplo: motor 12 V com MOSFET e PWM (Nano)', code: `// Acelera e desacelera o motor pelo PWM no D9
const int MOTOR = 9;

void setup() {
  pinMode(MOTOR, OUTPUT);
  Serial.begin(9600);
}

void loop() {
  for (int v = 0; v <= 255; v += 51) {
    analogWrite(MOTOR, v);
    Serial.print("PWM = ");
    Serial.println(v);
    delay(500);
  }
  analogWrite(MOTOR, 0);
  delay(1000);
}
`, build() {
    const b = exBuilder(boardDefault()); const s = b.s;
    s.mcu = { type: 'nano', name: 'Arduino Nano', pins: { D9: { mode: 'pwm', level: 0, duty: 60 } } };
    const H1 = b.add('header', 2, 2, 0, { name: 'H1', n: 2, female: false, desc: 'D9 e GND do Nano' });
    const J1 = b.add('term', 18, 3, 2, { name: 'J1', ways: 2, mode: 'src', v: 12, on: true, duty: 50, rload: 1000, kind: 'res', color: 'azul', desc: 'Fonte 12 V' });
    b.add('term', 18, 24, 0, { name: 'J2', ways: 2, mode: 'load', v: 5, on: true, duty: 50, rload: 12, kind: 'ind', color: 'verde', desc: 'Motor 12 V' });
    b.add('mos', 8, 14, 0, { name: 'Q1', model: 'IRLZ44N', pinout: 'GDS' });
    b.add('diode', 14, 20, 0, { name: 'D1', model: '1N5819', span: 4, desc: 'Roda‑livre do motor' });
    b.add('res', 2, 6, 1, { name: 'R1', val: 220, span: 4, watt: 0.25, desc: 'Gate' });
    b.add('res', 6, 16, 0, { name: 'R2', val: 10000, span: 4, watt: 0.25, desc: 'Pull‑down do gate' });
    b.tr([[18, 3], [18, 20], [18, 24]], '12V', 'vermelho');
    b.tr([[20, 24], [20, 26], [9, 26], [9, 14]], 'Dreno', 'laranja');
    b.tr([[14, 20], [9, 20]], 'Dreno', 'laranja');
    b.tr([[10, 14], [10, 5], [16, 5], [16, 3]], 'GND', 'preto');
    b.tr([[3, 2], [3, 5], [10, 5]], 'GND', 'preto');
    b.tr([[2, 2], [2, 6]], 'PWM', 'azul'); b.tr([[2, 10], [2, 14], [8, 14]], 'Gate', 'azul');
    b.tr([[6, 16], [6, 14]], 'Gate', 'azul'); b.tr([[10, 16], [10, 14]], 'GND', 'preto');
    b.wire({ mcu: 'D9' }, { pin: [H1, 0] }, 'amarelo', 'PWM'); b.wire({ mcu: 'GND' }, { pin: [H1, 1] }, 'preto', 'GND');
    b.label(18, 10, '12V'); b.label(13, 5, 'GND'); b.label(9, 22, 'DRENO');
    void J1; return s; } },
  audio: { name: 'Exemplo: analisador de áudio em 3 faixas (MAX4466 + Uno)', code: `// Analisador de áudio em 3 faixas: Arduino Uno + microfone MAX4466
// A0  <- OUT do microfone (repouso em 2,5 V, o som oscila em volta)
// D9  -> LED vermelho (graves, abaixo de 200 Hz)
// D10 -> LED verde    (médios, 200 Hz a 2 kHz)
// D11 -> LED azul     (agudos, acima de 2 kHz)
// Lê um bloco de amostras, separa as faixas com filtros IIR Butterworth de
// 2ª ordem (biquads) e acende cada LED conforme a energia (RMS) da sua faixa.
// No simulador, escolha o som de teste no inspetor do microfone (MK1).

const int MIC = A0;
const int LED_GRAVE = 9;
const int LED_MEDIO = 10;
const int LED_AGUDO = 11;

const int N = 64;                 // amostras por bloco
const float CORTE_GRAVE = 200.0;  // Hz
const float CORTE_AGUDO = 2000.0; // Hz
const float GANHO = 2.5;          // sensibilidade dos LEDs (ajuste na montagem real)
const float SUAVE = 0.5;          // 0 = resposta instantânea, perto de 1 = LEDs mais lentos

int amostras[N];
float fs = 8000.0;                // taxa de amostragem, medida no setup()

// Filtros: 0 = passa-baixa 200 Hz, 1 = passa-alta 200 Hz,
//          2 = passa-baixa 2 kHz,  3 = passa-alta 2 kHz
float b0[4], b1[4], b2[4], a1[4], a2[4], z1[4], z2[4];
float nivel[3];

// Coeficientes do biquad (Audio EQ Cookbook, Q = 0,7071 = Butterworth)
void projeta(int k, float fc, int passaAlta) {
  float w = 2.0 * PI * fc / fs;
  float c = cos(w);
  float alfa = sin(w) / (2.0 * 0.7071);
  float a0 = 1.0 + alfa;
  if (passaAlta) {
    b0[k] = (1.0 + c) / 2.0 / a0;
    b1[k] = -(1.0 + c) / a0;
  } else {
    b0[k] = (1.0 - c) / 2.0 / a0;
    b1[k] = (1.0 - c) / a0;
  }
  b2[k] = b0[k];
  a1[k] = -2.0 * c / a0;
  a2[k] = (1.0 - alfa) / a0;
  z1[k] = 0.0;
  z2[k] = 0.0;
}

// y[n] = b0 x[n] + b1 x[n-1] + b2 x[n-2] - a1 y[n-1] - a2 y[n-2]  (forma direta II transposta)
float filtra(int k, float x) {
  float y = b0[k] * x + z1[k];
  z1[k] = b1[k] * x - a1[k] * y + z2[k];
  z2[k] = b2[k] * x - a2[k] * y;
  return y;
}

void lerBloco() {
  for (int i = 0; i < N; i++) {
    amostras[i] = analogRead(MIC);
  }
}

int brilho(float rms) {
  return (int)constrain(rms * 255.0 * GANHO, 0, 255);
}

void setup() {
  pinMode(LED_GRAVE, OUTPUT);
  pinMode(LED_MEDIO, OUTPUT);
  pinMode(LED_AGUDO, OUTPUT);
  Serial.begin(115200);

  unsigned long t0 = micros();
  lerBloco();
  fs = N * 1000000.0 / (micros() - t0);

  projeta(0, CORTE_GRAVE, 0);
  projeta(1, CORTE_GRAVE, 1);
  projeta(2, CORTE_AGUDO, 0);
  projeta(3, CORTE_AGUDO, 1);
  Serial.print("Taxa de amostragem: ");
  Serial.print(fs, 0);
  Serial.println(" Hz");
}

void loop() {
  lerBloco();

  long soma = 0;
  for (int i = 0; i < N; i++) soma += amostras[i];
  float media = soma * 1.0 / N;   // nível DC do microfone (VCC/2), removido antes de filtrar

  float eg = 0.0, em = 0.0, ea = 0.0;
  for (int i = 0; i < N; i++) {
    float x = (amostras[i] - media) / 512.0;   // -1 a 1
    float g = filtra(0, x);                    // graves
    float m = filtra(2, filtra(1, x));         // médios (passa-faixa)
    float a = filtra(3, x);                    // agudos
    eg += g * g;
    em += m * m;
    ea += a * a;
  }
  nivel[0] = SUAVE * nivel[0] + (1.0 - SUAVE) * sqrt(eg / N);
  nivel[1] = SUAVE * nivel[1] + (1.0 - SUAVE) * sqrt(em / N);
  nivel[2] = SUAVE * nivel[2] + (1.0 - SUAVE) * sqrt(ea / N);

  analogWrite(LED_GRAVE, brilho(nivel[0]));
  analogWrite(LED_MEDIO, brilho(nivel[1]));
  analogWrite(LED_AGUDO, brilho(nivel[2]));

  // Formato do Serial Plotter da IDE do Arduino
  Serial.print("Graves:");
  Serial.print(brilho(nivel[0]));
  Serial.print(" Medios:");
  Serial.print(brilho(nivel[1]));
  Serial.print(" Agudos:");
  Serial.println(brilho(nivel[2]));
}
`, build() {
    const bd = boardDefault(); bd.kind = 'bread'; bd.size = 830;
    const b = exBuilder(bd); const s = b.s;
    s.mcu = { type: 'uno', name: 'Arduino Uno', pins: { A0: { mode: 'analog', level: 0, duty: 0 }, D9: { mode: 'out', level: 0, duty: 0 }, D10: { mode: 'out', level: 0, duty: 0 }, D11: { mode: 'out', level: 0, duty: 0 } } };
    b.wire({ mcu: '5V' }, { h: [2, 0] }, 'vermelho', '5V'); b.wire({ mcu: 'GND' }, { h: [2, 1] }, 'preto', 'GND');
    // microfone: OUT/GND/VCC nas colunas 8/9/10, com 100 nF entre VCC e GND
    b.add('mic', 8, 3, 0, { name: 'MK1', sinal: 'mix', nivel: 60, desc: 'Microfone com amplificador' });
    b.add('capc', 10, 6, 2, { name: 'C1', model: '100n', span: 1, desc: 'Desacoplamento do MAX4466' });
    b.wire({ h: [9, 4] }, { h: [9, 1] }, 'preto', 'GND'); b.wire({ h: [10, 4] }, { h: [10, 0] }, 'vermelho', '5V');
    b.wire({ mcu: 'A0' }, { h: [8, 5] }, 'amarelo', 'ÁUDIO');
    // três canais: pino PWM → 330 Ω → LED → GND
    [[9, 20, 'red', 'Graves'], [10, 30, 'green', 'Médios'], [11, 40, 'blue', 'Agudos']].forEach(([pin, x, color, faixa], i) => {
      b.wire({ mcu: 'D' + pin }, { h: [x, 6] }, ['laranja', 'verde', 'azul'][i], 'D' + pin);
      b.add('res', x, 4, 0, { name: 'R' + (i + 1), val: 330, span: 3, watt: 0.25, desc: 'LED ' + faixa.toLowerCase() });
      b.add('led', x + 3, 7, 0, { name: 'D' + (i + 1), color, size: 5, desc: faixa });
      b.wire({ h: [x + 4, 3] }, { h: [x + 4, 1] }, 'preto');
      b.label(x + 1, 6, faixa.toUpperCase());
    });
    b.label(8, 7, 'MIC');
    return s; } },
  psu: { name: 'Exemplo: fonte 5 V com 7805 (veroboard)', build() {
    const bd = boardDefault(); bd.kind = 'strip'; bd.size = '5x7'; bd.cols = 18; bd.rows = 24; bd.sides = 1;
    const b = exBuilder(bd);
    b.add('term', 2, 4, 3, { name: 'J1', ways: 2, mode: 'src', v: 9, on: true, duty: 50, rload: 1000, kind: 'res', color: 'azul', desc: 'Entrada 9 V' });
    b.add('reg', 8, 4, 1, { name: 'U1', model: '7805' });
    b.add('capc', 11, 4, 1, { name: 'C1', model: '100n', span: 1, desc: 'Desacoplamento da entrada' });
    b.add('cape', 13, 6, 3, { name: 'C2', model: '100u', desc: 'Filtro da saída' });
    b.add('res', 15, 6, 1, { name: 'R1', val: 330, span: 4, watt: 0.25 });
    b.add('led', 17, 10, 1, { name: 'D1', color: 'green', size: 5, desc: 'Indicador de 5 V' });
    b.add('term', 4, 6, 1, { name: 'J2', ways: 2, mode: 'load', v: 5, on: true, duty: 50, rload: 100, kind: 'res', color: 'verde', desc: 'Saída 5 V (carga 100 Ω)' });
    b.wire({ h: [4, 2] }, { h: [4, 5] }, 'preto', 'GND'); b.wire({ h: [6, 8] }, { h: [6, 5] }, 'preto', 'GND'); b.wire({ h: [16, 11] }, { h: [16, 5] }, 'preto', 'GND');
    b.s.cuts = [[0, 10], [0, 11]];
    b.solderPins();
    b.label(9, 4, 'VIN'); b.label(10, 5, 'GND'); b.label(10, 6, '5V');
    return b.s; } },
};

export function exampleState(k) { const st = normalize(EXAMPLES[k].build()); if (EXAMPLES[k].code && st.mcus[0]) st.mcus[0].code = EXAMPLES[k].code; return st; }


/** Efeitos de inicialização do módulo (eventos, DOM). Chamado por main.ts na ordem certa. */
export function mount() {
  $('projName').addEventListener('change', e => { PROJ.name = e.target.value.trim().slice(0, 60) || 'Circuito sem nome'; e.target.value = PROJ.name; scheduleSave(); });
  $('projName').addEventListener('keydown', e => { if (e.key === 'Enter') e.target.blur(); });
  window.addEventListener('pagehide', () => { if (saveTimer) { Store.draft(); flushSave(); } });
  $('pNewBoard').innerHTML = NEWBOARDS.map(([k, l]) => `<option value="${k}">${l}</option>`).join('');
  $('bProjects').onclick = async () => { if (saveTimer) await flushSave(); pConfirm = null; pRename = null; $('pMsg').textContent = ''; $('jsonBox').value = JSON.stringify(Object.assign({ app: 'protobench', name: PROJ.name }, app.S), null, 1); $('projModal').hidden = false; renderProjects(); };
  $('pClose').onclick = () => { $('projModal').hidden = true; };
  $('projModal').addEventListener('click', async e => {
    if (e.target.id === 'projModal') { $('projModal').hidden = true; return; }
    const b = e.target.closest('[data-pa]'); if (!b) return;
    const a = b.dataset.pa, id = b.dataset.id;
    if (a === 'cancel') { pConfirm = null; pRename = null; renderProjects(); }
    else if (a === 'open') { const st = await Store.load(id); const m = Store.index().find(x => x.id === id); if (!st) { pmsg('Não consegui abrir esse projeto.', false); return; } openState(st, { id, name: m ? m.name : 'Projeto' }); $('projModal').hidden = true; }
    else if (a === 'ren') { pRename = id; pConfirm = null; renderProjects(); }
    else if (a === 'renok') { const nm = ($('renameIn').value.trim() || 'Circuito sem nome').slice(0, 60); await Store.rename(id, nm); if (id === PROJ.id) { PROJ.name = nm; renderChrome(); } pRename = null; renderProjects(); }
    else if (a === 'dup') { const st = await Store.load(id); const m = Store.index().find(x => x.id === id); if (st) { await Store.save(uid(), (m ? m.name : 'Projeto') + ' (cópia)', st); renderProjects(); } }
    else if (a === 'exp') { const st = await Store.load(id); const m = Store.index().find(x => x.id === id); if (st) exportProject(m ? m.name : 'circuito', st); }
    else if (a === 'del') { pConfirm = id; pRename = null; renderProjects(); }
    else if (a === 'delok') { await Store.remove(id); if (id === PROJ.id) { PROJ.id = null; setSaveState('projeto excluído · edite para salvar de novo', 'warn'); } pConfirm = null; renderProjects(); }
  });
  $('projModal').addEventListener('keydown', e => { if (e.key === 'Enter' && e.target.id === 'renameIn') { const b = document.querySelector('[data-pa="renok"]'); if (b) b.click(); } });
  $('pNew').onclick = async () => {
    if (saveTimer) await flushSave();
    const [kind, size] = $('pNewBoard').value.split(':'), b = boardDefault(), st = emptyState();
    b.kind = kind; if (kind === 'bread') b.size = +size; else { const sz = SIZES.find(s => s[0] === size); b.size = size; b.cols = sz[2]; b.rows = sz[3]; }
    b.id = st.nextId++; b.x = 2; b.y = 3; b.name = BPREFIX[kind] + '1'; st.boards.push(b);
    openState(st, { id: uid(), name: 'Circuito sem nome' }); flushSave(); $('projModal').hidden = true; $('projName').focus(); $('projName').select();
  };
  $('pImport').onchange = e => { const f = e.target.files[0]; if (!f) return; const rd = new FileReader(); rd.onload = () => importText(rd.result, f.name.replace(/\.json$/i, '').replace(/\.protobench$/i, '')); rd.readAsText(f); e.target.value = ''; };
  $('mCopy').onclick = () => { const box = $('jsonBox'); navigator.clipboard.writeText(box.value).then(() => pmsg('Copiado.', true)).catch(() => { box.select(); pmsg('Texto selecionado: use Ctrl+C.', true); }); };
  $('mLoad').onclick = () => importText($('jsonBox').value, 'Projeto colado');
  $('exSel').innerHTML = '<option value="">Exemplos…</option>' + Object.entries(EXAMPLES).map(([k, e]) => `<option value="${k}">${esc(e.name.replace('Exemplo: ', ''))}</option>`).join('');
  $('exSel').onchange = async e => { const k = e.target.value; e.target.value = ''; if (!k) return; if (saveTimer) await flushSave(); openState(exampleState(k), { id: null, name: EXAMPLES[k].name }); say('Exemplo aberto. Ele vira um projeto salvo quando você editar.' + (EXAMPLES[k].code ? ' Abra o código do Arduino e clique em Rodar.' : '')); };
  // ════════════════════════ Início ════════════════════════
  (async function init() {
    setupSvg();
    app.S = exampleState('led'); setDims(); buildThumbs();
    setZoom(window.innerWidth < 700 ? 0.6 : 1);
    renderLib();
    await Store.init();
    let opened = false;
    const last = await Store.getLast(), m = last && Store.index().find(x => x.id === last);
    if (m) { const st = await Store.load(last); if (st) { try { openState(st, { id: last, name: m.name }); opened = true; } catch (e) {} } }
    if (!opened) { openState(exampleState('led'), { id: null, name: EXAMPLES.led.name }); setSaveState('exemplo (edite para salvar neste navegador)'); }
    window.__protobench = { analyze, simulate, EXAMPLES, exampleState, openState, normalize, get S() { return app.S; }, get AN() { return app.AN; }, get SIM() { return app.SIM; }, Store, ready: true };
  })();
}
