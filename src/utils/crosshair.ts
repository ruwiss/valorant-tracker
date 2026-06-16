import type { CrosshairLayer, CrosshairColor, CrosshairProfile } from "../lib/types";

// Pixels per Valorant unit. Valorant lengths are small (lineLength ~1-10),
// so we scale up for a legible preview. ~3 keeps proportions close to in-game.
const DEFAULT_SCALE = 3;

function rgba(c: CrosshairColor, opacity: number): string {
  const a = Math.max(0, Math.min(1, (c.a / 255) * opacity));
  return `rgba(${c.r}, ${c.g}, ${c.b}, ${a})`;
}

function layerColor(layer: CrosshairLayer): CrosshairColor {
  return layer.bUseCustomColor ? layer.colorCustom : layer.color;
}

// Draw a single axis-aligned rect plus, optionally, a black outline around it
// (separate top/bottom/left/right rects, like Valorant). Coordinates are in
// game units relative to the crosshair center; converted to canvas px here.
function rect(
  ctx: CanvasRenderingContext2D,
  scale: number,
  cx: number,
  cy: number,
  x: number,
  y: number,
  w: number,
  h: number,
  fill: string,
  outline: { width: number; color: string } | null,
) {
  const px = cx + x * scale;
  const py = cy + y * scale;
  const pw = w * scale;
  const ph = h * scale;

  if (outline && outline.width > 0) {
    const o = outline.width * scale;
    ctx.fillStyle = outline.color;
    // left, right, top, bottom strips around the rect
    ctx.fillRect(px - o, py - o, o, ph + o * 2);
    ctx.fillRect(px + pw, py - o, o, ph + o * 2);
    ctx.fillRect(px, py - o, pw, o);
    ctx.fillRect(px, py + ph, pw, o);
  }

  ctx.fillStyle = fill;
  ctx.fillRect(px, py, pw, ph);
}

// Draw one line group (inner or outer): the 4 arms around the center.
function drawLines(
  ctx: CanvasRenderingContext2D,
  scale: number,
  cx: number,
  cy: number,
  lines: CrosshairLayer["innerLines"],
  fill: string,
  outline: { width: number; color: string } | null,
) {
  if (!lines.bShowLines || lines.lineLength <= 0 || lines.lineThickness <= 0) return;

  const t = lines.lineThickness;
  const lenH = lines.lineLength; // horizontal arm length
  // Vertical length is only independent when vertical scaling is enabled;
  // otherwise both axes use lineLength (matches Valorant's behavior).
  const lenV = lines.bAllowVertScaling ? lines.lineLengthVertical : lines.lineLength;
  const gap = lines.lineOffset; // distance from center to the start of each arm

  // Left arm: horizontal rect, thin in y. Starts at -(gap+len), thickness tall.
  rect(ctx, scale, cx, cy, -gap - lenH, -t / 2, lenH, t, fill, outline);
  // Right arm
  rect(ctx, scale, cx, cy, gap, -t / 2, lenH, t, fill, outline);
  // Top arm: vertical rect, thin in x.
  rect(ctx, scale, cx, cy, -t / 2, -gap - lenV, t, lenV, fill, outline);
  // Bottom arm
  rect(ctx, scale, cx, cy, -t / 2, gap, t, lenV, fill, outline);
}

function drawCenterDot(
  ctx: CanvasRenderingContext2D,
  scale: number,
  cx: number,
  cy: number,
  layer: CrosshairLayer,
  color: CrosshairColor,
) {
  if (!layer.bDisplayCenterDot || layer.centerDotSize <= 0) return;
  // Center dot is a square in Valorant; size is the side length in units.
  const s = layer.centerDotSize;
  const outline =
    layer.bHasOutline && layer.outlineThickness > 0
      ? { width: layer.outlineThickness, color: rgba(layer.outlineColor, layer.outlineOpacity) }
      : null;
  rect(ctx, scale, cx, cy, -s / 2, -s / 2, s, s, rgba(color, layer.centerDotOpacity), outline);
}

/**
 * Render a crosshair layer onto a canvas, Valorant-style: outer lines, inner
 * lines, then the center dot, each with its own outline. Canvas is cleared.
 * `scale` is pixels-per-unit; defaults to a legible preview scale.
 */
export function drawCrosshair(
  canvas: HTMLCanvasElement,
  layer: CrosshairLayer,
  scale: number = DEFAULT_SCALE,
) {
  const ctx = canvas.getContext("2d");
  if (!ctx) return;

  const w = canvas.width;
  const h = canvas.height;
  const cx = w / 2;
  const cy = h / 2;

  ctx.clearRect(0, 0, w, h);

  const color = layerColor(layer);
  const outline =
    layer.bHasOutline && layer.outlineThickness > 0
      ? { width: layer.outlineThickness, color: rgba(layer.outlineColor, layer.outlineOpacity) }
      : null;

  drawLines(ctx, scale, cx, cy, layer.outerLines, rgba(color, layer.outerLines.opacity), outline);
  drawLines(ctx, scale, cx, cy, layer.innerLines, rgba(color, layer.innerLines.opacity), outline);
  drawCenterDot(ctx, scale, cx, cy, layer, color);
}

/** The layer shown in previews — the primary (unscoped) crosshair. */
export function previewLayer(profile: CrosshairProfile): CrosshairLayer {
  return profile.primary;
}
