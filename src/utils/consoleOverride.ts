import { invoke } from "@tauri-apps/api/core";

/**
 * Initializes overrides for console methods to forward logs to the backend.
 * This allows frontend logs to be captured in the app.log file.
 */
export function initConsoleOverride() {
  const originalConsole = {
    log: console.log,
    warn: console.warn,
    error: console.error,
    info: console.info,
    debug: console.debug,
  };

  function sendToBackend(level: string, args: any[]) {
    try {
      // Safely convert args to string
      const message = args.map(arg => {
        if (arg instanceof Error) {
          return `${arg.name}: ${arg.message}\n${arg.stack || ''}`;
        }
        if (typeof arg === 'object') {
            try {
                return JSON.stringify(arg);
            } catch (e) {
                return String(arg); // Circular reference or other error
            }
        }
        return String(arg);
      }).join(' ');

      // Use raw invoke to avoid circular dependency with ipc.ts wrapper which might log errors
      invoke('log_frontend_message', { level, message }).catch(() => {
        // If backend logging fails (e.g. backend not ready), silently fail
        // to avoid infinite recursion if we tried to log the error
      });
    } catch (e) {
      // Ignore errors during log processing
    }
  }

  console.log = (...args) => {
    originalConsole.log(...args);
    sendToBackend('info', args);
  };

  console.warn = (...args) => {
    originalConsole.warn(...args);
    sendToBackend('warn', args);
  };

  console.error = (...args) => {
    originalConsole.error(...args);
    sendToBackend('error', args);
  };
  
  console.info = (...args) => {
      originalConsole.info(...args);
      sendToBackend('info', args);
  };

  console.debug = (...args) => {
      originalConsole.debug(...args);
      sendToBackend('debug', args);
  };
  
  console.log("[ConsoleOverride] Frontend logging initialized and forwarding to backend.");
}
