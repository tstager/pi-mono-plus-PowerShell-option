import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { type HttpMcpServerConfig, isStdioMcpServerConfig, type McpServerConfig } from "./config.js";
import {
	getGitHubCopilotMcpLoginRequiredMessage,
	isGitHubCopilotMcpUrl,
	loadGitHubCopilotMcpBearerToken,
} from "./github-copilot-mcp-auth.js";
import {
	createFileBackedOAuthClientProvider,
	type FileBackedOAuthClientProvider,
	type FileBackedOAuthProviderRuntimeState,
} from "./oauth-provider.js";
import { buildRegisteredToolName, shouldExposeTool } from "./schema.js";

const CLIENT_NAME = "pi-mcp-adapter";
const CLIENT_VERSION = "0.1.0";

type McpClient = Client;
type McpTransport = StdioClientTransport | StreamableHTTPClientTransport;
type McpListToolsResult = Awaited<ReturnType<McpClient["listTools"]>>;
type McpRemoteTool = McpListToolsResult["tools"][number];
export type McpCallToolResult = Awaited<ReturnType<McpClient["callTool"]>>;

export interface McpToolBinding {
	serverName: string;
	registeredName: string;
	toolName: string;
	description: string;
	inputSchema: unknown;
}

export interface McpServerTransportMetadata {
	target: string;
	sessionId?: string;
}

export type McpServerConnectionStatus = "connected" | "auth_required" | "error";

export type McpServerOAuthMetadata = FileBackedOAuthProviderRuntimeState;

export interface McpServerManagedAuthMetadata {
	kind: "pi";
	provider: "github-copilot";
	status: "available" | "missing";
}

export interface McpServerConnection {
	name: string;
	status: McpServerConnectionStatus;
	transportKind: McpServerConfig["transport"];
	transportMetadata: McpServerTransportMetadata;
	description?: string;
	configPath: string;
	scope: "user" | "project";
	toolCount: number;
	errorMessage?: string;
	oauth?: McpServerOAuthMetadata;
	managedAuth?: McpServerManagedAuthMetadata;
	serverConfig?: McpServerConfig;
	client?: McpClient;
	transport?: McpTransport;
}

export interface McpRuntimeState {
	servers: Map<string, McpServerConnection>;
	toolBindings: Map<string, McpToolBinding>;
	configPaths: string[];
}

export interface McpRefreshResult {
	state: McpRuntimeState;
	newBindings: McpToolBinding[];
	connectedServers: number;
	failedServers: number;
}

function getBindingKey(serverName: string, toolName: string): string {
	return `${serverName}\u0000${toolName}`;
}

export function resolveRegisteredToolName(
	serverName: string,
	toolName: string,
	usedToolNames: ReadonlySet<string>,
	previousBindingsByKey: ReadonlyMap<string, McpToolBinding>,
	reservedNames: ReadonlySet<string>,
): string {
	const previousBinding = previousBindingsByKey.get(getBindingKey(serverName, toolName));
	if (previousBinding) {
		return previousBinding.registeredName;
	}

	return buildRegisteredToolName(serverName, toolName, new Set([...reservedNames, ...usedToolNames]));
}

