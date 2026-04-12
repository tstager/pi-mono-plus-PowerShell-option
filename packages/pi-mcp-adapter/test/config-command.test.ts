import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionUIContext,
	RegisteredCommand,
	ToolDefinition,
} from "../../coding-agent/src/core/extensions/index.js";
import { readRawMcpConfig } from "../src/config.js";
import type { McpConfigEditDetails, McpConfigEditParametersSchema } from "../src/config-management.js";
import mcpAdapterExtension from "../src/index.js";

interface NotificationRecord {
	message: string;
	type: "info" | "warning" | "error" | undefined;
}

interface SelectCall {
	title: string;
	options: string[];
}

interface ConfirmCall {
	title: string;
	message: string;
}

interface EditorCall {
	title: string;
	prefill: string | undefined;
}

interface UiHarness {
	ui: ExtensionUIContext;
	selectCalls: SelectCall[];
	confirmCalls: ConfirmCall[];
	editorCalls: EditorCall[];
	reports: string[];
	notifications: NotificationRecord[];
}

function createCommandContext(cwd: string, ui: ExtensionUIContext): ExtensionCommandContext {
	return {
		hasUI: true,
		ui,
		cwd,
		sessionManager: {} as ExtensionCommandContext["sessionManager"],
		modelRegistry: {} as ExtensionCommandContext["modelRegistry"],
		model: undefined,
		isIdle: () => true,
		signal: undefined,
		abort: () => undefined,
		hasPendingMessages: () => false,
		shutdown: () => undefined,
		getContextUsage: () => undefined,
		compact: () => undefined,
		getSystemPrompt: () => "",
		waitForIdle: async () => undefined,
		newSession: async () => ({ cancelled: false }),
		fork: async () => ({ cancelled: false }),
		navigateTree: async () => ({ cancelled: false }),
		switchSession: async () => ({ cancelled: false }),
		reload: async () => undefined,
	};
}

function createRegisteredCommand(): {
	command: RegisteredCommand;
	authCommand: RegisteredCommand;
	tool: ToolDefinition<typeof McpConfigEditParametersSchema, McpConfigEditDetails>;
} {
	const registeredCommands = new Map<string, RegisteredCommand>();
	const registeredTools = new Map<
		string,
		ToolDefinition<typeof McpConfigEditParametersSchema, McpConfigEditDetails>
	>();
	const api = {
		on: () => undefined,
		registerTool: (tool: ToolDefinition<typeof McpConfigEditParametersSchema, McpConfigEditDetails>) => {
			registeredTools.set(tool.name, tool);
		},
		registerCommand: (name: string, options: Omit<RegisteredCommand, "name" | "sourceInfo">) => {
			registeredCommands.set(name, {
				name,
				sourceInfo: {
					path: "test",
					source: "test",
					scope: "temporary",
					origin: "top-level",
				},
				...options,
			});
		},
	} as unknown as ExtensionAPI;

	mcpAdapterExtension(api);

	const command = registeredCommands.get("mcp-config");
	if (!command) {
		throw new Error("Expected /mcp-config to be registered.");
	}
	const authCommand = registeredCommands.get("mcp-auth");
	if (!authCommand) {
		throw new Error("Expected /mcp-auth to be registered.");
	}

	const tool = registeredTools.get("mcp_config_edit");
	if (!tool) {
		throw new Error("Expected mcp_config_edit to stay registered.");
	}

	return { command, authCommand, tool };
}

function createUiHarness(options: {
	selectResponses?: Array<string | undefined>;
	inputResponses?: Array<string | undefined>;
	confirmResponses?: boolean[];
	rawEditorResponses?: Array<string | undefined>;
}): UiHarness {
	const selectQueue = [...(options.selectResponses ?? [])];
	const inputQueue = [...(options.inputResponses ?? [])];
	const confirmQueue = [...(options.confirmResponses ?? [])];
	const rawEditorQueue = [...(options.rawEditorResponses ?? [])];

	const selectCalls: SelectCall[] = [];
	const confirmCalls: ConfirmCall[] = [];
	const editorCalls: EditorCall[] = [];
	const reports: string[] = [];
	const notifications: NotificationRecord[] = [];

	return {
		ui: {
			select: async (title: string, choices: string[]) => {
				selectCalls.push({ title, options: [...choices] });
				return selectQueue.shift();
			},
			confirm: async (title: string, message: string) => {
				confirmCalls.push({ title, message });
				return confirmQueue.shift() ?? false;
			},
			input: async () => inputQueue.shift(),
			notify: (message: string, type?: "info" | "warning" | "error") => {
				notifications.push({ message, type });
			},
			onTerminalInput: () => () => undefined,
			setStatus: () => undefined,
			setWorkingMessage: () => undefined,
			setHiddenThinkingLabel: () => undefined,
			setWidget: () => undefined,
			setFooter: () => undefined,
			setHeader: () => undefined,
			setTitle: () => undefined,
			custom: async () => {
				throw new Error("custom UI is not used in this test.");
			},
			pasteToEditor: () => undefined,
			setEditorText: () => undefined,
			getEditorText: () => "",
			editor: async (title: string, prefill?: string) => {
				editorCalls.push({ title, prefill });
				if (title.startsWith("Edit raw MCP config JSON")) {
					return rawEditorQueue.shift();
				}
				reports.push(prefill ?? "");
				return undefined;
			},
			setEditorComponent: () => undefined,
			setBottomToolbar: () => undefined,
			clearBottomToolbar: () => undefined,
		} as unknown as ExtensionUIContext,
		selectCalls,
		confirmCalls,
		editorCalls,
		reports,
		notifications,
	};
}

