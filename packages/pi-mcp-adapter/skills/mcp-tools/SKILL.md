---
name: mcp-tools
description: Use MCP-backed tools exposed by the pi MCP adapter package.
---

Use this when the user asks for work that depends on an installed MCP server.

Guidelines:

- Prefer MCP-backed tools when the capability clearly comes from an external MCP server.
- Look for tool names that start with `mcp_`.
- If the expected MCP tool is missing, suggest `/mcp-status` or `/mcp-list` first.
- If `/mcp-status` shows `auth_required`, have the user run `/mcp-auth` before retrying MCP-backed tools.
- If the server is not configured yet, use `/mcp-config` or `mcp_config_edit` with explicit `project` or `user` scope.
- After adding or updating MCP servers, use `/mcp-reload`.
- After removing servers or renaming tools, use `/reload` so stale MCP tool registrations are cleared.
- Do not assume MCP servers are configured unless the MCP-backed tools are actually available.
