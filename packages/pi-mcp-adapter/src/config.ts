import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

export interface McpServerConfig {
	name: string;
	command: string;
	args: string[];
	env?: Record<string, string>;
	cwd?: string;
	description?: string;
	enabled: boolean;
	includeTools?: string[];
	excludeTools?: string[];
	scope: "user" | "project";
	configPath: string;
}

interface RawMcpServerConfig {
	command?: unknown;
	args?: unknown;
	env?: unknown;
	cwd?: unknown;
	description?: unknown;
	enabled?: unknown;
	includeTools?: unknown;
	excludeTools?: unknown;
	transport?: unknown;
}

interface RawMcpConfigFile {
	mcpServers?: unknown;
}

export interface LoadedMcpConfig {
	servers: McpServerConfig[];
	configPaths: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function getHomeDir(): string {
	return process.env.HOME || homedir();
}

function asStringArray(value: unknown, fieldName: string, configPath: string): string[] | undefined {
	if (value === undefined) return undefined;
	if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
		throw new Error(`${configPath}: "${fieldName}" must be an array of strings.`);
	}
	return [...value];
}

function asStringRecord(value: unknown, fieldName: string, configPath: string): Record<string, string> | undefined {
	if (value === undefined) return undefined;
	if (!isRecord(value)) {
		throw new Error(`${configPath}: "${fieldName}" must be an object with string values.`);
	}

	const result: Record<string, string> = {};
	for (const [key, entry] of Object.entries(value)) {
		if (typeof entry !== "string") {
			throw new Error(`${configPath}: "${fieldName}.${key}" must be a string.`);
		}
		result[key] = entry;
	}
	return result;
}

function readConfigFile(configPath: string): RawMcpConfigFile | undefined {
	if (!existsSync(configPath)) return undefined;

	try {
		return JSON.parse(readFileSync(configPath, "utf-8")) as RawMcpConfigFile;
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(`${configPath}: failed to parse JSON: ${message}`);
	}
}

function parseServerConfig(
	serverName: string,
	value: unknown,
	scope: "user" | "project",
	configPath: string,
): McpServerConfig {
	if (!isRecord(value)) {
		throw new Error(`${configPath}: mcpServers.${serverName} must be an object.`);
	}

	const raw = value as RawMcpServerConfig;
	if (raw.transport !== undefined && raw.transport !== "stdio") {
		throw new Error(`${configPath}: mcpServers.${serverName}.transport must be "stdio" when provided.`);
	}
	if (typeof raw.command !== "string" || raw.command.trim().length === 0) {
		throw new Error(`${configPath}: mcpServers.${serverName}.command must be a non-empty string.`);
	}

	const resolvedCwd =
		typeof raw.cwd === "string" && raw.cwd.trim().length > 0 ? resolve(dirname(configPath), raw.cwd) : undefined;
	if (raw.cwd !== undefined && resolvedCwd === undefined) {
		throw new Error(`${configPath}: mcpServers.${serverName}.cwd must be a non-empty string when provided.`);
	}

	if (raw.description !== undefined && typeof raw.description !== "string") {
		throw new Error(`${configPath}: mcpServers.${serverName}.description must be a string.`);
	}
	if (raw.enabled !== undefined && typeof raw.enabled !== "boolean") {
		throw new Error(`${configPath}: mcpServers.${serverName}.enabled must be a boolean.`);
	}

	return {
		name: serverName,
		command: raw.command,
		args: asStringArray(raw.args, `mcpServers.${serverName}.args`, configPath) ?? [],
		env: asStringRecord(raw.env, `mcpServers.${serverName}.env`, configPath),
		cwd: resolvedCwd,
		description: raw.description,
		enabled: raw.enabled ?? true,
		includeTools: asStringArray(raw.includeTools, `mcpServers.${serverName}.includeTools`, configPath),
		excludeTools: asStringArray(raw.excludeTools, `mcpServers.${serverName}.excludeTools`, configPath),
		scope,
		configPath,
	};
}

function parseConfigFile(
	raw: RawMcpConfigFile,
	scope: "user" | "project",
	configPath: string,
): Map<string, McpServerConfig> {
	if (raw.mcpServers === undefined) {
		return new Map();
	}
	if (!isRecord(raw.mcpServers)) {
		throw new Error(`${configPath}: "mcpServers" must be an object keyed by server name.`);
	}

	const servers = new Map<string, McpServerConfig>();
	for (const [serverName, serverConfig] of Object.entries(raw.mcpServers)) {
		servers.set(serverName, parseServerConfig(serverName, serverConfig, scope, configPath));
	}
	return servers;
}

export function getUserMcpConfigPath(): string {
	return join(getHomeDir(), ".pi", "agent", "mcp.json");
}

export function getProjectMcpConfigPath(cwd: string): string {
	return join(cwd, ".pi", "mcp.json");
}

export function loadMcpConfig(cwd: string): LoadedMcpConfig {
	const userPath = getUserMcpConfigPath();
	const projectPath = getProjectMcpConfigPath(cwd);

	const configPaths: string[] = [];
	const merged = new Map<string, McpServerConfig>();

	const userConfig = readConfigFile(userPath);
	if (userConfig) {
		configPaths.push(userPath);
		for (const [name, config] of parseConfigFile(userConfig, "user", userPath)) {
			merged.set(name, config);
		}
	}

	const projectConfig = readConfigFile(projectPath);
	if (projectConfig) {
		configPaths.push(projectPath);
		for (const [name, config] of parseConfigFile(projectConfig, "project", projectPath)) {
			merged.set(name, config);
		}
	}

	return {
		servers: [...merged.values()].filter((server) => server.enabled),
		configPaths,
	};
}
