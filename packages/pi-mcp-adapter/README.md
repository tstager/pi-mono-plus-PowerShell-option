# pi MCP Adapter

This package adds **MCP client support** to pi without modifying core `pi-coding-agent` behavior.

It:

- reads MCP server config from user and project config files
- connects to configured **stdio** and **HTTP/HTTPS** MCP servers
- discovers their tools on session start
- registers them as pi tools with stable `mcp_*` tool names
- adds `/mcp-status`, `/mcp-list`, `/mcp-config`, `/mcp-auth`, and `/mcp-reload`
- exposes `mcp_config_edit` for explicit config mutations from tools/agents

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

Both scopes are loaded. If the same server name exists in both files, the **project** entry wins for the current workspace. `/mcp-config` asks for scope every time, and `mcp_config_edit` always requires an explicit `scope`.

The format is intentionally close to common MCP client configs:

```json
{
  "mcpServers": {
    "filesystem": {
      "transport": "stdio",
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "."]
    },
    "docs-http": {
      "transport": "http",
      "url": "https://example.com/mcp",
      "headers": {
        "Authorization": "Bearer ${DOCS_TOKEN}"
      }
    },
    "github": {
      "transport": "http",
      "url": "https://api.githubcopilot.com/mcp"
    },
    "github-pre-registered-oauth": {
      "transport": "http",
      "url": "https://api.githubcopilot.com/mcp",
      "oauth": {
        "clientId": "github-oauth-client-id",
        "clientSecret": {
          "type": "file",
          "path": ".\\secrets\\github-mcp-client-secret.txt"
        },
        "redirectUrl": "http://127.0.0.1:8080/callback",
        "scopes": ["read:user"],
        "tokenEndpointAuthMethod": "client_secret_post",
        "persistence": {
          "type": "file",
          "dir": ".\\oauth\\github"
        }
      }
    }
  }
}
```

Notes:

- `transport` defaults to `stdio` when omitted.
- `transport: "http"` accepts both `http://...` and `https://...` URLs.
- For `https://api.githubcopilot.com/mcp`, pi can reuse the existing `github-copilot` login stored in `~/.pi/agent/auth.json`. Configure only the URL, then run `/login github-copilot` if needed.
- HTTP servers can include optional `oauth` settings for pre-registered OAuth clients such as GitHub’s MCP endpoint when you want the MCP SDK to drive the full OAuth authorization-code flow itself.
- OAuth client secrets are loaded from the configured file path, and tokens/discovery state are persisted under the configured persistence directory.
- Common fields like `description`, `enabled`, `includeTools`, and `excludeTools` are supported in raw config JSON.
- `/mcp-config` and `mcp_config_edit` cover common add/remove flows; use raw JSON editing for advanced fields that are not part of the guided prompts/tool schema.

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
- `/mcp-config` - interactively choose scope, then add/remove servers or edit raw JSON
- `/mcp-auth` - finish OAuth sign-in for HTTP MCP servers that are waiting for authorization
- `/mcp-reload` - reconnect configured servers and register newly discovered tools

## Tool

`mcp_config_edit` edits MCP config entries with explicit scope-aware operations:

- `add_stdio_server`
- `add_http_server`
- `remove_server`

Use `overwrite: true` only when you intentionally want to replace an existing server entry in the selected scope.

## Reload Guidance

- `/mcp-reload` reconnects currently configured MCP servers and registers newly discovered tools.
- When `/mcp-status` shows `auth_required`, run `/mcp-auth` to open the authorization URL and paste back either the callback URL or the auth code.
- Use pi’s normal `/reload` after **removing** servers, renaming tools, or otherwise needing stale MCP tool registrations fully cleared from the current session.
- After raw JSON edits, `/mcp-reload` is usually enough for additive/connection changes; prefer `/reload` when the change removes or renames MCP entries.
