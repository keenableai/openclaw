# @openclaw/keenable-plugin

OpenClaw web-search provider plugin for [Keenable](https://keenable.ai).

Registers `keenable` as a web search provider, mirroring the bundled `brave` /
`duckduckgo` plugins. Returns titles, URLs, and snippets for a query, with
optional `mode` (pro/realtime), `site`, and date filters.

## Setup

The provider calls Keenable's search API and needs an API key:

```bash
openclaw configure --section web   # store the Keenable API key
# or set KEENABLE_API_KEY in the Gateway environment
```

Create a key at https://keenable.ai/console.

## Keyless option (MCP)

Keenable's MCP endpoint has a keyless public mode (rate-limited). For zero-setup
access without an API key, add it as an MCP server instead of using this
provider:

```bash
openclaw mcp add keenable \
  --url https://api.keenable.ai/mcp \
  --transport streamable-http
```

## Config

```jsonc
{
  "plugins": {
    "entries": {
      "keenable": {
        "config": {
          "webSearch": {
            "apiKey": "keen_...",     // or KEENABLE_API_KEY env var
            "mode": "pro",            // "pro" (default) | "realtime"
            "baseUrl": "https://api.keenable.ai"
          }
        }
      }
    }
  }
}
```
