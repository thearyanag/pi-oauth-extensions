/**
 * Google Gemini CLI OAuth provider extension.
 *
 * Restores the removed `google-gemini-cli` provider as an extension for Pi
 * releases where it is no longer built in.
 *
 * Usage:
 *   pi -e ./packages/coding-agent/examples/extensions/google-gemini-cli
 *   # then /login google-gemini-cli if credentials are not already present
 */

import { createServer, type Server } from "node:http";
import {
	type Api,
	type AssistantMessage,
	type AssistantMessageEventStream,
	type Context,
	calculateCost,
	createAssistantMessageEventStream,
	type ImageContent,
	type Message,
	type Model,
	type OAuthCredentials,
	type OAuthLoginCallbacks,
	type SimpleStreamOptions,
	type StopReason,
	type TextContent,
	type ThinkingContent,
	type Tool,
	type ToolCall,
	type ToolResultMessage,
	type Usage,
} from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const PROVIDER_ID = "google-gemini-cli";
const API_ID = "google-gemini-cli" as Api;
const CALLBACK_HOST = process.env.PI_OAUTH_CALLBACK_HOST || "127.0.0.1";
const CALLBACK_PORT = 8085;
const REDIRECT_URI = "http://localhost:8085/oauth2callback";
const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const CODE_ASSIST_ENDPOINT = "https://cloudcode-pa.googleapis.com";
const CLIENT_ID_ENV = "GOOGLE_GEMINI_CLI_OAUTH_CLIENT_ID";
const CLIENT_SECRET_ENV = "GOOGLE_GEMINI_CLI_OAUTH_CLIENT_SECRET";
const SCOPES = [
	"https://www.googleapis.com/auth/cloud-platform",
	"https://www.googleapis.com/auth/userinfo.email",
	"https://www.googleapis.com/auth/userinfo.profile",
];

const GEMINI_CLI_HEADERS = {
	"User-Agent": "google-cloud-sdk vscode_cloudshelleditor/0.1",
	"X-Goog-Api-Client": "gl-node/22.17.0",
	"Client-Metadata": JSON.stringify({
		ideType: "IDE_UNSPECIFIED",
		platform: "PLATFORM_UNSPECIFIED",
		pluginType: "GEMINI",
	}),
};

const TIER_FREE = "free-tier";
const TIER_LEGACY = "legacy-tier";
const TIER_STANDARD = "standard-tier";
const MAX_RETRIES = 3;
const BASE_DELAY_MS = 1000;
const MAX_EMPTY_STREAM_RETRIES = 2;
const EMPTY_STREAM_BASE_DELAY_MS = 500;
const SKIP_THOUGHT_SIGNATURE = "skip_thought_signature_validator";

type GeminiCliModel = Model<Api>;

type GeminiCliCredentials = OAuthCredentials & {
	projectId?: unknown;
	email?: unknown;
};

type OAuthCallbackResult = {
	code: string;
	state: string;
};

type CallbackServer = {
	server: Server;
	cancelWait(): void;
	waitForCode(): Promise<OAuthCallbackResult | null>;
};

type CloudCodeTier = {
	id: string;
	isDefault?: boolean;
};

type LoadCodeAssistResponse = {
	currentTier?: CloudCodeTier;
	allowedTiers?: CloudCodeTier[];
	cloudaicompanionProject?: string;
	error?: {
		details?: Array<{ reason?: string }>;
	};
};

type OperationResponse = {
	done?: boolean;
	name?: string;
	response?: {
		cloudaicompanionProject?: {
			id?: string;
		};
	};
};

type GeminiPart = {
	text?: string;
	thought?: boolean;
	thoughtSignature?: string;
	inlineData?: {
		mimeType: string;
		data: string;
	};
	functionCall?: {
		name?: string;
		args?: Record<string, unknown>;
		id?: string;
	};
	functionResponse?: {
		name: string;
		response: Record<string, string>;
		id?: string;
		parts?: GeminiPart[];
	};
};

type GeminiContent = {
	role: "user" | "model";
	parts: GeminiPart[];
};

type GeminiRequest = {
	contents: GeminiContent[];
	sessionId?: string;
	systemInstruction?: {
		parts: Array<{ text: string }>;
	};
	generationConfig?: {
		temperature?: number;
		maxOutputTokens?: number;
		thinkingConfig?: {
			includeThoughts?: boolean;
			thinkingBudget?: number;
			thinkingLevel?: string;
		};
	};
	tools?: Array<{ functionDeclarations: Array<Record<string, unknown>> }>;
	toolConfig?: {
		functionCallingConfig: {
			mode: "AUTO" | "NONE" | "ANY";
		};
	};
};

type CloudCodeRequest = {
	project: string;
	model: string;
	request: GeminiRequest;
	userAgent: "pi-coding-agent";
	requestId: string;
};

type StreamOptionsWithThinking = SimpleStreamOptions & {
	thinking?: {
		enabled: boolean;
		budgetTokens?: number;
		level?: string;
	};
	toolChoice?: "auto" | "none" | "any";
};

type GeminiCandidate = {
	content?: {
		parts?: GeminiPart[];
	};
	finishReason?: string;
};

type GeminiStreamPayload = {
	response?: {
		responseId?: string;
		candidates?: GeminiCandidate[];
		usageMetadata?: {
			promptTokenCount?: number;
			cachedContentTokenCount?: number;
			candidatesTokenCount?: number;
			thoughtsTokenCount?: number;
			totalTokenCount?: number;
		};
	};
};

export const MODELS = [
	{
		id: "gemini-2.0-flash",
		name: "Gemini 2.0 Flash (Cloud Code Assist)",
		reasoning: false,
		input: ["text", "image"] as const,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1048576,
		maxTokens: 8192,
	},
	{
		id: "gemini-2.5-flash",
		name: "Gemini 2.5 Flash (Cloud Code Assist)",
		reasoning: true,
		input: ["text", "image"] as const,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1048576,
		maxTokens: 65535,
	},
	{
		id: "gemini-2.5-pro",
		name: "Gemini 2.5 Pro (Cloud Code Assist)",
		reasoning: true,
		input: ["text", "image"] as const,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1048576,
		maxTokens: 65535,
	},
	{
		id: "gemini-3-flash-preview",
		name: "Gemini 3 Flash Preview (Cloud Code Assist)",
		reasoning: true,
		input: ["text", "image"] as const,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1048576,
		maxTokens: 65535,
	},
	{
		id: "gemini-3-pro-preview",
		name: "Gemini 3 Pro Preview (Cloud Code Assist)",
		reasoning: true,
		input: ["text", "image"] as const,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1048576,
		maxTokens: 65535,
	},
	{
		id: "gemini-3.1-flash-lite-preview",
		name: "Gemini 3.1 Flash Lite Preview (Cloud Code Assist)",
		reasoning: true,
		input: ["text", "image"] as const,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1048576,
		maxTokens: 65535,
	},
	{
		id: "gemini-3.1-pro-preview",
		name: "Gemini 3.1 Pro Preview (Cloud Code Assist)",
		reasoning: true,
		input: ["text", "image"] as const,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1048576,
		maxTokens: 65535,
	},
];

