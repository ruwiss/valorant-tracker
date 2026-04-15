import { create } from "zustand";
import { invokeCommand } from "../utils/ipc";

// Mock types since the original folder was deleted
type LicenseStatus = any;
type LicenseValidation = any;
type MachineIdResponse = any;
type LicenseRequestData = any;
type LicenseData = any;

interface LicenseState {
  // State
  isChecking: boolean;
  isImporting: boolean;
  licenseStatus: LicenseStatus | null;
  machineId: MachineIdResponse | null;
  error: string | null;

  // Actions
  checkLicense: () => Promise<void>;
  getMachineId: () => Promise<void>;
  getLicenseRequestData: () => Promise<LicenseRequestData>;
  getActivationCode: () => Promise<string>;
  importLicense: (path: string) => Promise<LicenseValidation | null>;
  resetLicense: () => Promise<void>;
  getLicenseInfo: () => Promise<LicenseData | null>;
  clearError: () => void;
  isLicensed: () => boolean;
}

export const useLicenseStore = create<LicenseState>((set, get) => ({
  isChecking: false,
  isImporting: false,
  licenseStatus: null,
  machineId: null,
  error: null,

  resetLicense: async () => {
    try {
      await invokeCommand("reset_license", undefined, { successMessage: "Lisans başarıyla silindi" });
      // Reset local state immediately
      set({ licenseStatus: { status: "NotFound" } });
      await get().checkLicense();
    } catch (e) {
      set({ error: String(e) });
    }
  },

  getLicenseInfo: async () => {
    try {
      return await invokeCommand<LicenseData | null>("get_license_info", undefined, { suppressErrorToast: true });
    } catch {
      return null;
    }
  },

  checkLicense: async () => {
    set({ isChecking: true, error: null });
    try {
      const status = await invokeCommand<LicenseStatus>("check_license", undefined, { suppressErrorToast: true });
      if (status) set({ licenseStatus: status });
    } catch (e) {
      set({ error: String(e) });
    } finally {
      set({ isChecking: false });
    }
  },

  getMachineId: async () => {
    try {
      const response = await invokeCommand<MachineIdResponse>("get_machine_id", undefined, { suppressErrorToast: true });
      if (response) set({ machineId: response });
    } catch (e) {
      set({ error: String(e) });
    }
  },

  getLicenseRequestData: async (): Promise<LicenseRequestData> => {
    const res = await invokeCommand<LicenseRequestData>("get_license_request_data");
    if (!res) throw new Error("Failed to get license request data");
    return res;
  },

  getActivationCode: async (): Promise<string> => {
    const res = await invokeCommand<string>("get_activation_code");
    return res || "";
  },

  importLicense: async (path: string) => {
    set({ isImporting: true, error: null });
    try {
      const validation = await invokeCommand<LicenseValidation>("import_license", { path }, {
         successMessage: "Lisans dosyası başarıyla yüklendi!"
      });

      // Refresh license status after import
      await get().checkLicense();

      return validation;
    } catch (e) {
      set({ error: String(e) });
      return null;
    } finally {
      set({ isImporting: false });
    }
  },

  clearError: () => set({ error: null }),

  isLicensed: () => {
    return true; // Always free
  },
}));

// Helper to format expiration date
export function formatExpirationDate(timestamp: number | null, t: (key: string) => string, locale: string = "tr"): string {
  if (timestamp === null) {
    return t("header.lifetime");
  }
  const date = new Date(timestamp * 1000);
  return date.toLocaleString(locale === "tr" ? "tr-TR" : "en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

// Helper to check if license is expired
export function isExpired(timestamp: number | null): boolean {
  if (timestamp === null) return false;
  return Date.now() > timestamp * 1000;
}
