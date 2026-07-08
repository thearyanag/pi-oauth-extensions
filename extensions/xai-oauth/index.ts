/**
 * xAI OAuth provider extension.
 *
 * Adds OAuth login for the built-in `xai` provider using the same xAI Grok
 * auth flow OpenClaw ships for eligible SuperGrok / X Premium accounts.
 *
 * Usage:
 *   pi -e ./packages/coding-agent/examples/extensions/xai-oauth
 *   # then /login xai if credentials are not already present
 */

import { createServer, type Server } from "node:http";
import type { ExtensionAPI, ProviderConfig, ProviderModelConfig } from "@earendil-works/pi-coding-agent";

const PROVIDER_ID = "xai";
const API_ID = "openai-responses";
const XAI_GROK_OAUTH_BASE_URL = "https://cli-chat-proxy.grok.com/v1";
const XAI_GROK_OAUTH_MODELS_URL = `${XAI_GROK_OAUTH_BASE_URL}/models`;
const OAUTH_ISSUER = "https://auth.x.ai";
const DISCOVERY_URL = `${OAUTH_ISSUER}/.well-known/openid-configuration`;
const CLIENT_ID = "b1a00492-073a-47ea-816f-4c329264a828";
const SCOPE = "openid profile email offline_access grok-cli:access api:access";
const CALLBACK_HOST = "127.0.0.1";
const CALLBACK_PORT = 56121;
const CALLBACK_PATH = "/callback";
const REDIRECT_URI = `http://${CALLBACK_HOST}:${CALLBACK_PORT}${CALLBACK_PATH}`;
const DEVICE_CODE_GRANT_TYPE = "urn:ietf:params:oauth:grant-type:device_code";
const FETCH_TIMEOUT_MS = 30_000;
const LOGIN_TIMEOUT_MS = 5 * 60 * 1000;
const DEVICE_CODE_DEFAULT_INTERVAL_MS = 5_000;
const DEVICE_CODE_MIN_INTERVAL_MS = 1_000;
const DEVICE_CODE_SLOW_DOWN_INCREMENT_MS = 5_000;
const ACCESS_TOKEN_REFRESH_SKEW_MS = 120_000;
const CALLBACK_CORS_ORIGIN_ALLOWLIST = new Set(["auth.x.ai", "accounts.x.ai"]);
const XAI_GROK_CLI_USER_AGENT_ORIGINATOR = "openclaw";
const XAI_GROK_CLI_USER_AGENT_FALLBACK_VERSION = "2026.5.18";
const XAI_GROK_CLIENT_VERSION_HEADER = "x-grok-client-version";
const XAI_GROK_CLIENT_VERSION_FALLBACK = "0.1.202";
const XAI_REASONING_ENCRYPTED_CONTENT_INCLUDE = "reasoning.encrypted_content";
const XAI_DEFAULT_CONTEXT_WINDOW = 1_000_000;
const XAI_LARGE_CONTEXT_WINDOW = 2_000_000;
const XAI_GROK_45_CONTEXT_WINDOW = 500_000;
const XAI_GROK_4_CONTEXT_WINDOW = 256_000;
const XAI_CODE_CONTEXT_WINDOW = 256_000;
const XAI_DEFAULT_MAX_TOKENS = 64_000;
const XAI_LEGACY_CONTEXT_WINDOW = 131_072;
const XAI_LEGACY_MAX_TOKENS = 8_192;
const XAI_MAX_CACHED_MODELS = 100;

const XAI_MODEL_ID_ALIASES = new Map<string, string>([
	["grok-code-fast-1", "grok-build-0.1"],
	["grok-code-fast", "grok-build-0.1"],
	["grok-code-fast-1-0825", "grok-build-0.1"],
	["grok-4-fast-reasoning", "grok-4-fast"],
	["grok-4-1-fast-reasoning", "grok-4-1-fast"],
	["grok-4.20-experimental-beta-0304-reasoning", "grok-4.20-beta-latest-reasoning"],
	["grok-4.20-experimental-beta-0304-non-reasoning", "grok-4.20-beta-latest-non-reasoning"],
	["grok-4.20-reasoning", "grok-4.20-beta-latest-reasoning"],
	["grok-4.20-non-reasoning", "grok-4.20-beta-latest-non-reasoning"],
]);

const XAI_SELECTABLE_MODEL_IDS = new Set([
	"grok-build-0.1",
	"grok-4.5",
	"grok-4.3",
	"grok-4.20-beta-latest-reasoning",
	"grok-4.20-beta-latest-non-reasoning",
]);

const XAI_UNSUPPORTED_SCHEMA_KEYWORDS = new Set([
	"minLength",
	"maxLength",
	"minItems",
	"maxItems",
	"minContains",
	"maxContains",
]);

type RegisteredOAuthConfig = NonNullable<ProviderConfig["oauth"]>;
type OAuthCredentials = Parameters<RegisteredOAuthConfig["refreshToken"]>[0];
type OAuthLoginCallbacks = Parameters<RegisteredOAuthConfig["login"]>[0];
type RegisteredModel = Parameters<NonNullable<RegisteredOAuthConfig["modifyModels"]>>[0][number];
type XaiModelCost = RegisteredModel["cost"];
type XaiOAuthModelConfig = RegisteredModel & {
	api: typeof API_ID;
	provider: typeof PROVIDER_ID;
	baseUrl: typeof XAI_GROK_OAUTH_BASE_URL;
};

type XaiCredentials = OAuthCredentials & {
	tokenEndpoint?: unknown;
	idToken?: unknown;
	email?: unknown;
	displayName?: unknown;
	accountId?: unknown;
	authFlow?: unknown;
	issuer?: unknown;
	oauthModels?: unknown;
};

type OAuthDiscovery = {
	authorizationEndpoint: string;
	tokenEndpoint: string;
};

type DeviceCodeDiscovery = {
	deviceAuthorizationEndpoint: string;
	tokenEndpoint: string;
};

type TokenResponse = {
	accessToken: string;
	refreshToken?: string;
	expires: number;
	idToken?: string;
};

type OAuthCallbackResult = {
	code: string;
	state: string;
};

type CallbackServer = {
	server: Server;
	waitForCode(): Promise<OAuthCallbackResult>;
};

type DeviceCodeResponse = {
	deviceCode: string;
	userCode: string;
	verificationUri: string;
	verificationUriComplete?: string;
	expiresInMs: number;
	intervalMs: number;
};

type XaiIdentity = {
	email?: string;
	displayName?: string;
	accountId?: string;
};

const XAI_GROK_BUILD_COST = { input: 1, output: 2, cacheRead: 0.2, cacheWrite: 0 } satisfies XaiModelCost;
const XAI_GROK_45_COST = { input: 2, output: 6, cacheRead: 0.5, cacheWrite: 0 } satisfies XaiModelCost;
const XAI_GROK_43_COST = { input: 1.25, output: 2.5, cacheRead: 0.2, cacheWrite: 0 } satisfies XaiModelCost;
const XAI_GROK_420_COST = { input: 1.25, output: 2.5, cacheRead: 0.2, cacheWrite: 0 } satisfies XaiModelCost;