const LOGO_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 800 800" aria-hidden="true"><path fill="#fff" fill-rule="evenodd" d="M165.29 165.29 H517.36 V400 H400 V517.36 H282.65 V634.72 H165.29 Z M282.65 282.65 V400 H400 V282.65 Z"/><path fill="#fff" d="M517.36 400 H634.72 V634.72 H517.36 Z"/></svg>`;

function oauthSuccessHtml(message: string): string {
	return renderOAuthPage({
		title: "Authentication successful",
		heading: "Authentication successful",
		message,
	});
}

function oauthErrorHtml(message: string, details?: string): string {
	return renderOAuthPage({
		title: "Authentication failed",
		heading: "Authentication failed",
		message,
		details,
	});
}

function renderOAuthPage(options: { title: string; heading: string; message: string; details?: string }): string {
	const title = escapeHtml(options.title);
	const heading = escapeHtml(options.heading);
	const message = escapeHtml(options.message);
	const details = options.details ? escapeHtml(options.details) : undefined;
	return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${title}</title>
  <style>
    :root {
      --text: #fafafa;
      --text-dim: #a1a1aa;
      --page-bg: #09090b;
      --font-sans: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, "Noto Sans", sans-serif, "Apple Color Emoji", "Segoe UI Emoji", "Segoe UI Symbol", "Noto Color Emoji";
      --font-mono: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace;
    }
    * { box-sizing: border-box; }
    html { color-scheme: dark; }
    body {
      margin: 0;
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 24px;
      background: var(--page-bg);
      color: var(--text);
      font-family: var(--font-sans);
      text-align: center;
    }
    main {
      width: 100%;
      max-width: 560px;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
    }
    .logo {
      width: 72px;
      height: 72px;
      display: block;
      margin-bottom: 24px;
    }
    h1 {
      margin: 0 0 10px;
      font-size: 28px;
      line-height: 1.15;
      font-weight: 650;
      color: var(--text);
    }
    p {
      margin: 0;
      line-height: 1.7;
      color: var(--text-dim);
      font-size: 15px;
    }
    .details {
      margin-top: 16px;
      font-family: var(--font-mono);
      font-size: 13px;
      color: var(--text-dim);
      white-space: pre-wrap;
      word-break: break-word;
    }
  </style>
</head>
<body>
  <main>
    <div class="logo">${LOGO_SVG}</div>
    <h1>${heading}</h1>
    <p>${message}</p>
    ${details ? `<div class="details">${details}</div>` : ""}
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
	const verifierBytes = new Uint8Array(32);
	crypto.getRandomValues(verifierBytes);
	const verifier = base64urlEncode(verifierBytes);
	const hashBuffer = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
	return { verifier, challenge: base64urlEncode(new Uint8Array(hashBuffer)) };
}

async function startCallbackServer(): Promise<CallbackServer> {
	return new Promise((resolve, reject) => {
		let settleWait: ((value: OAuthCallbackResult | null) => void) | undefined;
		const waitForCodePromise = new Promise<OAuthCallbackResult | null>((resolveWait) => {
			let settled = false;
			settleWait = (value) => {
				if (settled) return;
				settled = true;
				resolveWait(value);
			};
		});

		const server = createServer((req, res) => {
			const url = new URL(req.url || "", `http://localhost:${CALLBACK_PORT}`);
			if (url.pathname !== "/oauth2callback") {
				res.writeHead(404, { "Content-Type": "text/html; charset=utf-8" });
				res.end(oauthErrorHtml("Callback route not found."));
				return;
			}

			const code = url.searchParams.get("code");
			const state = url.searchParams.get("state");
			const error = url.searchParams.get("error");
			if (error) {
				res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
				res.end(oauthErrorHtml("Google authentication did not complete.", `Error: ${error}`));
				return;
			}

			if (!code || !state) {
				res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
				res.end(oauthErrorHtml("Missing code or state parameter."));
				return;
			}

			res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
			res.end(oauthSuccessHtml("Google authentication completed. You can close this window."));
			settleWait?.({ code, state });
		});

		server.on("error", reject);
		server.listen(CALLBACK_PORT, CALLBACK_HOST, () => {
			resolve({
				server,
				cancelWait: () => settleWait?.(null),
				waitForCode: () => waitForCodePromise,
			});
		});
	});
}

function parseRedirectUrl(input: string): { code?: string; state?: string } {
	const value = input.trim();
	if (!value) return {};
	try {
		const url = new URL(value);
		return {
			code: url.searchParams.get("code") ?? undefined,
			state: url.searchParams.get("state") ?? undefined,
		};
	} catch {
		return {};
	}
}

function getOAuthClientCredentials(): { clientId: string; clientSecret: string } {
	const clientId = process.env[CLIENT_ID_ENV];
	const clientSecret = process.env[CLIENT_SECRET_ENV];
	if (!clientId || !clientSecret) {
		throw new Error(
			`Google Gemini CLI OAuth requires ${CLIENT_ID_ENV} and ${CLIENT_SECRET_ENV} environment variables.`,
		);
	}
	return { clientId, clientSecret };
}

