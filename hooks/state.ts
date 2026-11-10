import { atom, read, update } from 'claude-code'
import type { EngineInterface } from 'claude-code'

import {
  THREADS_ATOM_SHAPE,
  isSweepable,
  nextId,
  parseProject,
  statusText,
  toStored,
  trimClosed,
} from './threads'
import type { Mutation, ParsedProject, Project } from './threads'
import type { Thread } from '../types'

// Helpers handed `$` are function declarations: past an import the engine
// follows `$` only into those.

export const REFRESH_MS = 30_000

// `pane.tsx` declares this atom again with the same literal ref (the engine's
// source scan needs it written in each declaring file) and this shape tag.
export const threadsAtom = atom({ plugin: 'loose-ends', key: 'threads' } as const, [], {
  shape: THREADS_ATOM_SHAPE,
})

/**
 * The store key of this session's project: the main checkout's root, so a
 * worktree shares its list, or the session root outside a repo. Asked fresh
 * on every operation.
 */
export async function projectKey($: EngineInterface): Promise<string> {
  const repo = await $.session.repo()

  return repo?.root ?? (await $.session.root())
}

export async function readProject(
  $: EngineInterface,
  key: string,
): Promise<ParsedProject> {
  return parseProject(await $.store.get(key))
}

/** What a write answers when the stored value is one it cannot read. */
export const UNREADABLE_WRITE =
  'stored loose ends for this project are unreadable — not overwriting'

/** What a read answers when the stored value is one it cannot read. */
export const UNREADABLE_READ = 'stored loose ends for this project are unreadable'

/**
 * What the write path answers: the mutation's `result`, or `unreadable` when
 * the stored value is unrecognised and nothing was written.
 */
export type WriteOutcome<R> = { kind: 'ok'; result: R } | { kind: 'unreadable' }

/**
 * The tail of each store key's write queue: settles when the last write queued
 * for that key has, and never rejects. An entry is removed when its queue
 * drains.
 *
 * Module state is allowed here: the engine asks that state a drawing reads
 * live in `$.state`, because a hot reload drops module variables. This is a
 * write lock, not drawing state, and a reload that starts a fresh, empty queue
 * is fine: at worst a write overlapping the reload goes unordered against one
 * from the new environment, as a cross-session write already can.
 *
 * Keyed per store key, not one chain: the store key is the unit a write
 * re-reads and replaces, so writes to different projects (a session whose
 * root changed) have nothing to order and need not wait on each other.
 */
const writeQueues = new Map<string, Promise<void>>()

/** Waits for `work` to settle, keeping its error for its own caller. */
async function settled(work: Promise<unknown>): Promise<void> {
  try {
    await work
  } catch {
    // The rejection reaches the caller awaiting `work`; the queue goes on.
  }
}

/**
 * Runs `work` once every write queued before it for `key` has settled,
 * succeeded or failed, and answers what `work` answers, or its error.
 */
async function queueWrite<T>(key: string, work: () => Promise<T>): Promise<T> {
  const previous = writeQueues.get(key) ?? Promise.resolve()
  const afterPrevious = async (): Promise<T> => {
    await previous

    return work()
  }
  const result = afterPrevious()
  const tail = settled(result)
  writeQueues.set(key, tail)

  try {
    return await result
  } finally {
    // Nothing queued behind this write: the queue for `key` has drained.
    if (writeQueues.get(key) === tail) {
      writeQueues.delete(key)
    }
  }
}

/**
 * The write path for tools and commands. Writes for one project from this
 * session run one at a time (`queueWrite`), so two that overlap do not both
 * read the same project and lose one. Once its turn comes it re-reads the
 * project, refuses to touch a value it does not recognise, applies `mutate`,
 * and sets the id counter past both `nextId(current)` (the free id before the
 * mutation, so an id the mutation removed is not handed out again) and every
 * id the mutation left; then trims the closed threads, writes the store as v1,
 * then the atom. A failed atom write is logged and still answers `ok`: the
 * store holds the change, and the next refresh tick puts it in the atom.
 */
export async function writeThreads<R>(
  $: EngineInterface,
  mutate: (project: Project, nowIso: string) => Mutation<R>,
): Promise<WriteOutcome<R>> {
  const key = await projectKey($)

  return queueWrite(key, () => writeProject($, key, mutate))
}

