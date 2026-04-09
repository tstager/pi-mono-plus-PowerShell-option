---
name: subagent-authoring
description: Create and update reusable custom agents for the subagent extension. Use when the built-in scout, planner, worker, or reviewer roles are not enough.
---

# Subagent Authoring

This package exposes two authoring surfaces:

- `subagent_create_agent` for model-driven agent creation
- `/subagent-agent` for interactive manual authoring

## Prefer the tool when

- the model already knows the target role
- you want the new agent created as part of a larger workflow
- you can provide the name, description, tools, and prompt directly

## Prefer the slash command when

- you want to review each field interactively
- you want to write or revise the system prompt in the editor
- you want an explicit overwrite confirmation

## Tool example

```json
{
  "name": "typescript-reviewer",
  "description": "Reviews TypeScript changes for correctness, edge cases, and type safety.",
  "scope": "project",
  "tools": ["read", "grep", "find", "ls"]
}
```

## Slash command

```bash
/subagent-agent
```
