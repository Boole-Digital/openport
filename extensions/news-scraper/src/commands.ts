import { randomBytes } from "node:crypto";
import { callGateway } from "../../../src/gateway/call.js";
import type { OpenClawPluginApi, PluginCommandContext } from "../../../src/plugins/types.js";
import { GATEWAY_CLIENT_MODES, GATEWAY_CLIENT_NAMES } from "../../../src/utils/message-channel.js";
import { detectFeedType } from "./cli.js";
import { loadFeeds, loadFeedState, removeFeed, saveFeed } from "./feeds.js";
import { scrapeFeed } from "./scraper.js";
import { summarizeItems } from "./summarizer.js";
import type { Feed, NewsItem, PluginCfg } from "./types.js";

const DEFAULT_SOURCE_URL = "https://news.treeofalpha.com/";
const DEFAULT_SOURCE_NAME = "Tree of Alpha";
const DEFAULT_SCHEDULE = "*/5 * * * *";

function genId(): string {
  return randomBytes(6).toString("hex");
}

/** Detect whether a token looks like a URL. */
function isUrl(token: string): boolean {
  return /^https?:\/\//i.test(token) || token.includes("t.me/") || token.includes("x.com/");
}

/** Parse args into URLs, keyword tokens, and flags. */
function parseArgs(args: string): { urls: string[]; keywords: string[]; useScrapling: boolean } {
  const tokens = args.split(/\s+/).filter(Boolean);
  const urls: string[] = [];
  const keywords: string[] = [];
  let useScrapling = false;
  for (const t of tokens) {
    if (t === "--scrapling" || t === "scrapling") {
      useScrapling = true;
    } else if (isUrl(t)) {
      urls.push(t.startsWith("http") ? t : `https://${t}`);
    } else {
      keywords.push(t);
    }
  }
  return { urls, keywords, useScrapling };
}

/** Build a temporary Feed object for one-shot scraping. */
function buildTempFeed(url: string, name: string, keywords: string[], useScrapling = false): Feed {
  const feedType = detectFeedType(url);
  // Tree of Alpha is JS-rendered
  const jsRender = feedType === "web" && url.includes("treeofalpha.com");
  return {
    id: genId(),
    name,
    type: feedType,
    url,
    keywords: keywords.length > 0 ? keywords : undefined,
    jsRender,
    useScrapling,
    enabled: true,
  };
}

/** Format a news item for display in messaging channels. */
function formatItem(item: NewsItem): string {
  const rel = item.relevance === "high" ? "🔴" : item.relevance === "medium" ? "🟡" : "⚪";
  // Wrap URL in <> to suppress link previews on Telegram/Discord/Slack
  const link = item.url ? `\n<${item.url}>` : "";
  return `${rel} ${item.summary}${link}`;
}

// ---------------------------------------------------------------------------
// /news — one-shot news fetch
// ---------------------------------------------------------------------------

