import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { ExtensionCommandContext, ExtensionUIContext } from "@mariozechner/pi-coding-agent";
import { getProjectMcpConfigPath, getUserMcpConfigPath, type McpConfigScope } from "./config.js";
import {
	buildMcpConfigEditReport,
	executeMcpConfigEdit,
	type McpConfigAddToolParams,
	type McpConfigEditDetails,
	type McpConfigEditToolParams,
	validateHttpOAuthConfigInput,
} from "./config-management.js";

const DEFAULT_RAW_CONFIG_TEXT = '{\n  "mcpServers": {}\n}\n';
const COMMAND_CANCELLED_MESSAGE = "MCP config update cancelled.";
const SCOPE_OPTIONS = [
	{ label: "Project (.pi\\mcp.json)", scope: "project" },
	{ label: "User (~\\.pi\\agent\\mcp.json)", scope: "user" },
] as const satisfies readonly { label: string; scope: McpConfigScope }[];
const ACTION_OPTIONS = [
	{ label: "Add stdio server", operation: "add_stdio_server" },
	{ label: "Add HTTP server", operation: "add_http_server" },
	{ label: "Remove server", operation: "remove_server" },
	{ label: "Edit raw JSON (advanced)", operation: "edit_raw_json" },
] as const;

type McpConfigCommandAction = (typeof ACTION_OPTIONS)[number]["operation"];

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isErrnoException(error: unknown): error is NodeJS.ErrnoException {
	return error instanceof Error && "code" in error;
}

function getConfigPath(cwd: string, scope: McpConfigScope): string {
	return scope === "project" ? getProjectMcpConfigPath(cwd) : getUserMcpConfigPath();
}

function normalizeRequiredInput(value: string | undefined, fieldLabel: string): string | undefined {
	if (value === undefined) {
		return undefined;
	}

	const trimmed = value.trim();
	if (!trimmed) {
		throw new Error(`${fieldLabel} is required.`);
	}
	return trimmed;
}

function parseOptionalStringArray(value: string | undefined, fieldLabel: string): string[] | undefined {
	const trimmed = value?.trim();
	if (!trimmed) {
		return undefined;
	}

	const parsed = JSON.parse(trimmed) as unknown;
	if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== "string")) {
		throw new Error(`${fieldLabel} must be a JSON array of strings.`);
	}

	return [...parsed];
}

function parseOptionalStringRecord(value: string | undefined, fieldLabel: string): Record<string, string> | undefined {
	const trimmed = value?.trim();
	if (!trimmed) {
		return undefined;
	}

	const parsed = JSON.parse(trimmed) as unknown;
	if (!isRecord(parsed)) {
		throw new Error(`${fieldLabel} must be a JSON object with string values.`);
	}

	const record: Record<string, string> = {};
	for (const [key, entryValue] of Object.entries(parsed)) {
		if (typeof entryValue !== "string") {
			throw new Error(`${fieldLabel} must be a JSON object with string values.`);
		}
		record[key] = entryValue;
	}
	return record;
}

function parseOptionalHttpOAuthConfig(value: string | undefined) {
	const trimmed = value?.trim();
	if (!trimmed) {
		return undefined;
	}

	return validateHttpOAuthConfigInput(JSON.parse(trimmed));
}

function serializeRawConfig(value: Record<string, unknown>): string {
	return `${JSON.stringify(value, null, 2)}\n`;
}

function buildRawJsonReport(scope: McpConfigScope, configPath: string, changed: boolean): string {
	return [
		changed
			? `Saved raw ${scope} MCP config (${configPath}).`
			: `No change: raw ${scope} MCP config already matched the submitted JSON (${configPath}).`,
		"",
		`Scope: ${scope}`,
		`Config: ${configPath}`,
		"",
		changed
			? "Run /reload if you removed or renamed MCP servers. Otherwise /mcp-reload is usually enough to reconnect updated MCP servers in the current session."
			: "No reload is needed because the config file was unchanged.",
	].join("\n");
}

