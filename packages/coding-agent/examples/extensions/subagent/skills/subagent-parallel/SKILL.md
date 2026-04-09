---
name: subagent-parallel
description: Fan out independent work across multiple specialists with the subagent extension. Use when tasks can run in parallel without sharing intermediate state.
---

# Subagent Parallel

Use the `subagent` tool in **parallel** mode for independent scouting, audits, or implementation slices.

## When to use

- comparing several modules
- auditing multiple files or packages
- splitting unrelated implementation tasks across specialists

## Guidelines

- partition work so tasks do not overlap
- set `maxConcurrency` high enough for your machine, but lower than `tasks.length`
- use one agent role consistently unless different roles are clearly useful

## Example

```json
{
  "tasks": [
    { "agent": "scout", "task": "Inspect package A." },
    { "agent": "scout", "task": "Inspect package B." },
    { "agent": "scout", "task": "Inspect package C." }
  ],
  "maxConcurrency": 8
}
```
