import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { Feed, FeedState, FeedsFile } from "./types.js";

const NEWS_DIR = join(homedir(), ".openclaw", "news");
const FEEDS_PATH = join(NEWS_DIR, "feeds.json");
const STATE_DIR = join(NEWS_DIR, "state");

// --- Feeds CRUD ---

export async function loadFeeds(): Promise<Feed[]> {
  try {
    const raw = await readFile(FEEDS_PATH, "utf8");
    const data = JSON.parse(raw) as FeedsFile;
    return data.feeds ?? [];
  } catch {
    return [];
  }
}

async function writeFeeds(feeds: Feed[]): Promise<void> {
  const data: FeedsFile = { version: 1, feeds };
  await mkdir(dirname(FEEDS_PATH), { recursive: true });
  await writeFile(FEEDS_PATH, JSON.stringify(data, null, 2), "utf8");
}

export async function saveFeed(feed: Feed): Promise<void> {
  const feeds = await loadFeeds();
  const idx = feeds.findIndex((f) => f.id === feed.id);
  if (idx >= 0) {
    feeds[idx] = feed;
  } else {
    feeds.push(feed);
  }
  await writeFeeds(feeds);
}

export async function removeFeed(feedId: string): Promise<boolean> {
  const feeds = await loadFeeds();
  const filtered = feeds.filter((f) => f.id !== feedId);
  if (filtered.length === feeds.length) return false;
  await writeFeeds(filtered);
  return true;
}

export async function getFeed(feedId: string): Promise<Feed | undefined> {
  const feeds = await loadFeeds();
  return feeds.find((f) => f.id === feedId);
}

// --- Feed State (per-feed seen-hashes + last-checked) ---

function statePath(feedId: string): string {
  return join(STATE_DIR, `${feedId}.json`);
}

export async function loadFeedState(feedId: string): Promise<FeedState> {
  try {
    const raw = await readFile(statePath(feedId), "utf8");
    return JSON.parse(raw) as FeedState;
  } catch {
    return { feedId, lastCheckedAt: 0, seenHashes: [] };
  }
}

export async function saveFeedState(state: FeedState): Promise<void> {
  const p = statePath(state.feedId);
  await mkdir(dirname(p), { recursive: true });
  await writeFile(p, JSON.stringify(state), "utf8");
}
