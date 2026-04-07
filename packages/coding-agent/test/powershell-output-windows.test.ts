import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	settingsManagerCreate: vi.fn(),
}));

vi.mock("../src/core/settings-manager.js", () => ({
	SettingsManager: {
		create: mocks.settingsManagerCreate,
	},
}));

vi.mock("../src/config.js", () => ({
	getBinDir: () =>
		"C:\\Users\\Trent\\OneDrive\\Documents\\My Scripts\\Code\\Projects\\pi\\pi-mono\\packages\\coding-agent\\dist\\bin",
	getSettingsPath: () =>
		"C:\\Users\\Trent\\OneDrive\\Documents\\My Scripts\\Code\\Projects\\pi\\pi-mono\\packages\\coding-agent\\settings.json",
}));

vi.mock("node:fs", async () => {
	const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
	return {
		...actual,
		existsSync: vi.fn(() => true),
	};
});

import { executeBash } from "../src/core/bash-executor.js";

describe.skipIf(process.platform !== "win32")("PowerShell-backed bash execution", () => {
	afterEach(() => {
		mocks.settingsManagerCreate.mockReset();
		vi.restoreAllMocks();
	});

	it("captures output from PowerShell shells for interactive-style execution", async () => {
		mocks.settingsManagerCreate.mockReturnValue({
			getShellPath: () => "powershell.exe",
		});

		const result = await executeBash("Write-Output 'hello from powershell'");

		expect(result.exitCode).toBe(0);
		expect(result.cancelled).toBe(false);
		expect(result.output).toContain("hello from powershell");
	});
});
