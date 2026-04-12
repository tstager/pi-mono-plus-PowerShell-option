import { type Static, type TUnsafe, Type } from "@sinclair/typebox";
import {
	getProjectMcpConfigPath,
	getUserMcpConfigPath,
	type HttpMcpServerConfigInput,
	type HttpMcpServerOAuthConfigInput,
	type McpConfigScope,
	type McpOAuthTokenEndpointAuthMethod,
	readRawMcpConfig,
	removeMcpServerConfig,
	type StdioMcpServerConfigInput,
	upsertMcpServerConfig,
} from "./config.js";

const MCP_CONFIG_SCOPE_VALUES = ["project", "user"] as const;
const MCP_CONFIG_OPERATION_VALUES = ["add_stdio_server", "add_http_server", "remove_server"] as const;
const OAUTH_TOKEN_ENDPOINT_AUTH_METHOD_VALUES = ["client_secret_basic", "client_secret_post", "none"] as const;

function stringEnum<T extends readonly string[]>(values: T, description?: string): TUnsafe<T[number]> {
	return Type.Unsafe<T[number]>({
		type: "string",
		enum: [...values],
		...(description ? { description } : {}),
	});
}

const McpConfigScopeSchema = stringEnum(MCP_CONFIG_SCOPE_VALUES, 'Target config scope: "project" or "user".');
const StringArraySchema = Type.Array(Type.String());
const StringRecordSchema = Type.Record(Type.String(), Type.String());
const OAuthTokenEndpointAuthMethodSchema = stringEnum(
	OAUTH_TOKEN_ENDPOINT_AUTH_METHOD_VALUES,
	'OAuth token endpoint auth method: "client_secret_basic", "client_secret_post", or "none".',
);
const FileBackedMcpOAuthSecretSchema = Type.Object(
	{
		type: Type.Literal("file"),
		path: Type.String({ minLength: 1, description: "Path to a file that contains the OAuth client secret." }),
	},
	{ additionalProperties: false },
);
const FileBackedMcpOAuthPersistenceSchema = Type.Object(
	{
		type: Type.Literal("file"),
		dir: Type.String({
			minLength: 1,
			description: "Directory used to persist OAuth state files such as tokens and discovery metadata.",
		}),
	},
	{ additionalProperties: false },
);
const HttpMcpServerOAuthSchema = Type.Object(
	{
		clientId: Type.String({ minLength: 1, description: "Pre-registered OAuth client ID." }),
		clientSecret: FileBackedMcpOAuthSecretSchema,
		redirectUrl: Type.String({ minLength: 1, description: "OAuth redirect URL registered for the client." }),
		scopes: Type.Optional(StringArraySchema),
		tokenEndpointAuthMethod: Type.Optional(OAuthTokenEndpointAuthMethodSchema),
		persistence: FileBackedMcpOAuthPersistenceSchema,
	},
	{
		additionalProperties: false,
		description:
			"Optional OAuth configuration for remote HTTP MCP servers using a pre-registered client and file-backed OAuth persistence.",
	},
);

export const McpConfigEditParametersSchema = Type.Object(
	{
		operation: stringEnum(
			MCP_CONFIG_OPERATION_VALUES,
			'Config operation: "add_stdio_server", "add_http_server", or "remove_server".',
		),
		scope: McpConfigScopeSchema,
		name: Type.String({ minLength: 1, description: "MCP server name." }),
		overwrite: Type.Optional(Type.Boolean({ description: "Replace an existing server entry when adding." })),
		command: Type.Optional(
			Type.String({ minLength: 1, description: 'Required when operation is "add_stdio_server".' }),
		),
		args: Type.Optional(StringArraySchema),
		env: Type.Optional(StringRecordSchema),
		cwd: Type.Optional(Type.String({ minLength: 1 })),
		url: Type.Optional(Type.String({ minLength: 1, description: 'Required when operation is "add_http_server".' })),
		headers: Type.Optional(StringRecordSchema),
		oauth: Type.Optional(HttpMcpServerOAuthSchema),
	},
	{
		additionalProperties: false,
		description:
			"Edit MCP config entries with an explicit scope using add_stdio_server, add_http_server, or remove_server.",
	},
);

type McpConfigEditSchemaParams = Static<typeof McpConfigEditParametersSchema>;

