import {
  assertOkOrThrowProviderError,
  readProviderJsonResponse,
} from "openclaw/plugin-sdk/provider-http";
import type { SearchConfigRecord } from "openclaw/plugin-sdk/provider-web-search";
import {
  buildSearchCacheKey,
  DEFAULT_SEARCH_COUNT,
  MAX_SEARCH_COUNT,
  parseIsoDateRange,
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
// With an API key → authenticated endpoint (higher limits); without → the
// public keyless endpoint (rate-limited). Both accept the same params/response.
const KEENABLE_SEARCH_ENDPOINT_PATH = "/v1/search";
const KEENABLE_PUBLIC_SEARCH_ENDPOINT_PATH = "/v1/search/public";
// Traffic attribution (Keenable records this via the X-Keenable-Title header).
const KEENABLE_APP_TITLE = "OpenClaw";
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

function buildKeenableEndpointUrl(baseUrl: string, endpointPath: string): URL {
  const url = new URL(baseUrl);
  const basePath = url.pathname.replace(/\/+$/u, "");
  url.pathname = `${basePath}${endpointPath}`;
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

async function runKeenableWebSearch(params: {
  baseUrl: string;
  endpointMode: KeenableEndpointMode;
  query: string;
  count: number;
  mode: "pro" | "realtime";
  apiKey?: string;
  timeoutSeconds: number;
  diagnostics?: KeenableHttpDiagnostics;
  site?: string;
  dateAfter?: string;
  dateBefore?: string;
}): Promise<Array<Record<string, unknown>>> {
  const endpointPath = params.apiKey
    ? KEENABLE_SEARCH_ENDPOINT_PATH
    : KEENABLE_PUBLIC_SEARCH_ENDPOINT_PATH;
  const url = buildKeenableEndpointUrl(params.baseUrl, endpointPath);
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
    keyed: Boolean(params.apiKey),
    url: url.toString(),
  });
  const startedAt = Date.now();
  const withEndpoint =
    params.endpointMode === "selfHosted"
      ? withSelfHostedWebSearchEndpoint
      : withTrustedWebSearchEndpoint;

  const headers: Record<string, string> = {
    Accept: "application/json",
    "X-Keenable-Title": KEENABLE_APP_TITLE,
  };
  if (params.apiKey) {
    headers["X-API-Key"] = params.apiKey;
  }

  const data = await withEndpoint(
    {
      url: url.toString(),
      timeoutSeconds: params.timeoutSeconds,
      init: {
        method: "GET",
        headers,
      },
    },
    async (response) => {
      logKeenableHttp(params.diagnostics, "response", {
        status: response.status,
        ok: response.ok,
        durationMs: Date.now() - startedAt,
      });
      await assertOkOrThrowProviderError(response, "Keenable Search API error");
      return readProviderJsonResponse<KeenableSearchResponse>(
        response,
        "Keenable Search API error",
      );
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
  // Key is optional: present → authenticated endpoint (higher limits);
  // absent → public keyless endpoint (rate-limited). Either way the search runs.
  const apiKey = resolveKeenableApiKey(searchConfig);

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

  // Keenable filters by publication date (not a freshness bucket), so use the
  // provider-agnostic ISO date-range parser (validates real dates + ordering).
  const parsedDateRange = parseIsoDateRange({
    rawDateAfter: readStringParam(args, "date_after"),
    rawDateBefore: readStringParam(args, "date_before"),
    invalidDateAfterMessage: "date_after must be YYYY-MM-DD format.",
    invalidDateBeforeMessage: "date_before must be YYYY-MM-DD format.",
    invalidDateRangeMessage: "date_after must be before date_before.",
  });
  if ("error" in parsedDateRange) {
    return parsedDateRange;
  }
  const { dateAfter, dateBefore } = parsedDateRange;

  const resolvedCount = resolveSearchCount(count, DEFAULT_SEARCH_COUNT);
  const cacheKey = buildSearchCacheKey([
    "keenable",
    apiKey ? "keyed" : "public",
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

  let results: Array<Record<string, unknown>>;
  try {
    results = await runKeenableWebSearch({
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
  } catch (err) {
    // Keyless traffic is rate-limited; turn a 429 into an actionable hint
    // instead of a raw provider error (the SDK formats status as "(429)").
    const message = err instanceof Error ? err.message : String(err);
    if (!apiKey && message.includes("(429)")) {
      return {
        error: "keenable_rate_limited",
        message:
          "Keenable keyless search hit its rate limit. Set KEENABLE_API_KEY (https://keenable.ai/console) to raise the limits.",
        docs: "https://docs.openclaw.ai/tools/web",
      };
    }
    throw err;
  }

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