const XAI_MODELS = [
	{
		id: "grok-build-0.1",
		name: "Grok Build 0.1",
		reasoning: true,
		input: ["text", "image"],
		cost: XAI_GROK_BUILD_COST,
		contextWindow: 256_000,
		maxTokens: 64_000,
	},
	{
		id: "grok-4.5",
		name: "Grok 4.5",
		reasoning: true,
		input: ["text", "image"],
		cost: XAI_GROK_45_COST,
		contextWindow: 500_000,
		maxTokens: 64_000,
	},
	{
		id: "grok-4.3",
		name: "Grok 4.3",
		reasoning: true,
		input: ["text", "image"],
		cost: XAI_GROK_43_COST,
		contextWindow: 1_000_000,
		maxTokens: 64_000,
	},
	{
		id: "grok-4.20-beta-latest-reasoning",
		name: "Grok 4.20 Beta Latest (Reasoning)",
		reasoning: true,
		input: ["text", "image"],
		cost: XAI_GROK_420_COST,
		contextWindow: 2_000_000,
		maxTokens: 30_000,
	},
	{
		id: "grok-4.20-beta-latest-non-reasoning",
		name: "Grok 4.20 Beta Latest (Non-Reasoning)",
		reasoning: false,
		input: ["text", "image"],
		cost: XAI_GROK_420_COST,
		contextWindow: 2_000_000,
		maxTokens: 30_000,
	},
] satisfies ProviderModelConfig[];

const XAI_UNKNOWN_MODEL_COST = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
} satisfies XaiModelCost;

const XAI_GROK_4_COST = {
	input: 3,
	output: 15,
	cacheRead: 0.75,
	cacheWrite: 0,
} satisfies XaiModelCost;

const XAI_FAST_COST = {
	input: 0.2,
	output: 0.5,
	cacheRead: 0.05,
	cacheWrite: 0,
} satisfies XaiModelCost;

const XAI_CODE_FAST_COST = {
	input: 0.2,
	output: 1.5,
	cacheRead: 0.02,
	cacheWrite: 0,
} satisfies XaiModelCost;

const XAI_IMAGE_MODEL_IDS = new Set(["grok-imagine-image", "grok-imagine-image-quality"]);
const XAI_GROK_BUILD_ALIASES = new Set(["grok-code-fast-1", "grok-code-fast", "grok-code-fast-1-0825"]);
const xaiModelInputsById = new Map<string, ReadonlyArray<"text" | "image">>();

function readLiveModelString(row: unknown, key: string): string | undefined {
	if (!row || typeof row !== "object" || Array.isArray(row)) return undefined;
	const value = (row as Record<string, unknown>)[key];
	return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function readLiveModelPositiveInteger(row: unknown, keys: readonly string[]): number | undefined {
	if (!row || typeof row !== "object" || Array.isArray(row)) return undefined;
	const record = row as Record<string, unknown>;
	for (const key of keys) {
		const value = record[key];
		if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) return value;
	}
	return undefined;
}

function readLiveModelBoolean(row: unknown, key: string): boolean | undefined {
	if (!row || typeof row !== "object" || Array.isArray(row)) return undefined;
	const value = (row as Record<string, unknown>)[key];
	return typeof value === "boolean" ? value : undefined;
}

function normalizeCatalogModelId(modelId: string): string {
	const lower = modelId.trim().toLowerCase();
	const unprefixed = lower.startsWith("xai/") ? lower.slice("xai/".length) : lower;
	return XAI_GROK_BUILD_ALIASES.has(unprefixed) ? "grok-build-0.1" : unprefixed;
}

function resolveXaiCatalogEntry(modelId: string): ProviderModelConfig | undefined {
	const trimmed = modelId.trim();
	const lower = normalizeCatalogModelId(modelId);
	const exact = XAI_MODELS.find((entry) => entry.id.toLowerCase() === lower);
	if (exact) return exact;
	if (lower === "grok-build") return XAI_MODELS.find((entry) => entry.id === "grok-build-0.1");
	if (lower.includes("multi-agent")) return undefined;
	if (lower.startsWith("grok-code-fast")) {
		return {
			id: trimmed,
			name: trimmed,
			reasoning: true,
			input: ["text"],
			contextWindow: XAI_CODE_CONTEXT_WINDOW,
			maxTokens: 10_000,
			cost: XAI_CODE_FAST_COST,
		};
	}
	if (
		lower.startsWith("grok-3-mini-fast") ||
		lower.startsWith("grok-3-mini") ||
		lower.startsWith("grok-3-fast") ||
		lower.startsWith("grok-3")
	) {
		const cost = lower.startsWith("grok-3-mini-fast")
			? { input: 0.6, output: 4, cacheRead: 0.15, cacheWrite: 0 }
			: lower.startsWith("grok-3-mini")
				? { input: 0.3, output: 0.5, cacheRead: 0.075, cacheWrite: 0 }
				: lower.startsWith("grok-3-fast")
					? { input: 5, output: 25, cacheRead: 1.25, cacheWrite: 0 }
					: XAI_GROK_4_COST;
		return {
			id: trimmed,
			name: trimmed,
			reasoning: lower.includes("mini"),
			input: ["text"],
			contextWindow: XAI_LEGACY_CONTEXT_WINDOW,
			maxTokens: XAI_LEGACY_MAX_TOKENS,
			cost,
		};
	}
	if (lower.startsWith("grok-4.5")) {
		return {
			id: trimmed,
			name: trimmed,
			reasoning: !lower.includes("non-reasoning"),
			input: ["text", "image"],
			contextWindow: XAI_GROK_45_CONTEXT_WINDOW,
			maxTokens: XAI_DEFAULT_MAX_TOKENS,
			cost: XAI_GROK_45_COST,
		};
	}
	if (
		lower.startsWith("grok-4.3") ||
		lower.startsWith("grok-4.20") ||
		lower.startsWith("grok-4-1") ||
		lower.startsWith("grok-4-fast")
	) {
		return {
			id: trimmed,
			name: trimmed,
			reasoning: !lower.includes("non-reasoning"),
			input: ["text", "image"],
			contextWindow: lower.startsWith("grok-4.3") ? XAI_DEFAULT_CONTEXT_WINDOW : XAI_LARGE_CONTEXT_WINDOW,
			maxTokens: lower.startsWith("grok-4.3") ? XAI_DEFAULT_MAX_TOKENS : 30_000,
			cost: lower.startsWith("grok-4.3")
				? XAI_GROK_43_COST
				: lower.startsWith("grok-4.20")
					? XAI_GROK_420_COST
					: XAI_FAST_COST,
		};
	}
	if (lower.startsWith("grok-4")) {
		return {
			id: trimmed,
			name: trimmed,
			reasoning: lower.includes("reasoning"),
			input: ["text"],
			contextWindow: XAI_GROK_4_CONTEXT_WINDOW,
			maxTokens: XAI_DEFAULT_MAX_TOKENS,
			cost: XAI_GROK_4_COST,
		};
	}
	return undefined;
}

