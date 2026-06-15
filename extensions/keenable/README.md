# @openclaw/keenable-plugin

OpenClaw web-search provider plugin for [Keenable](https://keenable.ai).

Registers `keenable` as a web search provider, mirroring the bundled `brave` /
`duckduckgo` plugins. Returns titles, URLs, and snippets for a query, with
optional `mode` (pro/realtime), `site`, and date filters.

## Setup

**Keyless by default** — the provider works with no API key, calling Keenable's
public search endpoint (rate-limited). Just select it as your web search
provider.

To raise the rate limits, add an API key (optional):

```bash
openclaw configure --section web   # store the Keenable API key
# or set KEENABLE_API_KEY in the Gateway environment
```

Create a key at https://keenable.ai/console. With a key the provider uses the
authenticated endpoint; without one it uses the public keyless endpoint.

## Config

```jsonc
{
  "plugins": {
    "entries": {
      "keenable": {
        "config": {
          "webSearch": {
            "apiKey": "keen_...", // or KEENABLE_API_KEY env var
            "mode": "pro", // "pro" (default) | "realtime"
            "baseUrl": "https://api.keenable.ai",
          },
        },
      },
    },
  },
}
```
