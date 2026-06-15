import { isDiagnosticFlagEnabled } from "openclaw/plugin-sdk/diagnostic-runtime";
import type {
  SearchConfigRecord,
  WebSearchProviderPlugin,
  WebSearchProviderToolDefinition,
} from "openclaw/plugin-sdk/provider-web-search";
import {
  mergeScopedSearchConfig,
  resolveProviderWebSearchPluginConfig,
} from "openclaw/plugin-sdk/provider-web-search-config-contract";
import { buildKeenableWebSearchProviderBase } from "../web-search-shared.js";

type KeenableWebSearchRuntime = typeof import("./keenable-web-search-provider.runtime.js");

let keenableWebSearchRuntimePromise: Promise<KeenableWebSearchRuntime> | undefined;

function loadKeenableWebSearchRuntime(): Promise<KeenableWebSearchRuntime> {
  keenableWebSearchRuntimePromise ??= import("./keenable-web-search-provider.runtime.js");
  return keenableWebSearchRuntimePromise;
}

const KeenableSearchSchema = {
  type: "object",
  properties: {
    query: {
      type: "string",
      description: "Natural-language description of the ideal page, not just keywords.",
    },
    count: {
      type: "integer",
      description: "Number of results to return (1-10).",
      minimum: 1,
      maximum: 10,
    },
    mode: {
      type: "string",
      description: "'pro' (default, higher quality) or 'realtime' (fastest).",
      enum: ["pro", "realtime"],
    },
    site: {
      type: "string",
      description: "Restrict results to a single site, e.g. 'techcrunch.com'.",
    },
    date_after: {
      type: "string",
      description: "Only results published after this date (YYYY-MM-DD).",
    },
    date_before: {
      type: "string",
      description: "Only results published before this date (YYYY-MM-DD).",
    },
  },
} satisfies Record<string, unknown>;

function createKeenableToolDefinition(
  searchConfig?: SearchConfigRecord,
  config?: Parameters<typeof isDiagnosticFlagEnabled>[1],
): WebSearchProviderToolDefinition {
  const diagnosticsEnabled = isDiagnosticFlagEnabled("keenable.http", config);

  return {
    description:
      "Search the web using Keenable's AI search. Returns titles, URLs, and snippets. " +
      "Supports site and date filters; 'pro' mode for quality, 'realtime' for speed.",
    parameters: KeenableSearchSchema,
    execute: async (args) => {
      const { executeKeenableSearch } = await loadKeenableWebSearchRuntime();
      return await executeKeenableSearch(args, searchConfig, { diagnosticsEnabled });
    },
  };
}

export function createKeenableWebSearchProvider(): WebSearchProviderPlugin {
  return {
    ...buildKeenableWebSearchProviderBase(),
    createTool: (ctx) =>
      createKeenableToolDefinition(
        mergeScopedSearchConfig(
          ctx.searchConfig,
          "keenable",
          resolveProviderWebSearchPluginConfig(ctx.config, "keenable"),
          { mirrorApiKeyToTopLevel: true },
        ),
        ctx.config,
      ),
  };
}
