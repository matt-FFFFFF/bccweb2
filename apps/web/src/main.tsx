import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./router.js";
import { setup as setupTelemetry } from "./lib/telemetry.js";

setupTelemetry();

const root = document.getElementById("root");
if (!root) throw new Error("Root element not found");

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>
);
