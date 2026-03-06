import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Feed, PluginCfg, RawItem } from "./types.js";

// ---------------------------------------------------------------------------
// Tier 1: RSS / Atom feed parsing (native fetch + inline XML parsing)
// ---------------------------------------------------------------------------

/** Extract text content from an XML tag (simple regex, no full XML parser needed). */
function xmlText(xml: string, tag: string): string {
  const re = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, "i");
  const m = xml.match(re);
  if (!m) return "";
  // Strip CDATA wrappers if present
  return (m[1] ?? "")
    .replace(/^<!\[CDATA\[/, "")
    .replace(/]]>$/, "")
    .trim();
}

/** Parse RSS 2.0 or Atom feed XML into RawItems. */
function parseRssFeed(xml: string): RawItem[] {
  const items: RawItem[] = [];

  // RSS 2.0: <item>...</item>
  const rssItems = xml.match(/<item[\s>][\s\S]*?<\/item>/gi) ?? [];
  for (const chunk of rssItems) {
    items.push({
      title: xmlText(chunk, "title"),
      body: xmlText(chunk, "description") || xmlText(chunk, "content:encoded"),
      url: xmlText(chunk, "link") || xmlText(chunk, "guid"),
      publishedAt: xmlText(chunk, "pubDate") || xmlText(chunk, "dc:date"),
    });
  }

  // Atom: <entry>...</entry>
  if (items.length === 0) {
    const entries = xml.match(/<entry[\s>][\s\S]*?<\/entry>/gi) ?? [];
    for (const chunk of entries) {
      const linkMatch = chunk.match(/<link[^>]*href=["']([^"']+)["'][^>]*\/?>/i);
      items.push({
        title: xmlText(chunk, "title"),
        body: xmlText(chunk, "summary") || xmlText(chunk, "content"),
        url: linkMatch?.[1] ?? "",
        publishedAt: xmlText(chunk, "published") || xmlText(chunk, "updated"),
      });
    }
  }

  return items;
}

