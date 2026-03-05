import { hashItem } from "./differ.js";
import type { Feed, NewsItem, PluginCfg, RawItem, StrategyTrigger } from "./types.js";

const DEFAULT_MODEL = "meta-llama/llama-3.3-70b-instruct:free";
const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";

/** Max items per LLM batch call to keep token usage low. */
const BATCH_SIZE = 10;

type SummarizeResult = {
  items: NewsItem[];
  triggers: StrategyTrigger[];
};

/**
 * Summarize and classify raw scraped items using a cheap LLM.
 *
 * Priority: OpenRouter free model → user's configured model (via llm-task fallback) → raw truncation.
 */
export async function summarizeItems(
  rawItems: RawItem[],
  feed: Feed,
  cfg: PluginCfg,
): Promise<SummarizeResult> {
  if (rawItems.length === 0) return { items: [], triggers: [] };

  const allItems: NewsItem[] = [];
  const allTriggers: StrategyTrigger[] = [];

  // Process in batches to stay within token limits
  for (let i = 0; i < rawItems.length; i += BATCH_SIZE) {
    const batch = rawItems.slice(i, i + BATCH_SIZE);
    const result = cfg.openrouterApiKey
      ? await summarizeBatchViaOpenRouter(batch, feed, cfg)
      : summarizeBatchRaw(batch, feed);
    allItems.push(...result.items);
    allTriggers.push(...result.triggers);
  }

  return { items: allItems, triggers: allTriggers };
}

// ---------------------------------------------------------------------------
// OpenRouter-powered summarization (primary path)
// ---------------------------------------------------------------------------

async function summarizeBatchViaOpenRouter(
  batch: RawItem[],
  feed: Feed,
  cfg: PluginCfg,
): Promise<SummarizeResult> {
  const model = cfg.openrouterModel || DEFAULT_MODEL;
  const keywordsClause = feed.keywords?.length
    ? `\nRelevance keywords: ${feed.keywords.join(", ")}. Items matching these keywords should be rated higher.`
    : "";
  const strategyClause = feed.strategy
    ? `\nStrategy trigger: if any item is "high" relevance, include "trigger": true for that item. Strategy: "${feed.strategy}". ${feed.strategyPrompt ?? ""}`
    : "";

  const itemsJson = batch.map((item, idx) => ({
    idx,
    title: item.title.slice(0, 200),
    body: item.body.slice(0, 800),
    url: item.url,
  }));

  const prompt = `You are a news classifier and summarizer. For each item, output JSON with:
- "idx": the item index
- "relevance": "high", "medium", or "low"
- "summary": 1-2 sentence summary
- "trigger": boolean (only if strategy trigger is requested)
${keywordsClause}${strategyClause}

Return a JSON array. No markdown fences, no commentary.

Items:
${JSON.stringify(itemsJson)}`;

  try {
    const res = await fetch(OPENROUTER_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${cfg.openrouterApiKey}`,
        "Content-Type": "application/json",
        "HTTP-Referer": "https://openclaw.ai",
        "X-OpenRouter-Title": "OpenClaw News Scraper",
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: "You are a JSON-only function. Return ONLY valid JSON." },
          { role: "user", content: prompt },
        ],
        temperature: 0.1,
        max_tokens: 2000,
      }),
      signal: AbortSignal.timeout(30_000),
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      throw new Error(`OpenRouter ${res.status}: ${errText.slice(0, 200)}`);
    }

    const json = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const text = json.choices?.[0]?.message?.content ?? "";
    return parseLlmResponse(text, batch, feed);
  } catch (err) {
    // Fallback to raw summarization on LLM failure
    console.error(`[news-scraper] OpenRouter error: ${(err as Error).message}`);
    return summarizeBatchRaw(batch, feed);
  }
}

// ---------------------------------------------------------------------------
// Parse LLM JSON response into NewsItems + StrategyTriggers
// ---------------------------------------------------------------------------

type LlmItem = {
  idx: number;
  relevance?: string;
  summary?: string;
  trigger?: boolean;
};

function parseLlmResponse(text: string, batch: RawItem[], feed: Feed): SummarizeResult {
  const items: NewsItem[] = [];
  const triggers: StrategyTrigger[] = [];

  let parsed: LlmItem[];
  try {
    // Strip markdown fences if present
    const clean = text
      .trim()
      .replace(/^```(?:json)?\s*/i, "")
      .replace(/\s*```$/i, "");
    parsed = JSON.parse(clean) as LlmItem[];
    if (!Array.isArray(parsed)) parsed = [];
  } catch {
    // If parsing fails, fall back to raw
    return summarizeBatchRaw(batch, feed);
  }

  for (const llmItem of parsed) {
    const raw = batch[llmItem.idx];
    if (!raw) continue;

    const relevance = (
      ["high", "medium", "low"].includes(llmItem.relevance ?? "") ? llmItem.relevance : "low"
    ) as "high" | "medium" | "low";

    const newsItem: NewsItem = {
      id: hashItem(raw),
      title: raw.title,
      summary: llmItem.summary || raw.body.slice(0, 200),
      url: raw.url,
      source: feed.name,
      publishedAt: raw.publishedAt,
      relevance,
    };
    items.push(newsItem);

    if (llmItem.trigger && feed.strategy) {
      triggers.push({
        stem: feed.strategy,
        reason: llmItem.summary || raw.title,
        item: newsItem,
      });
    }
  }

  return { items, triggers };
}

// ---------------------------------------------------------------------------
// Raw fallback: no LLM, just truncate body as summary
// ---------------------------------------------------------------------------

function summarizeBatchRaw(batch: RawItem[], feed: Feed): SummarizeResult {
  const items: NewsItem[] = [];
  const triggers: StrategyTrigger[] = [];

  for (const raw of batch) {
    const matchesKeyword =
      !feed.keywords?.length ||
      feed.keywords.some(
        (kw) =>
          raw.title.toLowerCase().includes(kw.toLowerCase()) ||
          raw.body.toLowerCase().includes(kw.toLowerCase()),
      );

    const newsItem: NewsItem = {
      id: hashItem(raw),
      title: raw.title,
      summary: raw.body.slice(0, 300),
      url: raw.url,
      source: feed.name,
      publishedAt: raw.publishedAt,
      relevance: matchesKeyword ? "medium" : "low",
    };
    items.push(newsItem);

    // Raw mode: trigger on keyword match as a simple heuristic
    if (matchesKeyword && feed.strategy) {
      triggers.push({ stem: feed.strategy, reason: raw.title, item: newsItem });
    }
  }

  return { items, triggers };
}
