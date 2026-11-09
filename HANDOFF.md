# loose-ends: a Claude Code mod (handoff brief)

Repository: `~/Code/personal/loose-ends`. Mod name `loose-ends`. The band reads `◦ 3 loose ends: …`.

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
- **Scope:** one list per project, kept across sessions.
- **Token budget matters.** The user asked about context pollution. The open list must **not** go into the system prompt, because every change would invalidate the prompt cache for the whole conversation. Details are under Token budget below.
- It's a **mod**: a Claude Code plugin made of function hooks. It lives in its own repository and is shared through a marketplace file.

## How to start

1. Load the `plugin-authoring` skill with the Skill tool **first**. It starts the engine's hot reload and writes this build's API types (`types/claude-code.d.ts`, about 14k lines, the source of truth) plus `examples/` and `reference.md`. Its paths live in a temporary folder for each Claude Code build, so read them from the skill's own text, not from this brief.
2. Read `examples/band.tsx` (band plus atom), `examples/pane.tsx` (commands), `examples/tool-call.ts` (tool hooks and `.catch` guards), `examples/pane.test.tsx` (the test kit) and `reference.md` § "Tools and agent types the model can call" and § "Developing one".
3. Develop it in this repository and run it with `claude --plugin-dir <repo>`, which hot-reloads in interactive sessions. Alternatively, build it in the session's mods folder as the skill describes and copy it here.
4. The user leaves changes uncommitted until they've reviewed them. Don't commit unless they say so.

## Design

**Files**
- `.claude-plugin/plugin.json`: `{ "name": "loose-ends", "version": "0.1.0", "description": "...", "types": "./types/index.d.ts" }`
- `hooks/hooks.json`: `{ "modules": ["./register.tsx"] }`
- `hooks/register.tsx`: exports `register: Register` (imported from `'claude-code'`)
- `types/index.d.ts`: declares `PluginState['loose-ends']` (the `threads` key, `Shaped<Thread[]>`) and exports `Thread`
- `hooks/threads.test.tsx`
- `.claude-plugin/marketplace.json` and a `README.md` with the install line, when the user asks to publish

**Data**
- `Thread = { id: number; text: string; origin: 'claude' | 'user'; openedAt: string; closedAt?: string; note?: string }`
- Persisted in `$.store`, the plugin's JSON store under `~/.claude` that survives sessions. The key is the project root from `await $.session.root()`, giving one list per project. Mind the store's 4 MiB total limit: trim closed threads beyond the last 50 per project.
- Mirrored into `atom({ plugin: 'loose-ends', key: 'threads' }, [], { shape: 'threads-1' })` so the band redraws when the list changes. The atom is loaded from the store in `session.start`.
- Every write goes through one helper that updates both the atom and the store.

**Tools for Claude** (`$.tool.register` with `isDeferred: false`, so they're always visible without ToolSearch; each is answered by a `tool.call` hook matching `{ tool: 'mcp__loose-ends__<name>' }`)
- `park({ items: string[] })` returns the new ids
- `close({ id: number, note?: string })`
- `list()` returns the open threads

**System prompt rule** (a `prompt.compose` hook returns `next(e)`'s sections plus one `{ id: 'loose-ends:rule', scope: 'session', text }` at the end)
- The text is **fixed**, so it stays cached. Never put the list in it.
- Gist of the rule:
  - when your reply raises 2+ separate points that need the user's input and the user picks up only some, call `park` with the rest and say "Parked: …" in one line
  - when a parked thread is settled, call `close` with a one-line note
  - don't park implementation steps (that's the todo list) or anything trivial
  - after `/clear` or at the start of a session, call `list` if you need to know what's pending

**User commands** (`$.command.register` in `session.start`, answered by `command.run` hooks returning `{ text }`)
- `/park <text>` adds a thread
- `/threads` shows the open threads plus the last 5 closed ones with notes
- `/tie <id> [note]` closes a thread (ties off the loose end)
- `/drop <id>` removes a thread parked by mistake

**Band above the prompt** (`ui.render` on `{ component: 'AbovePrompt' }`, modelled on `examples/band.tsx`)
- Shows one dim line: `◦ 3 loose ends: <text> · <text> · …`, truncated to fit.
- Returns `next(e)` when the list is empty or `e.props.hasSurvey` is set.

**Later, not v1:** a side pane (`$.ui.open`, as in `examples/pane.tsx`) with a close button on each row.

## Token budget

| Item | Tokens | Notes |
| --- | --- | --- |
| Rule section | ~120 | Fixed, cached |
| Three tool schemas | ~300 | Fixed, cached |
| One park/close call | ~50–100 | Per use |
| Band | 0 | UI only |

Checked on Claude Code 2.1.321: `command.run` output **does** enter the model's context. `isTextDisplayOnly` is honoured only for plugins bundled with Claude Code ("Any other plugin's text stays in requests"). Keep `/threads` output compact, one line per thread. The band and any future pane cost nothing.

## Verification

1. `claude plugin validate <repo>` lists the hooks, three tools and four commands, with no refusals.
2. `tsc -p <repo>` passes once the engine has laid `.claude-plugin/types/` beside the mod.
3. `claude plugin test <repo>` runs tests in AAA style:
   - park then close updates the store, and the band text changes on `terminal` and `desktop`
   - `/park`, `/tie` and `/drop` work as described
   - an empty list draws no band
   - a value stored under an old `shape` is ignored
4. Manual check with `claude --plugin-dir <repo> --debug`:
   - ask something that makes Claude raise 3 options, pick one, and confirm the other two get parked and appear in the band
   - settle one and confirm it closes
   - `/clear`, then confirm the band still shows the open threads
   - in another repo, confirm the list there is separate

## Risks

- **Claude parks too much.** The narrow rule wording, the visible "Parked:" line and `/drop` mitigate it. Expect to tune the rule after real use.
- **The mod API is early access.** The types file for the running build is the authority, so re-run `validate` after Claude Code updates.
