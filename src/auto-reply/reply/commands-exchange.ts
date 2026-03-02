import { execFile } from "node:child_process";
import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { TelegramInlineButtons } from "../../telegram/button-types.js";
import type { ReplyPayload } from "../types.js";
import { rejectUnauthorizedCommand } from "./command-gates.js";
import type { CommandHandler } from "./commands-types.js";
import { isRoutableChannel, routeReply } from "./route-reply.js";

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

type Order = {
  orderId: string;
  market: string;
  side: "buy" | "sell";
  price: number;
  size: number;
  filled: number;
  timestamp: number;
};

type StateResult =
  | { id: ExchangeId; label: string; configured: false }
  | { id: ExchangeId; label: string; configured: true; error: string }
  | { id: ExchangeId; label: string; configured: true; balances: Record<string, number>; positions: Position[] };

type OrderResult =
  | { id: ExchangeId; label: string; configured: false }
  | { id: ExchangeId; label: string; configured: true; error: string }
  | { id: ExchangeId; label: string; configured: true; orders: Order[] };

// Runs as an ESM temp script (.mjs) so it can import portara-agent's ESM libs.
// cwd must be v3Dir so Extended SDK WASM resolves correctly.
function buildRunnerScript(v3Dir: string, mode: "state" | "orders"): string {
  const tiPath = JSON.stringify(`${v3Dir}/libs/trading-interface.js`);
  const cfgPath = JSON.stringify(`${v3Dir}/libs/config.js`);
  const fetchBody =
    mode === "state"
      ? `    const state = await ti.getExchangeState(id);
    return { id, label, configured: true, balances: state.balances, positions: state.positions };`
      : `    const orders = await ti.getOpenOrders(id);
    return { id, label, configured: true, orders };`;
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
${fetchBody}
  } catch (err) {
    return { id, label, configured: true, error: err.message };
  }
}));

