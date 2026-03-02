import { execFile } from "node:child_process";
import { open } from "node:fs/promises";
import { promisify } from "node:util";
import type { TelegramInlineButton, TelegramInlineButtons } from "../../telegram/button-types.js";
import type { ReplyPayload } from "../types.js";
import { rejectUnauthorizedCommand } from "./command-gates.js";
import type { CommandHandler } from "./commands-types.js";

const execFileAsync = promisify(execFile);

// Max lines a user can request; keeps responses within messaging platform limits
const MAX_LOG_LINES = 50;
const DEFAULT_LOG_LINES = 20;
// Error lines always shown if present (separate section)
const STDERR_PEEK_LINES = 10;
// Safety cap: if log output exceeds this, trim from the top (keep newest)
const MAX_LOG_CHARS = 3500;

type Pm2Process = {
  name: string;
  pm2_env: {
    status: string;
    pm_uptime: number;
    restart_time: number;
    pm_out_log_path: string;
    pm_err_log_path: string;
  };
  monit: {
    memory: number;
    cpu: number;
  };
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
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60) % 60;
  const h = Math.floor(s / 3600) % 24;
  const d = Math.floor(s / 86400);
  if (d > 0) return h > 0 ? `${d}d ${h}h` : `${d}d`;
  if (h > 0) return m > 0 ? `${h}h ${m}m` : `${h}h`;
  return `${m}m`;
}

function formatMemory(bytes: number): string {
  const mb = bytes / (1024 * 1024);
  if (mb < 1) return `${Math.round(bytes / 1024)} KB`;
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
    if (proc.pm2_env.restart_time > 0) stats.push(`↺ ${proc.pm2_env.restart_time}`);
    return `${emoji} ${proc.name}\n   ${stats.join("  ·  ")}`;
  }

  const statusLine =
    proc.pm2_env.restart_time > 0
      ? `${proc.pm2_env.status}  ·  ↺ ${proc.pm2_env.restart_time}`
      : proc.pm2_env.status;
  return `${emoji} ${proc.name}\n   ${statusLine}`;
}

// Short /ms prefix keeps callback_data within Telegram's 64-byte limit.
// e.g. "/ms select strategy:hyperliquid:btc_market_maker_hyperliquid" = 61 bytes ✓
const CB_PREFIX = "/ms";

function callbackData(action: string, name: string): string {
  const raw = `${CB_PREFIX} ${action} ${name}`;
  return Buffer.byteLength(raw, "utf8") <= 64 ? raw : raw.slice(0, 63);
}

// Overview: one button per strategy, status emoji tells you running/stopped at a glance.
function buildOverviewButtons(processes: Pm2Process[]): TelegramInlineButtons {
  return processes.map((proc) => {
    const emoji = statusEmoji(proc.pm2_env.status);
    const label = proc.name.length > 28 ? `${proc.name.slice(0, 27)}…` : proc.name;
    return [{ text: `${emoji}  ${label}`, callback_data: callbackData("select", proc.name) }];
  });
}

// Detail: action row (stop/start/restart/logs) + back button on its own row.
function buildDetailButtons(proc: Pm2Process): TelegramInlineButtons {
  const { status } = proc.pm2_env;
  const logsBtn: TelegramInlineButton = { text: "📋  Logs", callback_data: callbackData("logs", proc.name) };
  const backBtn: TelegramInlineButton = { text: "‹  All strategies", callback_data: "/mystrategies" };

  let actionRow: TelegramInlineButton[];
  if (status === "online") {
    actionRow = [
      { text: "⏹  Stop", callback_data: callbackData("stop", proc.name) },
      { text: "↺  Restart", callback_data: callbackData("restart", proc.name) },
      logsBtn,
    ];
  } else if (status === "stopped" || status === "errored") {
    actionRow = [
      { text: "▶  Start", callback_data: callbackData("start", proc.name) },
      { text: "↺  Restart", callback_data: callbackData("restart", proc.name) },
      logsBtn,
    ];
  } else {
    // Transitioning: only safe actions
    actionRow = [{ text: "⏹  Stop", callback_data: callbackData("stop", proc.name) }, logsBtn];
  }

  return [actionRow, [backBtn]];
}

async function fetchProcesses(): Promise<{ processes: Pm2Process[]; error?: string }> {
  let stdout: string;
  try {
    ({ stdout } = await execFileAsync("pm2", ["jlist"], { timeout: 8000 }));
  } catch (err) {
    const error = err as NodeJS.ErrnoException & { killed?: boolean };
    if (error.code === "ENOENT") return { processes: [], error: "PM2 is not installed or not in PATH." };
    if (error.killed) return { processes: [], error: "PM2 query timed out. Is the PM2 daemon running?" };
    return { processes: [], error: `PM2 error: ${error.message}` };
  }

  try {
    const parsed = JSON.parse(stdout) as Pm2Process[];
    if (!Array.isArray(parsed)) return { processes: [], error: "Unexpected PM2 output format." };
    return { processes: parsed };
  } catch {
    return { processes: [], error: "Failed to parse PM2 output." };
  }
}

