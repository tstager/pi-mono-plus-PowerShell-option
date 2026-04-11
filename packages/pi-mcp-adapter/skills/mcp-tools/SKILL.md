---
name: mcp-tools
description: Use MCP-backed tools exposed by the pi MCP adapter package.
---

Use this when the user asks for work that depends on an installed MCP server.

Guidelines:

- Prefer MCP-backed tools when the capability clearly comes from an external MCP server.
- Look for tool names that start with `mcp_`.
- If the expected MCP tool is missing, suggest `/mcp-status` or `/mcp-reload`.
- Do not assume MCP servers are configured unless the MCP-backed tools are actually available.
