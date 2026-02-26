import { niceTimeInterval } from "../math/intervals";
import type { TimeFormatPreset } from "../types";
import { formatAxisTimeByPresetWorklet } from "./timeFormat";

export { niceTimeInterval } from "../math/intervals";

export const MAX_TIME_LABELS = 30;

export interface TimeLabelSlot {
  key: number;
  x: number;
  tSec: number;
  text: string;
  alpha: number;
  renderAlpha: number;
}

/** Pre-allocated scratch buffers for updateTimeSlots to avoid per-frame arrays. */
export interface TimeScratch {
  targetKeys: number[];
  visibleIdx: number[];
}

export function createTimeScratch(): TimeScratch {
  return {
    targetKeys: new Array(MAX_TIME_LABELS).fill(0),
    visibleIdx: new Array(MAX_TIME_LABELS).fill(0),
  };
}

const TIME_AXIS_FADE = 0.08;

function alphaLerp(
  from: number,
  to: number,
  speed: number,
  dtRatio: number,
): number {
  "worklet";
  const alpha = 1 - Math.pow(1 - speed, dtRatio);
  const clamped = Math.min(1, Math.max(0, alpha));
  return from + (to - from) * clamped;
}

export function defaultFormatTimeWorklet(ms: number): string {
  "worklet";
  const d = new Date(ms);
  const hh = `${d.getHours()}`.padStart(2, "0");
  const mm = `${d.getMinutes()}`.padStart(2, "0");
  const ss = `${d.getSeconds()}`.padStart(2, "0");
  return `${hh}:${mm}:${ss}`;
}

export function createTimeSlots(): TimeLabelSlot[] {
  return Array.from({ length: MAX_TIME_LABELS }, () => ({
    key: Number.MIN_SAFE_INTEGER,
    x: -1000,
    tSec: 0,
    text: "",
    alpha: 0,
    renderAlpha: 0,
  }));
}

/**
 * Update time axis label slots: assign ticks, fade in/out, resolve overlaps.
 * Returns true when any slot was mutated (caller should signal Reanimated).
 */
