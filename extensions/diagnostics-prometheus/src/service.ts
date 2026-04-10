import http from "node:http";
import client from "prom-client";
import type { DiagnosticEventPayload, OpenClawPluginService } from "../api.js";
import { onDiagnosticEvent, redactSensitiveText } from "../api.js";

const DEFAULT_PORT = 9090;
const DEFAULT_PATH = "/metrics";
const DEFAULT_PREFIX = "openclaw_";

function formatError(err: unknown): string {
  if (err instanceof Error) {
    return err.stack ?? err.message;
  }
  if (typeof err === "string") {
    return err;
  }
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

export function createDiagnosticsPrometheusService(): OpenClawPluginService {
  let unsubscribe: (() => void) | null = null;
  let server: http.Server | null = null;

  return {
    id: "diagnostics-prometheus",
    async start(ctx) {
      const cfg = ctx.config.diagnostics;
      const prom = cfg?.prometheus;
      if (!cfg?.enabled || !prom?.enabled) {
        return;
      }

      const port = prom.port ?? DEFAULT_PORT;
      const metricsPath = prom.path ?? DEFAULT_PATH;
      const prefix = prom.prefix ?? DEFAULT_PREFIX;

      const registry = new client.Registry();

      if (prom.defaultLabels) {
        registry.setDefaultLabels(prom.defaultLabels);
      }

      // --- Info gauge ---
      const infoGauge = new client.Gauge({
        name: `${prefix}info`,
        help: "OpenClaw instance info",
        labelNames: ["service_name"] as const,
        registers: [registry],
      });
      infoGauge.set({ service_name: prom.defaultLabels?.service_name ?? "openclaw" }, 1);

      // --- Counters ---
      const tokensCounter = new client.Counter({
        name: `${prefix}tokens_total`,
        help: "Token usage by type",
        labelNames: ["channel", "provider", "model", "token_type"] as const,
        registers: [registry],
      });

      const costCounter = new client.Counter({
        name: `${prefix}cost_usd_total`,
        help: "Estimated model cost (USD)",
        labelNames: ["channel", "provider", "model"] as const,
        registers: [registry],
      });

      const webhookReceivedCounter = new client.Counter({
        name: `${prefix}webhook_received_total`,
        help: "Webhook requests received",
        labelNames: ["channel", "webhook_type"] as const,
        registers: [registry],
      });

      const webhookErrorCounter = new client.Counter({
        name: `${prefix}webhook_errors_total`,
        help: "Webhook processing errors",
        labelNames: ["channel", "webhook_type"] as const,
        registers: [registry],
      });

      const messageQueuedCounter = new client.Counter({
        name: `${prefix}messages_queued_total`,
        help: "Messages queued for processing",
        labelNames: ["channel", "source"] as const,
        registers: [registry],
      });

      const messageProcessedCounter = new client.Counter({
        name: `${prefix}messages_processed_total`,
        help: "Messages processed by outcome",
        labelNames: ["channel", "outcome"] as const,
        registers: [registry],
      });

      const laneEnqueueCounter = new client.Counter({
        name: `${prefix}queue_enqueue_total`,
        help: "Command queue lane enqueue events",
        labelNames: ["lane"] as const,
        registers: [registry],
      });

      const laneDequeueCounter = new client.Counter({
        name: `${prefix}queue_dequeue_total`,
        help: "Command queue lane dequeue events",
        labelNames: ["lane"] as const,
        registers: [registry],
      });

      const sessionStateCounter = new client.Counter({
        name: `${prefix}session_state_total`,
        help: "Session state transitions",
        labelNames: ["state", "reason"] as const,
        registers: [registry],
      });

      const sessionStuckCounter = new client.Counter({
        name: `${prefix}session_stuck_total`,
        help: "Sessions stuck in processing",
        labelNames: ["state"] as const,
        registers: [registry],
      });

      const runAttemptCounter = new client.Counter({
        name: `${prefix}run_attempts_total`,
        help: "Run attempts",
        labelNames: ["attempt"] as const,
        registers: [registry],
      });

      // --- Histograms ---
      const runDurationHistogram = new client.Histogram({
        name: `${prefix}run_duration_seconds`,
        help: "Agent run duration",
        labelNames: ["channel", "provider", "model"] as const,
        buckets: [1, 5, 10, 30, 60, 120, 300, 600],
        registers: [registry],
      });

      const contextTokensHistogram = new client.Histogram({
        name: `${prefix}context_tokens`,
        help: "Context window size and usage",
        labelNames: ["channel", "context_type"] as const,
        buckets: [1000, 10000, 50000, 100000, 200000, 500000, 1000000],
        registers: [registry],
      });

      const webhookDurationHistogram = new client.Histogram({
        name: `${prefix}webhook_duration_seconds`,
        help: "Webhook processing duration",
        labelNames: ["channel", "webhook_type"] as const,
        buckets: [0.01, 0.05, 0.1, 0.5, 1, 5],
        registers: [registry],
      });

      const messageDurationHistogram = new client.Histogram({
        name: `${prefix}message_duration_seconds`,
        help: "Message processing duration (end-to-end)",
        labelNames: ["channel", "outcome"] as const,
        buckets: [1, 5, 10, 30, 60, 120, 300, 600],
        registers: [registry],
      });

      const queueDepthHistogram = new client.Histogram({
        name: `${prefix}queue_depth`,
        help: "Queue depth on enqueue/dequeue",
        labelNames: ["lane"] as const,
        buckets: [1, 2, 5, 10, 20, 50],
        registers: [registry],
      });

      const queueWaitHistogram = new client.Histogram({
        name: `${prefix}queue_wait_seconds`,
        help: "Queue wait time before execution",
        labelNames: ["lane"] as const,
        buckets: [0.1, 0.5, 1, 5, 10, 30, 60],
        registers: [registry],
      });

      const sessionStuckAgeHistogram = new client.Histogram({
        name: `${prefix}session_stuck_age_seconds`,
        help: "Age of stuck sessions",
        labelNames: ["state"] as const,
        buckets: [60, 300, 600, 1800, 3600],
        registers: [registry],
      });

      // --- Event handlers ---

      const recordModelUsage = (evt: Extract<DiagnosticEventPayload, { type: "model.usage" }>) => {
        const labels = {
          channel: evt.channel ?? "unknown",
          provider: evt.provider ?? "unknown",
          model: evt.model ?? "unknown",
        };

        const usage = evt.usage;
        if (usage.input) {
          tokensCounter.inc({ ...labels, token_type: "input" }, usage.input);
        }
        if (usage.output) {
          tokensCounter.inc({ ...labels, token_type: "output" }, usage.output);
        }
        if (usage.cacheRead) {
          tokensCounter.inc({ ...labels, token_type: "cache_read" }, usage.cacheRead);
        }
        if (usage.cacheWrite) {
          tokensCounter.inc({ ...labels, token_type: "cache_write" }, usage.cacheWrite);
        }
        if (usage.total) {
          tokensCounter.inc({ ...labels, token_type: "total" }, usage.total);
        }

        if (evt.costUsd) {
          costCounter.inc(labels, evt.costUsd);
        }
        if (evt.durationMs) {
          runDurationHistogram.observe(labels, evt.durationMs / 1000);
        }
        if (evt.context?.limit) {
          contextTokensHistogram.observe(
            { channel: labels.channel, context_type: "limit" },
            evt.context.limit,
          );
        }
        if (evt.context?.used) {
          contextTokensHistogram.observe(
            { channel: labels.channel, context_type: "used" },
            evt.context.used,
          );
        }
      };

      const recordWebhookReceived = (
        evt: Extract<DiagnosticEventPayload, { type: "webhook.received" }>,
      ) => {
        webhookReceivedCounter.inc({
          channel: evt.channel ?? "unknown",
          webhook_type: evt.updateType ?? "unknown",
        });
      };

      const recordWebhookProcessed = (
        evt: Extract<DiagnosticEventPayload, { type: "webhook.processed" }>,
      ) => {
        const labels = {
          channel: evt.channel ?? "unknown",
          webhook_type: evt.updateType ?? "unknown",
        };
        if (typeof evt.durationMs === "number") {
          webhookDurationHistogram.observe(labels, evt.durationMs / 1000);
        }
      };

      const recordWebhookError = (
        evt: Extract<DiagnosticEventPayload, { type: "webhook.error" }>,
      ) => {
        webhookErrorCounter.inc({
          channel: evt.channel ?? "unknown",
          webhook_type: evt.updateType ?? "unknown",
        });
      };

      const recordMessageQueued = (
        evt: Extract<DiagnosticEventPayload, { type: "message.queued" }>,
      ) => {
        const labels = {
          channel: evt.channel ?? "unknown",
          source: evt.source ?? "unknown",
        };
        messageQueuedCounter.inc(labels);
        if (typeof evt.queueDepth === "number") {
          queueDepthHistogram.observe({ lane: labels.channel }, evt.queueDepth);
        }
      };

      const recordMessageProcessed = (
        evt: Extract<DiagnosticEventPayload, { type: "message.processed" }>,
      ) => {
        const labels = {
          channel: evt.channel ?? "unknown",
          outcome: evt.outcome ?? "unknown",
        };
        messageProcessedCounter.inc(labels);
        if (typeof evt.durationMs === "number") {
          messageDurationHistogram.observe(labels, evt.durationMs / 1000);
        }
      };

      const recordLaneEnqueue = (
        evt: Extract<DiagnosticEventPayload, { type: "queue.lane.enqueue" }>,
      ) => {
        const labels = { lane: evt.lane };
        laneEnqueueCounter.inc(labels);
        queueDepthHistogram.observe(labels, evt.queueSize);
      };

      const recordLaneDequeue = (
        evt: Extract<DiagnosticEventPayload, { type: "queue.lane.dequeue" }>,
      ) => {
        const labels = { lane: evt.lane };
        laneDequeueCounter.inc(labels);
        queueDepthHistogram.observe(labels, evt.queueSize);
        if (typeof evt.waitMs === "number") {
          queueWaitHistogram.observe(labels, evt.waitMs / 1000);
        }
      };

      const recordSessionState = (
        evt: Extract<DiagnosticEventPayload, { type: "session.state" }>,
      ) => {
        sessionStateCounter.inc({
          state: evt.state,
          reason: evt.reason ? redactSensitiveText(evt.reason) : "",
        });
      };

      const recordSessionStuck = (
        evt: Extract<DiagnosticEventPayload, { type: "session.stuck" }>,
      ) => {
        const labels = { state: evt.state };
        sessionStuckCounter.inc(labels);
        if (typeof evt.ageMs === "number") {
          sessionStuckAgeHistogram.observe(labels, evt.ageMs / 1000);
        }
      };

      const recordRunAttempt = (evt: Extract<DiagnosticEventPayload, { type: "run.attempt" }>) => {
        runAttemptCounter.inc({ attempt: String(evt.attempt) });
      };

      const recordHeartbeat = (
        evt: Extract<DiagnosticEventPayload, { type: "diagnostic.heartbeat" }>,
      ) => {
        queueDepthHistogram.observe({ lane: "heartbeat" }, evt.queued);
      };

      // --- Subscribe to events ---
      unsubscribe = onDiagnosticEvent((evt: DiagnosticEventPayload) => {
        try {
          switch (evt.type) {
            case "model.usage":
              recordModelUsage(evt);
              return;
            case "webhook.received":
              recordWebhookReceived(evt);
              return;
            case "webhook.processed":
              recordWebhookProcessed(evt);
              return;
            case "webhook.error":
              recordWebhookError(evt);
              return;
            case "message.queued":
              recordMessageQueued(evt);
              return;
            case "message.processed":
              recordMessageProcessed(evt);
              return;
            case "queue.lane.enqueue":
              recordLaneEnqueue(evt);
              return;
            case "queue.lane.dequeue":
              recordLaneDequeue(evt);
              return;
            case "session.state":
              recordSessionState(evt);
              return;
            case "session.stuck":
              recordSessionStuck(evt);
              return;
            case "run.attempt":
              recordRunAttempt(evt);
              return;
            case "diagnostic.heartbeat":
              recordHeartbeat(evt);
              return;
          }
        } catch (err) {
          ctx.logger.error(
            `diagnostics-prometheus: event handler failed (${evt.type}): ${formatError(err)}`,
          );
        }
      });

      // --- HTTP server for /metrics ---
      server = http.createServer(async (req, res) => {
        if (req.url === metricsPath && req.method === "GET") {
          try {
            const metricsOutput = await registry.metrics();
            res.writeHead(200, { "Content-Type": registry.contentType });
            res.end(metricsOutput);
          } catch (err) {
            res.writeHead(500);
            res.end("Internal Server Error");
            ctx.logger.error(`diagnostics-prometheus: metrics scrape failed: ${formatError(err)}`);
          }
        } else if (req.url === "/health" && req.method === "GET") {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ status: "ok", service: "diagnostics-prometheus" }));
        } else {
          res.writeHead(404);
          res.end("Not Found");
        }
      });

      await new Promise<void>((resolve, reject) => {
        server!.listen(port, () => {
          ctx.logger.info(`diagnostics-prometheus: serving metrics on :${port}${metricsPath}`);
          resolve();
        });
        server!.on("error", (err) => {
          ctx.logger.error(
            `diagnostics-prometheus: failed to start HTTP server: ${formatError(err)}`,
          );
          reject(err);
        });
      });
    },

    async stop() {
      unsubscribe?.();
      unsubscribe = null;
      if (server) {
        await new Promise<void>((resolve) => {
          server!.close(() => resolve());
        });
        server = null;
      }
    },
  } satisfies OpenClawPluginService;
}
