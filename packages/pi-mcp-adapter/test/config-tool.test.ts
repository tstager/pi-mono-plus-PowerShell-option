import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "../../coding-agent/src/core/extensions/index.js";
import { readRawMcpConfig } from "../src/config.js";
import type {
	McpConfigEditDetails,
	McpConfigEditHttpDetails,
	McpConfigEditParametersSchema,
	McpConfigEditStdioDetails,
} from "../src/config-management.js";
import mcpAdapterExtension from "../src/index.js";

function createContext(cwd: string): ExtensionContext {
	return {
		hasUI: false,
		ui: {} as ExtensionContext["ui"],
		cwd,
		sessionManager: {} as ExtensionContext["sessionManager"],
		modelRegistry: {} as ExtensionContext["modelRegistry"],
		model: undefined,
		isIdle: () => true,
		signal: undefined,
		abort: () => undefined,
		hasPendingMessages: () => false,
		shutdown: () => undefined,
		getContextUsage: () => undefined,
		compact: () => undefined,
		getSystemPrompt: () => "",
	};
}

function createRegisteredTool(): ToolDefinition<typeof McpConfigEditParametersSchema, McpConfigEditDetails> {
	const registeredTools = new Map<
		string,
		ToolDefinition<typeof McpConfigEditParametersSchema, McpConfigEditDetails>
	>();
	const api = {
		on: () => undefined,
		registerTool: (tool: ToolDefinition<typeof McpConfigEditParametersSchema, McpConfigEditDetails>) => {
			registeredTools.set(tool.name, tool);
		},
		registerCommand: () => undefined,
	} as unknown as ExtensionAPI;

	mcpAdapterExtension(api);
	const tool = registeredTools.get("mcp_config_edit");
	if (!tool) {
		throw new Error("Expected mcp_config_edit to be registered.");
	}
	return tool;
}

