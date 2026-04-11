import type { ImageContent, TextContent } from "@mariozechner/pi-ai";

export interface NormalizedMcpResult {
	content: (TextContent | ImageContent)[];
	summary: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringifyValue(value: unknown): string {
	if (typeof value === "string") return value;
	try {
		return JSON.stringify(value, null, 2);
	} catch {
		return String(value);
	}
}

function formatUnsupportedContentItem(item: unknown): string {
	if (!isRecord(item)) {
		return stringifyValue(item);
	}

	const itemType = typeof item.type === "string" ? item.type : "unknown";
	return `Unsupported MCP content item (${itemType}):\n${stringifyValue(item)}`;
}

export function normalizeMcpResult(result: unknown): NormalizedMcpResult {
	const parts: (TextContent | ImageContent)[] = [];
	const unsupported: string[] = [];
	let structuredContent: unknown;
	let compatibilityToolResult: unknown;

	if (isRecord(result)) {
		if (Array.isArray(result.content)) {
			for (const item of result.content) {
				if (isRecord(item) && item.type === "text" && typeof item.text === "string") {
					parts.push({ type: "text", text: item.text });
					continue;
				}

				if (
					isRecord(item) &&
					item.type === "image" &&
					typeof item.data === "string" &&
					typeof item.mimeType === "string"
				) {
					parts.push({
						type: "image",
						data: item.data,
						mimeType: item.mimeType,
					});
					continue;
				}

				if (
					isRecord(item) &&
					item.type === "resource" &&
					isRecord(item.resource) &&
					typeof item.resource.uri === "string" &&
					typeof item.resource.text === "string"
				) {
					parts.push({
						type: "text",
						text: `${item.resource.uri}\n${item.resource.text}`,
					});
					continue;
				}

				if (
					isRecord(item) &&
					item.type === "resource" &&
					isRecord(item.resource) &&
					typeof item.resource.uri === "string" &&
					typeof item.resource.blob === "string"
				) {
					const mimeType = typeof item.resource.mimeType === "string" ? ` (${item.resource.mimeType})` : "";
					parts.push({
						type: "text",
						text: `Binary resource ${item.resource.uri}${mimeType}`,
					});
					continue;
				}

				if (isRecord(item) && item.type === "resource_link" && typeof item.uri === "string") {
					const description = typeof item.description === "string" ? `\n${item.description}` : "";
					parts.push({
						type: "text",
						text: `Resource link: ${item.uri}${description}`,
					});
					continue;
				}

				if (isRecord(item) && item.type === "audio" && typeof item.mimeType === "string") {
					parts.push({
						type: "text",
						text: `Audio output (${item.mimeType}) returned by MCP tool.`,
					});
					continue;
				}

				unsupported.push(formatUnsupportedContentItem(item));
			}
		}

		if ("structuredContent" in result) {
			structuredContent = result.structuredContent;
		}
		if ("toolResult" in result) {
			compatibilityToolResult = result.toolResult;
		}
	}

	if (unsupported.length > 0) {
		parts.push({
			type: "text",
			text: unsupported.join("\n\n"),
		});
	}

	if (parts.length === 0 && structuredContent !== undefined) {
		parts.push({
			type: "text",
			text: stringifyValue(structuredContent),
		});
	}

	if (parts.length === 0 && compatibilityToolResult !== undefined) {
		parts.push({
			type: "text",
			text: stringifyValue(compatibilityToolResult),
		});
	}

	if (parts.length === 0) {
		parts.push({
			type: "text",
			text: "(MCP tool returned no content.)",
		});
	}

	return {
		content: parts,
		summary: parts
			.filter((item): item is TextContent => item.type === "text")
			.map((item) => item.text)
			.join("\n")
			.trim(),
	};
}