function wait(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function getDefaultTier(allowedTiers: CloudCodeTier[] | undefined): CloudCodeTier {
	if (!allowedTiers || allowedTiers.length === 0) return { id: TIER_LEGACY };
	return allowedTiers.find((tier) => tier.isDefault) ?? { id: TIER_LEGACY };
}

function isVpcScAffectedUser(payload: LoadCodeAssistResponse | undefined): boolean {
	return payload?.error?.details?.some((detail) => detail.reason === "SECURITY_POLICY_VIOLATED") ?? false;
}

async function pollOperation(
	operationName: string,
	headers: Record<string, string>,
	onProgress: OAuthLoginCallbacks["onProgress"],
): Promise<OperationResponse> {
	let attempt = 0;
	while (true) {
		if (attempt > 0) {
			onProgress?.(`Waiting for project provisioning (attempt ${attempt + 1})...`);
			await wait(5000);
		}

		const response = await fetch(`${CODE_ASSIST_ENDPOINT}/v1internal/${operationName}`, {
			method: "GET",
			headers,
		});
		if (!response.ok) {
			throw new Error(`Failed to poll operation: ${response.status} ${response.statusText}`);
		}

		const data = (await response.json()) as OperationResponse;
		if (data.done) return data;
		attempt += 1;
	}
}

async function discoverProject(accessToken: string, onProgress: OAuthLoginCallbacks["onProgress"]): Promise<string> {
	const envProjectId = process.env.GOOGLE_CLOUD_PROJECT || process.env.GOOGLE_CLOUD_PROJECT_ID;
	const headers = {
		Authorization: `Bearer ${accessToken}`,
		"Content-Type": "application/json",
		"User-Agent": "google-api-nodejs-client/9.15.1",
		"X-Goog-Api-Client": "gl-node/22.17.0",
	};

	onProgress?.("Checking for existing Cloud Code Assist project...");
	const loadResponse = await fetch(`${CODE_ASSIST_ENDPOINT}/v1internal:loadCodeAssist`, {
		method: "POST",
		headers,
		body: JSON.stringify({
			cloudaicompanionProject: envProjectId,
			metadata: {
				ideType: "IDE_UNSPECIFIED",
				platform: "PLATFORM_UNSPECIFIED",
				pluginType: "GEMINI",
				duetProject: envProjectId,
			},
		}),
	});

	let data: LoadCodeAssistResponse;
	if (!loadResponse.ok) {
		let errorPayload: LoadCodeAssistResponse | undefined;
		try {
			errorPayload = (await loadResponse.clone().json()) as LoadCodeAssistResponse;
		} catch {
			errorPayload = undefined;
		}
		if (isVpcScAffectedUser(errorPayload)) {
			data = { currentTier: { id: TIER_STANDARD } };
		} else {
			throw new Error(
				`loadCodeAssist failed: ${loadResponse.status} ${loadResponse.statusText}: ${await loadResponse.text()}`,
			);
		}
	} else {
		data = (await loadResponse.json()) as LoadCodeAssistResponse;
	}

	if (data.currentTier) {
		if (data.cloudaicompanionProject) return data.cloudaicompanionProject;
		if (envProjectId) return envProjectId;
		throw new Error(
			"This account requires setting the GOOGLE_CLOUD_PROJECT or GOOGLE_CLOUD_PROJECT_ID environment variable. See https://goo.gle/gemini-cli-auth-docs#workspace-gca",
		);
	}

	const tierId = getDefaultTier(data.allowedTiers).id || TIER_FREE;
	if (tierId !== TIER_FREE && !envProjectId) {
		throw new Error(
			"This account requires setting the GOOGLE_CLOUD_PROJECT or GOOGLE_CLOUD_PROJECT_ID environment variable. See https://goo.gle/gemini-cli-auth-docs#workspace-gca",
		);
	}

	onProgress?.("Provisioning Cloud Code Assist project (this may take a moment)...");
	const onboardBody: {
		tierId: string;
		cloudaicompanionProject?: string;
		metadata: {
			ideType: string;
			platform: string;
			pluginType: string;
			duetProject?: string;
		};
	} = {
		tierId,
		metadata: {
			ideType: "IDE_UNSPECIFIED",
			platform: "PLATFORM_UNSPECIFIED",
			pluginType: "GEMINI",
		},
	};
	if (tierId !== TIER_FREE && envProjectId) {
		onboardBody.cloudaicompanionProject = envProjectId;
		onboardBody.metadata.duetProject = envProjectId;
	}

	const onboardResponse = await fetch(`${CODE_ASSIST_ENDPOINT}/v1internal:onboardUser`, {
		method: "POST",
		headers,
		body: JSON.stringify(onboardBody),
	});
	if (!onboardResponse.ok) {
		throw new Error(
			`onboardUser failed: ${onboardResponse.status} ${onboardResponse.statusText}: ${await onboardResponse.text()}`,
		);
	}

	let operationData = (await onboardResponse.json()) as OperationResponse;
	if (!operationData.done && operationData.name) {
		operationData = await pollOperation(operationData.name, headers, onProgress);
	}

	const projectId = operationData.response?.cloudaicompanionProject?.id;
	if (projectId) return projectId;
	if (envProjectId) return envProjectId;
	throw new Error(
		"Could not discover or provision a Google Cloud project. Try setting the GOOGLE_CLOUD_PROJECT or GOOGLE_CLOUD_PROJECT_ID environment variable. See https://goo.gle/gemini-cli-auth-docs#workspace-gca",
	);
}

async function getUserEmail(accessToken: string): Promise<string | undefined> {
	try {
		const response = await fetch("https://www.googleapis.com/oauth2/v1/userinfo?alt=json", {
			headers: { Authorization: `Bearer ${accessToken}` },
		});
		if (!response.ok) return undefined;
		const data = (await response.json()) as { email?: string };
		return data.email;
	} catch {
		return undefined;
	}
}

async function refreshGoogleCloudToken(refreshToken: string, projectId: string): Promise<GeminiCliCredentials> {
	const { clientId, clientSecret } = getOAuthClientCredentials();
	const response = await fetch(TOKEN_URL, {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams({
			client_id: clientId,
			client_secret: clientSecret,
			refresh_token: refreshToken,
			grant_type: "refresh_token",
		}),
	});
	if (!response.ok) {
		throw new Error(`Google Cloud token refresh failed: ${await response.text()}`);
	}

	const data = (await response.json()) as { access_token: string; refresh_token?: string; expires_in: number };
	return {
		refresh: data.refresh_token || refreshToken,
		access: data.access_token,
		expires: Date.now() + data.expires_in * 1000 - 5 * 60 * 1000,
		projectId,
	};
}

async function loginGeminiCli(callbacks: OAuthLoginCallbacks): Promise<GeminiCliCredentials> {
	const { clientId, clientSecret } = getOAuthClientCredentials();
	const { verifier, challenge } = await generatePKCE();
	callbacks.onProgress?.("Starting local server for OAuth callback...");
	const callbackServer = await startCallbackServer();

	try {
		const authParams = new URLSearchParams({
			client_id: clientId,
			response_type: "code",
			redirect_uri: REDIRECT_URI,
			scope: SCOPES.join(" "),
			code_challenge: challenge,
			code_challenge_method: "S256",
			state: verifier,
			access_type: "offline",
			prompt: "consent",
		});

		callbacks.onAuth({
			url: `${AUTH_URL}?${authParams.toString()}`,
			instructions: "Complete the sign-in in your browser.",
		});

		callbacks.onProgress?.("Waiting for OAuth callback...");
		const code = await waitForOAuthCode(callbackServer, verifier, callbacks.onManualCodeInput);
		if (!code) throw new Error("No authorization code received");

		callbacks.onProgress?.("Exchanging authorization code for tokens...");
		const tokenResponse = await fetch(TOKEN_URL, {
			method: "POST",
			headers: { "Content-Type": "application/x-www-form-urlencoded" },
			body: new URLSearchParams({
				client_id: clientId,
				client_secret: clientSecret,
				code,
				grant_type: "authorization_code",
				redirect_uri: REDIRECT_URI,
				code_verifier: verifier,
			}),
		});
		if (!tokenResponse.ok) throw new Error(`Token exchange failed: ${await tokenResponse.text()}`);

		const tokenData = (await tokenResponse.json()) as {
			access_token: string;
			refresh_token?: string;
			expires_in: number;
		};
		if (!tokenData.refresh_token) throw new Error("No refresh token received. Please try again.");

		callbacks.onProgress?.("Getting user info...");
		const email = await getUserEmail(tokenData.access_token);
		const projectId = await discoverProject(tokenData.access_token, callbacks.onProgress);

		return {
			refresh: tokenData.refresh_token,
			access: tokenData.access_token,
			expires: Date.now() + tokenData.expires_in * 1000 - 5 * 60 * 1000,
			projectId,
			email,
		};
	} finally {
		callbackServer.server.close();
	}
}

async function waitForOAuthCode(
	callbackServer: CallbackServer,
	verifier: string,
	onManualCodeInput: OAuthLoginCallbacks["onManualCodeInput"],
): Promise<string | undefined> {
	if (!onManualCodeInput) {
		const result = await callbackServer.waitForCode();
		if (result?.state && result.state !== verifier) throw new Error("OAuth state mismatch - possible CSRF attack");
		return result?.code;
	}

	let manualInput: string | undefined;
	let manualError: Error | undefined;
	const manualPromise = onManualCodeInput()
		.then((input) => {
			manualInput = input;
			callbackServer.cancelWait();
		})
		.catch((error) => {
			manualError = error instanceof Error ? error : new Error(String(error));
			callbackServer.cancelWait();
		});

	const callbackResult = await callbackServer.waitForCode();
	if (manualError) throw manualError;
	if (callbackResult?.code) {
		if (callbackResult.state !== verifier) throw new Error("OAuth state mismatch - possible CSRF attack");
		return callbackResult.code;
	}

	await manualPromise;
	if (manualError) throw manualError;
	if (!manualInput) return undefined;

	const parsed = parseRedirectUrl(manualInput);
	if (parsed.state && parsed.state !== verifier) throw new Error("OAuth state mismatch - possible CSRF attack");
	return parsed.code;
}

function getCredentialProjectId(credentials: OAuthCredentials): string {
	const projectId = (credentials as GeminiCliCredentials).projectId;
	if (typeof projectId !== "string" || !projectId) {
		throw new Error("Google Cloud credentials missing projectId");
	}
	return projectId;
}

function sanitizeSurrogates(text: string): string {
	return text.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, "");
}

