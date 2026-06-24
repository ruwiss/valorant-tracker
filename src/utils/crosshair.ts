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

// ===== Valorant share-code generation =====
//
// Encodes a layer into the "profile code" string Valorant accepts in its
// "Import Profile Code" box (e.g. `0;P;c;5;0l;4;0o;2`). Format reverse-
// engineered by the community: a leading `0` version marker, a `P` (primary)
// section marker, then flat `key;value` pairs. Inner-line keys are prefixed
// `0`, outer-line keys `1`. Crucially, Valorant OMITS any key whose value equals
// its default — emitting defaults can produce a non-canonical/garbled import, so
// every field below is only pushed when it differs from the documented default.

// Built-in color presets, in index order. Index 8 means "custom" (color in `u`).
const PRESET_COLORS: ReadonlyArray<[number, number, number]> = [
  [255, 255, 255], // 0 white (default)
  [0, 255, 0], // 1 green
  [127, 255, 0], // 2 yellow-green
  [223, 255, 0], // 3 green-yellow
  [255, 255, 0], // 4 yellow
  [0, 255, 255], // 5 cyan
  [255, 0, 255], // 6 pink
  [255, 0, 0], // 7 red
];

// Format a float the way Valorant does: shortest decimal, no forced trailing
// zeros ("1" not "1.0", "0.35" not "0.350").
function num(n: number): string {
  return String(Math.round(n * 1000) / 1000);
}

function hex2(n: number): string {
  return Math.max(0, Math.min(255, Math.round(n))).toString(16).toUpperCase().padStart(2, "0");
}

function colorMatchesPreset(c: CrosshairColor): number {
  return PRESET_COLORS.findIndex(([r, g, b]) => r === c.r && g === c.g && b === c.b);
}

// Push line-group keys for one layer (inner: prefix "0", outer: prefix "1").
// Defaults differ between inner and outer, so they're passed in.
function pushLines(
  out: string[],
  prefix: "0" | "1",
  lines: CrosshairLayer["innerLines"],
  defs: { show: boolean; thickness: number; length: number; offset: number; opacity: number },
) {
  // Turning lines off collapses the whole group to "<prefix>b;0".
  if (lines.bShowLines !== defs.show) {
    out.push(`${prefix}b`, lines.bShowLines ? "1" : "0");
    if (!lines.bShowLines) return;
  }
  if (lines.lineThickness !== defs.thickness) out.push(`${prefix}t`, num(lines.lineThickness));
  if (lines.lineLength !== defs.length) out.push(`${prefix}l`, num(lines.lineLength));
  // Vertical length only meaningful (and only encodable) when unlinked.
  if (lines.bAllowVertScaling) {
    out.push(`${prefix}v`, num(lines.lineLengthVertical), `${prefix}g`, "1");
  }
  if (lines.lineOffset !== defs.offset) out.push(`${prefix}o`, num(lines.lineOffset));
  if (lines.opacity !== defs.opacity) out.push(`${prefix}a`, num(lines.opacity));
}

/**
 * Build a Valorant import code for a single (primary) crosshair layer.
 * Emits only non-default keys so the result matches what Valorant itself
 * produces. Returns a string like `0;P;c;5;0l;4`.
 */
export function buildCrosshairCode(layer: CrosshairLayer): string {
  const out: string[] = [];

  // Color: omit when white preset (default); emit index for other presets;
  // emit `c;8;u;RRGGBBAA` for a custom color.
  const color = layerColor(layer);
  const preset = layer.bUseCustomColor ? -1 : colorMatchesPreset(color);
  if (preset > 0) {
    out.push("c", String(preset));
  } else if (preset === -1) {
    out.push("c", "8", "u", `${hex2(color.r)}${hex2(color.g)}${hex2(color.b)}${hex2(color.a)}`);
  }
  // preset === 0 (white) → omit entirely.

  // Outlines: default ON. Only emit when off, else emit thickness/opacity diffs.
  if (!layer.bHasOutline) {
    out.push("h", "0");
  } else {
    if (layer.outlineThickness !== 1) out.push("t", num(layer.outlineThickness));
    if (layer.outlineOpacity !== 0.5) out.push("o", num(layer.outlineOpacity));
  }

  // Center dot: default OFF. Only emit the group when on.
  if (layer.bDisplayCenterDot) {
    out.push("d", "1");
    if (layer.centerDotSize !== 2) out.push("z", num(layer.centerDotSize));
    if (layer.centerDotOpacity !== 1) out.push("a", num(layer.centerDotOpacity));
  }

  pushLines(out, "0", layer.innerLines, {
    show: true,
    thickness: 2,
    length: 6,
    offset: 3,
    opacity: 0.8,
  });
  pushLines(out, "1", layer.outerLines, {
    show: true,
    thickness: 2,
    length: 2,
    offset: 10,
    opacity: 0.35,
  });

  return ["0", "P", ...out].join(";");
}
