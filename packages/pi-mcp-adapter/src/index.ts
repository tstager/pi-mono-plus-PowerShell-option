import { spawn } from "node:child_process";
import type { ExtensionAPI, ExtensionUIContext } from "@mariozechner/pi-coding-agent";
import {
	callBoundTool,
	createEmptyRuntimeState,
	finishServerAuthorization,
	type McpRuntimeState,
	type McpServerConnection,
	type McpToolBinding,
	reconnectServers,
} from "./client.js";
import { loadMcpConfig } from "./config.js";
import { handleMcpConfigCommand } from "./config-command.js";
import { executeMcpConfigEdit, McpConfigEditParametersSchema } from "./config-management.js";
import { normalizeMcpResult } from "./content.js";
import { createToolParametersSchema } from "./schema.js";

const MAX_STATUS_ERROR_LENGTH = 160;

function formatStatusError(message: string): string {
	const normalized = message.replace(/\s+/g, " ").trim();
	if (normalized.length <= MAX_STATUS_ERROR_LENGTH) {
		return normalized;
	}
	return `${normalized.slice(0, MAX_STATUS_ERROR_LENGTH - 1)}…`;
}

function formatServerStatus(server: McpServerConnection): string {
	if (server.status === "auth_required" && server.managedAuth?.kind === "pi") {
		return "auth_required (pi login required)";
	}
	return server.status;
}

function appendServerStatus(lines: string[], server: McpServerConnection): void {
	lines.push(`- ${server.name}`);
	lines.push(`  scope: ${server.scope}`);
	lines.push(`  transport: ${server.transportKind}`);
	lines.push(`  status: ${formatServerStatus(server)}`);
	lines.push(`  tool count: ${server.toolCount}`);
	lines.push(`  ${server.transportKind === "http" ? "url" : "command"}: ${server.transportMetadata.target}`);
	if (server.transportMetadata.sessionId) {
		lines.push(`  session: ${server.transportMetadata.sessionId}`);
	}
	if (server.oauth) {
		lines.push(`  oauth: ${server.oauth.status}`);
		lines.push(`  oauth client id: ${server.oauth.clientId}`);
		lines.push(`  oauth scopes: ${server.oauth.scopes.length > 0 ? server.oauth.scopes.join(", ") : "(none)"}`);
		if (server.oauth.authorizationUrl) {
			lines.push("  oauth authorization url: ready (run /mcp-auth)");
		}
	}
	if (server.managedAuth) {
		lines.push(`  auth: pi (${server.managedAuth.provider})`);
		lines.push(`  auth status: ${server.managedAuth.status}`);
	}
	if (server.errorMessage) {
		lines.push(`  error: ${formatStatusError(server.errorMessage)}`);
	}
}

function formatBindingContext(state: McpRuntimeState, binding: McpToolBinding): string {
	const server = state.servers.get(binding.serverName);
	if (!server) {
		return "";
	}
	if (server.status === "connected") {
		return ` [${server.transportKind}]`;
	}
	return ` [${server.transportKind}, ${server.status}]`;
}

export function buildStatusReport(state: McpRuntimeState): string {
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

	const servers = [...state.servers.values()].sort((left, right) => left.name.localeCompare(right.name));
	for (const [index, server] of servers.entries()) {
		if (index > 0) {
			lines.push("");
		}
		appendServerStatus(lines, server);
	}

	return lines.join("\n");
}

