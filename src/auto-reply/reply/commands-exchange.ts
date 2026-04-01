import { execFile } from "node:child_process";
import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { TelegramInlineButtons } from "@openclaw/telegram/api.js";
import type { ReplyPayload } from "../types.js";
import { rejectUnauthorizedCommand } from "./command-gates.js";
import type { CommandHandler } from "./commands-types.js";
import { isRoutableChannel, routeReply } from "./route-reply.js";

const execFileAsync = promisify(execFile);

const PERP_EXCHANGES = [
  { id: "hyperliquid", label: "Hyperliquid" },
  { id: "extended", label: "Extended" },
  { id: "xyz", label: "trade\u200b.xyz" },
  { id: "cash", label: "Dreamcash" },
] as const;

const PREDICTION_EXCHANGES = [{ id: "polymarket", label: "Polymarket" }] as const;

const ALL_EXCHANGES = [...PERP_EXCHANGES, ...PREDICTION_EXCHANGES];

type ExchangeEntry = { id: string; label: string };

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

type PredictionPosition = {
  marketId: string;
  outcomeIndex: number;
  outcomeName: string;
  shares: number;
  avgPrice: number;
  currentPrice: number;
  unrealizedPnl: number;
  realizedPnl: number;
  title?: string;
  redeemable?: boolean;
  mergeable?: boolean;
};

type PredictionOrder = {
  orderId: string;
  marketId: string;
  outcomeIndex: number;
  side: string;
  price: number;
  size: number;
  filled: number;
  timestamp: number | null;
  title?: string;
  outcomeName?: string;
};

type StateResult =
  | { id: string; label: string; configured: false }
  | { id: string; label: string; configured: true; error: string }
  | {
      id: string;
      label: string;
      configured: true;
      balances: Record<string, number>;
      positions: Position[];
      extras?: Record<string, unknown>;
    };

type PredictionOrderResult =
  | { id: string; label: string; configured: false }
  | { id: string; label: string; configured: true; error: string }
  | { id: string; label: string; configured: true; orders: PredictionOrder[] };

type OrderResult =
  | { id: string; label: string; configured: false }
  | { id: string; label: string; configured: true; error: string }
  | { id: string; label: string; configured: true; orders: Order[] };

type RunnerMode = "state" | "orders" | "prediction-orders";