function isXaiOAuthResponsesModel(row: unknown, fallback: ProviderModelConfig | undefined): boolean {
	const modelId = readLiveModelString(row, "id") ?? readLiveModelString(row, "model");
	if (modelId && XAI_IMAGE_MODEL_IDS.has(modelId)) return false;
	const backend =
		readLiveModelString(row, "api_backend") ??
		readLiveModelString(row, "apiBackend") ??
		readLiveModelString(row, "backend");
	if (backend) {
		const normalizedBackend = backend.toLowerCase();
		return normalizedBackend === "responses" || normalizedBackend === "chat" || normalizedBackend === "language";
	}
	return Boolean(fallback);
}

function normalizeXaiModelInput(value: unknown): Array<"text" | "image"> | null {
	if (!Array.isArray(value)) return null;
	const input = value.filter((item): item is "text" | "image" => item === "text" || item === "image");
	return input.length > 0 ? Array.from(new Set(input)) : null;
}

function normalizeXaiModelCost(value: unknown): XaiModelCost | null {
	if (!value || typeof value !== "object" || Array.isArray(value)) return null;
	const record = value as Record<string, unknown>;
	const input = typeof record.input === "number" && Number.isFinite(record.input) && record.input >= 0 ? record.input : null;
	const output =
		typeof record.output === "number" && Number.isFinite(record.output) && record.output >= 0 ? record.output : null;
	const cacheRead =
		typeof record.cacheRead === "number" && Number.isFinite(record.cacheRead) && record.cacheRead >= 0
			? record.cacheRead
			: null;
	const cacheWrite =
		typeof record.cacheWrite === "number" && Number.isFinite(record.cacheWrite) && record.cacheWrite >= 0
			? record.cacheWrite
			: null;
	if (input === null || output === null || cacheRead === null || cacheWrite === null) return null;
	return { input, output, cacheRead, cacheWrite };
}

function normalizeStoredXaiOAuthModel(value: unknown): XaiOAuthModelConfig | null {
	if (!value || typeof value !== "object" || Array.isArray(value)) return null;
	const record = value as Record<string, unknown>;
	const id = typeof record.id === "string" && record.id.trim().length > 0 ? record.id.trim() : null;
	const name = typeof record.name === "string" && record.name.trim().length > 0 ? record.name.trim() : null;
	const reasoning = typeof record.reasoning === "boolean" ? record.reasoning : null;
	const input = normalizeXaiModelInput(record.input);
	const cost = normalizeXaiModelCost(record.cost);
	const contextWindow =
		typeof record.contextWindow === "number" && Number.isSafeInteger(record.contextWindow) && record.contextWindow > 0
			? record.contextWindow
			: null;
	const maxTokens =
		typeof record.maxTokens === "number" && Number.isSafeInteger(record.maxTokens) && record.maxTokens > 0
			? record.maxTokens
			: null;
	if (!id || !name || reasoning === null || !input || !cost || !contextWindow || !maxTokens) return null;
	if (XAI_IMAGE_MODEL_IDS.has(id)) return null;
	return {
		id,
		name,
		api: API_ID,
		provider: PROVIDER_ID,
		baseUrl: XAI_GROK_OAUTH_BASE_URL,
		reasoning,
		input,
		cost,
		contextWindow,
		maxTokens,
	};
}

function normalizeStoredXaiOAuthModels(value: unknown): XaiOAuthModelConfig[] {
	if (!Array.isArray(value)) return [];
	const models: XaiOAuthModelConfig[] = [];
	const seenIds = new Set<string>();
	for (const item of value) {
		const model = normalizeStoredXaiOAuthModel(item);
		if (!model) continue;
		const key = model.id.toLowerCase();
		if (seenIds.has(key)) continue;
		seenIds.add(key);
		models.push(model);
		if (models.length >= XAI_MAX_CACHED_MODELS) break;
	}
	return models;
}

function buildXaiOAuthModelFromLiveRow(row: unknown): XaiOAuthModelConfig | null {
	const modelId = readLiveModelString(row, "id") ?? readLiveModelString(row, "model");
	if (!modelId || XAI_IMAGE_MODEL_IDS.has(modelId)) return null;
	const fallback = resolveXaiCatalogEntry(modelId);
	if (!isXaiOAuthResponsesModel(row, fallback)) return null;

	const contextWindow =
		readLiveModelPositiveInteger(row, ["context_window", "contextWindow"]) ??
		fallback?.contextWindow ??
		XAI_DEFAULT_CONTEXT_WINDOW;
	const maxTokens =
		readLiveModelPositiveInteger(row, ["max_completion_tokens", "maxCompletionTokens"]) ??
		fallback?.maxTokens ??
		XAI_DEFAULT_MAX_TOKENS;
	const reasoning =
		readLiveModelBoolean(row, "supports_reasoning_effort") ??
		readLiveModelBoolean(row, "supportsReasoningEffort") ??
		fallback?.reasoning ??
		false;

	return {
		id: modelId,
		name: readLiveModelString(row, "name") ?? fallback?.name ?? modelId,
		api: API_ID,
		provider: PROVIDER_ID,
		baseUrl: XAI_GROK_OAUTH_BASE_URL,
		reasoning,
		input: fallback?.input ?? ["text"],
		cost: fallback?.cost ?? XAI_UNKNOWN_MODEL_COST,
		contextWindow,
		maxTokens,
	};
}

function xaiOAuthModelRows(payload: unknown): unknown[] {
	if (Array.isArray(payload)) return payload;
	if (!payload || typeof payload !== "object" || Array.isArray(payload)) return [];
	const record = payload as Record<string, unknown>;
	if (Array.isArray(record.data)) return record.data;
	if (Array.isArray(record.models)) return record.models;
	return [];
}

function buildXaiOAuthModelsFromResponse(payload: unknown): XaiOAuthModelConfig[] {
	return normalizeStoredXaiOAuthModels(
		xaiOAuthModelRows(payload)
			.map(buildXaiOAuthModelFromLiveRow)
			.filter((model): model is XaiOAuthModelConfig => Boolean(model)),
	);
}

function xaiUserAgent(): string {
	const version =
		process.env.OPENCLAW_VERSION?.trim() ||
		process.env.OPENCLAW_SERVICE_VERSION?.trim() ||
		process.env.npm_package_version?.trim() ||
		XAI_GROK_CLI_USER_AGENT_FALLBACK_VERSION;
	return `${XAI_GROK_CLI_USER_AGENT_ORIGINATOR}/${version}`;
}

function xaiGrokClientVersion(): string {
	return process.env.PI_XAI_GROK_CLIENT_VERSION?.trim() || XAI_GROK_CLIENT_VERSION_FALLBACK;
}

