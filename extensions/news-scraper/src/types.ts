/** Supported feed source types. */
export type FeedType = "rss" | "web" | "x-search" | "telegram";

/** Relevance classification assigned by the LLM summarizer. */
export type Relevance = "high" | "medium" | "low";

/** User-configured news feed. */
export type Feed = {
  id: string;
  name: string;
  type: FeedType;
  url: string;
  /** Only surface items matching at least one keyword (case-insensitive). Empty = no filter. */
  keywords?: string[];
  // Cron expression for scheduled checks (default: every 2 hours).
  schedule?: string;
  /** If true, use Playwright for JS rendering (applies to type "web"). */
  jsRender?: boolean;
  /** Optional strategy stem to trigger on high-relevance news. */
  strategy?: string;
  /** Optional prompt guiding the LLM's strategy trigger decision. */
  strategyPrompt?: string;
  enabled: boolean;
};

/** Raw scraped item before LLM processing. */
export type RawItem = {
  title: string;
  body: string;
  url?: string;
  publishedAt?: string;
};

/** Processed news item after LLM summarization. */
export type NewsItem = {
  id: string;
  title: string;
  summary: string;
  url?: string;
  source: string;
  publishedAt?: string;
  relevance?: Relevance;
};

/** Strategy trigger emitted when a high-relevance item matches a feed's strategy config. */
export type StrategyTrigger = {
  stem: string;
  reason: string;
  item: NewsItem;
};

/** Persistent state for a single feed — tracks what we've already seen. */
export type FeedState = {
  feedId: string;
  lastCheckedAt: number;
  /** Rolling window of content hashes (capped at MAX_SEEN_HASHES). */
  seenHashes: string[];
};

/** Top-level feeds config file shape. */
export type FeedsFile = {
  version: 1;
  feeds: Feed[];
};

/** Plugin config from openclaw.plugin.json configSchema. */
export type PluginCfg = {
  openrouterApiKey?: string;
  openrouterModel?: string;
  scraplingUrl?: string;
  maxItemsPerFeed?: number;
  playwrightTimeout?: number;
};

/** Result from a single feed check. */
export type FeedCheckResult = {
  feed: Feed;
  newItems: NewsItem[];
  triggers: StrategyTrigger[];
  error?: string;
};