describe("/mcp-config command", () => {
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

	it("registers /mcp-config while preserving mcp_config_edit", () => {
		const { command, authCommand, tool } = createRegisteredCommand();

		expect(command.description).toContain("Interactively");
		expect(authCommand.description).toContain("OAuth");
		expect(tool.name).toBe("mcp_config_edit");
	});

	it("prompts for scope on each invocation and supports the stdio add/remove flow", async () => {
		const { command } = createRegisteredCommand();

		await withHomeDir(async (projectDir) => {
			const ui = createUiHarness({
				selectResponses: [
					"Project (.pi\\mcp.json)",
					"Add stdio server",
					"Project (.pi\\mcp.json)",
					"Remove server",
				],
				inputResponses: ["docs", "node", '["server.js"]', '{"FOO":"bar"}', ".\\tools", "docs"],
				confirmResponses: [true, true],
			});
			const ctx = createCommandContext(projectDir, ui.ui);

			await command.handler("", ctx);
			await command.handler("", ctx);

			expect(ui.selectCalls[0]?.title).toBe("Select MCP config scope");
			expect(ui.selectCalls[2]?.title).toBe("Select MCP config scope");
			expect(readRawMcpConfig(projectDir, "project")).toEqual({
				mcpServers: {},
			});
			expect(ui.reports[0]).toContain('Added stdio MCP server "docs" to project config');
			expect(ui.reports[0]).toContain("/mcp-reload");
			expect(ui.reports[1]).toContain('Removed MCP server "docs" from project config');
			expect(ui.reports[1]).toContain("/reload");
			expect(ui.confirmCalls).toHaveLength(2);
			expect(ui.confirmCalls[0]?.title).toBe("Apply MCP config change?");
			expect(ui.confirmCalls[0]?.message).toContain("Action: add stdio server");
			expect(ui.confirmCalls[1]?.message).toContain("Action: remove server");
		});
	});

	it("adds an HTTP server to user config and includes header details in the summary", async () => {
		const { command } = createRegisteredCommand();

		await withHomeDir(async (projectDir) => {
			const ui = createUiHarness({
				selectResponses: ["User (~\\.pi\\agent\\mcp.json)", "Add HTTP server"],
				inputResponses: ["remote", "https://example.com/mcp", '{"Authorization":"Bearer test-token"}'],
				confirmResponses: [true],
			});

			await command.handler("", createCommandContext(projectDir, ui.ui));

			expect(readRawMcpConfig(projectDir, "user")).toEqual({
				mcpServers: {
					remote: {
						transport: "http",
						url: "https://example.com/mcp",
						headers: {
							Authorization: "Bearer test-token",
						},
					},
				},
			});
			expect(ui.reports).toHaveLength(1);
			expect(ui.reports[0]).toContain('Added http MCP server "remote" to user config');
			expect(ui.reports[0]).toContain("Header keys: Authorization");
			expect(ui.reports[0]).toContain("/mcp-reload");
			expect(ui.confirmCalls).toEqual([
				expect.objectContaining({
					title: "Apply MCP config change?",
					message: expect.stringContaining("Action: add HTTP server"),
				}),
			]);
		});
	});

	it("adds an HTTP server with OAuth config and includes OAuth details in the summary", async () => {
		const { command } = createRegisteredCommand();

		await withHomeDir(async (projectDir) => {
			const ui = createUiHarness({
				selectResponses: ["Project (.pi\\mcp.json)", "Add HTTP server"],
				inputResponses: [
					"github",
					"https://api.githubcopilot.com/mcp",
					'{"Authorization":"Bearer test-token"}',
					'{"clientId":"github-client-id","clientSecret":{"type":"file","path":".\\\\secrets\\\\github-client-secret.txt"},"redirectUrl":"http://127.0.0.1:4123/callback","scopes":["read:user","repo"],"tokenEndpointAuthMethod":"client_secret_post","persistence":{"type":"file","dir":".\\\\oauth\\\\github"}}',
				],
				confirmResponses: [true],
			});

			await command.handler("", createCommandContext(projectDir, ui.ui));

			expect(readRawMcpConfig(projectDir, "project")).toEqual({
				mcpServers: {
					github: {
						transport: "http",
						url: "https://api.githubcopilot.com/mcp",
						headers: {
							Authorization: "Bearer test-token",
						},
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
			expect(ui.reports).toHaveLength(1);
			expect(ui.reports[0]).toContain('Added http MCP server "github" to project config');
			expect(ui.reports[0]).toContain("OAuth: enabled");
			expect(ui.reports[0]).toContain("OAuth client ID: github-client-id");
			expect(ui.reports[0]).toContain("OAuth client secret file: .\\secrets\\github-client-secret.txt");
			expect(ui.confirmCalls).toEqual([
				expect.objectContaining({
					title: "Apply MCP config change?",
					message: expect.stringContaining("OAuth: enabled"),
				}),
			]);
			expect(ui.confirmCalls[0]?.message).toContain("OAuth token auth method: client_secret_post");
		});
	});

	it("reuses the overwrite-aware config edit flow when an interactive add collides", async () => {
		const { command } = createRegisteredCommand();

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

			const ui = createUiHarness({
				selectResponses: ["Project (.pi\\mcp.json)", "Add HTTP server"],
				inputResponses: ["docs", "https://example.com/mcp", '{"Authorization":"Bearer test-token"}'],
				confirmResponses: [true, true],
			});

			await command.handler("", createCommandContext(projectDir, ui.ui));

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
			expect(ui.confirmCalls).toEqual([
				expect.objectContaining({
					title: "Apply MCP config change?",
					message: expect.stringContaining("Action: add HTTP server"),
				}),
				expect.objectContaining({
					title: "Overwrite existing MCP server?",
					message: expect.stringContaining("already exists in project scope. Pass overwrite: true to replace it."),
				}),
			]);
			expect(ui.reports).toHaveLength(1);
			expect(ui.reports[0]).toContain('Updated http MCP server "docs" in project config');
			expect(ui.reports[0]).toContain("Header keys: Authorization");
		});
	});

	it("removes a server after confirmation and reports reload guidance", async () => {
		const { command } = createRegisteredCommand();

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
								args: ["server.js"],
							},
						},
					},
					null,
					2,
				)}\n`,
				"utf-8",
			);

			const ui = createUiHarness({
				selectResponses: ["Project (.pi\\mcp.json)", "Remove server"],
				inputResponses: ["docs"],
				confirmResponses: [true],
			});

			await command.handler("", createCommandContext(projectDir, ui.ui));

			expect(readRawMcpConfig(projectDir, "project")).toEqual({
				mcpServers: {},
			});
			expect(ui.confirmCalls).toEqual([
				expect.objectContaining({
					title: "Apply MCP config change?",
					message: expect.stringContaining(`Config: ${projectConfigPath}`),
				}),
			]);
			expect(ui.confirmCalls[0]?.message).toContain("Action: remove server");
			expect(ui.reports[0]).toContain('Removed MCP server "docs" from project config');
			expect(ui.reports[0]).toContain("/reload");
		});
	});

	it("offers a raw JSON editor fallback", async () => {
		const { command } = createRegisteredCommand();

		await withHomeDir(async (projectDir) => {
			const ui = createUiHarness({
				selectResponses: ["User (~\\.pi\\agent\\mcp.json)", "Edit raw JSON (advanced)"],
				confirmResponses: [true],
				rawEditorResponses: [
					'{\n  "mcpServers": {\n    "docs": {\n      "transport": "http",\n      "url": "https://example.com/mcp"\n    }\n  }\n}\n',
				],
			});

			await command.handler("", createCommandContext(projectDir, ui.ui));

			expect(readRawMcpConfig(projectDir, "user")).toEqual({
				mcpServers: {
					docs: {
						transport: "http",
						url: "https://example.com/mcp",
					},
				},
			});
			expect(ui.reports[0]).toContain("Saved raw user MCP config");
			expect(ui.reports[0]).toContain("/mcp-reload");
			expect(ui.confirmCalls).toEqual([
				expect.objectContaining({
					title: "Apply MCP config change?",
					message: expect.stringContaining("Action: edit raw JSON"),
				}),
			]);
		});
	});
});
