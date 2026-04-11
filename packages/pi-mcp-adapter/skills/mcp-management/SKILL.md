---
name: mcp-management
description: Inspect and refresh MCP connectivity provided by the pi MCP adapter package.
---

Use this when the user wants to inspect or recover MCP connectivity.

Commands:

- `/mcp-status` shows configured servers and connection state
- `/mcp-list` shows registered MCP-backed tools
- `/mcp-reload` reconnects configured servers and adds newly discovered tools

Notes:

- Use `/reload` when the config removes servers or renames tools and you want a clean runtime rebuild.
- MCP config is loaded from `.pi\mcp.json` in the project and `%USERPROFILE%\.pi\agent\mcp.json` for user scope.