function replaceImagesWithPlaceholder(content: (TextContent | ImageContent)[], placeholder: string): TextContent[] {
	const result: TextContent[] = [];
	let previousWasPlaceholder = false;

	for (const block of content) {
		if (block.type === "image") {
			if (!previousWasPlaceholder) {
				result.push({ type: "text", text: placeholder });
			}
			previousWasPlaceholder = true;
			continue;
		}

		result.push(block);
		previousWasPlaceholder = block.text === placeholder;
	}

	return result;
}

function transformMessages(messages: Message[], model: GeminiCliModel): Message[] {
	const imageAwareMessages = model.input.includes("image")
		? messages
		: messages.map((msg) => {
				if (msg.role === "user" && Array.isArray(msg.content)) {
					return {
						...msg,
						content: replaceImagesWithPlaceholder(msg.content, "(image omitted: model does not support images)"),
					};
				}
				if (msg.role === "toolResult") {
					return {
						...msg,
						content: replaceImagesWithPlaceholder(
							msg.content,
							"(tool image omitted: model does not support images)",
						),
					};
				}
				return msg;
			});

	const result: Message[] = [];
	let pendingToolCalls: ToolCall[] = [];
	let existingToolResultIds = new Set<string>();

	const insertSyntheticToolResults = () => {
		if (pendingToolCalls.length === 0) return;
		for (const toolCall of pendingToolCalls) {
			if (!existingToolResultIds.has(toolCall.id)) {
				result.push({
					role: "toolResult",
					toolCallId: toolCall.id,
					toolName: toolCall.name,
					content: [{ type: "text", text: "No result provided" }],
					isError: true,
					timestamp: Date.now(),
				} satisfies ToolResultMessage);
			}
		}
		pendingToolCalls = [];
		existingToolResultIds = new Set();
	};

	for (const msg of imageAwareMessages) {
		if (msg.role === "assistant") {
			insertSyntheticToolResults();
			if (msg.stopReason === "error" || msg.stopReason === "aborted") continue;
			const isSameModel = msg.provider === model.provider && msg.api === model.api && msg.model === model.id;
			const content: AssistantMessage["content"] = [];
			for (const block of msg.content) {
				if (block.type === "thinking") {
					if (block.redacted) {
						if (isSameModel) content.push(block);
						continue;
					}
					if (isSameModel && block.thinkingSignature) {
						content.push(block);
						continue;
					}
					if (!block.thinking.trim()) continue;
					content.push(isSameModel ? block : { type: "text", text: block.thinking });
					continue;
				}
				if (block.type === "toolCall" && !isSameModel && block.thoughtSignature) {
					const normalized: ToolCall = { ...block };
					delete normalized.thoughtSignature;
					content.push(normalized);
					continue;
				}
				content.push(block);
			}
			const transformedAssistant = { ...msg, content };
			pendingToolCalls = content.filter((block): block is ToolCall => block.type === "toolCall");
			existingToolResultIds = new Set();
			result.push(transformedAssistant);
			continue;
		}

		if (msg.role === "toolResult") {
			existingToolResultIds.add(msg.toolCallId);
			result.push(msg);
			continue;
		}

		insertSyntheticToolResults();
		result.push(msg);
	}

	insertSyntheticToolResults();
	return result;
}

function isThinkingPart(part: Pick<GeminiPart, "thought" | "thoughtSignature">): boolean {
	return part.thought === true;
}

function retainThoughtSignature(existing: string | undefined, incoming: string | undefined): string | undefined {
	if (typeof incoming === "string" && incoming.length > 0) return incoming;
	return existing;
}

function isValidThoughtSignature(signature: string | undefined): boolean {
	if (!signature) return false;
	if (signature.length % 4 !== 0) return false;
	return /^[A-Za-z0-9+/]+={0,2}$/.test(signature);
}

function resolveThoughtSignature(isSameProviderAndModel: boolean, signature: string | undefined): string | undefined {
	return isSameProviderAndModel && isValidThoughtSignature(signature) ? signature : undefined;
}

function requiresToolCallId(modelId: string): boolean {
	return modelId.startsWith("claude-") || modelId.startsWith("gpt-oss-");
}

function supportsMultimodalFunctionResponse(modelId: string): boolean {
	const match = modelId.toLowerCase().match(/^gemini(?:-live)?-(\d+)/);
	if (!match) return true;
	return Number.parseInt(match[1], 10) >= 3;
}

