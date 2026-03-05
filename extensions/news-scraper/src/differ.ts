import { createHash } from "node:crypto";
import type { RawItem } from "./types.js";

/** Maximum number of content hashes to retain in the rolling window. */
export const MAX_SEEN_HASHES = 500;

/** Compute a short content hash for deduplication. */
export function hashItem(item: RawItem): string {
  const input = (item.title || "") + (item.url || "");
  return createHash("sha256").update(input).digest("hex").slice(0, 16);
}

/**
 * Filter out items already seen in a previous scrape cycle.
 * Returns only new items and the updated set of seen hashes.
 */
export function diffItems(
  items: RawItem[],
  seenHashes: string[],
): { newItems: RawItem[]; updatedHashes: string[] } {
  const seen = new Set(seenHashes);
  const newItems: RawItem[] = [];
  const freshHashes: string[] = [];

  for (const item of items) {
    const h = hashItem(item);
    if (!seen.has(h)) {
      newItems.push(item);
      freshHashes.push(h);
      seen.add(h);
    }
  }

  // Keep a rolling window: newest hashes at the end, drop oldest if over cap
  const merged = [...seenHashes, ...freshHashes];
  const updatedHashes = merged.length > MAX_SEEN_HASHES ? merged.slice(-MAX_SEEN_HASHES) : merged;

  return { newItems, updatedHashes };
}