function xaiGrokProxyHeaders(): Record<string, string> {
	return {
		"User-Agent": xaiUserAgent(),
		[XAI_GROK_CLIENT_VERSION_HEADER]: xaiGrokClientVersion(),
	};
}

function oauthSuccessHtml(): string {
	return renderOAuthPage({
		title: "xAI OAuth complete",
		heading: "xAI OAuth complete",
		message: "Authentication completed. You can close this window and return to Pi.",
	});
}

function oauthErrorHtml(message: string): string {
	return renderOAuthPage({
		title: "xAI OAuth failed",
		heading: "xAI OAuth failed",
		message,
	});
}

function renderOAuthPage(options: { title: string; heading: string; message: string }): string {
	return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(options.title)}</title>
  <style>
    html { color-scheme: dark; }
    body {
      margin: 0;
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 24px;
      background: #09090b;
      color: #fafafa;
      font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      text-align: center;
    }
    main { max-width: 560px; }
    h1 { margin: 0 0 10px; font-size: 28px; line-height: 1.15; font-weight: 650; }
    p { margin: 0; line-height: 1.7; color: #a1a1aa; font-size: 15px; }
  </style>
</head>
<body>
  <main>
    <h1>${escapeHtml(options.heading)}</h1>
    <p>${escapeHtml(options.message)}</p>
  </main>
</body>
</html>`;
}

function escapeHtml(value: string): string {
	return value
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;")
		.replaceAll("'", "&#39;");
}

function base64urlEncode(bytes: Uint8Array): string {
	let binary = "";
	for (const byte of bytes) {
		binary += String.fromCharCode(byte);
	}
	return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
}

async function generatePKCE(): Promise<{ verifier: string; challenge: string }> {
	const verifierBytes = new Uint8Array(64);
	crypto.getRandomValues(verifierBytes);
	const verifier = base64urlEncode(verifierBytes);
	const hashBuffer = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
	return { verifier, challenge: base64urlEncode(new Uint8Array(hashBuffer)) };
}

function randomState(byteLength: number): string {
	const bytes = new Uint8Array(byteLength);
	crypto.getRandomValues(bytes);
	return base64urlEncode(bytes);
}

function readRecord(value: unknown): Record<string, unknown> {
	return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function isTrustedXaiEndpoint(endpoint: string): boolean {
	try {
		const url = new URL(endpoint);
		return url.protocol === "https:" && (url.hostname === "x.ai" || url.hostname.endsWith(".x.ai"));
	} catch {
		return false;
	}
}

function requireTrustedXaiEndpoint(endpoint: string, label: string): string {
	if (!isTrustedXaiEndpoint(endpoint)) {
		throw new Error(`xAI OAuth discovery returned untrusted ${label}`);
	}
	return endpoint;
}

async function readJsonResponse(response: Response, context: string): Promise<unknown> {
	let body: unknown = null;
	try {
		body = await response.json();
	} catch {
		body = null;
	}
	if (!response.ok) {
		const record = readRecord(body);
		const error = typeof record.error_description === "string" ? record.error_description : record.error;
		throw new Error(`${context} failed (${response.status})${typeof error === "string" ? `: ${error}` : ""}`);
	}
	return body;
}

async function fetchDiscoveryDocument(): Promise<Record<string, unknown>> {
	const response = await fetch(DISCOVERY_URL, {
		headers: {
			Accept: "application/json",
			"User-Agent": xaiUserAgent(),
		},
		signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
	});
	return readRecord(await readJsonResponse(response, "xAI OAuth discovery"));
}

async function fetchOAuthDiscovery(): Promise<OAuthDiscovery> {
	const document = await fetchDiscoveryDocument();
	const authorizationEndpoint = document.authorization_endpoint;
	const tokenEndpoint = document.token_endpoint;
	if (typeof authorizationEndpoint !== "string" || typeof tokenEndpoint !== "string") {
		throw new Error("xAI OAuth discovery response is missing endpoints");
	}
	return {
		authorizationEndpoint: requireTrustedXaiEndpoint(authorizationEndpoint, "authorization endpoint"),
		tokenEndpoint: requireTrustedXaiEndpoint(tokenEndpoint, "token endpoint"),
	};
}

async function fetchDeviceCodeDiscovery(): Promise<DeviceCodeDiscovery> {
	const document = await fetchDiscoveryDocument();
	const deviceAuthorizationEndpoint = document.device_authorization_endpoint;
	const tokenEndpoint = document.token_endpoint;
	if (typeof deviceAuthorizationEndpoint !== "string" || typeof tokenEndpoint !== "string") {
		throw new Error("xAI OAuth discovery response is missing device code endpoints");
	}
	return {
		deviceAuthorizationEndpoint: requireTrustedXaiEndpoint(
			deviceAuthorizationEndpoint,
			"device authorization endpoint",
		),
		tokenEndpoint: requireTrustedXaiEndpoint(tokenEndpoint, "token endpoint"),
	};
}

function buildAuthorizeUrl(params: {
	authorizationEndpoint: string;
	state: string;
	nonce: string;
	challenge: string;
}): string {
	const url = new URL(requireTrustedXaiEndpoint(params.authorizationEndpoint, "authorization endpoint"));
	url.searchParams.set("response_type", "code");
	url.searchParams.set("client_id", CLIENT_ID);
	url.searchParams.set("redirect_uri", REDIRECT_URI);
	url.searchParams.set("scope", SCOPE);
	url.searchParams.set("state", params.state);
	url.searchParams.set("nonce", params.nonce);
	url.searchParams.set("code_challenge", params.challenge);
	url.searchParams.set("code_challenge_method", "S256");
	url.searchParams.set("plan", "generic");
	url.searchParams.set("referrer", "openclaw");
	return url.toString();
}

function formHeaders(): Record<string, string> {
	return {
		"Content-Type": "application/x-www-form-urlencoded",
		Accept: "application/json",
		"User-Agent": xaiUserAgent(),
	};
}

function normalizeExpires(value: unknown): number | undefined {
	const seconds =
		typeof value === "number" ? value : typeof value === "string" ? Number.parseFloat(value) : Number.NaN;
	if (!Number.isFinite(seconds) || seconds <= 0) return undefined;
	return Date.now() + seconds * 1000 - ACCESS_TOKEN_REFRESH_SKEW_MS;
}

function normalizePositiveSecondsToMs(value: unknown): number | undefined {
	const seconds =
		typeof value === "number" ? value : typeof value === "string" ? Number.parseFloat(value) : Number.NaN;
	if (!Number.isFinite(seconds) || seconds <= 0) return undefined;
	return Math.trunc(seconds * 1000);
}

function decodeJwtPayload(token: string | undefined): Record<string, unknown> {
	if (!token) return {};
	const payload = token.split(".")[1];
	if (!payload) return {};
	try {
		return readRecord(JSON.parse(Buffer.from(payload, "base64url").toString("utf8")));
	} catch {
		return {};
	}
}

function deriveExpiresFromJwt(token: string | undefined): number | undefined {
	const exp = decodeJwtPayload(token).exp;
	return typeof exp === "number" && Number.isFinite(exp) && exp > 0
		? exp * 1000 - ACCESS_TOKEN_REFRESH_SKEW_MS
		: undefined;
}

function parseTokenResponse(value: unknown, requireRefreshToken: boolean): TokenResponse {
	const record = readRecord(value);
	const accessToken = record.access_token;
	if (typeof accessToken !== "string" || accessToken.trim().length === 0) {
		throw new Error("xAI OAuth token response is missing access_token");
	}
	const refreshToken =
		typeof record.refresh_token === "string" && record.refresh_token.trim().length > 0
			? record.refresh_token
			: undefined;
	if (requireRefreshToken && !refreshToken) {
		throw new Error(
			"xAI OAuth token response is missing refresh_token. Re-run the login; if the issue persists, the OAuth client is not configured to issue refresh tokens (commonly because the offline_access scope was rejected).",
		);
	}
	const idToken =
		typeof record.id_token === "string" && record.id_token.trim().length > 0 ? record.id_token : undefined;
	return {
		accessToken,
		...(refreshToken ? { refreshToken } : {}),
		expires: normalizeExpires(record.expires_in) ?? deriveExpiresFromJwt(accessToken) ?? Date.now() + 3600_000,
		...(idToken ? { idToken } : {}),
	};
}

async function exchangeToken(params: {
	tokenEndpoint: string;
	body: Record<string, string>;
	context: string;
	requireRefreshToken?: boolean;
}): Promise<TokenResponse> {
	const response = await fetch(requireTrustedXaiEndpoint(params.tokenEndpoint, "token endpoint"), {
		method: "POST",
		headers: formHeaders(),
		body: new URLSearchParams(params.body).toString(),
		signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
	});
	return parseTokenResponse(await readJsonResponse(response, params.context), params.requireRefreshToken ?? false);
}

function resolveIdentity(tokens: TokenResponse): XaiIdentity {
	const payload = decodeJwtPayload(tokens.idToken ?? tokens.accessToken);
	const email = typeof payload.email === "string" ? payload.email : undefined;
	const displayName = typeof payload.name === "string" ? payload.name : undefined;
	const accountId = typeof payload.sub === "string" ? payload.sub : undefined;
	return {
		...(email ? { email } : {}),
		...(displayName ? { displayName } : {}),
		...(accountId ? { accountId } : {}),
	};
}

function allowedCorsOrigin(origin: string | undefined): string | undefined {
	if (!origin) return undefined;
	try {
		const url = new URL(origin);
		if (url.protocol === "https:" && CALLBACK_CORS_ORIGIN_ALLOWLIST.has(url.hostname)) return origin;
		return undefined;
	} catch {
		return undefined;
	}
}

async function startCallbackServer(expectedState: string): Promise<CallbackServer> {
	return new Promise((resolve, reject) => {
		let settleWait: ((value: OAuthCallbackResult) => void) | undefined;
		let rejectWait: ((error: Error) => void) | undefined;
		const waitForCodePromise = new Promise<OAuthCallbackResult>((resolveWait, rejectPromise) => {
			let settled = false;
			settleWait = (value) => {
				if (settled) return;
				settled = true;
				resolveWait(value);
			};
			rejectWait = (error) => {
				if (settled) return;
				settled = true;
				rejectPromise(error);
			};
		});

		const timeout = setTimeout(() => {
			rejectWait?.(new Error("OAuth callback timeout - authorization took too long"));
		}, LOGIN_TIMEOUT_MS);

		const server = createServer((req, res) => {
			const origin = allowedCorsOrigin(typeof req.headers.origin === "string" ? req.headers.origin : undefined);
			if (origin) {
				res.setHeader("Access-Control-Allow-Origin", origin);
				res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
				res.setHeader("Access-Control-Allow-Headers", "Content-Type");
				res.setHeader("Access-Control-Allow-Private-Network", "true");
				res.setHeader("Vary", "Origin");
			}

			if (req.method === "OPTIONS") {
				res.writeHead(204);
				res.end();
				return;
			}

			const url = new URL(req.url || "", `http://${CALLBACK_HOST}:${CALLBACK_PORT}`);
			if (url.pathname !== CALLBACK_PATH) {
				res.writeHead(404, { "Content-Type": "text/html; charset=utf-8" });
				res.end(oauthErrorHtml("Callback route not found."));
				return;
			}

			const error = url.searchParams.get("error");
			const errorDescription = url.searchParams.get("error_description");
			if (error) {
				const message = errorDescription || error;
				res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
				res.end(oauthErrorHtml(message));
				rejectWait?.(new Error(message));
				return;
			}

			const code = url.searchParams.get("code");
			const state = url.searchParams.get("state");
			if (!code || !state) {
				res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
				res.end(oauthErrorHtml("Missing code or state parameter."));
				rejectWait?.(new Error("Missing code or state parameter"));
				return;
			}
			if (state !== expectedState) {
				res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
				res.end(oauthErrorHtml("Invalid OAuth state."));
				rejectWait?.(new Error("OAuth state mismatch - possible CSRF attack"));
				return;
			}

			res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
			res.end(oauthSuccessHtml());
			settleWait?.({ code, state });
		});

		server.on("error", (error) => {
			clearTimeout(timeout);
			reject(error);
		});
		server.listen(CALLBACK_PORT, CALLBACK_HOST, () => {
			resolve({
				server,
				waitForCode: () =>
					waitForCodePromise.finally(() => {
						clearTimeout(timeout);
					}),
			});
		});
	});
}

