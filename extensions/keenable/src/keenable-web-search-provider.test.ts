import fs from "node:fs";
import { validateJsonSchemaValue } from "openclaw/plugin-sdk/json-schema-runtime";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { createKeenableWebSearchProvider as createKeenableWebSearchContractProvider } from "../web-search-contract-api.js";
import { createKeenableWebSearchProvider } from "./keenable-web-search-provider.js";

const loggerInfoMock = vi.hoisted(() => vi.fn());

vi.mock("openclaw/plugin-sdk/runtime-env", () => ({
  createSubsystemLogger: () => ({
    info: loggerInfoMock,
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
    trace: vi.fn(),
    raw: vi.fn(),
    isEnabled: () => true,
    child: () => ({
      info: loggerInfoMock,
      debug: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      fatal: vi.fn(),
      trace: vi.fn(),
      raw: vi.fn(),
      isEnabled: () => true,
      child: vi.fn(),
    }),
  }),
}));

const keenableManifest = JSON.parse(
  fs.readFileSync(new URL("../openclaw.plugin.json", import.meta.url), "utf-8"),
) as { configSchema?: Record<string, unknown> };

afterAll(() => {
  vi.doUnmock("openclaw/plugin-sdk/runtime-env");
  vi.resetModules();
});

function readHeader(init: unknown, name: string): string | null {
  const headers = (init as { headers?: HeadersInit } | undefined)?.headers;
  if (!headers) {
    return null;
  }
  return new Headers(headers).get(name);
}

function fetchCall(mockFetch: { mock: { calls: Array<Array<unknown>> } }, index = 0) {
  const call = mockFetch.mock.calls[index];
  if (!call) {
    throw new Error(`Expected fetch call ${index + 1}`);
  }
  return call;
}

function fetchRequestUrl(mockFetch: { mock: { calls: Array<Array<unknown>> } }, index = 0) {
  return new URL(String(fetchCall(mockFetch, index)[0]));
}

function installResultsFetch(results: Array<Record<string, unknown>>) {
  const mockFetch = vi.fn(async (_input?: unknown, _init?: unknown) => {
    return {
      ok: true,
      status: 200,
      json: async () => ({ query: "q", mode: "pro", results }),
    } as unknown as Response;
  });
  global.fetch = mockFetch as typeof global.fetch;
  return mockFetch;
}