export async function scrapeRss(url: string): Promise<RawItem[]> {
  const res = await fetch(url, {
    headers: {
      "User-Agent": "OpenClaw-News/1.0",
      Accept: "application/rss+xml, application/atom+xml, application/xml, text/xml",
    },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`RSS fetch failed: ${res.status} ${res.statusText}`);
  const xml = await res.text();
  return parseRssFeed(xml);
}

// ---------------------------------------------------------------------------
// Tier 2: HTTP + Readability (static HTML → article extraction)
// ---------------------------------------------------------------------------

export async function scrapeWeb(
  url: string,
  opts?: { jsRender?: boolean; playwrightTimeout?: number },
): Promise<RawItem[]> {
  if (opts?.jsRender) {
    return scrapeWithPlaywright(url, opts.playwrightTimeout);
  }

  const res = await fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0 (compatible; OpenClaw-News/1.0)" },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`HTTP fetch failed: ${res.status} ${res.statusText}`);
  const html = await res.text();
  return extractArticle(html, url);
}

/** Extract article content using @mozilla/readability + linkedom. */
async function extractArticle(html: string, url: string): Promise<RawItem[]> {
  try {
    const { parseHTML } = await import("linkedom");
    const { Readability } = await import("@mozilla/readability");
    const { document } = parseHTML(html);
    const reader = new Readability(document as unknown as Document);
    const article = reader.parse();
    if (!article) return [{ title: "", body: html.slice(0, 2000), url }];
    return [
      {
        title: article.title || "",
        body: article.textContent?.slice(0, 5000) || "",
        url,
        publishedAt: article.publishedTime || undefined,
      },
    ];
  } catch {
    // Fallback: return raw HTML snippet
    return [{ title: "", body: html.slice(0, 2000), url }];
  }
}

// ---------------------------------------------------------------------------
// Tier 3: Playwright (JS-rendered sites)
// ---------------------------------------------------------------------------

/**
 * Scroll the page incrementally to trigger lazy/infinite-scroll loading.
 * Stops when no new content appears or max iterations reached.
 */
async function scrollToBottom(
  page: import("playwright-core").Page,
  opts?: { maxIterations?: number; scrollDelayMs?: number },
): Promise<void> {
  const maxIterations = opts?.maxIterations ?? 15;
  const scrollDelay = opts?.scrollDelayMs ?? 800;
  let previousHeight = 0;
  let stableCount = 0;

  for (let i = 0; i < maxIterations; i++) {
    const currentHeight = await page.evaluate(() => document.body.scrollHeight);
    if (currentHeight === previousHeight) {
      stableCount++;
      if (stableCount >= 2) break;
    } else {
      stableCount = 0;
    }
    previousHeight = currentHeight;
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.waitForTimeout(scrollDelay);
    await page.waitForLoadState("networkidle").catch(() => {});
  }
}

type ExtractedItem = {
  index: number;
  title: string;
  body: string;
  url: string;
  publishedAt: string;
};

/** Extract items currently visible in a virtual-scroll container, keyed by data-index. */
function extractVisibleVirtualItems(selector: string) {
  return (elements: Element[]) =>
    elements.map((el) => {
      const parent = el.closest("[data-index]");
      const index = parent ? Number(parent.getAttribute("data-index")) : -1;

      const heading = el.querySelector(
        "h1, h2, h3, h4, h5, h6, [class*='title'], [class*='Title']",
      );
      const title = heading?.textContent?.trim() ?? "";

      const fullText = (el.textContent ?? "").trim();
      if (fullText.length < 5 || fullText.length > 3000) return null;
      let body = title ? fullText.replace(title, "").trim() : fullText;
      if (body.length < 20 || /^[👍👎+\-\d/,:\s\w]*$/.test(body)) {
        body = title;
      }

      const link = el.querySelector("a[href]") as HTMLAnchorElement | null;
      const url = link?.href ?? "";

      const timeEl =
        el.querySelector("time") ??
        el.querySelector("[class*='time']") ??
        el.querySelector("[class*='Time']") ??
        el.querySelector("[class*='date']");
      const publishedAt = timeEl?.getAttribute("datetime") ?? timeEl?.textContent?.trim() ?? "";

      return { index, title, body, url, publishedAt };
    });
}

/**
 * Scrape a page that uses react-virtuoso or similar virtual-scroll library.
 * Incrementally scrolls the container and collects items as they appear in the DOM.
 */
async function scrapeVirtualScroll(
  page: import("playwright-core").Page,
  baseUrl: string,
  itemSelector: string,
  maxItems = 200,
): Promise<RawItem[]> {
  const scroller = page.locator("[data-testid='virtuoso-scroller']");

  // Try selecting "All results" if the dropdown exists
  try {
    const select = page.locator(".results-select select");
    if ((await select.count()) > 0) {
      await select.selectOption({ label: "All results" });
      await page.waitForTimeout(1500);
    }
  } catch {
    // dropdown not found — fine
  }

  const collected = new Map<number, ExtractedItem>();
  let stableRounds = 0;
  const maxIterations = 60;

  for (let i = 0; i < maxIterations; i++) {
    // Extract currently visible items
    const visible = await page.$$eval(itemSelector, extractVisibleVirtualItems(itemSelector));
    const validItems = visible.filter(
      (item): item is ExtractedItem => item !== null && item.index >= 0 && item.title.length > 0,
    );

    let newCount = 0;
    for (const item of validItems) {
      if (!collected.has(item.index)) {
        collected.set(item.index, item);
        newCount++;
      }
    }

    if (collected.size >= maxItems) break;

    if (newCount === 0) {
      stableRounds++;
      if (stableRounds >= 3) break;
    } else {
      stableRounds = 0;
    }

    // Scroll the virtuoso container down
    await scroller.evaluate((el) => {
      el.scrollTop += el.clientHeight * 0.8;
    });
    await page.waitForTimeout(400);
  }

  // Convert to RawItems, sorted by index (newest first = index 0)
  const sorted = Array.from(collected.values()).sort((a, b) => a.index - b.index);
  return sorted.map((item) => ({
    title: item.title,
    body: item.body,
    url:
      item.url && item.url.startsWith("http")
        ? item.url
        : item.url
          ? `${baseUrl}${item.url}`
          : undefined,
    publishedAt: item.publishedAt || undefined,
  }));
}

async function scrapeWithPlaywright(url: string, timeout?: number): Promise<RawItem[]> {
  const pw = await import("playwright-core");
  const browser = await pw.chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.goto(url, { waitUntil: "networkidle", timeout: timeout ?? 30_000 });

    // Check for react-virtuoso virtual scroll
    const hasVirtuoso = (await page.locator("[data-testid='virtuoso-scroller']").count()) > 0;
    if (hasVirtuoso) {
      // Find the best item selector within the virtual list
      const itemSelector = await findBestItemSelector(page);
      if (itemSelector) {
        const items = await scrapeVirtualScroll(page, url, itemSelector);
        if (items.length > 1) return items;
      }
    }

    // Standard path: scroll body and extract
    await scrollToBottom(page);

    const items = await extractRenderedItems(page, url);
    if (items.length > 1) return items;

    // Fallback: Readability single-article extraction
    const html = await page.content();
    return extractArticle(html, url);
  } finally {
    await browser.close();
  }
}

