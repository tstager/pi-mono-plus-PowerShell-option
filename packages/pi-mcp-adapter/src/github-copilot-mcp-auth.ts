import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const GITHUB_COPILOT_PROVIDER_ID = "github-copilot";

interface RawGitHubCopilotAuthEntry {
	type?: unknown;
	refresh?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function getPiAuthFilePath(): string {
	const home = process.env.HOME || process.env.USERPROFILE || homedir();
	return join(home, ".pi", "agent", "auth.json");
}

export function isGitHubCopilotMcpUrl(url: string): boolean {
	try {
		const parsed = new URL(url);
		return parsed.hostname === "api.githubcopilot.com" && parsed.pathname.startsWith("/mcp");
	} catch {
		return false;
	}
}

export function loadGitHubCopilotMcpBearerToken(): string | undefined {
	const authPath = getPiAuthFilePath();
	if (!existsSync(authPath)) {
		return undefined;
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(authPath, "utf8"));
	} catch {
		return undefined;
	}

	if (!isRecord(parsed)) {
		return undefined;
	}

	const entry = parsed[GITHUB_COPILOT_PROVIDER_ID];
	if (!isRecord(entry)) {
		return undefined;
	}

	const rawEntry = entry as RawGitHubCopilotAuthEntry;
	if (rawEntry.type !== "oauth") {
		return undefined;
	}

	return typeof rawEntry.refresh === "string" && rawEntry.refresh.trim().length > 0
		? rawEntry.refresh.trim()
		: undefined;
}

export function getGitHubCopilotMcpLoginRequiredMessage(serverName: string): string {
	return `GitHub MCP server "${serverName}" can reuse your pi GitHub Copilot login. Run /login github-copilot, then /mcp-reload.`;
}
