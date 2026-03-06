import { Type } from "@sinclair/typebox";
import type { OpenClawPluginApi } from "../../../src/plugins/types.js";
import { diffItems } from "./differ.js";
import { getFeed, loadFeeds, loadFeedState, saveFeedState } from "./feeds.js";
import { scrapeFeed } from "./scraper.js";
import { summarizeItems } from "./summarizer.js";
import type { FeedCheckResult, NewsItem, PluginCfg, StrategyTrigger } from "./types.js";

/**
 * Create the `check_news` agent tool.
 *
 * The agent (or a cron job) invokes this to scrape configured feeds,
 * diff against previously seen content, summarize via a cheap LLM,
 * and return structured results with optional strategy triggers.
 */
export function createNewsTool(api: OpenClawPluginApi) {
  return {
    name: "check_news",
    label: "Check News",
    description:
      "Check configured news feeds for new items. Scrapes sources, deduplicates, summarizes with LLM, and returns news with relevance classification. Can trigger linked strategies on high-relevance items.",
    parameters: Type.Object({
      feedId: Type.Optional(
        Type.String({ description: "Specific feed ID to check. Omit to check all enabled feeds." }),
      ),
      keywords: Type.Optional(
        Type.String({ description: "Additional keywords to filter results by (comma-separated)." }),
      ),
    }),

    async execute(_id: string, params: Record<string, unknown>) {
      const cfg = (api.pluginConfig ?? {}) as PluginCfg;
      const maxItems = cfg.maxItemsPerFeed ?? 100;

      // Resolve target feeds
      const feedId = typeof params.feedId === "string" ? params.feedId.trim() : undefined;
      const extraKeywords =
        typeof params.keywords === "string"
          ? params.keywords
              .split(",")
              .map((k) => k.trim())
              .filter(Boolean)
          : [];

      let feeds;
      if (feedId) {
        const feed = await getFeed(feedId);
        if (!feed) throw new Error(`Feed not found: ${feedId}`);
        feeds = [feed];
      } else {
        feeds = (await loadFeeds()).filter((f) => f.enabled);
      }

      if (feeds.length === 0) {
        return {
          content: [
            { type: "text", text: "No news feeds configured. Use `openclaw news add` to add one." },
          ],
        };
      }

      const results: FeedCheckResult[] = [];

      for (const feed of feeds) {
        try {
          // 1. Scrape
          let rawItems = await scrapeFeed(feed, cfg);
          rawItems = rawItems.slice(0, maxItems);

          // 2. Diff against previously seen items
          const state = await loadFeedState(feed.id);
          const { newItems, updatedHashes } = diffItems(rawItems, state.seenHashes);

          if (newItems.length === 0) {
            results.push({ feed, newItems: [], triggers: [] });
            // Still update lastCheckedAt
            await saveFeedState({ ...state, lastCheckedAt: Date.now(), seenHashes: updatedHashes });
            continue;
          }

          // 3. Summarize + classify via LLM
          // Merge feed keywords with any extra keywords from the tool call
          const mergedFeed =
            extraKeywords.length > 0
              ? { ...feed, keywords: [...(feed.keywords ?? []), ...extraKeywords] }
              : feed;
          const { items, triggers } = await summarizeItems(newItems, mergedFeed, cfg);

          // 4. Filter by keywords if any are set
          const keywords = mergedFeed.keywords ?? [];
          const filtered =
            keywords.length > 0
              ? items.filter(
                  (item) =>
                    item.relevance === "high" ||
                    keywords.some(
                      (kw) =>
                        item.title.toLowerCase().includes(kw.toLowerCase()) ||
                        item.summary.toLowerCase().includes(kw.toLowerCase()),
                    ),
                )
              : items;

          results.push({ feed, newItems: filtered, triggers });

          // 5. Persist updated state
          await saveFeedState({
            feedId: feed.id,
            lastCheckedAt: Date.now(),
            seenHashes: updatedHashes,
          });
        } catch (err) {
          results.push({
            feed,
            newItems: [],
            triggers: [],
            error: (err as Error).message,
          });
        }
      }

      // Format response
      const text = formatResults(results);
      const allTriggers = results.flatMap((r) => r.triggers);

      return {
        content: [{ type: "text", text }],
        details: {
          feedResults: results.map((r) => ({
            feedId: r.feed.id,
            feedName: r.feed.name,
            newItemCount: r.newItems.length,
            error: r.error,
          })),
          triggers: allTriggers,
        },
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Response formatting
// ---------------------------------------------------------------------------

function relevanceIcon(r?: string): string {
  switch (r) {
    case "high":
      return "[HIGH]";
    case "medium":
      return "[MED]";
    default:
      return "[LOW]";
  }
}

function formatNewsItem(item: NewsItem): string {
  const icon = relevanceIcon(item.relevance);
  const link = item.url ? `\n   ${item.url}` : "";
  return `${icon} ${item.title || item.summary.slice(0, 80)}\n   ${item.summary}${link}`;
}

function formatTrigger(t: StrategyTrigger): string {
  return `Strategy "${t.stem}" triggered: ${t.reason}`;
}

function formatResults(results: FeedCheckResult[]): string {
  const parts: string[] = [];

  for (const r of results) {
    if (r.error) {
      parts.push(`${r.feed.name}: Error - ${r.error}`);
      continue;
    }
    if (r.newItems.length === 0) {
      parts.push(`${r.feed.name}: No new items.`);
      continue;
    }

    parts.push(`News Update - ${r.feed.name} (${r.newItems.length} new)\n`);
    for (const item of r.newItems) {
      parts.push(formatNewsItem(item));
    }
    for (const trigger of r.triggers) {
      parts.push(`\n${formatTrigger(trigger)}`);
    }
  }

  return parts.join("\n\n") || "No updates across all feeds.";
}