/** Find the best CSS selector for repeated news items on the page. */
async function findBestItemSelector(page: import("playwright-core").Page): Promise<string | null> {
  const candidateSelectors = [
    ".contentWrapper",
    "[class*='contentWrapper']",
    "article",
    "[class*='news-item']",
    "[class*='news_item']",
    "[class*='feed-item']",
    "[class*='feed_item']",
    "[class*='story']",
    "[class*='entry']",
    "[class*='post-item']",
    "[class*='card']",
  ];

  for (const selector of candidateSelectors) {
    const count = await page.locator(selector).count();
    if (count >= 2) return selector;
  }
  return null;
}

/**
 * Extract individual news items from a JS-rendered page by finding
 * repeated structural elements in the DOM (non-virtual-scroll path).
 */
async function extractRenderedItems(
  page: import("playwright-core").Page,
  baseUrl: string,
): Promise<RawItem[]> {
  const selector = await findBestItemSelector(page);
  if (!selector) return [];

  const items = await page.$$eval(selector, (elements) =>
    elements.slice(0, 200).map((el) => {
      const heading = el.querySelector(
        "h1, h2, h3, h4, h5, h6, [class*='title'], [class*='Title']",
      );
      const title = heading?.textContent?.trim() ?? "";

      const fullText = (el.textContent ?? "").trim();
      if (fullText.length < 5 || fullText.length > 3000) return null;
      let body = title ? fullText.replace(title, "").trim() : fullText;
      if (body.length < 20 || /^[👍👎+\-\d/,:\s\w]*$/.test(body)) {
        body = title;
      }

      const link = el.querySelector("a[href]") as HTMLAnchorElement | null;
      const url = link?.href ?? "";

      const timeEl =
        el.querySelector("time") ??
        el.querySelector("[class*='time']") ??
        el.querySelector("[class*='Time']") ??
        el.querySelector("[class*='date']");
      const publishedAt = timeEl?.getAttribute("datetime") ?? timeEl?.textContent?.trim() ?? "";

      return { title, body, url, publishedAt };
    }),
  );

  const valid = items.filter(
    (item): item is { title: string; body: string; url: string; publishedAt: string } =>
      item !== null && (item.title.length > 0 || item.body.length > 0),
  );

  if (valid.length < 2) return [];

  return valid.map((item) => ({
    title: item.title,
    body: item.body,
    url:
      item.url && item.url.startsWith("http")
        ? item.url
        : item.url
          ? `${baseUrl}${item.url}`
          : undefined,
    publishedAt: item.publishedAt || undefined,
  }));
}

// ---------------------------------------------------------------------------
// X/Twitter scraping
// ---------------------------------------------------------------------------

/** Extract tweet ID from a single-tweet URL (x.com/user/status/ID). */
function extractTweetId(url: string): string | null {
  const m = url.match(/(?:x\.com|twitter\.com)\/[^/]+\/status\/(\d+)/i);
  return m?.[1] ?? null;
}

