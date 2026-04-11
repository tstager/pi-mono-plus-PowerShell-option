import type { ExtensionAPI, ExtensionUIContext } from "@mariozechner/pi-coding-agent";
import {
	callBoundTool,
	createEmptyRuntimeState,
	type McpRuntimeState,
	type McpToolBinding,
	reconnectServers,
} from "./client.js";
import { loadMcpConfig } from "./config.js";
import { normalizeMcpResult } from "./content.js";
import { createToolParametersSchema } from "./schema.js";

function buildStatusReport(state: McpRuntimeState): string {
	if (state.configPaths.length === 0) {
		return "No MCP config files were found. Create .pi\\mcp.json in the project or ~/.pi/agent/mcp.json for user-wide config.";
	}

	const lines: string[] = [];
	lines.push("MCP status");
	lines.push("");
	lines.push(`Config files: ${state.configPaths.join(", ")}`);
	lines.push("");

	if (state.servers.size === 0) {
		lines.push("No enabled MCP servers are configured.");
		return lines.join("\n");
	}

	for (const server of state.servers.values()) {
		const prefix = server.status === "connected" ? "[connected]" : "[error]";
		lines.push(
			`${prefix} ${server.name} (${server.scope}) - ${server.toolCount} tool${server.toolCount === 1 ? "" : "s"}`,
		);
		if (server.errorMessage) {
			lines.push(`  ${server.errorMessage}`);
		}
	}

	return lines.join("\n");
}

function buildToolListReport(state: McpRuntimeState): string {
	const bindings = [...state.toolBindings.values()].sort((left, right) =>
		left.registeredName.localeCompare(right.registeredName),
	);
	if (bindings.length === 0) {
		return "No MCP tools are currently registered.";
	}

	return [
		"Registered MCP tools",
		"",
		...bindings.map(
			(binding) =>
				`- ${binding.registeredName} -> ${binding.serverName}.${binding.toolName}${binding.description ? ` — ${binding.description}` : ""}`,
		),
	].join("\n");
}

function summarizeRefresh(connectedServers: number, failedServers: number, newBindings: McpToolBinding[]): string {
	const parts = [`${connectedServers} server${connectedServers === 1 ? "" : "s"} connected`];
	if (failedServers > 0) {
		parts.push(`${failedServers} failed`);
	}
	if (newBindings.length > 0) {
		parts.push(`${newBindings.length} new tool${newBindings.length === 1 ? "" : "s"} registered`);
	}
	return parts.join(", ");
}

export default function mcpAdapterExtension(pi: ExtensionAPI) {
	let state = createEmptyRuntimeState();

	const registerBindingTool = (binding: McpToolBinding): void => {
		pi.registerTool({
			name: binding.registeredName,
			label: `MCP ${binding.serverName}:${binding.toolName}`,
			description: binding.description,
			promptSnippet: `${binding.registeredName}: Call MCP tool "${binding.toolName}" from server "${binding.serverName}"`,
			promptGuidelines: [
				`Use ${binding.registeredName} when the task depends on MCP server "${binding.serverName}".`,
			],
			parameters: createToolParametersSchema(
				binding.inputSchema,
				`Arguments for MCP tool "${binding.toolName}" from server "${binding.serverName}".`,
			),
			async execute(_toolCallId, params, signal) {
				if (signal?.aborted) {
					throw new Error("MCP tool call aborted.");
				}

				const rawResult = await callBoundTool(state, binding.registeredName, params as Record<string, unknown>);
				const normalized = normalizeMcpResult(rawResult);
				return {
					content: normalized.content,
					details: {
						serverName: binding.serverName,
						toolName: binding.toolName,
						registeredName: binding.registeredName,
						rawResult,
					},
				};
			},
		});
	};

	const refresh = async (cwd: string) => {
		const config = loadMcpConfig(cwd);
		const next = await reconnectServers(
			config.servers.map((server) => [server.name, server] as const),
			state,
		);
		state = next.state;
		state.configPaths = config.configPaths;
		for (const binding of next.newBindings) {
			registerBindingTool(binding);
		}
		return next;
	};

	const showReport = async (ui: ExtensionUIContext, title: string, content: string) => {
		await ui.editor(title, content);
	};

	pi.on("session_start", async (_event, ctx) => {
		try {
			const next = await refresh(ctx.cwd);
			if (next.connectedServers > 0 || next.failedServers > 0) {
				ctx.ui.notify(summarizeRefresh(next.connectedServers, next.failedServers, next.newBindings), "info");
			}
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			ctx.ui.notify(`MCP startup failed: ${message}`, "error");
		}
	});

	pi.on("session_shutdown", async () => {
		await reconnectServers([], state);
		state = createEmptyRuntimeState();
	});

	pi.registerCommand("mcp-status", {
		description: "Show MCP server connection status and configured tool counts.",
		handler: async (_args, ctx) => {
			await showReport(ctx.ui, "MCP Status", buildStatusReport(state));
		},
	});

	pi.registerCommand("mcp-list", {
		description: "Show the currently registered MCP-backed pi tools.",
		handler: async (_args, ctx) => {
			await showReport(ctx.ui, "MCP Tools", buildToolListReport(state));
		},
	});

	pi.registerCommand("mcp-reload", {
		description: "Reconnect configured MCP servers and register newly discovered tools.",
		handler: async (_args, ctx) => {
			try {
				const next = await refresh(ctx.cwd);
				ctx.ui.notify(summarizeRefresh(next.connectedServers, next.failedServers, next.newBindings), "info");
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				ctx.ui.notify(`MCP reload failed: ${message}`, "error");
			}
		},
	});
}
