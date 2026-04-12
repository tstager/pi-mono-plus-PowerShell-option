import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { loadSkillsFromDir } from "@mariozechner/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import { resolveRegisteredToolName } from "../src/client.js";
import { loadMcpConfig } from "../src/config.js";
import { normalizeMcpResult } from "../src/content.js";
import { buildRegisteredToolName, createToolParametersSchema, shouldExposeTool } from "../src/schema.js";

describe("pi-mcp-adapter helpers", () => {
	const tempDirs: string[] = [];

	afterEach(() => {
		for (const dir of tempDirs.splice(0)) {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	it("loads bundled skills from the package directory", () => {
		const skillsDir = path.resolve(__dirname, "../skills");
		const { skills, diagnostics } = loadSkillsFromDir({
			dir: skillsDir,
			source: "test",
		});

		expect(skills.map((skill) => skill.name).sort()).toEqual(["mcp-management", "mcp-tools"]);
		expect(diagnostics).toHaveLength(0);
	});

	it("merges user and project MCP configs with project override precedence", () => {
		const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-mcp-home-"));
		const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-mcp-project-"));
		tempDirs.push(homeDir, projectDir);

		const previousHome = process.env.HOME;
		process.env.HOME = homeDir;

		try {
			const userConfigPath = path.join(homeDir, ".pi", "agent", "mcp.json");
			fs.mkdirSync(path.dirname(userConfigPath), { recursive: true });
			fs.writeFileSync(
				userConfigPath,
				JSON.stringify({
					mcpServers: {
						shared: {
							command: "node",
							args: ["user.js"],
						},
						userOnly: {
							command: "node",
							args: ["user-only.js"],
						},
					},
				}),
			);

			const projectConfigPath = path.join(projectDir, ".pi", "mcp.json");
			fs.mkdirSync(path.dirname(projectConfigPath), { recursive: true });
			fs.writeFileSync(
				projectConfigPath,
				JSON.stringify({
					mcpServers: {
						shared: {
							command: "python",
							args: ["project.py"],
							cwd: "..\\tools",
						},
						projectOnly: {
							command: "python",
							args: ["project-only.py"],
						},
					},
				}),
			);

			const config = loadMcpConfig(projectDir);
			const sharedServer = config.servers.find((server) => server.name === "shared");
			const userOnlyServer = config.servers.find((server) => server.name === "userOnly");
			const projectOnlyServer = config.servers.find((server) => server.name === "projectOnly");

			expect(config.configPaths).toEqual([userConfigPath, projectConfigPath]);
			expect(config.servers).toHaveLength(3);
			expect(config.servers.every((server) => server.transport === "stdio")).toBe(true);
			expect(sharedServer?.scope).toBe("project");
			expect(projectOnlyServer?.scope).toBe("project");
			expect(userOnlyServer?.scope).toBe("user");

			if (!sharedServer || sharedServer.transport !== "stdio") {
				throw new Error("Expected merged shared server to remain a stdio config.");
			}

			expect(sharedServer.command).toBe("python");
			expect(sharedServer.cwd).toBe(path.resolve(projectDir, ".pi", "..\\tools"));
		} finally {
			if (previousHome === undefined) {
				delete process.env.HOME;
			} else {
				process.env.HOME = previousHome;
			}
		}
	});

	it("parses explicit http transport entries for both http and https URLs", () => {
		const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-mcp-http-home-"));
		const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-mcp-http-project-"));
		tempDirs.push(homeDir, projectDir);

		const previousHome = process.env.HOME;
		process.env.HOME = homeDir;

		try {
			const projectConfigPath = path.join(projectDir, ".pi", "mcp.json");
			fs.mkdirSync(path.dirname(projectConfigPath), { recursive: true });
			fs.writeFileSync(
				projectConfigPath,
				JSON.stringify({
					mcpServers: {
						localHttp: {
							transport: "http",
							url: "http://127.0.0.1:8080/mcp",
						},
						remoteHttps: {
							transport: "http",
							url: "https://example.com/mcp",
							headers: {
								Authorization: "Bearer test-token",
							},
						},
					},
				}),
			);

			const config = loadMcpConfig(projectDir);
			const localHttp = config.servers.find((server) => server.name === "localHttp");
			const remoteHttps = config.servers.find((server) => server.name === "remoteHttps");

			expect(config.configPaths).toEqual([projectConfigPath]);

			if (!localHttp || localHttp.transport !== "http") {
				throw new Error("Expected localHttp to parse as an explicit http transport config.");
			}
			if (!remoteHttps || remoteHttps.transport !== "http") {
				throw new Error("Expected remoteHttps to parse as an explicit http transport config.");
			}

			expect(localHttp.url).toBe("http://127.0.0.1:8080/mcp");
			expect(remoteHttps.url).toBe("https://example.com/mcp");
			expect(remoteHttps.headers).toEqual({
				Authorization: "Bearer test-token",
			});
		} finally {
			if (previousHome === undefined) {
				delete process.env.HOME;
			} else {
				process.env.HOME = previousHome;
			}
		}
	});

	it("filters and normalizes MCP tool schemas and names", () => {
		const usedNames = new Set<string>(["mcp_docs_search"]);

		expect(buildRegisteredToolName("Docs", "Search", usedNames)).toBe("mcp_docs_search_2");
		expect(
			shouldExposeTool(
				{
					name: "docs",
					transport: "stdio",
					command: "node",
					args: [],
					enabled: true,
					includeTools: ["search"],
					excludeTools: ["delete"],
					scope: "project",
					configPath: "config.json",
				},
				"search",
			),
		).toBe(true);
		expect(
			shouldExposeTool(
				{
					name: "docs",
					transport: "stdio",
					command: "node",
					args: [],
					enabled: true,
					includeTools: ["search"],
					scope: "project",
					configPath: "config.json",
				},
				"delete",
			),
		).toBe(false);

		const schema = createToolParametersSchema(
			{
				type: "object",
				properties: {
					query: { type: "string" },
				},
				required: ["query"],
			},
			"Schema",
		);
		expect(schema.type).toBe("object");
		expect(schema.description).toBe("Schema");
	});

	it("normalizes text, image, and structured MCP results", () => {
		const result = normalizeMcpResult({
			content: [
				{ type: "text", text: "hello" },
				{ type: "image", data: "ZmFrZQ==", mimeType: "image/png" },
				{ type: "resource", resource: { uri: "file:///tmp/test.txt", text: "resource body" } },
				{ type: "resource_link", uri: "file:///tmp/linked.txt", description: "linked file" },
			],
			structuredContent: { ok: true },
		});

		expect(result.content[0]).toEqual({ type: "text", text: "hello" });
		expect(result.content.some((item) => item.type === "image")).toBe(true);
		expect(result.summary).toContain("hello");
		expect(result.summary).toContain("resource body");
		expect(result.summary).toContain("Resource link: file:///tmp/linked.txt");
	});

	it("normalizes compatibility toolResult payloads", () => {
		const result = normalizeMcpResult({
			toolResult: {
				status: "ok",
				value: 42,
			},
		});

		expect(result.content).toEqual([
			{
				type: "text",
				text: '{\n  "status": "ok",\n  "value": 42\n}',
			},
		]);
	});

	it("preserves registered tool names across reconnects", () => {
		const previousBinding = {
			serverName: "docs",
			registeredName: "mcp_docs_search",
			toolName: "search",
			description: "Search docs",
			inputSchema: {
				type: "object",
				properties: {
					query: { type: "string" },
				},
			},
		};
		const previousBindingsByKey = new Map([["docs\u0000search", previousBinding]]);
		const reservedNames = new Set(["mcp_docs_search"]);
		const usedToolNames = new Set<string>();

		expect(resolveRegisteredToolName("docs", "search", usedToolNames, previousBindingsByKey, reservedNames)).toBe(
			"mcp_docs_search",
		);
		expect(resolveRegisteredToolName("docs", "read", usedToolNames, previousBindingsByKey, reservedNames)).toBe(
			"mcp_docs_read",
		);
	});
});
