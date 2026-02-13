import type {
  AgentEventPayload,
  DiagnosticEventPayload,
  OpenClawPluginService,
} from "openclaw/plugin-sdk";
import { onAgentEvent, onDiagnosticEvent } from "openclaw/plugin-sdk";
import { randomUUID } from "node:crypto";

const DEFAULT_BATCH_SIZE = 10;
const DEFAULT_FLUSH_INTERVAL_MS = 30000; // 30 seconds
const DEFAULT_TIMEOUT_MS = 10000;
const DEFAULT_RETRIES = 2;

type TelemetryConfig = {
  enabled?: boolean;
  endpoint?: string;
  token?: string;
  headers?: Record<string, string>;
  batchSize?: number;
  flushIntervalMs?: number;
  timeoutMs?: number;
  retries?: number;
  events?: {
    messages?: boolean;
    tools?: boolean;
    lifecycle?: boolean;
    usage?: boolean;
    sessions?: boolean;
  };
};

type TelemetryEvent = {
  ts: number;
  instanceId: string;
  eventType: string;
  sessionKey?: string;
  runId?: string;
  data: Record<string, unknown>;
};

type TelemetryState = {
  enabled: boolean;
  endpoint: string;
  token?: string;
  headers: Record<string, string>;
  batchSize: number;
  flushIntervalMs: number;
  timeoutMs: number;
  retries: number;
  events: {
    messages: boolean;
    tools: boolean;
    lifecycle: boolean;
    usage: boolean;
    sessions: boolean;
  };
  instanceId: string;
  buffer: TelemetryEvent[];
  flushTimer: ReturnType<typeof setInterval> | null;
  agentUnsub: (() => void) | null;
  diagnosticUnsub: (() => void) | null;
  isFlushing: boolean;
  logger: {
    info: (msg: string) => void;
    warn: (msg: string) => void;
    error: (msg: string) => void;
    debug: (msg: string) => void;
  };
};

function mapAgentEventToTelemetry(
  evt: AgentEventPayload,
  state: TelemetryState,
): TelemetryEvent | null {
  const { stream, data, runId, sessionKey, ts } = evt;

  // Lifecycle events (agent start/end)
  if (stream === "lifecycle") {
    if (!state.events.lifecycle) return null;
    const phase = data.phase as string | undefined;
    return {
      ts,
      instanceId: state.instanceId,
      eventType: phase === "start" ? "agent.start" : phase === "end" ? "agent.end" : `agent.${phase}`,
      sessionKey,
      runId,
      data: { phase },
    };
  }

  // Tool events
  if (stream === "tool") {
    if (!state.events.tools) return null;
    const phase = data.phase as string | undefined;
    return {
      ts,
      instanceId: state.instanceId,
      eventType: phase === "start" ? "tool.start" : phase === "end" ? "tool.end" : `tool.${phase}`,
      sessionKey,
      runId,
      data: { name: data.name, phase },
    };
  }

  // Assistant messages
  if (stream === "assistant") {
    if (!state.events.messages) return null;
    return {
      ts,
      instanceId: state.instanceId,
      eventType: "assistant.text",
      sessionKey,
      runId,
      data: {
        contentLength: typeof data.content === "string" ? data.content.length : undefined,
      },
    };
  }

  // Error events - always capture
  if (stream === "error") {
    return {
      ts,
      instanceId: state.instanceId,
      eventType: "agent.error",
      sessionKey,
      runId,
      data: { error: data.error },
    };
  }

  return null;
}

function mapDiagnosticEventToTelemetry(
  evt: DiagnosticEventPayload,
  state: TelemetryState,
): TelemetryEvent | null {
  const { type, ts } = evt;

  // Model usage (token counts)
  if (type === "model.usage") {
    if (!state.events.usage) return null;
    const usage = (evt as { usage?: { input?: number; output?: number; total?: number } }).usage;
    return {
      ts,
      instanceId: state.instanceId,
      eventType: "model.usage",
      sessionKey: (evt as { sessionKey?: string }).sessionKey,
      data: {
        provider: (evt as { provider?: string }).provider,
        model: (evt as { model?: string }).model,
        tokensInput: usage?.input,
        tokensOutput: usage?.output,
        tokensTotal: usage?.total,
      },
    };
  }

  // Session state changes
  if (type === "session.state") {
    if (!state.events.sessions) return null;
    return {
      ts,
      instanceId: state.instanceId,
      eventType: "session.state",
      sessionKey: (evt as { sessionKey?: string }).sessionKey,
      data: { state: (evt as { state?: string }).state },
    };
  }

  // Message queued/processed
  if (type === "message.queued" || type === "message.processed") {
    if (!state.events.messages) return null;
    return {
      ts,
      instanceId: state.instanceId,
      eventType: type,
      sessionKey: (evt as { sessionKey?: string }).sessionKey,
      data: {
        channel: (evt as { channel?: string }).channel,
        outcome: (evt as { outcome?: string }).outcome,
      },
    };
  }

  return null;
}

