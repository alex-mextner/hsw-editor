# Offline wall editing (mirror, queue, reconcile)

Ticket: [#87](https://github.com/alex-mextner/hsw-editor/issues/87). Code: `apps/web/src/offline/`. The walls live on
disk behind the daemon (single writer); the browser keeps an IndexedDB **mirror** of the walls it opened and a **queue**
of edits the daemon has not acknowledged. With the daemon down the editor keeps working on mirror + queue; when the
daemon returns the queue is replayed in order. All op semantics come from `@hsw-editor/core` (`applyOp`): there is no
second reducer.

This layer is a library: the editor's wall session (`apps/web/src/wall/sync.ts`) consumes it in the follow-up that wires it
in (#87), so until then nothing in the UI calls it.

## Storage

Database `hsw-editor-offline` (IndexedDB, `idb.ts`), store `walls`: one `WallRecord` per wall id, written in one put:

| field | meaning |
| --- | --- |
| `wall` | last server wall this device saw: the **base** every queued edit sits on |
| `edits[]` | queued edits `{ id, ops (flat leaf ops, one undo step), label?, baseRev, at }` |
| `actor` | identity edits are replayed under (stable across reloads) |
| `canUndo`, `canRedo`, `nextEditId`, `savedAt` | bookkeeping |

A record that fails validation (older build, hand edit) is treated as absent; a record with one unreadable edit is
refused as a whole, never silently shortened, and `enqueueEdit` never records an edit with no operations, so what is
written always reads back. The mirror keeps the 30 most recent walls without unsent edits (`prune`, which re-checks each
record inside the delete transaction); a wall with unsent edits is never pruned. Writes of one wall are serialized and
coalesced (`WallMirror.put`). `LiveRecord` holds the open wall's record in memory: every change is a function of the
*current* record, so the editor recording an edit and the replay acknowledging one never overwrite each other.

## Replay (`replay.ts`)

`replayQueue` sends the head edit with `baseRev = record.wall.rev` (optimistic, no GET first):

1. `200` – the edit leaves the record and the record is persisted; next edit uses the acknowledged rev.
2. `409 rev_conflict` – the body carries the daemon's current wall; the queue is **reconciled** against it (below).
3. network failure – stop; the persisted record is still valid; the next reconnect resumes.
4. a refusal the daemon will repeat (`422 op_failed`) – the edit is dropped and reported (`reason: 'rejected'`).
5. `404` – the wall was deleted; `5xx` – stop with `failed`, the queue stays.

An edit whose acknowledgement was lost (browser closed after the daemon applied it) is recognised as already applied on
the next run: replaying it changes nothing (`redundant`), or, for `addItem`/`removeItem`, the daemon already has that
outcome. It is never applied twice, and its footprint is not counted as "theirs", so my own follow-up edits on the same
item are not conflicts with myself. Edits made while the replay runs are kept (they queue behind the others).

## Reconcile (`reconcile.ts`, `footprint.ts`)

Mine = queued ops; theirs = a structural diff between the base wall and the daemon's wall (no history endpoint
needed). They *conflict* only when both wrote the same field of the same entity (`item:<id>` position, rotation,
`params.<key>`, variant, lock, attach, label; `photo:`, `model:`, `wall:` name/board) or one added/removed an entity
the other edited. Moving a holder while an agent renamed it is not a conflict; a board change by the other side is not
a move of every item either (only the cell and z count then). A field the vocabulary does not know about counts as
written (`other`). Each edit is classified by replaying it with `applyOp` on the daemon's wall:

| status | meaning | asks the user |
| --- | --- | --- |
| `clean` | applies, touches nothing the other side changed | no |
| `redundant` | already satisfied on the daemon | no |
| `overlap` | applies but overwrites a field the other side changed | yes |
| `inapplicable` | reducer refuses (item removed or locked by the other side) | yes |

A daemon whose wall is *older* than the base (`diverged`: restored backup, reset) is a question as well, even with no
conflicting edit: replaying on top would silently replace what this device last saw.

Strategy (one question for the whole queue; without conflicts all three are identical, so nothing is asked):

- **rebase** – replay mine on top of theirs; refused edits are dropped and reported; mine wins overlaps.
- **keep mine** – like rebase, and an item/photo/model the other side removed is re-added as the user last saw it when
  one of my edits needs it. A lock set by the other side is never overridden.
- **keep theirs** – drop every overlapping or refused edit; clean ones still go through.

`replayQueue` without a `strategy` returns `needs-decision` (plan + the daemon's wall) and changes nothing; with a
`strategy` the resolved queue is persisted on top of the daemon's wall *before* anything is sent.

## Connection and events

`ConnectionMonitor` (`connection.ts`): online/offline state from real API results, browser events and a `/api/health`
probe with exponential backoff (1 s → 30 s, 20 % jitter; `timers.ts`). `navigator.onLine` is not trusted alone (it cannot
see a stopped daemon on localhost). A probe result older than a later success is ignored. `onReconnect` is where the replay
starts.

`ReconnectingSource` (`events.ts`): wraps `EventSource` for `/api/walls/:id/events`. When the browser gives up (a
non-200 such as a proxy 502 while the daemon restarts) it recreates the source with `?since=<last rev>`
(docs/api.md "Resume"; a `snapshot` resets the position, so a wall restored from a backup is followed); silence for 45 s
(three missed heartbeats) counts as a dead connection; `reconnectNow()` is for `online` / tab-visible events.

`createLiveSource` (`live.ts`) joins the two so there is one owner of "daemon reachable": the stream opening reports success
(and so starts the replay), the stream going down reports failure, and a recovered monitor reconnects the stream at once.