async function requestDeviceCode(deviceAuthorizationEndpoint: string): Promise<DeviceCodeResponse> {
	const response = await fetch(
		requireTrustedXaiEndpoint(deviceAuthorizationEndpoint, "device authorization endpoint"),
		{
			method: "POST",
			headers: formHeaders(),
			body: new URLSearchParams({
				client_id: CLIENT_ID,
				scope: SCOPE,
			}).toString(),
			signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
		},
	);
	const record = readRecord(await readJsonResponse(response, "xAI device code request"));
	const deviceCode = record.device_code;
	const userCode = record.user_code;
	const verificationUri = record.verification_uri;
	if (
		typeof deviceCode !== "string" ||
		typeof userCode !== "string" ||
		typeof verificationUri !== "string" ||
		!deviceCode.trim() ||
		!userCode.trim() ||
		!verificationUri.trim()
	) {
		throw new Error("xAI device code response is missing device_code, user_code, or verification_uri");
	}
	const verificationUriComplete =
		typeof record.verification_uri_complete === "string" && record.verification_uri_complete.trim()
			? requireTrustedXaiEndpoint(record.verification_uri_complete, "complete device verification URI")
			: undefined;
	return {
		deviceCode,
		userCode,
		verificationUri: requireTrustedXaiEndpoint(verificationUri, "device verification URI"),
		...(verificationUriComplete ? { verificationUriComplete } : {}),
		expiresInMs: normalizePositiveSecondsToMs(record.expires_in) ?? LOGIN_TIMEOUT_MS,
		intervalMs: normalizePositiveSecondsToMs(record.interval) ?? DEVICE_CODE_DEFAULT_INTERVAL_MS,
	};
}

