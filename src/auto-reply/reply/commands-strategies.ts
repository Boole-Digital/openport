import { execFile } from "node:child_process";
import { open, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { TelegramInlineButtons } from "@openclaw/telegram/api.js";

type TelegramInlineButton = TelegramInlineButtons[number][number];
import type { ReplyPayload } from "../types.js";
import { rejectUnauthorizedCommand } from "./command-gates.js";
import type { CommandHandler } from "./commands-types.js";
import { isRoutableChannel, routeReply } from "./route-reply.js";

const execFileAsync = promisify(execFile);

// Max lines a user can request; keeps responses within messaging platform limits
const MAX_LOG_LINES = 50;
const DEFAULT_LOG_LINES = 20;
// Error lines always shown if present (separate section)
const STDERR_PEEK_LINES = 10;
// Safety cap: if log output exceeds this, trim from the top (keep newest)
const MAX_LOG_CHARS = 3500;

// Convention: agent creates user strategies in this workspace directory
const STRATEGIES_DIR = join(homedir(), ".openclaw/workspace/portara-agent/v3/strategies");

type Pm2Process = {
  name: string;
  pm2_env: {
    status: string;
    pm_uptime: number;
    restart_time: number;
    pm_out_log_path: string;
    pm_err_log_path: string;
    pm_exec_path?: string;
  };
  monit: {
    memory: number;
    cpu: number;
  };
};

type Strategy = {
  stem: string;
  process?: Pm2Process;
};

const STATUS_ORDER: Record<string, number> = {
  online: 0,
  launching: 1,
  stopping: 2,
  stopped: 3,
  errored: 4,
};

function statusEmoji(status: string): string {
  switch (status) {
    case "online":
      return "🟢";
    case "stopped":
      return "🔴";
    case "errored":
      return "❌";
    case "stopping":
    case "launching":
      return "🟡";
    default:
      return "⚪";
  }
}

function formatUptime(uptimeMs: number): string {
  const elapsed = Math.max(0, Date.now() - uptimeMs);
  const s = Math.floor(elapsed / 1000);
  if (s < 60) {
    return `${s}s`;
  }
  const m = Math.floor(s / 60) % 60;
  const h = Math.floor(s / 3600) % 24;
  const d = Math.floor(s / 86400);
  if (d > 0) {
    return h > 0 ? `${d}d ${h}h` : `${d}d`;
  }
  if (h > 0) {
    return m > 0 ? `${h}h ${m}m` : `${h}h`;
  }
  return `${m}m`;
}

function formatMemory(bytes: number): string {
  const mb = bytes / (1024 * 1024);
  if (mb < 1) {
    return `${Math.round(bytes / 1024)} KB`;
  }
  return mb < 100 ? `${mb.toFixed(1)} MB` : `${Math.round(mb)} MB`;
}

function formatProcess(proc: Pm2Process): string {
  const emoji = statusEmoji(proc.pm2_env.status);

  if (proc.pm2_env.status === "online") {
    const stats = [
      `⏱ ${formatUptime(proc.pm2_env.pm_uptime)}`,
      `⚙ ${proc.monit.cpu.toFixed(1)}%`,
      `💾 ${formatMemory(proc.monit.memory)}`,
    ];
    if (proc.pm2_env.restart_time > 0) {
      stats.push(`↺ ${proc.pm2_env.restart_time}`);
    }
    return `${emoji} ${proc.name}\n   ${stats.join("  ·  ")}`;
  }

  const statusLine =
    proc.pm2_env.restart_time > 0
      ? `${proc.pm2_env.status}  ·  ↺ ${proc.pm2_env.restart_time}`
      : proc.pm2_env.status;
  return `${emoji} ${proc.name}\n   ${statusLine}`;
}

function formatStrategy(s: Strategy): string {
  if (s.process) {
    return formatProcess(s.process);
  }
  return `⚪ ${s.stem}\n   not started`;
}

// Short /ms prefix keeps callback_data within Telegram's 64-byte limit.
// e.g. "/ms select buy_btc_dip" — stems are compact, well within 64 bytes.
const CB_PREFIX = "/ms";

function callbackData(action: string, name: string): string {
  const raw = `${CB_PREFIX} ${action} ${name}`;
  return Buffer.byteLength(raw, "utf8") <= 64 ? raw : raw.slice(0, 63);
}

// Truncate at 22 chars so button text fits on mobile without Telegram clipping it.
function buttonLabel(name: string): string {
  return name.length > 22 ? `${name.slice(0, 21)}…` : name;
}

// Overview: one button per strategy, status emoji tells you running/stopped at a glance.
function buildOverviewButtons(strategies: Strategy[]): TelegramInlineButtons {
  return strategies.map((s) => {
    const emoji = s.process ? statusEmoji(s.process.pm2_env.status) : "⚪";
    return [
      { text: `${emoji}  ${buttonLabel(s.stem)}`, callback_data: callbackData("select", s.stem) },
    ];
  });
}

// Detail buttons: paired primary actions on one row, secondary actions on their own rows.
function buildDetailButtons(s: Strategy): TelegramInlineButtons {
  const rows: TelegramInlineButton[][] = [];

  if (!s.process) {
    rows.push([{ text: "▶  Start", callback_data: callbackData("start", s.stem) }]);
    rows.push([{ text: "✏️  Work on Strategy", callback_data: callbackData("work", s.stem) }]);
    rows.push([{ text: "‹  All Strategies", callback_data: "/mystrategies" }]);
    return rows;
  }

  const { status } = s.process.pm2_env;
  if (status === "online") {
    rows.push([
      { text: "⏹  Stop", callback_data: callbackData("stop", s.stem) },
      { text: "↺  Restart", callback_data: callbackData("restart", s.stem) },
    ]);
  } else if (status === "stopped" || status === "errored") {
    rows.push([
      { text: "▶  Start", callback_data: callbackData("start", s.stem) },
      { text: "↺  Restart", callback_data: callbackData("restart", s.stem) },
    ]);
  } else {
    rows.push([{ text: "⏹  Stop", callback_data: callbackData("stop", s.stem) }]);
  }

  rows.push([{ text: "✏️  Work on Strategy", callback_data: callbackData("work", s.stem) }]);
  rows.push([{ text: "📋  View Logs", callback_data: callbackData("logs", s.stem) }]);
  rows.push([{ text: "‹  All Strategies", callback_data: "/mystrategies" }]);

  return rows;
}

async function fetchProcesses(): Promise<{ processes: Pm2Process[]; error?: string }> {
  let stdout: string;
  try {
    ({ stdout } = await execFileAsync("pm2", ["jlist"], { timeout: 8000 }));
  } catch (err) {
    const error = err as NodeJS.ErrnoException & { killed?: boolean };
    if (error.code === "ENOENT") {
      return { processes: [], error: "PM2 is not installed or not in PATH." };
    }
    if (error.killed) {
      return { processes: [], error: "PM2 query timed out. Is the PM2 daemon running?" };
    }
    return { processes: [], error: `PM2 error: ${error.message}` };
  }

  try {
    // PM2 startup noise includes "[PM2] ..." lines before the JSON array.
    // Find the "[" that begins its own line (the JSON array), not "[PM2]" prefixes.
    const lineStart = stdout.lastIndexOf("\n[");
    const jsonStart = lineStart !== -1 ? lineStart + 1 : stdout.startsWith("[") ? 0 : -1;
    const jsonEnd = stdout.lastIndexOf("]");
    const jsonStr =
      jsonStart !== -1 && jsonEnd > jsonStart ? stdout.slice(jsonStart, jsonEnd + 1) : stdout;
    const parsed = JSON.parse(jsonStr) as Pm2Process[];
    if (!Array.isArray(parsed)) {
      return { processes: [], error: "Unexpected PM2 output format." };
    }
    return { processes: parsed };
  } catch {
    return { processes: [], error: "Failed to parse PM2 output." };
  }
}

// Extract the file stem from a PM2 process's script path.
// e.g. "/root/.openclaw/workspace/portara-agent/v3/strategies/btc_does_nth.js" → "btc_does_nth"
function scriptStem(proc: Pm2Process): string | undefined {
  const execPath = proc.pm2_env.pm_exec_path;
  if (!execPath) {
    return undefined;
  }
  const filename = execPath.split("/").pop() ?? "";
  return filename.endsWith(".js") ? filename.slice(0, -3) : undefined;
}

// Match a PM2 process to a file stem.
// Primary: script path lives in the strategies directory and filename matches.
// Fallback: the PM2 name contains the stem (covers any naming convention).
function processMatchesStem(proc: Pm2Process, stem: string): boolean {
  // Primary: match by script path (most reliable)
  const pathStem = scriptStem(proc);
  if (pathStem === stem) {
    return true;
  }
  // Fallback: stem appears as the last colon-segment or equals the full name
  const name = proc.name;
  if (name === stem) {
    return true;
  }
  const lastColon = name.lastIndexOf(":");
  if (lastColon !== -1 && name.slice(lastColon + 1) === stem) {
    return true;
  }
  return false;
}

// Generate a PM2 name when starting a strategy via the slash command.
// Uses "strategy:<stem>" so the portara-agent recognises it as a strategy process
// in `pm2 list`. processMatchesStem still matches via the last-colon-segment check.
function stemToPm2Name(stem: string): string {
  return `strategy:${stem}`;
}

async function fetchStrategyFiles(): Promise<string[]> {
  try {
    const entries = await readdir(STRATEGIES_DIR);
    return entries
      .filter((f) => f.endsWith(".js") && !f.endsWith("_template.js"))
      .map((f) => f.slice(0, -3));
  } catch {
    return [];
  }
}

// Source of truth: strategy files on disk, enriched with PM2 runtime status.
// Matches PM2 processes to files by script path first, then by name.
// Falls back to PM2 strategy:* processes if the directory is unavailable.
async function fetchStrategies(): Promise<{ strategies: Strategy[]; error?: string }> {
  const [stems, { processes, error }] = await Promise.all([fetchStrategyFiles(), fetchProcesses()]);

  // Build a map: file stem → matching PM2 process
  const pm2ByStem = new Map<string, Pm2Process>();
  for (const stem of stems) {
    const proc = processes.find((p) => processMatchesStem(p, stem));
    if (proc) {
      pm2ByStem.set(stem, proc);
    }
  }

  const strategies = stems.map((stem) => ({ stem, process: pm2ByStem.get(stem) }));

  // Fallback: no files on disk but PM2 has strategy processes
  if (strategies.length === 0 && processes.length > 0) {
    const fallback = processes
      .filter((p) => p.name.startsWith("strategy:"))
      .map((p) => ({ stem: scriptStem(p) ?? p.name, process: p }));
    if (fallback.length > 0) {
      return { strategies: fallback };
    }
  }

  if (strategies.length === 0 && error) {
    return { strategies: [], error };
  }
  // Surface PM2 errors even when files exist so the user knows status is stale
  if (error) {
    return { strategies, error };
  }
  return { strategies };
}

function resolveProcess(processes: Pm2Process[], stem: string): Pm2Process | undefined {
  return processes.find((p) => processMatchesStem(p, stem));
}

// Reads the last `maxLines` non-empty lines from a file efficiently.
// Seeks near the end so it stays fast even on large log files.
async function tailFile(filePath: string, maxLines: number): Promise<string[]> {
  let file;
  try {
    file = await open(filePath, "r");
    const { size } = await file.stat();
    if (size === 0) {
      return [];
    }
    // Estimate ~150 bytes/line; overshoot to avoid missing lines
    const bytesToRead = Math.min(size, maxLines * 150 + 512);
    const buf = Buffer.allocUnsafe(bytesToRead);
    const { bytesRead } = await file.read(buf, 0, bytesToRead, size - bytesToRead);
    const text = buf.subarray(0, bytesRead).toString("utf8");
    const lines = text.split("\n");
    // Drop the first entry if we started mid-line (only when not at file start)
    const complete = size > bytesToRead ? lines.slice(1) : lines;
    return complete.filter((l) => l.trim()).slice(-maxLines);
  } catch {
    return [];
  } finally {
    await file?.close();
  }
}

// Build telegram channelData, optionally including an editMessageId so delivery
// edits the original message in place instead of sending a new one.
function telegramChannelData(
  buttons?: TelegramInlineButtons,
  editMessageId?: string,
): Record<string, unknown> {
  return {
    telegram: {
      ...(buttons ? { buttons } : {}),
      ...(editMessageId ? { editMessageId } : {}),
    },
  };
}

function buildListReply(
  strategies: Strategy[],
  channel: string,
  editMessageId?: string,
): ReplyPayload {
  if (strategies.length === 0) {
    return { text: "No strategies found." };
  }

  // Sort: running first, then by PM2 status order, unstarted last
  const sorted = [...strategies].toSorted((a, b) => {
    const aOrder = a.process ? (STATUS_ORDER[a.process.pm2_env.status] ?? 9) : 10;
    const bOrder = b.process ? (STATUS_ORDER[b.process.pm2_env.status] ?? 9) : 10;
    return aOrder - bOrder;
  });

  const counts: Record<string, number> = {};
  for (const s of strategies) {
    const status = s.process?.pm2_env.status ?? "not_started";
    counts[status] = (counts[status] ?? 0) + 1;
  }

  const summaryParts: string[] = [];
  if (counts["online"]) {
    summaryParts.push(`${counts["online"]} running`);
  }
  if (counts["stopped"]) {
    summaryParts.push(`${counts["stopped"]} stopped`);
  }
  if (counts["errored"]) {
    summaryParts.push(`${counts["errored"]} errored`);
  }
  const transitioning = (counts["launching"] ?? 0) + (counts["stopping"] ?? 0);
  if (transitioning) {
    summaryParts.push(`${transitioning} transitioning`);
  }
  if (counts["not_started"]) {
    summaryParts.push(`${counts["not_started"]} not started`);
  }
  if (summaryParts.length === 0) {
    summaryParts.push(`${strategies.length} total`);
  }

  const text = `My Strategies  ·  ${summaryParts.join("  ·  ")}\nTap a strategy to view details and controls.`;

  if (channel === "telegram") {
    return { text, channelData: telegramChannelData(buildOverviewButtons(sorted), editMessageId) };
  }

  return { text: `${text}\n\n${sorted.map(formatStrategy).join("\n\n")}` };
}

async function buildSelectReply(
  stem: string,
  channel: string,
  editMessageId?: string,
): Promise<ReplyPayload> {
  const { processes } = await fetchProcesses();
  const strategy: Strategy = { stem, process: resolveProcess(processes, stem) };
  const text = formatStrategy(strategy);

  if (channel === "telegram") {
    return { text, channelData: telegramChannelData(buildDetailButtons(strategy), editMessageId) };
  }
  return { text };
}

async function buildLogsReply(
  name: string,
  maxLines: number,
  editMessageId?: string,
): Promise<ReplyPayload> {
  const { processes, error } = await fetchProcesses();
  if (error) {
    return { text: error };
  }

  const proc = resolveProcess(processes, name);
  if (!proc) {
    return { text: `Strategy "${name}" has no logs — not started.` };
  }

  const outPath = proc.pm2_env.pm_out_log_path;
  const errPath = proc.pm2_env.pm_err_log_path;

  // Fetch stdout and stderr concurrently
  const [outLines, errLines] = await Promise.all([
    tailFile(outPath, maxLines),
    tailFile(errPath, STDERR_PEEK_LINES),
  ]);

  const parts: string[] = [`📋 ${name}  (last ${maxLines} lines)`, ""];

  if (outLines.length === 0) {
    parts.push("(no output logged yet)");
  } else {
    parts.push(...outLines);
  }

  if (errLines.length > 0) {
    parts.push("", `⚠️ Recent errors (${errLines.length} lines)`, ...errLines);
  }

  // Trim from the top if the combined output is too long for a single message
  let text = parts.join("\n");
  if (text.length > MAX_LOG_CHARS) {
    const header = parts[0];
    const trimmed = text.slice(text.length - MAX_LOG_CHARS);
    // Keep from the next newline to avoid a partial first line
    const cutIndex = trimmed.indexOf("\n");
    text = `${header}\n…\n${cutIndex >= 0 ? trimmed.slice(cutIndex + 1) : trimmed}`;
  }

  if (editMessageId) {
    return { text, channelData: telegramChannelData(undefined, editMessageId) };
  }
  return { text };
}

async function controlStrategy(
  action: "start" | "stop" | "restart",
  stem: string,
  channel: string,
  editMessageId?: string,
): Promise<ReplyPayload> {
  const { processes } = await fetchProcesses();
  const proc = resolveProcess(processes, stem);

  // First-time start: pm2 doesn't know this strategy yet
  if (!proc && action === "start") {
    const filePath = join(STRATEGIES_DIR, `${stem}.js`);
    const pm2Name = stemToPm2Name(stem);
    try {
      await execFileAsync("pm2", ["start", filePath, "--name", pm2Name, "--interpreter", "node"], {
        timeout: 10000,
      });
    } catch (err) {
      const error = err as NodeJS.ErrnoException;
      if (error.code === "ENOENT") {
        return { text: "PM2 is not installed or not in PATH." };
      }
      return { text: `Failed to start "${stem}": ${error.message}` };
    }
    return buildSelectReply(stem, channel, editMessageId);
  }

  if (!proc) {
    return { text: `Strategy "${stem}" is not started — cannot ${action}.` };
  }

  try {
    await execFileAsync("pm2", [action, proc.name], { timeout: 10000 });
  } catch (err) {
    const error = err as NodeJS.ErrnoException;
    if (error.code === "ENOENT") {
      return { text: "PM2 is not installed or not in PATH." };
    }
    return { text: `Failed to ${action} "${stem}": ${error.message}` };
  }

  return buildSelectReply(stem, channel, editMessageId);
}

export const handleMyStrategiesCommand: CommandHandler = async (params, allowTextCommands) => {
  if (!allowTextCommands) {
    return null;
  }

  const body = params.command.commandBodyNormalized;

  // Handle user-facing /mystrategies and the short /ms callback prefix
  let rest: string;
  if (body.startsWith("/mystrategies")) {
    rest = body.slice("/mystrategies".length).trim();
  } else if (body.startsWith("/ms ") || body === "/ms") {
    rest = body.slice("/ms".length).trim();
  } else {
    return null;
  }

  const unauthorized = rejectUnauthorizedCommand(params, "/mystrategies");
  if (unauthorized) {
    return unauthorized;
  }

  const channel = params.command.channel;
  // Set when command came from a button click — delivery layer will edit the original message
  // in place rather than sending a new one.
  let editMessageId = params.ctx.TelegramEditMessageId;

  // Send interim ⏳ on fresh invocations (not button-click refreshes).
  if (!editMessageId) {
    const originChannel = params.ctx.OriginatingChannel;
    const originTo = params.ctx.OriginatingTo ?? params.command.from ?? params.command.to;
    if (originChannel && originTo && isRoutableChannel(originChannel)) {
      const interim = await routeReply({
        payload: { text: "⏳" },
        channel: originChannel,
        to: originTo,
        sessionKey: params.sessionKey,
        accountId: params.ctx.AccountId,
        threadId: params.ctx.MessageThreadId,
        cfg: params.cfg,
        mirror: false,
      });
      if (channel === "telegram" && interim.messageId) {
        editMessageId = interim.messageId;
      }
    }
  }

  // select <name> — show detail view for one strategy
  const selectMatch = rest.match(/^select\s+(\S.*)$/);
  if (selectMatch) {
    return {
      shouldContinue: false,
      reply: await buildSelectReply(selectMatch[1].trim(), channel, editMessageId),
    };
  }

  // logs <name> [lines]
  const logsMatch = rest.match(/^logs\s+(\S+)(?:\s+(\d+))?$/);
  if (logsMatch) {
    const name = logsMatch[1];
    const lines = logsMatch[2]
      ? Math.min(MAX_LOG_LINES, Math.max(1, Number.parseInt(logsMatch[2], 10)))
      : DEFAULT_LOG_LINES;
    return { shouldContinue: false, reply: await buildLogsReply(name, lines, editMessageId) };
  }

  // start|stop|restart <name>
  const controlMatch = rest.match(/^(start|stop|restart)\s+(\S+)$/);
  if (controlMatch) {
    const action = controlMatch[1] as "start" | "stop" | "restart";
    const name = controlMatch[2];
    return {
      shouldContinue: false,
      reply: await controlStrategy(action, name, channel, editMessageId),
    };
  }

  // work <name> — inject strategy filepath as hidden context into the agent's turn
  const workMatch = rest.match(/^work\s+(\S+)$/);
  if (workMatch) {
    const stem = workMatch[1].trim();
    const filePath = join(STRATEGIES_DIR, `${stem}.js`);
    return {
      shouldContinue: true,
      agentMessageOverride: `Please work on my "${stem}" strategy. The strategy file is at: ${filePath}`,
    };
  }

  // /mystrategies — list all
  if (!rest) {
    const { strategies, error } = await fetchStrategies();
    if (error && strategies.length === 0) {
      return { shouldContinue: false, reply: { text: error } };
    }
    const reply = buildListReply(strategies, channel, editMessageId);
    // Append PM2 warning so the user knows status may be stale
    if (error) {
      reply.text = `${reply.text}\n\n⚠️ ${error}`;
    }
    return { shouldContinue: false, reply };
  }

  return {
    shouldContinue: false,
    reply: {
      text: "Usage: /mystrategies  ·  /mystrategies logs <name> [lines]  ·  /mystrategies start|stop|restart <name>",
    },
  };
};
