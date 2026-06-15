import {
  assertOkOrThrowProviderError,
  readProviderJsonResponse,
} from "openclaw/plugin-sdk/provider-http";
import type { SearchConfigRecord } from "openclaw/plugin-sdk/provider-web-search";
import {
  buildSearchCacheKey,
  DEFAULT_SEARCH_COUNT,
  formatCliCommand,
  MAX_SEARCH_COUNT,
  readCachedSearchPayload,
  readConfiguredSecretString,
  readPositiveIntegerParam,
  readProviderEnvValue,
  readStringParam,
  resolveSearchCacheTtlMs,
  resolveSearchCount,
  resolveSearchTimeoutSeconds,
  resolveSiteName,
  withSelfHostedWebSearchEndpoint,
  withTrustedWebSearchEndpoint,
  wrapWebContent,
  writeCachedSearchPayload,
} from "openclaw/plugin-sdk/provider-web-search";
import { createSubsystemLogger } from "openclaw/plugin-sdk/runtime-env";
import {
  assertHttpUrlTargetsPrivateNetwork,
  isBlockedHostnameOrIp,
  isPrivateIpAddress,
  resolvePinnedHostnameWithPolicy,
} from "openclaw/plugin-sdk/ssrf-runtime";

const DEFAULT_KEENABLE_BASE_URL = "https://api.keenable.ai";
const KEENABLE_SEARCH_ENDPOINT_PATH = "/v1/search";
const keenableHttpLogger = createSubsystemLogger("keenable/http");
type KeenableEndpointMode = "selfHosted" | "strict";

type KeenableSearchResultDto = {
  title?: string;
  url?: string;
  description?: string;
  snippet?: string;
};

type KeenableSearchResponse = {
  query?: string;
  mode?: string;
  results?: KeenableSearchResultDto[];
};

type KeenableHttpDiagnostics = { enabled?: boolean };

function logKeenableHttp(
  diagnostics: KeenableHttpDiagnostics | undefined,
  event: string,
  meta?: Record<string, unknown>,
): void {
  if (!diagnostics?.enabled) {
    return;
  }
  keenableHttpLogger.info(`keenable http ${event}`, meta);
}

function resolveKeenableApiKey(searchConfig?: SearchConfigRecord): string | undefined {
  return (
    readConfiguredSecretString(searchConfig?.apiKey, "tools.web.search.apiKey") ??
    readProviderEnvValue(["KEENABLE_API_KEY"])
  );
}

type KeenableConfig = {
  baseUrl?: unknown;
  mode?: unknown;
};

// Scoped provider config lives under `searchConfig.keenable` (mergeScopedSearchConfig
// nests it there); only the apiKey is mirrored to the top level.
function resolveKeenableConfig(searchConfig?: SearchConfigRecord): KeenableConfig {
  const keenable = searchConfig?.keenable;
  return keenable && typeof keenable === "object" && !Array.isArray(keenable)
    ? (keenable as KeenableConfig)
    : {};
}

function resolveKeenableBaseUrl(keenableConfig: KeenableConfig): string {
  const configured = readConfiguredSecretString(
    keenableConfig.baseUrl,
    "plugins.entries.keenable.config.webSearch.baseUrl",
  );
  return configured?.replace(/\/+$/u, "") || DEFAULT_KEENABLE_BASE_URL;
}

function resolveKeenableMode(keenableConfig: KeenableConfig): "pro" | "realtime" {
  return keenableConfig.mode === "realtime" ? "realtime" : "pro";
}

function buildKeenableEndpointUrl(baseUrl: string): URL {
  const url = new URL(baseUrl);
  const basePath = url.pathname.replace(/\/+$/u, "");
  url.pathname = `${basePath}${KEENABLE_SEARCH_ENDPOINT_PATH}`;
  url.search = "";
  return url;
}

async function keenableEndpointTargetsPrivateNetwork(url: URL): Promise<boolean> {
  if (isBlockedHostnameOrIp(url.hostname)) {
    return true;
  }
  try {
    const pinned = await resolvePinnedHostnameWithPolicy(url.hostname, {
      policy: { allowPrivateNetwork: true, allowRfc2544BenchmarkRange: true },
    });
    return pinned.addresses.every((address) => isPrivateIpAddress(address));
  } catch {
    return false;
  }
}

async function validateKeenableBaseUrl(baseUrl: string): Promise<KeenableEndpointMode> {
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    throw new Error("Keenable base URL must be a valid http:// or https:// URL.");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("Keenable base URL must use http:// or https://.");
  }
  if (parsed.protocol === "http:") {
    await assertHttpUrlTargetsPrivateNetwork(parsed.toString(), {
      dangerouslyAllowPrivateNetwork: true,
      errorMessage:
        "Keenable HTTP base URL must target a trusted private or loopback host. Use https:// for public hosts.",
    });
    return "selfHosted";
  }
  return (await keenableEndpointTargetsPrivateNetwork(parsed)) ? "selfHosted" : "strict";
}

function missingKeenableKeyPayload() {
  return {
    error: "missing_keenable_api_key",
    message: `web_search (keenable) needs a Keenable API key. Run \`${formatCliCommand("openclaw configure --section web")}\` to store it, or set KEENABLE_API_KEY in the Gateway environment. Keyless access is available via the Keenable MCP server (\`openclaw mcp add keenable --url https://api.keenable.ai/mcp --transport streamable-http\`).`,
    docs: "https://docs.openclaw.ai/tools/web",
  };
}

