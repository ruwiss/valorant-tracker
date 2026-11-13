import assert from "node:assert/strict";
import test from "node:test";
import { onOverlayHotkey, setOverlayHotkeyAction } from "../src/lib/overlayHotkey.ts";

test("an already registered F2 handler dispatches to the newest store action", () => {
  const calls: string[] = [];
  setOverlayHotkeyAction(() => calls.push("old store"));
  const nativeHandler = onOverlayHotkey;
  setOverlayHotkeyAction(() => calls.push("current store"));
  nativeHandler({ state: "Pressed" });
  nativeHandler({ state: "Released" });
  nativeHandler({ state: "Pressed" });
  assert.deepEqual(calls, ["current store", "current store"]);
});
test("a callback retained across module reloads also uses the latest action", async () => {
  const calls: string[] = [];
  const nativeHandler = onOverlayHotkey;
  setOverlayHotkeyAction(() => calls.push("old"));
  const reloaded = await import("../src/lib/overlayHotkey.ts?reload");
  reloaded.setOverlayHotkeyAction(() => calls.push("new"));
  nativeHandler({ state: "Pressed" });
  assert.deepEqual(calls, ["new"]);
});
