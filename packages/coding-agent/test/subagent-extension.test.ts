import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { discoverAgents } from "../examples/extensions/subagent/agents.js";
import { renderAgentDefinition, writeAgentDefinition } from "../examples/extensions/subagent/authoring.js";
import {
	DEFAULT_MAX_CONCURRENCY,
	DEFAULT_MAX_PARALLEL_TASKS,
	resolveExecutionLimits,
} from "../examples/extensions/subagent/config.js";
import { loadSkillsFromDir } from "../src/core/skills.js";

function writeAgentFile(dir: string, name: string, description: string): void {
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(
		path.join(dir, `${name}.md`),
		`---\nname: ${JSON.stringify(name)}\ndescription: ${JSON.stringify(description)}\n---\n\nPrompt for ${name}\n`,
		"utf-8",
	);
}

describe("subagent extension helpers", () => {
	const tempDirs: string[] = [];

	afterEach(() => {
		for (const dir of tempDirs.splice(0)) {
			fs.rmSync(dir, { recursive: true, force: true });
		}
		delete process.env.PI_SUBAGENT_MAX_PARALLEL_TASKS;
		delete process.env.PI_SUBAGENT_MAX_CONCURRENCY;
	});

	it("loads bundled skills from the package directory", () => {
		const skillsDir = path.resolve(__dirname, "../examples/extensions/subagent/skills");
		const { skills, diagnostics } = loadSkillsFromDir({
			dir: skillsDir,
			source: "test",
		});

		expect(skills.map((skill) => skill.name).sort()).toEqual([
			"subagent-authoring",
			"subagent-chain",
			"subagent-parallel",
			"subagent-single",
			"subagent-workflows",
		]);
		expect(diagnostics).toHaveLength(0);
	});

	it("prefers project agents over user and bundled agents", () => {
		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-discovery-"));
		tempDirs.push(tempDir);

		const bundledDir = path.join(tempDir, "bundled");
		const userDir = path.join(tempDir, "user");
		const projectDir = path.join(tempDir, ".pi", "agents");

		writeAgentFile(bundledDir, "shared", "bundled agent");
		writeAgentFile(bundledDir, "bundled-only", "bundled only");
		writeAgentFile(userDir, "shared", "user agent");
		writeAgentFile(userDir, "user-only", "user only");
		writeAgentFile(projectDir, "shared", "project agent");
		writeAgentFile(projectDir, "project-only", "project only");

		const discovery = discoverAgents(tempDir, "both", {
			bundledAgentsDir: bundledDir,
			userAgentsDir: userDir,
			projectAgentsDir: projectDir,
		});
		const sharedAgent = discovery.agents.find((agent) => agent.name === "shared");

		expect(sharedAgent?.source).toBe("project");
		expect(discovery.agents.some((agent) => agent.name === "bundled-only" && agent.source === "bundled")).toBe(true);
		expect(discovery.agents.some((agent) => agent.name === "user-only" && agent.source === "user")).toBe(true);
		expect(discovery.projectAgentsDir).toBe(projectDir);
		expect(discovery.bundledAgentsDir).toBe(bundledDir);
	});

	it("writes project agent definitions and refuses overwrite by default", async () => {
		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-author-"));
		tempDirs.push(tempDir);
		const projectAgentsDir = path.join(tempDir, ".pi", "agents");

		const created = await writeAgentDefinition({
			cwd: tempDir,
			name: "typescript-reviewer",
			description: "Reviews TypeScript changes for safety.",
			scope: "project",
			tools: ["read", "grep"],
			projectAgentsDir,
		});
		const content = fs.readFileSync(created.filePath, "utf-8");

		expect(created.filePath).toBe(path.join(projectAgentsDir, "typescript-reviewer.md"));
		expect(content).toContain('name: "typescript-reviewer"');
		expect(content).toContain('description: "Reviews TypeScript changes for safety."');
		expect(content).toContain('tools: "read, grep"');

		await expect(
			writeAgentDefinition({
				cwd: tempDir,
				name: "typescript-reviewer",
				description: "Reviews TypeScript changes for safety.",
				scope: "project",
				projectAgentsDir,
			}),
		).rejects.toThrow("already exists");
	});

	it("renders agent markdown with the provided prompt body", () => {
		const content = renderAgentDefinition({
			name: "worker-plus",
			description: "Implements planned changes.",
			scope: "project",
			tools: ["read", "write"],
			model: "claude-sonnet-4-5",
			systemPrompt: "Follow the plan exactly.",
		});

		expect(content).toContain('name: "worker-plus"');
		expect(content).toContain('model: "claude-sonnet-4-5"');
		expect(content).toContain("Follow the plan exactly.");
	});

	it("resolves concurrency limits from defaults, env, and overrides", () => {
		expect(resolveExecutionLimits({})).toEqual({
			maxParallelTasks: DEFAULT_MAX_PARALLEL_TASKS,
			maxConcurrency: DEFAULT_MAX_CONCURRENCY,
		});

		process.env.PI_SUBAGENT_MAX_PARALLEL_TASKS = "40";
		process.env.PI_SUBAGENT_MAX_CONCURRENCY = "12";
		expect(resolveExecutionLimits({})).toEqual({
			maxParallelTasks: 40,
			maxConcurrency: 12,
		});

		expect(
			resolveExecutionLimits({
				maxParallelTasks: 10,
				maxConcurrency: 99,
			}),
		).toEqual({
			maxParallelTasks: 10,
			maxConcurrency: 10,
		});
	});
});
