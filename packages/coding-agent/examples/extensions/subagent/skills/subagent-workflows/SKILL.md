---
name: subagent-workflows
description: Choose bundled scout, planner, worker, and reviewer workflows for the subagent extension. Use when deciding how to compose multi-agent work for a coding task.
---

# Subagent Workflows

This package ships four bundled roles:

- `scout` for recon
- `planner` for step-by-step plans
- `worker` for implementation
- `reviewer` for post-change review

## Recommended patterns

### Recon only

Use `scout` in single mode.

### Plan from findings

Use `scout` then `planner` in chain mode.

### Implement after planning

Use `planner` then `worker` in chain mode when the worker should follow a concrete plan.

### Parallel recon

Use several `scout` tasks in parallel, then hand the combined results to `planner` or `worker`.

### Review after coding

Use `reviewer` after `worker` completes a change.
