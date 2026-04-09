---
name: subagent-single
description: Delegate one focused task to a single specialist with the subagent extension. Use when the work fits one expert and does not need fan-out or chaining.
---

# Subagent Single

Use the `subagent` tool in **single** mode when one specialist can handle the task cleanly.

## Good fits

- one focused investigation
- one implementation task for a known area
- one review pass by a specific specialist

## Pick an agent

- `scout` for fast codebase recon
- `planner` for implementation planning
- `worker` for making changes
- `reviewer` for a follow-up review

## Example

```json
{
  "agent": "scout",
  "task": "Inspect the extension loading flow and summarize the key files."
}
```
