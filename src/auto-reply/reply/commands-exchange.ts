import { execFile } from "node:child_process";
import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { TelegramInlineButtons } from "../../telegram/button-types.js";
import type { ReplyPayload } from "../types.js";
import { rejectUnauthorizedCommand } from "./command-gates.js";
import type { CommandHandler } from "./commands-types.js";

const execFileAsync = promisify(execFile);

const EXCHANGES = [
  { id: "hyperliquid", label: "Hyperliquid" },
  { id: "extended", label: "Extended" },
  { id: "xyz", label: "trade.xyz" },
  { id: "cash", label: "Dreamcash" },
] as const;

type ExchangeId = (typeof EXCHANGES)[number]["id"];

type Position = {
  market: string;
  side: "long" | "short";
  size: number;
  entryPrice: number;
  markPrice: number;
  unrealizedPnl: number;
  leverage: number;
  liquidationPrice: number;
};

type ExchangeResult =
  | { id: ExchangeId; label: string; configured: false }
  | { id: ExchangeId; label: string; configured: true; error: string }
  | { id: ExchangeId; label: string; configured: true; balances: Record<string, number>; positions: Position[] };

// Runs as an ESM temp script (.mjs) so it can import portara-agent's ESM libs.
// cwd must be v3Dir so Extended SDK WASM resolves correctly.
function buildRunnerScript(v3Dir: string): string {
  const tiPath = JSON.stringify(`${v3Dir}/libs/trading-interface.js`);
  const cfgPath = JSON.stringify(`${v3Dir}/libs/config.js`);
  return `
import { TradingInterface } from ${tiPath};
import { loadConfig } from ${cfgPath};

const config = loadConfig();
const ti = new TradingInterface();

const EXCHANGES = [
  { id: 'hyperliquid', label: 'Hyperliquid' },
  { id: 'extended', label: 'Extended' },
  { id: 'xyz', label: 'trade.xyz' },
  { id: 'cash', label: 'Dreamcash' },
];

const results = await Promise.all(EXCHANGES.map(async ({ id, label }) => {
  if (!config[id]?.privateKey) {
    return { id, label, configured: false };
  }
  try {
    await ti.connectExchange(id, config[id]);
    const state = await ti.getExchangeState(id);
    return { id, label, configured: true, balances: state.balances, positions: state.positions };
  } catch (err) {
    return { id, label, configured: true, error: err.message };
  }
}));

try { ti.disconnectAll(); } catch {}
process.stdout.write(JSON.stringify(results));
`;
}

async function fetchExchangeData(
  v3Dir: string,
): Promise<{ results: ExchangeResult[]; error?: string }> {
  // Verify portara-agent is installed before spinning up a node process
  try {
    await access(v3Dir);
  } catch {
    return { results: [], error: "portara-agent not found in workspace. Ensure it is cloned to workspace/portara-agent." };
  }

  const tmpDir = await mkdtemp(path.join(tmpdir(), "portara-ex-"));
  const scriptPath = path.join(tmpDir, "runner.mjs");
  try {
    await writeFile(scriptPath, buildRunnerScript(v3Dir), "utf8");
    const { stdout } = await execFileAsync("node", [scriptPath], {
      timeout: 20000,
      cwd: v3Dir,
    });
    return { results: JSON.parse(stdout) as ExchangeResult[] };
  } catch (err) {
    const error = err as NodeJS.ErrnoException & { killed?: boolean; stderr?: string };
    if (error.code === "ENOENT") return { results: [], error: "Node.js is not installed or not in PATH." };
    if (error.killed) return { results: [], error: "Exchange query timed out after 20s." };
    // Surface the first meaningful error line from stderr
    const detail = error.stderr?.split("\n").find((l) => l.trim() && !l.startsWith(" ")) ?? error.message;
    return { results: [], error: `Exchange query failed: ${detail}` };
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
}

// --- Formatting ---

function formatAmount(amount: number): string {
  if (amount >= 1000) return amount.toLocaleString("en-US", { maximumFractionDigits: 2 });
  if (amount >= 1) return amount.toFixed(4).replace(/\.?0+$/, "");
  return amount.toPrecision(4);
}

function formatPrice(price: number): string {
  if (price >= 1000) return price.toLocaleString("en-US", { maximumFractionDigits: 2 });
  return price.toFixed(4).replace(/\.?0+$/, "");
}

function formatPnl(pnl: number): string {
  const sign = pnl >= 0 ? "+" : "";
  return `${sign}$${Math.abs(pnl).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function buildBalancesText(results: ExchangeResult[]): string {
  const lines: string[] = ["My Balances", ""];

  for (const r of results) {
    if (!r.configured) {
      lines.push(`${r.label}  ·  not configured`);
      continue;
    }
    if ("error" in r) {
      lines.push(`${r.label}  ·  error: ${r.error}`);
      continue;
    }
    const nonZero = Object.entries(r.balances).filter(([, v]) => v !== 0);
    if (nonZero.length === 0) {
      lines.push(`${r.label}  ·  no balances`);
    } else {
      lines.push(r.label);
      for (const [asset, amount] of nonZero) {
        lines.push(`  ${asset.padEnd(8)}  ${formatAmount(amount)}`);
      }
    }
    lines.push("");
  }

  return lines.join("\n").trimEnd();
}

function buildPositionsText(results: ExchangeResult[]): string {
  const lines: string[] = ["My Positions", ""];

  for (const r of results) {
    if (!r.configured) {
      lines.push(`${r.label}  ·  not configured`);
      continue;
    }
    if ("error" in r) {
      lines.push(`${r.label}  ·  error: ${r.error}`);
      continue;
    }
    const open = r.positions.filter((p) => p.size > 0);
    if (open.length === 0) {
      lines.push(`${r.label}  ·  no open positions`);
      continue;
    }
    lines.push(r.label);
    for (const p of open) {
      const dir = p.side === "long" ? "▲" : "▼";
      const pnl = formatPnl(p.unrealizedPnl);
      lines.push(`  ${dir} ${p.market}  ${formatAmount(p.size)} @ ${formatPrice(p.entryPrice)}  ${pnl}  ${p.leverage}×`);
    }
    lines.push("");
  }

  return lines.join("\n").trimEnd();
}

// --- Reply helpers ---

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

function buildReply(
  text: string,
  command: string,
  channel: string,
  editMessageId?: string,
): ReplyPayload {
  if (channel === "telegram") {
    const buttons: TelegramInlineButtons = [[{ text: "⟳  Refresh", callback_data: command }]];
    return { text, channelData: telegramChannelData(buttons, editMessageId) };
  }
  return { text };
}

// --- Main handler ---

export const handleExchangeCommand: CommandHandler = async (params, allowTextCommands) => {
  if (!allowTextCommands) return null;

  const body = params.command.commandBodyNormalized;
  const isBalances = body === "/mybalances" || body.startsWith("/mybalances ");
  const isPositions = body === "/mypositions" || body.startsWith("/mypositions ");
  if (!isBalances && !isPositions) return null;

  const label = isBalances ? "/mybalances" : "/mypositions";
  const unauthorized = rejectUnauthorizedCommand(params, label);
  if (unauthorized) return unauthorized;

  const channel = params.command.channel;
  const editMessageId = params.ctx.TelegramEditMessageId;
  const v3Dir = path.join(params.workspaceDir, "portara-agent", "v3");

  const { results, error } = await fetchExchangeData(v3Dir);
  if (error) return { shouldContinue: false, reply: { text: error } };

  const text = isBalances ? buildBalancesText(results) : buildPositionsText(results);
  return { shouldContinue: false, reply: buildReply(text, label, channel, editMessageId) };
};
