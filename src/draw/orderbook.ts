import type { OrderbookData } from "../types";

const RNG_MULTIPLIER = 1664525;
const RNG_INCREMENT = 1013904223;
const RNG_MODULUS = 4294967296;

export const MAX_ORDERBOOK_LABELS = 50;
const LABEL_LIFETIME = 6;
const SPAWN_INTERVAL_MS = 40;
const MIN_LABEL_GAP = 22;
const BASE_SPEED = 60;
const MAX_SPEED = 160;

export interface OrderbookLabelSlot {
  active: number;
  y: number;
  text: string;
  green: number;
  life: number;
  maxLife: number;
  intensity: number;
  alpha: number;
}

export interface OrderbookRuntimeState {
  spawnTimerMs: number;
  smoothSpeed: number;
  prevBidTotal: number;
  prevAskTotal: number;
  churnRate: number;
  rng: number;
}

function clamp(n: number, min: number, max: number): number {
  "worklet";
  return Math.min(max, Math.max(min, n));
}

function nextRngState(state: number): number {
  "worklet";
  return (Math.imul(state, RNG_MULTIPLIER) + RNG_INCREMENT) >>> 0;
}

function rand01(state: number): number {
  "worklet";
  return state / RNG_MODULUS;
}

function formatSize(size: number): string {
  "worklet";
  if (size >= 10) return `$${Math.round(size)}`;
  if (size >= 1) return `$${size.toFixed(1)}`;
  return `$${size.toFixed(2)}`;
}

export function createOrderbookState(): OrderbookRuntimeState {
  return {
    spawnTimerMs: 0,
    smoothSpeed: BASE_SPEED,
    prevBidTotal: 0,
    prevAskTotal: 0,
    churnRate: 0,
    rng: 1337,
  };
}

export function createOrderbookLabelSlots(
  max: number = MAX_ORDERBOOK_LABELS,
): OrderbookLabelSlot[] {
  return Array.from({ length: max }, () => ({
    active: 0,
    y: 0,
    text: "",
    green: 1,
    life: 0,
    maxLife: LABEL_LIFETIME,
    intensity: 0,
    alpha: 0,
  }));
}

function findReusableSlot(
  labels: OrderbookLabelSlot[],
): OrderbookLabelSlot | null {
  "worklet";
  for (let i = 0; i < labels.length; i += 1) {
    if (labels[i].active === 0) return labels[i];
  }
  return null;
}

