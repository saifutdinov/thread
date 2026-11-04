export type MicModel = 'browser' | 'off' | 'rnnoise' | 'deepfilter';
export type MicSettings = {
  model: MicModel; strength: number; gain: number; gate: number; hold: number;
  highPass: boolean; agc: boolean; echo: boolean;
};
export const GATE_OFF = -70;
export const GATE_MAX = -10;
const models: MicModel[] = ['browser', 'off', 'rnnoise', 'deepfilter'];

export function readMicSettings(saved: string, legacy: { denoise: string; gate: string }, customDefault: boolean): MicSettings {
  let value: Partial<MicSettings> = {};
  try { const parsed = JSON.parse(saved); if (parsed && typeof parsed === 'object') value = parsed; } catch { /* old settings */ }
  const number = (v: unknown, fallback: number, min: number, max: number) =>
    typeof v === 'number' && Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : fallback;
  const boolean = (v: unknown, fallback: boolean) => typeof v === 'boolean' ? v : fallback;
  return {
    model: models.includes(value.model!) ? value.model! : (legacy.denoise ? legacy.denoise === '1' : customDefault) ? 'rnnoise' : 'browser',
    strength: number(value.strength, 0.65, 0, 1), gain: number(value.gain, 0, -12, 12),
    gate: number(value.gate, number(legacy.gate ? Number(legacy.gate) : GATE_OFF, GATE_OFF, GATE_OFF, GATE_MAX), GATE_OFF, GATE_MAX),
    hold: number(value.hold, 300, 0, 1000), highPass: boolean(value.highPass, false),
    agc: boolean(value.agc, true), echo: boolean(value.echo, true),
  };
}
