export const BASE_WIDTH = 380;
export const SIDE_WIDTH = 260;
export const CHAT_WIDTH = 400;
export type ExpansionSide = "left" | "right";

export interface LayoutRequest {
  pane: "none" | "side" | "chat";
}
export interface Layout {
  side: ExpansionSide;
  panelWidth: number;
  width: number;
  x: number;
}

/** Coordinates and bounds are physical pixels; widths returned are logical pixels. */
export function planWindowLayout(
  anchorX: number,
  scale: number,
  bounds: { x: number; width: number },
  pane: LayoutRequest["pane"],
): Layout {
  const base = BASE_WIDTH * scale;
  const rightEdge = bounds.x + bounds.width;
  // Clamp only when the base overlay itself is outside the monitor work area.
  const anchor = Math.max(bounds.x, Math.min(anchorX, rightEdge - base));
  if (pane === "none") return { side: "right", panelWidth: 0, width: BASE_WIDTH, x: anchor };
  const desired = pane === "chat" ? CHAT_WIDTH : SIDE_WIDTH;
  const left = Math.max(0, anchor - bounds.x) / scale;
  const right = Math.max(0, rightEdge - anchor - base) / scale;
  const side: ExpansionSide = right >= desired || right >= left ? "right" : "left";
  // Prefer keeping the main overlay stationary. On small displays, shrink the pane
  // to a usable minimum before shifting the combined window inside the work area.
  const available = side === "right" ? right : left;
  const minimum = pane === "chat" ? 300 : SIDE_WIDTH;
  const panelWidth = Math.max(0, Math.min(desired, Math.max(minimum, available), Math.floor(bounds.width / scale) - BASE_WIDTH));
  const width = BASE_WIDTH + panelWidth;
  const requestedX = side === "left" ? anchor - panelWidth * scale : anchor;
  const x = Math.round(Math.max(bounds.x, Math.min(requestedX, rightEdge - width * scale)));
  return { side, panelWidth, width, x };
}
