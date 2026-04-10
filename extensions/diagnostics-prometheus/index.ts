import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { createDiagnosticsPrometheusService } from "./src/service.js";

export default definePluginEntry({
  id: "diagnostics-prometheus",
  name: "Diagnostics Prometheus",
  description: "Export diagnostics events as Prometheus metrics",
  register(api) {
    api.registerService(createDiagnosticsPrometheusService());
  },
});
