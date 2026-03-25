/**
 * PM2 monitor + idle check-in integration for the heartbeat runner.
 *
 * Runs before the standard heartbeat LLM call. Handles two things:
 *
 * 1. **PM2 error monitoring** — When new errors are found:
 *    - Delivers a code-formatted error summary (no LLM, reliable).
 *    - Calls the PRIMARY model (from config) for proposed fixes.
 *    - Both mirrored to session transcript for TG follow-up.
 *
 * 2. **Idle check-in** — When no user messages or alerts for N hours
 *    (default: 8), sends a brief check-in via the heartbeat model
 *    (cheap/auto) with a helpful Portara tip or market observation.
 *
 * Model usage:
 *   - Error summary formatting: code (no LLM cost).
 *   - Fix proposals: PRIMARY model from agents.defaults.model.primary.
 *   - Idle check-ins: heartbeat model (agents.defaults.heartbeat.model,
 *     e.g. openrouter/openrouter/auto — cheap/free).
 *
 * Both models are read dynamically from config at runtime — nothing is
 * hardcoded in this module.
 */

import { resolveAgentModelPrimary, resolveAgentWorkspaceDir } from "../agents/agent-scope.js";
import { appendCronStyleCurrentTimeLine } from "../agents/current-time.js";
import { resolveHeartbeatReplyPayload } from "../auto-reply/heartbeat-reply-payload.js";
import { getReplyFromConfig } from "../auto-reply/reply.js";
import type { OpenClawConfig } from "../config/config.js";
import type { AgentDefaultsConfig } from "../config/types.agent-defaults.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import type { HeartbeatDeps } from "./heartbeat-runner.js";
import { deliverOutboundPayloads } from "./outbound/deliver.js";
import type { OutboundTarget } from "./outbound/targets.js";
import {
  collectPm2Errors,
  formatErrorContext,
  formatErrorSummary,
  hasRunningPm2Processes,
  readPm2MonitorState,
  writePm2MonitorState,
} from "./pm2-monitor.js";

const log = createSubsystemLogger("heartbeat/pm2");

type HeartbeatConfig = AgentDefaultsConfig["heartbeat"];

const DEFAULT_IDLE_HOURS = 8;

export type Pm2MonitorPhaseResult = {
  /** True if the PM2 phase handled this heartbeat tick (errors found or idle check-in sent). */
  handled: boolean;
};

const FIX_PROMPT_TEMPLATE = `The PM2 strategy errors above were just surfaced to the user. For each error pattern in each strategy/process, propose a concise, actionable fix.

Rules:
- Group fixes by strategy/process name.
- Be brief — one or two sentences per fix.
- If you can identify the root cause, state it directly.
- If the error is transient (network timeouts, rate limits), say so and suggest retry/backoff config.
- Do not repeat the error summary — the user already has it.
- Do NOT use any tools (exec, process, write, read, etc.) — respond with text only.`;

const IDLE_CHECKIN_PROMPT = `It has been over 8 hours since the user last interacted. Send ONE brief, friendly check-in message (1-2 sentences). Pick one of these:
- An idea for an interesting trading strategy the user could build and deploy with Portara (e.g. grid trading, momentum scalping, mean reversion, funding-rate arb, cross-exchange spread).
- A tip on how Portara helps strategise, deploy, or monitor strategies (e.g. backtesting, live deployment via PM2, real-time error alerts, performance tracking).
- A reminder about a useful Portara command: /mystrategies to list all strategies with their status, /mybalances to check exchange balances, /myorders to see open orders, /mypositions to view open positions, /update_portara to update the agent, /new to start a fresh session.

Focus on what Portara can do for the user — strategy ideas, deployment workflows, monitoring capabilities. Do NOT talk about general market observations or prices.
Do NOT ask if they need help. Do NOT be generic. Be specific and actionable. Do NOT repeat previous check-ins.`;

export async function runPm2MonitorPhase(opts: {
  cfg: OpenClawConfig;
  agentId: string;
  heartbeat?: HeartbeatConfig;
  sessionKey: string;
  delivery: OutboundTarget & { channel: Exclude<OutboundTarget["channel"], "none">; to: string };
  sender: string;
  startedAt: number;
  /** Session updatedAt — reflects last real user interaction (heartbeat-OK runs are excluded). */
  sessionUpdatedAt?: number;
  deps?: HeartbeatDeps;
}): Promise<Pm2MonitorPhaseResult> {
  const { cfg, agentId, heartbeat } = opts;
  const pm2Cfg = heartbeat?.pm2Monitor;
  if (!pm2Cfg?.enabled) {
    return { handled: false };
  }

  const workspaceDir = resolveAgentWorkspaceDir(cfg, agentId);
  if (!workspaceDir) {
    log.warn("pm2-monitor: no workspace dir resolved, skipping");
    return { handled: false };
  }

  // Read last-check state
  const state = await readPm2MonitorState(workspaceDir);

  // ── PM2 error monitoring ─────────────────────────────────────────
  const result = await collectPm2Errors({
    lastCheck: state.lastCheck,
    logLines: pm2Cfg.logLines,
    errorPatterns: pm2Cfg.errorPatterns,
  });

  // Always advance the PM2 log cursor
  await writePm2MonitorState(workspaceDir, { lastCheck: result.latestTimestamp });

  if (result.hasErrors) {
    return handlePm2Errors(opts, result);
  }

  // ── Idle check-in ────────────────────────────────────────────────
  const idleHours = pm2Cfg.idleHours ?? DEFAULT_IDLE_HOURS;
  if (idleHours > 0) {
    const idleResult = await maybeIdleCheckIn(opts, state, workspaceDir, idleHours);
    if (idleResult.handled) {
      return idleResult;
    }
  }

  return { handled: false };
}