async function handleNews(args: string, cfg: PluginCfg): Promise<string> {
  const { urls, keywords, useScrapling } = parseArgs(args);

  // Default to Tree of Alpha if no source specified
  const sources =
    urls.length > 0
      ? urls.map((u) => ({ url: u, name: u }))
      : [{ url: DEFAULT_SOURCE_URL, name: DEFAULT_SOURCE_NAME }];

  const allItems: NewsItem[] = [];
  const errors: string[] = [];

  for (const source of sources) {
    const feed = buildTempFeed(source.url, source.name, keywords, useScrapling);
    try {
      const rawItems = await scrapeFeed(feed, cfg);
      if (rawItems.length === 0) {
        errors.push(`${source.name}: no items found`);
        continue;
      }
      const { items } = await summarizeItems(
        rawItems.slice(0, cfg.maxItemsPerFeed ?? 100),
        feed,
        cfg,
      );
      allItems.push(...items);
    } catch (err) {
      errors.push(`${source.name}: ${(err as Error).message}`);
    }
  }

  if (allItems.length === 0 && errors.length > 0) {
    return `Could not fetch news.\n${errors.join("\n")}`;
  }

  if (allItems.length === 0) {
    return "No news items found.";
  }

  // Sort: high relevance first, then medium, then low
  const order = { high: 0, medium: 1, low: 2 };
  allItems.sort((a, b) => (order[a.relevance ?? "low"] ?? 2) - (order[b.relevance ?? "low"] ?? 2));

  // Filter by keywords — strict text match, don't trust LLM relevance ratings
  const filtered =
    keywords.length > 0
      ? allItems.filter((item) =>
          keywords.some(
            (kw) =>
              item.title.toLowerCase().includes(kw.toLowerCase()) ||
              item.summary.toLowerCase().includes(kw.toLowerCase()),
          ),
        )
      : allItems;

  // If keyword filtering returned nothing, say so — don't dump unrelated items
  if (keywords.length > 0 && filtered.length === 0) {
    return `📰 No news matching "${keywords.join(", ")}" found in latest ${allItems.length} items.`;
  }
  const display = filtered.length > 0 ? filtered : allItems.slice(0, 10);

  const sourceLabel = sources.length === 1 ? sources[0]!.name : `${sources.length} sources`;
  const keywordLabel = keywords.length > 0 ? ` (${keywords.join(", ")})` : "";
  const header = `📰 Latest News — ${sourceLabel}${keywordLabel}\n`;
  const body = display.slice(0, 25).map(formatItem).join("\n\n");
  const footer = errors.length > 0 ? `\n\n⚠️ ${errors.join("; ")}` : "";

  return `${header}\n${body}${footer}`;
}

// ---------------------------------------------------------------------------
// /newswatch — set up or manage recurring news watches
// ---------------------------------------------------------------------------

