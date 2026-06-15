import type { WebSearchProviderPlugin } from "openclaw/plugin-sdk/provider-web-search-config-contract";
import { buildKeenableWebSearchProviderBase } from "./web-search-shared.js";

export function createKeenableWebSearchProvider(): WebSearchProviderPlugin {
  return {
    ...buildKeenableWebSearchProviderBase(),
    createTool: () => null,
  };
}
