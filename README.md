# loose-ends

A Claude Code mod that keeps a running list of open discussion threads, so the points Claude raised that you didn't pick up don't get lost.

In a long conversation Claude often raises several points in one reply. You pick one, go deep on it, and the rest are forgotten. With loose-ends, Claude parks the points you didn't take up ("Parked: X, Y"), closes them with a note once they're settled, and the list stays visible in a side pane and the status line:

```
◦ 3 loose ends · oldest 12d
```

The list is per project, survives `/clear` and restarts, and worktrees of one repository share the main checkout's list.

## Install

In Claude Code (2.1.275 or later):

```
/plugin install loose-ends --marketplace rkosta/loose-ends
```

Pull updates with `claude plugin marketplace update loose-ends`.

To work on the mod, load it from a checkout instead; interactive sessions hot-reload it when its files change:

```sh
claude --plugin-dir ~/Code/personal/loose-ends
```

Disable the installed copy while you do, so the mod isn't loaded twice.

## Using it

**Claude** gets three tools:

- `park` adds threads (main thread only; subagents can't park). Duplicates of an open thread return the existing id, and parking stops at 15 open threads.
- `close` settles a thread with an optional one-line note.
- `list` shows what's open.

**You** get four commands:

| Command | What it does |
| --- | --- |
| `/park <text>` | Add a thread yourself |
| `/threads` | Open the pane, or print the list where no pane can be drawn |
| `/tie <id> [note]` | Close a thread (ties off the loose end) |
| `/drop <id>` | Remove a thread parked by mistake. Only you can drop |

Ids work with or without `#` (`/tie 3` and `/tie #3`).

**The pane** opens on its own at session start and after a park while something is open, unless you've closed it by hand this session (`/threads` brings it back). In a fullscreen terminal it docks beside the chat with OPEN and SETTLED cards; elsewhere it shows three rows inline. Each open row has an age bar that goes from fresh to aging to stale. Pick a row, then press `t` to tie it or `d` twice to drop it; `x` closes the pane.

## Storage

Threads live in Claude Code's plugin store under `~/.claude`, keyed by the repository root (or the session root outside a repo). Each write keeps every open thread plus the last 50 closed. At session start, lists with nothing open and no closure in the last 90 days are deleted. A stored value the mod can't read is never overwritten or deleted.

Writes within one session are serialised. Two sessions writing the same project at the same moment can still lose a write; other sessions' changes reach the pane within 30 seconds.

## Token cost

The system prompt gets one fixed rule (about 150 tokens) and the three tool schemas (about 300), both cached. The open list is never put in the prompt, so parking doesn't invalidate the cache. The pane and status line cost nothing; `/threads` output does enter the context, so it's kept to one line per thread.

## Development

```sh
claude plugin validate .                     # hooks and register calls
npx --yes -p typescript@5 tsc --noEmit -p .  # type-check (needs the engine-laid .claude-plugin/types/)
claude plugin test .                         # tests in hooks/threads.test.tsx
```

See `CLAUDE.md` for the conventions the code follows.
