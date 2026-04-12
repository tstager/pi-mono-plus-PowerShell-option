import { existsSync, readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { withFileMutationQueue } from "@mariozechner/pi-coding-agent";

export type McpConfigScope = "user" | "project";
export type McpTransportKind = "stdio" | "http";
export type McpOAuthTokenEndpointAuthMethod = "client_secret_basic" | "client_secret_post" | "none";

export interface FileBackedMcpOAuthSecretConfig {
	type: "file";
	path: string;
}

export interface McpOAuthPersistencePaths {
	dir: string;
	tokensPath: string;
	clientInfoPath: string;
	codeVerifierPath: string;
	discoveryStatePath: string;
}

export interface FileBackedMcpOAuthPersistenceConfig extends McpOAuthPersistencePaths {
	type: "file";
}

export interface FileBackedMcpOAuthPersistenceConfigInput {
	type: "file";
	dir: string;
}

export interface HttpMcpServerOAuthConfig {
	clientId: string;
	clientSecret: FileBackedMcpOAuthSecretConfig;
	redirectUrl: string;
	scopes?: string[];
	tokenEndpointAuthMethod?: McpOAuthTokenEndpointAuthMethod;
	persistence: FileBackedMcpOAuthPersistenceConfig;
}

export interface HttpMcpServerOAuthConfigInput {
	clientId: string;
	clientSecret: FileBackedMcpOAuthSecretConfig;
	redirectUrl: string;
	scopes?: string[];
	tokenEndpointAuthMethod?: McpOAuthTokenEndpointAuthMethod;
	persistence: FileBackedMcpOAuthPersistenceConfigInput;
}

interface McpServerConfigBase {
	name: string;
	description?: string;
	enabled: boolean;
	includeTools?: string[];
	excludeTools?: string[];
	scope: McpConfigScope;
	configPath: string;
}

export interface StdioMcpServerConfig extends McpServerConfigBase {
	transport: "stdio";
	command: string;
	args: string[];
	env?: Record<string, string>;
	cwd?: string;
}

export interface HttpMcpServerConfig extends McpServerConfigBase {
	transport: "http";
	url: string;
	headers?: Record<string, string>;
	oauth?: HttpMcpServerOAuthConfig;
}

export type McpServerConfig = StdioMcpServerConfig | HttpMcpServerConfig;
export type McpServerConfigInput = StdioMcpServerConfigInput | HttpMcpServerConfigInput;

export interface StdioMcpServerConfigInput {
	name: string;
	description?: string;
	enabled?: boolean;
	includeTools?: string[];
	excludeTools?: string[];
	transport: "stdio";
	command: string;
	args?: string[];
	env?: Record<string, string>;
	cwd?: string;
}

export interface HttpMcpServerConfigInput {
	name: string;
	description?: string;
	enabled?: boolean;
	includeTools?: string[];
	excludeTools?: string[];
	transport: "http";
	url: string;
	headers?: Record<string, string>;
	oauth?: HttpMcpServerOAuthConfigInput;
}

interface RawFileBackedMcpOAuthSecretConfig {
	[key: string]: unknown;
	type?: unknown;
	path?: unknown;
}

interface RawFileBackedMcpOAuthPersistenceConfig {
	[key: string]: unknown;
	type?: unknown;
	dir?: unknown;
}

interface RawHttpMcpServerOAuthConfig {
	[key: string]: unknown;
	clientId?: unknown;
	clientSecret?: unknown;
	redirectUrl?: unknown;
	scopes?: unknown;
	tokenEndpointAuthMethod?: unknown;
	persistence?: unknown;
}

interface RawMcpServerConfig {
	[key: string]: unknown;
	command?: unknown;
	args?: unknown;
	env?: unknown;
	cwd?: unknown;
	url?: unknown;
	headers?: unknown;
	description?: unknown;
	enabled?: unknown;
	includeTools?: unknown;
	excludeTools?: unknown;
	transport?: unknown;
	oauth?: unknown;
}

export interface RawMcpConfig {
	[key: string]: unknown;
	mcpServers?: unknown;
}

export interface LoadedMcpConfig {
	servers: McpServerConfig[];
	configPaths: string[];
}

const KNOWN_SERVER_KEYS = new Set([
	"description",
	"enabled",
	"includeTools",
	"excludeTools",
	"transport",
	"command",
	"args",
	"env",
	"cwd",
	"url",
	"headers",
	"oauth",
]);

const OAUTH_TOKEN_FILE_NAME = "tokens.json";
const OAUTH_CLIENT_INFO_FILE_NAME = "client-info.json";
const OAUTH_CODE_VERIFIER_FILE_NAME = "code-verifier.txt";
const OAUTH_DISCOVERY_STATE_FILE_NAME = "discovery-state.json";

export function isStdioMcpServerConfig(serverConfig: McpServerConfig): serverConfig is StdioMcpServerConfig {
	return serverConfig.transport === "stdio";
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOwnKey(record: Record<string, unknown>, key: string): boolean {
	return Object.hasOwn(record, key);
}

function isMcpOAuthTokenEndpointAuthMethod(value: unknown): value is McpOAuthTokenEndpointAuthMethod {
	return value === "client_secret_basic" || value === "client_secret_post" || value === "none";
}

function getHomeDir(): string {
	return process.env.HOME || homedir();
}

function getMcpConfigPath(cwd: string, scope: McpConfigScope): string {
	return scope === "user" ? getUserMcpConfigPath() : getProjectMcpConfigPath(cwd);
}

function cloneRawMcpConfig(config: RawMcpConfig): RawMcpConfig {
	return structuredClone(config);
}

function parseTransportKind(value: unknown, serverName: string, configPath: string): McpTransportKind {
	if (value === undefined) return "stdio";
	if (value === "stdio" || value === "http") {
		return value;
	}

	throw new Error(`${configPath}: mcpServers.${serverName}.transport must be "stdio" or "http" when provided.`);
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

function asNonEmptyString(value: unknown, fieldName: string, configPath: string): string {
	if (typeof value !== "string" || value.trim().length === 0) {
		throw new Error(`${configPath}: "${fieldName}" must be a non-empty string.`);
	}

	return value.trim();
}

function asSafeUrlString(value: unknown, fieldName: string, configPath: string): string {
	const stringValue = asNonEmptyString(value, fieldName, configPath);

	let url: URL;
	try {
		url = new URL(stringValue);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(`${configPath}: "${fieldName}" must be a valid URL: ${message}`);
	}

	if (url.protocol === "javascript:") {
		throw new Error(`${configPath}: "${fieldName}" must not use javascript:.`);
	}

	return url.href;
}

function resolveConfigRelativePath(configPath: string, configuredPath: string): string {
	return resolve(dirname(configPath), configuredPath);
}

function createFileBackedMcpOAuthPersistenceConfig(dir: string): FileBackedMcpOAuthPersistenceConfig {
	return {
		type: "file",
		dir,
		tokensPath: join(dir, OAUTH_TOKEN_FILE_NAME),
		clientInfoPath: join(dir, OAUTH_CLIENT_INFO_FILE_NAME),
		codeVerifierPath: join(dir, OAUTH_CODE_VERIFIER_FILE_NAME),
		discoveryStatePath: join(dir, OAUTH_DISCOVERY_STATE_FILE_NAME),
	};
}

function parseFileBackedMcpOAuthSecretConfig(
	value: unknown,
	fieldName: string,
	configPath: string,
): FileBackedMcpOAuthSecretConfig {
	if (!isRecord(value)) {
		throw new Error(`${configPath}: "${fieldName}" must be an object.`);
	}

	const raw = value as RawFileBackedMcpOAuthSecretConfig;
	if (raw.type !== "file") {
		throw new Error(`${configPath}: "${fieldName}.type" must be "file".`);
	}

	return {
		type: "file",
		path: resolveConfigRelativePath(configPath, asNonEmptyString(raw.path, `${fieldName}.path`, configPath)),
	};
}

function parseFileBackedMcpOAuthPersistenceConfig(
	value: unknown,
	fieldName: string,
	configPath: string,
): FileBackedMcpOAuthPersistenceConfig {
	if (!isRecord(value)) {
		throw new Error(`${configPath}: "${fieldName}" must be an object.`);
	}

	const raw = value as RawFileBackedMcpOAuthPersistenceConfig;
	if (raw.type !== "file") {
		throw new Error(`${configPath}: "${fieldName}.type" must be "file".`);
	}

	return createFileBackedMcpOAuthPersistenceConfig(
		resolveConfigRelativePath(configPath, asNonEmptyString(raw.dir, `${fieldName}.dir`, configPath)),
	);
}

function parseHttpServerOAuthConfig(
	serverName: string,
	value: unknown,
	configPath: string,
): HttpMcpServerOAuthConfig | undefined {
	if (value === undefined) {
		return undefined;
	}
	if (!isRecord(value)) {
		throw new Error(`${configPath}: mcpServers.${serverName}.oauth must be an object.`);
	}

	const fieldPrefix = `mcpServers.${serverName}.oauth`;
	const raw = value as RawHttpMcpServerOAuthConfig;
	if (raw.tokenEndpointAuthMethod !== undefined && !isMcpOAuthTokenEndpointAuthMethod(raw.tokenEndpointAuthMethod)) {
		throw new Error(
			`${configPath}: "${fieldPrefix}.tokenEndpointAuthMethod" must be "client_secret_basic", "client_secret_post", or "none".`,
		);
	}

	return {
		clientId: asNonEmptyString(raw.clientId, `${fieldPrefix}.clientId`, configPath),
		clientSecret: parseFileBackedMcpOAuthSecretConfig(raw.clientSecret, `${fieldPrefix}.clientSecret`, configPath),
		redirectUrl: asSafeUrlString(raw.redirectUrl, `${fieldPrefix}.redirectUrl`, configPath),
		scopes: asStringArray(raw.scopes, `${fieldPrefix}.scopes`, configPath),
		tokenEndpointAuthMethod: raw.tokenEndpointAuthMethod,
		persistence: parseFileBackedMcpOAuthPersistenceConfig(raw.persistence, `${fieldPrefix}.persistence`, configPath),
	};
}

function readConfigFile(configPath: string): RawMcpConfig | undefined {
	if (!existsSync(configPath)) return undefined;

	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(configPath, "utf-8"));
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(`${configPath}: failed to parse JSON: ${message}`);
	}

	if (!isRecord(parsed)) {
		throw new Error(`${configPath}: top-level config must be a JSON object.`);
	}

	return parsed;
}

function parseCommonServerFields(
	serverName: string,
	raw: RawMcpServerConfig,
	scope: McpConfigScope,
	configPath: string,
): Omit<McpServerConfigBase, "name"> {
	if (raw.description !== undefined && typeof raw.description !== "string") {
		throw new Error(`${configPath}: mcpServers.${serverName}.description must be a string.`);
	}
	if (raw.enabled !== undefined && typeof raw.enabled !== "boolean") {
		throw new Error(`${configPath}: mcpServers.${serverName}.enabled must be a boolean.`);
	}

	return {
		description: raw.description,
		enabled: raw.enabled ?? true,
		includeTools: asStringArray(raw.includeTools, `mcpServers.${serverName}.includeTools`, configPath),
		excludeTools: asStringArray(raw.excludeTools, `mcpServers.${serverName}.excludeTools`, configPath),
		scope,
		configPath,
	};
}

function parseStdioServerConfig(
	serverName: string,
	raw: RawMcpServerConfig,
	scope: McpConfigScope,
	configPath: string,
): StdioMcpServerConfig {
	if (typeof raw.command !== "string" || raw.command.trim().length === 0) {
		throw new Error(`${configPath}: mcpServers.${serverName}.command must be a non-empty string.`);
	}

	const resolvedCwd =
		typeof raw.cwd === "string" && raw.cwd.trim().length > 0 ? resolve(dirname(configPath), raw.cwd) : undefined;
	if (raw.cwd !== undefined && resolvedCwd === undefined) {
		throw new Error(`${configPath}: mcpServers.${serverName}.cwd must be a non-empty string when provided.`);
	}

	return {
		name: serverName,
		transport: "stdio",
		command: raw.command,
		args: asStringArray(raw.args, `mcpServers.${serverName}.args`, configPath) ?? [],
		env: asStringRecord(raw.env, `mcpServers.${serverName}.env`, configPath),
		cwd: resolvedCwd,
		...parseCommonServerFields(serverName, raw, scope, configPath),
	};
}

function parseHttpServerConfig(
	serverName: string,
	raw: RawMcpServerConfig,
	scope: McpConfigScope,
	configPath: string,
): HttpMcpServerConfig {
	if (typeof raw.url !== "string" || raw.url.trim().length === 0) {
		throw new Error(`${configPath}: mcpServers.${serverName}.url must be a non-empty string.`);
	}

	let url: URL;
	try {
		url = new URL(raw.url);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(`${configPath}: mcpServers.${serverName}.url must be a valid URL: ${message}`);
	}

	if (url.protocol !== "http:" && url.protocol !== "https:") {
		throw new Error(`${configPath}: mcpServers.${serverName}.url must use http:// or https://.`);
	}

	return {
		name: serverName,
		transport: "http",
		url: url.href,
		headers: asStringRecord(raw.headers, `mcpServers.${serverName}.headers`, configPath),
		oauth: parseHttpServerOAuthConfig(serverName, raw.oauth, configPath),
		...parseCommonServerFields(serverName, raw, scope, configPath),
	};
}

function parseServerConfig(
	serverName: string,
	value: unknown,
	scope: McpConfigScope,
	configPath: string,
): McpServerConfig {
	if (!isRecord(value)) {
		throw new Error(`${configPath}: mcpServers.${serverName} must be an object.`);
	}

	const raw = value as RawMcpServerConfig;
	return parseTransportKind(raw.transport, serverName, configPath) === "http"
		? parseHttpServerConfig(serverName, raw, scope, configPath)
		: parseStdioServerConfig(serverName, raw, scope, configPath);
}

function parseConfigFile(raw: RawMcpConfig, scope: McpConfigScope, configPath: string): Map<string, McpServerConfig> {
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

function serializeConfigFile(raw: RawMcpConfig): string {
	return `${JSON.stringify(raw, null, 2)}\n`;
}

function normalizeServerName(serverName: string, configPath: string): string {
	if (typeof serverName !== "string" || serverName.trim().length === 0) {
		throw new Error(`${configPath}: MCP server name must be a non-empty string.`);
	}

	return serverName.trim();
}

function normalizeStringArrayInput(
	value: string[] | undefined,
	fieldName: string,
	configPath: string,
): string[] | undefined {
	if (value === undefined) return undefined;
	if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
		throw new Error(`${configPath}: "${fieldName}" must be an array of strings.`);
	}

	return [...value];
}

function normalizeStringRecordInput(
	value: Record<string, string> | undefined,
	fieldName: string,
	configPath: string,
): Record<string, string> | undefined {
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

function normalizeNonEmptyStringInput(value: unknown, fieldName: string, configPath: string): string {
	if (typeof value !== "string" || value.trim().length === 0) {
		throw new Error(`${configPath}: "${fieldName}" must be a non-empty string.`);
	}

	return value.trim();
}

function normalizeSafeUrlInput(value: unknown, fieldName: string, configPath: string): string {
	const stringValue = normalizeNonEmptyStringInput(value, fieldName, configPath);

	let url: URL;
	try {
		url = new URL(stringValue);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(`${configPath}: "${fieldName}" must be a valid URL: ${message}`);
	}

	if (url.protocol === "javascript:") {
		throw new Error(`${configPath}: "${fieldName}" must not use javascript:.`);
	}

	return url.href;
}

function serializeFileBackedMcpOAuthSecretConfig(
	value: FileBackedMcpOAuthSecretConfig,
	fieldName: string,
	configPath: string,
): RawFileBackedMcpOAuthSecretConfig {
	if (!isRecord(value) || value.type !== "file") {
		throw new Error(`${configPath}: "${fieldName}.type" must be "file".`);
	}

	return {
		type: "file",
		path: normalizeNonEmptyStringInput(value.path, `${fieldName}.path`, configPath),
	};
}

function serializeFileBackedMcpOAuthPersistenceConfig(
	value: FileBackedMcpOAuthPersistenceConfigInput,
	fieldName: string,
	configPath: string,
): RawFileBackedMcpOAuthPersistenceConfig {
	if (!isRecord(value) || value.type !== "file") {
		throw new Error(`${configPath}: "${fieldName}.type" must be "file".`);
	}

	return {
		type: "file",
		dir: normalizeNonEmptyStringInput(value.dir, `${fieldName}.dir`, configPath),
	};
}

function serializeHttpServerOAuthConfig(
	serverName: string,
	value: HttpMcpServerOAuthConfigInput,
	configPath: string,
): RawHttpMcpServerOAuthConfig {
	if (!isRecord(value)) {
		throw new Error(`${configPath}: mcpServers.${serverName}.oauth must be an object.`);
	}

	const fieldPrefix = `mcpServers.${serverName}.oauth`;
	const oauthConfig: RawHttpMcpServerOAuthConfig = {
		clientId: normalizeNonEmptyStringInput(value.clientId, `${fieldPrefix}.clientId`, configPath),
		clientSecret: serializeFileBackedMcpOAuthSecretConfig(
			value.clientSecret,
			`${fieldPrefix}.clientSecret`,
			configPath,
		),
		redirectUrl: normalizeSafeUrlInput(value.redirectUrl, `${fieldPrefix}.redirectUrl`, configPath),
		persistence: serializeFileBackedMcpOAuthPersistenceConfig(
			value.persistence,
			`${fieldPrefix}.persistence`,
			configPath,
		),
	};

	const scopes = normalizeStringArrayInput(value.scopes, `${fieldPrefix}.scopes`, configPath);
	if (scopes !== undefined) {
		oauthConfig.scopes = scopes;
	}

	if (value.tokenEndpointAuthMethod !== undefined) {
		if (!isMcpOAuthTokenEndpointAuthMethod(value.tokenEndpointAuthMethod)) {
			throw new Error(
				`${configPath}: "${fieldPrefix}.tokenEndpointAuthMethod" must be "client_secret_basic", "client_secret_post", or "none".`,
			);
		}
		oauthConfig.tokenEndpointAuthMethod = value.tokenEndpointAuthMethod;
	}

	return oauthConfig;
}

function serializeCommonServerFields(
	serverConfig: McpServerConfigInput,
	configPath: string,
	raw: RawMcpServerConfig,
): string {
	const serverName = normalizeServerName(serverConfig.name, configPath);

	if (serverConfig.description !== undefined && typeof serverConfig.description !== "string") {
		throw new Error(`${configPath}: mcpServers.${serverName}.description must be a string.`);
	}
	if (serverConfig.enabled !== undefined && typeof serverConfig.enabled !== "boolean") {
		throw new Error(`${configPath}: mcpServers.${serverName}.enabled must be a boolean.`);
	}

	raw.transport = serverConfig.transport;
	if (serverConfig.description !== undefined) {
		raw.description = serverConfig.description;
	}
	if (serverConfig.enabled !== undefined) {
		raw.enabled = serverConfig.enabled;
	}

	const includeTools = normalizeStringArrayInput(
		serverConfig.includeTools,
		`mcpServers.${serverName}.includeTools`,
		configPath,
	);
	if (includeTools !== undefined) {
		raw.includeTools = includeTools;
	}

	const excludeTools = normalizeStringArrayInput(
		serverConfig.excludeTools,
		`mcpServers.${serverName}.excludeTools`,
		configPath,
	);
	if (excludeTools !== undefined) {
		raw.excludeTools = excludeTools;
	}

	return serverName;
}

function serializeServerConfig(serverConfig: McpServerConfigInput, configPath: string): [string, RawMcpServerConfig] {
	const raw: RawMcpServerConfig = {};
	const serverName = serializeCommonServerFields(serverConfig, configPath, raw);

	if (serverConfig.transport === "http") {
		if (typeof serverConfig.url !== "string" || serverConfig.url.trim().length === 0) {
			throw new Error(`${configPath}: mcpServers.${serverName}.url must be a non-empty string.`);
		}

		let url: URL;
		try {
			url = new URL(serverConfig.url.trim());
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			throw new Error(`${configPath}: mcpServers.${serverName}.url must be a valid URL: ${message}`);
		}

		if (url.protocol !== "http:" && url.protocol !== "https:") {
			throw new Error(`${configPath}: mcpServers.${serverName}.url must use http:// or https://.`);
		}

		raw.url = url.href;
		const headers = normalizeStringRecordInput(serverConfig.headers, `mcpServers.${serverName}.headers`, configPath);
		if (headers !== undefined) {
			raw.headers = headers;
		}
		if (serverConfig.oauth !== undefined) {
			raw.oauth = serializeHttpServerOAuthConfig(serverName, serverConfig.oauth, configPath);
		}
		return [serverName, raw];
	}

	if (typeof serverConfig.command !== "string" || serverConfig.command.trim().length === 0) {
		throw new Error(`${configPath}: mcpServers.${serverName}.command must be a non-empty string.`);
	}

	raw.command = serverConfig.command.trim();
	const args = normalizeStringArrayInput(serverConfig.args, `mcpServers.${serverName}.args`, configPath);
	if (args !== undefined) {
		raw.args = args;
	}

	const env = normalizeStringRecordInput(serverConfig.env, `mcpServers.${serverName}.env`, configPath);
	if (env !== undefined) {
		raw.env = env;
	}

	if (serverConfig.cwd !== undefined) {
		if (typeof serverConfig.cwd !== "string" || serverConfig.cwd.trim().length === 0) {
			throw new Error(`${configPath}: mcpServers.${serverName}.cwd must be a non-empty string when provided.`);
		}
		raw.cwd = serverConfig.cwd.trim();
	}

	return [serverName, raw];
}

function mergeServerConfig(
	existingServerConfig: unknown,
	serverConfig: McpServerConfigInput,
	configPath: string,
): [string, RawMcpServerConfig] {
	const [serverName, nextServerConfig] = serializeServerConfig(serverConfig, configPath);

	if (!isRecord(existingServerConfig)) {
		return [serverName, nextServerConfig];
	}

	for (const [key, value] of Object.entries(existingServerConfig)) {
		if (!KNOWN_SERVER_KEYS.has(key)) {
			nextServerConfig[key] = value;
		}
	}

	return [serverName, nextServerConfig];
}

function getOrCreateMcpServers(rawConfig: RawMcpConfig, configPath: string): Record<string, unknown> {
	if (rawConfig.mcpServers === undefined) {
		const servers: Record<string, unknown> = {};
		rawConfig.mcpServers = servers;
		return servers;
	}
	if (!isRecord(rawConfig.mcpServers)) {
		throw new Error(`${configPath}: "mcpServers" must be an object keyed by server name.`);
	}

	return rawConfig.mcpServers;
}

async function mutateRawMcpConfig(
	cwd: string,
	scope: McpConfigScope,
	mutate: (rawConfig: RawMcpConfig, configPath: string) => boolean,
): Promise<boolean> {
	const configPath = getMcpConfigPath(cwd, scope);

	return withFileMutationQueue(configPath, async () => {
		const existingConfig = readConfigFile(configPath);
		const nextConfig: RawMcpConfig = existingConfig ? cloneRawMcpConfig(existingConfig) : {};
		const shouldWrite = mutate(nextConfig, configPath);

		if (!shouldWrite) {
			return false;
		}

		const nextSerialized = serializeConfigFile(nextConfig);
		const existingSerialized = existingConfig ? serializeConfigFile(existingConfig) : undefined;
		if (existingSerialized === nextSerialized) {
			return false;
		}

		await mkdir(dirname(configPath), { recursive: true });
		await writeFile(configPath, nextSerialized, "utf-8");
		return true;
	});
}

export function getUserMcpConfigPath(): string {
	return join(getHomeDir(), ".pi", "agent", "mcp.json");
}

export function getProjectMcpConfigPath(cwd: string): string {
	return join(cwd, ".pi", "mcp.json");
}

export function readRawMcpConfig(cwd: string, scope: McpConfigScope): RawMcpConfig {
	const configPath = getMcpConfigPath(cwd, scope);
	const config = readConfigFile(configPath);
	return config ? cloneRawMcpConfig(config) : {};
}

export async function upsertMcpServerConfig(
	cwd: string,
	scope: McpConfigScope,
	serverConfig: McpServerConfigInput,
): Promise<boolean> {
	return mutateRawMcpConfig(cwd, scope, (rawConfig, configPath) => {
		const servers = getOrCreateMcpServers(rawConfig, configPath);
		const normalizedServerName = normalizeServerName(serverConfig.name, configPath);
		const [serverName, nextServerConfig] = mergeServerConfig(
			servers[normalizedServerName],
			{ ...serverConfig, name: normalizedServerName },
			configPath,
		);
		servers[serverName] = nextServerConfig;
		return true;
	});
}

export async function removeMcpServerConfig(cwd: string, scope: McpConfigScope, serverName: string): Promise<boolean> {
	return mutateRawMcpConfig(cwd, scope, (rawConfig, configPath) => {
		const normalizedServerName = normalizeServerName(serverName, configPath);
		if (rawConfig.mcpServers === undefined) {
			return false;
		}
		if (!isRecord(rawConfig.mcpServers)) {
			throw new Error(`${configPath}: "mcpServers" must be an object keyed by server name.`);
		}
		if (!hasOwnKey(rawConfig.mcpServers, normalizedServerName)) {
			return false;
		}

		delete rawConfig.mcpServers[normalizedServerName];
		return true;
	});
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
