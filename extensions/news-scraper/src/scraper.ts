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

async function scrapeWithPlaywright(url: string, timeout?: number): Promise<RawItem[]> {
  const pw = await import("playwright-core");
  const browser = await pw.chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.goto(url, { waitUntil: "networkidle", timeout: timeout ?? 30_000 });
    const html = await page.content();
    return extractArticle(html, url);
  } finally {
    await browser.close();
  }
}

// ---------------------------------------------------------------------------
// X/Twitter scraping (Playwright default, optional Scrapling sidecar)
// ---------------------------------------------------------------------------

export async function scrapeX(
  url: string,
  opts?: { scraplingUrl?: string; playwrightTimeout?: number },
): Promise<RawItem[]> {
  // If Scrapling sidecar is configured, delegate to it
  if (opts?.scraplingUrl) {
    return scrapeViaScraping(url, opts.scraplingUrl);
  }

  // Default: Playwright-based X scraping
  const pw = await import("playwright-core");
  const browser = await pw.chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    // Set a realistic viewport and user agent
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(url, { waitUntil: "networkidle", timeout: opts?.playwrightTimeout ?? 30_000 });

    // Wait for tweet articles to render
    await page.waitForSelector("article", { timeout: 10_000 }).catch(() => {});

    // Extract tweets from the page
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
// Unified entry point
// ---------------------------------------------------------------------------

export async function scrapeFeed(feed: Feed, cfg: PluginCfg): Promise<RawItem[]> {
  const timeout = cfg.playwrightTimeout;

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