function buildPendingEditSummary(cwd: string, params: McpConfigEditToolParams): string {
	const lines = [
		"Apply MCP config change?",
		"",
		`Scope: ${params.scope}`,
		`Config: ${getConfigPath(cwd, params.scope)}`,
	];

	switch (params.operation) {
		case "add_stdio_server":
			lines.push("Action: add stdio server");
			lines.push(`Name: ${params.name}`);
			lines.push(`Command: ${params.command}`);
			lines.push(`Args: ${params.args && params.args.length > 0 ? JSON.stringify(params.args) : "(none)"}`);
			lines.push(
				`Environment keys: ${params.env ? Object.keys(params.env).sort().join(", ") || "(none)" : "(none)"}`,
			);
			if (params.cwd) {
				lines.push(`Working directory: ${params.cwd}`);
			}
			lines.push("", "Reload hint: /mcp-reload after saving.");
			break;
		case "add_http_server":
			lines.push("Action: add HTTP server");
			lines.push(`Name: ${params.name}`);
			lines.push(`URL: ${params.url}`);
			lines.push(
				`Header keys: ${params.headers ? Object.keys(params.headers).sort().join(", ") || "(none)" : "(none)"}`,
			);
			if (params.oauth) {
				lines.push("OAuth: enabled");
				lines.push(`OAuth client ID: ${params.oauth.clientId}`);
				lines.push(`OAuth redirect URL: ${params.oauth.redirectUrl}`);
				lines.push(
					`OAuth scopes: ${params.oauth.scopes && params.oauth.scopes.length > 0 ? params.oauth.scopes.join(", ") : "(none)"}`,
				);
				lines.push(`OAuth client secret file: ${params.oauth.clientSecret.path}`);
				lines.push(`OAuth persistence dir: ${params.oauth.persistence.dir}`);
				lines.push(`OAuth token auth method: ${params.oauth.tokenEndpointAuthMethod ?? "(auto)"}`);
			}
			lines.push("", "Reload hint: /mcp-reload after saving.");
			break;
		case "remove_server":
			lines.push("Action: remove server");
			lines.push(`Name: ${params.name}`);
			lines.push("", "Reload hint: /reload fully unregisters removed MCP tools.");
			break;
	}

	return lines.join("\n");
}

function buildPendingRawJsonSummary(cwd: string, scope: McpConfigScope, changed: boolean): string {
	return [
		"Apply MCP config change?",
		"",
		`Scope: ${scope}`,
		`Config: ${getConfigPath(cwd, scope)}`,
		"Action: edit raw JSON",
		`Changes detected: ${changed ? "yes" : "no"}`,
		"",
		changed
			? "Reload hint: use /reload after removals or renames; otherwise /mcp-reload is usually enough."
			: "Reload hint: none needed if nothing changed.",
	].join("\n");
}

async function confirmEditSummary(ui: ExtensionUIContext, summary: string): Promise<boolean> {
	return ui.confirm("Apply MCP config change?", summary);
}

async function promptScope(ui: ExtensionUIContext): Promise<McpConfigScope | undefined> {
	const choice = await ui.select(
		"Select MCP config scope",
		SCOPE_OPTIONS.map((option) => option.label),
	);
	return SCOPE_OPTIONS.find((option) => option.label === choice)?.scope;
}

async function promptAction(ui: ExtensionUIContext): Promise<McpConfigCommandAction | undefined> {
	const choice = await ui.select(
		"Choose MCP config action",
		ACTION_OPTIONS.map((option) => option.label),
	);
	return ACTION_OPTIONS.find((option) => option.label === choice)?.operation;
}

async function promptStdioParams(
	ui: ExtensionUIContext,
	scope: McpConfigScope,
): Promise<Extract<McpConfigEditToolParams, { operation: "add_stdio_server" }> | undefined> {
	const name = normalizeRequiredInput(await ui.input("Server name", "docs"), "Server name");
	if (!name) {
		return undefined;
	}

	const command = normalizeRequiredInput(await ui.input("Command", "node"), "Command");
	if (!command) {
		return undefined;
	}

	const args = parseOptionalStringArray(
		await ui.input("Args JSON array (optional)", '["server.js"]'),
		"Args JSON array",
	);
	const env = parseOptionalStringRecord(
		await ui.input("Environment JSON object (optional)", '{"FOO":"bar"}'),
		"Environment JSON object",
	);
	const cwd = (await ui.input("Working directory (optional)", ".\\tools"))?.trim() || undefined;

	return {
		operation: "add_stdio_server",
		scope,
		name,
		command,
		args,
		env,
		cwd,
	};
}

async function promptHttpParams(
	ui: ExtensionUIContext,
	scope: McpConfigScope,
): Promise<Extract<McpConfigEditToolParams, { operation: "add_http_server" }> | undefined> {
	const name = normalizeRequiredInput(await ui.input("Server name", "docs-http"), "Server name");
	if (!name) {
		return undefined;
	}

	const url = normalizeRequiredInput(await ui.input("HTTP URL", "https://example.com/mcp"), "HTTP URL");
	if (!url) {
		return undefined;
	}

	const headers = parseOptionalStringRecord(
		await ui.input("Headers JSON object (optional)", '{"Authorization":"Bearer token"}'),
		"Headers JSON object",
	);
	const oauth = parseOptionalHttpOAuthConfig(
		await ui.input(
			"OAuth JSON object (optional)",
			'{"clientId":"github-client-id","clientSecret":{"type":"file","path":".\\\\secrets\\\\github-mcp-client-secret.txt"},"redirectUrl":"http://127.0.0.1:4123/callback","scopes":["read:user"],"tokenEndpointAuthMethod":"client_secret_post","persistence":{"type":"file","dir":".\\\\oauth\\\\github-mcp"}}',
		),
	);

	return {
		operation: "add_http_server",
		scope,
		name,
		url,
		headers,
		oauth,
	};
}