function convertMessages(model: GeminiCliModel, context: Context): GeminiContent[] {
	const contents: GeminiContent[] = [];
	const normalizeToolCallId = (id: string): string => {
		if (!requiresToolCallId(model.id)) return id;
		return id.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64);
	};

	for (const msg of transformMessages(context.messages, model)) {
		if (msg.role === "user") {
			if (typeof msg.content === "string") {
				contents.push({ role: "user", parts: [{ text: sanitizeSurrogates(msg.content) }] });
			} else {
				const parts = msg.content.map((item) =>
					item.type === "text"
						? { text: sanitizeSurrogates(item.text) }
						: { inlineData: { mimeType: item.mimeType, data: item.data } },
				);
				if (parts.length > 0) contents.push({ role: "user", parts });
			}
			continue;
		}

		if (msg.role === "assistant") {
			const parts: GeminiPart[] = [];
			const isSameProviderAndModel = msg.provider === model.provider && msg.model === model.id;
			for (const block of msg.content) {
				if (block.type === "text") {
					if (!block.text.trim()) continue;
					const thoughtSignature = resolveThoughtSignature(isSameProviderAndModel, block.textSignature);
					parts.push({ text: sanitizeSurrogates(block.text), ...(thoughtSignature && { thoughtSignature }) });
				} else if (block.type === "thinking") {
					if (!block.thinking.trim()) continue;
					if (isSameProviderAndModel) {
						const thoughtSignature = resolveThoughtSignature(isSameProviderAndModel, block.thinkingSignature);
						parts.push({
							thought: true,
							text: sanitizeSurrogates(block.thinking),
							...(thoughtSignature && { thoughtSignature }),
						});
					} else {
						parts.push({ text: sanitizeSurrogates(block.thinking) });
					}
				} else if (block.type === "toolCall") {
					const thoughtSignature = resolveThoughtSignature(isSameProviderAndModel, block.thoughtSignature);
					const isGemini3 = model.id.toLowerCase().includes("gemini-3");
					const effectiveSignature = thoughtSignature || (isGemini3 ? SKIP_THOUGHT_SIGNATURE : undefined);
					parts.push({
						functionCall: {
							name: block.name,
							args: block.arguments ?? {},
							...(requiresToolCallId(model.id) ? { id: normalizeToolCallId(block.id) } : {}),
						},
						...(effectiveSignature && { thoughtSignature: effectiveSignature }),
					});
				}
			}
			if (parts.length > 0) contents.push({ role: "model", parts });
			continue;
		}

		const textContent = msg.content.filter((content): content is TextContent => content.type === "text");
		const imageContent = model.input.includes("image")
			? msg.content.filter((content): content is ImageContent => content.type === "image")
			: [];
		const textResult = textContent.map((content) => content.text).join("\n");
		const hasText = textResult.length > 0;
		const hasImages = imageContent.length > 0;
		const responseValue = hasText ? sanitizeSurrogates(textResult) : hasImages ? "(see attached image)" : "";
		const imageParts = imageContent.map((imageBlock) => ({
			inlineData: { mimeType: imageBlock.mimeType, data: imageBlock.data },
		}));
		const functionResponsePart: GeminiPart = {
			functionResponse: {
				name: msg.toolName,
				response: msg.isError ? { error: responseValue } : { output: responseValue },
				...(hasImages && supportsMultimodalFunctionResponse(model.id) && { parts: imageParts }),
				...(requiresToolCallId(model.id) ? { id: normalizeToolCallId(msg.toolCallId) } : {}),
			},
		};

		const lastContent = contents[contents.length - 1];
		if (lastContent?.role === "user" && lastContent.parts.some((part) => part.functionResponse)) {
			lastContent.parts.push(functionResponsePart);
		} else {
			contents.push({ role: "user", parts: [functionResponsePart] });
		}

		if (hasImages && !supportsMultimodalFunctionResponse(model.id)) {
			contents.push({ role: "user", parts: [{ text: "Tool result image:" }, ...imageParts] });
		}
	}

	return contents;
}

function convertTools(
	tools: Tool[] | undefined,
): Array<{ functionDeclarations: Array<Record<string, unknown>> }> | undefined {
	if (!tools || tools.length === 0) return undefined;
	return [
		{
			functionDeclarations: tools.map((tool) => ({
				name: tool.name,
				description: tool.description,
				parametersJsonSchema: tool.parameters,
			})),
		},
	];
}

function mapToolChoice(choice: string): "AUTO" | "NONE" | "ANY" {
	switch (choice) {
		case "none":
			return "NONE";
		case "any":
			return "ANY";
		default:
			return "AUTO";
	}
}

function mapStopReasonString(reason: string): StopReason {
	switch (reason) {
		case "STOP":
			return "stop";
		case "MAX_TOKENS":
			return "length";
		default:
			return "error";
	}
}

function isGemini3ProModel(modelId: string): boolean {
	return /gemini-3(?:\.1)?-pro/.test(modelId.toLowerCase());
}

function isGemini3FlashModel(modelId: string): boolean {
	return /gemini-3(?:\.1)?-flash/.test(modelId.toLowerCase());
}

function isGemini3Model(modelId: string): boolean {
	return isGemini3ProModel(modelId) || isGemini3FlashModel(modelId);
}

function getDisabledThinkingConfig(modelId: string): { thinkingBudget?: number; thinkingLevel?: string } {
	if (isGemini3ProModel(modelId)) return { thinkingLevel: "LOW" };
	if (isGemini3FlashModel(modelId)) return { thinkingLevel: "MINIMAL" };
	return { thinkingBudget: 0 };
}

function getGeminiCliThinkingLevel(
	effort: Exclude<SimpleStreamOptions["reasoning"], "xhigh" | undefined>,
	modelId: string,
): string {
	if (isGemini3ProModel(modelId)) {
		switch (effort) {
			case "minimal":
			case "low":
				return "LOW";
			case "medium":
			case "high":
				return "HIGH";
		}
	}

	switch (effort) {
		case "minimal":
			return "MINIMAL";
		case "low":
			return "LOW";
		case "medium":
			return "MEDIUM";
		case "high":
			return "HIGH";
	}
}

function buildBaseOptions(
	model: GeminiCliModel,
	options: SimpleStreamOptions | undefined,
	apiKey: string,
): StreamOptionsWithThinking {
	return {
		temperature: options?.temperature,
		maxTokens: options?.maxTokens ?? (model.maxTokens > 0 ? Math.min(model.maxTokens, 32000) : undefined),
		signal: options?.signal,
		apiKey,
		cacheRetention: options?.cacheRetention,
		sessionId: options?.sessionId,
		headers: options?.headers,
		onPayload: options?.onPayload,
		onResponse: options?.onResponse,
		maxRetryDelayMs: options?.maxRetryDelayMs,
		metadata: options?.metadata,
	};
}

