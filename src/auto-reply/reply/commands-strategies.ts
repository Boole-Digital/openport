import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { TelegramInlineButtons } from "../../telegram/button-types.js";
import type { ReplyPayload } from "../types.js";
import { rejectUnauthorizedCommand } from "./command-gates.js";
import type { CommandHandler } from "./commands-types.js";

const execFileAsync = promisify(execFile);

type Pm2Process = {
  name: string;
  pm2_env: {
    status: string;
    pm_uptime: number;
    restart_time: number;
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
  const fields: string[] = [];

  if (proc.pm2_env.status === "online") {
    fields.push(
      formatUptime(proc.pm2_env.pm_uptime),
      `${proc.monit.cpu.toFixed(1)}%`,
      formatMemory(proc.monit.memory),
    );
  } else {
    fields.push(proc.pm2_env.status);
  }

  if (proc.pm2_env.restart_time > 0) {
    fields.push(`↺ ${proc.pm2_env.restart_time}`);
  }

  return `${emoji} ${proc.name}    ${fields.join("    ")}`;
}

// Telegram callback_data limit: 64 bytes
function callbackData(action: string, name: string): string {
  const raw = `/strategies ${action} ${name}`;
  return Buffer.byteLength(raw, "utf8") <= 64 ? raw : raw.slice(0, 63);
}

// Truncate name for button label (keeping it readable)
function shortName(name: string): string {
  return name.length > 14 ? `${name.slice(0, 13)}…` : name;
}

function buildStrategyButtons(processes: Pm2Process[]): TelegramInlineButtons {
  return processes.map((proc) => {
    const { status } = proc.pm2_env;
    const n = shortName(proc.name);

    if (status === "online") {
      return [
        { text: `⏹ Stop ${n}`, callback_data: callbackData("stop", proc.name) },
        { text: `↺ Restart ${n}`, callback_data: callbackData("restart", proc.name) },
      ];
    }
    if (status === "stopped" || status === "errored") {
      return [
        { text: `▶ Start ${n}`, callback_data: callbackData("start", proc.name) },
        { text: `↺ Restart ${n}`, callback_data: callbackData("restart", proc.name) },
      ];
    }
    // Transitioning
    return [{ text: `⏹ Stop ${n}`, callback_data: callbackData("stop", proc.name) }];
  });
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

function buildListReply(processes: Pm2Process[], channel: string): ReplyPayload {
  if (processes.length === 0) {
    return { text: "No strategies running." };
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

  const n = processes.length;
  const header = `Strategies — ${summaryParts.join(" · ")}  (${n} total)`;
  const text = [header, "", ...sorted.map(formatProcess)].join("\n");

  // Telegram gets a button grid — one row per strategy with context-appropriate actions.
  // Buttons use callback_data = the command text (e.g. "/strategies stop scalper-btc"),
  // which the Telegram handler routes as a synthetic message through the normal command pipeline.
  if (channel === "telegram") {
    const buttons = buildStrategyButtons(sorted);
    return { text, channelData: { telegram: { buttons } } };
  }

  return { text };
}

async function controlStrategy(action: "start" | "stop" | "restart", name: string): Promise<ReplyPayload> {
  try {
    await execFileAsync("pm2", [action, name], { timeout: 10000 });
  } catch (err) {
    const error = err as NodeJS.ErrnoException;
    if (error.code === "ENOENT") return { text: "PM2 is not installed or not in PATH." };
    return { text: `Failed to ${action} "${name}": ${error.message}` };
  }

  // Return the updated status line for the affected strategy
  const { processes } = await fetchProcesses();
  const proc = processes.find((p) => p.name === name);
  const actionLabel = action === "start" ? "Started" : action === "stop" ? "Stopped" : "Restarted";
  return { text: proc ? `${actionLabel} — ${formatProcess(proc)}` : `${actionLabel} "${name}".` };
}

export const handleStrategiesCommand: CommandHandler = async (params, allowTextCommands) => {
  if (!allowTextCommands) return null;

  const body = params.command.commandBodyNormalized;
  if (!body.startsWith("/strategies")) return null;

  const unauthorized = rejectUnauthorizedCommand(params, "/strategies");
  if (unauthorized) return unauthorized;

  const rest = body.slice("/strategies".length).trim();

  // /strategies start|stop|restart <name>
  const controlMatch = rest.match(/^(start|stop|restart)\s+(\S+)$/);
  if (controlMatch) {
    const action = controlMatch[1] as "start" | "stop" | "restart";
    const name = controlMatch[2];
    return { shouldContinue: false, reply: await controlStrategy(action, name) };
  }

  // /strategies — list all
  if (!rest) {
    const { processes, error } = await fetchProcesses();
    if (error) return { shouldContinue: false, reply: { text: error } };
    return { shouldContinue: false, reply: buildListReply(processes, params.command.channel) };
  }

  return {
    shouldContinue: false,
    reply: { text: "Usage: /strategies  or  /strategies start|stop|restart <name>" },
  };
};
