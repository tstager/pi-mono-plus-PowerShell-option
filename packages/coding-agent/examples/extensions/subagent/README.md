# Subagent Extension Package

This package turns the subagent example into an installable pi package with:

- the `subagent` tool for **single**, **parallel**, and **chain** delegation
- bundled `scout`, `planner`, `worker`, and `reviewer` agents
- the `subagent_create_agent` tool and `/subagent-agent` slash command for authoring custom agents
- markdown skills that teach pi when to use each workflow

## Install

```bash
pi install .\packages\coding-agent\examples\extensions\subagent
```

Or load it for one run:

```bash
pi -e .\packages\coding-agent\examples\extensions\subagent
```

## Bundled Agents

The package always exposes these built-in agent definitions:

- `scout`
- `planner`
- `worker`
- `reviewer`

User agents from `~/.pi/agent/agents` and project agents from `.pi/agents` are still supported. Project agents can override bundled agents when you enable `agentScope: "project"` or `agentScope: "both"`.

## Parallelism

Parallel mode now defaults to:

- **24** maximum tasks
- **8** concurrent workers

Override them per call:

```json
{
  "tasks": [
    { "agent": "scout", "task": "Inspect package A" },
    { "agent": "scout", "task": "Inspect package B" }
  ],
  "maxParallelTasks": 32,
  "maxConcurrency": 12
}
```

Or set environment variables before launching pi:

```powershell
$env:PI_SUBAGENT_MAX_PARALLEL_TASKS = "32"
$env:PI_SUBAGENT_MAX_CONCURRENCY = "12"
```

## Authoring Custom Agents

### Tool

Use `subagent_create_agent` when the model should create a reusable specialist:

```json
{
  "name": "powershell-reviewer",
  "description": "Reviews PowerShell changes for correctness and safety.",
  "scope": "project",
  "tools": ["read", "grep", "find"],
  "model": "claude-sonnet-4-5"
}
```

### Slash Command

Use the interactive authoring flow when you want to create or edit one manually:

```bash
/subagent-agent
```

It prompts for the name, description, scope, tools, model, and system prompt, then writes the markdown file into `.pi/agents` or `~/.pi/agent/agents`.
