---
name: mcp-management
description: Inspect, edit, and refresh MCP connectivity provided by the pi MCP adapter package.
---

Use this when the user wants to inspect, edit, or recover MCP connectivity.

Commands:

- `/mcp-status` shows configured servers and connection state
- `/mcp-list` shows registered MCP-backed tools
- `/mcp-config` interactively edits MCP config after selecting project or user scope
- `/mcp-auth` completes OAuth sign-in for remote HTTP MCP servers that are waiting for authorization
- `/mcp-reload` reconnects configured servers and adds newly discovered tools

Tool:

- `mcp_config_edit` edits MCP config with explicit `scope` plus `add_stdio_server`, `add_http_server`, or `remove_server`

Notes:

- MCP config is loaded from `.pi\mcp.json` in the project and `%USERPROFILE%\.pi\agent\mcp.json` for user scope.
- If the same server name exists in both scopes, the project entry wins in that workspace.
- Use `/mcp-reload` after additive or connection-setting changes.
- If `/mcp-status` shows `auth_required`, use `/mcp-auth` to complete the OAuth flow and then let the adapter reconnect.
- Use `/reload` when the config removes servers or renames tools and you want a clean runtime rebuild.