// Reads the last `maxLines` non-empty lines from a file efficiently.
// Seeks near the end so it stays fast even on large log files.
async function tailFile(filePath: string, maxLines: number): Promise<string[]> {
  let file;
  try {
    file = await open(filePath, "r");
    const { size } = await file.stat();
    if (size === 0) return [];
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

function buildListReply(processes: Pm2Process[], channel: string): ReplyPayload {
  if (processes.length === 0) {
    return { text: "No strategies found." };
  }

  const sorted = [...processes].sort(
    (a, b) => (STATUS_ORDER[a.pm2_env.status] ?? 9) - (STATUS_ORDER[b.pm2_env.status] ?? 9),
  );

  const counts = processes.reduce<Record<string, number>>((acc, p) => {
    acc[p.pm2_env.status] = (acc[p.pm2_env.status] ?? 0) + 1;
    return acc;
  }, {});

  const summaryParts: string[] = [];
  if (counts["online"]) summaryParts.push(`${counts["online"]} running`);
  if (counts["stopped"]) summaryParts.push(`${counts["stopped"]} stopped`);
  if (counts["errored"]) summaryParts.push(`${counts["errored"]} errored`);
  if ((counts["launching"] ?? 0) + (counts["stopping"] ?? 0) > 0) {
    summaryParts.push(`${(counts["launching"] ?? 0) + (counts["stopping"] ?? 0)} transitioning`);
  }
  if (summaryParts.length === 0) summaryParts.push(`${processes.length} total`);

  const text = `My Strategies  ·  ${summaryParts.join("  ·  ")}\nTap a strategy to view details and controls.`;

  if (channel === "telegram") {
    return { text, channelData: { telegram: { buttons: buildOverviewButtons(sorted) } } };
  }

  // Non-Telegram: show the full text list instead
  return { text: `${text}\n\n${sorted.map(formatProcess).join("\n\n")}` };
}

async function buildSelectReply(name: string, channel: string): Promise<ReplyPayload> {
  const { processes, error } = await fetchProcesses();
  if (error) return { text: error };

  const proc = processes.find((p) => p.name === name);
  if (!proc) return { text: `Strategy "${name}" not found.` };

  const text = formatProcess(proc);

  if (channel === "telegram") {
    return { text, channelData: { telegram: { buttons: buildDetailButtons(proc) } } };
  }
  return { text };
}

async function buildLogsReply(name: string, maxLines: number): Promise<ReplyPayload> {
  const { processes, error } = await fetchProcesses();
  if (error) return { text: error };

  const proc = processes.find((p) => p.name === name);
  if (!proc) return { text: `Strategy "${name}" not found.` };

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

  return { text };
}

async function controlStrategy(
  action: "start" | "stop" | "restart",
  name: string,
  channel: string,
): Promise<ReplyPayload> {
  try {
    await execFileAsync("pm2", [action, name], { timeout: 10000 });
  } catch (err) {
    const error = err as NodeJS.ErrnoException;
    if (error.code === "ENOENT") return { text: "PM2 is not installed or not in PATH." };
    return { text: `Failed to ${action} "${name}": ${error.message}` };
  }

  // Return the updated detail view so the user sees the result immediately with fresh buttons
  return buildSelectReply(name, channel);
}

export const handleMyStrategiesCommand: CommandHandler = async (params, allowTextCommands) => {
  if (!allowTextCommands) return null;

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
  if (unauthorized) return unauthorized;

  const channel = params.command.channel;

  // select <name> — show detail view for one strategy
  const selectMatch = rest.match(/^select\s+(\S.*)$/);
  if (selectMatch) {
    return { shouldContinue: false, reply: await buildSelectReply(selectMatch[1].trim(), channel) };
  }

  // logs <name> [lines]
  const logsMatch = rest.match(/^logs\s+(\S+)(?:\s+(\d+))?$/);
  if (logsMatch) {
    const name = logsMatch[1];
    const lines = logsMatch[2]
      ? Math.min(MAX_LOG_LINES, Math.max(1, Number.parseInt(logsMatch[2], 10)))
      : DEFAULT_LOG_LINES;
    return { shouldContinue: false, reply: await buildLogsReply(name, lines) };
  }

  // start|stop|restart <name>
  const controlMatch = rest.match(/^(start|stop|restart)\s+(\S+)$/);
  if (controlMatch) {
    const action = controlMatch[1] as "start" | "stop" | "restart";
    const name = controlMatch[2];
    return { shouldContinue: false, reply: await controlStrategy(action, name, channel) };
  }

  // /mystrategies — list all
  if (!rest) {
    const { processes, error } = await fetchProcesses();
    if (error) return { shouldContinue: false, reply: { text: error } };
    return { shouldContinue: false, reply: buildListReply(processes, channel) };
  }

  return {
    shouldContinue: false,
    reply: { text: "Usage: /mystrategies  ·  /mystrategies logs <name> [lines]  ·  /mystrategies start|stop|restart <name>" },
  };
};
