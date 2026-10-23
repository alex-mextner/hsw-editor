# omp integration (agent panel and wall tools)

hsw-editor embeds the [omp](https://github.com/can1357/oh-my-pi) coding agent. The daemon starts and supervises
one `omp --mode rpc-ui` child per open wall, relays it to the page over a WebSocket, and registers *host tools*
so the agent edits the wall through the same op stream as the human. Spike evidence and the decision record
(thin own client over `omp://rpc.md`, vendored MIT renderers) are in issue #16.

```
page (React panel) <-- WebSocket /api/omp/ws?wall=<id> --> daemon (apps/server/src/omp) <-- JSONL stdio --> omp child
                                                              |  host tools: wall_get / wall_apply / ...   (HTTP on the daemon itself)
                                                              +- viewport calls (screenshot, selection) -> page -> back
```

## What runs where

| Piece | Path |
| --- | --- |
| Wire types shared by page and daemon (omp frames, WebSocket envelopes, validation, in-flight tracker) | `packages/omp-protocol` |
| Child process, framing (v1 lines, v2 `rpc_chunk`), supervision, snapshot/resync, dialogs, host-tool dispatch | `apps/server/src/omp/{child,frame,session,host}.ts` |
| HTTP/WebSocket routes (a `ServerModule`) | `apps/server/src/omp/{module,routes}.ts` |
| Wall tools and the agent's system prompt | `apps/server/src/omp/{wall-tools,prompt}.ts` |
| Panel UI, store, reducer, viewport bridge | `apps/web/src/features/omp/` |
| Vendored renderers (MIT, upstream `can1357/oh-my-pi` `collab-web`) | `apps/web/src/features/omp/vendor/` (see its `VENDORED.md`) |

## Configuration

`~/.config/hsw-editor/config.json`, key `omp` (all optional):

| Key | Default | Meaning |
| --- | --- | --- |
| `command` | `["omp"]` | argv prefix that starts omp (env `HSW_EDITOR_OMP_COMMAND`, space separated) |
| `model`, `thinking` | omp's own default | passed as `--model` / `--thinking` (env `HSW_EDITOR_OMP_MODEL`, `HSW_EDITOR_OMP_THINKING`) |
| `approvalMode` | `write` | omp tool approval: `always-ask`, `write`, `yolo` (env `HSW_EDITOR_OMP_APPROVAL`). `yolo` approves everything including shell: not recommended |
| `extraArgs` | `[]` | appended to the omp argv (`--profile`, `--tools`, ...) |
| `envPassthrough` | base set | extra variable names copied to the child; `OMP_*` and `PI_*` always pass |
| `destructiveOps` | `ask` | bulk removals by the agent: `ask` (user approves), `deny`, `allow` |
| `destructiveThreshold` | `5` | removals in one `wall_apply` call above this need approval |
| `autoApproveWallTools` | `true` | answer omp's own "Allow tool: wall_*" prompt for our host tools (the destructive gate above still applies) |
| `maxChildren` | `3` | concurrent omp processes; an idle one is stopped to make room |
| `idleStopMinutes` | `10` | stop a child nobody is attached to (it resumes on the next attach) |

The child runs with `--approval-mode`, `--no-title --no-extensions --no-skills --no-rules --no-lsp`, `--session-dir
<home>/omp/<wallId> --continue` and `cwd = <home>/walls/<wallId>`. Sessions are therefore per wall, and a reload, a
daemon restart or an idle stop resumes the same conversation. Only that directory is ever listed.

## Safety model

- Loopback only: the daemon binds `127.0.0.1`, the global guard checks `Host` and `Origin`, and the omp module also
  refuses non-loopback peers.
- The page can only send an allow-listed set of omp commands (`BLOCKED_RPC_COMMANDS` in `packages/omp-protocol`):
  no `bash`, `login`/`logout`, `export_html`, `open_session`, no host-tool or event-filter registration.
  `switch_session` must point inside the wall's session directory. The page never receives environment variables or
  credentials; authentication stays inside omp (`~/.omp/agent`).
- Shell access exists only through omp itself: every tool call that needs approval becomes an Approve/Deny card.
  Unanswered dialogs are kept and re-sent when the page reconnects (omp never times them out).
- Wall edits from the agent are ordinary ops (`actor = {kind:"agent", name:"omp"}`), validated by the reducer,
  appended to the history, pushed to the page over SSE and undoable like human edits.
- The system prompt tells the agent never to touch printers or write `wall.json` directly.

## Host tools

Registered with `set_host_tools` (`loadMode: essential`, so the model calls them directly). Argument schemas are the
zod schemas of `packages/core` rendered with `z.toJSONSchema`.

| Tool | Purpose |
| --- | --- |
| `wall_get` | wall JSON (compact when large), rev, undo/redo availability, geometry warnings, current selection |
| `wall_apply` | atomic batch of ops with optional `baseRev`; returns new rev, generated ids, warnings |
| `wall_undo` | undo/redo on the shared linear history (optionally guarded by `baseRev`) |
| `wall_bank_search` | search the element bank; returns ids, sizes, cells and parameters |
| `wall_select` | highlight items in the editor |
| `wall_view` | screenshot of the 3D viewport as an image block (requires an open editor window) |
| `wall_ask_user` | ask for choices / dimensions / text in the panel |

`vision_run` and `draw_view` are added the same way once their services land: write a `ToolFactory` and append it in
`apps/server/src/omp/module.ts`.

## Protocol notes (omp 18.8.1)

- After `ready` the daemon negotiates protocol v2 (so oversized frames arrive as `rpc_chunk` and are reassembled
  server-side), enables `set_ask_dialog`, switches to delta `message_update` frames and registers the host tools.
- A page that attaches gets `snapshot = get_messages + the in-flight frames` captured atomically with that response
  (everything after it is streamed live), so mid-turn reloads neither lose nor duplicate output.
- The panel renders from `agent_start/end`, `message_*`, `tool_execution_*`, `queue_update`, `auto_retry_*`,
  `auto_compaction_*`, `notice`, `extension_ui_request`, `get_state` (todos, context usage, model) and
  `get_session_stats` (cost and tokens).

### TUI features not reachable through RPC (or deliberately blocked)

- User `!`/`!!` shell commands (the RPC `bash` command bypasses the approval flow; blocked for the page).
- `/login`, `/logout`, account switching (secret prompts are unsupported over RPC; blocked).
- Terminal-only widgets: custom editor/header/footer components, theme switching, tool-output expansion hotkeys,
  raw terminal input, autocomplete composition, live voice (`live_*`), voice/TTS commands.
- Session HTML export to an arbitrary path (`export_html` writes files; blocked) and `open_session` into another
  directory (a per-wall session dir is used instead).
- The session tree browser (`get_tree` exists, the panel offers list/switch/fork/new instead), message-level
  branching UI, `/btw` side questions UI, subagent drill-down/steering UI (the `task` tool card still shows progress),
  slash-command argument completion popups (commands run when typed), Agent Hub and goal mode controls, prompt
  history search, image output preview from `generate_image` beyond the tool card, settings editing (`/config`).
- Rich `ask` previews render as text; MCP OAuth challenges have no RPC handler in either mode.