try { ti.disconnectAll(); } catch {}
process.stdout.write(JSON.stringify(results));
`;
}

async function fetchData<T>(
  v3Dir: string,
  mode: "state" | "orders",
): Promise<{ results: T[]; error?: string }> {
  try {
    await access(v3Dir);
  } catch {
    return { results: [], error: "portara-agent not found in workspace. Ensure it is cloned to workspace/portara-agent." };
  }

  const tmpDir = await mkdtemp(path.join(tmpdir(), "portara-ex-"));
  const scriptPath = path.join(tmpDir, "runner.mjs");
  try {
    await writeFile(scriptPath, buildRunnerScript(v3Dir, mode), "utf8");
    const { stdout } = await execFileAsync("node", [scriptPath], {
      timeout: 20000,
      cwd: v3Dir,
    });
    return { results: JSON.parse(stdout) as T[] };
  } catch (err) {
    const error = err as NodeJS.ErrnoException & { killed?: boolean; stderr?: string };
    if (error.code === "ENOENT") return { results: [], error: "Node.js is not installed or not in PATH." };
    if (error.killed) return { results: [], error: "Exchange query timed out after 20s." };
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
  return amount.toPrecision(4).replace(/\.?0+$/, "");
}

// For USD monetary values — always 2 decimal places, no more.
function formatUsd(amount: number): string {
  return amount.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function formatPrice(price: number): string {
  if (price >= 1000) return price.toLocaleString("en-US", { maximumFractionDigits: 2 });
  return price.toFixed(4).replace(/\.?0+$/, "");
}

function formatPnl(pnl: number): string {
  const sign = pnl >= 0 ? "+" : "-";
  return `${sign}$${Math.abs(pnl).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function buildBalancesText(results: StateResult[]): string {
  const lines: string[] = ["**My Balances**", ""];

  // trade.xyz is built on Hyperliquid and shares the same margin account.
  // Combine their USD balances under "Hyperliquid / trade.xyz" and skip xyz separately.
  const hlIdx = results.findIndex((r) => r.id === "hyperliquid");
  const xyzIdx = results.findIndex((r) => r.id === "xyz");
  const merged: Record<number, true> = {};
  let combined: StateResult[] = results.map((r) => ({ ...r }));
  if (hlIdx !== -1 && xyzIdx !== -1) {
    const hl = combined[hlIdx];
    const xyz = combined[xyzIdx];
    if (hl.configured && !("error" in hl) && xyz.configured && !("error" in xyz)) {
      combined[hlIdx] = {
        ...hl,
        label: "Hyperliquid / trade.xyz",
        balances: { ...hl.balances, USD: (hl.balances.USD ?? 0) + (xyz.balances.USD ?? 0) },
      };
      merged[xyzIdx] = true;
    }
  }
  combined = combined.filter((_, i) => !merged[i]);

  for (const r of combined) {
    if (!r.configured) { lines.push(`${r.label}  ·  not configured`); continue; }
    if ("error" in r) { lines.push(`${r.label}  ·  error: ${r.error}`); continue; }
    // USDT0 is Hyperliquid's on-chain USDT used as Dreamcash margin — always 1:1 with USDC, skip it.
    const nonZero = Object.entries(r.balances).filter(([k, v]) => v !== 0 && !(r.id === "cash" && k === "USDT0"));
    if (nonZero.length === 0) {
      lines.push(`${r.label}  ·  no balances`);
    } else {
      lines.push(`**${r.label}**`);
      lines.push("```");
      for (const [asset, amount] of nonZero) {
        lines.push(`${asset.padEnd(10)}${formatAmount(amount)}`);
      }
      lines.push("```");
    }
    lines.push("");
  }
  return lines.join("\n").trimEnd();
}

function buildPositionsText(results: StateResult[]): string {
  const lines: string[] = ["**My Positions**", ""];
  for (const r of results) {
    if (!r.configured) { lines.push(`${r.label}  ·  not configured`); continue; }
    if ("error" in r) { lines.push(`${r.label}  ·  error: ${r.error}`); continue; }
    const open = r.positions.filter((p) => p.size > 0);
    if (open.length === 0) { lines.push(`${r.label}  ·  no open positions`); continue; }
    lines.push(`**${r.label}**`);
    for (let i = 0; i < open.length; i++) {
      const p = open[i];
      // add blank line between positions for readability
      if (i > 0) lines.push("");
      const side = p.side === "long" ? "long " : "short";
      const notional = formatUsd(p.size * p.markPrice);
      const margin = formatUsd((p.size * p.markPrice) / p.leverage);
      const pnlEmoji = p.unrealizedPnl >= 0 ? "🟢" : "🔴";
      lines.push(`  ${side}  ${p.market}  ${formatAmount(p.size)} ($${notional})  ${p.leverage}×  ${pnlEmoji} ${formatPnl(p.unrealizedPnl)}`);
      const details = [`entry $${formatPrice(p.entryPrice)}`, `mark $${formatPrice(p.markPrice)}`, `margin $${margin}`];
      if (p.liquidationPrice > 0) details.push(`liq $${formatPrice(p.liquidationPrice)}`);
      lines.push(`    ${details.join("  ·  ")}`);
    }
    lines.push("");
  }
  return lines.join("\n").trimEnd();
}

function buildOrdersText(results: OrderResult[]): string {
  const lines: string[] = ["**My Open Orders**", ""];
  for (const r of results) {
    if (!r.configured) { lines.push(`${r.label}  ·  not configured`); continue; }
    if ("error" in r) { lines.push(`${r.label}  ·  error: ${r.error}`); continue; }
    if (r.orders.length === 0) { lines.push(`${r.label}  ·  no open orders`); continue; }
    lines.push(`**${r.label}**`);
    for (let i = 0; i < r.orders.length; i++) {
      if (i > 0) lines.push("");
      const o = r.orders[i];
      const side = o.side === "buy" ? "BUY " : "SELL";
      const qty = o.filled > 0 ? `${formatAmount(o.filled)}/${formatAmount(o.size)} filled` : formatAmount(o.size);
      lines.push(`  ${side}  ${o.market}  ${qty}  @ $${formatPrice(o.price)}  ≈ $${formatUsd(o.size * o.price)}`);
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
  const isOrders = body === "/myorders" || body.startsWith("/myorders ");
  if (!isBalances && !isPositions && !isOrders) return null;

  const label = isBalances ? "/mybalances" : isPositions ? "/mypositions" : "/myorders";
  const unauthorized = rejectUnauthorizedCommand(params, label);
  if (unauthorized) return unauthorized;

  const channel = params.command.channel;
  const v3Dir = path.join(params.workspaceDir, "portara-agent", "v3");

  // Send interim "thinking" message on fresh invocations (not refreshes).
  // For Telegram, capture the messageId so we can edit it in-place with the result.
  let editMessageId = params.ctx.TelegramEditMessageId;
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

  if (isOrders) {
    const { results, error } = await fetchData<OrderResult>(v3Dir, "orders");
    if (error) return { shouldContinue: false, reply: { text: error } };
    return { shouldContinue: false, reply: buildReply(buildOrdersText(results), label, channel, editMessageId) };
  }

  const { results, error } = await fetchData<StateResult>(v3Dir, "state");
  if (error) return { shouldContinue: false, reply: { text: error } };
  const text = isBalances ? buildBalancesText(results) : buildPositionsText(results);
  return { shouldContinue: false, reply: buildReply(text, label, channel, editMessageId) };
};