interface Closeable {
	close?: () => Promise<void> | void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asCloseable(value: unknown): Closeable | undefined {
	return isRecord(value) ? (value as Closeable) : undefined;
}

function getToolDescription(serverName: string, tool: McpRemoteTool): string {
	if (typeof tool.description === "string" && tool.description.trim().length > 0) {
		return tool.description;
	}
	return `Call MCP tool "${tool.name}" from server "${serverName}".`;
}

function getTransportTarget(serverConfig: McpServerConfig): string {
	return isStdioMcpServerConfig(serverConfig) ? serverConfig.command : serverConfig.url;
}

function createTransportMetadata(serverConfig: McpServerConfig, transport?: McpTransport): McpServerTransportMetadata {
	return {
		target: getTransportTarget(serverConfig),
		sessionId: transport instanceof StreamableHTTPClientTransport ? transport.sessionId : undefined,
	};
}

function isStreamableHttpTransport(transport: McpTransport): transport is StreamableHTTPClientTransport {
	return transport instanceof StreamableHTTPClientTransport;
}

function isOAuthHttpServerConfig(
	serverConfig: McpServerConfig,
): serverConfig is HttpMcpServerConfig & { oauth: NonNullable<HttpMcpServerConfig["oauth"]> } {
	return !isStdioMcpServerConfig(serverConfig) && serverConfig.oauth !== undefined;
}

function hasHeaderCaseInsensitive(headers: Record<string, string> | undefined, headerName: string): boolean {
	if (!headers) {
		return false;
	}

	const normalizedHeaderName = headerName.toLowerCase();
	return Object.keys(headers).some((key) => key.toLowerCase() === normalizedHeaderName);
}

function resolveManagedHttpHeaders(serverConfig: HttpMcpServerConfig): {
	headers?: Record<string, string>;
	missingAuthorizationMessage?: string;
	managedAuth?: McpServerManagedAuthMetadata;
} {
	const configuredHeaders = serverConfig.headers ? { ...serverConfig.headers } : undefined;
	if (serverConfig.oauth || hasHeaderCaseInsensitive(configuredHeaders, "Authorization")) {
		return { headers: configuredHeaders };
	}
	if (!isGitHubCopilotMcpUrl(serverConfig.url)) {
		return { headers: configuredHeaders };
	}

	const bearerToken = loadGitHubCopilotMcpBearerToken();
	if (!bearerToken) {
		return {
			headers: configuredHeaders,
			missingAuthorizationMessage: getGitHubCopilotMcpLoginRequiredMessage(serverConfig.name),
			managedAuth: {
				kind: "pi",
				provider: "github-copilot",
				status: "missing",
			},
		};
	}

	return {
		headers: {
			...(configuredHeaders ?? {}),
			Authorization: `Bearer ${bearerToken}`,
		},
		managedAuth: {
			kind: "pi",
			provider: "github-copilot",
			status: "available",
		},
	};
}

function createTransport(
	serverConfig: McpServerConfig,
	authProvider?: FileBackedOAuthClientProvider,
	requestHeaders?: Record<string, string>,
): McpTransport {
	if (isStdioMcpServerConfig(serverConfig)) {
		return new StdioClientTransport({
			command: serverConfig.command,
			args: serverConfig.args,
			cwd: serverConfig.cwd,
			env: serverConfig.env,
		});
	}

	const requestInit: RequestInit | undefined = requestHeaders
		? {
				headers: requestHeaders,
			}
		: undefined;

	return new StreamableHTTPClientTransport(new URL(serverConfig.url), {
		authProvider,
		requestInit,
	});
}

function createErroredConnection(
	serverName: string,
	serverConfig: McpServerConfig,
	errorMessage: string,
): McpServerConnection {
	return {
		name: serverName,
		status: "error",
		transportKind: serverConfig.transport,
		transportMetadata: createTransportMetadata(serverConfig),
		description: serverConfig.description,
		configPath: serverConfig.configPath,
		scope: serverConfig.scope,
		toolCount: 0,
		errorMessage,
		serverConfig,
	};
}

function createManagedAuthRequiredConnection(
	serverName: string,
	serverConfig: HttpMcpServerConfig,
	errorMessage: string,
	managedAuth: McpServerManagedAuthMetadata,
): McpServerConnection {
	return {
		name: serverName,
		status: "auth_required",
		transportKind: serverConfig.transport,
		transportMetadata: createTransportMetadata(serverConfig),
		description: serverConfig.description,
		configPath: serverConfig.configPath,
		scope: serverConfig.scope,
		toolCount: 0,
		errorMessage,
		managedAuth,
		serverConfig,
	};
}

async function createAuthRequiredConnection(
	serverName: string,
	serverConfig: HttpMcpServerConfig & { oauth: NonNullable<HttpMcpServerConfig["oauth"]> },
	oauthProvider: ReturnType<typeof createFileBackedOAuthClientProvider>,
	client: McpClient,
	transport: StreamableHTTPClientTransport,
): Promise<McpServerConnection> {
	return {
		name: serverName,
		status: "auth_required",
		transportKind: serverConfig.transport,
		transportMetadata: createTransportMetadata(serverConfig, transport),
		description: serverConfig.description,
		configPath: serverConfig.configPath,
		scope: serverConfig.scope,
		toolCount: 0,
		errorMessage: `OAuth authorization is required for MCP server "${serverName}". Complete the pending OAuth flow, then retry the connection.`,
		oauth: await oauthProvider.getRuntimeState(),
		serverConfig,
		client,
		transport,
	};
}

async function connectServer(
	serverName: string,
	serverConfig: McpServerConfig,
	usedToolNames: Set<string>,
	previousBindingsByKey: ReadonlyMap<string, McpToolBinding>,
	reservedNames: ReadonlySet<string>,
): Promise<{ connection: McpServerConnection; bindings: McpToolBinding[] }> {
	const oauthProvider = isOAuthHttpServerConfig(serverConfig)
		? createFileBackedOAuthClientProvider(serverConfig.oauth)
		: undefined;
	const managedHttpHeaders = !isStdioMcpServerConfig(serverConfig)
		? resolveManagedHttpHeaders(serverConfig)
		: undefined;
	if (!isStdioMcpServerConfig(serverConfig) && managedHttpHeaders?.missingAuthorizationMessage) {
		return {
			connection: createManagedAuthRequiredConnection(
				serverName,
				serverConfig,
				managedHttpHeaders.missingAuthorizationMessage,
				managedHttpHeaders.managedAuth ?? {
					kind: "pi",
					provider: "github-copilot",
					status: "missing",
				},
			),
			bindings: [],
		};
	}

	const transport = createTransport(serverConfig, oauthProvider, managedHttpHeaders?.headers);
	const client = new Client({
		name: CLIENT_NAME,
		version: CLIENT_VERSION,
	});

	try {
		await client.connect(transport);
		const toolsResult = await client.listTools();
		const bindings: McpToolBinding[] = [];

		for (const tool of toolsResult.tools) {
			if (!shouldExposeTool(serverConfig, tool.name)) {
				continue;
			}

			const registeredName = resolveRegisteredToolName(
				serverName,
				tool.name,
				usedToolNames,
				previousBindingsByKey,
				reservedNames,
			);
			usedToolNames.add(registeredName);
			bindings.push({
				serverName,
				registeredName,
				toolName: tool.name,
				description: getToolDescription(serverName, tool),
				inputSchema: tool.inputSchema,
			});
		}

		return {
			connection: {
				name: serverName,
				status: "connected",
				transportKind: serverConfig.transport,
				transportMetadata: createTransportMetadata(serverConfig, transport),
				description: serverConfig.description,
				configPath: serverConfig.configPath,
				scope: serverConfig.scope,
				toolCount: bindings.length,
				oauth: oauthProvider ? await oauthProvider.getRuntimeState() : undefined,
				managedAuth: managedHttpHeaders?.managedAuth,
				serverConfig,
				client,
				transport,
			},
			bindings,
		};
	} catch (error) {
		if (
			oauthProvider &&
			isOAuthHttpServerConfig(serverConfig) &&
			isStreamableHttpTransport(transport) &&
			error instanceof UnauthorizedError
		) {
			return {
				connection: await createAuthRequiredConnection(serverName, serverConfig, oauthProvider, client, transport),
				bindings: [],
			};
		}

		if (
			!isStdioMcpServerConfig(serverConfig) &&
			!serverConfig.oauth &&
			isGitHubCopilotMcpUrl(serverConfig.url) &&
			error instanceof UnauthorizedError
		) {
			return {
				connection: createManagedAuthRequiredConnection(
					serverName,
					serverConfig,
					getGitHubCopilotMcpLoginRequiredMessage(serverName),
					{
						kind: "pi",
						provider: "github-copilot",
						status: "missing",
					},
				),
				bindings: [],
			};
		}

		const message = error instanceof Error ? error.message : String(error);
		return {
			connection: createErroredConnection(serverName, serverConfig, message),
			bindings: [],
		};
	}
}

export function createEmptyRuntimeState(): McpRuntimeState {
	return {
		servers: new Map(),
		toolBindings: new Map(),
		configPaths: [],
	};
}

export async function closeRuntimeState(state: McpRuntimeState): Promise<void> {
	for (const server of state.servers.values()) {
		const clientClose = asCloseable(server.client)?.close;
		if (clientClose) {
			await clientClose.call(server.client);
		}

		const transportClose = asCloseable(server.transport)?.close;
		if (transportClose) {
			await transportClose.call(server.transport);
		}
	}
}

export async function reconnectServers(
	serverEntries: Array<[string, McpServerConfig]>,
	previousState: McpRuntimeState,
): Promise<McpRefreshResult> {
	const usedToolNames = new Set<string>();
	const reservedNames = new Set(previousState.toolBindings.keys());
	const previousBindingsByKey = new Map(
		[...previousState.toolBindings.values()].map(
			(binding) => [getBindingKey(binding.serverName, binding.toolName), binding] as const,
		),
	);
	const nextState = createEmptyRuntimeState();
	const newBindings: McpToolBinding[] = [];

	for (const [serverName, serverConfig] of serverEntries) {
		const { connection, bindings } = await connectServer(
			serverName,
			serverConfig,
			usedToolNames,
			previousBindingsByKey,
			reservedNames,
		);
		nextState.servers.set(serverName, connection);
		for (const binding of bindings) {
			nextState.toolBindings.set(binding.registeredName, binding);
			if (!previousState.toolBindings.has(binding.registeredName)) {
				newBindings.push(binding);
			}
		}
	}

	nextState.configPaths = [...new Set(serverEntries.map(([, serverConfig]) => serverConfig.configPath))];

	for (const [registeredName, binding] of previousState.toolBindings) {
		if (!nextState.toolBindings.has(registeredName)) {
			nextState.toolBindings.set(registeredName, binding);
		}
	}

	await closeRuntimeState(previousState);

	let connectedServers = 0;
	let failedServers = 0;
	for (const server of nextState.servers.values()) {
		if (server.status === "connected") connectedServers++;
		else failedServers++;
	}

	return {
		state: nextState,
		newBindings,
		connectedServers,
		failedServers,
	};
}

export async function finishServerAuthorization(
	state: McpRuntimeState,
	serverName: string,
	authorizationCode: string,
): Promise<McpServerOAuthMetadata> {
	const server = state.servers.get(serverName);
	if (!server || !server.serverConfig || isStdioMcpServerConfig(server.serverConfig) || !server.serverConfig.oauth) {
		throw new Error(`MCP server "${serverName}" does not have a pending OAuth authorization flow.`);
	}

	const transport =
		server.transport && isStreamableHttpTransport(server.transport)
			? server.transport
			: createTransport(server.serverConfig, createFileBackedOAuthClientProvider(server.serverConfig.oauth));
	if (!isStreamableHttpTransport(transport)) {
		throw new Error(`MCP server "${serverName}" does not support finishing OAuth on its current transport.`);
	}

	await transport.finishAuth(authorizationCode);

	const oauthProvider = createFileBackedOAuthClientProvider(server.serverConfig.oauth);
	const oauth = await oauthProvider.getRuntimeState();
	state.servers.set(serverName, {
		...server,
		errorMessage: undefined,
		oauth,
		transport,
	});
	return oauth;
}

export async function callBoundTool(
	state: McpRuntimeState,
	registeredName: string,
	argumentsObject: Record<string, unknown>,
): Promise<McpCallToolResult> {
	const binding = state.toolBindings.get(registeredName);
	if (!binding) {
		throw new Error(`Unknown MCP tool: ${registeredName}`);
	}

	const server = state.servers.get(binding.serverName);
	if (!server) {
		throw new Error(
			`MCP server "${binding.serverName}" is not currently connected. Run /reload to fully unregister removed tools, or /mcp-reload if the server config still exists.`,
		);
	}
	if (server.status === "auth_required") {
		throw new Error(
			`MCP server "${binding.serverName}" requires OAuth authorization. Complete the pending OAuth flow, then retry the tool call.`,
		);
	}
	if (server.status !== "connected" || !server.client) {
		throw new Error(
			`MCP server "${binding.serverName}" is not currently connected. Run /reload to fully unregister removed tools, or /mcp-reload if the server config still exists.`,
		);
	}

	return server.client.callTool({
		name: binding.toolName,
		arguments: argumentsObject,
	});
}
