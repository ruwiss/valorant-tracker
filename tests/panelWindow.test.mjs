import assert from "node:assert/strict";
import { test, beforeEach } from "node:test";
import { registerHooks, stripTypeScriptTypes } from "node:module";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

// Run the actual stores with a deterministic native window. No game, network,
// browser, or OS window is needed for panel transitions and hide/show races.
const storage = new Map();
Object.defineProperty(globalThis, "localStorage", { configurable: true, value: {
  getItem: (key) => storage.get(key) ?? null,
  setItem: (key, value) => storage.set(key, value),
  removeItem: (key) => storage.delete(key),
} });
const native = {
  x: 1540, y: 100, width: 380, height: 800, scale: 1,
  visible: true, minimized: false, mutations: [], sizeGate: null,
};
const monitor = { position: { x: 0, y: 0 }, size: { width: 1920, height: 1080 },
  workArea: { position: { x: 0, y: 0 }, size: { width: 1920, height: 1040 } }, scaleFactor: 1 };
const win = {
  innerSize: async () => ({ width: native.width * native.scale, height: native.height * native.scale }),
  outerSize: async () => ({ width: native.width * native.scale, height: native.height * native.scale }),
  outerPosition: async () => ({ x: native.x, y: native.y }),
  scaleFactor: async () => native.scale,
  setSize: async (size) => {
    if (native.sizeGate) await native.sizeGate;
    native.width = size.width; native.height = size.height;
    native.mutations.push(["size", size.width]);
  },
  setPosition: async (pos) => { native.x = pos.x; native.y = pos.y; native.mutations.push(["position", pos.x]); },
  isVisible: async () => native.visible,
  isMinimized: async () => native.minimized,
  isMaximized: async () => false,
  hide: async () => { native.visible = false; },
  show: async () => { native.visible = true; },
  minimize: async () => { native.minimized = true; },
  unminimize: async () => { native.minimized = false; },
  setFocus: async () => {},
};
globalThis.__panelWindow = { win, monitor };
const windowModule = `
export class LogicalSize { constructor(width, height) { this.width = width; this.height = height; } }
export class PhysicalPosition { constructor(x, y) { this.x = x; this.y = y; } }
export const getCurrentWindow = () => globalThis.__panelWindow.win;
export const currentMonitor = async () => globalThis.__panelWindow.monitor;
export const monitorFromPoint = async () => globalThis.__panelWindow.monitor;
export const availableMonitors = async () => [globalThis.__panelWindow.monitor];
`;
const mocks = {
  "@tauri-apps/api/window": windowModule,
  "@tauri-apps/plugin-global-shortcut": "export const register = async () => {}; export const unregister = async () => {};",
};
registerHooks({
  resolve(specifier, context, next) {
    let source = mocks[specifier];
    if (specifier.endsWith("/utils/ipc")) source = "export const invokeCommand = async () => true;";
    if (specifier.endsWith("/lib/i18n")) source = "export const useI18n = { getState: () => ({ t: (key) => key }) };";
    if (source) return { url: "data:text/javascript," + encodeURIComponent(source), shortCircuit: true };
    if (specifier.startsWith(".") && context.parentURL?.startsWith("file:")) {
      const url = new URL(specifier, context.parentURL);
      if (!/\.[a-z]+$/i.test(url.pathname) && existsSync(fileURLToPath(url) + ".ts")) {
        return next(url.href + ".ts", context);
      }
    }
    return next(specifier, context);
  },
  load(url, context, next) {
    if (url.endsWith(".ts")) return { format: "module", shortCircuit: true,
      source: stripTypeScriptTypes(readFileSync(new URL(url), "utf8")) };
    return next(url, context);
  },
});
const { usePanelStore: panel, mainOverlayPosition } = await import("../src/stores/panelStore.ts");
const { useChatStore: chat } = await import("../src/stores/chatStore.ts");
const { useSettingsStore: settings } = await import("../src/stores/settingsStore.ts");
const defaultChatSidePanel = settings.getState().chatSidePanel;
const settle = () => panel.getState().syncWindowToState();
beforeEach(async () => {
  chat.getState().setIsOpen(false);
  await panel.getState().close();
  Object.assign(native, { x: 1540, y: 100, width: 380, scale: 1, visible: true, minimized: false, mutations: [], sizeGate: null });
  monitor.position.x = 0; monitor.workArea.position.x = 0;
  settings.setState({ chatSidePanel: true, windowStyle: "free", minimizeToTray: true, windowPosition: null });
});

