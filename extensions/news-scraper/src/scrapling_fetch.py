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
import os
import json
import argparse
import subprocess


VENV_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), ".scrapling-venv")


def ensure_scrapling():
    """Auto-install scrapling into a local venv if not present."""
    try:
        import scrapling  # noqa: F811

        return
    except ImportError:
        pass

    # If we're already running inside our venv, pip install directly
    if sys.prefix == VENV_DIR:
        sys.stderr.write("scrapling not found in venv, installing...\n")
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
            pass
        return

    # Create venv and re-exec inside it
    venv_python = os.path.join(VENV_DIR, "bin", "python3")
    if not os.path.exists(venv_python):
        sys.stderr.write(f"creating scrapling venv at {VENV_DIR}...\n")
        subprocess.check_call([sys.executable, "-m", "venv", VENV_DIR])
        sys.stderr.write("installing scrapling (first run, may take a minute)...\n")
        subprocess.check_call(
            [venv_python, "-m", "pip", "install", "scrapling[all]", "-q"],
            stdout=subprocess.DEVNULL,
        )
        try:
            subprocess.check_call(
                [venv_python, "-m", "playwright", "install", "chromium"],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
            )
        except Exception:
            pass

    # Re-exec this script with the venv python
    os.execv(venv_python, [venv_python] + sys.argv)


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
            # First try scrolling a virtuoso container (react-virtuoso virtual scroll)
            page.execute_script(
                """
                async () => {
                    const vs = document.querySelector('[data-testid="virtuoso-scroller"]');
                    if (vs) {
                        for (let i = 0; i < 15; i++) {
                            vs.scrollTop += vs.clientHeight * 0.8;
                            await new Promise(r => setTimeout(r, 500));
                        }
                        return;
                    }
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


def collect_virtual_scroll_items(page, item_selector, max_items=50):
    """
    Collect items from a react-virtuoso virtual scroll container.
    Scrolls incrementally and gathers items by data-index to deduplicate.
    """
    collected = {}  # data-index -> item dict

    for iteration in range(40):
        elements = page.css(item_selector)
        new_count = 0
        for el in elements:
            parent = el
            # Walk up to find [data-index]
            idx = -1
            try:
                # Try getting the parent with data-index via CSS from the page
                # Scrapling elements don't have .parent easily, so extract from the element's context
                idx_attr = el.attrib.get("data-index", "")
                if not idx_attr:
                    # The data-index is on a wrapper div above .contentWrapper
                    # Use the element's text as a dedup key instead
                    text = el.get_all_text(separator=" ").strip()
                    idx = hash(text[:200])
            except Exception:
                continue

            if idx_attr:
                idx = int(idx_attr)

            if idx in collected:
                continue

            text = el.get_all_text(separator=" ").strip()
            if len(text) < 5:
                continue

            heading_el = _first(el.css("h1, h2, h3, h4, h5, h6"))
            if not heading_el:
                heading_el = _first(el.css("[class*='title']"))
            title = heading_el.get_all_text().strip() if heading_el else ""

            body = text.replace(title, "", 1).strip() if title else text
            if len(body) < 20:
                body = title or text

            link_el = _first(el.css("a[href]"))
            url = link_el.attrib.get("href", "") if link_el else ""

            time_el = _first(el.css("time")) or _first(el.css("[class*='time']")) or _first(el.css("[class*='date']"))
            published = ""
            if time_el:
                published = time_el.attrib.get("datetime", "") or time_el.get_all_text().strip()

            collected[idx] = {
                "title": title[:500],
                "body": body[:3000],
                "url": url,
                "publishedAt": published,
            }
            new_count += 1

        if len(collected) >= max_items:
            break

        if new_count == 0 and iteration > 2:
            break

        # Scroll the virtuoso container
        try:
            page.execute_script(
                """
                async () => {
                    const vs = document.querySelector('[data-testid="virtuoso-scroller"]');
                    if (vs) {
                        vs.scrollTop += vs.clientHeight * 0.8;
                        await new Promise(r => setTimeout(r, 400));
                    }
                }
                """
            )
        except Exception:
            break

    return list(collected.values())[:max_items]


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

    # Check for react-virtuoso virtual scroll — needs incremental collection
    has_virtuoso = len(page.css('[data-testid="virtuoso-scroller"]')) > 0

    if has_virtuoso and mode in ("stealthy", "dynamic"):
        # Find the best item selector
        item_selector = args.selector
        if not item_selector:
            for sel in [".contentWrapper", "[class*='contentWrapper']", "article", "[class*='card']"]:
                if len(page.css(sel)) >= 2:
                    item_selector = sel
                    break
        if item_selector:
            items = collect_virtual_scroll_items(page, item_selector)
            if items:
                json.dump(items, sys.stdout)
                sys.stdout.write("\n")
                sys.stderr.write(f"scrapling: fetched {len(items)} items (virtual scroll) from {args.url}\n")
                return

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