export function buildToolListReport(state: McpRuntimeState): string {
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
				`- ${binding.registeredName} -> ${binding.serverName}.${binding.toolName}${formatBindingContext(state, binding)}${binding.description ? ` — ${binding.description}` : ""}`,
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

function getServersRequiringAuthorization(state: McpRuntimeState): McpServerConnection[] {
	return [...state.servers.values()]
		.filter((server) => server.status === "auth_required" && server.oauth)
		.sort((left, right) => left.name.localeCompare(right.name));
}

function buildOAuthAuthorizationReport(server: McpServerConnection): string {
	if (!server.oauth) {
		return `MCP server "${server.name}" does not expose OAuth state.`;
	}

	const lines = [
		"MCP OAuth authorization",
		"",
		`Server: ${server.name}`,
		`Scope: ${server.scope}`,
		`URL: ${server.transportMetadata.target}`,
		`OAuth state: ${server.oauth.status}`,
		`OAuth client ID: ${server.oauth.clientId}`,
		`OAuth redirect URL: ${server.oauth.redirectUrl}`,
		`OAuth scopes: ${server.oauth.scopes.length > 0 ? server.oauth.scopes.join(", ") : "(none)"}`,
		`Authorization URL: ${server.oauth.authorizationUrl ?? "Not available. Run /mcp-reload to restart the OAuth flow."}`,
		"",
		"Complete the flow by pasting either the final callback URL or just the authorization code when prompted.",
	];
	return lines.join("\n");
}

function extractAuthorizationCode(input: string): string {
	const trimmed = input.trim();
	if (!trimmed) {
		throw new Error("OAuth authorization code input is required.");
	}

	try {
		const parsed = new URL(trimmed);
		const oauthError = parsed.searchParams.get("error");
		if (oauthError) {
			const description = parsed.searchParams.get("error_description");
			throw new Error(description ? `${oauthError}: ${description}` : oauthError);
		}

		const code = parsed.searchParams.get("code");
		if (!code || code.trim().length === 0) {
			throw new Error("Callback URL did not include an OAuth authorization code.");
		}
		return code;
	} catch (error) {
		if (error instanceof TypeError) {
			const params = new URLSearchParams(trimmed);
			const code = params.get("code");
			return code && code.trim().length > 0 ? code : trimmed;
		}
		throw error;
	}
}

async function openExternalUrl(url: string): Promise<void> {
	const command =
		process.platform === "win32"
			? { file: "cmd", args: ["/c", "start", "", url] }
			: process.platform === "darwin"
				? { file: "open", args: [url] }
				: { file: "xdg-open", args: [url] };

	await new Promise<void>((resolve, reject) => {
		const child = spawn(command.file, command.args, {
			detached: true,
			stdio: "ignore",
		});
		child.once("error", reject);
		child.once("spawn", () => {
			child.unref();
			resolve();
		});
	});
}

export default function mcpAdapterExtension(pi: ExtensionAPI) {
	let state = createEmptyRuntimeState();

	pi.registerTool({
		name: "mcp_config_edit",
		label: "MCP Config Edit",
		description:
			"Edit MCP server entries in project or user config files using add_stdio_server, add_http_server, or remove_server.",
		promptSnippet:
			"mcp_config_edit: edit MCP config entries with explicit scope and an explicit add/remove operation.",
		promptGuidelines: [
			'Always set scope to "project" or "user" explicitly when editing MCP config.',
			"Set overwrite: true only when you intentionally want to replace an existing MCP server entry.",
		],
		parameters: McpConfigEditParametersSchema,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const result = await executeMcpConfigEdit(ctx.cwd, params);
			return {
				content: [{ type: "text", text: result.summary }],
				details: result,
			};
		},
	});

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

	pi.registerCommand("mcp-config", {
		description: "Interactively add, remove, or raw-edit MCP server config entries with explicit scope selection.",
		handler: handleMcpConfigCommand,
	});

	pi.registerCommand("mcp-auth", {
		description: "Complete OAuth authorization for remote HTTP MCP servers that are waiting for sign-in.",
		handler: async (_args, ctx) => {
			try {
				const pendingServers = getServersRequiringAuthorization(state);
				if (pendingServers.length === 0) {
					ctx.ui.notify("No MCP servers are currently waiting for OAuth authorization.", "info");
					return;
				}

				const selectedLabel =
					pendingServers.length === 1
						? `${pendingServers[0]?.name} (${pendingServers[0]?.scope})`
						: await ctx.ui.select(
								"Choose MCP server to authorize",
								pendingServers.map((entry) => `${entry.name} (${entry.scope})`),
							);
				const selectedName = selectedLabel?.replace(/\s+\(.+$/, "");
				const server = pendingServers.find((candidate) => candidate.name === selectedName);
				if (!server) {
					ctx.ui.notify("MCP OAuth authorization cancelled.", "info");
					return;
				}

				const report = buildOAuthAuthorizationReport(server);
				await showReport(ctx.ui, "MCP OAuth", report);

				if (server.oauth?.authorizationUrl) {
					const shouldOpen = await ctx.ui.confirm(
						"Open OAuth authorization URL?",
						`${server.name}\n\n${server.oauth.authorizationUrl}`,
					);
					if (shouldOpen) {
						try {
							await openExternalUrl(server.oauth.authorizationUrl);
						} catch (error) {
							const message = error instanceof Error ? error.message : String(error);
							ctx.ui.notify(`Failed to open browser automatically: ${message}`, "warning");
						}
					}
				}

				const authorizationInput = await ctx.ui.input(
					"Paste OAuth callback URL or code",
					server.oauth?.redirectUrl ?? "authorization code",
				);
				if (!authorizationInput || authorizationInput.trim().length === 0) {
					ctx.ui.notify("MCP OAuth authorization cancelled.", "info");
					return;
				}

				await finishServerAuthorization(state, server.name, extractAuthorizationCode(authorizationInput));
				const next = await refresh(ctx.cwd);
				const refreshedServer = next.state.servers.get(server.name);
				if (refreshedServer?.status === "connected") {
					ctx.ui.notify(
						`Authorized MCP server "${server.name}". ${summarizeRefresh(next.connectedServers, next.failedServers, next.newBindings)}`,
						"info",
					);
					return;
				}

				ctx.ui.notify(
					refreshedServer?.status === "auth_required"
						? `OAuth for "${server.name}" is still pending. Re-run /mcp-auth if the provider issued a new authorization URL.`
						: `OAuth was processed for "${server.name}", but the server is still unavailable. Check /mcp-status for details.`,
					refreshedServer?.status === "error" ? "warning" : "info",
				);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				ctx.ui.notify(`MCP OAuth authorization failed: ${message}`, "error");
			}
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