test("chat replaces settings, gets 400px, and stays anchored on the right", async () => {
  await panel.getState().openSettings();
  assert.equal(native.width, 640);
  chat.getState().setIsOpen(true);
  await settle();
  assert.equal(panel.getState().isOpen, false);
  assert.equal(panel.getState().chatInline, true);
  assert.equal(panel.getState().expansionSide, "left");
  assert.equal(native.width, 780);
  assert.equal(native.x, 1140);
  assert.deepEqual(await mainOverlayPosition(), { x: 1540, y: 100 });
});
test("closing only chat collapses its extension and retains draft and conversation", async () => {
  chat.setState({ activeCid: "dm", drafts: { dm: "unsent text" } });
  chat.getState().setIsOpen(true); await settle();
  chat.getState().setIsOpen(false); await settle();
  assert.equal(native.width, 380);
  assert.equal(native.x, 1540);
  assert.equal(chat.getState().activeCid, "dm");
  assert.equal(chat.getState().drafts.dm, "unsent text");
});
test("opening a profile from chat closes chat and restores the profile width", async () => {
  chat.getState().setIsOpen(true); await settle();
  await panel.getState().openPlayer({ puuid: "friend", name: "Friend#1" }, "friends");
  assert.equal(chat.getState().isOpen, false);
  assert.equal(panel.getState().panelType, "player");
  assert.equal(native.width, 640);
  assert.equal(native.x, 1280);
});
test("disabled preference keeps legacy modal chat at base width", async () => {
  settings.getState().setChatSidePanel(false);
  await panel.getState().openSettings();
  chat.getState().setIsOpen(true); await settle();
  assert.equal(panel.getState().isOpen, false);
  assert.equal(panel.getState().chatInline, false);
  assert.equal(native.width, 380);
});
test("changing the preference while chat is open reconciles native width", async () => {
  chat.getState().setIsOpen(true); await settle();
  settings.getState().setChatSidePanel(false); await settle();
  assert.equal(native.width, 380);
  assert.equal(native.x, 1540);
  assert.equal(chat.getState().isOpen, true);
  settings.getState().setChatSidePanel(true); await settle();
  assert.equal(native.width, 780);
  assert.equal(native.x, 1140);
});
test("rapid transitions during native resizing end in the latest requested panel", async () => {
  let release; let entered;
  const started = new Promise(resolve => { entered = resolve; });
  const original = win.setSize;
  native.sizeGate = new Promise(resolve => { release = resolve; });
  win.setSize = async (size) => { entered(); await original(size); };
  const opening = panel.getState().openSettings();
  await started;
  chat.getState().setIsOpen(true);
  chat.getState().setIsOpen(false);
  const shop = panel.getState().openShop();
  release(); native.sizeGate = null;
  await opening; await shop; await settle();
  win.setSize = original;
  assert.equal(chat.getState().isOpen, false);
  assert.equal(panel.getState().panelType, "shop");
  assert.equal(native.width, 640);
  assert.equal(native.x, 1280);
});
test("hide and reveal keep chat, its left offset, and the main overlay position", async () => {
  chat.getState().setIsOpen(true); await settle();
  await settings.getState().hideWindow();
  assert.equal(native.visible, false);
  assert.deepEqual(settings.getState().windowPosition, { x: 1540, y: 100 });
  await settings.getState().toggleWindow();
  assert.equal(native.visible, true);
  assert.equal(native.x, 1140);
  assert.equal(native.width, 780);
  assert.equal(chat.getState().isOpen, true);
});
test("taskbar minimize also preserves the attached chat", async () => {
  settings.setState({ minimizeToTray: false });
  chat.getState().setIsOpen(true); await settle();
  await settings.getState().hideWindow();
  assert.equal(native.minimized, true);
  await settings.getState().toggleWindow();
  assert.equal(native.minimized, false);
  assert.equal(native.width, 780);
  assert.equal(native.x, 1140);
});
test("moving to the left edge can move the pane right without shifting the main overlay", async () => {
  chat.getState().setIsOpen(true); await settle();
  // Main overlay is now at 400px while chat occupies 0..400.
  native.x = 0;
  await panel.getState().syncWindowToState({ reposition: true });
  assert.equal(panel.getState().expansionSide, "right");
  assert.equal(native.x, 400);
  assert.equal((await mainOverlayPosition()).x, 400);
});
test("hiding while a resize is in flight never resurrects the window", async () => {
  let release; let entered;
  const started = new Promise(resolve => { entered = resolve; });
  const original = win.setSize;
  native.sizeGate = new Promise(resolve => { release = resolve; });
  win.setSize = async (size) => { entered(); await original(size); };
  chat.getState().setIsOpen(true);
  await started;
  const hiding = settings.getState().hideWindow();
  release(); native.sizeGate = null;
  await hiding; await settle();
  win.setSize = original;
  assert.equal(native.visible, false);
  assert.equal(native.width, 780);
  assert.equal(settings.getState().windowPosition.x, 1540);
});

