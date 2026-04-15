import { invoke, InvokeArgs } from "@tauri-apps/api/core";
import { toast } from "sonner";
import { useI18n } from "../lib/i18n";

// Map backend error messages to i18n keys
const ERROR_TRANSLATIONS: Record<string, string> = {
  "Not in game": "error.notInGame",
};

/**
 * Translate backend error message using i18n
 */
function translateError(error: string): string {
  const i18nKey = ERROR_TRANSLATIONS[error];
  if (i18nKey) {
    return useI18n.getState().t(i18nKey);
  }
  return error;
}

/**
 * Wrapper for Tauri's invoke function that adds automatic error handling and toast notifications.
 *
 * @param command The backend command to invoke
 * @param args Arguments to pass to the command
 * @param options Options for the invocation
 * @returns The result of the command
 */
export async function invokeCommand<T>(
  command: string,
  args?: InvokeArgs,
  options?: {
    /** Custom error message to show instead of the backend error */
    errorMessage?: string;
    /** Whether to suppress the error toast notification */
    suppressErrorToast?: boolean;
    /** Whether to show a success toast notification */
    successMessage?: string;
  }
): Promise<T | null> {
  try {
    const result = await invoke<T>(command, args);

    if (options?.successMessage) {
      toast.success(options.successMessage);
    }

    return result;
  } catch (error) {
    console.error(`Error invoking command "${command}":`, error);

    if (!options?.suppressErrorToast) {
      const rawMessage = typeof error === 'string' ? error : options?.errorMessage || "An unexpected error occurred";
      const message = translateError(rawMessage);
      toast.error(message);
    }

    // Re-throw so the caller can handle specific logic if needed
    throw error;
  }
}
