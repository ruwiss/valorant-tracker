import type { Locale } from "./lib/i18n";

/**
 * Notes for the running version. Filled by scripts/build_release.ps1.
 * Leave both strings empty to hide the card.
 * `devPreview` only applies to `pnpm tauri dev` / `pnpm dev`.
 */
export const changelogDevPreview = false;

// changelog-notes:start
export const changelogNotes: Record<Locale, string> = {
  tr: "- Mesaj geldiğinde bildirim alırsınız\n- Oyunculara artık not alınabilir\n- Ajan kilitlemesi başladığında artık iptal edilebilir\n- Bazı sorunlar giderildi",
  en: "- You’ll receive a notification when a message arrives\n- You can now add notes to players\n- You can now cancel agent locking once it starts\n\n\n- Fixed some issues",
};
// changelog-notes:end

export function changelogText(locale: Locale): string {
  return changelogNotes[locale].trim();
}

export function planChangelog(input: {
  notes: string;
  currentVersion: string;
  seenVersion: string | null;
  hasUsedAppBefore: boolean;
}): { show: boolean; markSeen: boolean } {
  const current = input.currentVersion.trim();
  if (!current) return { show: false, markSeen: false };

  const notes = input.notes.trim();
  if (!notes) {
    return { show: false, markSeen: input.seenVersion !== current };
  }

  if (!input.seenVersion && !input.hasUsedAppBefore) {
    return { show: false, markSeen: true };
  }

  if (input.seenVersion === current) {
    return { show: false, markSeen: false };
  }

  return { show: true, markSeen: false };
}