test("the side-chat preference survives settings persistence", async () => {
  settings.getState().setChatSidePanel(false); await settle();
  const saved = JSON.parse(storage.get("valorant-tracker-settings-v3"));
  assert.equal(saved.state.chatSidePanel, false);
  settings.getState().setChatSidePanel(true); await settle();
  assert.equal(JSON.parse(storage.get("valorant-tracker-settings-v3")).state.chatSidePanel, true);
});
test("docking a left-expanded free window reanchors the main overlay at the left edge", async () => {
  chat.getState().setIsOpen(true); await settle();
  await settings.getState().setWindowStyle("docked");
  assert.equal(native.x, 0);
  assert.equal(panel.getState().expansionSide, "right");
  assert.equal((await mainOverlayPosition()).x, 0);
  await settings.getState().hideWindow();
  assert.equal(native.visible, false);
  assert.equal(native.x, -780);
  await settle();
  assert.equal(native.x, -780); // Synchronizing a hidden pane must not undo the slide.
  await settings.getState().toggleWindow();
  assert.equal(native.visible, true);
  assert.equal(native.x, 0);
  assert.equal(native.width, 780);
  assert.equal(chat.getState().isOpen, true);
});
test("free-window restoration accepts negative coordinates on a secondary monitor", async () => {
  monitor.position.x = -1920; monitor.workArea.position.x = -1920;
  settings.setState({ windowPosition: { x: -380, y: 100 } });
  await settings.getState().restoreWindowPosition();
  assert.equal(native.x, -380);
  chat.getState().setIsOpen(true); await settle();
  assert.equal(native.x, -780);
  chat.getState().setIsOpen(false); await settle();
  assert.equal(native.x, -380);
});

test("chat beside the overlay is enabled by default", () => {
  assert.equal(defaultChatSidePanel, true);
});
test("opening a panel does not poll while the native size report lags behind", async () => {
  const original = win.innerSize;
  let reads = 0;
  win.innerSize = async () => {
    reads += 1;
    return { width: 380, height: 800 };
  };
  try {
    await panel.getState().openSettings();
    assert.equal(native.width, 640);
    assert.equal(panel.getState().expansionWidth, 260);
    assert.equal(reads, 1);
  } finally {
    win.innerSize = original;
  }
});

test("settings images mount only after native window expansion completes", async () => {
  let release;
  let entered;
  const started = new Promise(resolve => { entered = resolve; });
  const original = win.setSize;
  native.sizeGate = new Promise(resolve => { release = resolve; });
  win.setSize = async (size) => { entered(); await original(size); };
  const opening = panel.getState().openSettings();
  try {
    assert.equal(panel.getState().isOpen, true);
    assert.equal(panel.getState().settingsReady, false);
    await started;
    assert.equal(panel.getState().settingsReady, false);
    release();
    await opening;
    assert.equal(panel.getState().settingsReady, true);
    assert.equal(native.width, 640);
  } finally {
    release();
    native.sizeGate = null;
    win.setSize = original;
  }
});
test("settings can mount immediately when another side panel already sized the window", async () => {
  await panel.getState().openShop();
  native.mutations = [];
  await panel.getState().openSettings();
  assert.equal(panel.getState().settingsReady, true);
  assert.deepEqual(native.mutations, []);
});

test("reveal restores attached chat if the native window resets width while showing", async () => {
  chat.getState().setIsOpen(true); await settle();
  await settings.getState().hideWindow();
  const original = win.show;
  win.show = async () => {
    await original();
    native.width = 380;
  };
  try {
    await settings.getState().toggleWindow();
    assert.equal(native.width, 780);
    assert.equal(panel.getState().chatInline, true);
    assert.equal(chat.getState().isOpen, true);
  } finally {
    win.show = original;
  }
});
test("reveal reapplies inline rendering even if its cached layout flag is stale", async () => {
  chat.getState().setIsOpen(true); await settle();
  await settings.getState().hideWindow();
  panel.setState({ chatInline: false });
  await settings.getState().toggleWindow();
  assert.equal(panel.getState().chatInline, true);
  assert.equal(panel.getState().expansionWidth, 400);
  assert.equal(chat.getState().isOpen, true);
});

test("docked reveal focuses only once the combined overlay has finished sliding in", async () => {
  settings.setState({ windowStyle: "docked" });
  native.x = 0;
  chat.getState().setIsOpen(true); await settle();
  await settings.getState().hideWindow();
  const original = win.setFocus;
  const focusedAt = [];
  win.setFocus = async () => { focusedAt.push(native.x); };
  try {
    await settings.getState().toggleWindow();
    assert.deepEqual(focusedAt, [0]);
    assert.equal(native.width, 780);
    assert.equal(chat.getState().isOpen, true);
  } finally {
    win.setFocus = original;
  }
});