function buildRequest(
	model: GeminiCliModel,
	context: Context,
	projectId: string,
	options: StreamOptionsWithThinking = {},
): CloudCodeRequest {
	const generationConfig: GeminiRequest["generationConfig"] = {};
	if (options.temperature !== undefined) generationConfig.temperature = options.temperature;
	if (options.maxTokens !== undefined) generationConfig.maxOutputTokens = options.maxTokens;

	if (options.thinking?.enabled && model.reasoning) {
		generationConfig.thinkingConfig = { includeThoughts: true };
		if (options.thinking.level !== undefined) {
			generationConfig.thinkingConfig.thinkingLevel = options.thinking.level;
		} else if (options.thinking.budgetTokens !== undefined) {
			generationConfig.thinkingConfig.thinkingBudget = options.thinking.budgetTokens;
		}
	} else if (model.reasoning && options.thinking && !options.thinking.enabled) {
		generationConfig.thinkingConfig = getDisabledThinkingConfig(model.id);
	}

	const request: GeminiRequest = {
		contents: convertMessages(model, context),
		sessionId: options.sessionId,
	};

	if (context.systemPrompt) {
		request.systemInstruction = { parts: [{ text: sanitizeSurrogates(context.systemPrompt) }] };
	}
	if (Object.keys(generationConfig).length > 0) request.generationConfig = generationConfig;

	const tools = convertTools(context.tools);
	if (tools) {
		request.tools = tools;
		if (options.toolChoice) {
			request.toolConfig = { functionCallingConfig: { mode: mapToolChoice(options.toolChoice) } };
		}
	}

	return {
		project: projectId,
		model: model.id,
		request,
		userAgent: "pi-coding-agent",
		requestId: `pi-${Date.now()}-${Math.random().toString(36).slice(2, 11)}`,
	};
}

function headersToRecord(headers: Headers): Record<string, string> {
	const result: Record<string, string> = {};
	for (const [key, value] of headers.entries()) {
		result[key] = value;
	}
	return result;
}

function isRetryableError(status: number, errorText: string): boolean {
	if (status === 429 || status === 500 || status === 502 || status === 503 || status === 504) return true;
	return /resource.?exhausted|rate.?limit|overloaded|service.?unavailable|other.?side.?closed/i.test(errorText);
}

function extractErrorMessage(errorText: string): string {
	try {
		const parsed = JSON.parse(errorText) as { error?: { message?: string } };
		if (parsed.error?.message) return parsed.error.message;
	} catch {
		return errorText;
	}
	return errorText;
}

function extractRetryDelay(errorText: string, response?: Response): number | undefined {
	const normalizeDelay = (ms: number) => (ms > 0 ? Math.ceil(ms + 1000) : undefined);
	const headers = response?.headers;
	if (headers) {
		const retryAfter = headers.get("retry-after");
		if (retryAfter) {
			const retryAfterSeconds = Number(retryAfter);
			if (Number.isFinite(retryAfterSeconds)) return normalizeDelay(retryAfterSeconds * 1000);
			const retryAfterMs = new Date(retryAfter).getTime();
			if (!Number.isNaN(retryAfterMs)) return normalizeDelay(retryAfterMs - Date.now());
		}

		const rateLimitReset = headers.get("x-ratelimit-reset");
		if (rateLimitReset) {
			const resetSeconds = Number.parseInt(rateLimitReset, 10);
			if (!Number.isNaN(resetSeconds)) return normalizeDelay(resetSeconds * 1000 - Date.now());
		}

		const rateLimitResetAfter = headers.get("x-ratelimit-reset-after");
		if (rateLimitResetAfter) {
			const resetAfterSeconds = Number(rateLimitResetAfter);
			if (Number.isFinite(resetAfterSeconds)) return normalizeDelay(resetAfterSeconds * 1000);
		}
	}

	const durationMatch = errorText.match(/reset after (?:(\d+)h)?(?:(\d+)m)?(\d+(?:\.\d+)?)s/i);
	if (durationMatch) {
		const hours = durationMatch[1] ? Number.parseInt(durationMatch[1], 10) : 0;
		const minutes = durationMatch[2] ? Number.parseInt(durationMatch[2], 10) : 0;
		const seconds = Number.parseFloat(durationMatch[3]);
		if (!Number.isNaN(seconds)) return normalizeDelay(((hours * 60 + minutes) * 60 + seconds) * 1000);
	}

	const retryInMatch = errorText.match(/Please retry in ([0-9.]+)(ms|s)/i);
	if (retryInMatch?.[1]) {
		const value = Number.parseFloat(retryInMatch[1]);
		if (!Number.isNaN(value) && value > 0) {
			const ms = retryInMatch[2].toLowerCase() === "ms" ? value : value * 1000;
			return normalizeDelay(ms);
		}
	}

	const retryDelayMatch = errorText.match(/"retryDelay":\s*"([0-9.]+)(ms|s)"/i);
	if (retryDelayMatch?.[1]) {
		const value = Number.parseFloat(retryDelayMatch[1]);
		if (!Number.isNaN(value) && value > 0) {
			const ms = retryDelayMatch[2].toLowerCase() === "ms" ? value : value * 1000;
			return normalizeDelay(ms);
		}
	}

	return undefined;
}

function sleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) {
			reject(new Error("Request was aborted"));
			return;
		}
		const timeout = setTimeout(resolve, ms);
		signal?.addEventListener("abort", () => {
			clearTimeout(timeout);
			reject(new Error("Request was aborted"));
		});
	});
}

