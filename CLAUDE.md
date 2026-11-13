# loose-ends

A Claude Code mod: a per-project list of open discussion threads that Claude parks and closes, shown in a side pane and the status line. `README.md` covers behaviour and commands.

## Before touching hooks

Load the `plugin-authoring` skill first. It starts hot reload and lays this build's API types; `types/claude-code.d.ts` from the skill is the source of truth for the mod API (early access, so re-check after Claude Code updates). Read its paths from the skill's text: they change per build.

`.claude-plugin/types/` is laid by the engine when it loads the mod from a watched folder (`claude --plugin-dir .`). Leave it to the engine.

## Checks

- Type-check: `npx --yes -p typescript@5 tsc --noEmit -p .`. There is no `package.json`. Keep `--noEmit`: without the engine-laid types the repo's `tsconfig.json` has no `noEmit`, and `tsc` writes `.js` into `hooks/`.
- `claude plugin validate .` warns five times about gating hooks without `.catch` (three tool hooks, `command.run` for `/loose`, `ui.close`). Expected: handlers catch internally, and the typescript-patterns-enforcer rejects `.catch(`. Use `try`/`catch`.
- `claude plugin test .`: AAA style, a test-owned fake store over a `Map` (`mock.store` has no read-back), `mock.clock` for time.

## Conventions

- Helper modules are imported statically from `hooks/register.tsx`; dynamic `import()` breaks the engine's source scan.
- Each module declares the atoms it reads or updates, with plugin and key as literals in that file (the scan lists a module's state only from atoms made there). Only the shape tag is shared, from `threads.ts`.
- Every store mutation goes through the write helper in `state.ts`: it queues per key, re-reads, refuses unreadable values, trims, writes, then updates the atom.
- Every caught failure logs `loose-ends: <op> failed: <message>` to debug, then answers as before.
- The system-prompt rule in `rule.ts` is fixed text, kept byte-identical to its test. State stays out of the prompt so the prompt cache holds.
- Stored value is `{ v: 2, nextId, threads }`; a thread may carry `context` (v2), and v1 is still read. Any shape change, an added field included, bumps `v` and the atom's shape tag in `threads.ts`. A value this build can't recognise is never overwritten or deleted.
- `$` goes only to named functions at the call site: a lookup table of handlers (`table[kind]($)`) fails the engine's source scan.
- Parking is main-thread only (enforced through `e.agentId`); only the user drops.

## Git

Leave changes uncommitted until the user has reviewed them; commit only when asked.
