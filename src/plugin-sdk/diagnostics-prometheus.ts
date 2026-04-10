// Narrow plugin-sdk surface for the bundled diagnostics-prometheus plugin.
// Keep this list additive and scoped to symbols used under extensions/diagnostics-prometheus.

export type { DiagnosticEventPayload } from "../infra/diagnostic-events.js";
export { emitDiagnosticEvent, onDiagnosticEvent } from "../infra/diagnostic-events.js";
export { redactSensitiveText } from "../logging/redact.js";
export { emptyPluginConfigSchema } from "../plugins/config-schema.js";
export type {
  OpenClawPluginApi,
  OpenClawPluginService,
  OpenClawPluginServiceContext,
} from "../plugins/types.js";
