import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { withFileMutationQueue } from "@mariozechner/pi-coding-agent";
import { findNearestProjectAgentsDir } from "./agents.js";

export type AgentAuthoringScope = "user" | "project";

export const DEFAULT_AGENT_TOOLS = ["read", "grep", "find", "ls", "bash"];
const AGENT_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export interface AgentAuthoringInput {
	cwd: string;
	name: string;
	description: string;
	scope: AgentAuthoringScope;
	systemPrompt?: string;
	tools?: string[] | string;
	model?: string;
	overwrite?: boolean;
	userAgentsDir?: string;
	projectAgentsDir?: string | null;
}

export interface AgentAuthoringResult {
	filePath: string;
	scope: AgentAuthoringScope;
	content: string;
}

export function normalizeAgentName(name: string): string | null {
	const normalized = name
		.trim()
		.toLowerCase()
		.replace(/[_\s]+/g, "-")
		.replace(/-+/g, "-")
		.replace(/^-|-$/g, "");

	return AGENT_NAME_PATTERN.test(normalized) ? normalized : null;
}

export function normalizeAgentTools(tools: string[] | string | undefined): string[] | undefined {
	if (!tools) return undefined;

	const rawValues = Array.isArray(tools) ? tools : tools.split(",");
	const normalized = rawValues
		.map((toolName) => toolName.trim())
		.filter(Boolean)
		.filter((toolName, index, all) => all.indexOf(toolName) === index);

	return normalized.length > 0 ? normalized : undefined;
}

export function buildDefaultSystemPrompt(name: string, description: string): string {
	return [
		`You are ${name}, a specialized subagent.`,
		"",
		description,
		"",
		"Guidelines:",
		"- Stay focused on the delegated task.",
		"- Return concise, implementation-ready output.",
		"- Mention concrete files, commands, or follow-up steps when they matter.",
	].join("\n");
}

export function renderAgentDefinition(
	input: Omit<AgentAuthoringInput, "cwd" | "overwrite" | "userAgentsDir" | "projectAgentsDir">,
): string {
	const tools = normalizeAgentTools(input.tools);
	const systemPrompt = (input.systemPrompt?.trim() || buildDefaultSystemPrompt(input.name, input.description)).trim();

	const frontmatterLines = [
		"---",
		`name: ${JSON.stringify(input.name)}`,
		`description: ${JSON.stringify(input.description)}`,
		...(tools ? [`tools: ${JSON.stringify(tools.join(", "))}`] : []),
		...(input.model?.trim() ? [`model: ${JSON.stringify(input.model.trim())}`] : []),
		"---",
	];

	return `${frontmatterLines.join("\n")}\n\n${systemPrompt}\n`;
}

export function resolveAgentFilePath({
	cwd,
	name,
	scope,
	userAgentsDir,
	projectAgentsDir,
}: Pick<AgentAuthoringInput, "cwd" | "name" | "scope" | "userAgentsDir" | "projectAgentsDir">): string {
	const targetDir =
		scope === "user"
			? (userAgentsDir ?? path.join(os.homedir(), ".pi", "agent", "agents"))
			: (projectAgentsDir ?? findNearestProjectAgentsDir(cwd) ?? path.join(cwd, ".pi", "agents"));

	return path.join(targetDir, `${name}.md`);
}

export async function writeAgentDefinition(input: AgentAuthoringInput): Promise<AgentAuthoringResult> {
	const normalizedName = normalizeAgentName(input.name);
	if (!normalizedName) {
		throw new Error("Agent names must use lowercase letters, numbers, and single hyphens.");
	}

	const description = input.description.trim();
	if (!description) {
		throw new Error("Agent description is required.");
	}

	const filePath = resolveAgentFilePath({
		cwd: input.cwd,
		name: normalizedName,
		scope: input.scope,
		userAgentsDir: input.userAgentsDir,
		projectAgentsDir: input.projectAgentsDir,
	});
	const content = renderAgentDefinition({
		name: normalizedName,
		description,
		scope: input.scope,
		systemPrompt: input.systemPrompt,
		tools: input.tools,
		model: input.model,
	});

	await withFileMutationQueue(filePath, async () => {
		if (!input.overwrite && fs.existsSync(filePath)) {
			throw new Error(`Agent already exists at ${filePath}. Set overwrite to replace it.`);
		}

		await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
		await fs.promises.writeFile(filePath, content, { encoding: "utf-8", mode: 0o600 });
	});

	return {
		filePath,
		scope: input.scope,
		content,
	};
}
