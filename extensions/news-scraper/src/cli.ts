import { randomBytes } from "node:crypto";
import type { Command } from "commander";
import type { OpenClawPluginApi } from "../../../src/plugins/types.js";
import { diffItems } from "./differ.js";
import { getFeed, loadFeeds, loadFeedState, removeFeed, saveFeed, saveFeedState } from "./feeds.js";
import { scrapeFeed } from "./scraper.js";
import { summarizeItems } from "./summarizer.js";
import type { Feed, FeedType, PluginCfg } from "./types.js";

function genId(): string {
  return randomBytes(6).toString("hex");
}

const DEFAULT_SCHEDULE = "0 */2 * * *";

export function registerNewsCli(program: Command, api: OpenClawPluginApi): void {
  const news = program.command("news").description("Manage news scraping feeds");

  // ---- add ----
  news
    .command("add")
    .description("Add a new news feed")
    .requiredOption("--url <url>", "Feed URL (RSS, web page, X search, or Telegram channel URL)")
    .requiredOption("--name <name>", "Human-friendly feed name")
    .option("--type <type>", "Feed type: rss, web, x-search, telegram (auto-detected if omitted)")
    .option("--keywords <words>", "Comma-separated keywords to filter by")
    .option("--schedule <cron>", `Cron schedule (default: "${DEFAULT_SCHEDULE}")`)
    .option("--strategy <stem>", "Strategy stem to trigger on high-relevance news")
    .option("--strategy-prompt <prompt>", "Instruction for strategy trigger decision")
    .option("--js-render", "Use Playwright for JS rendering (type=web only)")
    .action(async (opts) => {
      const url = opts.url as string;
      const name = opts.name as string;
      const feedType = (opts.type as FeedType) || detectFeedType(url);
      const keywords = opts.keywords
        ? (opts.keywords as string)
            .split(",")
            .map((k: string) => k.trim())
            .filter(Boolean)
        : undefined;

      const feed: Feed = {
        id: genId(),
        name,
        type: feedType,
        url,
        keywords,
        schedule: (opts.schedule as string) || DEFAULT_SCHEDULE,
        jsRender: opts.jsRender === true,
        strategy: opts.strategy as string | undefined,
        strategyPrompt: opts.strategyPrompt as string | undefined,
        enabled: true,
      };

      await saveFeed(feed);
      console.log(`Feed added: ${feed.name} (${feed.id})`);
      console.log(`  Type: ${feed.type}`);
      console.log(`  URL: ${feed.url}`);
      console.log(`  Schedule: ${feed.schedule}`);
      if (feed.keywords?.length) console.log(`  Keywords: ${feed.keywords.join(", ")}`);
      if (feed.strategy) console.log(`  Strategy: ${feed.strategy}`);
      console.log(
        `\nTo set up scheduled checks, create a cron job:\n  openclaw cron add --name "news:${feed.id}" --cron "${feed.schedule}" --message "Run check_news for feed ${feed.id}. Summarize new items and deliver to me." --deliver --session isolated`,
      );
    });

  // ---- list ----
  news
    .command("list")
    .description("List all configured feeds")
    .action(async () => {
      const feeds = await loadFeeds();
      if (feeds.length === 0) {
        console.log("No feeds configured. Use `openclaw news add` to add one.");
        return;
      }
      for (const f of feeds) {
        const state = await loadFeedState(f.id);
        const lastChecked = state.lastCheckedAt
          ? new Date(state.lastCheckedAt).toLocaleString()
          : "never";
        const status = f.enabled ? "enabled" : "disabled";
        console.log(`${f.id}  ${f.name}  [${f.type}]  ${status}  last: ${lastChecked}`);
        console.log(`  ${f.url}`);
        if (f.keywords?.length) console.log(`  keywords: ${f.keywords.join(", ")}`);
        if (f.strategy) console.log(`  strategy: ${f.strategy}`);
      }
    });

  // ---- remove ----
  news
    .command("remove")
    .description("Remove a feed by ID")
    .argument("<feedId>", "Feed ID to remove")
    .action(async (feedId: string) => {
      const ok = await removeFeed(feedId);
      if (ok) {
        console.log(`Feed ${feedId} removed.`);
        console.log(
          `Remember to also remove the matching cron job: openclaw cron remove news:${feedId}`,
        );
      } else {
        console.log(`Feed ${feedId} not found.`);
      }
    });

  // ---- check ----
  news
    .command("check")
    .description("Run a one-off check on a feed (or all feeds)")
    .option("--feed <feedId>", "Specific feed ID (omit for all enabled feeds)")
    .option("--keywords <words>", "Additional comma-separated keywords to filter by")
    .action(async (opts) => {
      const cfg = (api.pluginConfig ?? {}) as PluginCfg;
      const maxItems = cfg.maxItemsPerFeed ?? 20;
      const feedId = opts.feed as string | undefined;
      const extraKeywords = opts.keywords
        ? (opts.keywords as string)
            .split(",")
            .map((k: string) => k.trim())
            .filter(Boolean)
        : [];

      let feeds;
      if (feedId) {
        const f = await getFeed(feedId);
        if (!f) {
          console.error(`Feed not found: ${feedId}`);
          return;
        }
        feeds = [f];
      } else {
        feeds = (await loadFeeds()).filter((f) => f.enabled);
      }

      if (feeds.length === 0) {
        console.log("No feeds to check.");
        return;
      }

      for (const feed of feeds) {
        console.log(`\nChecking: ${feed.name} (${feed.type})...`);
        try {
          let rawItems = await scrapeFeed(feed, cfg);
          rawItems = rawItems.slice(0, maxItems);
          console.log(`  Scraped ${rawItems.length} items`);

          const state = await loadFeedState(feed.id);
          const { newItems, updatedHashes } = diffItems(rawItems, state.seenHashes);
          console.log(`  New items: ${newItems.length}`);

          if (newItems.length === 0) {
            await saveFeedState({ ...state, lastCheckedAt: Date.now(), seenHashes: updatedHashes });
            continue;
          }

          const mergedFeed =
            extraKeywords.length > 0
              ? { ...feed, keywords: [...(feed.keywords ?? []), ...extraKeywords] }
              : feed;
          const { items, triggers } = await summarizeItems(newItems, mergedFeed, cfg);

          for (const item of items) {
            const rel = item.relevance ? `[${item.relevance.toUpperCase()}]` : "";
            console.log(`  ${rel} ${item.title}`);
            console.log(`    ${item.summary}`);
            if (item.url) console.log(`    ${item.url}`);
          }

          for (const t of triggers) {
            console.log(`  >> Strategy "${t.stem}" triggered: ${t.reason}`);
          }

          await saveFeedState({
            feedId: feed.id,
            lastCheckedAt: Date.now(),
            seenHashes: updatedHashes,
          });
        } catch (err) {
          console.error(`  Error: ${(err as Error).message}`);
        }
      }
    });

  // ---- status ----
  news
    .command("status")
    .description("Show feed health and last check info")
    .action(async () => {
      const feeds = await loadFeeds();
      if (feeds.length === 0) {
        console.log("No feeds configured.");
        return;
      }
      for (const f of feeds) {
        const state = await loadFeedState(f.id);
        const lastChecked = state.lastCheckedAt
          ? new Date(state.lastCheckedAt).toLocaleString()
          : "never";
        const seenCount = state.seenHashes.length;
        const status = f.enabled ? "enabled" : "disabled";
        console.log(`${f.name} (${f.id})`);
        console.log(
          `  Status: ${status}  |  Type: ${f.type}  |  Schedule: ${f.schedule ?? DEFAULT_SCHEDULE}`,
        );
        console.log(`  Last checked: ${lastChecked}  |  Seen items: ${seenCount}`);
      }
    });
}

// ---------------------------------------------------------------------------
// Auto-detection helpers
// ---------------------------------------------------------------------------

export function detectFeedType(url: string): FeedType {
  const lower = url.toLowerCase();
  if (lower.includes("t.me/")) return "telegram";
  if (lower.includes("x.com/") || lower.includes("twitter.com/")) return "x-search";
  if (
    lower.endsWith("/rss") ||
    lower.endsWith("/feed") ||
    lower.endsWith("/atom") ||
    lower.includes("/rss.xml") ||
    lower.includes("/feed.xml") ||
    lower.includes("/atom.xml") ||
    lower.includes("feeds.") ||
    lower.includes("/feed/")
  ) {
    return "rss";
  }
  return "web";
}