/** Extract username from an X/Twitter URL. */
function extractXUsername(url: string): string | null {
  const m = url.match(/(?:x\.com|twitter\.com)\/([^/?#]+)/i);
  const user = m?.[1];
  if (!user || user === "search" || user === "hashtag" || user === "i") return null;
  return user;
}

type FxTweetResponse = {
  code: number;
  tweet?: {
    text?: string;
    author?: { name?: string; screen_name?: string };
    created_at?: string;
    url?: string;
    media?: { all?: Array<{ type?: string; url?: string }> };
    quote?: { text?: string; author?: { name?: string; screen_name?: string }; url?: string };
    replies?: number;
    retweets?: number;
    likes?: number;
  };
};

/**
 * Fetch a single tweet via the FxTwitter API (public, no auth required).
 * Returns rich structured data including quoted tweets and engagement.
 */
async function fetchTweetViaFxTwitter(tweetId: string, username: string): Promise<RawItem[]> {
  const apiUrl = `https://api.fxtwitter.com/${username}/status/${tweetId}`;
  const res = await fetch(apiUrl, {
    headers: { "User-Agent": "OpenClaw-News/1.0" },
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) return [];

  const json = (await res.json()) as FxTweetResponse;
  const tweet = json.tweet;
  if (!tweet?.text) return [];

  const author = tweet.author?.name ?? tweet.author?.screen_name ?? username;
  const stats = [
    tweet.likes != null ? `${tweet.likes} likes` : "",
    tweet.retweets != null ? `${tweet.retweets} retweets` : "",
    tweet.replies != null ? `${tweet.replies} replies` : "",
  ]
    .filter(Boolean)
    .join(", ");

  let body = tweet.text;
  if (tweet.quote?.text) {
    const quoteAuthor = tweet.quote.author?.name ?? tweet.quote.author?.screen_name ?? "";
    body += `\n\nQuoting ${quoteAuthor}: ${tweet.quote.text}`;
  }
  if (stats) body += `\n\n${stats}`;

  const items: RawItem[] = [
    {
      title: `@${tweet.author?.screen_name ?? username} (${author})`,
      body,
      url: tweet.url ?? `https://x.com/${username}/status/${tweetId}`,
      publishedAt: tweet.created_at,
    },
  ];

  return items;
}

export async function scrapeX(
  url: string,
  opts?: { scraplingUrl?: string; playwrightTimeout?: number },
): Promise<RawItem[]> {
  // For single tweet URLs, use FxTwitter API (fast, reliable, no Playwright needed)
  const tweetId = extractTweetId(url);
  const username = extractXUsername(url);
  if (tweetId && username) {
    const items = await fetchTweetViaFxTwitter(tweetId, username).catch(() => []);
    if (items.length > 0) return items;
  }

  // If Scrapling sidecar is configured, delegate to it
  if (opts?.scraplingUrl) {
    return scrapeViaScraping(url, opts.scraplingUrl);
  }

  // Fallback: Playwright-based X scraping (for search/profile pages)
  const pw = await import("playwright-core");
  const browser = await pw.chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(url, { waitUntil: "networkidle", timeout: opts?.playwrightTimeout ?? 30_000 });

    await page.waitForSelector("article", { timeout: 10_000 }).catch(() => {});

    const items = await page.$$eval("article", (articles) =>
      articles.slice(0, 30).map((el) => {
        const tweetText = el.querySelector("[data-testid='tweetText']")?.textContent ?? "";
        const userName = el.querySelector("[data-testid='User-Name']")?.textContent ?? "";
        const timeEl = el.querySelector("time");
        const tweetLink = el.querySelector("a[href*='/status/']") as HTMLAnchorElement | null;
        return {
          title: userName,
          body: tweetText,
          url: tweetLink?.href ?? "",
          publishedAt: timeEl?.getAttribute("datetime") ?? "",
        };
      }),
    );
    return items;
  } finally {
    await browser.close();
  }
}

// ---------------------------------------------------------------------------
// Scrapling MCP sidecar (optional, for stealth anti-bot scraping)
// ---------------------------------------------------------------------------

/** Call the Scrapling MCP HTTP server's stealthy_fetch tool. */
async function scrapeViaScraping(url: string, scraplingUrl: string): Promise<RawItem[]> {
  // Scrapling MCP uses JSON-RPC over HTTP (MCP protocol)
  const rpcBody = {
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: {
      name: "stealthy_fetch",
      arguments: { url, headless: true, disable_resources: true },
    },
  };

  const res = await fetch(scraplingUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(rpcBody),
    signal: AbortSignal.timeout(60_000),
  });

  if (!res.ok) throw new Error(`Scrapling sidecar error: ${res.status}`);

  const json = (await res.json()) as { result?: { content?: Array<{ text?: string }> } };
  const html = json.result?.content?.[0]?.text ?? "";
  if (!html) return [];

  return extractArticle(html, url);
}

// ---------------------------------------------------------------------------
// Telegram public channel scraping (static HTML via t.me/s/ web preview)
// ---------------------------------------------------------------------------

/** Normalize a Telegram URL to the /s/ web preview form. */
function normalizeTelegramUrl(url: string): string {
  const u = new URL(url.startsWith("http") ? url : `https://${url}`);
  const parts = u.pathname.replace(/^\/+/, "").split("/").filter(Boolean);
  // Already /s/channel → keep it; otherwise prepend /s/
  if (parts[0] === "s" && parts.length >= 2) {
    return `https://t.me/s/${parts.slice(1).join("/")}`;
  }
  return `https://t.me/s/${parts.join("/")}`;
}

export async function scrapeTelegram(url: string): Promise<RawItem[]> {
  const normalizedUrl = normalizeTelegramUrl(url);
  const res = await fetch(normalizedUrl, {
    headers: { "User-Agent": "Mozilla/5.0 (compatible; OpenClaw-News/1.0)" },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`Telegram fetch failed: ${res.status} ${res.statusText}`);
  const html = await res.text();
  return extractTelegramMessages(html);
}

/** Parse Telegram channel web preview HTML into RawItems using linkedom. */
async function extractTelegramMessages(html: string): Promise<RawItem[]> {
  const { parseHTML } = await import("linkedom");
  const { document } = parseHTML(html);

  // Channel name from the sidebar header
  const channelName =
    document
      .querySelector(".tgme_channel_info_header_title span[dir='auto']")
      ?.textContent?.trim() ?? "";

  const messageEls = document.querySelectorAll(".tgme_widget_message");
  const items: RawItem[] = [];

  for (const msg of messageEls) {
    const body = msg.querySelector(".tgme_widget_message_text")?.textContent?.trim() ?? "";
    if (!body) continue; // skip media-only messages

    const dateLink = msg.querySelector("a.tgme_widget_message_date");
    const href = dateLink?.getAttribute("href") ?? "";
    const permalink = href.startsWith("http") ? href : href ? `https://t.me${href}` : undefined;

    const timeEl = msg.querySelector("time.time");
    const publishedAt = timeEl?.getAttribute("datetime") ?? undefined;

    items.push({ title: channelName, body, url: permalink, publishedAt });
  }

  return items;
}

// ---------------------------------------------------------------------------
// Scrapling (Python child_process, optional alternative backend)
// ---------------------------------------------------------------------------

/** Resolve the path to the bundled scrapling_fetch.py script. */
function scraplingScriptPath(): string {
  const currentDir = path.dirname(fileURLToPath(import.meta.url));
  return path.join(currentDir, "scrapling_fetch.py");
}

/**
 * Scrape a URL using the Python Scrapling library via child_process.
 * Requires python3 on PATH; auto-installs scrapling pip package if missing.
 */
async function scrapeWithScrapling(
  url: string,
  opts?: { selector?: string; timeout?: number },
): Promise<RawItem[]> {
  const scriptPath = scraplingScriptPath();
  const args = [scriptPath, url, "--dynamic", "--scroll"];

  if (opts?.selector) {
    args.push("--selector", opts.selector);
  }
  if (opts?.timeout) {
    args.push("--timeout", String(opts.timeout));
  }

  // First run creates a venv + pip installs ~200MB of deps — allow up to 5 minutes
  const venvExists = await import("node:fs").then((fs) =>
    fs.existsSync(path.join(path.dirname(scriptPath), ".scrapling-venv", "bin", "python3")),
  );
  const processTimeout = venvExists ? (opts?.timeout ?? 30_000) + 30_000 : 300_000;

  return new Promise<RawItem[]>((resolve, reject) => {
    const child = spawn("python3", args, {
      stdio: ["ignore", "pipe", "pipe"],
      timeout: processTimeout,
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    child.on("error", (err) => {
      reject(new Error(`Scrapling process failed to start: ${err.message}`));
    });

    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`Scrapling exited with code ${code}: ${stderr.slice(0, 500)}`));
        return;
      }
      try {
        const items = JSON.parse(stdout) as Array<{
          title: string;
          body: string;
          url: string;
          publishedAt: string;
        }>;
        resolve(
          items.map((item) => ({
            title: item.title ?? "",
            body: item.body ?? "",
            url: item.url || undefined,
            publishedAt: item.publishedAt || undefined,
          })),
        );
      } catch (err) {
        reject(new Error(`Failed to parse Scrapling output: ${(err as Error).message}`));
      }
    });
  });
}

// ---------------------------------------------------------------------------
// Unified entry point
// ---------------------------------------------------------------------------

export async function scrapeFeed(feed: Feed, cfg: PluginCfg): Promise<RawItem[]> {
  const timeout = cfg.playwrightTimeout;

  // If feed opts into Scrapling, use Python backend
  if (feed.useScrapling && feed.type === "web") {
    return scrapeWithScrapling(feed.url, {
      selector: feed.scraplingSelector,
      timeout,
    });
  }

  switch (feed.type) {
    case "rss":
      return scrapeRss(feed.url);
    case "web":
      return scrapeWeb(feed.url, { jsRender: feed.jsRender, playwrightTimeout: timeout });
    case "x-search":
      return scrapeX(feed.url, { scraplingUrl: cfg.scraplingUrl, playwrightTimeout: timeout });
    case "telegram":
      return scrapeTelegram(feed.url);
    default:
      throw new Error(`Unknown feed type: ${feed.type}`);
  }
}
