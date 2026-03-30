import type { TelegramInlineButtons } from "@openclaw/telegram/api.js";
import { editMessageTelegram } from "@openclaw/telegram/runtime-api.js";
import type { ReplyPayload } from "../types.js";
import { rejectUnauthorizedCommand } from "./command-gates.js";
import type { CommandHandler } from "./commands-types.js";

const HL_INFO_URL = "https://api.hyperliquid.xyz/info";

type HlOpenOrder = {
  coin: string;
  isTrigger: boolean;
  limitPx: string;
  oid: number;
  orderType: string;
  reduceOnly: boolean;
  side: string; // "B" | "S"
  sz: string;
  triggerCondition: string;
  triggerPx: string;
};

type HlPosition = {
  coin: string;
  entryPx: string;
  liquidationPx: string | null;
  returnOnEquity: string;
  szi: string; // positive = long, negative = short
  unrealizedPnl: string;
};

type HlAssetPosition = {
  position: HlPosition;
  type: string;
};

type HlMarginSummary = {
  accountValue: string;
  totalMarginUsed: string;
  totalRawUsd: string;
};

type HlClearinghouseState = {
  assetPositions: HlAssetPosition[];
  crossMarginSummary: HlMarginSummary;
  marginSummary: HlMarginSummary;
  withdrawable: string;
};

async function hlPost<T>(body: Record<string, unknown>): Promise<T> {
  const res = await fetch(HL_INFO_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`Hyperliquid API ${res.status}`);
  }
  return res.json() as Promise<T>;
}

function formatPrice(px: string): string {
  const n = parseFloat(px);
  if (isNaN(n) || n === 0) {
    return "—";
  }
  if (n >= 10000) {
    return n.toLocaleString("en-US", { maximumFractionDigits: 0 });
  }
  if (n >= 100) {
    return n.toLocaleString("en-US", { maximumFractionDigits: 2 });
  }
  if (n >= 1) {
    return n.toLocaleString("en-US", { maximumFractionDigits: 4 });
  }
  return n.toLocaleString("en-US", { maximumFractionDigits: 6 });
}

function formatSize(sz: string): string {
  const n = Math.abs(parseFloat(sz));
  if (isNaN(n)) {
    return sz;
  }
  if (n >= 1000) {
    return n.toLocaleString("en-US", { maximumFractionDigits: 1 });
  }
  if (n >= 1) {
    return n.toLocaleString("en-US", { maximumFractionDigits: 4 });
  }
  return n.toLocaleString("en-US", { maximumFractionDigits: 6 });
}

function formatUSDC(val: string): string {
  const n = parseFloat(val);
  if (isNaN(n)) {
    return val;
  }
  const abs = Math.abs(n);
  const formatted =
    abs >= 10000
      ? abs.toLocaleString("en-US", { maximumFractionDigits: 0 })
      : abs.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return n >= 0 ? `$${formatted}` : `-$${formatted}`;
}

function formatRoe(roe: string): string {
  const n = parseFloat(roe) * 100;
  if (isNaN(n)) {
    return "";
  }
  return n >= 0 ? ` (+${n.toFixed(1)}%)` : ` (${n.toFixed(1)}%)`;
}

function formatOrder(o: HlOpenOrder): string {
  const sideEmoji = o.side === "B" ? "🟢" : "🔴";
  const sideLabel = o.side === "B" ? "BUY " : "SELL";
  const price = o.isTrigger ? `trigger ${o.triggerPx}` : `@ ${formatPrice(o.limitPx)}`;
  const type = o.isTrigger ? `Trigger (${o.triggerCondition})` : o.orderType;
  const reduceTag = o.reduceOnly ? "  reduce-only" : "";
  return `${sideEmoji} ${sideLabel}  ${formatSize(o.sz)} ${o.coin}  ${price}  ${type}${reduceTag}`;
}

function formatPosition(ap: HlAssetPosition): string {
  const p = ap.position;
  const size = parseFloat(p.szi);
  const isLong = size >= 0;
  const emoji = isLong ? "📈" : "📉";
  const dir = isLong ? "LONG " : "SHORT";
  const pnl = parseFloat(p.unrealizedPnl);
  const pnlStr = `${pnl >= 0 ? "+" : ""}${formatUSDC(p.unrealizedPnl)}${formatRoe(p.returnOnEquity)}`;
  const liq = p.liquidationPx ? `  Liq ${formatPrice(p.liquidationPx)}` : "";
  return `${emoji} ${dir}  ${formatSize(p.szi)} ${p.coin}  Entry ${formatPrice(p.entryPx)}  PnL ${pnlStr}${liq}`;
}

