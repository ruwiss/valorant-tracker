import { invokeCommand } from "./ipc";
import type { PlayerSettingsResponse } from "../lib/types";

/**
 * Capture the player's current in-game Valorant settings (sensitivity,
 * crosshair, keybinds, video, audio, ...) from the local Riot Client.
 *
 * Read-only. Returns null on failure (not connected, no saved data, etc.).
 * Use this to build settings presets.
 */
export async function capturePlayerSettings(): Promise<PlayerSettingsResponse | null> {
  return invokeCommand<PlayerSettingsResponse>("get_player_settings", undefined, {
    suppressErrorToast: true,
  });
}

// Dev helper: lets you inspect the raw settings from the devtools console
// while we design the presets model. Call `window.__dumpSettings()`.
if (import.meta.env.DEV) {
  (window as unknown as Record<string, unknown>).__dumpSettings = async () => {
    const s = await capturePlayerSettings();
    // Stringify so the full payload is forwarded to the backend terminal log,
    // not just shown as a collapsed object in DevTools.
    // eslint-disable-next-line no-console
    console.log("[PlayerSettings] captured:", JSON.stringify(s));
    return s;
  };
}
