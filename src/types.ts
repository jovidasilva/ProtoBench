// Modelo de dados do projeto (formato v3, é o que vai no IndexedDB e no .protobench.json).
export type Hole = [c: number, r: number];

export interface Board {
  id: number; name: string; x: number; y: number;
  kind: 'perf' | 'strip' | 'bread'; size: string | number; cols?: number; rows?: number;
  sides?: 1 | 2; labels?: string; color?: string;
}
export interface PinCfg { mode: 'in' | 'pullup' | 'out' | 'pwm'; level: 0 | 1; duty: number }
export interface Mcu { id: number; type: 'uno' | 'nano' | 'esp32' | string; name: string; x: number; y: number; pins: Record<string, PinCfg>; code: string }
export interface Comp { id: number; type: string; c: number; r: number; rot: number; p: { name: string; desc?: string; [k: string]: any } }
export interface Trace { id: number; tag: number; pts: Hole[]; color: string | null; name: string; side?: 'top' | 'bottom' }
/** Ponta de fio: furo da placa (h) ou pino de microcontrolador (mcu = [id, pino]). */
export interface Endpoint { h?: Hole; mcu?: [number, string] }
export interface Wire { id: number; a: Endpoint; b: Endpoint; color: string; name: string }
export interface Label { h: Hole; name: string }

export interface State {
  v: 3; boards: Board[]; mcus: Mcu[]; comps: Comp[]; traces: Trace[]; wires: Wire[];
  solder: Hole[]; cuts: Hole[]; labels: Label[]; links: any[]; nextId: number;
}
export type Severity = 'err' | 'warn' | 'info';
export interface Issue { sev: Severity; msg: string; at?: { c: number; r: number } | null; [k: string]: any }