export interface AddStdioServerParams {
	operation: "add_stdio_server";
	scope: McpConfigScope;
	name: string;
	overwrite?: boolean;
	command: string;
	args?: string[];
	env?: Record<string, string>;
	cwd?: string;
}

export interface AddHttpServerParams {
	operation: "add_http_server";
	scope: McpConfigScope;
	name: string;
	overwrite?: boolean;
	url: string;
	headers?: Record<string, string>;
	oauth?: HttpMcpServerOAuthConfigInput;
}

export interface RemoveServerParams {
	operation: "remove_server";
	scope: McpConfigScope;
	name: string;
}

export type McpConfigEditToolParams = AddStdioServerParams | AddHttpServerParams | RemoveServerParams;
export type McpConfigAddToolParams = AddStdioServerParams | AddHttpServerParams;
type McpConfigEditOperation = McpConfigEditToolParams["operation"];
type McpConfigEditOutcome = "added" | "updated" | "unchanged" | "removed" | "not_found";

interface McpConfigEditDetailsBase {
	operation: McpConfigEditOperation;
	scope: McpConfigScope;
	name: string;
	configPath: string;
	changed: boolean;
	outcome: McpConfigEditOutcome;
	summary: string;
	overwrite?: boolean;
}

export interface McpConfigEditStdioDetails extends McpConfigEditDetailsBase {
	operation: "add_stdio_server";
	command: string;
	args: string[];
	envKeys: string[];
	cwd?: string;
}

export interface McpConfigEditHttpDetails extends McpConfigEditDetailsBase {
	operation: "add_http_server";
	url: string;
	headerKeys: string[];
	oauth?: {
		clientId: string;
		clientSecretPath: string;
		redirectUrl: string;
		scopes: string[];
		tokenEndpointAuthMethod?: McpOAuthTokenEndpointAuthMethod;
		persistenceDir: string;
	};
}

export interface McpConfigEditRemoveDetails extends McpConfigEditDetailsBase {
	operation: "remove_server";
}

export type McpConfigEditDetails = McpConfigEditStdioDetails | McpConfigEditHttpDetails | McpConfigEditRemoveDetails;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isMcpOAuthTokenEndpointAuthMethod(value: unknown): value is McpOAuthTokenEndpointAuthMethod {
	return value === "client_secret_basic" || value === "client_secret_post" || value === "none";
}

function requireNonEmptyString(value: unknown, fieldName: string, operation: McpConfigEditOperation): string {
	if (typeof value !== "string" || value.trim().length === 0) {
		throw new Error(`"${fieldName}" is required when operation is "${operation}".`);
	}
	return value.trim();
}

function requireOptionalStringArray(
	value: unknown,
	fieldName: string,
	operation: McpConfigEditOperation,
): string[] | undefined {
	if (value === undefined) {
		return undefined;
	}
	if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
		throw new Error(`"${fieldName}" must be an array of strings when operation is "${operation}".`);
	}

	return [...value];
}

export function validateHttpOAuthConfigInput(
	value: unknown,
	operation: Extract<McpConfigEditOperation, "add_http_server"> = "add_http_server",
): HttpMcpServerOAuthConfigInput {
	if (!isRecord(value)) {
		throw new Error(`"oauth" must be an object when operation is "${operation}".`);
	}
	if (!isRecord(value.clientSecret)) {
		throw new Error(`"oauth.clientSecret" must be an object when operation is "${operation}".`);
	}
	if (!isRecord(value.persistence)) {
		throw new Error(`"oauth.persistence" must be an object when operation is "${operation}".`);
	}
	if (value.clientSecret.type !== "file") {
		throw new Error(`"oauth.clientSecret.type" must be "file" when operation is "${operation}".`);
	}
	if (value.persistence.type !== "file") {
		throw new Error(`"oauth.persistence.type" must be "file" when operation is "${operation}".`);
	}
	if (
		value.tokenEndpointAuthMethod !== undefined &&
		!isMcpOAuthTokenEndpointAuthMethod(value.tokenEndpointAuthMethod)
	) {
		throw new Error(
			`"oauth.tokenEndpointAuthMethod" must be "client_secret_basic", "client_secret_post", or "none" when operation is "${operation}".`,
		);
	}

	return {
		clientId: requireNonEmptyString(value.clientId, "oauth.clientId", operation),
		clientSecret: {
			type: "file",
			path: requireNonEmptyString(value.clientSecret.path, "oauth.clientSecret.path", operation),
		},
		redirectUrl: requireNonEmptyString(value.redirectUrl, "oauth.redirectUrl", operation),
		scopes: requireOptionalStringArray(value.scopes, "oauth.scopes", operation),
		tokenEndpointAuthMethod: value.tokenEndpointAuthMethod,
		persistence: {
			type: "file",
			dir: requireNonEmptyString(value.persistence.dir, "oauth.persistence.dir", operation),
		},
	};
}

