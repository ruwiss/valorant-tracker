/** Native shortcut callbacks outlive module hot updates. Keep their action live. */
interface OverlayHotkeyRuntime {
  toggle: (() => void | Promise<void>) | null;
}
const scope = globalThis as typeof globalThis & {
  __valorantOverlayHotkey?: OverlayHotkeyRuntime;
};
const runtime = scope.__valorantOverlayHotkey ??= { toggle: null };

export function setOverlayHotkeyAction(toggle: () => void | Promise<void>) {
  runtime.toggle = toggle;
}

export function onOverlayHotkey(event: { state: string }) {
  if (event.state === "Pressed") return runtime.toggle?.();
}