async function fetchAccountData(
  address: string,
): Promise<{
  orders: HlOpenOrder[];
  state: HlClearinghouseState;
  unifiedAccountValue?: number;
  error?: string;
}> {
  try {
    const [orders, state, mode] = await Promise.all([
      hlPost<HlOpenOrder[]>({ type: "frontendOpenOrders", user: address }),
      hlPost<HlClearinghouseState>({ type: "clearinghouseState", user: address }),
      hlPost<string>({ type: "userAbstraction", user: address }).catch(() => "default"),
    ]);
    const unified = mode === "unifiedAccount" || mode === "portfolioMargin";
    let unifiedAccountValue: number | undefined;
    if (unified) {
      const spot = await hlPost<{ balances: { coin: string; total: string }[] }>({
        type: "spotClearinghouseState",
        user: address,
      }).catch(() => ({ balances: [] }));
      unifiedAccountValue = (spot.balances ?? [])
        .filter((b) => b.coin === "USDC" || b.coin === "USDH")
        .reduce((sum, b) => sum + parseFloat(b.total || "0"), 0);
    }
    return { orders, state, unifiedAccountValue };
  } catch (err) {
    return { orders: [], state: {} as HlClearinghouseState, error: String(err) };
  }
}

function buildOrdersReply(
  orders: HlOpenOrder[],
  state: HlClearinghouseState,
  channel: string,
  editMessageId?: string,
  unifiedAccountValue?: number,
): ReplyPayload {
  const positions = (state.assetPositions ?? [])
    .filter((ap) => parseFloat(ap.position.szi) !== 0)
    .toSorted(
      (a, b) =>
        Math.abs(parseFloat(b.position.unrealizedPnl)) -
        Math.abs(parseFloat(a.position.unrealizedPnl)),
    );

  const accountValue =
    unifiedAccountValue != null
      ? formatUSDC(String(unifiedAccountValue))
      : formatUSDC(state.marginSummary?.accountValue ?? "0");
  const withdrawable = formatUSDC(state.withdrawable ?? "0");
  const margin = formatUSDC(state.crossMarginSummary?.totalMarginUsed ?? "0");

  const parts: string[] = [];

  // Header
  const summaryParts: string[] = [];
  if (orders.length > 0) {
    summaryParts.push(`${orders.length} open order${orders.length !== 1 ? "s" : ""}`);
  }
  if (positions.length > 0) {
    summaryParts.push(`${positions.length} position${positions.length !== 1 ? "s" : ""}`);
  }
  if (summaryParts.length === 0) {
    summaryParts.push("no open orders or positions");
  }
  parts.push(`My Account  ·  ${summaryParts.join("  ·  ")}`);

  // Account summary
  parts.push(`\n💵 ${accountValue} USDC  ·  Margin ${margin}  ·  Available ${withdrawable}`);

  // Open orders
  if (orders.length > 0) {
    parts.push(`\nOpen Orders (${orders.length}):`);
    for (const o of orders) {
      parts.push(formatOrder(o));
    }
  }

  // Positions
  if (positions.length > 0) {
    parts.push(`\nPositions (${positions.length}):`);
    for (const ap of positions) {
      parts.push(formatPosition(ap));
    }
  }

  const text = parts.join("\n");

  if (channel === "telegram") {
    const buttons: TelegramInlineButtons = [[{ text: "🔄  Refresh", callback_data: "/myorders" }]];
    const channelData: Record<string, unknown> = {
      telegram: {
        buttons,
        ...(editMessageId ? { editMessageId } : {}),
      },
    };
    return { text, channelData };
  }

  return { text };
}

export const handleMyOrdersCommand: CommandHandler = async (params, allowTextCommands) => {
  if (!allowTextCommands) {
    return null;
  }

  const body = params.command.commandBodyNormalized;
  if (!body.startsWith("/myorders")) {
    return null;
  }

  const unauthorized = rejectUnauthorizedCommand(params, "/myorders");
  if (unauthorized) {
    return unauthorized;
  }

  const address = process.env["HYPERLIQUID_ADDRESS"]?.trim();
  if (!address) {
    return {
      shouldContinue: false,
      reply: {
        text: '⚠️ HYPERLIQUID_ADDRESS not set.\nAdd to ~/.profile:\nexport HYPERLIQUID_ADDRESS="0x..."',
      },
    };
  }

  const channel = params.command.channel;
  const editMessageId = params.ctx.TelegramEditMessageId;

  const { orders, state, unifiedAccountValue, error } = await fetchAccountData(address);
  if (error) {
    return { shouldContinue: false, reply: { text: `Hyperliquid error: ${error}` } };
  }

  const reply = buildOrdersReply(orders, state, channel, editMessageId, unifiedAccountValue);

  // Edit loading message in-place for Telegram button refreshes
  const chatId = params.ctx.OriginatingTo ?? params.command.from ?? params.command.to;
  if (editMessageId && channel === "telegram" && chatId) {
    const buttons = (reply.channelData?.telegram as { buttons?: TelegramInlineButtons })?.buttons;
    try {
      await editMessageTelegram(chatId, editMessageId, reply.text ?? "", {
        cfg: params.cfg,
        buttons,
      });
      return { shouldContinue: false };
    } catch {
      // Edit failed — fall back to new message
    }
  }

  return { shouldContinue: false, reply };
};
