import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockState = vi.hoisted(() => {
	interface MockOAuthClientProvider {
		saveTokens(tokens: { access_token: string; token_type: string; refresh_token?: string }): Promise<void> | void;
		saveCodeVerifier(codeVerifier: string): Promise<void> | void;
		saveDiscoveryState(state: { authorizationServerUrl: string }): Promise<void> | void;
		redirectToAuthorization(authorizationUrl: URL): Promise<void> | void;
	}

	let httpSessionCounter = 0;
	const authRequiredTargets = new Set<string>();
	const httpTransports: MockStreamableHTTPClientTransport[] = [];

	class MockUnauthorizedError extends Error {}

	class MockStdioClientTransport {
		readonly options: {
			command: string;
			args?: string[];
			cwd?: string;
			env?: Record<string, string>;
		};
		close = vi.fn(async () => {});

		constructor(options: { command: string; args?: string[]; cwd?: string; env?: Record<string, string> }) {
			this.options = options;
		}
	}

	class MockStreamableHTTPClientTransport {
		readonly url: URL;
		readonly options?: {
			authProvider?: MockOAuthClientProvider;
			requestInit?: RequestInit;
		};
		readonly sessionId: string;
		close = vi.fn(async () => {});
		finishAuth = vi.fn(async (authorizationCode: string) => {
			if (!this.options?.authProvider) {
				throw new Error("Missing authProvider");
			}

			await this.options.authProvider.saveTokens({
				access_token: `access-${authorizationCode}`,
				refresh_token: `refresh-${authorizationCode}`,
				token_type: "Bearer",
			});
		});

		constructor(
			url: URL,
			options?: {
				authProvider?: MockOAuthClientProvider;
				requestInit?: RequestInit;
			},
		) {
			this.url = url;
			this.options = options;
			httpSessionCounter += 1;
			this.sessionId = `session-${httpSessionCounter}`;
			httpTransports.push(this);
		}
	}

	type MockTransport = MockStdioClientTransport | MockStreamableHTTPClientTransport;

	class MockClient {
		transport?: MockTransport;
		close = vi.fn(async () => {});

		async connect(transport: MockTransport): Promise<void> {
			this.transport = transport;
			if (
				transport instanceof MockStreamableHTTPClientTransport &&
				authRequiredTargets.has(transport.url.href) &&
				transport.options?.authProvider
			) {
				await transport.options.authProvider.saveDiscoveryState({
					authorizationServerUrl: `${transport.url.origin}/oauth`,
				});
				await transport.options.authProvider.saveCodeVerifier(`pkce-${transport.url.hostname}`);
				await transport.options.authProvider.redirectToAuthorization(
					new URL(`${transport.url.origin}/authorize?client_id=test-client`),
				);
				throw new MockUnauthorizedError("Authorization required");
			}
		}

		async listTools(): Promise<{ tools: [] }> {
			return { tools: [] };
		}

		async callTool(): Promise<{ content: [] }> {
			return { content: [] };
		}
	}

	function reset(): void {
		httpSessionCounter = 0;
		authRequiredTargets.clear();
		httpTransports.splice(0);
	}

	return {
		MockClient,
		MockStdioClientTransport,
		MockStreamableHTTPClientTransport,
		MockUnauthorizedError,
		authRequiredTargets,
		httpTransports,
		reset,
	};
});

vi.mock("@modelcontextprotocol/sdk/client/index.js", () => ({
	Client: mockState.MockClient,
}));

vi.mock("@modelcontextprotocol/sdk/client/stdio.js", () => ({
	StdioClientTransport: mockState.MockStdioClientTransport,
}));

vi.mock("@modelcontextprotocol/sdk/client/streamableHttp.js", () => ({
	StreamableHTTPClientTransport: mockState.MockStreamableHTTPClientTransport,
}));

vi.mock("@modelcontextprotocol/sdk/client/auth.js", () => ({
	UnauthorizedError: mockState.MockUnauthorizedError,
}));

import { createEmptyRuntimeState, finishServerAuthorization, reconnectServers } from "../src/client.js";
import type { HttpMcpServerConfig } from "../src/config.js";
import { createFileBackedOAuthClientProvider } from "../src/oauth-provider.js";

const TEST_ROOT = join(process.cwd(), "test-artifacts", "oauth-runtime");

async function createHttpOAuthServerConfig(name: string, url: string): Promise<HttpMcpServerConfig> {
	const serverRoot = join(TEST_ROOT, name);
	const persistenceDir = join(serverRoot, "oauth");
	const secretPath = join(serverRoot, "client-secret.txt");
	await mkdir(serverRoot, { recursive: true });
	await writeFile(secretPath, "super-secret\n", "utf8");

	return {
		name,
		transport: "http",
		url,
		description: `${name} server`,
		enabled: true,
		scope: "project",
		configPath: join(serverRoot, "mcp.json"),
		headers: {
			"X-Test": "1",
		},
		oauth: {
			clientId: "test-client",
			clientSecret: {
				type: "file",
				path: secretPath,
			},
			redirectUrl: "http://127.0.0.1:8080/callback",
			scopes: ["mcp:tools", "mcp:read"],
			tokenEndpointAuthMethod: "client_secret_post",
			persistence: {
				type: "file",
				dir: persistenceDir,
				tokensPath: join(persistenceDir, "tokens.json"),
				clientInfoPath: join(persistenceDir, "client-info.json"),
				codeVerifierPath: join(persistenceDir, "code-verifier.txt"),
				discoveryStatePath: join(persistenceDir, "discovery-state.json"),
			},
		},
	};
}

