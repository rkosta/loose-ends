# loose-ends: a Claude Code mod (handoff brief)

Repository: `~/Code/personal/loose-ends`. Mod name `loose-ends`. A side pane lists the open threads, and the status line reads `◦ 3 loose ends · oldest 12d`.

This is a self-contained brief for a Claude Code agent picking the work up in a fresh session and a fresh repository. Nothing here depends on the macs-adventure repo, where the idea was discussed.

## The problem

In long conversations, Claude often raises several points in one reply. The user picks one, the conversation goes deep on it for 5 to 10 minutes, and the other points are forgotten.

The user wants a running list of open discussion threads that:

- Claude adds to when it raises several points and only some get picked up
- the user can add to by hand
- the user can see without asking for it
- Claude closes with a note once a thread is settled
- survives `/clear` and restarts, with one list per project

## Decisions already made (don't re-ask)

- **Who adds threads:** both. Claude parks them on its own and says so in one line ("Parked: X, Y"); the user adds them with `/park`.
- **Scope:** one list per project, kept across sessions. Worktrees of one repository share the main checkout's list.
- **Token budget matters.** The user asked about context pollution. The open list must **not** go into the system prompt, because every change would invalidate the prompt cache for the whole conversation. Details are under Token budget below.
- It's a **mod**: a Claude Code plugin made of function hooks. It lives in its own repository and is shared through a marketplace file.
- **Parking is main-thread only.** Subagents and teammates can't park.
- **Only the user drops.** `/drop` exists; there is no `drop` tool.

### Settled during planning (Q1–Q5)

- **Q1, ids vs `/drop`.** Ids are never reused within a stored list's lifetime, even after `/drop` removes the highest id or a trim removes it. (The start sweep deletes a stale list whole, counter included, so a list parked later starts again at #1.) The stored value per project is `{ v: 1, nextId: number, threads: Thread[] }` (see Data for versioning), and a new id is `max(nextId, max(id) + 1)`, computed after a fresh store read. The atom still holds a bare `Thread[]`.
- **Q2, cap on a batch.** A `park` batch that would take the open count past 15 denies the whole call and writes nothing. It never parks a partial batch.
- **Q3, cap and dedupe for `/park`.** `/park` dedupes like the tool (answering `Already open as #N.`), but the 15-open cap does not apply to it: the cap message is aimed at Claude.
- **Q4, type-checking.** `tsc` is not installed and there is no `package.json`. Type-check with `npx --yes -p typescript@5 tsc --noEmit -p <repo>`, which downloads to the npx cache and writes nothing to the repo. Keep `--noEmit`: without the engine-laid `.claude-plugin/types/` the repo's `tsconfig.json` has no `noEmit` of its own, and `tsc` writes `.js` files into `hooks/`.
- **Q5, sweep of empty keys.** A project key with no threads left at all (everything `/drop`ped) has no `closedAt`; the sweep deletes it too.

## How to start

1. Load the `plugin-authoring` skill with the Skill tool **first**. It starts the engine's hot reload and writes this build's API types (`types/claude-code.d.ts`, about 14k lines, the source of truth) plus `examples/` and `reference.md`. Its paths live in a temporary folder for each Claude Code build, so read them from the skill's own text, not from this brief.
2. Read `examples/pane.tsx` (pane, atoms and commands), `examples/tool-call.ts` (tool hooks and `.catch` guards), `examples/pane.test.tsx` (the test kit) and `reference.md` § "Tools and agent types the model can call" and § "Developing one".
3. Develop it in this repository and run it with `claude --plugin-dir <repo>`, which hot-reloads in interactive sessions. Alternatively, build it in the session's mods folder as the skill describes and copy it here.
4. The user leaves changes uncommitted until they've reviewed them. Don't commit unless they say so.

## Design

**Files**
- `.claude-plugin/plugin.json`: `{ "name": "loose-ends", "version": "0.1.0", "description": "...", "types": "./types/index.d.ts" }`
- `hooks/hooks.json`: `{ "modules": ["./register.tsx"] }`
- `hooks/register.tsx`: exports `register: Register` (imported from `'claude-code'`)
- Helper modules under `hooks/` (state and write helper, pure thread logic, tools, commands, pane), imported statically from `register.tsx`. Never `import()`.
- `types/index.d.ts`: self-contained (no import or reference). Exports `Thread` and declares `PluginState['loose-ends'] = { threads: Shaped<Thread[]>; toolsReady: boolean; picked: number; dropArmed: number; paneDismissed: boolean }`
- `hooks/threads.test.tsx`
- `tsconfig.json` at the top level, extending `./.claude-plugin/types/tsconfig.json`, so `tsc --noEmit -p <repo>` works
- `.claude-plugin/types/` is **written by the engine** when it loads the mod from a watched folder (e.g. an interactive `claude --plugin-dir <repo>`). Don't write or edit it by hand.
- `.claude-plugin/marketplace.json` and a `README.md` with the install line, when the user asks to publish. Not in v1.

