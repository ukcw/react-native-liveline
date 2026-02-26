import type { Momentum } from "../types";

const RNG_MULTIPLIER = 1664525;
const RNG_INCREMENT = 1013904223;
const RNG_MODULUS = 4294967296;

export const MAX_PARTICLES = 80;
const PARTICLE_LIFETIME = 1;
const PARTICLE_COOLDOWN_MS = 400;
const PARTICLE_MAGNITUDE_THRESHOLD = 0.08;
const PARTICLE_MAX_BURSTS = 3;
const SHAKE_DECAY_RATE = 0.002;
const SHAKE_MIN_AMPLITUDE = 0.2;

export interface ParticleSlot {
  active: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  size: number;
}

export interface ParticleRuntimeState {
  cooldownMs: number;
  burstCount: number;
  shakeAmplitude: number;
  shakeX: number;
  shakeY: number;
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

function findParticleSlot(slots: ParticleSlot[]): ParticleSlot | null {
  "worklet";
  for (let i = 0; i < slots.length; i += 1) {
    if (slots[i].active === 0) return slots[i];
  }
  return null;
}

export function createParticleState(): ParticleRuntimeState {
  return {
    cooldownMs: 0,
    burstCount: 0,
    shakeAmplitude: 0,
    shakeX: 0,
    shakeY: 0,
    rng: 24681357,
  };
}

export function createParticleSlots(
  max: number = MAX_PARTICLES,
): ParticleSlot[] {
  return Array.from({ length: max }, () => ({
    active: 0,
    x: 0,
    y: 0,
    vx: 0,
    vy: 0,
    life: 0,
    size: 0,
  }));
}

export function updateParticlesAndShake(
  slots: ParticleSlot[],
  state: ParticleRuntimeState,
  momentum: Momentum,
  dotX: number,
  dotY: number,
  swingMagnitude: number,
  dtMs: number,
  scale: number,
  downMomentumEnabled: boolean,
  shakeScale: number,
): void {
  "worklet";

  const dtSec = dtMs / 1000;
  if (dtSec <= 0) return;

  state.cooldownMs = Math.max(0, state.cooldownMs - dtMs);

  let burstIntensity = 0;

  if (swingMagnitude < PARTICLE_MAGNITUDE_THRESHOLD) {
    state.burstCount = 0;
  }

  const canSpawnDirection =
    momentum === "up" || (momentum === "down" && downMomentumEnabled);
  const canSpawn =
    canSpawnDirection &&
    state.cooldownMs <= 0 &&
    swingMagnitude >= PARTICLE_MAGNITUDE_THRESHOLD &&
    state.burstCount < PARTICLE_MAX_BURSTS;

  if (canSpawn) {
    state.cooldownMs = PARTICLE_COOLDOWN_MS;

    const mag = clamp(swingMagnitude * 5, 0, 1);
    const falloff =
      mag > 0.6
        ? 1
        : state.burstCount === 0
          ? 1
          : state.burstCount === 1
            ? 0.6
            : 0.35;

    state.burstCount += 1;
    burstIntensity = falloff;

    const safeScale = Math.max(0.25, scale);
    const count = Math.round((12 + mag * 20) * safeScale * falloff);
    const speedMultiplier = 1 + mag * 0.8;
    const isUp = momentum === "up";

    for (let i = 0; i < count; i += 1) {
      const slot = findParticleSlot(slots);
      if (!slot) break;

      state.rng = nextRngState(state.rng);
      const angleR1 = rand01(state.rng);
      state.rng = nextRngState(state.rng);
      const speedR = rand01(state.rng);
      state.rng = nextRngState(state.rng);
      const offXR = rand01(state.rng);
      state.rng = nextRngState(state.rng);
      const offYR = rand01(state.rng);
      state.rng = nextRngState(state.rng);
      const sizeR = rand01(state.rng);

      const baseAngle = isUp ? -Math.PI / 2 : Math.PI / 2;
      const spread = Math.PI * 1.2;
      const angle = baseAngle + (angleR1 - 0.5) * spread;
      const speed = (60 + speedR * 100) * speedMultiplier;

      slot.active = 1;
      slot.x = dotX + (offXR - 0.5) * 24;
      slot.y = dotY + (offYR - 0.5) * 8;
      slot.vx = Math.cos(angle) * speed;
      slot.vy = Math.sin(angle) * speed;
      slot.life = 1;
      slot.size = (1 + sizeR * 1.2) * safeScale * falloff;
    }
  }

  for (let i = 0; i < slots.length; i += 1) {
    const p = slots[i];
    if (p.active !== 1) continue;

    p.life -= dtSec / PARTICLE_LIFETIME;
    if (p.life <= 0) {
      p.active = 0;
      p.life = 0;
      continue;
    }

    p.x += p.vx * dtSec;
    p.y += p.vy * dtSec;
    p.vx *= 0.95;
    p.vy *= 0.95;
  }

  if (burstIntensity > 0) {
    const shake =
      (3 + swingMagnitude * 4) * burstIntensity * Math.max(0, shakeScale);
    if (shake > state.shakeAmplitude) {
      state.shakeAmplitude = shake;
    }
  }

  const decayRate = Math.pow(SHAKE_DECAY_RATE, dtSec);
  state.shakeAmplitude *= decayRate;

  if (state.shakeAmplitude < SHAKE_MIN_AMPLITUDE) {
    state.shakeAmplitude = 0;
    state.shakeX = 0;
    state.shakeY = 0;
    return;
  }

  state.rng = nextRngState(state.rng);
  const rx = rand01(state.rng);
  state.rng = nextRngState(state.rng);
  const ry = rand01(state.rng);

  state.shakeX = (rx - 0.5) * 2 * state.shakeAmplitude;
  state.shakeY = (ry - 0.5) * 2 * state.shakeAmplitude;
}