async function runKeenableWebSearch(params: {
  baseUrl: string;
  endpointMode: KeenableEndpointMode;
  query: string;
  count: number;
  mode: "pro" | "realtime";
  apiKey: string;
  timeoutSeconds: number;
  diagnostics?: KeenableHttpDiagnostics;
  site?: string;
  dateAfter?: string;
  dateBefore?: string;
}): Promise<Array<Record<string, unknown>>> {
  const url = buildKeenableEndpointUrl(params.baseUrl);
  url.searchParams.set("query", params.query);
  url.searchParams.set("mode", params.mode);
  if (params.site) {
    url.searchParams.set("site", params.site);
  }
  if (params.dateAfter) {
    url.searchParams.set("published_after", params.dateAfter);
  }
  if (params.dateBefore) {
    url.searchParams.set("published_before", params.dateBefore);
  }

  logKeenableHttp(params.diagnostics, "request", {
    mode: params.mode,
    url: url.toString(),
  });
  const startedAt = Date.now();
  const withEndpoint =
    params.endpointMode === "selfHosted"
      ? withSelfHostedWebSearchEndpoint
      : withTrustedWebSearchEndpoint;

  const data = await withEndpoint(
    {
      url: url.toString(),
      timeoutSeconds: params.timeoutSeconds,
      init: {
        method: "GET",
        headers: {
          Accept: "application/json",
          "X-API-Key": params.apiKey,
        },
      },
    },
    async (response) => {
      logKeenableHttp(params.diagnostics, "response", {
        status: response.status,
        ok: response.ok,
        durationMs: Date.now() - startedAt,
      });
      await assertOkOrThrowProviderError(response, "Keenable Search API error");
      return readProviderJsonResponse<KeenableSearchResponse>(response, "Keenable Search API error");
    },
  );

  const results = Array.isArray(data.results) ? data.results : [];
  return results.slice(0, params.count).map((entry) => {
    const title = entry.title ?? "";
    const url = entry.url ?? "";
    const description = entry.snippet || entry.description || "";
    return {
      title: title ? wrapWebContent(title, "web_search") : "",
      url,
      description: description ? wrapWebContent(description, "web_search") : "",
      siteName: resolveSiteName(url) || undefined,
    };
  });
}

export async function executeKeenableSearch(
  args: Record<string, unknown>,
  searchConfig?: SearchConfigRecord,
  options?: { diagnosticsEnabled?: boolean },
): Promise<Record<string, unknown>> {
  const apiKey = resolveKeenableApiKey(searchConfig);
  if (!apiKey) {
    return missingKeenableKeyPayload();
  }

  const keenableConfig = resolveKeenableConfig(searchConfig);
  const baseUrl = resolveKeenableBaseUrl(keenableConfig);
  const endpointMode = await validateKeenableBaseUrl(baseUrl);
  const mode = resolveKeenableMode(keenableConfig);
  const query = readStringParam(args, "query", { required: true });
  const count =
    readPositiveIntegerParam(args, "count", {
      max: MAX_SEARCH_COUNT,
      message: `count must be an integer from 1 to ${MAX_SEARCH_COUNT}.`,
    }) ??
    searchConfig?.maxResults ??
    undefined;
  const site = readStringParam(args, "site");

  // Keenable filters by publication date (not a freshness bucket), so validate
  // YYYY-MM-DD bounds locally rather than via the brave/perplexity-only helper.
  const dateRe = /^\d{4}-\d{2}-\d{2}$/u;
  const dateAfter = readStringParam(args, "date_after");
  const dateBefore = readStringParam(args, "date_before");
  if (dateAfter && !dateRe.test(dateAfter)) {
    return {
      error: "invalid_date_after",
      message: "date_after must be YYYY-MM-DD format.",
      docs: "https://docs.openclaw.ai/tools/web",
    };
  }
  if (dateBefore && !dateRe.test(dateBefore)) {
    return {
      error: "invalid_date_before",
      message: "date_before must be YYYY-MM-DD format.",
      docs: "https://docs.openclaw.ai/tools/web",
    };
  }
  if (dateAfter && dateBefore && dateAfter > dateBefore) {
    return {
      error: "invalid_date_range",
      message: "date_after must be before date_before.",
      docs: "https://docs.openclaw.ai/tools/web",
    };
  }

  const resolvedCount = resolveSearchCount(count, DEFAULT_SEARCH_COUNT);
  const cacheKey = buildSearchCacheKey([
    "keenable",
    mode,
    baseUrl,
    query,
    resolvedCount,
    site,
    dateAfter,
    dateBefore,
  ]);
  const diagnostics: KeenableHttpDiagnostics = { enabled: options?.diagnosticsEnabled === true };
  const cached = readCachedSearchPayload(cacheKey);
  if (cached) {
    logKeenableHttp(diagnostics, "cache hit", { query, cacheKey });
    return cached;
  }
  logKeenableHttp(diagnostics, "cache miss", { query, cacheKey });

  const start = Date.now();
  const timeoutSeconds = resolveSearchTimeoutSeconds(searchConfig);
  const cacheTtlMs = resolveSearchCacheTtlMs(searchConfig);

  const results = await runKeenableWebSearch({
    baseUrl,
    endpointMode,
    query,
    count: resolvedCount,
    mode,
    apiKey,
    timeoutSeconds,
    diagnostics,
    site: site ?? undefined,
    dateAfter,
    dateBefore,
  });

  const payload = {
    query,
    provider: "keenable",
    mode,
    count: results.length,
    tookMs: Date.now() - start,
    externalContent: {
      untrusted: true,
      source: "web_search",
      provider: "keenable",
      wrapped: true,
    },
    results,
  };
  writeCachedSearchPayload(cacheKey, payload, cacheTtlMs);
  logKeenableHttp(diagnostics, "cache write", {
    query,
    cacheKey,
    ttlMs: cacheTtlMs,
    count: results.length,
  });
  return payload;
}
