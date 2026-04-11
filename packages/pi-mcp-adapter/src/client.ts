import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { McpServerConfig } from "./config.js";
import { buildRegisteredToolName, shouldExposeTool } from "./schema.js";

const CLIENT_NAME = "pi-mcp-adapter";
const CLIENT_VERSION = "0.1.0";

type McpClient = Client;
type McpTransport = StdioClientTransport;
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

export interface McpServerConnection {
	name: string;
	status: "connected" | "error";
	description?: string;
	configPath: string;
	scope: "user" | "project";
	toolCount: number;
	errorMessage?: string;
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

async function connectServer(
	serverName: string,
	serverConfig: McpServerConfig,
	usedToolNames: Set<string>,
	previousBindingsByKey: ReadonlyMap<string, McpToolBinding>,
	reservedNames: ReadonlySet<string>,
): Promise<{ connection: McpServerConnection; bindings: McpToolBinding[] }> {
	try {
		const transport = new StdioClientTransport({
			command: serverConfig.command,
			args: serverConfig.args,
			cwd: serverConfig.cwd,
			env: serverConfig.env,
		});
		const client = new Client({
			name: CLIENT_NAME,
			version: CLIENT_VERSION,
		});

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
				description: serverConfig.description,
				configPath: serverConfig.configPath,
				scope: serverConfig.scope,
				toolCount: bindings.length,
				client,
				transport,
			},
			bindings,
		};
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return {
			connection: {
				name: serverName,
				status: "error",
				description: serverConfig.description,
				configPath: serverConfig.configPath,
				scope: serverConfig.scope,
				toolCount: 0,
				errorMessage: message,
			},
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
	if (!server || server.status !== "connected" || !server.client) {
		throw new Error(
			`MCP server "${binding.serverName}" is not currently connected. Run /mcp-reload or /reload to refresh it.`,
		);
	}

	return server.client.callTool({
		name: binding.toolName,
		arguments: argumentsObject,
	});
}
