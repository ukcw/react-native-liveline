export const MAX_GRID_LABELS = 24;

/** Maximum number of candidate ticks per frame (coarse + fine). */
const MAX_GRID_TICKS = MAX_GRID_LABELS * 2;

export interface GridLabelSlot {
  key: number;
  y: number;
  value: number;
  text: string;
  alpha: number;
}

/** Pre-allocated scratch buffers for updateGridSlots to avoid per-frame arrays. */
export interface GridScratch {
  keys: number[];
  values: number[];
  ys: number[];
  targets: number[];
  used: number[];
  capacity: number;
}

export function createGridScratch(
  capacity: number = MAX_GRID_TICKS,
): GridScratch {
  return {
    keys: new Array(capacity).fill(0),
    values: new Array(capacity).fill(0),
    ys: new Array(capacity).fill(0),
    targets: new Array(capacity).fill(0),
    used: new Array(capacity).fill(0),
    capacity,
  };
}

const EPS = 1e-9;
const GRID_FADE_IN = 0.18;
const GRID_FADE_OUT = 0.12;

// Hoisted to module scope to avoid 4 array allocations per frame inside
// the pickGridInterval worklet (which runs every frame when grid is visible).
const DIVISOR_SET_0 = [2, 2.5, 2] as const;
const DIVISOR_SET_1 = [2, 2, 2.5] as const;
const DIVISOR_SET_2 = [2.5, 2, 2] as const;
const DIVISOR_SETS = [DIVISOR_SET_0, DIVISOR_SET_1, DIVISOR_SET_2] as const;

function alphaLerp(
  from: number,
  to: number,
  speed: number,
  dtRatio: number,
): number {
  "worklet";
  const a = 1 - Math.pow(1 - speed, dtRatio);
  const clamped = Math.min(1, Math.max(0, a));
  return from + (to - from) * clamped;
}

function formatWorkletValue(
  formatValueWorklet: ((v: number) => string) | undefined,
  v: number,
): string {
  "worklet";
  if (formatValueWorklet) return formatValueWorklet(v);
  return formatAxisValueWorklet(v);
}

export function createGridSlots(): GridLabelSlot[] {
  return Array.from({ length: MAX_GRID_LABELS }, () => ({
    key: Number.MIN_SAFE_INTEGER,
    y: -1000,
    value: 0,
    text: "",
    alpha: 0,
  }));
}

export function pickGridInterval(
  valRange: number,
  pxPerUnit: number,
  minGap: number,
  prev: number,
): number {
  "worklet";
  if (prev > 0) {
    const px = prev * pxPerUnit;
    if (px >= minGap * 0.5 && px <= minGap * 4) return prev;
  }

  let best = Number.POSITIVE_INFINITY;
  for (let i = 0; i < DIVISOR_SETS.length; i += 1) {
    const divs = DIVISOR_SETS[i];
    let span = Math.pow(10, Math.ceil(Math.log10(Math.max(valRange, EPS))));
    let cursor = 0;
    while ((span / divs[cursor % 3]) * pxPerUnit >= minGap) {
      span /= divs[cursor % 3];
      cursor += 1;
      if (cursor > 60) break;
    }
    if (span < best) best = span;
  }

  if (!Number.isFinite(best) || best <= 0) {
    return Math.max(valRange / 5, 1e-6);
  }
  return best;
}

export interface GridResult {
  dirty: boolean;
  interval: number;
}

export function createGridResult(): GridResult {
  return { dirty: false, interval: 0 };
}

export function gridDivisible(v: number, coarse: number): boolean {
  "worklet";
  const ratio = v / Math.max(coarse, 1e-9);
  return Math.abs(ratio - Math.round(ratio)) < 1e-6;
}

export function formatAxisValueWorklet(n: number): string {
  "worklet";
  if (!Number.isFinite(n)) return "0.00";
  const fixed = n.toFixed(2);
  const parts = fixed.split(".");
  const frac = parts[1] ?? "00";
  let whole = parts[0] ?? "0";
  const negative = whole.startsWith("-");
  if (negative) whole = whole.slice(1);
  let grouped = "";
  for (let i = 0; i < whole.length; i += 1) {
    const idxFromEnd = whole.length - i;
    grouped += whole[i];
    if (idxFromEnd > 1 && idxFromEnd % 3 === 1) grouped += ",";
  }
  return `${negative ? "-" : ""}${grouped}.${frac}`;
}

/**
 * Update grid label slots: compute coarse/fine intervals, position labels,
 * fade in/out with edge zones, recycle empty slots.
 * Writes the new interval and dirty flag into the pre-allocated `out` param
 * to avoid per-frame object allocation.
 */