function toValidatedEditParams(params: McpConfigEditSchemaParams | McpConfigEditToolParams): McpConfigEditToolParams {
	switch (params.operation) {
		case "add_stdio_server":
			return {
				operation: "add_stdio_server",
				scope: params.scope,
				name: params.name,
				overwrite: params.overwrite,
				command: requireNonEmptyString(params.command, "command", params.operation),
				args: params.args,
				env: params.env,
				cwd: params.cwd,
			};
		case "add_http_server":
			return {
				operation: "add_http_server",
				scope: params.scope,
				name: params.name,
				overwrite: params.overwrite,
				url: requireNonEmptyString(params.url, "url", params.operation),
				headers: params.headers,
				oauth: params.oauth ? validateHttpOAuthConfigInput(params.oauth, params.operation) : undefined,
			};
		case "remove_server":
			return {
				operation: "remove_server",
				scope: params.scope,
				name: params.name,
			};
	}

	throw new Error("Unsupported MCP config operation.");
}

function hasServer(rawConfig: ReturnType<typeof readRawMcpConfig>, name: string): boolean {
	if (!isRecord(rawConfig.mcpServers)) {
		return false;
	}
	return Object.hasOwn(rawConfig.mcpServers, name);
}

function getConfigPath(cwd: string, scope: McpConfigScope): string {
	return scope === "project" ? getProjectMcpConfigPath(cwd) : getUserMcpConfigPath();
}

function getTransportLabel(operation: McpConfigEditOperation): string {
	return operation === "add_http_server" ? "http" : "stdio";
}

export function buildMcpConfigEditSummary(result: McpConfigEditDetails): string {
	if (result.operation === "remove_server") {
		return result.outcome === "removed"
			? `Removed MCP server "${result.name}" from ${result.scope} config (${result.configPath}).`
			: `No change: MCP server "${result.name}" was not found in ${result.scope} config (${result.configPath}).`;
	}

	if (result.outcome === "added") {
		return `Added ${getTransportLabel(result.operation)} MCP server "${result.name}" to ${result.scope} config (${result.configPath}).`;
	}
	if (result.outcome === "updated") {
		return `Updated ${getTransportLabel(result.operation)} MCP server "${result.name}" in ${result.scope} config (${result.configPath}).`;
	}
	return `No change: MCP server "${result.name}" in ${result.scope} config already matched the requested settings (${result.configPath}).`;
}

export function buildMcpConfigReloadHint(result: McpConfigEditDetails): string {
	if (!result.changed) {
		return "No reload is needed because the config file was unchanged.";
	}
	if (result.operation === "remove_server") {
		return "Run /reload to fully unregister removed MCP tools in the current session. /mcp-reload can reconnect the remaining MCP servers.";
	}
	return "Run /mcp-reload to reconnect MCP servers in the current session.";
}

export function buildMcpConfigEditReport(result: McpConfigEditDetails): string {
	const lines = [result.summary, "", `Scope: ${result.scope}`, `Config: ${result.configPath}`];

	switch (result.operation) {
		case "add_stdio_server":
			lines.push("Transport: stdio");
			lines.push(`Command: ${result.command}`);
			lines.push(`Args: ${result.args.length > 0 ? JSON.stringify(result.args) : "(none)"}`);
			lines.push(`Environment keys: ${result.envKeys.length > 0 ? result.envKeys.join(", ") : "(none)"}`);
			if (result.cwd) {
				lines.push(`Working directory: ${result.cwd}`);
			}
			break;
		case "add_http_server":
			lines.push("Transport: http");
			lines.push(`URL: ${result.url}`);
			lines.push(`Header keys: ${result.headerKeys.length > 0 ? result.headerKeys.join(", ") : "(none)"}`);
			if (result.oauth) {
				lines.push("OAuth: enabled");
				lines.push(`OAuth client ID: ${result.oauth.clientId}`);
				lines.push(`OAuth redirect URL: ${result.oauth.redirectUrl}`);
				lines.push(`OAuth scopes: ${result.oauth.scopes.length > 0 ? result.oauth.scopes.join(", ") : "(none)"}`);
				lines.push(`OAuth client secret file: ${result.oauth.clientSecretPath}`);
				lines.push(`OAuth persistence dir: ${result.oauth.persistenceDir}`);
				lines.push(`OAuth token auth method: ${result.oauth.tokenEndpointAuthMethod ?? "(auto)"}`);
			}
			break;
		case "remove_server":
			lines.push("Action: remove server");
			break;
	}

	lines.push("", buildMcpConfigReloadHint(result));
	return lines.join("\n");
}

