import { type TSchema, Type } from "@sinclair/typebox";
import type { McpServerConfig } from "./config.js";

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeIdentifierPart(value: string, fallback: string): string {
	const normalized = value
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "_")
		.replace(/^_+|_+$/g, "")
		.replace(/_+/g, "_");
	return normalized.length > 0 ? normalized : fallback;
}

export function buildRegisteredToolName(serverName: string, toolName: string, usedNames: ReadonlySet<string>): string {
	const serverId = normalizeIdentifierPart(serverName, "server");
	const toolId = normalizeIdentifierPart(toolName, "tool");
	const base = `mcp_${serverId}_${toolId}`;
	if (!usedNames.has(base)) return base;

	let suffix = 2;
	while (usedNames.has(`${base}_${suffix}`)) {
		suffix++;
	}
	return `${base}_${suffix}`;
}

export function shouldExposeTool(serverConfig: McpServerConfig, toolName: string): boolean {
	if (serverConfig.includeTools && !serverConfig.includeTools.includes(toolName)) {
		return false;
	}
	if (serverConfig.excludeTools?.includes(toolName)) {
		return false;
	}
	return true;
}

export function createToolParametersSchema(schema: unknown, description: string): TSchema {
	if (!isRecord(schema)) {
		return Type.Object({}, { additionalProperties: true, description });
	}

	const normalized: Record<string, unknown> = { ...schema };
	if (normalized.type === undefined) {
		normalized.type = "object";
	}
	if (normalized.description === undefined) {
		normalized.description = description;
	}

	return Type.Unsafe<Record<string, unknown>>(normalized);
}
