import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
// Latin + latin-ext only (Turkish glyphs); skips the thai/vietnamese subsets.
import "@fontsource/chakra-petch/latin-500.css";
import "@fontsource/chakra-petch/latin-ext-500.css";
import "@fontsource/chakra-petch/latin-600.css";
import "@fontsource/chakra-petch/latin-ext-600.css";
import "@fontsource/chakra-petch/latin-700.css";
import "@fontsource/chakra-petch/latin-ext-700.css";
import "./index.css";
import { initConsoleOverride } from "./utils/consoleOverride";
// Registers window.__dumpSettings() in dev for inspecting captured game settings.
import "./utils/playerSettings";

import { ErrorBoundary } from "./components/ErrorBoundary";

// Initialize console override to forward logs to backend
initConsoleOverride();

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </React.StrictMode>,
);