function nextDeviceCodeDelay(intervalMs: number, deadlineMs: number): number {
	const remainingMs = Math.max(0, deadlineMs - Date.now());
	return Math.min(Math.max(intervalMs, DEVICE_CODE_MIN_INTERVAL_MS), remainingMs);
}

async function pollDeviceCodeToken(params: {
	tokenEndpoint: string;
	deviceCode: string;
	expiresInMs: number;
	intervalMs: number;
	onProgress: OAuthLoginCallbacks["onProgress"];
}): Promise<TokenResponse> {
	const deadlineMs = Date.now() + params.expiresInMs;
	let intervalMs = params.intervalMs;

	while (Date.now() < deadlineMs) {
		const response = await fetch(requireTrustedXaiEndpoint(params.tokenEndpoint, "token endpoint"), {
			method: "POST",
			headers: formHeaders(),
			body: new URLSearchParams({
				grant_type: DEVICE_CODE_GRANT_TYPE,
				client_id: CLIENT_ID,
				device_code: params.deviceCode,
			}).toString(),
			signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
		});
		let body: unknown = null;
		try {
			body = await response.json();
		} catch {
			body = null;
		}
		if (response.ok) return parseTokenResponse(body, true);

		const record = readRecord(body);
		const error = typeof record.error === "string" ? record.error : undefined;
		if (error === "authorization_pending") {
			params.onProgress?.("Waiting for xAI device authorization...");
			await new Promise((resolve) => setTimeout(resolve, nextDeviceCodeDelay(intervalMs, deadlineMs)));
			continue;
		}
		if (error === "slow_down") {
			intervalMs += DEVICE_CODE_SLOW_DOWN_INCREMENT_MS;
			params.onProgress?.("xAI asked us to slow down polling...");
			await new Promise((resolve) => setTimeout(resolve, nextDeviceCodeDelay(intervalMs, deadlineMs)));
			continue;
		}
		if (error === "access_denied" || error === "authorization_denied") {
			throw new Error("xAI device authorization was denied");
		}
		if (error === "expired_token") {
			throw new Error("xAI device code expired. Re-run login.");
		}
		const description = typeof record.error_description === "string" ? record.error_description : error;
		throw new Error(`xAI device token exchange failed (${response.status})${description ? `: ${description}` : ""}`);
	}

	throw new Error("xAI device authorization timed out");
}

function credentialsFromTokens(tokens: TokenResponse, tokenEndpoint: string, authFlow?: string): XaiCredentials {
	const identity = resolveIdentity(tokens);
	return {
		refresh: tokens.refreshToken || "",
		access: tokens.accessToken,
		expires: tokens.expires,
		tokenEndpoint,
		issuer: OAUTH_ISSUER,
		...(authFlow ? { authFlow } : {}),
		...(tokens.idToken ? { idToken: tokens.idToken } : {}),
		...(identity.email ? { email: identity.email } : {}),
		...(identity.displayName ? { displayName: identity.displayName } : {}),
		...(identity.accountId ? { accountId: identity.accountId } : {}),
	};
}

async function loginBrowser(callbacks: OAuthLoginCallbacks): Promise<XaiCredentials> {
	callbacks.onProgress?.("Starting xAI OAuth callback server...");
	const discovery = await fetchOAuthDiscovery();
	const pkce = await generatePKCE();
	const state = randomState(32);
	const nonce = randomState(16);
	const callbackServer = await startCallbackServer(state);

	try {
		const authorizeUrl = buildAuthorizeUrl({
			authorizationEndpoint: discovery.authorizationEndpoint,
			state,
			nonce,
			challenge: pkce.challenge,
		});

		callbacks.onAuth({
			url: authorizeUrl,
			instructions: "Complete xAI authorization in your browser.",
		});
		callbacks.onProgress?.(`Waiting for xAI OAuth callback on ${REDIRECT_URI}...`);
		const callback = await callbackServer.waitForCode();

		callbacks.onProgress?.("Exchanging xAI authorization code for tokens...");
		const tokens = await exchangeToken({
			tokenEndpoint: discovery.tokenEndpoint,
			context: "xAI OAuth token exchange",
			requireRefreshToken: true,
			body: {
				grant_type: "authorization_code",
				code: callback.code,
				redirect_uri: REDIRECT_URI,
				client_id: CLIENT_ID,
				code_verifier: pkce.verifier,
				code_challenge: pkce.challenge,
				code_challenge_method: "S256",
			},
		});

		return credentialsFromTokens(tokens, discovery.tokenEndpoint);
	} finally {
		callbackServer.server.close();
	}
}

async function loginDeviceCode(callbacks: OAuthLoginCallbacks): Promise<XaiCredentials> {
	callbacks.onProgress?.("Starting xAI device code flow...");
	const discovery = await fetchDeviceCodeDiscovery();
	const deviceCode = await requestDeviceCode(discovery.deviceAuthorizationEndpoint);
	const expiresInMinutes = Math.max(1, Math.round(deviceCode.expiresInMs / 60_000));
	const browserUrl = deviceCode.verificationUriComplete ?? deviceCode.verificationUri;
	callbacks.onAuth({
		url: browserUrl,
		instructions: `Open ${deviceCode.verificationUri} and enter code: ${deviceCode.userCode}. Expires in ${expiresInMinutes} minutes.`,
	});
	callbacks.onProgress?.("Waiting for xAI device authorization...");
	const tokens = await pollDeviceCodeToken({
		tokenEndpoint: discovery.tokenEndpoint,
		deviceCode: deviceCode.deviceCode,
		expiresInMs: deviceCode.expiresInMs,
		intervalMs: deviceCode.intervalMs,
		onProgress: callbacks.onProgress,
	});
	return credentialsFromTokens(tokens, discovery.tokenEndpoint, "device-code");
}

function chooseLoginFlow(): "browser" | "device-code" {
	const envFlow = process.env.PI_XAI_OAUTH_FLOW;
	if (envFlow === "device-code" || envFlow === "browser") return envFlow;
	return "browser";
}

async function fetchXaiOAuthModels(accessToken: string): Promise<XaiOAuthModelConfig[]> {
	const response = await fetch(XAI_GROK_OAUTH_MODELS_URL, {
		headers: {
			Accept: "application/json",
			Authorization: `Bearer ${accessToken}`,
			...xaiGrokProxyHeaders(),
		},
		signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
	});
	if (!response.ok) return [];
	let payload: unknown = null;
	try {
		payload = await response.json();
	} catch {
		return [];
	}
	return buildXaiOAuthModelsFromResponse(payload);
}

async function attachXaiOAuthModels(credentials: XaiCredentials): Promise<XaiCredentials> {
	try {
		const accessToken = typeof credentials.access === "string" && credentials.access.trim() ? credentials.access : "";
		if (!accessToken) return credentials;
		const oauthModels = await fetchXaiOAuthModels(accessToken);
		return oauthModels.length > 0 ? { ...credentials, oauthModels } : credentials;
	} catch {
		return credentials;
	}
}

