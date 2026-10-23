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
| `command` | `["omp"]` | argv prefix that starts omp (env `HSW_EDITOR_OMP_COMMAND`: whitespace-separated words, or a JSON array for paths with spaces; an empty array means unset) |
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
| `wall_analyse_hang` | physics of the hung tools (`GET /api/walls/:id/physics`): per tool stability score and status, problems with an English sentence each (levitating, not seated, falls, tips, swings, slides off, overloaded, removal blocked / needs a tilt / needs two hands), `skipped` tools; `itemId` limits it to one tool. The system prompt tells the agent to run it after placing tools and to move unstable tools to a better holder |
| `wall_clean_background` | clean the photographed wall under the board (a "clean" variant of the photo; basic local fill, then the image backend when signed in) and wait for the result |
| `wall_request_input` | open a core input request (dimensions, variant, compare, calibration) in the editor and wait for the answer |

`vision_run` and `draw_view` are added the same way once their services land: write a `ToolFactory` and pass it as
`extraTools` to `createOmpModule` (`apps/server/src/omp/module.ts`).

### `app_command` and the command palette

`app_command` (`apps/server/src/omp/app-command-tool.ts`, registered by `createOmpModule` next to the wall tools) lets the
agent list, search and run the editor's registered commands, the same actions as the command palette and the keyboard
shortcuts. Its input is `appCommandRequestSchema` from `packages/commands` (one flat object: `op` plus `group`, `query`,
`limit`, `id`, `args`). The commands live in the page, so the tool only:

1. validates the request (zod, plus the per-op required fields) and refuses a bad one without bothering the page;
2. forwards it as a `ui_call` with `{ method: 'app_command', params }` over the existing viewport-call channel;
3. validates the page's `ui_result` against `appCommandResultSchema` and hands it to the model as JSON. A refused or failed
   command (`rejected`, `unknown`, `cancelled`, ...) is an error result carrying its `code`.

Timeouts and cancellation: a changing command waits for the user's approval, so the tool asks for a 5 minute timeout
(`APP_COMMAND_TIMEOUT_MS`, passed to `ViewportPort.call`) instead of the 20 s of `wall_view`. The call goes to the page that
sent the latest prompt (the one the user asked in, so the one that can show the approval card), not to the most active tab. When omp cancels the tool (the run is aborted), or the timeout fires, the
server sends `{ t: 'ui_cancel', id }` to the page, which aborts the `AbortSignal` of that call (the approval card closes).
A page that disconnects mid-call fails the call; the page aborts its own pending calls when its socket drops.
The name is in `HSW_TOOL_NAMES`, so omp's own "Allow tool: app_command" prompt is auto-approved; what the user must
approve is the editor-side approval of the planned action (palette answer pane), not omp's prompt.

The page side is `apps/web/src/features/omp`: the store (`store.ts`) routes `ui_call`s with method `app_command` to the
handler the palette registered (`PaletteAiBridge.setAppCommandHandler`, i.e. `executeAppCommand` behind the approval
gate) and replies with `ui_result`; without a handler it answers with an error. `paletteBridge.ts` implements
`PaletteAiBridge` on top of the store's single WebSocket (`omp.palette`, a `PaletteTransport`): `ask` sends a `prompt`
wrapped by `buildPalettePrompt` (`paletteMode.ts`: answer briefly in the user's language, act through `app_command`, never
invent command ids, say what you will do first) and maps the streamed assistant text to `AiEvent`s; `cancel` sends `abort`.
Palette questions share the panel's conversation (same omp session, same model and cost); the panel shows them as
`⌘K · <question>` without the instruction block (`conversation.ts`). If the agent is already working on something from the
panel the palette says it is busy instead of interrupting it. Known limits of sharing one session: the palette's Stop aborts the
whole omp turn, text the user steers in from the panel during a palette answer streams into the palette, and the palette-mode
instruction block stays in the conversation history (it says it applies to that message only). Wall-edit approvals (`HswPromptRequest`) still appear in the
panel only.

The palette needs the panel's connection: it is open whenever a wall is open (the dock stays mounted while collapsed). The
bridge status is `unavailable` when no wall is open or the omp child failed, `connecting` while the connection or omp is
coming up.

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