export function updateGridSlots(
  slots: GridLabelSlot[],
  currentInterval: number,
  rangeMin: number,
  rangeMax: number,
  rangeSpan: number,
  height: number,
  innerHeight: number,
  paddingTop: number,
  paddingBottom: number,
  ratio: number,
  gridTimeReveal: number,
  formatValueWorklet: ((v: number) => string) | undefined,
  buf: GridScratch,
  out: GridResult,
): void {
  "worklet";

  const chartH = innerHeight;
  const pxPerUnit = chartH / Math.max(rangeSpan, 1e-9);
  const coarse = pickGridInterval(rangeSpan, pxPerUnit, 36, currentInterval);

  const fine = coarse * 0.5;
  const finePx = fine * pxPerUnit;
  const fineTarget = finePx < 40 ? 0 : finePx >= 60 ? 1 : (finePx - 40) / 20;
  const fadeZone = 32;

  const keys = buf.keys;
  const vals = buf.values;
  const yBuf = buf.ys;
  const tgts = buf.targets;
  let tickCount = 0;

  if (fine > 0 && Number.isFinite(fine)) {
    const bottom = height - paddingBottom;
    const startIdx = Math.ceil(rangeMin / fine);
    const endIdx = Math.floor(rangeMax / fine);
    for (
      let idx = startIdx;
      idx <= endIdx && tickCount < MAX_GRID_TICKS;
      idx += 1
    ) {
      const v = idx * fine;
      const y =
        paddingTop + (1 - (v - rangeMin) / Math.max(rangeSpan, 1e-9)) * chartH;
      if (y < paddingTop - 2 || y > bottom + 2) continue;
      const isCoarse = gridDivisible(v, coarse);
      const fromEdge = Math.min(y - paddingTop, bottom - y);
      let edgeAlpha = 1;
      if (fromEdge <= 0) edgeAlpha = 0;
      else if (fromEdge < fadeZone) edgeAlpha = fromEdge / fadeZone;
      const target = (isCoarse ? 1 : fineTarget) * edgeAlpha * gridTimeReveal;
      keys[tickCount] = Math.round(v * 1000);
      vals[tickCount] = v;
      yBuf[tickCount] = y;
      tgts[tickCount] = target;
      tickCount += 1;
    }
  }

  // Reset used flags for this frame's ticks
  const used = buf.used;
  for (let j = 0; j < tickCount; j += 1) used[j] = 0;

  let dirty = false;

  for (let i = 0; i < slots.length; i += 1) {
    const slot = slots[i];
    let match = -1;
    for (let j = 0; j < tickCount; j += 1) {
      if (keys[j] === slot.key) {
        match = j;
        break;
      }
    }

    if (match >= 0) {
      const targetAlpha = tgts[match];
      const nextValue = vals[match];
      const nextY = yBuf[match];
      const nextAlpha = alphaLerp(
        slot.alpha,
        targetAlpha,
        targetAlpha >= slot.alpha ? GRID_FADE_IN : GRID_FADE_OUT,
        ratio,
      );

      if (slot.value !== nextValue) {
        slot.value = nextValue;
        dirty = true;
      }
      if (Math.abs(slot.y - nextY) > 1e-4) {
        slot.y = nextY;
        dirty = true;
      }
      if (Math.abs(nextAlpha - targetAlpha) < 0.02) {
        if (Math.abs(slot.alpha - targetAlpha) > 1e-4) {
          slot.alpha = targetAlpha;
          dirty = true;
        }
      } else if (Math.abs(slot.alpha - nextAlpha) > 1e-4) {
        slot.alpha = nextAlpha;
        dirty = true;
      }
      used[match] = 1;
    } else {
      const nextAlpha = alphaLerp(slot.alpha, 0, GRID_FADE_OUT, ratio);
      if (Math.abs(slot.alpha - nextAlpha) > 1e-4) {
        slot.alpha = nextAlpha;
        dirty = true;
      }
      if (slot.alpha < 0.01) {
        if (slot.alpha !== 0) {
          slot.alpha = 0;
          dirty = true;
        }
        if (slot.key !== Number.MIN_SAFE_INTEGER) {
          slot.key = Number.MIN_SAFE_INTEGER;
          dirty = true;
        }
        if (slot.y !== -1000) {
          slot.y = -1000;
          dirty = true;
        }
        if (slot.value !== 0) {
          slot.value = 0;
          dirty = true;
        }
        if (slot.text !== "") {
          slot.text = "";
          dirty = true;
        }
      }
    }
  }

  for (let j = 0; j < tickCount; j += 1) {
    if (used[j] === 1 || tgts[j] <= 0.01) continue;

    let best = -1;
    let minAlpha = Number.POSITIVE_INFINITY;
    for (let i = 0; i < slots.length; i += 1) {
      if (slots[i].key === Number.MIN_SAFE_INTEGER) {
        best = i;
        break;
      }
      if (slots[i].alpha < minAlpha) {
        minAlpha = slots[i].alpha;
        best = i;
      }
    }

    if (best >= 0) {
      slots[best].key = keys[j];
      slots[best].value = vals[j];
      slots[best].y = yBuf[j];
      slots[best].text = formatWorkletValue(formatValueWorklet, vals[j]);
      slots[best].alpha = tgts[j] * GRID_FADE_IN;
      dirty = true;
    }
  }

  out.dirty = dirty;
  out.interval = coarse;
}

/** Fade all grid slots toward zero when the grid is hidden. */
export function fadeOutGridSlots(
  slots: GridLabelSlot[],
  ratio: number,
): boolean {
  "worklet";
  let dirty = false;
  for (let i = 0; i < slots.length; i += 1) {
    const nextAlpha = Math.max(0, slots[i].alpha - GRID_FADE_OUT * ratio);
    if (Math.abs(slots[i].alpha - nextAlpha) > 1e-4) {
      slots[i].alpha = nextAlpha;
      dirty = true;
    }
  }
  return dirty;
}