async function fetchWithTimeout(
  url: string,
  options: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timeoutId);
  }
}

async function sendBatch(events: TelemetryEvent[], state: TelemetryState): Promise<void> {
  if (events.length === 0) return;

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...state.headers,
  };

  if (state.token) {
    headers["Authorization"] = `Bearer ${state.token}`;
  }

  let lastError: Error | null = null;
  for (let attempt = 0; attempt <= state.retries; attempt++) {
    try {
      const response = await fetchWithTimeout(
        state.endpoint,
        {
          method: "POST",
          headers,
          body: JSON.stringify({ events }),
        },
        state.timeoutMs,
      );

      if (response.ok) {
        state.logger.debug(`Sent ${events.length} telemetry events`);
        return;
      }

      lastError = new Error(`HTTP ${response.status}: ${response.statusText}`);
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
    }

    if (attempt < state.retries) {
      // Exponential backoff: 500ms, 1000ms, 2000ms...
      await new Promise((r) => setTimeout(r, 500 * Math.pow(2, attempt)));
    }
  }

  state.logger.error(`Failed to send telemetry: ${lastError?.message}`);
}

function enqueueEvent(event: TelemetryEvent | null, state: TelemetryState): void {
  if (!event) return;
  state.buffer.push(event);

  if (state.buffer.length >= state.batchSize) {
    void flushBuffer(state);
  }
}

async function flushBuffer(state: TelemetryState): Promise<void> {
  if (state.buffer.length === 0 || state.isFlushing) return;

  state.isFlushing = true;
  const batch = state.buffer.splice(0, state.batchSize);

  try {
    await sendBatch(batch, state);
  } finally {
    state.isFlushing = false;
  }

  // Continue flushing if more events accumulated
  if (state.buffer.length >= state.batchSize) {
    void flushBuffer(state);
  }
}

export function createTelemetryWebhookService(): OpenClawPluginService {
  let state: TelemetryState | null = null;

  return {
    id: "telemetry-webhook",

    async start(ctx) {
      const cfg = ctx.config.plugins?.["telemetry-webhook"] as TelemetryConfig | undefined;

      if (!cfg?.enabled || !cfg.endpoint) {
        ctx.logger.debug("Telemetry webhook disabled or no endpoint configured");
        return;
      }

      const instanceId = randomUUID();

      state = {
        enabled: true,
        endpoint: cfg.endpoint,
        token: cfg.token,
        headers: cfg.headers ?? {},
        batchSize: cfg.batchSize ?? DEFAULT_BATCH_SIZE,
        flushIntervalMs: cfg.flushIntervalMs ?? DEFAULT_FLUSH_INTERVAL_MS,
        timeoutMs: cfg.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        retries: cfg.retries ?? DEFAULT_RETRIES,
        events: {
          messages: cfg.events?.messages ?? true,
          tools: cfg.events?.tools ?? false, // Disabled by default - focus on messages
          lifecycle: cfg.events?.lifecycle ?? true,
          usage: cfg.events?.usage ?? true,
          sessions: cfg.events?.sessions ?? false, // Disabled by default
        },
        instanceId,
        buffer: [],
        flushTimer: null,
        agentUnsub: null,
        diagnosticUnsub: null,
        isFlushing: false,
        logger: ctx.logger,
      };

      // Subscribe to agent events
      state.agentUnsub = onAgentEvent((evt) => {
        if (!state) return;
        enqueueEvent(mapAgentEventToTelemetry(evt, state), state);
      });

      // Subscribe to diagnostic events
      state.diagnosticUnsub = onDiagnosticEvent((evt) => {
        if (!state) return;
        enqueueEvent(mapDiagnosticEventToTelemetry(evt, state), state);
      });

      // Periodic flush timer
      state.flushTimer = setInterval(() => {
        if (state) void flushBuffer(state);
      }, state.flushIntervalMs);
      state.flushTimer.unref?.();

      ctx.logger.info(`Telemetry webhook started: endpoint=${cfg.endpoint}, instanceId=${instanceId}`);
    },

    async stop() {
      if (!state) return;

      // Clear timer
      if (state.flushTimer) {
        clearInterval(state.flushTimer);
        state.flushTimer = null;
      }

      // Unsubscribe from events
      state.agentUnsub?.();
      state.diagnosticUnsub?.();

      // Flush remaining events
      while (state.buffer.length > 0) {
        await flushBuffer(state);
      }

      state.logger.info("Telemetry webhook stopped");
      state = null;
    },
  };
}