/** One write of `writeThreads`, run in its turn in the key's queue. */
async function writeProject<R>(
  $: EngineInterface,
  key: string,
  mutate: (project: Project, nowIso: string) => Mutation<R>,
): Promise<WriteOutcome<R>> {
  const parsed = await readProject($, key)

  if (parsed.kind === 'unrecognised') {
    return { kind: 'unreadable' }
  }

  const current = parsed.project
  const nowIso = new Date(await $.clock.now()).toISOString()
  const { project, result } = mutate(current, nowIso)

  if (project === undefined) {
    return { kind: 'ok', result }
  }

  const trimmed: Project = {
    nextId: Math.max(nextId(current), nextId(project)),
    threads: trimClosed(project.threads),
  }
  await $.store.set(key, toStored(trimmed))

  try {
    await update($, threadsAtom, () => trimmed.threads)
  } catch (error) {
    // The store write landed; the next refresh tick heals the pane.
    logDebug($, `loose-ends: pane update failed: ${describeError(error)}`)
  }
  await showStatus($, trimmed.threads)

  return { kind: 'ok', result }
}

/**
 * Pins the status line for `threads` (`◦ 3 loose ends · oldest 12d`), or
 * clears it with nothing open. Never throws: a failure is logged and the next
 * write or refresh tick sets it again.
 */
export async function showStatus(
  $: EngineInterface,
  threads: readonly Thread[],
): Promise<void> {
  try {
    $.ui.status(statusText(threads, await $.clock.now()))
  } catch (error) {
    logDebug($, `loose-ends: status failed: ${describeError(error)}`)
  }
}

/**
 * Puts the project's stored threads in the atom, unless they already are, and
 * sets the status line every time (an age in it moves on with the clock). An
 * unrecognised value shows as an empty list (the status line clears) and stays
 * in the store untouched. Runs in the key's write queue, so a write that lands
 * while it reads is not overwritten in the atom by the older list it read.
 */
export async function refresh($: EngineInterface): Promise<void> {
  const key = await projectKey($)

  await queueWrite(key, () => refreshProject($, key))
}

/** One refresh, run in its turn in the key's queue. */
async function refreshProject($: EngineInterface, key: string): Promise<void> {
  const parsed = await readProject($, key)
  const threads = parsed.kind === 'ok' ? parsed.project.threads : []
  const shown = await read($, threadsAtom)

  if (JSON.stringify(shown) !== JSON.stringify(threads)) {
    await update($, threadsAtom, () => threads)
  }
  await showStatus($, threads)
}

/**
 * Deletes every project with nothing open and no closure in 90 days. A value
 * it does not recognise (a later version's, or a broken one) is never
 * deleted. Each key is re-read in its write queue just before its delete, so
 * a write from this session that lands after the first read keeps its list.
 */
export async function sweep($: EngineInterface, nowMs: number): Promise<void> {
  const keys = await $.store.keys()
  const parsed = await Promise.all(keys.map(key => readProject($, key)))
  const stale = keys.filter((_, i) => isStale(parsed[i], nowMs))
  await Promise.all(
    stale.map(key => queueWrite(key, () => deleteIfStale($, key, nowMs))),
  )
}

const isStale = (parsed: ParsedProject | undefined, nowMs: number): boolean =>
  parsed?.kind === 'ok' && isSweepable(parsed.project, nowMs)

/** Deletes `key` if it is still stale when its turn in the queue comes. */
async function deleteIfStale(
  $: EngineInterface,
  key: string,
  nowMs: number,
): Promise<void> {
  if (isStale(await readProject($, key), nowMs)) {
    await $.store.delete(key)
  }
}

/** An error's message, for a debug line. */
export const describeError = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)

/**
 * Writes one line to the debug log. Never throws: it is called from catch
 * blocks, and a log that fails has nowhere left to report to.
 */
export function logDebug($: EngineInterface, text: string): void {
  try {
    $.ui.log(text, { to: 'debug' })
  } catch {
    // Dropped: the caller's own failure handling goes on without it.
  }
}

/**
 * Never throws: a failed refresh leaves the atom as it was and says why in the
 * debug log.
 */
export async function safeRefresh($: EngineInterface): Promise<void> {
  try {
    await refresh($)
  } catch (error) {
    // The next tick tries again.
    logDebug($, `loose-ends: refresh failed: ${describeError(error)}`)
  }
}