export function updateOrderbookLabels(
  labels: OrderbookLabelSlot[],
  state: OrderbookRuntimeState,
  orderbook: OrderbookData,
  topY: number,
  bottomY: number,
  chartHeight: number,
  dtMs: number,
  swingMagnitude: number,
): void {
  "worklet";

  const dtSec = dtMs / 1000;
  if (dtSec <= 0) return;

  let maxSize = 0;
  let bidTotal = 0;
  let askTotal = 0;

  for (let i = 0; i < orderbook.bids.length; i += 1) {
    const size = orderbook.bids[i]?.[1] ?? 0;
    if (!Number.isFinite(size) || size <= 0) continue;
    bidTotal += size;
    if (size > maxSize) maxSize = size;
  }

  for (let i = 0; i < orderbook.asks.length; i += 1) {
    const size = orderbook.asks[i]?.[1] ?? 0;
    if (!Number.isFinite(size) || size <= 0) continue;
    askTotal += size;
    if (size > maxSize) maxSize = size;
  }

  if (maxSize <= 0) {
    for (let i = 0; i < labels.length; i += 1) {
      labels[i].active = 0;
      labels[i].alpha = 0;
    }
    state.prevBidTotal = bidTotal;
    state.prevAskTotal = askTotal;
    state.churnRate = 0;
    state.spawnTimerMs = 0;
    return;
  }

  const prevTotal = state.prevBidTotal + state.prevAskTotal;
  const nextTotal = bidTotal + askTotal;
  let churnSignal = 0;

  if (prevTotal > 0) {
    const delta =
      Math.abs(bidTotal - state.prevBidTotal) +
      Math.abs(askTotal - state.prevAskTotal);
    churnSignal = Math.min(delta / prevTotal, 1);
  }

  state.prevBidTotal = bidTotal;
  state.prevAskTotal = askTotal;

  const churnLerp = churnSignal > state.churnRate ? 0.3 : 0.05;
  state.churnRate += (churnSignal - state.churnRate) * churnLerp;

  const activity = Math.max(clamp(swingMagnitude * 5, 0, 1), state.churnRate);
  const targetSpeed = BASE_SPEED + activity * (MAX_SPEED - BASE_SPEED);
  const speedLerp = 1 - Math.pow(0.95, dtMs / 16.67);
  state.smoothSpeed += (targetSpeed - state.smoothSpeed) * speedLerp;

  state.spawnTimerMs += dtMs;

  while (state.spawnTimerMs >= SPAWN_INTERVAL_MS) {
    state.spawnTimerMs -= SPAWN_INTERVAL_MS;

    const slot = findReusableSlot(labels);
    if (!slot) break;

    let tooClose = false;
    for (let i = 0; i < labels.length; i += 1) {
      if (labels[i].active !== 1) continue;
      if (Math.abs(labels[i].y - bottomY) < MIN_LABEL_GAP) {
        tooClose = true;
        break;
      }
    }
    if (tooClose) break;

    const bidCount = orderbook.bids.length;
    const askCount = orderbook.asks.length;
    const levelCount = bidCount + askCount;
    if (levelCount <= 0 || nextTotal <= 0) break;

    state.rng = nextRngState(state.rng);
    let pick = rand01(state.rng) * nextTotal;

    let pickedSize = 0;
    let pickedGreen = 1;

    for (let i = 0; i < bidCount; i += 1) {
      const size = orderbook.bids[i]?.[1] ?? 0;
      if (size <= 0) continue;
      pick -= size;
      if (pick <= 0) {
        pickedSize = size;
        pickedGreen = 1;
        break;
      }
    }

    if (pickedSize <= 0) {
      for (let i = 0; i < askCount; i += 1) {
        const size = orderbook.asks[i]?.[1] ?? 0;
        if (size <= 0) continue;
        pick -= size;
        if (pick <= 0) {
          pickedSize = size;
          pickedGreen = 0;
          break;
        }
      }
    }

    if (pickedSize <= 0) {
      // fallback: first valid level
      for (let i = 0; i < bidCount; i += 1) {
        const size = orderbook.bids[i]?.[1] ?? 0;
        if (size > 0) {
          pickedSize = size;
          pickedGreen = 1;
          break;
        }
      }
      if (pickedSize <= 0) {
        for (let i = 0; i < askCount; i += 1) {
          const size = orderbook.asks[i]?.[1] ?? 0;
          if (size > 0) {
            pickedSize = size;
            pickedGreen = 0;
            break;
          }
        }
      }
    }

    if (pickedSize <= 0) continue;

    const sizeRatio = clamp(pickedSize / Math.max(1e-6, maxSize), 0, 1);
    slot.active = 1;
    slot.y = bottomY;
    slot.text = `+ ${formatSize(pickedSize)}`;
    slot.green = pickedGreen;
    slot.life = LABEL_LIFETIME;
    slot.maxLife = LABEL_LIFETIME;
    slot.intensity = 0.5 + sizeRatio * 0.5;
    slot.alpha = 0;
  }

  const topCull = topY - 14;
  const range = Math.max(1e-6, bottomY - topY);

  for (let i = 0; i < labels.length; i += 1) {
    const label = labels[i];
    if (label.active !== 1) continue;

    label.life -= dtSec;
    if (label.life <= 0) {
      label.active = 0;
      label.alpha = 0;
      continue;
    }

    const yProgress = clamp((label.y - topY) / range, 0, 1);
    label.y -= state.smoothSpeed * (0.7 + 0.3 * yProgress) * dtSec;

    if (label.y < topCull) {
      label.active = 0;
      label.alpha = 0;
      continue;
    }

    const lifeRatio = clamp(label.life / Math.max(1e-6, label.maxLife), 0, 1);
    const fadeIn = Math.min((1 - lifeRatio) * 10, 1);
    const yRatio = clamp((label.y - topY) / Math.max(1e-6, chartHeight), 0, 1);
    const fadeOut = yRatio < 0.45 ? yRatio / 0.45 : 1;
    const strength = clamp(label.intensity * fadeIn * fadeOut, 0, 1);
    label.alpha = strength;
  }
}