// Runs as an ESM temp script (.mjs) so it can import portara-agent's ESM libs.
// cwd must be v3Dir so Extended SDK WASM resolves correctly.
function buildRunnerScript(
  v3Dir: string,
  mode: RunnerMode,
  exchanges: ReadonlyArray<ExchangeEntry>,
): string {
  const tiPath = JSON.stringify(`${v3Dir}/libs/trading-interface.js`);
  const cfgPath = JSON.stringify(`${v3Dir}/libs/config.js`);
  const exchangesJson = JSON.stringify(exchanges.map((e) => ({ id: e.id, label: e.label })));

  let fetchBody: string;
  if (mode === "state") {
    fetchBody = `    const state = await ti.getExchangeState(id);
    return { id, label, configured: true, balances: state.balances, positions: state.positions, extras: state.extras };`;
  } else if (mode === "orders") {
    fetchBody = `    const orders = await ti.getOpenOrders(id);
    return { id, label, configured: true, orders };`;
  } else {
    // prediction-orders: fetch orders and enrich with market titles
    fetchBody = `    const orders = await ti.getOpenOrders(id);
    const marketIds = [...new Set(orders.map(o => o.marketId).filter(Boolean))];
    const info = {};
    await Promise.all(marketIds.map(async (mId) => {
      try {
        const m = await ti.fetchMarket(id, mId);
        info[mId] = { title: m.title || m.question, outcomes: m.outcomes };
      } catch {}
    }));
    const enriched = orders.map(o => ({
      ...o,
      title: info[o.marketId]?.title || undefined,
      outcomeName: info[o.marketId]?.outcomes?.[o.outcomeIndex]?.name || undefined,
    }));
    return { id, label, configured: true, orders: enriched };`;
  }

  return `
import { TradingInterface } from ${tiPath};
import { loadConfig } from ${cfgPath};

const config = loadConfig();
const ti = new TradingInterface();

const EXCHANGES = ${exchangesJson};

const results = await Promise.all(EXCHANGES.map(async ({ id, label }) => {
  if (!config[id]) {
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
  mode: RunnerMode,
  exchanges: ReadonlyArray<ExchangeEntry>,
): Promise<{ results: T[]; error?: string }> {
  try {
    await access(v3Dir);
  } catch {
    return {
      results: [],
      error:
        "portara-agent not found in workspace. Ensure it is cloned to workspace/portara-agent.",
    };
  }

  const tmpDir = await mkdtemp(path.join(tmpdir(), "portara-ex-"));
  const scriptPath = path.join(tmpDir, "runner.mjs");
  try {
    await writeFile(scriptPath, buildRunnerScript(v3Dir, mode, exchanges), "utf8");
    const { stdout } = await execFileAsync("node", [scriptPath], {
      timeout: 20000,
      cwd: v3Dir,
    });
    return { results: JSON.parse(stdout) as T[] };
  } catch (err) {
    const error = err as NodeJS.ErrnoException & { killed?: boolean; stderr?: string };
    if (error.code === "ENOENT") {
      return { results: [], error: "Node.js is not installed or not in PATH." };
    }
    if (error.killed) {
      return { results: [], error: "Exchange query timed out after 20s." };
    }
    const detail =
      error.stderr?.split("\n").find((l) => l.trim() && !l.startsWith(" ")) ?? error.message;
    return { results: [], error: `Exchange query failed: ${detail}` };
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
}

// --- Formatting ---

function formatAmount(amount: number): string {
  if (amount >= 1000) {
    return amount.toLocaleString("en-US", { maximumFractionDigits: 2 });
  }
  if (amount >= 1) {
    return amount.toFixed(4).replace(/\.?0+$/, "");
  }
  return amount.toPrecision(4).replace(/\.?0+$/, "");
}

// For USD monetary values — always 2 decimal places, no more.
function formatUsd(amount: number): string {
  return amount.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function formatPrice(price: number): string {
  if (price >= 1000) {
    return price.toLocaleString("en-US", { maximumFractionDigits: 2 });
  }
  return price.toFixed(4).replace(/\.?0+$/, "");
}

function formatPnl(pnl: number): string {
  const sign = pnl >= 0 ? "+" : "-";
  return `${sign}$${Math.abs(pnl).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function formatCents(decimal: number): string {
  const cents = decimal * 100;
  return `${cents.toFixed(1).replace(/\.0$/, "")}¢`;
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
      // For unified accounts, HL and xyz share the same collateral pool —
      // use HL's balance only (xyz reports the same value, not additive).
      const isUnified = hl.extras?.unified === true;
      combined[hlIdx] = {
        ...hl,
        label: "Hyperliquid / trade\u200b.xyz",
        balances: {
          ...hl.balances,
          USD: isUnified
            ? (hl.balances.USD ?? 0)
            : (hl.balances.USD ?? 0) + (xyz.balances.USD ?? 0),
        },
      };
      merged[xyzIdx] = true;
    }
  }
  combined = combined.filter((_, i) => !merged[i]);

  for (const r of combined) {
    if (!r.configured) {
      lines.push(`${r.label}  ·  not configured`, "");
      continue;
    }
    if ("error" in r) {
      lines.push(`${r.label}  ·  error: ${r.error}`, "");
      continue;
    }
    const nonZero = Object.entries(r.balances).filter(
      ([k, v]) =>
        v !== 0 &&
        // USDT0 is Hyperliquid's on-chain USDT used as Dreamcash margin — always 1:1 with USDC, skip it.
        !(r.id === "cash" && k === "USDT0") &&
        // Polymarket normalizes USDC → USD; skip the raw USDC/USDT duplicates.
        !(r.id === "polymarket" && k !== "USD"),
    );
    if (nonZero.length === 0) {
      lines.push(`${r.label}  ·  no balances`);
    } else {
      lines.push(`**${r.label}**`);
      lines.push("```");
      for (const [asset, amount] of nonZero) {
        lines.push(`${asset.padEnd(10)}$${formatUsd(amount)}`);
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
    if (!r.configured) {
      lines.push(`${r.label}  ·  not configured`, "");
      continue;
    }
    if ("error" in r) {
      lines.push(`${r.label}  ·  error: ${r.error}`, "");
      continue;
    }
    const open = r.positions.filter((p) => p.size > 0);
    if (open.length === 0) {
      lines.push(`**${r.label}**`);
      lines.push("  no open positions");
      lines.push("");
      continue;
    }
    lines.push(`**${r.label}**`);
    for (let i = 0; i < open.length; i++) {
      const p = open[i];
      // add blank line between positions for readability
      if (i > 0) {
        lines.push("");
      }
      const side = p.side === "long" ? "long " : "short";
      const notional = formatUsd(p.size * p.markPrice);
      const margin = formatUsd((p.size * p.markPrice) / p.leverage);
      lines.push(
        `  ${side}  ${p.market}  ${formatAmount(p.size)} ($${notional})  ${p.leverage}×  PNL ${formatPnl(p.unrealizedPnl)}`,
      );
      const details = [
        `entry $${formatPrice(p.entryPrice)}`,
        `mark $${formatPrice(p.markPrice)}`,
        `margin $${margin}`,
      ];
      if (p.liquidationPrice > 0) {
        details.push(`liq $${formatPrice(p.liquidationPrice)}`);
      }
      lines.push(`    ${details.join("  ·  ")}`);
    }
    lines.push("");
  }
  return lines.join("\n").trimEnd();
}

function buildOrdersText(results: OrderResult[]): string {
  const lines: string[] = ["**My Open Orders**", ""];
  for (const r of results) {
    if (!r.configured) {
      lines.push(`${r.label}  ·  not configured`, "");
      continue;
    }
    if ("error" in r) {
      lines.push(`${r.label}  ·  error: ${r.error}`, "");
      continue;
    }
    if (r.orders.length === 0) {
      lines.push(`**${r.label}**`);
      lines.push("  no open orders");
      lines.push("");
      continue;
    }
    lines.push(`**${r.label}**`);
    for (let i = 0; i < r.orders.length; i++) {
      if (i > 0) {
        lines.push("");
      }
      const o = r.orders[i];
      const side = o.side === "buy" ? "BUY " : "SELL";
      const qty =
        o.filled > 0
          ? `${formatAmount(o.filled)}/${formatAmount(o.size)} filled`
          : formatAmount(o.size);
      lines.push(
        `  ${side}  ${o.market}  ${qty}  @ $${formatPrice(o.price)}  ≈ $${formatUsd(o.size * o.price)}`,
      );
    }
    lines.push("");
  }
  return lines.join("\n").trimEnd();
}

function buildPredictionPositionsText(results: StateResult[]): string {
  const lines: string[] = ["**My Prediction Positions**", ""];
  for (const r of results) {
    if (!r.configured) {
      lines.push(`${r.label}  ·  not configured`, "");
      continue;
    }
    if ("error" in r) {
      lines.push(`${r.label}  ·  error: ${r.error}`, "");
      continue;
    }
    const positions = (r.positions as unknown as PredictionPosition[]).filter((p) => p.shares > 0);
    if (positions.length === 0) {
      lines.push(`**${r.label}**`);
      lines.push("  no open positions");
      lines.push("");
      continue;
    }
    lines.push(`**${r.label}**`);
    for (let i = 0; i < positions.length; i++) {
      const p = positions[i];
      if (i > 0) {
        lines.push("");
      }
      const title = p.title || p.marketId;
      const outcome = p.outcomeName || (p.outcomeIndex === 0 ? "Yes" : "No");
      lines.push(`  ${title}`);
      const details = [
        `${outcome}  ${formatAmount(p.shares)} shares`,
        `avg ${formatCents(p.avgPrice)}`,
        `now ${formatCents(p.currentPrice)}`,
        `PnL ${formatPnl(p.unrealizedPnl)}`,
      ];
      lines.push(`    ${details.join("  ·  ")}`);
    }
    lines.push("");
  }
  return lines.join("\n").trimEnd();
}

function buildPredictionOrdersText(results: PredictionOrderResult[]): string {
  const lines: string[] = ["**My Prediction Orders**", ""];
  for (const r of results) {
    if (!r.configured) {
      lines.push(`${r.label}  ·  not configured`, "");
      continue;
    }
    if ("error" in r) {
      lines.push(`${r.label}  ·  error: ${r.error}`, "");
      continue;
    }
    if (r.orders.length === 0) {
      lines.push(`**${r.label}**`);
      lines.push("  no open orders");
      lines.push("");
      continue;
    }
    lines.push(`**${r.label}**`);
    for (let i = 0; i < r.orders.length; i++) {
      if (i > 0) {
        lines.push("");
      }
      const o = r.orders[i];
      const side = o.side === "buy" ? "BUY " : "SELL";
      const outcome = o.outcomeName || (o.outcomeIndex === 0 ? "Yes" : "No");
      const priceCents = `${o.price.toFixed(1).replace(/\.0$/, "")}¢`;
      const qty =
        o.filled > 0
          ? `${formatAmount(o.filled)}/${formatAmount(o.size)} filled`
          : formatAmount(o.size);
      const titlePart = o.title ? `  —  ${o.title}` : "";
      lines.push(`  ${side}  ${qty} ${outcome}  @ ${priceCents}${titlePart}`);
    }
    lines.push("");
  }
  return lines.join("\n").trimEnd();
}

// --- Reply helpers ---

function buildReply(text: string, command: string, channel: string): ReplyPayload {
  if (channel === "telegram") {
    const buttons: TelegramInlineButtons = [[{ text: "⟳  Refresh", callback_data: command }]];
    return { text, channelData: { telegram: { buttons } } };
  }
  return { text };
}

// --- Main handler ---

export const handleExchangeCommand: CommandHandler = async (params, allowTextCommands) => {
  if (!allowTextCommands) {
    return null;
  }

  const body = params.command.commandBodyNormalized;
  const isBalances = body === "/mybalances" || body.startsWith("/mybalances ");
  const isPositions = body === "/mypositions" || body.startsWith("/mypositions ");
  const isOrders = body === "/myorders" || body.startsWith("/myorders ");
  const isPredictionPositions =
    body === "/mypredictionpositions" ||
    body.startsWith("/mypredictionpositions ") ||
    body === "/my_prediction_positions" ||
    body.startsWith("/my_prediction_positions ");
  const isPredictionOrders =
    body === "/mypredictionorders" ||
    body.startsWith("/mypredictionorders ") ||
    body === "/my_prediction_orders" ||
    body.startsWith("/my_prediction_orders ");
  if (!isBalances && !isPositions && !isOrders && !isPredictionPositions && !isPredictionOrders) {
    return null;
  }

  const label = isBalances
    ? "/mybalances"
    : isPositions
      ? "/mypositions"
      : isOrders
        ? "/myorders"
        : isPredictionPositions
          ? "/mypredictionpositions"
          : "/mypredictionorders";
  const unauthorized = rejectUnauthorizedCommand(params, label);
  if (unauthorized) {
    return unauthorized;
  }

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

  // Fetch data based on command type
  let replyPayload: ReplyPayload;
  if (isOrders) {
    const { results, error } = await fetchData<OrderResult>(v3Dir, "orders", PERP_EXCHANGES);
    if (error) {
      replyPayload = { text: error };
    } else {
      replyPayload = buildReply(buildOrdersText(results), label, channel);
    }
  } else if (isPredictionPositions) {
    const { results, error } = await fetchData<StateResult>(v3Dir, "state", PREDICTION_EXCHANGES);
    if (error) {
      replyPayload = { text: error };
    } else {
      replyPayload = buildReply(buildPredictionPositionsText(results), label, channel);
    }
  } else if (isPredictionOrders) {
    const { results, error } = await fetchData<PredictionOrderResult>(
      v3Dir,
      "prediction-orders",
      PREDICTION_EXCHANGES,
    );
    if (error) {
      replyPayload = { text: error };
    } else {
      replyPayload = buildReply(buildPredictionOrdersText(results), label, channel);
    }
  } else {
    // /mybalances or /mypositions — fetch state
    const exchanges = isBalances ? ALL_EXCHANGES : PERP_EXCHANGES;
    const { results, error } = await fetchData<StateResult>(v3Dir, "state", exchanges);
    if (error) {
      replyPayload = { text: error };
    } else {
      const text = isBalances ? buildBalancesText(results) : buildPositionsText(results);
      replyPayload = buildReply(text, label, channel);
    }
  }

  // If we have a loading message to edit, edit it directly via Telegram API
  const chatId = params.ctx.OriginatingTo ?? params.command.from ?? params.command.to;
  if (editMessageId && channel === "telegram" && chatId) {
    const buttons = (replyPayload.channelData?.telegram as { buttons?: TelegramInlineButtons })
      ?.buttons;
    try {
      const { editMessageTelegram } = await import("@openclaw/telegram/runtime-api.js");
      await editMessageTelegram(chatId, editMessageId, replyPayload.text ?? "", {
        cfg: params.cfg,
        buttons,
      });
    } catch {
      // Edit failed (message deleted, too old, etc.) — fall back to new message
      return { shouldContinue: false, reply: replyPayload };
    }
    return { shouldContinue: false };
  }

  return { shouldContinue: false, reply: replyPayload };
};
