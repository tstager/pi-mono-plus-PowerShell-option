import { Type } from "@sinclair/typebox";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getModel } from "../src/models.js";
import { streamAnthropic } from "../src/providers/anthropic.js";
import type { Context, Tool } from "../src/types.js";

const mockState = vi.hoisted(() => ({
	events: [] as Array<Record<string, unknown>>,
	streamParams: undefined as Record<string, unknown> | undefined,
}));

vi.mock("@anthropic-ai/sdk", () => {
	class FakeAnthropic {
		messages = {
			stream: (params: Record<string, unknown>) => {
				mockState.streamParams = params;
				return {
					async *[Symbol.asyncIterator]() {
						for (const event of mockState.events) {
							yield event;
						}
					},
				};
			},
		};
	}

	return { default: FakeAnthropic };
});

describe("Anthropic tool schema conversion", () => {
	beforeEach(() => {
		mockState.streamParams = undefined;
		mockState.events = [
			{
				type: "message_start",
				message: {
					id: "msg_test",
					usage: {
						input_tokens: 10,
						output_tokens: 0,
						cache_read_input_tokens: 0,
						cache_creation_input_tokens: 0,
					},
				},
			},
			{
				type: "message_delta",
				delta: { stop_reason: "end_turn" },
				usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
			},
		];
	});

	it("preserves full WebFetch-style schemas instead of collapsing them to bare properties", async () => {
		const model = getModel("anthropic", "claude-sonnet-4-20250514");
		const webFetchTool: Tool = {
			name: "web_fetch",
			description: "Fetches a URL from the internet and returns the page as markdown or raw HTML.",
			parameters: Type.Object(
				{
					url: Type.String({ description: "The URL to fetch" }),
					max_length: Type.Optional(Type.Number({ description: "Maximum number of characters to return" })),
					start_index: Type.Optional(Type.Number({ description: "Pagination offset" })),
					raw: Type.Optional(Type.Boolean({ description: "Return raw HTML instead of markdown" })),
				},
				{
					additionalProperties: false,
					description: "WebFetch parameters",
				},
			),
		};
		const context: Context = {
			systemPrompt: "You are a helpful assistant.",
			messages: [{ role: "user", content: "Fetch https://example.com", timestamp: Date.now() }],
			tools: [webFetchTool],
		};

		const stream = streamAnthropic(model, context, { apiKey: "sk-ant-oat-test-token" });
		await stream.result();

		const params = mockState.streamParams as {
			tools?: Array<{ name: string; input_schema: Record<string, unknown> }>;
		};
		expect(params.tools).toHaveLength(1);
		expect(params.tools?.[0]?.name).toBe("WebFetch");
		expect(params.tools?.[0]?.input_schema).toMatchObject({
			type: "object",
			additionalProperties: false,
			description: "WebFetch parameters",
			required: ["url"],
		});
		expect(params.tools?.[0]?.input_schema.properties).toMatchObject({
			url: { type: "string", description: "The URL to fetch" },
			max_length: { type: "number", description: "Maximum number of characters to return" },
			start_index: { type: "number", description: "Pagination offset" },
			raw: { type: "boolean", description: "Return raw HTML instead of markdown" },
		});
	});

	it("maps Claude Code WebFetch tool calls back to pi's web_fetch tool name", async () => {
		mockState.events = [
			{
				type: "message_start",
				message: {
					id: "msg_tool",
					usage: {
						input_tokens: 10,
						output_tokens: 0,
						cache_read_input_tokens: 0,
						cache_creation_input_tokens: 0,
					},
				},
			},
			{
				type: "content_block_start",
				index: 0,
				content_block: {
					type: "tool_use",
					id: "toolu_123",
					name: "WebFetch",
					input: { url: "https://example.com" },
				},
			},
			{
				type: "content_block_stop",
				index: 0,
			},
			{
				type: "message_delta",
				delta: { stop_reason: "tool_use" },
				usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
			},
		];

		const model = getModel("anthropic", "claude-sonnet-4-20250514");
		const webFetchTool: Tool = {
			name: "web_fetch",
			description: "Fetch a URL",
			parameters: Type.Object({
				url: Type.String(),
			}),
		};
		const context: Context = {
			messages: [{ role: "user", content: "Fetch the page", timestamp: Date.now() }],
			tools: [webFetchTool],
		};

		const stream = streamAnthropic(model, context, { apiKey: "sk-ant-oat-test-token" });
		const result = await stream.result();
		const toolCall = result.content.find((block) => block.type === "toolCall");

		expect(result.stopReason).toBe("toolUse");
		expect(toolCall && toolCall.type === "toolCall" ? toolCall.name : undefined).toBe("web_fetch");
	});

	it("uses Claude Code WebFetch compatibility for GitHub Copilot Anthropic requests", async () => {
		mockState.events = [
			{
				type: "message_start",
				message: {
					id: "msg_copilot_tool",
					usage: {
						input_tokens: 10,
						output_tokens: 0,
						cache_read_input_tokens: 0,
						cache_creation_input_tokens: 0,
					},
				},
			},
			{
				type: "content_block_start",
				index: 0,
				content_block: {
					type: "tool_use",
					id: "toolu_copilot_123",
					name: "WebFetch",
					input: { url: "https://example.com" },
				},
			},
			{
				type: "content_block_stop",
				index: 0,
			},
			{
				type: "message_delta",
				delta: { stop_reason: "tool_use" },
				usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
			},
		];

		const model = getModel("github-copilot", "claude-sonnet-4");
		const webFetchTool: Tool = {
			name: "web_fetch",
			description: "Fetch a URL",
			parameters: Type.Object({
				url: Type.String(),
			}),
		};
		const context: Context = {
			messages: [{ role: "user", content: "Fetch the page", timestamp: Date.now() }],
			tools: [webFetchTool],
		};

		const stream = streamAnthropic(model, context, { apiKey: "tid_copilot_session_test_token" });
		const result = await stream.result();
		const params = mockState.streamParams as { tools?: Array<{ name: string }> };
		const toolCall = result.content.find((block) => block.type === "toolCall");

		expect(params.tools?.[0]?.name).toBe("WebFetch");
		expect(result.stopReason).toBe("toolUse");
		expect(toolCall && toolCall.type === "toolCall" ? toolCall.name : undefined).toBe("web_fetch");
	});
});
