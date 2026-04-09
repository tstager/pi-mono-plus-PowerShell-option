---
name: subagent-chain
description: Run sequential specialist handoffs with the subagent extension. Use when later steps depend on earlier output and should receive it through the {previous} placeholder.
---

# Subagent Chain

Use the `subagent` tool in **chain** mode when each step depends on the previous one.

## Common flows

- `scout` -> `planner`
- `planner` -> `worker`
- `worker` -> `reviewer`

## Guidelines

- keep each step narrow and role-specific
- use `{previous}` only where the next agent truly needs prior output
- stop chaining once the next step no longer depends on prior context

## Example

```json
{
  "chain": [
    { "agent": "scout", "task": "Inspect the authentication flow and summarize the relevant files." },
    { "agent": "planner", "task": "Using this scout output, create an implementation plan:\n\n{previous}" }
  ]
}
```