describe("keenable web search provider", () => {
  const priorFetch = global.fetch;

  afterEach(() => {
    vi.unstubAllEnvs();
    loggerInfoMock.mockClear();
    global.fetch = priorFetch;
  });

  it("points provider metadata at the canonical Keenable docs page", () => {
    expect(createKeenableWebSearchProvider().docsUrl).toBe(
      "https://docs.openclaw.ai/tools/keenable-search",
    );
    expect(createKeenableWebSearchContractProvider().docsUrl).toBe(
      "https://docs.openclaw.ai/tools/keenable-search",
    );
    expect(createKeenableWebSearchProvider().id).toBe("keenable");
  });

  it("exposes legacy top-level apiKey as a Keenable-owned compatibility fallback", () => {
    const apiKey = { source: "env", provider: "default", id: "KEENABLE_API_KEY" } as const;
    const config = { tools: { web: { search: { apiKey } } } };

    expect(createKeenableWebSearchProvider().getConfiguredCredentialValue?.(config)).toEqual(
      apiKey,
    );
    expect(createKeenableWebSearchProvider().getConfiguredCredentialFallback?.(config)).toEqual({
      path: "tools.web.search.apiKey",
      value: apiKey,
    });
  });

  it("returns a missing-key payload that points to the keyless MCP route", async () => {
    vi.stubEnv("KEENABLE_API_KEY", "");
    const provider = createKeenableWebSearchProvider();
    const tool = provider.createTool({ config: {}, searchConfig: {} });
    if (!tool) {
      throw new Error("Expected tool definition");
    }

    const result = await tool.execute({ query: "openclaw docs" });

    expect(result).toMatchObject({ error: "missing_keenable_api_key" });
    expect((result as { message: string }).message).toContain("openclaw mcp add keenable");
  });

  it("accepts mode and baseUrl in the plugin config schema", () => {
    if (!keenableManifest.configSchema) {
      throw new Error("Expected Keenable manifest config schema");
    }
    const result = validateJsonSchemaValue({
      schema: keenableManifest.configSchema,
      cacheKey: "test:keenable-config-schema",
      value: { webSearch: { mode: "realtime", baseUrl: "https://api.keenable.ai/proxy" } },
    });
    expect(result.ok).toBe(true);
  });

  it("rejects invalid mode values in the plugin config schema", () => {
    if (!keenableManifest.configSchema) {
      throw new Error("Expected Keenable manifest config schema");
    }
    const result = validateJsonSchemaValue({
      schema: keenableManifest.configSchema,
      cacheKey: "test:keenable-config-schema-mode",
      value: { webSearch: { mode: "invalid-mode" } },
    });
    expect(result.ok).toBe(false);
  });

  it("calls /v1/search with query, mode, and the X-API-Key header", async () => {
    vi.stubEnv("KEENABLE_API_KEY", "");
    const mockFetch = installResultsFetch([
      { title: "Result", url: "https://example.com/a", snippet: "snip" },
    ]);

    const provider = createKeenableWebSearchProvider();
    const tool = provider.createTool({
      config: {},
      searchConfig: { apiKey: "keen-test-key", keenable: { mode: "pro" } },
    });
    if (!tool) {
      throw new Error("Expected tool definition");
    }

    const result = (await tool.execute({ query: "latest ai news" })) as {
      provider: string;
      results: Array<{ url: string }>;
    };

    const requestUrl = fetchRequestUrl(mockFetch);
    expect(requestUrl.origin).toBe("https://api.keenable.ai");
    expect(requestUrl.pathname).toBe("/v1/search");
    expect(requestUrl.searchParams.get("query")).toBe("latest ai news");
    expect(requestUrl.searchParams.get("mode")).toBe("pro");
    expect(readHeader(fetchCall(mockFetch)[1], "X-API-Key")).toBe("keen-test-key");
    expect(result.provider).toBe("keenable");
    expect(result.results[0]?.url).toBe("https://example.com/a");
  });

  it("maps site and date filters to Keenable query parameters", async () => {
    vi.stubEnv("KEENABLE_API_KEY", "");
    const mockFetch = installResultsFetch([]);

    const provider = createKeenableWebSearchProvider();
    const tool = provider.createTool({
      config: {},
      searchConfig: { apiKey: "keen-test-key", keenable: {} },
    });
    if (!tool) {
      throw new Error("Expected tool definition");
    }

    await tool.execute({
      query: "ai policy",
      site: "europa.eu",
      date_after: "2025-01-01",
      date_before: "2025-12-31",
    });

    const requestUrl = fetchRequestUrl(mockFetch);
    expect(requestUrl.searchParams.get("site")).toBe("europa.eu");
    expect(requestUrl.searchParams.get("published_after")).toBe("2025-01-01");
    expect(requestUrl.searchParams.get("published_before")).toBe("2025-12-31");
  });

  it("returns a validation error for reversed date ranges before fetch", async () => {
    vi.stubEnv("KEENABLE_API_KEY", "");
    const mockFetch = installResultsFetch([]);

    const provider = createKeenableWebSearchProvider();
    const tool = provider.createTool({
      config: {},
      searchConfig: { apiKey: "keen-test-key", keenable: {} },
    });
    if (!tool) {
      throw new Error("Expected tool definition");
    }

    const result = await tool.execute({
      query: "latest gpu news",
      date_after: "2026-03-20",
      date_before: "2026-03-01",
    });

    expect(result).toMatchObject({ error: "invalid_date_range" });
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("uses a configured baseUrl for search requests", async () => {
    vi.stubEnv("KEENABLE_API_KEY", "");
    const mockFetch = installResultsFetch([]);

    const provider = createKeenableWebSearchProvider();
    const tool = provider.createTool({
      config: {},
      searchConfig: {
        apiKey: "keen-test-key",
        keenable: { baseUrl: "https://api.keenable.ai/proxy/" },
      },
    });
    if (!tool) {
      throw new Error("Expected tool definition");
    }

    await tool.execute({ query: "base url cache identity" });

    const requestUrl = fetchRequestUrl(mockFetch);
    expect(requestUrl.pathname).toBe("/proxy/v1/search");
  });
});