**Data**
- `Thread = { id: number; text: string; origin: 'claude' | 'user'; openedAt: string; closedAt?: string; note?: string }`. Times are ISO strings from `new Date(await $.clock.now()).toISOString()` (plugin-side, `$.clock.now()` is a Promise). A `note` is only valid on a closed thread; a stored note without `closedAt` makes the whole value unrecognised.
- `text` is put on one line (every whitespace run, line breaks included, becomes one space), trimmed and truncated to 60 chars at park time (120 before the first live run). A close note is put on one line the same way, so `list`, `/threads` and the close answer stay one line per thread.
- Persisted in `$.store`, the plugin's JSON store under `~/.claude` that survives sessions. Per project the value is versioned: `{ v: 1, nextId, threads }` (see Q1). Reading never throws and answers a tagged result, `{ kind: 'ok', project }` or `{ kind: 'unrecognised' }`:
  - a missing key is `ok` with an empty project;
  - `v: 1`, or no `v` with an otherwise valid shape (values written before versioning), is `ok`; the next write rewrites it with `v: 1`;
  - anything else is `unrecognised`, whole: the wrong top-level shape, any other `v` (a later version's value), a `nextId` that is not a positive integer, any thread failing validation, an `openedAt`/`closedAt` that `Date.parse` cannot read, or two threads with the same id. No thread is dropped to make a value fit.
- **Version policy.** Any change to the stored shape bumps `v`, an added field included (this build reads past an unknown top-level field, so an older build would otherwise rewrite the value without it). An older build treats a newer `v` as unreadable: it never sweeps or overwrites it.
- **Unrecognised values are never deleted or overwritten.** The sweep skips them, every write (`park`, `close`, `/park`, `/tie`, `/drop`) refuses with `stored loose ends for this project are unreadable — not overwriting` (a tool's `deny`, a command's `text`) and leaves the stored bytes as they were, `list` and `/threads` answer `stored loose ends for this project are unreadable`, and the start load and the refresh show an empty list (the pane says `Nothing open.` and the status line clears).
- **Store key:** `(await $.session.repo())?.root ?? await $.session.root()`, computed fresh for each operation. For a worktree, `repo.root` is the main working tree's root, so worktrees share one list.
- **Store limits:** `$.store` holds JSON, and `set` rejects once the whole store is over 4 MiB. There is no compare-and-swap and no change notification, so another session's writes are only seen by re-reading.
- **Ids:** `max(nextId, max(id) + 1)` after a fresh read, never reused within a stored list's lifetime (the sweep deleting a list resets it).
- **Trim:** every write keeps every open thread plus the last 50 closed (by `closedAt`).
- **Sweep:** at `session.start`, delete every store key with no open threads whose newest `closedAt` is more than 90 days old, plus keys with no threads at all (Q5). Keys with any open thread, or a closure within 90 days, stay, and so does every unrecognised value. Each stale key is re-read in its write queue just before its delete, so a write from this session that lands first keeps its list.
- Mirrored into `atom({ plugin: 'loose-ends', key: 'threads' }, [], { shape: THREADS_ATOM_SHAPE })` so the pane redraws when the list changes. A value stored under another shape tag (or none) reads as `[]`. `state.ts` and `pane.tsx` each declare it; the engine's source scan needs the plugin and key written as literals in each file, so only the shape tag (`'threads-1'`, in `threads.ts`) is shared.
- **One write helper for tools and commands.** Every mutation they make goes through it. Writes from one session are serialised per store key: a module-level queue (`Map<string, Promise<void>>` in `state.ts`) runs each write only after the previous one for that key has settled, failed or not; a failed write's error still reaches its own caller, and a key's entry is removed once its queue drains. Once its turn comes, a write does, in this order: re-read the store, stop with `{ kind: 'unreadable' }` (writing nothing) when the value is unrecognised, apply the mutation, set the counter past `nextId` of the value as read and every id the mutation left, trim, `$.store.set` the `{ v: 1, ... }` value, then `update($, threadsAtom, () => list)`. A failed atom update is logged to debug and the write still answers success: the store holds the change and the next refresh tick puts it in the atom.
- **Refresh:** `$.clock.every(30_000, () => safeRefresh($))` re-reads the store and updates the atom only when the serialized value changed, so writes from other sessions reach the pane within 30 s; every tick also resets the status line, so its ages move on. It runs in the key's write queue, so it never puts back a list it read before one of this session's writes landed. A hot reload drops the timer until `session.start` runs again.
- No module-level mutable state that drawing depends on. State lives in the atoms and the store. The write queue is the one piece of module state: a lock, not drawing state, and a hot reload starting a fresh, empty queue is fine.
- A second atom, `atom({ plugin: 'loose-ends', key: 'toolsReady' }, false)`, declared in `register.tsx`, records whether this load's `session.start` registered the tools. Each module reads or updates only atoms declared in that module: validate lists a module's state from the atoms made there, so an atom imported from elsewhere goes unlisted.
- **Every caught failure is logged.** Each `catch` (tools, commands, the write helper's atom update, refresh, the tools-ready read, the start steps) writes `loose-ends: <op> failed: <message>` to the debug log, then answers as before; the user-facing strings don't change.

**session.start**, in this order (and return `next(e)`); each step is guarded on its own, and every caught error goes to the debug log as `loose-ends: <step> failed: <message>` (`$.ui.log(text, { to: 'debug' })`, itself wrapped in a `try` so a failing log can't break the start or a refresh):
1. register the 3 tools, then set `toolsReady` to true (false when any registration fails; all three are attempted, and the debug line names each one that failed)
2. register the 4 commands
3. run the sweep
4. load the atom from the current project's store value (a failed refresh, here or on a tick, is logged the same way)
5. start the 30 s refresh (`$.clock.every` in its own `try`: a failure is logged as `loose-ends: refresh timer failed: …` and `next(e)` still runs; the pane then catches up on this session's own writes and the next start)
6. open the pane unasked while something is open (see Pane)

`session.start` does **not** fire after `/clear` (that ends the session with `reason: 'clear'`). The atom persists in-process, so the pane keeps showing the list (confirmed live with the earlier band).

**Tools for Claude** (`$.tool.register({ name, description, inputSchema, isDeferred: false })` in `session.start`, so they're always visible without ToolSearch; listed as `mcp__loose-ends__<name>` and answered by a `tool.call` hook matching `{ tool: 'mcp__loose-ends__<name>' }`)
- Arguments arrive **spread on `e`** (`e.items`, `e.id`, `e.note`), next to `e.tool`, `e.tool_use_id` and `e.agentId`. `e` is loosely typed, so validate arguments defensively.
- A hook answers `{ result: string }`. A refusal is `{ deny: string }` with a one-line reason, which the model reads as an error result. Each handler catches its own failure internally and answers `{ deny: 'loose-ends: <tool> failed' }`; the hooks never call `next`. `claude plugin validate` warns three times about a gating hook without `.catch`; that is accepted: the user's typescript-patterns-enforcer rejects `.catch(`, and these hooks are the only server of their tools, so a hook failure becomes a generic tool error, not a fail-open.
- Keep the three descriptions to one or two sentences each (about 300 tokens in all).
- `park({ items: string[] })`
  - denies `parking is main-thread only` when `e.agentId` is present (a subagent or teammate loop)
  - denies when `items` is missing or empty, or any label is blank after trimming
  - dedupes against open threads, case-insensitive on trimmed text (also within the batch), and returns the existing id without creating a thread
  - denies `15 loose ends open — ask the user to /tie or /drop some first` when the new open count would exceed 15, writing nothing (Q2)
  - otherwise creates the threads with origin `claude` and returns their ids, e.g. `Parked: #4, #5`, with `#2 (already open)` for dedupes
- `close({ id: number, note?: string })`
  - an unknown or already-closed id denies `no open thread #N`
  - otherwise sets `closedAt` (and `note` when given). The result names the closed id and up to 5 remaining open threads as `#id label`, oldest first: `Closed #3. Still open: #1 a, #2 b`, or `Closed #3. Nothing else open.`
- `list()` returns the open threads, one `#id label` per line, or `No loose ends.`

**System prompt rule** (a `prompt.compose` hook: `const r = await next(e); return { sections: [...r.sections, rule] }`, with `rule = { id: 'loose-ends:rule', scope: 'session', text: RULE }` last; every `shared` section comes before every `session` one)
- The text is **fixed**, so it stays cached. Never put the list in it, and never interpolate state.
- **Dropped when the tools are not registered.** The hook appends the rule only while `toolsReady` is true, so a failed registration never leaves the model a rule naming tools it cannot call. `toolsReady` starts false: the engine awaits the first `session.start` before the first prompt, so the first compose already sees it set, and a compose before any start sends no rule.
- The exact text:

  > **Loose ends.** This project keeps a list of open discussion threads (tools `park`, `close`, `list`). If your previous reply raised 2+ separate points that needed the user's input (in prose or as questions in a question dialog) and their reply took up only some or none of them, call `park` with the rest, then say "Parked: …" in one line. A label is a short noun phrase of about 50 characters naming the decision, not the question with its options ("repo hosting", "HANDOFF.md: README or docs/"), clear without this conversation, with no prefix shared across labels. When a parked thread is settled, call `close` with a one-line note; if threads remain open, add one line, "Still open: #id label, …". When the user's reply changes what a thread asks, close it with a note saying so and park the new question. Never park implementation steps, todo items or trivia. After `/clear` or at session start, call `list` only when you need to know what's pending.

  Changed after the first live run: labels came back as full questions with a shared `Publish:` prefix, past 80 characters; questions asked in the picker weren't covered; a reworded thread kept its old label.

- The rule can't be kept out of subagent prompts. Main-thread-only parking is enforced in the `park` hook through `e.agentId`, not by the prompt.

**User commands** (`$.command.register({ name, description, argumentHint })` in `session.start`, answered by `command.run` hooks matching `{ command: '<name>' }` and returning `{ text }`, one line unless noted)
- `e.args` is the raw string after the command name (`""` when empty). Ids parse with or without a leading `#` (`/tie 3` and `/tie #3`). A missing or non-numeric id answers a usage line; an unknown id answers a not-found line.
- `/park <text>` adds a thread with origin `user`. Deduped (`Already open as #N.`), not capped (Q3).
- `/threads` opens the pane (asked, with the keyboard) and answers `Opened the loose ends pane.`; where no surface draws it, it lists `— open —` and the open threads as `#3 · 12d · label`, then `— closed —` and the last 5 closed as `#2 · tied 1d · label → note` (no `→ note` without a note). With no threads it answers `No loose ends.` Ages are floor days, `0d` minimum.
- `/tie <id> [note]` closes a thread (ties off the loose end).
- `/drop <id>` removes a thread parked by mistake, entirely. Only the user can drop: there is no tool for it.
- Every mutation goes through the write helper.

**Pane** (`hooks/pane.tsx`; `ui.render` on `{ component: 'Pane', requestId: 'loose-ends' }`). Replaced the one-line band after the first live run: the user found the band too plain.
- Docked (fullscreen terminal from 110 columns; unasked opens from 144): a `LOOSE ENDS · N OPEN · M SETTLED` header with a fresh/aging/stale legend, an OPEN card and a SETTLED card (latest 5, `✓ #id label → note  age`). Inline (elsewhere): the OPEN card's body alone, 3 rows and `+N more · /threads`.
- An open row is a plain `Button` keyed `thread-<id>`: pick mark, `#id`, label padded to the width, an age bar `▮▮▯▯▯` and the age (`today`, `Nd`). The bar fills a cell every 3 days; 1 cell is fresh (`success`), 2–3 aging (`warning`), 4–5 stale (`error`). The OPEN card's border takes the oldest thread's colour.
- Pressing a row picks it (`picked` atom, 0 = the oldest). `tie #id` (hotkey `t`) runs `/tie` on the picked thread and toasts what it answered. Drop takes two presses: the first arms it (`dropArmed` atom, label `drop #id? d again`), the second runs `/drop` and toasts. Picking a row or pressing tie disarms it. Both were confirmed live.
- `close` (hotkey `x`) closes the pane from inside it and counts as the person's close (sets `paneDismissed`). It exists because hosts such as Orca take `ctrl+x` and draw no reachable close mark of the engine's. The unfocused hint reads `click to use` for the same reason.
- Opens unasked at `session.start` and after a park while something is open, unless the person closed it by hand this session (`paneDismissed`, set by a `ui.close` hook on origin `person`, cleared by `/threads`). Untested: the test kit raises no `ui.close`.
- Reads its own redeclaration of the threads atom (same literal ref, shared shape tag). A failed read logs `loose-ends: pane read failed: <message>` and draws an empty list.

**Status line** (`$.ui.status`): `◦ 3 loose ends · oldest 12d` (`◦ 1 loose end · today`), cleared with nothing open. Set after every write and on every refresh tick (ages move on with the clock). A failure logs `loose-ends: status failed: …`.

## Token budget

| Item | Tokens | Notes |
| --- | --- | --- |
| Rule section | ~150 | Fixed, cached |
| Three tool schemas | ~300 | Fixed, cached |
| One park/close call | ~50–100 | Per use |
| Pane and status line | 0 | UI only |

Checked on Claude Code 2.1.321: `command.run` output **does** enter the model's context. `isTextDisplayOnly` is honoured only for plugins bundled with Claude Code ("Any other plugin's text stays in requests"). Keep `/threads` output compact, one line per thread. The pane and the status line cost nothing.

## Verification

1. `claude plugin validate <repo>` lists the hooks (`session.start`, `tool.call` ×3, `command.run` ×4, `prompt.compose`, `ui.render`, `ui.close`) and the register calls; it does not name the tools or commands themselves. No refusals (the "gating hook without .catch" warnings are expected: three for the tool hooks, see Tools for Claude, and one for `ui.close`, whose `noteClose` never throws). The README and LICENSE problems apply only to a directory submission..
2. `npx --yes -p typescript@5 tsc --noEmit -p <repo>` passes (strict, `noUncheckedIndexedAccess`) once the engine has laid `.claude-plugin/types/` beside the mod. If it can't be laid (no interactive session), use a `tsconfig.json` kept outside the repo that points at the skill's `types/claude-code.d.ts`, as that file's header describes.
3. `claude plugin test <repo>` runs tests in AAA style. Tests use a test-owned fake store (`store.get/set/delete/keys` hooks over a `Map`), since `mock.store` has no read-back, and `mock.clock` for time.
   - park then close updates the store, and the pane and status line change
   - `/park`, `/tie` and `/drop` work as described, and `/threads` prints the format above
   - the pane: row layout and colours, docked and inline, `Nothing open.`, tie, two-press drop, unasked opens
   - a value stored under an old `shape` is ignored
   - worktree key: data lands under `repo.root`; with no repo, under `session.root()`
   - `park` dedupes (also within a batch) and returns the existing id
   - `park` from a subagent (`agentId` set) is denied and writes nothing
   - `park` with no items or a blank label is denied
   - the cap at 15
   - text truncated to 60 chars
   - `close` on an unknown or already-closed id is denied; its result lists at most 5 remaining
   - trim to the last 50 closed
   - the 90-day sweep (91d deleted, 89d and open-thread keys kept, empty keys deleted)
   - store refresh: a change made outside the plugin reaches the atom and the pane after a 30 s tick
   - a malformed store value (duplicate ids included) is refused and reported unreadable, and left untouched in the store
   - the rule section comes last, `scope: 'session'`, byte-identical to the text above
4. `git status` shows the changes uncommitted.
5. Manual check with `claude --plugin-dir <repo> --debug`:
   - ask something that makes Claude raise 3 options, pick one, and confirm the other two get parked and appear in the pane
   - settle one and confirm it closes
   - `/clear`, then confirm the pane still shows the open threads
   - close the pane by hand and confirm a park does not reopen it until `/threads`
   - outside fullscreen, confirm the inline pane (3 rows and `+N more`)
   - after `/clear`, confirm in the `--debug` log that the `loose-ends:rule` section is still sent. `toolsReady` lives in `$.state`, and its lifetime across `/clear` is undocumented
   - in another repo, confirm the list there is separate
   - concurrency in one session: ask Claude to call `park` twice in parallel in one message (one call with 'x', one with 'y'), then run `/threads`. Both should be there with distinct ids: this confirms the in-session write queue works live, as the parallel-write tests in `hooks/threads.test.tsx` show it does under the test kit. If one is missing or the ids collide, the live engine runs the two calls in a way the queue does not cover (for example, in separate hooks module instances)

## Risks

- **Claude parks too much.** The narrow rule wording, the visible "Parked:" line, the cap at 15 and `/drop` mitigate it. Expect to tune the rule after real use.
- **Concurrent sessions.** Writes within one session are serialised by the write queue, so overlapping parks, closes and commands in one session all land. Across sessions there is still no guard: `$.store` has no compare-and-swap, so two sessions writing the same project at once can lose a write. This is an accepted risk; the write helper re-reads right before writing to keep the window small.
- **The mod API is early access.** The types file for the running build is the authority, so re-run `validate` after Claude Code updates.
