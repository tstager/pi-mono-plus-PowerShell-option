import { describe, expect, it } from "vitest";
import type { McpRuntimeState, McpServerConnection, McpToolBinding } from "../src/client.js";
import { buildStatusReport, buildToolListReport } from "../src/index.js";

const CONFIG_PATH = "C:\\repo\\.pi\\mcp.json";

function createServerConnection(
	server: Pick<
		McpServerConnection,
		"name" | "status" | "transportKind" | "transportMetadata" | "scope" | "toolCount" | "configPath"
	> &
		Partial<Pick<McpServerConnection, "description" | "errorMessage" | "oauth" | "managedAuth">>,
): McpServerConnection {
	return {
		description: undefined,
		errorMessage: undefined,
		...server,
	};
}

function createBinding(binding: McpToolBinding): McpToolBinding {
	return binding;
}

function createState(servers: McpServerConnection[], bindings: McpToolBinding[] = []): McpRuntimeState {
	return {
		configPaths: [CONFIG_PATH],
		servers: new Map(servers.map((server) => [server.name, server] as const)),
		toolBindings: new Map(bindings.map((binding) => [binding.registeredName, binding] as const)),
	};
}

describe("MCP status reporting", () => {
	it("shows scope, transport, tool count, and remote metadata in the status report", () => {
		const state = createState([
			createServerConnection({
				name: "remote",
				status: "connected",
				transportKind: "http",
				transportMetadata: {
					target: "https://example.com/mcp",
					sessionId: "session-2",
				},
				scope: "project",
				toolCount: 3,
				configPath: CONFIG_PATH,
			}),
			createServerConnection({
				name: "stdioDocs",
				status: "connected",
				transportKind: "stdio",
				transportMetadata: {
					target: "node",
				},
				scope: "user",
				toolCount: 1,
				configPath: CONFIG_PATH,
			}),
		]);

		expect(buildStatusReport(state)).toBe(
			[
				"MCP status",
				"",
				`Config files: ${CONFIG_PATH}`,
				"",
				"- remote",
				"  scope: project",
				"  transport: http",
				"  status: connected",
				"  tool count: 3",
				"  url: https://example.com/mcp",
				"  session: session-2",
				"",
				"- stdioDocs",
				"  scope: user",
				"  transport: stdio",
				"  status: connected",
				"  tool count: 1",
				"  command: node",
			].join("\n"),
		);
	});

	it("keeps failed connection errors concise and single-line", () => {
		const state = createState([
			createServerConnection({
				name: "brokenRemote",
				status: "error",
				transportKind: "http",
				transportMetadata: {
					target: "https://example.com/mcp",
				},
				scope: "project",
				toolCount: 0,
				configPath: CONFIG_PATH,
				errorMessage: "connect ECONNREFUSED to https://example.com/mcp\nrequest id abc123",
			}),
		]);

		expect(buildStatusReport(state)).toBe(
			[
				"MCP status",
				"",
				`Config files: ${CONFIG_PATH}`,
				"",
				"- brokenRemote",
				"  scope: project",
				"  transport: http",
				"  status: error",
				"  tool count: 0",
				"  url: https://example.com/mcp",
				"  error: connect ECONNREFUSED to https://example.com/mcp request id abc123",
			].join("\n"),
		);
	});

	it("shows pi auth status for GitHub MCP connections that reuse pi login", () => {
		const state = createState([
			createServerConnection({
				name: "github",
				status: "connected",
				transportKind: "http",
				transportMetadata: {
					target: "https://api.githubcopilot.com/mcp",
					sessionId: "session-7",
				},
				scope: "user",
				toolCount: 44,
				configPath: CONFIG_PATH,
				managedAuth: {
					kind: "pi",
					provider: "github-copilot",
					status: "available",
				},
			}),
		]);

		expect(buildStatusReport(state)).toBe(
			[
				"MCP status",
				"",
				`Config files: ${CONFIG_PATH}`,
				"",
				"- github",
				"  scope: user",
				"  transport: http",
				"  status: connected",
				"  tool count: 44",
				"  url: https://api.githubcopilot.com/mcp",
				"  session: session-7",
				"  auth: pi (github-copilot)",
				"  auth status: available",
			].join("\n"),
		);
	});

	it("shows pi auth guidance when GitHub MCP is waiting on pi login", () => {
		const state = createState([
			createServerConnection({
				name: "github",
				status: "auth_required",
				transportKind: "http",
				transportMetadata: {
					target: "https://api.githubcopilot.com/mcp",
				},
				scope: "user",
				toolCount: 0,
				configPath: CONFIG_PATH,
				managedAuth: {
					kind: "pi",
					provider: "github-copilot",
					status: "missing",
				},
				errorMessage:
					'GitHub MCP server "github" can reuse your pi GitHub Copilot login. Run /login github-copilot, then /mcp-reload.',
			}),
		]);

		expect(buildStatusReport(state)).toBe(
			[
				"MCP status",
				"",
				`Config files: ${CONFIG_PATH}`,
				"",
				"- github",
				"  scope: user",
				"  transport: http",
				"  status: auth_required (pi login required)",
				"  tool count: 0",
				"  url: https://api.githubcopilot.com/mcp",
				"  auth: pi (github-copilot)",
				"  auth status: missing",
				'  error: GitHub MCP server "github" can reuse your pi GitHub Copilot login. Run /login github-copilot, then /mcp-reload.',
			].join("\n"),
		);
	});

	it("shows OAuth authorization guidance for servers waiting on sign-in", () => {
		const state = createState([
			createServerConnection({
				name: "github",
				status: "auth_required",
				transportKind: "http",
				transportMetadata: {
					target: "https://api.githubcopilot.com/mcp",
				},
				scope: "user",
				toolCount: 0,
				configPath: CONFIG_PATH,
				oauth: {
					status: "pending",
					clientId: "github-client",
					redirectUrl: "http://127.0.0.1:8080/callback",
					authorizationUrl: "https://github.com/login/oauth/authorize?client_id=github-client",
					scopes: ["read:user"],
					tokenEndpointAuthMethod: "client_secret_post",
					hasTokens: false,
					hasClientInformation: false,
					hasCodeVerifier: true,
					hasDiscoveryState: true,
				},
				errorMessage: 'OAuth authorization is required. Run /mcp-auth for "github" to finish sign-in.',
			}),
		]);

		expect(buildStatusReport(state)).toBe(
			[
				"MCP status",
				"",
				`Config files: ${CONFIG_PATH}`,
				"",
				"- github",
				"  scope: user",
				"  transport: http",
				"  status: auth_required",
				"  tool count: 0",
				"  url: https://api.githubcopilot.com/mcp",
				"  oauth: pending",
				"  oauth client id: github-client",
				"  oauth scopes: read:user",
				"  oauth authorization url: ready (run /mcp-auth)",
				'  error: OAuth authorization is required. Run /mcp-auth for "github" to finish sign-in.',
			].join("\n"),
		);
	});

	it("adds lightweight transport context to the tool list", () => {
		const state = createState(
			[
				createServerConnection({
					name: "docs",
					status: "error",
					transportKind: "stdio",
					transportMetadata: {
						target: "node",
					},
					scope: "project",
					toolCount: 0,
					configPath: CONFIG_PATH,
				}),
				createServerConnection({
					name: "remote",
					status: "connected",
					transportKind: "http",
					transportMetadata: {
						target: "https://example.com/mcp",
						sessionId: "session-2",
					},
					scope: "project",
					toolCount: 1,
					configPath: CONFIG_PATH,
				}),
			],
			[
				createBinding({
					serverName: "remote",
					registeredName: "mcp_remote_lookup",
					toolName: "lookup",
					description: "Lookup docs",
					inputSchema: { type: "object" },
				}),
				createBinding({
					serverName: "docs",
					registeredName: "mcp_docs_search",
					toolName: "search",
					description: "Search docs",
					inputSchema: { type: "object" },
				}),
			],
		);

		expect(buildToolListReport(state)).toBe(
			[
				"Registered MCP tools",
				"",
				"- mcp_docs_search -> docs.search [stdio, error] — Search docs",
				"- mcp_remote_lookup -> remote.lookup [http] — Lookup docs",
			].join("\n"),
		);
	});
});
