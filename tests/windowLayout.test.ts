import assert from "node:assert/strict";
import test from "node:test";
import { planWindowLayout } from "../src/lib/windowLayout.ts";

const screen = { x: 0, width: 1920 };
test("chat has its own width and opens right at the left screen edge", () => {
  assert.deepEqual(planWindowLayout(0, 1, screen, "chat"), {
    side: "right", panelWidth: 400, width: 780, x: 0,
  });
  assert.equal(planWindowLayout(0, 1, screen, "side").panelWidth, 260);
});
test("right edge opens left and closing restores the main overlay anchor", () => {
  const open = planWindowLayout(1540, 1, screen, "chat");
  assert.equal(open.side, "left");
  assert.equal(open.x, 1140);
  assert.equal(open.x + open.panelWidth, 1540);
  assert.equal(planWindowLayout(open.x + open.panelWidth, 1, screen, "none").x, 1540);
});
test("switching chat to a profile keeps the main overlay stationary", () => {
  const chat = planWindowLayout(1540, 1, screen, "chat");
  const profile = planWindowLayout(chat.x + chat.panelWidth, 1, screen, "side");
  assert.equal(profile.x + profile.panelWidth, 1540);
  assert.equal(profile.width, 640);
});
test("uses physical monitor coordinates with 150 percent display scaling", () => {
  const layout = planWindowLayout(1990, 1.5, { x: 0, width: 2560 }, "chat");
  assert.equal(layout.side, "left");
  assert.equal(layout.x, 1390);
  assert.equal(layout.x + layout.panelWidth * 1.5, 1990);
});
test("negative monitor origins and work area offsets are respected", () => {
  const layout = planWindowLayout(-380, 1, { x: -1920, width: 1920 }, "chat");
  assert.equal(layout.side, "left");
  assert.equal(layout.x, -780);
  assert.equal(planWindowLayout(80, 1, { x: 80, width: 1840 }, "chat").x, 80);
});
test("prefers right if it fits even when there is more room to the left", () => {
  assert.equal(planWindowLayout(1100, 1, screen, "chat").side, "right");
});
test("narrows chat before shifting the main overlay on cramped displays", () => {
  const layout = planWindowLayout(380, 1, { x: 0, width: 1140 }, "chat");
  assert.equal(layout.panelWidth, 380);
  assert.equal(layout.x, 380);
});
test("keeps the combined frame inside a display too narrow for full width", () => {
  for (const scale of [1, 1.25, 1.5, 2]) {
    for (const width of [800, 1024, 1920, 2560]) {
      if (width < 380 * scale) continue;
      for (let anchor = 0; anchor < width; anchor += 33) {
        const layout = planWindowLayout(anchor, scale, { x: 0, width }, "chat");
        assert.ok(layout.x >= 0);
        assert.ok(layout.x + layout.width * scale <= width + 1);
        assert.ok(layout.width >= 380);
      }
    }
  }
});