function toStdioServerConfigInput(params: AddStdioServerParams, name: string): StdioMcpServerConfigInput {
	return {
		name,
		transport: "stdio",
		command: params.command,
		args: params.args,
		env: params.env,
		cwd: params.cwd,
	};
}

function toHttpServerConfigInput(params: AddHttpServerParams, name: string): HttpMcpServerConfigInput {
	return {
		name,
		transport: "http",
		url: params.url,
		headers: params.headers,
		oauth: params.oauth,
	};
}

export async function executeMcpConfigEdit(
	cwd: string,
	params: McpConfigEditSchemaParams | McpConfigEditToolParams,
): Promise<McpConfigEditDetails> {
	const validatedParams = toValidatedEditParams(params);
	const name = validatedParams.name.trim();
	const configPath = getConfigPath(cwd, validatedParams.scope);
	const existedBefore = hasServer(readRawMcpConfig(cwd, validatedParams.scope), name);

	if (validatedParams.operation === "remove_server") {
		const changed = existedBefore ? await removeMcpServerConfig(cwd, validatedParams.scope, name) : false;
		const details: McpConfigEditRemoveDetails = {
			operation: "remove_server",
			scope: validatedParams.scope,
			name,
			configPath,
			changed,
			outcome: changed ? "removed" : "not_found",
			summary: "",
		};
		details.summary = buildMcpConfigEditSummary(details);
		return details;
	}

	if (existedBefore && !validatedParams.overwrite) {
		throw new Error(
			`${configPath}: MCP server "${name}" already exists in ${validatedParams.scope} scope. Pass overwrite: true to replace it.`,
		);
	}

	const changed = await upsertMcpServerConfig(
		cwd,
		validatedParams.scope,
		validatedParams.operation === "add_stdio_server"
			? toStdioServerConfigInput(validatedParams, name)
			: toHttpServerConfigInput(validatedParams, name),
	);
	const outcome = existedBefore ? (changed ? "updated" : "unchanged") : "added";

	if (validatedParams.operation === "add_stdio_server") {
		const details: McpConfigEditStdioDetails = {
			operation: "add_stdio_server",
			scope: validatedParams.scope,
			name,
			configPath,
			changed,
			outcome,
			summary: "",
			overwrite: validatedParams.overwrite ?? false,
			command: validatedParams.command,
			args: validatedParams.args ? [...validatedParams.args] : [],
			envKeys: Object.keys(validatedParams.env ?? {}).sort(),
			cwd: validatedParams.cwd,
		};
		details.summary = buildMcpConfigEditSummary(details);
		return details;
	}

	const details: McpConfigEditHttpDetails = {
		operation: "add_http_server",
		scope: validatedParams.scope,
		name,
		configPath,
		changed,
		outcome,
		summary: "",
		overwrite: validatedParams.overwrite ?? false,
		url: validatedParams.url,
		headerKeys: Object.keys(validatedParams.headers ?? {}).sort(),
		oauth: validatedParams.oauth
			? {
					clientId: validatedParams.oauth.clientId,
					clientSecretPath: validatedParams.oauth.clientSecret.path,
					redirectUrl: validatedParams.oauth.redirectUrl,
					scopes: validatedParams.oauth.scopes ? [...validatedParams.oauth.scopes] : [],
					tokenEndpointAuthMethod: validatedParams.oauth.tokenEndpointAuthMethod,
					persistenceDir: validatedParams.oauth.persistence.dir,
				}
			: undefined,
	};
	details.summary = buildMcpConfigEditSummary(details);
	return details;
}
