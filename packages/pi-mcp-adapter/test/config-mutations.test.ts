import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadMcpConfig, readRawMcpConfig, removeMcpServerConfig, upsertMcpServerConfig } from "../src/config.js";

describe("MCP config mutations", () => {
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

	it("reads raw configs for user and project scopes", () => {
		const homeDir = createTempDir("pi-mcp-home-");
		const projectDir = createTempDir("pi-mcp-project-");
		const previousHome = process.env.HOME;
		process.env.HOME = homeDir;

		try {
			const userConfigPath = path.join(homeDir, ".pi", "agent", "mcp.json");
			const projectConfigPath = path.join(projectDir, ".pi", "mcp.json");
			const userConfig = {
				theme: "dark",
				mcpServers: {
					userDocs: {
						transport: "http",
						url: "https://example.com/user",
					},
				},
			};
			const projectConfig = {
				workspace: "project",
				mcpServers: {
					localDocs: {
						transport: "stdio",
						command: "node",
						args: ["server.js"],
					},
				},
			};

			fs.mkdirSync(path.dirname(userConfigPath), { recursive: true });
			fs.mkdirSync(path.dirname(projectConfigPath), { recursive: true });
			fs.writeFileSync(userConfigPath, `${JSON.stringify(userConfig, null, 2)}\n`, "utf-8");
			fs.writeFileSync(projectConfigPath, `${JSON.stringify(projectConfig, null, 2)}\n`, "utf-8");

			expect(readRawMcpConfig(projectDir, "user")).toEqual(userConfig);
			expect(readRawMcpConfig(projectDir, "project")).toEqual(projectConfig);
		} finally {
			if (previousHome === undefined) {
				delete process.env.HOME;
			} else {
				process.env.HOME = previousHome;
			}
		}
	});

	it("adds stdio servers with explicit transport while preserving unrelated root config", async () => {
		const homeDir = createTempDir("pi-mcp-home-");
		const projectDir = createTempDir("pi-mcp-project-");
		const previousHome = process.env.HOME;
		process.env.HOME = homeDir;

		try {
			const projectConfigPath = path.join(projectDir, ".pi", "mcp.json");
			const existingConfig = {
				$schema: "https://example.com/pi-mcp.schema.json",
				theme: "dark",
			};

			fs.mkdirSync(path.dirname(projectConfigPath), { recursive: true });
			fs.writeFileSync(projectConfigPath, `${JSON.stringify(existingConfig, null, 2)}\n`, "utf-8");

			const result = await upsertMcpServerConfig(projectDir, "project", {
				name: "docs",
				transport: "stdio",
				command: "node",
				args: ["server.js"],
				env: {
					FOO: "bar",
				},
				includeTools: ["search"],
			});

			const expectedConfig = {
				$schema: "https://example.com/pi-mcp.schema.json",
				theme: "dark",
				mcpServers: {
					docs: {
						transport: "stdio",
						includeTools: ["search"],
						command: "node",
						args: ["server.js"],
						env: {
							FOO: "bar",
						},
					},
				},
			};
			const writtenText = fs.readFileSync(projectConfigPath, "utf-8");

			expect(result).toBe(true);
			expect(writtenText).toBe(`${JSON.stringify(expectedConfig, null, 2)}\n`);

			const loadedConfig = loadMcpConfig(projectDir);
			const docsServer = loadedConfig.servers.find((server) => server.name === "docs");
			if (!docsServer || docsServer.transport !== "stdio") {
				throw new Error("Expected docs to load as a stdio MCP server.");
			}

			expect(docsServer.command).toBe("node");
			expect(docsServer.args).toEqual(["server.js"]);
		} finally {
			if (previousHome === undefined) {
				delete process.env.HOME;
			} else {
				process.env.HOME = previousHome;
			}
		}
	});

	it("updates servers without disturbing unrelated config", async () => {
		const homeDir = createTempDir("pi-mcp-home-");
		const projectDir = createTempDir("pi-mcp-project-");
		const previousHome = process.env.HOME;
		process.env.HOME = homeDir;

		try {
			const projectConfigPath = path.join(projectDir, ".pi", "mcp.json");
			const existingConfig = {
				$schema: "https://example.com/pi-mcp.schema.json",
				theme: "dark",
				mcpServers: {
					keep: {
						transport: "stdio",
						command: "python",
						args: ["keep.py"],
					},
					docs: {
						transport: "stdio",
						command: "node",
						args: ["old.js"],
						"x-note": "preserve-me",
					},
				},
				featureFlags: {
					beta: true,
				},
			};

			fs.mkdirSync(path.dirname(projectConfigPath), { recursive: true });
			fs.writeFileSync(projectConfigPath, `${JSON.stringify(existingConfig, null, 2)}\n`, "utf-8");

			const result = await upsertMcpServerConfig(projectDir, "project", {
				name: "docs",
				transport: "http",
				description: "Docs server",
				excludeTools: ["delete"],
				url: "https://example.com/mcp",
				headers: {
					Authorization: "Bearer test-token",
				},
			});

			const expectedConfig = {
				$schema: "https://example.com/pi-mcp.schema.json",
				theme: "dark",
				mcpServers: {
					keep: {
						transport: "stdio",
						command: "python",
						args: ["keep.py"],
					},
					docs: {
						transport: "http",
						description: "Docs server",
						excludeTools: ["delete"],
						url: "https://example.com/mcp",
						headers: {
							Authorization: "Bearer test-token",
						},
						"x-note": "preserve-me",
					},
				},
				featureFlags: {
					beta: true,
				},
			};
			const writtenText = fs.readFileSync(projectConfigPath, "utf-8");

			expect(result).toBe(true);
			expect(writtenText).toBe(`${JSON.stringify(expectedConfig, null, 2)}\n`);

			const loadedConfig = loadMcpConfig(projectDir);
			const docsServer = loadedConfig.servers.find((server) => server.name === "docs");
			const keepServer = loadedConfig.servers.find((server) => server.name === "keep");

			if (!docsServer || docsServer.transport !== "http") {
				throw new Error("Expected docs to load as an http MCP server.");
			}
			if (!keepServer || keepServer.transport !== "stdio") {
				throw new Error("Expected keep to remain a stdio MCP server.");
			}

			expect(docsServer.url).toBe("https://example.com/mcp");
			expect(keepServer.command).toBe("python");
		} finally {
			if (previousHome === undefined) {
				delete process.env.HOME;
			} else {
				process.env.HOME = previousHome;
			}
		}
	});

	it("writes and loads HTTP OAuth config with file-backed persistence paths", async () => {
		const homeDir = createTempDir("pi-mcp-home-");
		const projectDir = createTempDir("pi-mcp-project-");
		const previousHome = process.env.HOME;
		process.env.HOME = homeDir;

		try {
			const projectConfigPath = path.join(projectDir, ".pi", "mcp.json");
			const result = await upsertMcpServerConfig(projectDir, "project", {
				name: "github",
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
			});

			const expectedConfig = {
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
							persistence: {
								type: "file",
								dir: ".\\oauth\\github",
							},
							scopes: ["read:user", "repo"],
							tokenEndpointAuthMethod: "client_secret_post",
						},
					},
				},
			};
			const writtenText = fs.readFileSync(projectConfigPath, "utf-8");

			expect(result).toBe(true);
			expect(writtenText).toBe(`${JSON.stringify(expectedConfig, null, 2)}\n`);

			const loadedConfig = loadMcpConfig(projectDir);
			const githubServer = loadedConfig.servers.find((server) => server.name === "github");
			if (!githubServer || githubServer.transport !== "http" || !githubServer.oauth) {
				throw new Error("Expected github to load as an HTTP MCP server with OAuth config.");
			}

			expect(githubServer.oauth).toEqual({
				clientId: "github-client-id",
				clientSecret: {
					type: "file",
					path: path.join(projectDir, ".pi", "secrets", "github-client-secret.txt"),
				},
				redirectUrl: "http://127.0.0.1:4123/callback",
				scopes: ["read:user", "repo"],
				tokenEndpointAuthMethod: "client_secret_post",
				persistence: {
					type: "file",
					dir: path.join(projectDir, ".pi", "oauth", "github"),
					tokensPath: path.join(projectDir, ".pi", "oauth", "github", "tokens.json"),
					clientInfoPath: path.join(projectDir, ".pi", "oauth", "github", "client-info.json"),
					codeVerifierPath: path.join(projectDir, ".pi", "oauth", "github", "code-verifier.txt"),
					discoveryStatePath: path.join(projectDir, ".pi", "oauth", "github", "discovery-state.json"),
				},
			});
		} finally {
			if (previousHome === undefined) {
				delete process.env.HOME;
			} else {
				process.env.HOME = previousHome;
			}
		}
	});

	it("removes only the targeted server entry and leaves the rest untouched", async () => {
		const homeDir = createTempDir("pi-mcp-home-");
		const projectDir = createTempDir("pi-mcp-project-");
		const previousHome = process.env.HOME;
		process.env.HOME = homeDir;

		try {
			const userConfigPath = path.join(homeDir, ".pi", "agent", "mcp.json");
			const existingConfig = {
				$schema: "https://example.com/pi-mcp.schema.json",
				mcpServers: {
					docs: {
						transport: "http",
						url: "https://example.com/docs",
					},
					keep: {
						transport: "stdio",
						command: "node",
						args: ["keep.js"],
						note: "preserve-me",
					},
				},
				ui: {
					compact: true,
				},
			};

			fs.mkdirSync(path.dirname(userConfigPath), { recursive: true });
			fs.writeFileSync(userConfigPath, `${JSON.stringify(existingConfig, null, 2)}\n`, "utf-8");

			const result = await removeMcpServerConfig(projectDir, "user", "docs");
			const expectedConfig = {
				$schema: "https://example.com/pi-mcp.schema.json",
				mcpServers: {
					keep: {
						transport: "stdio",
						command: "node",
						args: ["keep.js"],
						note: "preserve-me",
					},
				},
				ui: {
					compact: true,
				},
			};
			const writtenText = fs.readFileSync(userConfigPath, "utf-8");

			expect(result).toBe(true);
			expect(writtenText).toBe(`${JSON.stringify(expectedConfig, null, 2)}\n`);
			expect(readRawMcpConfig(projectDir, "user")).toEqual(expectedConfig);

			const noOpResult = await removeMcpServerConfig(projectDir, "user", "docs");
			expect(noOpResult).toBe(false);
			expect(fs.readFileSync(userConfigPath, "utf-8")).toBe(`${JSON.stringify(expectedConfig, null, 2)}\n`);
		} finally {
			if (previousHome === undefined) {
				delete process.env.HOME;
			} else {
				process.env.HOME = previousHome;
			}
		}
	});
});
