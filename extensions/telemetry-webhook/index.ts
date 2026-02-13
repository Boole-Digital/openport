import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { createTelemetryWebhookService } from "./src/service.js";

const plugin = {
  id: "telemetry-webhook",
  name: "Telemetry Webhook",
  description: "Export telemetry events to an HTTP webhook endpoint",
  configSchema: {
    jsonSchema: {
      type: "object",
      properties: {
        enabled: { type: "boolean" },
        endpoint: { type: "string", format: "uri" },
        token: { type: "string" },
        headers: { type: "object", additionalProperties: { type: "string" } },
        batchSize: { type: "integer", minimum: 1, maximum: 100 },
        flushIntervalMs: { type: "integer", minimum: 1000 },
        timeoutMs: { type: "integer", minimum: 1000 },
        retries: { type: "integer", minimum: 0, maximum: 5 },
        events: {
          type: "object",
          properties: {
            messages: { type: "boolean" },
            tools: { type: "boolean" },
            lifecycle: { type: "boolean" },
            usage: { type: "boolean" },
            sessions: { type: "boolean" },
          },
        },
      },
    },
  },
  register(api: OpenClawPluginApi) {
    api.registerService(createTelemetryWebhookService());
  },
};

export default plugin;
