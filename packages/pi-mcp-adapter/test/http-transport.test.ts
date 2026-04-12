import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockState = vi.hoisted(() => {
	type ToolFixture = {
		name: string;
		description?: string;
		inputSchema: unknown;
	};

	let httpSessionCounter = 0;
	const toolsByTarget = new Map<string, ToolFixture[]>();
	const httpTransports: MockStreamableHTTPClientTransport[] = [];
	const stdioTransports: MockStdioClientTransport[] = [];
	const clients: MockClient[] = [];

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
			stdioTransports.push(this);
		}
	}

	class MockStreamableHTTPClientTransport {
		readonly url: URL;
		readonly options?: { requestInit?: RequestInit };
		readonly sessionId: string;
		close = vi.fn(async () => {});

		constructor(url: URL, options?: { requestInit?: RequestInit }) {
			this.url = url;
			this.options = options;
			httpSessionCounter += 1;
			this.sessionId = `session-${httpSessionCounter}`;
			httpTransports.push(this);
		}
	}

	type MockTransport = MockStdioClientTransport | MockStreamableHTTPClientTransport;

	function getTransportTarget(transport: MockTransport): string {
		return transport instanceof MockStreamableHTTPClientTransport ? transport.url.href : transport.options.command;
	}

	class MockClient {
		transport?: MockTransport;
		close = vi.fn(async () => {});

		constructor(_clientInfo: { name: string; version: string }) {
			clients.push(this);
		}

		async connect(transport: MockTransport): Promise<void> {
			this.transport = transport;
		}

		async listTools(): Promise<{ tools: ToolFixture[] }> {
			if (!this.transport) {
				throw new Error("Mock client was not connected before listTools().");
			}

			return {
				tools: toolsByTarget.get(getTransportTarget(this.transport)) ?? [],
			};
		}

		async callTool(): Promise<{ content: [] }> {
			return { content: [] };
		}
	}

	function reset(): void {
		httpSessionCounter = 0;
		toolsByTarget.clear();
		httpTransports.splice(0);
		stdioTransports.splice(0);
		clients.splice(0);
	}

	return {
		MockClient,
		MockStdioClientTransport,
		MockStreamableHTTPClientTransport,
		clients,
		httpTransports,
		reset,
		stdioTransports,
		toolsByTarget,
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

import { callBoundTool, createEmptyRuntimeState, reconnectServers } from "../src/client.js";
import type { HttpMcpServerConfig, StdioMcpServerConfig } from "../src/config.js";

const TEST_HOME = join(process.cwd(), "test-artifacts", "http-transport-home");
const ORIGINAL_HOME = process.env.HOME;
const ORIGINAL_USERPROFILE = process.env.USERPROFILE;

async function writeGitHubCopilotAuth(refreshToken: string): Promise<void> {
	const authPath = join(TEST_HOME, ".pi", "agent", "auth.json");
	await mkdir(dirname(authPath), { recursive: true });
	await writeFile(
		authPath,
		`${JSON.stringify(
			{
				"github-copilot": {
					type: "oauth",
					refresh: refreshToken,
					access: "copilot-access-token",
					expires: Date.now() + 60_000,
				},
			},
			null,
			2,
		)}\n`,
		"utf8",
	);
}

function createHttpServerConfig(name: string, url: string, headers?: Record<string, string>): HttpMcpServerConfig {
	return {
		name,
		transport: "http",
		url,
		headers,
		description: `${name} server`,
		enabled: true,
		scope: "project",
		configPath: "C:\\repo\\.pi\\mcp.json",
	};
}

function createStdioServerConfig(name: string): StdioMcpServerConfig {
	return {
		name,
		transport: "stdio",
		command: "node",
		args: ["server.js"],
		cwd: "C:\\repo\\tools",
		env: { NODE_ENV: "test" },
		description: `${name} server`,
		enabled: true,
		scope: "project",
		configPath: "C:\\repo\\.pi\\mcp.json",
	};
}

describe("MCP HTTP transport lifecycle", () => {
	beforeEach(async () => {
		mockState.reset();
		await rm(TEST_HOME, { recursive: true, force: true });
		process.env.HOME = TEST_HOME;
		process.env.USERPROFILE = TEST_HOME;
	});

	afterEach(async () => {
		if (ORIGINAL_HOME === undefined) {
			delete process.env.HOME;
		} else {
			process.env.HOME = ORIGINAL_HOME;
		}
		if (ORIGINAL_USERPROFILE === undefined) {
			delete process.env.USERPROFILE;
		} else {
			process.env.USERPROFILE = ORIGINAL_USERPROFILE;
		}
		await rm(TEST_HOME, { recursive: true, force: true });
	});

	it("connects both http and https servers through the streamable HTTP transport", async () => {
		mockState.toolsByTarget.set("http://127.0.0.1:8080/mcp", [
			{ name: "search", description: "Search docs", inputSchema: { type: "object" } },
		]);
		mockState.toolsByTarget.set("https://example.com/mcp", [
			{ name: "lookup", description: "Lookup docs", inputSchema: { type: "object" } },
		]);

		const result = await reconnectServers(
			[
				["local", createHttpServerConfig("local", "http://127.0.0.1:8080/mcp")],
				[
					"remote",
					createHttpServerConfig("remote", "https://example.com/mcp", {
						Authorization: "Bearer test-token",
					}),
				],
			],
			createEmptyRuntimeState(),
		);

		expect(result.connectedServers).toBe(2);
		expect(result.failedServers).toBe(0);
		expect(mockState.httpTransports).toHaveLength(2);
		expect(mockState.stdioTransports).toHaveLength(0);
		expect(mockState.httpTransports.map((transport) => transport.url.href)).toEqual([
			"http://127.0.0.1:8080/mcp",
			"https://example.com/mcp",
		]);
		expect(mockState.httpTransports[1]?.options?.requestInit?.headers).toEqual({
			Authorization: "Bearer test-token",
		});

		const local = result.state.servers.get("local");
		const remote = result.state.servers.get("remote");
		if (!local || local.status !== "connected") {
			throw new Error("Expected local HTTP server to connect successfully.");
		}
		if (!remote || remote.status !== "connected") {
			throw new Error("Expected remote HTTPS server to connect successfully.");
		}

		expect(local.transportKind).toBe("http");
		expect(local.transportMetadata).toEqual({
			target: "http://127.0.0.1:8080/mcp",
			sessionId: "session-1",
		});
		expect(remote.transportMetadata).toEqual({
			target: "https://example.com/mcp",
			sessionId: "session-2",
		});
		expect([...result.state.toolBindings.keys()].sort()).toEqual(["mcp_local_search", "mcp_remote_lookup"]);
	});

	it("reuses the pi GitHub Copilot login for the remote GitHub MCP server", async () => {
		await writeGitHubCopilotAuth("ghu-test-refresh-token");
		mockState.toolsByTarget.set("https://api.githubcopilot.com/mcp/", [
			{ name: "get_me", description: "Get my profile", inputSchema: { type: "object" } },
		]);

		const result = await reconnectServers(
			[["github", createHttpServerConfig("github", "https://api.githubcopilot.com/mcp/")]],
			createEmptyRuntimeState(),
		);

		expect(result.connectedServers).toBe(1);
		expect(result.failedServers).toBe(0);
		expect(mockState.httpTransports).toHaveLength(1);
		expect(mockState.httpTransports[0]?.options?.requestInit?.headers).toEqual({
			Authorization: "Bearer ghu-test-refresh-token",
		});
		expect(result.state.servers.get("github")?.status).toBe("connected");
		expect([...result.state.toolBindings.keys()]).toEqual(["mcp_github_get_me"]);
	});

	it("reports auth_required when the remote GitHub MCP server has no reusable pi login", async () => {
		const result = await reconnectServers(
			[["github", createHttpServerConfig("github", "https://api.githubcopilot.com/mcp/")]],
			createEmptyRuntimeState(),
		);

		expect(result.connectedServers).toBe(0);
		expect(result.failedServers).toBe(1);
		expect(mockState.httpTransports).toHaveLength(0);
		expect(result.state.servers.get("github")).toMatchObject({
			status: "auth_required",
			errorMessage:
				'GitHub MCP server "github" can reuse your pi GitHub Copilot login. Run /login github-copilot, then /mcp-reload.',
		});
	});

	it("keeps stdio connections on the existing transport path", async () => {
		mockState.toolsByTarget.set("node", [
			{ name: "inspect", description: "Inspect", inputSchema: { type: "object" } },
		]);

		const result = await reconnectServers([["docs", createStdioServerConfig("docs")]], createEmptyRuntimeState());

		expect(result.connectedServers).toBe(1);
		expect(result.failedServers).toBe(0);
		expect(mockState.stdioTransports).toHaveLength(1);
		expect(mockState.httpTransports).toHaveLength(0);
		expect(mockState.stdioTransports[0]?.options).toEqual({
			command: "node",
			args: ["server.js"],
			cwd: "C:\\repo\\tools",
			env: { NODE_ENV: "test" },
		});

		const docs = result.state.servers.get("docs");
		if (!docs || docs.status !== "connected") {
			throw new Error("Expected stdio server to stay on the stdio transport.");
		}

		expect(docs.transportKind).toBe("stdio");
		expect(docs.transportMetadata).toEqual({
			target: "node",
			sessionId: undefined,
		});
		expect([...result.state.toolBindings.keys()]).toEqual(["mcp_docs_inspect"]);
	});

	it("closes previous remote connections during refresh", async () => {
		mockState.toolsByTarget.set("https://example.com/mcp", [
			{ name: "lookup", description: "Lookup docs", inputSchema: { type: "object" } },
		]);

		const config = createHttpServerConfig("remote", "https://example.com/mcp");
		const first = await reconnectServers([["remote", config]], createEmptyRuntimeState());
		const previousRemote = first.state.servers.get("remote");
		if (
			!previousRemote ||
			previousRemote.status !== "connected" ||
			!(previousRemote.client instanceof mockState.MockClient) ||
			!(previousRemote.transport instanceof mockState.MockStreamableHTTPClientTransport)
		) {
			throw new Error("Expected first refresh to create a connected HTTP runtime state.");
		}

		const second = await reconnectServers([["remote", config]], first.state);

		expect(previousRemote.client.close).toHaveBeenCalledTimes(1);
		expect(previousRemote.transport.close).toHaveBeenCalledTimes(1);
		expect(second.connectedServers).toBe(1);
		expect(second.failedServers).toBe(0);
		expect(second.state.servers.get("remote")?.transportMetadata.sessionId).toBe("session-2");
	});

	it("keeps stale bindings after removal but directs callers to /reload", async () => {
		mockState.toolsByTarget.set("https://example.com/mcp", [
			{ name: "lookup", description: "Lookup docs", inputSchema: { type: "object" } },
		]);

		const first = await reconnectServers(
			[["remote", createHttpServerConfig("remote", "https://example.com/mcp")]],
			createEmptyRuntimeState(),
		);
		const second = await reconnectServers([], first.state);

		expect(second.connectedServers).toBe(0);
		expect(second.failedServers).toBe(0);
		expect([...second.state.toolBindings.keys()]).toEqual(["mcp_remote_lookup"]);

		await expect(callBoundTool(second.state, "mcp_remote_lookup", {})).rejects.toThrow(
			"Run /reload to fully unregister removed tools, or /mcp-reload if the server config still exists.",
		);
	});
});
