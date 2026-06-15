---
name: keenable-web-search
description: Use Keenable web search for current, citable web results.
---

# Keenable Web Search

Use the `web_search` tool (Keenable provider) when the user needs current or
citable information from the web.

- `query`: describe the ideal page in natural language, not just keywords
  (e.g. "official changelog for the EU AI Act 2025 amendments").
- `count`: number of results, 1-10.
- `mode`: `pro` (default, higher quality) or `realtime` (fastest; use for
  latency-sensitive turns).
- `site`: restrict to one site, e.g. `arxiv.org`.
- `date_after` / `date_before`: `YYYY-MM-DD` bounds for time-sensitive topics.

Each result has a title, URL, and snippet. Snippets are starting points — open
the URL (e.g. with web fetch) before relying on a claim, and cite the source.

Keyless by default: works with no API key (rate-limited public endpoint). Set
`KEENABLE_API_KEY` to raise the limits.