export function streamGoogleGeminiCli(
	model: GeminiCliModel,
	context: Context,
	options?: StreamOptionsWithThinking,
): AssistantMessageEventStream {
	const stream = createAssistantMessageEventStream();

	void (async () => {
		const output: AssistantMessage = {
			role: "assistant",
			content: [],
			api: API_ID,
			provider: model.provider,
			model: model.id,
			usage: emptyUsage(),
			stopReason: "stop",
			timestamp: Date.now(),
		};

		try {
			const apiKeyRaw = options?.apiKey;
			if (!apiKeyRaw) {
				throw new Error("Google Cloud Code Assist requires OAuth authentication. Use /login to authenticate.");
			}

			const { accessToken, projectId } = parseApiKey(apiKeyRaw);
			let requestBody = buildRequest(model, context, projectId, options);
			const nextRequestBody = await options?.onPayload?.(requestBody, model);
			if (nextRequestBody !== undefined) {
				requestBody = nextRequestBody as CloudCodeRequest;
			}

			const requestHeaders = {
				Authorization: `Bearer ${accessToken}`,
				"Content-Type": "application/json",
				Accept: "text/event-stream",
				...GEMINI_CLI_HEADERS,
				...options?.headers,
			};
			const requestBodyJson = JSON.stringify(requestBody);
			const requestUrl = `${model.baseUrl || CODE_ASSIST_ENDPOINT}/v1internal:streamGenerateContent?alt=sse`;
			const response = await fetchWithRetries(requestUrl, requestHeaders, requestBodyJson, model, options);

			let started = false;
			const ensureStarted = () => {
				if (started) return;
				stream.push({ type: "start", partial: output });
				started = true;
			};
			const resetOutput = () => {
				output.content = [];
				output.usage = emptyUsage();
				output.stopReason = "stop";
				output.errorMessage = undefined;
				output.timestamp = Date.now();
				started = false;
			};

			let receivedContent = false;
			let currentResponse = response;
			for (let emptyAttempt = 0; emptyAttempt <= MAX_EMPTY_STREAM_RETRIES; emptyAttempt++) {
				if (options?.signal?.aborted) throw new Error("Request was aborted");
				if (emptyAttempt > 0) {
					await sleep(EMPTY_STREAM_BASE_DELAY_MS * 2 ** (emptyAttempt - 1), options?.signal);
					currentResponse = await fetch(requestUrl, {
						method: "POST",
						headers: requestHeaders,
						body: requestBodyJson,
						signal: options?.signal,
					});
					await options?.onResponse?.(
						{ status: currentResponse.status, headers: headersToRecord(currentResponse.headers) },
						model,
					);
					if (!currentResponse.ok) {
						throw new Error(
							`Cloud Code Assist API error (${currentResponse.status}): ${await currentResponse.text()}`,
						);
					}
				}

				const streamed = await streamResponse(currentResponse, model, output, stream, ensureStarted, options);
				if (streamed) {
					receivedContent = true;
					break;
				}
				if (emptyAttempt < MAX_EMPTY_STREAM_RETRIES) resetOutput();
			}

			if (!receivedContent) throw new Error("Cloud Code Assist API returned an empty response");
			if (options?.signal?.aborted) throw new Error("Request was aborted");
			if (output.stopReason === "aborted" || output.stopReason === "error")
				throw new Error("An unknown error occurred");

			stream.push({ type: "done", reason: output.stopReason, message: output });
			stream.end();
		} catch (error) {
			output.stopReason = options?.signal?.aborted ? "aborted" : "error";
			output.errorMessage = error instanceof Error ? error.message : JSON.stringify(error);
			stream.push({ type: "error", reason: output.stopReason, error: output });
			stream.end();
		}
	})();

	return stream;
}

function emptyUsage(): Usage {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function parseApiKey(apiKeyRaw: string): { accessToken: string; projectId: string } {
	let parsed: unknown;
	try {
		parsed = JSON.parse(apiKeyRaw);
	} catch {
		throw new Error("Invalid Google Cloud Code Assist credentials. Use /login to re-authenticate.");
	}

	if (!parsed || typeof parsed !== "object") {
		throw new Error("Invalid Google Cloud Code Assist credentials. Use /login to re-authenticate.");
	}

	const accessToken = (parsed as { token?: unknown }).token;
	const projectId = (parsed as { projectId?: unknown }).projectId;
	if (typeof accessToken !== "string" || typeof projectId !== "string" || !accessToken || !projectId) {
		throw new Error("Missing token or projectId in Google Cloud credentials. Use /login to re-authenticate.");
	}

	return { accessToken, projectId };
}

async function fetchWithRetries(
	requestUrl: string,
	requestHeaders: Record<string, string>,
	requestBodyJson: string,
	model: GeminiCliModel,
	options: StreamOptionsWithThinking | undefined,
): Promise<Response> {
	let lastError: Error | undefined;
	for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
		if (options?.signal?.aborted) throw new Error("Request was aborted");
		try {
			const response = await fetch(requestUrl, {
				method: "POST",
				headers: requestHeaders,
				body: requestBodyJson,
				signal: options?.signal,
			});
			await options?.onResponse?.({ status: response.status, headers: headersToRecord(response.headers) }, model);
			if (response.ok) return response;

			const errorText = await response.text();
			if (attempt < MAX_RETRIES && isRetryableError(response.status, errorText)) {
				const serverDelay = extractRetryDelay(errorText, response);
				const delayMs = serverDelay ?? BASE_DELAY_MS * 2 ** attempt;
				const maxDelayMs = options?.maxRetryDelayMs ?? 60000;
				if (maxDelayMs > 0 && serverDelay && serverDelay > maxDelayMs) {
					throw new Error(
						`Server requested ${Math.ceil(serverDelay / 1000)}s retry delay (max: ${Math.ceil(maxDelayMs / 1000)}s). ${extractErrorMessage(errorText)}`,
					);
				}
				await sleep(delayMs, options?.signal);
				continue;
			}

			throw new Error(`Cloud Code Assist API error (${response.status}): ${extractErrorMessage(errorText)}`);
		} catch (error) {
			if (error instanceof Error && (error.name === "AbortError" || error.message === "Request was aborted")) {
				throw new Error("Request was aborted");
			}
			lastError = error instanceof Error ? error : new Error(String(error));
			if (lastError.message === "fetch failed" && lastError.cause instanceof Error) {
				lastError = new Error(`Network error: ${lastError.cause.message}`);
			}
			if (attempt < MAX_RETRIES) {
				await sleep(BASE_DELAY_MS * 2 ** attempt, options?.signal);
				continue;
			}
			throw lastError;
		}
	}

	throw lastError ?? new Error("Failed to get response after retries");
}

async function streamResponse(
	response: Response,
	model: GeminiCliModel,
	output: AssistantMessage,
	stream: AssistantMessageEventStream,
	ensureStarted: () => void,
	options: StreamOptionsWithThinking | undefined,
): Promise<boolean> {
	if (!response.body) throw new Error("No response body");

	let hasContent = false;
	let currentBlock: TextContent | ThinkingContent | null = null;
	const blocks = output.content;
	const blockIndex = () => blocks.length - 1;
	const reader = response.body.getReader();
	const decoder = new TextDecoder();
	let buffer = "";
	const abortHandler = () => {
		void reader.cancel().catch(() => {});
	};
	options?.signal?.addEventListener("abort", abortHandler);

	try {
		while (true) {
			if (options?.signal?.aborted) throw new Error("Request was aborted");
			const { done, value } = await reader.read();
			if (done) break;
			buffer += decoder.decode(value, { stream: true });
			const lines = buffer.split("\n");
			buffer = lines.pop() || "";
			for (const line of lines) {
				if (!line.startsWith("data:")) continue;
				const jsonStr = line.slice(5).trim();
				if (!jsonStr) continue;
				let chunk: GeminiStreamPayload;
				try {
					chunk = JSON.parse(jsonStr) as GeminiStreamPayload;
				} catch {
					continue;
				}
				const responseData = chunk.response;
				if (!responseData) continue;
				output.responseId ||= responseData.responseId;
				const candidate = responseData.candidates?.[0];
				if (candidate?.content?.parts) {
					for (const part of candidate.content.parts) {
						if (part.text !== undefined) {
							hasContent = true;
							currentBlock = pushTextPart(part, currentBlock, output, stream, ensureStarted, blockIndex);
						}
						if (part.functionCall) {
							hasContent = true;
							currentBlock = endCurrentBlock(currentBlock, output, stream, blockIndex);
							pushToolCallPart(part, output, stream, ensureStarted, blockIndex);
						}
					}
				}
				if (candidate?.finishReason) {
					output.stopReason = mapStopReasonString(candidate.finishReason);
					if (output.content.some((block) => block.type === "toolCall")) output.stopReason = "toolUse";
				}
				if (responseData.usageMetadata) {
					const promptTokens = responseData.usageMetadata.promptTokenCount || 0;
					const cacheReadTokens = responseData.usageMetadata.cachedContentTokenCount || 0;
					output.usage = {
						input: promptTokens - cacheReadTokens,
						output:
							(responseData.usageMetadata.candidatesTokenCount || 0) +
							(responseData.usageMetadata.thoughtsTokenCount || 0),
						cacheRead: cacheReadTokens,
						cacheWrite: 0,
						totalTokens: responseData.usageMetadata.totalTokenCount || 0,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					};
					calculateCost(model, output.usage);
				}
			}
		}
	} finally {
		options?.signal?.removeEventListener("abort", abortHandler);
	}

	endCurrentBlock(currentBlock, output, stream, blockIndex);
	return hasContent;
}

