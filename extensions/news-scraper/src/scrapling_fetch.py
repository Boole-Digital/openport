#!/usr/bin/env python3
"""
Scrapling-based web fetcher for the news-scraper extension.

Usage:
  python3 scrapling_fetch.py <url> [--stealthy|--dynamic|--fast] [--selector <css>] [--timeout <ms>] [--scroll]

Output: JSON array of {title, body, url, publishedAt} to stdout.
Errors go to stderr.

Standalone test:
  python3 scrapling_fetch.py https://news.treeofalpha.com/ --dynamic --selector .contentWrapper --scroll
"""

import sys
import json
import argparse
import subprocess


def ensure_scrapling():
    """Auto-install scrapling if not present."""
    try:
        import scrapling  # noqa: F811

        return
    except ImportError:
        sys.stderr.write("scrapling not found, installing...\n")
        subprocess.check_call(
            [sys.executable, "-m", "pip", "install", "scrapling[all]", "-q"],
            stdout=subprocess.DEVNULL,
        )
        try:
            subprocess.check_call(
                [sys.executable, "-m", "playwright", "install", "chromium"],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
            )
        except Exception:
            sys.stderr.write(
                "note: playwright browser install skipped (may already exist)\n"
            )


def _first(elements):
    """Return first element from a Scrapling css() result, or None."""
    return elements[0] if elements else None


def extract_items_from_elements(elements, max_items=200):
    """Extract structured items from a list of Scrapling Selector elements."""
    items = []
    for el in elements[:max_items]:
        # Scrapling: .get_all_text() for text including children; .text is direct-only
        text = el.get_all_text(separator=" ").strip()
        if len(text) < 5:
            continue

        # Heading — try common heading selectors
        heading_el = _first(el.css("h1, h2, h3, h4, h5, h6"))
        if not heading_el:
            heading_el = _first(el.css("[class*='title']"))
        title = heading_el.get_all_text().strip() if heading_el else ""

        # Body: full text minus title
        body = text.replace(title, "", 1).strip() if title else text
        if len(body) < 20:
            body = title or text

        # Link
        link_el = _first(el.css("a[href]"))
        url = link_el.attrib.get("href", "") if link_el else ""

        # Timestamp
        time_el = _first(el.css("time")) or _first(el.css("[class*='time']")) or _first(el.css("[class*='date']"))
        published = ""
        if time_el:
            published = time_el.attrib.get("datetime", "") or time_el.get_all_text().strip()

        items.append(
            {
                "title": title[:500],
                "body": body[:3000],
                "url": url,
                "publishedAt": published,
            }
        )
    return items


def fetch_page(url, mode="dynamic", timeout_ms=30000, scroll=False):
    """Fetch a page using the appropriate Scrapling fetcher."""
    timeout = int(timeout_ms)
    if mode == "stealthy":
        from scrapling import StealthyFetcher

        page = StealthyFetcher.fetch(
            url, headless=True, network_idle=True, timeout=timeout
        )
    elif mode == "dynamic":
        from scrapling import DynamicFetcher

        page = DynamicFetcher.fetch(
            url, headless=True, network_idle=True, timeout=timeout
        )
    else:
        from scrapling import Fetcher

        page = Fetcher.get(url, timeout=timeout)

    # Scroll to load more content (only works with browser fetchers)
    if scroll and mode in ("stealthy", "dynamic"):
        try:
            page.execute_script(
                """
                async () => {
                    let prev = 0;
                    for (let i = 0; i < 15; i++) {
                        window.scrollTo(0, document.body.scrollHeight);
                        await new Promise(r => setTimeout(r, 800));
                        if (document.body.scrollHeight === prev) break;
                        prev = document.body.scrollHeight;
                    }
                }
                """
            )
        except Exception:
            pass  # scroll not supported by this fetcher

    return page


def main():
    parser = argparse.ArgumentParser(description="Scrapling web fetcher")
    parser.add_argument("url", help="URL to fetch")
    parser.add_argument(
        "--stealthy",
        action="store_true",
        help="Use StealthyFetcher (stealth HTTP, no JS rendering)",
    )
    parser.add_argument(
        "--dynamic",
        action="store_true",
        help="Use DynamicFetcher (Playwright, JS rendering)",
    )
    parser.add_argument(
        "--fast", action="store_true", help="Use Fetcher (fast HTTP only)"
    )
    parser.add_argument(
        "--selector", default=None, help="CSS selector for repeated items"
    )
    parser.add_argument("--timeout", type=int, default=30000, help="Timeout in ms")
    parser.add_argument(
        "--scroll",
        action="store_true",
        help="Scroll page to load infinite-scroll content",
    )
    args = parser.parse_args()

    ensure_scrapling()

    # Pick mode — default to dynamic (JS rendering) for most use cases
    if args.fast:
        mode = "fast"
    elif args.stealthy:
        mode = "stealthy"
    else:
        mode = "dynamic"  # default: full JS rendering via Playwright

    page = fetch_page(args.url, mode=mode, timeout_ms=args.timeout, scroll=args.scroll)

    if args.selector:
        elements = page.css(args.selector)
        items = extract_items_from_elements(elements)
    else:
        # No selector — try common news selectors, fall back to single article
        candidate_selectors = [
            ".contentWrapper",
            "[class*='contentWrapper']",
            "article",
            "[class*='news-item']",
            "[class*='feed-item']",
            "[class*='story']",
            "[class*='entry']",
            "[class*='card']",
        ]
        items = []
        for sel in candidate_selectors:
            elements = page.css(sel)
            if len(elements) >= 2:
                items = extract_items_from_elements(elements)
                if len(items) >= 2:
                    break
                items = []

        # Fall back to single article extraction
        if not items:
            title_el = _first(page.css("title"))
            title = title_el.get_all_text().strip() if title_el else ""
            body = page.get_all_text()[:5000] if hasattr(page, "get_all_text") else ""
            items = [
                {
                    "title": title,
                    "body": body,
                    "url": args.url,
                    "publishedAt": "",
                }
            ]

    json.dump(items, sys.stdout)
    sys.stdout.write("\n")
    sys.stderr.write(f"scrapling: fetched {len(items)} items from {args.url}\n")


if __name__ == "__main__":
    main()