// ─── PM2 error handling ──────────────────────────────────────────────

async function handlePm2Errors(
  opts: Parameters<typeof runPm2MonitorPhase>[0],
  result: Awaited<ReturnType<typeof collectPm2Errors>>,
): Promise<Pm2MonitorPhaseResult> {
  const { cfg, agentId, sessionKey, delivery, sender, startedAt } = opts;

  // Step 1: Deliver code-formatted error summary (no LLM)
  const errorSummary = formatErrorSummary(result);
  log.info("pm2-monitor: new errors found, delivering summary", {
    processCount: result.processes.length,
    errorCount: result.processes.reduce((sum, p) => sum + p.errors.length, 0),
  });

  await deliverOutboundPayloads({
    cfg,
    channel: delivery.channel,
    to: delivery.to,
    accountId: delivery.accountId,
    threadId: delivery.threadId,
    agentId,
    payloads: [{ text: errorSummary }],
    deps: opts.deps,
    mirror: { sessionKey, agentId, text: errorSummary },
  });

  // Step 2: Call PRIMARY model (from config) for proposed fixes
  const primaryModel =
    resolveAgentModelPrimary(cfg, agentId) ?? cfg.agents?.defaults?.model?.primary;
  if (!primaryModel) {
    log.warn("pm2-monitor: no primary model configured, skipping fix proposal");
    return { handled: true };
  }

  const errorContext = formatErrorContext(result);
  const fixPrompt = `${errorContext}\n\n${FIX_PROMPT_TEMPLATE}`;
  const fixCtx = {
    Body: appendCronStyleCurrentTimeLine(fixPrompt, cfg, startedAt),
    From: sender,
    To: sender,
    Provider: "pm2-monitor",
    SessionKey: sessionKey,
  };

  try {
    const fixReply = await getReplyFromConfig(
      fixCtx,
      {
        isHeartbeat: true,
        heartbeatModelOverride: primaryModel,
        suppressToolErrorWarnings: true,
        timeoutOverrideSeconds: 90,
      },
      cfg,
    );

    const fixPayload = resolveHeartbeatReplyPayload(fixReply);
    const fixText = fixPayload?.text?.trim();
    if (fixText) {
      await deliverOutboundPayloads({
        cfg,
        channel: delivery.channel,
        to: delivery.to,
        accountId: delivery.accountId,
        threadId: delivery.threadId,
        agentId,
        payloads: [{ text: fixText }],
        deps: opts.deps,
        mirror: { sessionKey, agentId, text: fixText },
      });
    }
  } catch (err) {
    log.error("pm2-monitor: fix proposal generation failed", { error: String(err) });
  }

  return { handled: true };
}

// ─── Idle check-in ───────────────────────────────────────────────────

async function maybeIdleCheckIn(
  opts: Parameters<typeof runPm2MonitorPhase>[0],
  state: Awaited<ReturnType<typeof readPm2MonitorState>>,
  workspaceDir: string,
  idleHours: number,
): Promise<Pm2MonitorPhaseResult> {
  const { cfg, agentId, sessionKey, delivery, sender, startedAt } = opts;
  const idleMs = idleHours * 60 * 60 * 1000;
  const now = startedAt;

  // Check if session has been idle long enough
  const sessionUpdatedAt = opts.sessionUpdatedAt;
  if (typeof sessionUpdatedAt === "number" && now - sessionUpdatedAt < idleMs) {
    return { handled: false };
  }

  // Check if we already sent a check-in recently
  if (state.lastIdleCheckIn) {
    const lastCheckIn = new Date(state.lastIdleCheckIn).getTime();
    if (Number.isFinite(lastCheckIn) && now - lastCheckIn < idleMs) {
      return { handled: false };
    }
  }

  // Skip if strategies are actively running — user is using the system, don't nag
  if (await hasRunningPm2Processes()) {
    log.info("pm2-monitor: skipping idle check-in, PM2 processes are running");
    return { handled: false };
  }

  log.info("pm2-monitor: session idle, sending check-in", {
    idleHours,
    sessionUpdatedAt: sessionUpdatedAt ? new Date(sessionUpdatedAt).toISOString() : "unknown",
  });

  // Use the heartbeat model (cheap/auto) for check-ins — NOT the primary model
  const checkInCtx = {
    Body: appendCronStyleCurrentTimeLine(IDLE_CHECKIN_PROMPT, cfg, startedAt),
    From: sender,
    To: sender,
    Provider: "idle-checkin",
    SessionKey: sessionKey,
  };

  try {
    const reply = await getReplyFromConfig(
      checkInCtx,
      { isHeartbeat: true, suppressToolErrorWarnings: true, timeoutOverrideSeconds: 60 },
      cfg,
    );

    const payload = resolveHeartbeatReplyPayload(reply);
    const text = payload?.text?.trim();
    if (text) {
      await deliverOutboundPayloads({
        cfg,
        channel: delivery.channel,
        to: delivery.to,
        accountId: delivery.accountId,
        threadId: delivery.threadId,
        agentId,
        payloads: [{ text }],
        deps: opts.deps,
        mirror: { sessionKey, agentId, text },
      });

      await writePm2MonitorState(workspaceDir, {
        lastIdleCheckIn: new Date(now).toISOString(),
      });
      return { handled: true };
    }
  } catch (err) {
    log.error("pm2-monitor: idle check-in failed", { error: String(err) });
  }

  return { handled: false };
}
