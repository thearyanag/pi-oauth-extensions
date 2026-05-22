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
import type { Api, Model, OAuthCredentials, OAuthLoginCallbacks } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const PROVIDER_ID = "xai";
const API_ID = "openai-responses" as Api;
const XAI_BASE_URL = "https://api.x.ai/v1";
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

const GROK_MODEL_IDS = new Set([
	"grok-build-0.1",
	"grok-4.3",
	"grok-4.20-beta-latest-reasoning",
	"grok-4.20-beta-latest-non-reasoning",
	"grok-4.20-0309-reasoning",
	"grok-4.20-0309-non-reasoning",
	"grok-code-fast-1",
]);

type XaiCredentials = OAuthCredentials & {
	tokenEndpoint?: unknown;
	idToken?: unknown;
	email?: unknown;
	displayName?: unknown;
	accountId?: unknown;
	authFlow?: unknown;
	issuer?: unknown;
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

type XaiModelConfig = {
	id: string;
	name: string;
	reasoning: boolean;
	thinkingLevelMap?: Model<Api>["thinkingLevelMap"];
	input: ("text" | "image")[];
	cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
	contextWindow: number;
	maxTokens: number;
};

const XAI_MODELS: XaiModelConfig[] = [
	{
		id: "grok-4.3",
		name: "Grok 4.3",
		reasoning: true,
		thinkingLevelMap: {
			off: null,
			minimal: "low",
			low: "low",
			medium: "medium",
			high: "high",
			xhigh: "high",
		},
		input: ["text", "image"],
		cost: { input: 1.25, output: 2.5, cacheRead: 0.2, cacheWrite: 0 },
		contextWindow: 1_000_000,
		maxTokens: 64_000,
	},
	{
		id: "grok-build-0.1",
		name: "Grok Build 0.1",
		reasoning: false,
		input: ["text", "image"],
		cost: { input: 1, output: 2, cacheRead: 0.2, cacheWrite: 0 },
		contextWindow: 256_000,
		maxTokens: 64_000,
	},
	{
		id: "grok-4.20-beta-latest-reasoning",
		name: "Grok 4.20 Beta Latest (Reasoning)",
		reasoning: false,
		input: ["text", "image"],
		cost: { input: 1.25, output: 2.5, cacheRead: 0.2, cacheWrite: 0 },
		contextWindow: 2_000_000,
		maxTokens: 30_000,
	},
	{
		id: "grok-4.20-beta-latest-non-reasoning",
		name: "Grok 4.20 Beta Latest (Non-Reasoning)",
		reasoning: false,
		input: ["text", "image"],
		cost: { input: 1.25, output: 2.5, cacheRead: 0.2, cacheWrite: 0 },
		contextWindow: 2_000_000,
		maxTokens: 30_000,
	},
	{
		id: "grok-4.20-0309-reasoning",
		name: "Grok 4.20 (Reasoning)",
		reasoning: false,
		input: ["text", "image"],
		cost: { input: 2, output: 6, cacheRead: 0.2, cacheWrite: 0 },
		contextWindow: 2_000_000,
		maxTokens: 30_000,
	},
	{
		id: "grok-4.20-0309-non-reasoning",
		name: "Grok 4.20 (Non-Reasoning)",
		reasoning: false,
		input: ["text", "image"],
		cost: { input: 2, output: 6, cacheRead: 0.2, cacheWrite: 0 },
		contextWindow: 2_000_000,
		maxTokens: 30_000,
	},
	{
		id: "grok-code-fast-1",
		name: "Grok Code Fast 1",
		reasoning: false,
		input: ["text"],
		cost: { input: 0.2, output: 1.5, cacheRead: 0.02, cacheWrite: 0 },
		contextWindow: 256_000,
		maxTokens: 10_000,
	},
];

function xaiUserAgent(): string {
	return "pi-coding-agent";
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
	url.searchParams.set("referrer", "pi");
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
		throw new Error("xAI OAuth token response is missing refresh_token");
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

async function chooseLoginFlow(callbacks: OAuthLoginCallbacks): Promise<"browser" | "device-code"> {
	const envFlow = process.env.PI_XAI_OAUTH_FLOW;
	if (envFlow === "device-code" || envFlow === "browser") return envFlow;
	if (!callbacks.onSelect) return "browser";
	const selected = await callbacks.onSelect({
		message: "Select xAI login flow",
		options: [
			{ id: "browser", label: "Browser OAuth" },
			{ id: "device-code", label: "Device code" },
		],
	});
	if (selected === "browser" || selected === "device-code") return selected;
	throw new Error("Login cancelled");
}

async function loginXai(callbacks: OAuthLoginCallbacks): Promise<XaiCredentials> {
	const flow = await chooseLoginFlow(callbacks);
	const credentials = flow === "device-code" ? await loginDeviceCode(callbacks) : await loginBrowser(callbacks);
	if (!credentials.refresh) {
		throw new Error("xAI OAuth login did not return a refresh token");
	}
	return credentials;
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
	return {
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
}

function stripUnsupportedStrictFlag(tool: unknown): unknown {
	if (!tool || typeof tool !== "object" || Array.isArray(tool)) return tool;
	const toolObject = tool as Record<string, unknown>;
	const fn = toolObject.function;
	if (!fn || typeof fn !== "object" || Array.isArray(fn)) return tool;
	const fnObject = fn as Record<string, unknown>;
	if (typeof fnObject.strict !== "boolean") return tool;
	const nextFunction = { ...fnObject };
	delete nextFunction.strict;
	return { ...toolObject, function: nextFunction };
}

function normalizeXaiPayload(payload: unknown): unknown {
	if (!payload || typeof payload !== "object" || Array.isArray(payload)) return payload;
	const payloadObject = payload as Record<string, unknown>;
	const model = payloadObject.model;
	if (typeof model !== "string" || !GROK_MODEL_IDS.has(model)) return payload;

	const next = { ...payloadObject };
	if (Array.isArray(next.tools)) {
		next.tools = next.tools.map((tool) => stripUnsupportedStrictFlag(tool));
	}
	if (model !== "grok-4.3") {
		delete next.reasoning;
		delete next.reasoningEffort;
		delete next.reasoning_effort;
	}
	return next;
}

export default function (pi: ExtensionAPI) {
	pi.registerProvider(PROVIDER_ID, {
		name: "xAI",
		baseUrl: XAI_BASE_URL,
		api: API_ID,
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
		},
	});

	pi.on("before_provider_request", (event) => normalizeXaiPayload(event.payload));
}