describe("mcp_config_edit tool", () => {
	const tempDirs: string[] = [];

	afterEach(() => {
		for (const dir of tempDirs.splice(0)) {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	function createTempDir(prefix: string): string {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
		tempDirs.push(dir);
		return dir;
	}

	async function withHomeDir<T>(callback: (projectDir: string) => Promise<T> | T): Promise<T> {
		const homeDir = createTempDir("pi-mcp-home-");
		const projectDir = createTempDir("pi-mcp-project-");
		const previousHome = process.env.HOME;
		process.env.HOME = homeDir;

		try {
			return await callback(projectDir);
		} finally {
			if (previousHome === undefined) {
				delete process.env.HOME;
			} else {
				process.env.HOME = previousHome;
			}
		}
	}

	it("registers the tool with a top-level object schema and explicit required fields", () => {
		const tool = createRegisteredTool();
		const schema = tool.parameters as {
			type?: string;
			required?: string[];
			properties?: Record<string, { enum?: string[] }>;
		};

		expect(schema.type).toBe("object");
		expect(schema.required).toEqual(expect.arrayContaining(["operation", "scope", "name"]));
		expect(schema.properties?.operation?.enum).toEqual(["add_stdio_server", "add_http_server", "remove_server"]);
		expect(schema.properties?.scope?.enum).toEqual(["project", "user"]);
	});

	it("requires operation-specific fields at execution time", async () => {
		const tool = createRegisteredTool();

		await withHomeDir(async (projectDir) => {
			await expect(
				tool.execute(
					"call-missing-command",
					{
						operation: "add_stdio_server",
						scope: "project",
						name: "docs",
					},
					undefined,
					undefined,
					createContext(projectDir),
				),
			).rejects.toThrow('"command" is required when operation is "add_stdio_server".');
		});
	});

	it("adds stdio servers to the requested project scope and returns a concise summary", async () => {
		const tool = createRegisteredTool();

		await withHomeDir(async (projectDir) => {
			const result = await tool.execute(
				"call-1",
				{
					operation: "add_stdio_server",
					scope: "project",
					name: "docs",
					command: "node",
					args: ["server.js"],
					env: {
						FOO: "bar",
					},
				},
				undefined,
				undefined,
				createContext(projectDir),
			);

			expect(result.content).toEqual([
				{
					type: "text",
					text: expect.stringContaining('Added stdio MCP server "docs" to project config'),
				},
			]);

			const details = result.details as McpConfigEditStdioDetails;
			expect(details.operation).toBe("add_stdio_server");
			expect(details.outcome).toBe("added");
			expect(details.scope).toBe("project");
			expect(details.command).toBe("node");
			expect(details.args).toEqual(["server.js"]);
			expect(details.envKeys).toEqual(["FOO"]);

			expect(readRawMcpConfig(projectDir, "project")).toEqual({
				mcpServers: {
					docs: {
						transport: "stdio",
						command: "node",
						args: ["server.js"],
						env: {
							FOO: "bar",
						},
					},
				},
			});
		});
	});

	it("adds HTTP servers with OAuth config and returns OAuth details", async () => {
		const tool = createRegisteredTool();

		await withHomeDir(async (projectDir) => {
			const result = await tool.execute(
				"call-http-oauth",
				{
					operation: "add_http_server",
					scope: "project",
					name: "github",
					url: "https://api.githubcopilot.com/mcp",
					oauth: {
						clientId: "github-client-id",
						clientSecret: {
							type: "file",
							path: ".\\secrets\\github-client-secret.txt",
						},
						redirectUrl: "http://127.0.0.1:4123/callback",
						scopes: ["read:user", "repo"],
						tokenEndpointAuthMethod: "client_secret_post",
						persistence: {
							type: "file",
							dir: ".\\oauth\\github",
						},
					},
				},
				undefined,
				undefined,
				createContext(projectDir),
			);

			expect(result.content).toEqual([
				{
					type: "text",
					text: expect.stringContaining('Added http MCP server "github" to project config'),
				},
			]);

			const details = result.details as McpConfigEditHttpDetails;
			expect(details.operation).toBe("add_http_server");
			expect(details.outcome).toBe("added");
			expect(details.oauth).toEqual({
				clientId: "github-client-id",
				clientSecretPath: ".\\secrets\\github-client-secret.txt",
				redirectUrl: "http://127.0.0.1:4123/callback",
				scopes: ["read:user", "repo"],
				tokenEndpointAuthMethod: "client_secret_post",
				persistenceDir: ".\\oauth\\github",
			});

			expect(readRawMcpConfig(projectDir, "project")).toEqual({
				mcpServers: {
					github: {
						transport: "http",
						url: "https://api.githubcopilot.com/mcp",
						oauth: {
							clientId: "github-client-id",
							clientSecret: {
								type: "file",
								path: ".\\secrets\\github-client-secret.txt",
							},
							redirectUrl: "http://127.0.0.1:4123/callback",
							scopes: ["read:user", "repo"],
							tokenEndpointAuthMethod: "client_secret_post",
							persistence: {
								type: "file",
								dir: ".\\oauth\\github",
							},
						},
					},
				},
			});
		});
	});

	it("refuses to overwrite an existing server unless overwrite is explicit", async () => {
		const tool = createRegisteredTool();

		await withHomeDir(async (projectDir) => {
			const projectConfigPath = path.join(projectDir, ".pi", "mcp.json");
			fs.mkdirSync(path.dirname(projectConfigPath), { recursive: true });
			fs.writeFileSync(
				projectConfigPath,
				`${JSON.stringify(
					{
						mcpServers: {
							docs: {
								transport: "stdio",
								command: "node",
								args: ["old.js"],
							},
						},
					},
					null,
					2,
				)}\n`,
				"utf-8",
			);

			await expect(
				tool.execute(
					"call-2",
					{
						operation: "add_http_server",
						scope: "project",
						name: "docs",
						url: "https://example.com/mcp",
					},
					undefined,
					undefined,
					createContext(projectDir),
				),
			).rejects.toThrow("already exists in project scope. Pass overwrite: true to replace it.");

			const updated = await tool.execute(
				"call-3",
				{
					operation: "add_http_server",
					scope: "project",
					name: "docs",
					url: "https://example.com/mcp",
					headers: {
						Authorization: "Bearer test-token",
					},
					overwrite: true,
				},
				undefined,
				undefined,
				createContext(projectDir),
			);

			const details = updated.details as McpConfigEditHttpDetails;
			expect(details.operation).toBe("add_http_server");
			expect(details.outcome).toBe("updated");
			expect(details.overwrite).toBe(true);
			expect(details.headerKeys).toEqual(["Authorization"]);
			expect(updated.content).toEqual([
				{
					type: "text",
					text: expect.stringContaining('Updated http MCP server "docs" in project config'),
				},
			]);
			expect(readRawMcpConfig(projectDir, "project")).toEqual({
				mcpServers: {
					docs: {
						transport: "http",
						url: "https://example.com/mcp",
						headers: {
							Authorization: "Bearer test-token",
						},
					},
				},
			});
		});
	});

	it("removes servers from the requested scope and reports missing entries clearly", async () => {
		const tool = createRegisteredTool();

		await withHomeDir(async (projectDir) => {
			const userConfigPath = path.join(process.env.HOME ?? "", ".pi", "agent", "mcp.json");
			fs.mkdirSync(path.dirname(userConfigPath), { recursive: true });
			fs.writeFileSync(
				userConfigPath,
				`${JSON.stringify(
					{
						mcpServers: {
							docs: {
								transport: "http",
								url: "https://example.com/docs",
							},
						},
					},
					null,
					2,
				)}\n`,
				"utf-8",
			);

			const removed = await tool.execute(
				"call-4",
				{
					operation: "remove_server",
					scope: "user",
					name: "docs",
				},
				undefined,
				undefined,
				createContext(projectDir),
			);
			expect(removed.content).toEqual([
				{
					type: "text",
					text: expect.stringContaining('Removed MCP server "docs" from user config'),
				},
			]);
			expect(readRawMcpConfig(projectDir, "user")).toEqual({
				mcpServers: {},
			});

			const missing = await tool.execute(
				"call-5",
				{
					operation: "remove_server",
					scope: "user",
					name: "docs",
				},
				undefined,
				undefined,
				createContext(projectDir),
			);
			expect(missing.content).toEqual([
				{
					type: "text",
					text: expect.stringContaining('No change: MCP server "docs" was not found in user config'),
				},
			]);
		});
	});
});