export function updateTimeSlots(
  slots: TimeLabelSlot[],
  start: number,
  rightEdge: number,
  windowSecsNow: number,
  targetWindowSecs: number,
  paddingLeft: number,
  innerWidth: number,
  ratio: number,
  gridTimeReveal: number,
  axisCharWidth: number,
  formatTimeWorklet: ((t: number) => string) | undefined,
  formatAxisTimeWorklet:
    | ((tMs: number, windowSecs: number, intervalSecs: number) => string)
    | undefined,
  timeFormatPreset: TimeFormatPreset | undefined,
  buf: TimeScratch,
): boolean {
  "worklet";

  let interval = niceTimeInterval(targetWindowSecs);
  const targetPxPerSec = innerWidth / targetWindowSecs;
  while (interval * targetPxPerSec < 60 && interval < targetWindowSecs) {
    interval *= 2;
  }

  const chartLeft = paddingLeft;
  const chartRight = paddingLeft + innerWidth;
  const fadeZone = 50;

  const useLocalDays = interval >= 86_400;
  let firstTick = 0;
  if (useLocalDays) {
    const d = new Date((start - interval) * 1000);
    d.setHours(0, 0, 0, 0);
    firstTick = d.getTime() / 1000;
  } else {
    firstTick = Math.ceil((start - interval) / interval) * interval;
  }

  const targetKeys = buf.targetKeys;
  let keyCount = 0;
  for (
    let t = firstTick;
    t <= rightEdge + interval && keyCount < MAX_TIME_LABELS;
    t += interval
  ) {
    targetKeys[keyCount] = Math.round(t * 100);
    keyCount += 1;
  }

  let dirty = false;

  // Ensure every target tick has a slot.
  for (let k = 0; k < keyCount; k += 1) {
    const key = targetKeys[k];
    let existing = -1;
    let firstFree = -1;
    let lowestAlpha = Number.POSITIVE_INFINITY;
    let lowestIdx = -1;
    for (let i = 0; i < slots.length; i += 1) {
      const slot = slots[i];
      if (slot.key === key) {
        existing = i;
        break;
      }
      if (slot.key === Number.MIN_SAFE_INTEGER && firstFree < 0) {
        firstFree = i;
      }
      if (slot.alpha < lowestAlpha) {
        lowestAlpha = slot.alpha;
        lowestIdx = i;
      }
    }

    if (existing >= 0) continue;

    const targetIdx = firstFree >= 0 ? firstFree : lowestIdx;
    if (targetIdx < 0) continue;
    const slot = slots[targetIdx];
    const tSec = key / 100;
    const tMs = tSec * 1000;
    const text = formatAxisTimeWorklet
      ? formatAxisTimeWorklet(tMs, windowSecsNow, interval)
      : formatTimeWorklet
        ? formatTimeWorklet(tMs)
        : formatAxisTimeByPresetWorklet(
            tMs,
            windowSecsNow,
            interval,
            timeFormatPreset,
          );

    if (slot.key !== key) {
      slot.key = key;
      dirty = true;
    }
    if (Math.abs(slot.tSec - tSec) > 1e-6) {
      slot.tSec = tSec;
      dirty = true;
    }
    if (slot.text !== text) {
      slot.text = text;
      dirty = true;
    }
    if (slot.alpha !== 0) {
      slot.alpha = 0;
      dirty = true;
    }
    if (slot.renderAlpha !== 0) {
      slot.renderAlpha = 0;
      dirty = true;
    }
  }

  // Update x/alpha for every slot and resolve fade in/out targets.
  for (let i = 0; i < slots.length; i += 1) {
    const slot = slots[i];
    if (slot.key === Number.MIN_SAFE_INTEGER) {
      if (slot.renderAlpha !== 0) {
        slot.renderAlpha = 0;
        dirty = true;
      }
      continue;
    }

    const x = chartLeft + ((slot.tSec - start) / windowSecsNow) * innerWidth;
    if (Math.abs(slot.x - x) > 1e-4) {
      slot.x = x;
      dirty = true;
    }

    let isTarget = false;
    for (let k = 0; k < keyCount; k += 1) {
      if (targetKeys[k] === slot.key) {
        isTarget = true;
        break;
      }
    }

    // Edge alpha (inline to avoid closure in worklet).
    const fromLeft = slot.x - chartLeft;
    const fromRight = chartRight - slot.x;
    const fromEdge = Math.min(fromLeft, fromRight);
    let ea = 1;
    if (fromEdge <= 0) ea = 0;
    else if (fromEdge < fadeZone) ea = fromEdge / fadeZone;

    const target = isTarget ? ea * gridTimeReveal : 0;
    let nextAlpha = alphaLerp(slot.alpha, target, TIME_AXIS_FADE, ratio);
    if (Math.abs(nextAlpha - target) < 0.02) nextAlpha = target;

    if (nextAlpha < 0.01 && target === 0) {
      if (slot.key !== Number.MIN_SAFE_INTEGER) {
        slot.key = Number.MIN_SAFE_INTEGER;
        dirty = true;
      }
      if (slot.x !== -1000) {
        slot.x = -1000;
        dirty = true;
      }
      if (slot.tSec !== 0) {
        slot.tSec = 0;
        dirty = true;
      }
      if (slot.text !== "") {
        slot.text = "";
        dirty = true;
      }
      if (slot.alpha !== 0) {
        slot.alpha = 0;
        dirty = true;
      }
      if (slot.renderAlpha !== 0) {
        slot.renderAlpha = 0;
        dirty = true;
      }
    } else {
      if (Math.abs(slot.alpha - nextAlpha) > 1e-4) {
        slot.alpha = nextAlpha;
        dirty = true;
      }
      if (Math.abs(slot.renderAlpha - slot.alpha) > 1e-4) {
        slot.renderAlpha = slot.alpha;
        dirty = true;
      }
    }
  }

  // Resolve overlaps by keeping the more visible label.
  const visIdx = buf.visibleIdx;
  let visCount = 0;
  for (let i = 0; i < slots.length; i += 1) {
    const slot = slots[i];
    if (slot.key === Number.MIN_SAFE_INTEGER || slot.renderAlpha < 0.02)
      continue;
    if (slot.x < chartLeft - 20 || slot.x > chartRight) continue;
    visIdx[visCount] = i;
    visCount += 1;
  }

  // Insertion sort by x (small-N, worklet-safe).
  for (let i = 1; i < visCount; i += 1) {
    const cur = visIdx[i];
    let j = i - 1;
    while (j >= 0 && slots[visIdx[j]].x > slots[cur].x) {
      visIdx[j + 1] = visIdx[j];
      j -= 1;
    }
    visIdx[j + 1] = cur;
  }

  let prevIdx = -1;
  const timeCharW = axisCharWidth;
  for (let i = 0; i < visCount; i += 1) {
    const idx = visIdx[i];
    const slot = slots[idx];
    const w = slot.text.length * timeCharW;
    const left = slot.x - w * 0.5;
    if (prevIdx >= 0) {
      const prev = slots[prevIdx];
      const prevW = prev.text.length * timeCharW;
      const prevRight = prev.x + prevW * 0.5;
      if (left < prevRight + 8) {
        if (slot.renderAlpha > prev.renderAlpha) {
          if (prev.renderAlpha !== 0) {
            prev.renderAlpha = 0;
            dirty = true;
          }
          prevIdx = idx;
        } else if (slot.renderAlpha !== 0) {
          slot.renderAlpha = 0;
          dirty = true;
        }
        continue;
      }
    }
    prevIdx = idx;
  }

  return dirty;
}