async function handleNewsWatch(
  args: string,
  cfg: PluginCfg,
  ctx: PluginCommandContext,
): Promise<string> {
  const tokens = args.split(/\s+/).filter(Boolean);
  const action = tokens[0]?.toLowerCase() ?? "";

  // /newswatch list
  if (action === "list") {
    const feeds = await loadFeeds();
    if (feeds.length === 0) return "No active news watches. Use /newswatch <topic> to start one.";
    const lines = await Promise.all(
      feeds.map(async (f) => {
        const state = await loadFeedState(f.id);
        const lastChecked = state.lastCheckedAt
          ? new Date(state.lastCheckedAt).toLocaleString()
          : "never";
        const kw = f.keywords?.length ? ` [${f.keywords.join(", ")}]` : "";
        const status = f.enabled ? "🟢" : "🔴";
        return `${status} ${f.name}${kw}\n   ID: ${f.id} · ${f.type} · last: ${lastChecked}`;
      }),
    );
    return `👁️ Active News Watches\n\n${lines.join("\n\n")}`;
  }

  // /newswatch stop <id>
  if (action === "stop" || action === "remove") {
    const feedId = tokens[1]?.trim();
    if (!feedId) return "Usage: /newswatch stop <id>\n\nUse /newswatch list to see feed IDs.";
    const ok = await removeFeed(feedId);
    if (!ok) return `Feed ${feedId} not found. Use /newswatch list to see active watches.`;
    // Auto-remove the associated cron job
    try {
      const jobs = await callGateway<{ id: string; name: string }[]>({
        method: "cron.list",
        params: { includeDisabled: true },
        clientName: GATEWAY_CLIENT_NAMES.CLI,
        mode: GATEWAY_CLIENT_MODES.CLI,
      });
      const cronJob = (Array.isArray(jobs) ? jobs : []).find((j) => j.name === `news:${feedId}`);
      if (cronJob) {
        await callGateway({
          method: "cron.remove",
          params: { id: cronJob.id },
          clientName: GATEWAY_CLIENT_NAMES.CLI,
          mode: GATEWAY_CLIENT_MODES.CLI,
        });
      }
    } catch {
      // Best-effort: feed is already removed, cron cleanup is non-critical
    }
    return `Stopped watching feed ${feedId}.`;
  }

  // /newswatch [urls...] [keywords...] — set up a new watch
  const { urls, keywords, useScrapling } = parseArgs(args);
  const sources = urls.length > 0 ? urls : [DEFAULT_SOURCE_URL];

  const created: string[] = [];
  const cronWarnings: string[] = [];
  for (const url of sources) {
    const feedType = detectFeedType(url);
    const jsRender = feedType === "web" && url.includes("treeofalpha.com");
    const name =
      url === DEFAULT_SOURCE_URL
        ? DEFAULT_SOURCE_NAME
        : url.replace(/^https?:\/\//, "").slice(0, 40);
    const feed: Feed = {
      id: genId(),
      name,
      type: feedType,
      url,
      keywords: keywords.length > 0 ? keywords : undefined,
      schedule: DEFAULT_SCHEDULE,
      jsRender,
      useScrapling,
      enabled: true,
    };
    await saveFeed(feed);
    // Auto-create the cron job so the watch actually polls
    try {
      await callGateway({
        method: "cron.add",
        params: {
          name: `news:${feed.id}`,
          description: `News watch: ${feed.name}`,
          enabled: true,
          schedule: { kind: "cron", expr: feed.schedule ?? DEFAULT_SCHEDULE },
          sessionTarget: "isolated",
          payload: {
            kind: "agentTurn",
            message: `Run check_news for feed ${feed.id}. Summarize and deliver any new items.`,
            thinking: "low",
            timeoutSeconds: 300,
          },
          delivery: {
            mode: "announce",
            channel: ctx.channelId ?? ctx.channel,
            to: ctx.from ?? ctx.senderId,
          },
        },
        clientName: GATEWAY_CLIENT_NAMES.CLI,
        mode: GATEWAY_CLIENT_MODES.CLI,
      });
    } catch (err) {
      cronWarnings.push(
        `⚠️ Could not auto-schedule feed ${feed.id}: ${(err as Error).message}\nRun manually:\n  openclaw cron add --name "news:${feed.id}" --cron "${DEFAULT_SCHEDULE}" --message "Run check_news for feed ${feed.id}. Summarize and deliver any new items." --deliver --session isolated`,
      );
    }
    created.push(
      `👁️ ${feed.name} (${feed.type})\n   ID: ${feed.id}${keywords.length > 0 ? ` · Keywords: ${keywords.join(", ")}` : ""}`,
    );
  }

  const warnings = cronWarnings.length > 0 ? `\n\n${cronWarnings.join("\n")}` : "";
  return `News watch created!\n\n${created.join("\n\n")}\n\nSchedule: every 5 minutes${warnings}`;
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export function registerNewsCommands(api: OpenClawPluginApi): void {
  const cfg = () => (api.pluginConfig ?? {}) as PluginCfg;

  api.registerCommand({
    name: "news",
    description: "Get latest news. Usage: /news [topic] [source-url] [scrapling]",
    acceptsArgs: true,
    handler: async (ctx) => {
      const args = ctx.args?.trim() ?? "";
      try {
        const text = await handleNews(args, cfg());
        return { text };
      } catch (err) {
        return { text: `Error fetching news: ${(err as Error).message}` };
      }
    },
  });

  api.registerCommand({
    name: "newswatch",
    description: "Watch for news and get pinged. Usage: /newswatch [topic] [source-url]",
    acceptsArgs: true,
    handler: async (ctx) => {
      const args = ctx.args?.trim() ?? "";
      try {
        const text = await handleNewsWatch(args, cfg(), ctx);
        return { text };
      } catch (err) {
        return { text: `Error: ${(err as Error).message}` };
      }
    },
  });
}
