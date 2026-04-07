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

import { buildShellCommandArgs, createShellConfig, detectShellFamily, getShellConfig } from "../src/utils/shell.js";

describe("shell resolution", () => {
	afterEach(() => {
		mocks.settingsManagerCreate.mockReset();
		vi.restoreAllMocks();
	});

	it("detects PowerShell shells from shellPath", () => {
		expect(detectShellFamily("C:\\Program Files\\PowerShell\\7\\pwsh.exe")).toBe("powershell");
		expect(detectShellFamily("/usr/bin/powershell")).toBe("powershell");
		expect(detectShellFamily("/bin/bash")).toBe("bash");
	});

	it("builds PowerShell command arguments for pwsh shells", () => {
		const shellConfig = createShellConfig("C:\\Program Files\\PowerShell\\7\\pwsh.exe");

		expect(shellConfig.family).toBe("powershell");
		expect(buildShellCommandArgs(shellConfig, "Write-Output 'hello'")).toEqual([
			"-NoLogo",
			"-NoProfile",
			"-NonInteractive",
			"-Command",
			"Write-Output 'hello'",
		]);
	});

	it("resolves configured PowerShell shells from settings", () => {
		mocks.settingsManagerCreate.mockReturnValue({
			getShellPath: () => "C:\\Program Files\\PowerShell\\7\\pwsh.exe",
		});

		const shellConfig = getShellConfig();

		expect(shellConfig).toEqual({
			shell: "C:\\Program Files\\PowerShell\\7\\pwsh.exe",
			family: "powershell",
			args: ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command"],
		});
	});
});