async function promptRemoveParams(
	ui: ExtensionUIContext,
	scope: McpConfigScope,
): Promise<Extract<McpConfigEditToolParams, { operation: "remove_server" }> | undefined> {
	const name = normalizeRequiredInput(await ui.input("Server name to remove", "docs"), "Server name");
	if (!name) {
		return undefined;
	}

	return {
		operation: "remove_server",
		scope,
		name,
	};
}

async function executeConfigEdit(
	cwd: string,
	ui: ExtensionUIContext,
	params: McpConfigEditToolParams,
): Promise<McpConfigEditDetails | undefined> {
	try {
		return await executeMcpConfigEdit(cwd, params);
	} catch (error) {
		if (
			params.operation === "remove_server" ||
			!(error instanceof Error) ||
			!error.message.includes("already exists")
		) {
			throw error;
		}

		const confirmed = await ui.confirm(
			"Overwrite existing MCP server?",
			`${error.message}\n\nReplace the existing entry with the new settings?`,
		);
		if (!confirmed) {
			ui.notify(COMMAND_CANCELLED_MESSAGE, "info");
			return undefined;
		}

		const overwriteParams: McpConfigAddToolParams = {
			...params,
			overwrite: true,
		};
		return executeMcpConfigEdit(cwd, overwriteParams);
	}
}

async function loadRawConfigText(configPath: string): Promise<string> {
	try {
		return await readFile(configPath, "utf-8");
	} catch (error) {
		if (isErrnoException(error) && error.code === "ENOENT") {
			return DEFAULT_RAW_CONFIG_TEXT;
		}
		throw error;
	}
}

async function editRawJsonConfig(
	cwd: string,
	ui: ExtensionUIContext,
	scope: McpConfigScope,
): Promise<string | undefined> {
	const configPath = getConfigPath(cwd, scope);
	const existingText = await loadRawConfigText(configPath);
	const editedText = await ui.editor(`Edit raw MCP config JSON (${scope})`, existingText);
	if (editedText === undefined) {
		ui.notify(COMMAND_CANCELLED_MESSAGE, "info");
		return undefined;
	}

	const parsed = JSON.parse(editedText) as unknown;
	if (!isRecord(parsed)) {
		throw new Error("Raw MCP config must be a JSON object.");
	}

	const serialized = serializeRawConfig(parsed);
	const changed = serialized !== existingText;
	const confirmed = await confirmEditSummary(ui, buildPendingRawJsonSummary(cwd, scope, changed));
	if (!confirmed) {
		ui.notify(COMMAND_CANCELLED_MESSAGE, "info");
		return undefined;
	}

	if (changed) {
		await mkdir(dirname(configPath), { recursive: true });
		await writeFile(configPath, serialized, "utf-8");
	}

	return buildRawJsonReport(scope, configPath, changed);
}

async function showReport(ui: ExtensionUIContext, report: string): Promise<void> {
	await ui.editor("MCP Config", report);
}

export async function handleMcpConfigCommand(_args: string, ctx: ExtensionCommandContext): Promise<void> {
	try {
		const scope = await promptScope(ctx.ui);
		if (!scope) {
			ctx.ui.notify(COMMAND_CANCELLED_MESSAGE, "info");
			return;
		}

		const action = await promptAction(ctx.ui);
		if (!action) {
			ctx.ui.notify(COMMAND_CANCELLED_MESSAGE, "info");
			return;
		}

		if (action === "edit_raw_json") {
			const report = await editRawJsonConfig(ctx.cwd, ctx.ui, scope);
			if (!report) {
				return;
			}
			ctx.ui.notify(report.split("\n", 1)[0] ?? "Updated MCP config.", "info");
			await showReport(ctx.ui, report);
			return;
		}

		const params =
			action === "add_stdio_server"
				? await promptStdioParams(ctx.ui, scope)
				: action === "add_http_server"
					? await promptHttpParams(ctx.ui, scope)
					: await promptRemoveParams(ctx.ui, scope);
		if (!params) {
			return;
		}

		const confirmed = await confirmEditSummary(ctx.ui, buildPendingEditSummary(ctx.cwd, params));
		if (!confirmed) {
			ctx.ui.notify(COMMAND_CANCELLED_MESSAGE, "info");
			return;
		}

		const result = await executeConfigEdit(ctx.cwd, ctx.ui, params);
		if (!result) {
			return;
		}

		ctx.ui.notify(result.summary, "info");
		await showReport(ctx.ui, buildMcpConfigEditReport(result));
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		ctx.ui.notify(`MCP config command failed: ${message}`, "error");
	}
}