function pushTextPart(
	part: GeminiPart,
	currentBlock: TextContent | ThinkingContent | null,
	output: AssistantMessage,
	stream: AssistantMessageEventStream,
	ensureStarted: () => void,
	blockIndex: () => number,
): TextContent | ThinkingContent {
	const thinking = isThinkingPart(part);
	if (!currentBlock || (thinking && currentBlock.type !== "thinking") || (!thinking && currentBlock.type !== "text")) {
		endCurrentBlock(currentBlock, output, stream, blockIndex);
		if (thinking) {
			currentBlock = { type: "thinking", thinking: "", thinkingSignature: undefined };
			output.content.push(currentBlock);
			ensureStarted();
			stream.push({ type: "thinking_start", contentIndex: blockIndex(), partial: output });
		} else {
			currentBlock = { type: "text", text: "" };
			output.content.push(currentBlock);
			ensureStarted();
			stream.push({ type: "text_start", contentIndex: blockIndex(), partial: output });
		}
	}

	if (currentBlock.type === "thinking") {
		currentBlock.thinking += part.text;
		currentBlock.thinkingSignature = retainThoughtSignature(currentBlock.thinkingSignature, part.thoughtSignature);
		stream.push({ type: "thinking_delta", contentIndex: blockIndex(), delta: part.text ?? "", partial: output });
		return currentBlock;
	}

	currentBlock.text += part.text;
	currentBlock.textSignature = retainThoughtSignature(currentBlock.textSignature, part.thoughtSignature);
	stream.push({ type: "text_delta", contentIndex: blockIndex(), delta: part.text ?? "", partial: output });
	return currentBlock;
}

function endCurrentBlock(
	currentBlock: TextContent | ThinkingContent | null,
	output: AssistantMessage,
	stream: AssistantMessageEventStream,
	blockIndex: () => number,
): null {
	if (!currentBlock) return null;
	if (currentBlock.type === "text") {
		stream.push({ type: "text_end", contentIndex: blockIndex(), content: currentBlock.text, partial: output });
	} else {
		stream.push({
			type: "thinking_end",
			contentIndex: blockIndex(),
			content: currentBlock.thinking,
			partial: output,
		});
	}
	return null;
}

let toolCallCounter = 0;

function pushToolCallPart(
	part: GeminiPart,
	output: AssistantMessage,
	stream: AssistantMessageEventStream,
	ensureStarted: () => void,
	blockIndex: () => number,
): void {
	if (!part.functionCall) return;
	const providedId = part.functionCall.id;
	const needsNewId =
		!providedId || output.content.some((block) => block.type === "toolCall" && block.id === providedId);
	const toolCall: ToolCall = {
		type: "toolCall",
		id: needsNewId ? `${part.functionCall.name}_${Date.now()}_${++toolCallCounter}` : providedId,
		name: part.functionCall.name || "",
		arguments: part.functionCall.args ?? {},
		...(part.thoughtSignature && { thoughtSignature: part.thoughtSignature }),
	};

	output.content.push(toolCall);
	ensureStarted();
	stream.push({ type: "toolcall_start", contentIndex: blockIndex(), partial: output });
	stream.push({
		type: "toolcall_delta",
		contentIndex: blockIndex(),
		delta: JSON.stringify(toolCall.arguments),
		partial: output,
	});
	stream.push({ type: "toolcall_end", contentIndex: blockIndex(), toolCall, partial: output });
}

export function streamSimpleGoogleGeminiCli(
	model: GeminiCliModel,
	context: Context,
	options?: SimpleStreamOptions,
): AssistantMessageEventStream {
	const apiKey = options?.apiKey;
	if (!apiKey) {
		throw new Error("Google Cloud Code Assist requires OAuth authentication. Use /login to authenticate.");
	}

	const base = buildBaseOptions(model, options, apiKey);
	if (!options?.reasoning) {
		return streamGoogleGeminiCli(model, context, { ...base, thinking: { enabled: false } });
	}

	const effort = options.reasoning === "xhigh" ? "high" : options.reasoning;
	if (isGemini3Model(model.id)) {
		return streamGoogleGeminiCli(model, context, {
			...base,
			thinking: { enabled: true, level: getGeminiCliThinkingLevel(effort, model.id) },
		});
	}

	const budgets = { minimal: 1024, low: 2048, medium: 8192, high: 16384, ...options.thinkingBudgets };
	const minOutputTokens = 1024;
	let thinkingBudget = budgets[effort];
	const maxTokens = Math.min((base.maxTokens || 0) + thinkingBudget, model.maxTokens);
	if (maxTokens <= thinkingBudget) thinkingBudget = Math.max(0, maxTokens - minOutputTokens);

	return streamGoogleGeminiCli(model, context, {
		...base,
		maxTokens,
		thinking: { enabled: true, budgetTokens: thinkingBudget },
	});
}

export default function googleGeminiCliExtension(pi: ExtensionAPI) {
	pi.registerProvider(PROVIDER_ID, {
		name: "Google Cloud Code Assist (Gemini CLI)",
		baseUrl: CODE_ASSIST_ENDPOINT,
		api: API_ID,
		models: MODELS.map((model) => ({
			...model,
			input: [...model.input],
		})),
		oauth: {
			name: "Google Cloud Code Assist (Gemini CLI)",
			usesCallbackServer: true,
			login: loginGeminiCli,
			async refreshToken(credentials) {
				return refreshGoogleCloudToken(credentials.refresh, getCredentialProjectId(credentials));
			},
			getApiKey(credentials) {
				return JSON.stringify({ token: credentials.access, projectId: getCredentialProjectId(credentials) });
			},
		},
		streamSimple: streamSimpleGoogleGeminiCli,
	});
}
