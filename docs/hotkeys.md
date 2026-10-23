# Commands, hotkeys and the command palette

Every user-visible action of the editor is a **command** registered once in `@hsw-editor/commands`
(`packages/commands`). Key bindings, the command palette, the shortcut cheat-sheet, settings and the
AI `app_command` tool all read that one registry. The package is pure TypeScript with no DOM
dependency; the web app feeds it key events and renders the results.

Tracked in [#50](https://github.com/alex-mextner/hsw-editor/issues/50) (engine),
[#52](https://github.com/alex-mextner/hsw-editor/issues/52) (per-user settings),
[#53](https://github.com/alex-mextner/hsw-editor/issues/53) (palette) and
[#54](https://github.com/alex-mextner/hsw-editor/issues/54) (keybinding editor, cheat-sheet, migration).

## Commands

```ts
defineCommand({
  id: 'edit.undo',                       // stable dotted id, persisted in user keymaps
  title: { en: 'Undo', ru: 'Отменить' },
  description: { en: '…', ru: '…' },     // optional
  keywords: ['revert', 'отмена'],        // synonyms in any language, matched by the palette
  group: 'edit',                         // edit | view | wall | tools | bank | history | navigation | settings | help | ai | app
  when: 'canUndo',                       // when-clause; listed and runnable only while true
  keybindings: { all: ['mod+z'] },       // per-OS defaults, see below
  mutates: true,                         // changes the wall or settings: the AI asks before running it
  allowInInput: false,                   // keep the binding alive while a text field has focus (needs a modifier)
  repeat: false,                         // holding the key repeats the command
  hidden: false,                         // hide from the palette (still bindable)
                                         // default key strings are validated by defineCommand (a typo throws)
  aiHidden: false,                       // hide from the AI app_command tool
  args: z.object({ … }),                 // optional zod schema; the handler receives the parsed value
  handler: (args) => …,                  // may return a JSON value (the AI reads it) or a promise
});
```

`CommandRegistry` registers them (`register(...commands)` returns a disposer, duplicate ids throw),
lists the ones whose when-clause holds (`available(context)`) and runs them (`run(id, args, context)`
never throws: it returns `{ ok: false, reason: 'unknown' | 'disabled' | 'invalid_args' | 'failed' }`). A command without `args` refuses arguments instead of ignoring them.
Arguments are validated before the handler runs; `argsJsonSchema(id)` exposes the JSON Schema to the AI.

Settings are commands too: `settingCommands(store)` generates `settings.toggle.<id>` and
`settings.set.<id>` (with `{ value }`) so every setting can be bound to a key and changed by the AI.

## When-clauses

A tiny boolean language over **context keys**: `selection && !dialog`, `mode == 'photo' || focus == canvas`.
Operators: `!`, `&&`, `||`, parentheses, `==`, `!=` (the value is compared as text). A bare key is true for
any value except `false`, `0`, `''` and `undefined`. A clause that does not parse is never true.

| Context key | Meaning |
| --- | --- |
| `selection` | at least one wall item is selected |
| `mode` | editor mode (`wall`, `photo`, …) |
| `focus` | which region has focus (`canvas`, `bank`, `inspector`, `palette`, …) |
| `dialog` | a modal dialog is open |
| `setting.<id>` | current value of a setting, e.g. `setting.editor.snapToGrid` |

The app owns the context object it passes to the registry and the dispatcher; keys can be added freely.

## Key bindings

A binding is a **portable chord**: one to four strokes separated by spaces.

- `mod` is **Cmd on macOS and iOS, Ctrl on Windows and Linux**: `mod+z`, `mod+shift+p`.
- Literal modifiers: `ctrl`, `meta` (Cmd / Win / Super), `alt`, `shift`.
- Keys are **physical** (from `KeyboardEvent.code`): letter shortcuts also work on the Russian layout.
  Names: `a`–`z`, `0`–`9`, `f1`–`f24`, `enter escape space tab backspace delete insert home end pageup pagedown up down left right`,
  and `- = [ ] \ ; ' , . / \``. `?` is spelled `shift+/` and is recognised on every layout.
- A chord such as `mod+e mod+s` waits up to 1.5 s for its next stroke; Escape or a wrong key cancels it
  (the wrong key is swallowed); the pending chord is shown to the user.

Defaults per OS: `keybindings: { all: [...], mac?: [...], windows?: [...], linux?: [...] }`. A platform
entry replaces `all` for that platform; `[]` means unbound there.

### Where keys are ignored

The dispatcher never touches:

- **IME composition** (`isComposing`, `keyCode 229`, `key === 'Process'`): composition keystrokes pass through
  and do not disturb a chord in progress.
- **Text fields.** While an input, textarea, select or contenteditable has focus every binding is skipped, except
  commands with `allowInInput` whose chord starts with `mod`, `ctrl` or `meta` and has no `alt` (Option types characters on macOS and AltGr is
  Ctrl+Alt on Windows, so plain typing can never trigger a command). The palette itself uses this.
- Auto-repeat of a key, unless the command sets `repeat`; while a chord is pending, repeats are swallowed without changing it, and so are the repeats of the key that just finished or broke a chord (Ctrl+S would otherwise open the browser's Save Page).

When several bindings match the same chord, the winner is: a user binding over a default, then the one with a
when-clause over one without, then the later registered.

### Conflicts

`findConflicts(keymap)` reports two kinds:

- `duplicate`: two commands on the same chord whose when-clauses can hold at the same time;
- `shadow`: one command's chord is a strict prefix of another's (`mod+k` shadows `mod+k mod+s`).

Clauses that cannot both be true (`dialog` and `!dialog`, `mode == 'a'` and `mode == 'b'`) never conflict.
`conflictsWith(keymap, commands, candidate)` previews a binding while the editor is recording a key.
The engine's own sample defaults are checked to be conflict-free (`keymap.test.ts`); the editor's real defaults get the same test when they are migrated into the registry (#54).

### User keymap

Planned storage ([#52](https://github.com/alex-mextner/hsw-editor/issues/52)): per user in the server user settings (namespace `keymap`) with a localStorage mirror. The engine itself only produces and consumes the JSON below.

```json
{ "version": 1, "overrides": { "edit.undo": [{ "key": "mod+u" }], "view.toggleGrid": [] } }
```

`overrides[id]` **replaces all defaults** of that command; `[]` unbinds it; removing the entry (per-command reset) restores
the defaults. An entry may carry its own `when`. Export is the JSON above; import validates it, canonicalises keys and
drops bad entries with a warning instead of failing the whole file (an entry whose every key is bad is dropped, so the command keeps its defaults; only an explicit `[]` unbinds). Pass `knownCommandIds` only for an import *file* check: commands registered later by lazy panels must not lose their overrides when the stored keymap is loaded at startup.

## Command palette

**Cmd/Ctrl+Shift+P** (and **Cmd/Ctrl+K**) opens it. Type to search everything at once, or start with a prefix:

| Prefix | Searches |
| --- | --- |
| *(none)* | commands, settings, walls, wall items, bank elements and tools, history, docs; recents on an empty query |
| `>` | commands and settings |
| `@` | items on the wall (select and focus) |
| `#` | bank elements and tools (add to wall) |
| `:` | go to: walls, panels, history revisions |
| `?` | ask the AI |

Search is fuzzy (fzf-style scoring: word starts, consecutive runs, gaps), bilingual and forgiving:

- every item matches in both languages and through its keywords;
- a query is also tried **transliterated** (`сорт` finds *Sort*, `tema` finds *Тема*) and as if typed on the **wrong layout**
  (`ыщке` finds *Sort*, `ntvf` finds *Тема*);
- one missing or extra letter is forgiven on words of four letters or more;
- recents and frequency (a 14-day half-life, capped below the exact-title bonus) break near-ties; they never beat a clearly better text match.

Settings appear as rows with an inline control (switch, choice, number); Enter on a switch toggles it in place.  A provider that throws is reported in `failedProviders` and does not hide the others. The engine (`searchPalette`) takes providers, so the app contributes walls, wall items,
bank, history and docs without touching the ranking; everything local runs offline.

## Asking the AI from the palette

`?` mode, or the pinned **Ask AI** row for free text, sends the query to the embedded omp session in *palette mode* and streams
the answer inline. The AI changes the app through the host tool **`app_command`**:

| Request | Effect |
| --- | --- |
| `{ "op": "list", "group"?: "edit" }` | available commands with title, keybinding, args JSON Schema, `mutates`; `truncated` says when more exist |
| `{ "op": "search", "query": "…", "limit"?: 10 }` | the same, ranked by the palette's own ranking (`rankPaletteItems`) |
| `{ "op": "run", "id": "…", "args"?: { … } }` | run a command (validated like any other run) |

The tool input is one flat object (`op` plus optional `group`, `query`, `limit`, `id`, `args`) because model tool APIs require an object at the root of the schema. `executeAppCommand` (`appCommand.ts`) is the page-side implementation; it honours the abort signal (before planning and again after approval, result `cancelled`); the bridge types and the answer state live in `aiBridge.ts`. For every run it **announces the plan** (`planned`, `running`, `done` or
`failed`) so the palette shows what the AI is about to do. Commands with `mutates: true` wait for the user's approval (the arguments are validated first, so the user is never asked to approve a call that cannot run; the prompt receives an `AbortSignal`)
(`approve` mode, default) or run straight away (`auto` mode); a rejection comes back to the AI as an error. Commands with
`aiHidden`, and commands whose when-clause is false, are invisible to the AI.

The palette talks to omp only through the `PaletteAiBridge` interface (`ask`, `status`, `setAppCommandHandler`), so the omp panel
bridge ([#16](https://github.com/alex-mextner/hsw-editor/issues/16)) can implement it when it lands.
