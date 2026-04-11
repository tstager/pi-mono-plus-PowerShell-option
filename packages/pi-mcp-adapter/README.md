# pi MCP Adapter

This package adds **MCP client support** to pi without modifying core `pi-coding-agent` behavior.

It:

- reads MCP server config from user and project config files
- connects to configured **stdio** MCP servers
- discovers their tools on session start
- registers them as pi tools with stable `mcp_*` tool names
- adds `/mcp-status`, `/mcp-list`, and `/mcp-reload`

## Install

```powershell
pi install .\packages\pi-mcp-adapter
```

Or load it for one run:

```powershell
pi -e .\packages\pi-mcp-adapter
```

## Configuration

Project config lives at:

```text
.pi\mcp.json
```

User config lives at:

```text
%USERPROFILE%\.pi\agent\mcp.json
```

The format is intentionally close to common MCP client configs:

```json
{
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "."]
    },
    "docs": {
      "command": "python",
      "args": ["tools/docs_server.py"],
      "cwd": "..\\tools",
      "includeTools": ["search_docs", "read_doc"]
    }
  }
}
```

## Tool Naming

Discovered MCP tools are registered with stable pi tool names:

```text
mcp_<server>_<tool>
```

For example, `filesystem.read_file` becomes something like:

```text
mcp_filesystem_read_file
```

This avoids collisions with built-in pi tools and other extensions.

## Commands

- `/mcp-status` - show configured servers, connection state, and tool counts
- `/mcp-list` - show registered MCP tools
- `/mcp-reload` - reconnect configured servers and register newly discovered tools

`/mcp-reload` refreshes current connections. If you **remove** servers or rename tools in config, use pi’s normal `/reload` to rebuild the full extension runtime cleanly.
