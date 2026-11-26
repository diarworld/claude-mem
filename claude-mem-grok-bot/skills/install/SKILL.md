---
name: claude-mem-install
description: >-
  Use this when setting up claude-mem on Grok Bot: local worker plus the
  internal model gateway observer (default), optional host-login observer, or
  a remote server. No Cursor required.
---
# Install claude-mem on Grok Bot

Independent of Cursor. Grok Bot has no session-start / file-read / tool-use hooks.

## Local worker + internal gateway observer (default)

```
npx claude-mem install --ide grok-bot
```

Do **not** pass `--provider host` unless you want the loopback shim. With no `--provider`, this is the internal model gateway (GPUStack) path:

- Worker on `127.0.0.1:<port>` (default `37700 + uid%100`). Do not restart if healthy.
- Transcript watcher per Grok Bot agent (`platformSource=grok-bot`)
- Observer via the internal gateway: `CLAUDE_MEM_PROVIDER=openrouter`, `CLAUDE_MEM_OPENROUTER_BASE_URL=https://gpustack.data.lmru.tech/v1`, `CLAUDE_MEM_OPENROUTER_MODEL=glm-5.3-flash` (fresh installs write these defaults; the API key comes from `CLAUDE_MEM_OPENROUTER_API_KEY` in the environment or `~/.claude-mem/.env` — a non-interactive install without it aborts)
- Interactive installer asks for the GPUStack API key when none is held
- MCP `session_start_context` at the start of a real task
- Live INDEX into `agents/<uuid>/memory/log/zz-claude-mem-inject.md` (disable with `CLAUDE_MEM_GROK_BOT_INJECT_ENABLED=false`)

No xAI key. No Claude CLI.

## Optional: local host-login observer

Explicit opt-in only. Not the user default.

```
npx claude-mem install --ide grok-bot --provider host
```

Loopback OpenAI-compatible shim on a **free** loopback port (not the worker port). Idle replies are `<skip_summary />`; finished units are one `<observation>`. This Grok login fulfills inbox jobs (skill host-observer).

## Remote worker / remote observer

Set plugin variable `CLAUDE_MEM_MCP_TOKEN` and use MCP `claude-mem-remote`.

```
npx claude-mem install --ide grok-bot --runtime server --server-url https://cmem.ai
```
