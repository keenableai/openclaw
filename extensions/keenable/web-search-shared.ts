import {
  createWebSearchProviderContractFields,
  type WebSearchProviderPlugin,
} from "openclaw/plugin-sdk/provider-web-search-config-contract";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";

export const KEENABLE_CREDENTIAL_PATH = "plugins.entries.keenable.config.webSearch.apiKey";

export function resolveLegacyTopLevelKeenableCredential(
  config: unknown,
): { path: string; value: unknown } | undefined {
  if (!isRecord(config)) {
    return undefined;
  }
  const tools = isRecord(config.tools) ? config.tools : undefined;
  const web = isRecord(tools?.web) ? tools.web : undefined;
  const search = isRecord(web?.search) ? web.search : undefined;
  if (!search || !("apiKey" in search)) {
    return undefined;
  }
  return { path: "tools.web.search.apiKey", value: search.apiKey };
}

function resolveKeenableWebSearchPluginConfig(
  config: unknown,
): Record<string, unknown> | undefined {
  if (!isRecord(config)) {
    return undefined;
  }
  const plugins = isRecord(config.plugins) ? config.plugins : undefined;
  const entries = isRecord(plugins?.entries) ? plugins.entries : undefined;
  const entry = isRecord(entries?.keenable) ? entries.keenable : undefined;
  const pluginConfig = isRecord(entry?.config) ? entry.config : undefined;
  return isRecord(pluginConfig?.webSearch) ? pluginConfig.webSearch : undefined;
}

export function resolveConfiguredKeenableCredential(config: unknown): unknown {
  return (
    resolveKeenableWebSearchPluginConfig(config)?.apiKey ??
    resolveLegacyTopLevelKeenableCredential(config)?.value
  );
}

export function buildKeenableWebSearchProviderBase(): Omit<WebSearchProviderPlugin, "createTool"> {
  return {
    id: "keenable",
    label: "Keenable",
    hint: "AI web search · keyless by default · key lifts rate limits",
    onboardingScopes: ["text-inference"],
    // Works keyless (public rate-limited endpoint); an API key is optional and
    // only raises limits — so onboarding must not force a credential.
    requiresCredential: false,
    credentialLabel: "Keenable API key (optional — lifts rate limits)",
    envVars: ["KEENABLE_API_KEY"],
    placeholder: "keen_...",
    signupUrl: "https://keenable.ai/console",
    docsUrl: "https://docs.openclaw.ai/tools/keenable-search",
    autoDetectOrder: 20,
    credentialPath: KEENABLE_CREDENTIAL_PATH,
    ...createWebSearchProviderContractFields({
      credentialPath: KEENABLE_CREDENTIAL_PATH,
      searchCredential: { type: "top-level" },
      configuredCredential: { pluginId: "keenable" },
    }),
    getConfiguredCredentialValue: resolveConfiguredKeenableCredential,
    getConfiguredCredentialFallback: resolveLegacyTopLevelKeenableCredential,
  };
}
