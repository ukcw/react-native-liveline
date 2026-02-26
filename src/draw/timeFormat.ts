import type { TimeFormatPreset } from "../types";

const ONE_DAY_SECS = 86_400;
const ONE_HOUR_SECS = 3_600;
const ONE_WEEK_SECS = 7 * ONE_DAY_SECS;
const SIX_MONTHS_SECS = 180 * ONE_DAY_SECS;

const MONTHS_SHORT = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

function pad2(n: number): string {
  "worklet";
  return n < 10 ? `0${n}` : `${n}`;
}

function formatHHmm(d: Date): string {
  "worklet";
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

function formatHHmmss(d: Date): string {
  "worklet";
  return `${formatHHmm(d)}:${pad2(d.getSeconds())}`;
}

function formatHourAmPm(d: Date): string {
  "worklet";
  const hours24 = d.getHours();
  const suffix = hours24 >= 12 ? "PM" : "AM";
  const hours12 = hours24 % 12 === 0 ? 12 : hours24 % 12;
  return `${hours12} ${suffix}`;
}

function formatHourMinuteAmPm(d: Date): string {
  "worklet";
  const hours24 = d.getHours();
  const suffix = hours24 >= 12 ? "PM" : "AM";
  const hours12 = hours24 % 12 === 0 ? 12 : hours24 % 12;
  return `${hours12}:${pad2(d.getMinutes())} ${suffix}`;
}

function formatHourMinuteSecondAmPm(d: Date): string {
  "worklet";
  const hours24 = d.getHours();
  const suffix = hours24 >= 12 ? "PM" : "AM";
  const hours12 = hours24 % 12 === 0 ? 12 : hours24 % 12;
  return `${hours12}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())} ${suffix}`;
}

function formatMonthDay(d: Date): string {
  "worklet";
  const month = MONTHS_SHORT[d.getMonth()] ?? "Jan";
  return `${month} ${d.getDate()}`;
}

function formatMonthDayYear(d: Date): string {
  "worklet";
  return `${formatMonthDay(d)}, ${d.getFullYear()}`;
}

function formatMonthYear(d: Date): string {
  "worklet";
  const month = MONTHS_SHORT[d.getMonth()] ?? "Jan";
  return `${month} ${d.getFullYear()}`;
}

function resolvePreset(preset: TimeFormatPreset | undefined): TimeFormatPreset {
  "worklet";
  return preset ?? "auto";
}

export function formatAxisTimeByPresetWorklet(
  ms: number,
  windowSecs: number,
  intervalSecs: number,
  preset: TimeFormatPreset | undefined,
): string {
  "worklet";
  const d = new Date(ms);
  const resolved = resolvePreset(preset);

  if (resolved === "intraday") {
    return intervalSecs < 60 ? formatHHmmss(d) : formatHHmm(d);
  }
  if (resolved === "swing") {
    return formatMonthDay(d);
  }
  if (resolved === "dateOnly") {
    return formatMonthDay(d);
  }
  if (resolved === "dateTime") {
    return `${formatMonthDay(d)} ${formatHHmm(d)}`;
  }

  // auto
  if (windowSecs <= ONE_DAY_SECS) {
    return intervalSecs < 60 ? formatHHmmss(d) : formatHHmm(d);
  }
  if (windowSecs <= SIX_MONTHS_SECS) {
    return formatMonthDay(d);
  }
  return formatMonthYear(d);
}

export function formatCrosshairTimeByPresetWorklet(
  ms: number,
  windowSecs: number,
  preset: TimeFormatPreset | undefined,
): string {
  "worklet";
  const d = new Date(ms);
  const resolved = resolvePreset(preset);

  if (resolved === "intraday") {
    return formatHHmmss(d);
  }
  if (resolved === "swing") {
    return `${formatMonthDay(d)}, ${formatHHmm(d)}`;
  }
  if (resolved === "dateOnly") {
    return formatMonthDayYear(d);
  }
  if (resolved === "dateTime") {
    return `${formatMonthDayYear(d)} ${formatHHmm(d)}`;
  }

  // auto: relative-to-now crosshair context.
  // Keep windowSecs in the signature for API stability and custom formatter parity.
  void windowSecs;
  const now = new Date(Date.now());
  if (d.getFullYear() !== now.getFullYear()) {
    return formatMonthDayYear(d);
  }
  const ageMs = now.getTime() - d.getTime();
  const absAgeMs = Math.abs(ageMs);
  const isSameDay =
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate();
  if (isSameDay) {
    return absAgeMs < ONE_HOUR_SECS * 1000
      ? formatHourMinuteSecondAmPm(d)
      : formatHourMinuteAmPm(d);
  }
  if (ageMs > ONE_WEEK_SECS * 1000) {
    return formatMonthDay(d);
  }
  return `${formatMonthDay(d)} at ${formatHourAmPm(d)}`;
}