async function loginXai(callbacks: OAuthLoginCallbacks): Promise<XaiCredentials> {
	const flow = chooseLoginFlow();
	const credentials = flow === "device-code" ? await loginDeviceCode(callbacks) : await loginBrowser(callbacks);
	if (!credentials.refresh) {
		throw new Error("xAI OAuth login did not return a refresh token");
	}
	return attachXaiOAuthModels(credentials);
}

function credentialString(credentials: OAuthCredentials, key: keyof XaiCredentials): string | undefined {
	const value = (credentials as XaiCredentials)[key];
	return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

async function refreshXai(credentials: OAuthCredentials): Promise<XaiCredentials> {
	const refreshToken = credentialString(credentials, "refresh");
	if (!refreshToken) throw new Error("xAI OAuth credential is missing refresh token");
	const tokenEndpoint = credentialString(credentials, "tokenEndpoint") ?? (await fetchOAuthDiscovery()).tokenEndpoint;
	const tokens = await exchangeToken({
		tokenEndpoint,
		context: "xAI OAuth refresh",
		body: {
			grant_type: "refresh_token",
			client_id: CLIENT_ID,
			refresh_token: refreshToken,
		},
	});
	const refreshedCredentials = {
		...(credentials as XaiCredentials),
		...credentialsFromTokens(
			{
				...tokens,
				refreshToken: tokens.refreshToken ?? refreshToken,
			},
			tokenEndpoint,
			credentialString(credentials, "authFlow"),
		),
	};
	return attachXaiOAuthModels(refreshedCredentials);
}

function normalizeXaiModelId(modelId: string): string {
	const lower = modelId.trim().toLowerCase();
	const unprefixed = lower.startsWith("xai/") ? lower.slice("xai/".length) : lower;
	return XAI_MODEL_ID_ALIASES.get(unprefixed) ?? unprefixed;
}

function rememberXaiModelInputs(models: Array<{ id: string; input?: ReadonlyArray<"text" | "image"> }>): void {
	xaiModelInputsById.clear();
	for (const model of models) {
		if (!Array.isArray(model.input) || model.input.length === 0) continue;
		xaiModelInputsById.set(normalizeXaiModelId(model.id), model.input);
	}
}

function isXaiModelId(modelId: string): boolean {
	const normalized = normalizeXaiModelId(modelId);
	return XAI_SELECTABLE_MODEL_IDS.has(normalized) || normalized.startsWith("grok-");
}

function supportsConfigurableXaiReasoningEffort(modelId: string): boolean {
	const normalized = normalizeXaiModelId(modelId);
	return (
		(normalized === "grok-4.5" ||
			normalized.startsWith("grok-4.5-") ||
			normalized === "grok-4.3" ||
			normalized.startsWith("grok-4.3-")) &&
		!normalized.includes("non-reasoning")
	);
}

function supportsExplicitImageInput(modelId: string): boolean {
	const normalized = normalizeXaiModelId(modelId);
	const resolvedInput = xaiModelInputsById.get(normalized);
	if (resolvedInput) return resolvedInput.includes("image");
	return (
		normalized === "grok-build-0.1" ||
		normalized === "grok-build" ||
		normalized.startsWith("grok-4.5") ||
		normalized.startsWith("grok-4.3") ||
		normalized.startsWith("grok-4.20") ||
		normalized.startsWith("grok-4-fast") ||
		normalized.startsWith("grok-4-1-fast")
	);
}

function stripUnsupportedSchemaKeywords(value: unknown): unknown {
	if (Array.isArray(value)) {
		let changed = false;
		const next = value.map((item) => {
			const normalized = stripUnsupportedSchemaKeywords(item);
			changed ||= normalized !== item;
			return normalized;
		});
		return changed ? next : value;
	}

	if (!value || typeof value !== "object") return value;

	const valueObject = value as Record<string, unknown>;
	let changed = false;
	const next: Record<string, unknown> = {};
	for (const [key, child] of Object.entries(valueObject)) {
		if (XAI_UNSUPPORTED_SCHEMA_KEYWORDS.has(key)) {
			changed = true;
			continue;
		}
		const normalized = stripUnsupportedSchemaKeywords(child);
		next[key] = normalized;
		changed ||= normalized !== child;
	}
	return changed ? next : value;
}

function stripUnsupportedStrictFlag(tool: unknown): unknown {
	if (!tool || typeof tool !== "object" || Array.isArray(tool)) return tool;
	const toolObject = tool as Record<string, unknown>;
	let nextTool: Record<string, unknown> | null = null;
	if (typeof toolObject.strict === "boolean") {
		nextTool = { ...toolObject };
		delete nextTool.strict;
	}
	if (toolObject.parameters && typeof toolObject.parameters === "object") {
		nextTool = nextTool ?? { ...toolObject };
		nextTool.parameters = stripUnsupportedSchemaKeywords(toolObject.parameters);
	}
	const fn = toolObject.function;
	if (!fn || typeof fn !== "object" || Array.isArray(fn)) return nextTool ?? tool;
	const fnObject = fn as Record<string, unknown>;
	let nextFunction: Record<string, unknown> | null = null;
	if (typeof fnObject.strict === "boolean") {
		nextFunction = { ...fnObject };
		delete nextFunction.strict;
	}
	if (fnObject.parameters && typeof fnObject.parameters === "object") {
		nextFunction = nextFunction ?? { ...fnObject };
		nextFunction.parameters = stripUnsupportedSchemaKeywords(fnObject.parameters);
	}
	if (!nextFunction) return nextTool ?? tool;
	return { ...(nextTool ?? toolObject), function: nextFunction };
}

const TOOL_RESULT_IMAGE_REPLAY_TEXT = "Attached image(s) from tool result:";

function isReplayableInputImagePart(part: Record<string, unknown>): boolean {
	if (part.type !== "input_image") return false;
	if (typeof part.image_url === "string") return true;
	if (!part.source || typeof part.source !== "object" || Array.isArray(part.source)) return false;
	const source = part.source as Record<string, unknown>;
	if (source.type === "url") return typeof source.url === "string";
	return source.type === "base64" && typeof source.media_type === "string" && typeof source.data === "string";
}

function normalizeXaiResponsesFunctionCallOutput(
	item: unknown,
	includeImages: boolean,
): { normalizedItem: unknown; imageParts: Array<Record<string, unknown>> } {
	if (!item || typeof item !== "object" || Array.isArray(item)) {
		return { normalizedItem: item, imageParts: [] };
	}

	const itemObject = item as Record<string, unknown>;
	if (itemObject.type !== "function_call_output" || !Array.isArray(itemObject.output)) {
		return { normalizedItem: itemObject, imageParts: [] };
	}

	const outputParts = itemObject.output.filter(
		(part): part is Record<string, unknown> =>
			Boolean(part) && typeof part === "object" && !Array.isArray(part),
	);
	const textOutput = outputParts
		.filter(
			(part): part is { type: "input_text"; text: string } =>
				part.type === "input_text" && typeof part.text === "string",
		)
		.map((part) => part.text)
		.join("");
	const imageParts = includeImages ? outputParts.filter((part) => isReplayableInputImagePart(part)) : [];
	const hadNonTextParts = outputParts.some((part) => part.type !== "input_text");

	return {
		normalizedItem: {
			...itemObject,
			output: textOutput || (hadNonTextParts ? "(see attached image)" : ""),
		},
		imageParts,
	};
}

function normalizeXaiResponsesToolResultPayload(payloadObject: Record<string, unknown>, modelId: string): void {
	if (!Array.isArray(payloadObject.input)) return;

	const includeImages = supportsExplicitImageInput(modelId);
	const normalizedInput: unknown[] = [];

	for (const item of payloadObject.input) {
		const normalized = normalizeXaiResponsesFunctionCallOutput(item, includeImages);
		normalizedInput.push(normalized.normalizedItem);
		if (normalized.imageParts.length > 0) {
			normalizedInput.push({
				type: "message",
				role: "user",
				content: [{ type: "input_text", text: TOOL_RESULT_IMAGE_REPLAY_TEXT }, ...normalized.imageParts],
			});
		}
	}

	payloadObject.input = normalizedInput;
}

function stripXaiReasoningInclude(payloadObject: Record<string, unknown>): void {
	if (!Array.isArray(payloadObject.include)) return;
	const nextInclude = payloadObject.include.filter((entry) => entry !== XAI_REASONING_ENCRYPTED_CONTENT_INCLUDE);
	if (nextInclude.length === payloadObject.include.length) return;
	if (nextInclude.length === 0) {
		delete payloadObject.include;
		return;
	}
	payloadObject.include = nextInclude;
}

function normalizeXaiPayload(payload: unknown): unknown {
	if (!payload || typeof payload !== "object" || Array.isArray(payload)) return payload;
	const payloadObject = payload as Record<string, unknown>;
	const model = payloadObject.model;
	if (typeof model !== "string" || !isXaiModelId(model)) return payload;

	const normalizedModel = normalizeXaiModelId(model);
	const next = { ...payloadObject };
	if (normalizedModel !== model) {
		next.model = normalizedModel;
	}
	if (Array.isArray(next.tools)) {
		next.tools = next.tools.map((tool) => stripUnsupportedStrictFlag(tool));
	}
	normalizeXaiResponsesToolResultPayload(next, normalizedModel);
	if (!supportsConfigurableXaiReasoningEffort(normalizedModel)) {
		delete next.reasoning;
		delete next.reasoningEffort;
		delete next.reasoning_effort;
		stripXaiReasoningInclude(next);
	}
	return next;
}

function rewriteRegisteredXaiModel(model: RegisteredModel): RegisteredModel {
	return {
		...model,
		api: API_ID,
		baseUrl: XAI_GROK_OAUTH_BASE_URL,
	};
}

function fallbackRegisteredXaiModels(): RegisteredModel[] {
	return XAI_MODELS.map(
		(model) =>
			({
				...model,
				api: API_ID,
				provider: PROVIDER_ID,
				baseUrl: XAI_GROK_OAUTH_BASE_URL,
			}) as RegisteredModel,
	);
}

function mergeXaiOAuthModels(
	liveModels: XaiOAuthModelConfig[],
	staticModels: RegisteredModel[],
): RegisteredModel[] {
	const merged: RegisteredModel[] = [];
	const seen = new Set<string>();
	for (const model of [...liveModels, ...staticModels]) {
		const key = model.id.toLowerCase();
		if (seen.has(key)) continue;
		seen.add(key);
		merged.push(model);
	}
	return merged;
}

function rewriteXaiOAuthModels(models: RegisteredModel[], credentials: OAuthCredentials): RegisteredModel[] {
	const nonXaiModels = models.filter((model) => model.provider !== PROVIDER_ID);
	const staticXaiModels = models
		.filter((model) => model.provider === PROVIDER_ID)
		.map(rewriteRegisteredXaiModel);
	const fallbackXaiModels = staticXaiModels.length > 0 ? staticXaiModels : fallbackRegisteredXaiModels();
	const oauthModels = normalizeStoredXaiOAuthModels((credentials as XaiCredentials).oauthModels);
	if (oauthModels.length > 0) {
		const mergedXaiModels = mergeXaiOAuthModels(oauthModels, fallbackXaiModels);
		rememberXaiModelInputs(mergedXaiModels);
		return [...nonXaiModels, ...mergedXaiModels];
	}
	const rewrittenModels = [...nonXaiModels, ...fallbackXaiModels];
	rememberXaiModelInputs(rewrittenModels.filter((model) => model.provider === PROVIDER_ID));
	return rewrittenModels;
}

function decodeHtmlEntities(value: string): string {
	if (!value.includes("&")) return value;
	return value.replace(/&(?:amp|lt|gt|quot|apos|#39|#x27|#34|#x22);/gi, (entity) => {
		switch (entity.toLowerCase()) {
			case "&amp;":
				return "&";
			case "&lt;":
				return "<";
			case "&gt;":
				return ">";
			case "&quot;":
			case "&#34;":
			case "&#x22;":
				return '"';
			case "&apos;":
			case "&#39;":
			case "&#x27;":
				return "'";
			default:
				return entity;
		}
	});
}

function decodeHtmlEntityStringsInPlace(value: unknown): unknown {
	if (typeof value === "string") return decodeHtmlEntities(value);
	if (Array.isArray(value)) {
		for (let i = 0; i < value.length; i += 1) {
			value[i] = decodeHtmlEntityStringsInPlace(value[i]);
		}
		return value;
	}
	if (!value || typeof value !== "object") return value;
	for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
		(value as Record<string, unknown>)[key] = decodeHtmlEntityStringsInPlace(child);
	}
	return value;
}

export default function (pi: ExtensionAPI) {
	rememberXaiModelInputs(XAI_MODELS);
	pi.registerProvider(PROVIDER_ID, {
		baseUrl: XAI_GROK_OAUTH_BASE_URL,
		api: API_ID,
		headers: xaiGrokProxyHeaders(),
		models: XAI_MODELS,
		oauth: {
			name: "xAI OAuth",
			async login(callbacks) {
				return loginXai(callbacks);
			},
			async refreshToken(credentials) {
				return refreshXai(credentials);
			},
			getApiKey(credentials) {
				return credentials.access;
			},
			modifyModels(models, credentials) {
				return rewriteXaiOAuthModels(models, credentials);
			},
		},
	});

	pi.on("before_provider_request", (event) => normalizeXaiPayload(event.payload));
	pi.on("tool_call", (event, ctx) => {
		if (ctx.model?.provider !== PROVIDER_ID) return;
		decodeHtmlEntityStringsInPlace(event.input);
	});
}