describe("MCP OAuth runtime", () => {
	beforeEach(async () => {
		mockState.reset();
		await rm(TEST_ROOT, { recursive: true, force: true });
	});

	afterEach(async () => {
		await rm(TEST_ROOT, { recursive: true, force: true });
	});

	it("persists and reloads OAuth client info, verifier, discovery state, and tokens", async () => {
		const serverConfig = await createHttpOAuthServerConfig("persisted", "https://example.com/mcp");
		if (!serverConfig.oauth) {
			throw new Error("Expected OAuth configuration.");
		}

		const provider = createFileBackedOAuthClientProvider(serverConfig.oauth);
		const clientInformation = await provider.clientInformation();
		await provider.saveCodeVerifier("pkce-verifier");
		await provider.saveDiscoveryState({
			authorizationServerUrl: "https://example.com/oauth",
		});
		provider.redirectToAuthorization(new URL("https://example.com/authorize?client_id=test-client"));

		const pendingState = await provider.getRuntimeState();
		expect(pendingState).toMatchObject({
			status: "pending",
			clientId: "test-client",
			redirectUrl: "http://127.0.0.1:8080/callback",
			authorizationUrl: "https://example.com/authorize?client_id=test-client",
			scopes: ["mcp:tools", "mcp:read"],
			tokenEndpointAuthMethod: "client_secret_post",
			hasTokens: false,
			hasClientInformation: true,
			hasCodeVerifier: true,
			hasDiscoveryState: true,
		});
		expect(clientInformation).toMatchObject({
			client_id: "test-client",
			client_secret: "super-secret",
			redirect_uris: ["http://127.0.0.1:8080/callback"],
			grant_types: ["authorization_code", "refresh_token"],
			response_types: ["code"],
			scope: "mcp:tools mcp:read",
			token_endpoint_auth_method: "client_secret_post",
		});

		const reloadedProvider = createFileBackedOAuthClientProvider(serverConfig.oauth);
		expect(await reloadedProvider.clientInformation()).toMatchObject({
			client_id: "test-client",
			client_secret: "super-secret",
		});
		expect(await reloadedProvider.codeVerifier()).toBe("pkce-verifier");
		expect(await reloadedProvider.discoveryState()).toEqual({
			authorizationServerUrl: "https://example.com/oauth",
		});

		await reloadedProvider.saveTokens({
			access_token: "access-token",
			refresh_token: "refresh-token",
			token_type: "Bearer",
		});

		const authorizedState = await reloadedProvider.getRuntimeState();
		expect(authorizedState).toMatchObject({
			status: "authorized",
			hasTokens: true,
			hasClientInformation: true,
			hasCodeVerifier: true,
			hasDiscoveryState: true,
		});
		expect(authorizedState.authorizationUrl).toBeUndefined();
		expect(await reloadedProvider.tokens()).toMatchObject({
			access_token: "access-token",
			refresh_token: "refresh-token",
			token_type: "Bearer",
		});

		const persistedTokens = JSON.parse(await readFile(serverConfig.oauth.persistence.tokensPath, "utf8")) as {
			access_token: string;
			refresh_token: string;
			token_type: string;
		};
		expect(persistedTokens.access_token).toBe("access-token");
		expect(persistedTokens.refresh_token).toBe("refresh-token");
	});

	it("wires auth providers into HTTP transports and exposes pending auth state", async () => {
		const serverConfig = await createHttpOAuthServerConfig("remote", "https://example.com/mcp");
		mockState.authRequiredTargets.add(serverConfig.url);

		const result = await reconnectServers([["remote", serverConfig]], createEmptyRuntimeState());
		const remoteServer = result.state.servers.get("remote");
		if (!remoteServer || !remoteServer.oauth) {
			throw new Error("Expected OAuth-enabled server state.");
		}

		expect(result.connectedServers).toBe(0);
		expect(result.failedServers).toBe(1);
		expect(remoteServer.status).toBe("auth_required");
		expect(remoteServer.oauth).toMatchObject({
			status: "pending",
			clientId: "test-client",
			tokenEndpointAuthMethod: "client_secret_post",
			hasTokens: false,
			hasClientInformation: false,
			hasCodeVerifier: true,
			hasDiscoveryState: true,
			authorizationUrl: "https://example.com/authorize?client_id=test-client",
		});
		expect(mockState.httpTransports).toHaveLength(1);
		expect(mockState.httpTransports[0]?.options?.requestInit?.headers).toEqual({
			"X-Test": "1",
		});
		expect(mockState.httpTransports[0]?.options?.authProvider).toBeDefined();
		expect(remoteServer.transport).toBe(mockState.httpTransports[0]);
		expect(remoteServer.client).toBeDefined();
	});

	it("finishes OAuth using persisted provider state without real network auth", async () => {
		const serverConfig = await createHttpOAuthServerConfig("github", "https://example.com/mcp");
		mockState.authRequiredTargets.add(serverConfig.url);

		const result = await reconnectServers([["github", serverConfig]], createEmptyRuntimeState());
		const oauthState = await finishServerAuthorization(result.state, "github", "code-123");

		expect(mockState.httpTransports[0]?.finishAuth).toHaveBeenCalledTimes(1);
		expect(mockState.httpTransports[0]?.finishAuth).toHaveBeenCalledWith("code-123");
		expect(oauthState).toMatchObject({
			status: "authorized",
			hasTokens: true,
			hasCodeVerifier: true,
			hasDiscoveryState: true,
		});
		expect(result.state.servers.get("github")?.oauth?.status).toBe("authorized");

		const persistedTokens = JSON.parse(await readFile(serverConfig.oauth!.persistence.tokensPath, "utf8")) as {
			access_token: string;
			refresh_token: string;
		};
		expect(persistedTokens).toMatchObject({
			access_token: "access-code-123",
			refresh_token: "refresh-code-123",
		});
	});
});
