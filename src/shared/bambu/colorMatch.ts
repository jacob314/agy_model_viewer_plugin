import { getFilamentsForScope, type BambuFilament, type BambuPaletteScope } from './palette.js';

export interface LabColor {
  L: number;
  a: number;
  b: number;
}

export interface BambuMatchResult {
  filament: BambuFilament;
  deltaE: number;
}

export function hexToRgb(hex: string): [number, number, number] {
  const clean = hex.replace(/^#/, '');
  const n = parseInt(
    clean.length === 3
      ? clean[0] + clean[0] + clean[1] + clean[1] + clean[2] + clean[2]
      : clean.slice(0, 6),
    16,
  );
  if (Number.isNaN(n)) return [180, 180, 180];
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

export function rgbToHex(r: number, g: number, b: number): string {
  const c = (v: number) => Math.max(0, Math.min(255, Math.round(v)));
  return (
    '#' +
    c(r).toString(16).padStart(2, '0') +
    c(g).toString(16).padStart(2, '0') +
    c(b).toString(16).padStart(2, '0')
  ).toUpperCase();
}

export function rgbToLab(r8: number, g8: number, b8: number): LabColor {
  const toLin = (v: number) => {
    const s = v / 255;
    return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  const r = toLin(r8);
  const g = toLin(g8);
  const b = toLin(b8);

  const x = (r * 0.4124564 + g * 0.3575761 + b * 0.1804375) / 0.95047;
  const y = (r * 0.2126729 + g * 0.7151522 + b * 0.072175) / 1.0;
  const z = (r * 0.0193339 + g * 0.119192 + b * 0.9503041) / 1.08883;

  const f = (t: number) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  const fx = f(x);
  const fy = f(y);
  const fz = f(z);

  return {
    L: 116 * fy - 16,
    a: 500 * (fx - fy),
    b: 200 * (fy - fz),
  };
}

export function ciede2000(c1: LabColor, c2: LabColor): number {
  const rad = Math.PI / 180;
  const deg = 180 / Math.PI;

  const C1 = Math.hypot(c1.a, c1.b);
  const C2 = Math.hypot(c2.a, c2.b);
  const Cbar = (C1 + C2) * 0.5;
  const Cbar7 = Math.pow(Cbar, 7);
  const G = 0.5 * (1 - Math.sqrt(Cbar7 / (Cbar7 + 6103515625)));

  const a1p = (1 + G) * c1.a;
  const a2p = (1 + G) * c2.a;
  const C1p = Math.hypot(a1p, c1.b);
  const C2p = Math.hypot(a2p, c2.b);

  const h1p = C1p === 0 ? 0 : ((Math.atan2(c1.b, a1p) * deg) + 360) % 360;
  const h2p = C2p === 0 ? 0 : ((Math.atan2(c2.b, a2p) * deg) + 360) % 360;

  const dLp = c2.L - c1.L;
  const dCp = C2p - C1p;

  let dhp = 0;
  if (C1p * C2p !== 0) {
    const diff = h2p - h1p;
    if (Math.abs(diff) <= 180) dhp = diff;
    else if (diff > 180) dhp = diff - 360;
    else dhp = diff + 360;
  }
  const dHp = 2 * Math.sqrt(C1p * C2p) * Math.sin((dhp * 0.5) * rad);

  const Lbarp = (c1.L + c2.L) * 0.5;
  const Cbarp = (C1p + C2p) * 0.5;

  let hbarp = h1p + h2p;
  if (C1p * C2p !== 0) {
    if (Math.abs(h1p - h2p) <= 180) hbarp = (h1p + h2p) * 0.5;
    else if (h1p + h2p < 360) hbarp = (h1p + h2p + 360) * 0.5;
    else hbarp = (h1p + h2p - 360) * 0.5;
  }

  const T =
    1 -
    0.17 * Math.cos((hbarp - 30) * rad) +
    0.24 * Math.cos((2 * hbarp) * rad) +
    0.32 * Math.cos((3 * hbarp + 6) * rad) -
    0.2 * Math.cos((4 * hbarp - 63) * rad);

  const dTheta = 30 * Math.exp(-Math.pow((hbarp - 275) / 25, 2));
  const Cbarp7 = Math.pow(Cbarp, 7);
  const RC = 2 * Math.sqrt(Cbarp7 / (Cbarp7 + 6103515625));
  const L50sq = Math.pow(Lbarp - 50, 2);
  const SL = 1 + (0.015 * L50sq) / Math.sqrt(20 + L50sq);
  const SC = 1 + 0.045 * Cbarp;
  const SH = 1 + 0.015 * Cbarp * T;
  const RT = -Math.sin(2 * dTheta * rad) * RC;

  const tL = dLp / SL;
  const tC = dCp / SC;
  const tH = dHp / SH;

  return Math.sqrt(tL * tL + tC * tC + tH * tH + RT * tC * tH);
}

interface PreparedEntry {
  filament: BambuFilament;
  rgb: [number, number, number];
  lab: LabColor;
}

const preparedByScope = new Map<BambuPaletteScope, PreparedEntry[]>();

function getPrepared(scope: BambuPaletteScope): PreparedEntry[] {
  let list = preparedByScope.get(scope);
  if (!list) {
    list = getFilamentsForScope(scope).map((filament) => {
      const rgb = hexToRgb(filament.hex);
      return { filament, rgb, lab: rgbToLab(rgb[0], rgb[1], rgb[2]) };
    });
    preparedByScope.set(scope, list);
  }
  return list;
}

export function matchBambuRgb(
  r: number,
  g: number,
  b: number,
  scope: BambuPaletteScope = 'basic-matte',
): BambuMatchResult {
  const lab = rgbToLab(r, g, b);
  const entries = getPrepared(scope);
  let best = entries[0];
  let bestDe = Infinity;

  for (let i = 0; i < entries.length; i++) {
    const de = ciede2000(lab, entries[i].lab);
    if (de < bestDe) {
      bestDe = de;
      best = entries[i];
    }
  }
  return { filament: best.filament, deltaE: bestDe };
}

export function matchBambuHex(
  hex: string,
  scope: BambuPaletteScope = 'basic-matte',
): BambuMatchResult {
  const [r, g, b] = hexToRgb(hex);
  return matchBambuRgb(r, g, b, scope);
}

export interface BambuRgbLut {
  scope: BambuPaletteScope;
  entries: PreparedEntry[];
  table: Uint8Array;
}

const lutCache = new Map<BambuPaletteScope, BambuRgbLut>();

export function getBambuLut(scope: BambuPaletteScope): BambuRgbLut {
  let lut = lutCache.get(scope);
  if (lut) return lut;

  const entries = getPrepared(scope);
  const table = new Uint8Array(32 * 32 * 32);

  for (let r5 = 0; r5 < 32; r5++) {
    const r = Math.round((r5 * 255) / 31);
    for (let g5 = 0; g5 < 32; g5++) {
      const g = Math.round((g5 * 255) / 31);
      for (let b5 = 0; b5 < 32; b5++) {
        const b = Math.round((b5 * 255) / 31);
        const lab = rgbToLab(r, g, b);
        let bestIdx = 0;
        let bestDe = Infinity;
        for (let i = 0; i < entries.length; i++) {
          const de = ciede2000(lab, entries[i].lab);
          if (de < bestDe) {
            bestDe = de;
            bestIdx = i;
          }
        }
        table[(r5 << 10) | (g5 << 5) | b5] = bestIdx;
      }
    }
  }

  lut = { scope, entries, table };
  lutCache.set(scope, lut);
  return lut;
}
