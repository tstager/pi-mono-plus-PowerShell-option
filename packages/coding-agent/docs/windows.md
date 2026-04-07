# Windows Setup

Pi keeps the public tool name `bash`, but the backend can run either a bash-compatible shell or PowerShell.

Without configuration, Pi currently resolves shells on Windows in this order:

1. Custom path from `~/.pi/agent/settings.json`
2. Git Bash in the standard install locations (`C:\Program Files\Git\bin\bash.exe` or `C:\Program Files (x86)\Git\bin\bash.exe`)
3. `bash.exe` on PATH (Cygwin, MSYS2, WSL)

For most users, [Git for Windows](https://git-scm.com/download/win) is sufficient.

If you want Pi's `bash` tool to execute PowerShell commands instead, set `shellPath` to `pwsh.exe` (PowerShell 7+) or `powershell.exe`.

## Custom Shell Path

### Bash example

```json
{
  "shellPath": "C:\\cygwin64\\bin\\bash.exe"
}
```

### PowerShell example

```json
{
  "shellPath": "C:\\Program Files\\PowerShell\\7\\pwsh.exe"
}
```

When `shellPath` points to PowerShell, model-facing tool descriptions and prompts describe PowerShell semantics, while the public tool name stays `bash` for compatibility.
