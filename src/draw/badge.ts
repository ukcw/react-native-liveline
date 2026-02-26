import type { SkPath } from "@shopify/react-native-skia";

export const BADGE_PAD_X = 10;
export const BADGE_PAD_Y = 3;
export const BADGE_TAIL_LEN = 5;
export const BADGE_TAIL_SPREAD = 2.5;
export const BADGE_LINE_H = 16;

export function createBadgePath(
  path: SkPath,
  left: number,
  top: number,
  pillW: number,
  pillH: number,
  tailLen: number,
  tailSpread: number,
): void {
  "worklet";
  path.rewind();

  const r = pillH / 2;
  const arcK = 0.5522847498 * r;
  const bodyLeft = left + tailLen;
  const bodyRight = bodyLeft + pillW;
  const tl = bodyLeft + r;
  const tr = bodyRight - r;
  const cy = top + r;
  const bottom = top + pillH;

  // Top edge and right semicircle (arc-accurate cubic approximation)
  path.moveTo(tl, top);
  path.lineTo(tr, top);
  path.cubicTo(tr + arcK, top, bodyRight, cy - arcK, bodyRight, cy);
  path.cubicTo(bodyRight, cy + arcK, tr + arcK, bottom, tr, bottom);

  // Bottom edge to the left side
  path.lineTo(tl, bottom);

  if (tailLen > 0) {
    // Curved tail joins into the left edge of the pill body.
    path.cubicTo(
      left + tailLen + 2,
      bottom,
      left + 3,
      cy + tailSpread,
      left,
      cy,
    );
    path.cubicTo(left + 3, cy - tailSpread, left + tailLen + 2, top, tl, top);
  } else {
    path.cubicTo(tl - arcK, bottom, bodyLeft, cy + arcK, bodyLeft, cy);
    path.cubicTo(bodyLeft, cy - arcK, tl - arcK, top, tl, top);
  }

  path.close();
}
