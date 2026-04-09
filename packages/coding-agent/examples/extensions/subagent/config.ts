export const DEFAULT_MAX_PARALLEL_TASKS = 24;
export const DEFAULT_MAX_CONCURRENCY = 8;
export const MAX_PARALLEL_TASKS_LIMIT = 64;
export const MAX_CONCURRENCY_LIMIT = 32;

export interface SubagentExecutionLimits {
	maxParallelTasks: number;
	maxConcurrency: number;
}

interface SubagentExecutionLimitOverrides {
	maxParallelTasks?: number;
	maxConcurrency?: number;
}

function parseLimitFromEnv(name: string, fallback: number, max: number): number {
	const rawValue = process.env[name];
	if (!rawValue) return fallback;

	const parsedValue = Number.parseInt(rawValue, 10);
	if (!Number.isFinite(parsedValue) || parsedValue < 1) return fallback;

	return Math.min(parsedValue, max);
}

export function resolveExecutionLimits(overrides: SubagentExecutionLimitOverrides): SubagentExecutionLimits {
	const maxParallelTasks = Math.min(
		overrides.maxParallelTasks ??
			parseLimitFromEnv("PI_SUBAGENT_MAX_PARALLEL_TASKS", DEFAULT_MAX_PARALLEL_TASKS, MAX_PARALLEL_TASKS_LIMIT),
		MAX_PARALLEL_TASKS_LIMIT,
	);
	const requestedConcurrency =
		overrides.maxConcurrency ??
		parseLimitFromEnv("PI_SUBAGENT_MAX_CONCURRENCY", DEFAULT_MAX_CONCURRENCY, MAX_CONCURRENCY_LIMIT);
	const maxConcurrency = Math.min(Math.max(1, requestedConcurrency), maxParallelTasks, MAX_CONCURRENCY_LIMIT);

	return {
		maxParallelTasks,
		maxConcurrency,
	};
}
