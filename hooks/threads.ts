import type { Thread } from '../types'

/**
 * What the store keeps per project: the threads, and the next id to hand out
 * so an id stays unused after `/drop` removes the highest one.
 */
export type Project = { nextId: number; threads: Thread[] }

/** A thread that has been closed: `closedAt` is always set. */
export type ClosedThread = Thread & { readonly closedAt: string }

/**
 * What a mutation answers: `project` to write, or none to leave the store as
 * it was, and the caller's `result` either way.
 */
export type Mutation<R> = { project?: Project; result: R }

/**
 * The threads atom's shape tag, shared by its two declarations (`state.ts`
 * and `pane.tsx`; only the declaring module may read or update an atom).
 * Change it when a thread's fields change: it declines what an earlier
 * version stored, which outlives a reload.
 */
export const THREADS_ATOM_SHAPE = 'threads-2'

/**
 * The longest label kept. The rule asks for about 50 characters; this leaves
 * slack, and keeps a pane row on one line at a docked pane's usual width.
 */
export const MAX_LABEL = 60

/**
 * The longest context kept: the rule asks for 1–3 sentences, which this
 * leaves room for, while a pulled draft stays a paragraph, not a page.
 */
export const MAX_CONTEXT = 500
export const KEEP_CLOSED = 50
export const SWEEP_DAYS = 90

const DAY = 86_400_000

export const emptyProject = (): Project => ({ nextId: 1, threads: [] })

/**
 * The version of the stored value this code writes. It reads this one and
 * the earlier ones (`READS_VERSIONS`); a value with no `v` is read as v1
 * (what came before versioning had its shape); any other `v` is a later
 * version's, which this code leaves alone.
 *
 * Any change to the stored shape bumps it, an added field included: an older
 * build reads a newer `v` as unreadable, so it never sweeps or overwrites a
 * value it would otherwise rewrite without the field. v2 added `context`.
 */
export const STORE_VERSION = 2

/** The stored versions this code reads: v1 is v2 with no context anywhere. */
const READS_VERSIONS: readonly unknown[] = [undefined, 1, STORE_VERSION]

/** What the store holds per project: the project, tagged with its version. */
export type StoredProject = Project & { v: typeof STORE_VERSION }

/**
 * A stored value as read: the project (a missing key reads as an empty one),
 * or `unrecognised` for anything this version cannot read whole. An
 * unrecognised value is never deleted or overwritten.
 */
export type ParsedProject =
  | { kind: 'ok'; project: Project }
  | { kind: 'unrecognised' }

const UNRECOGNISED: ParsedProject = { kind: 'unrecognised' }

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const isPositiveInteger = (value: unknown): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value > 0

const isTimestamp = (value: unknown): value is string =>
  typeof value === 'string' && !Number.isNaN(Date.parse(value))

const parseThread = (value: unknown): Thread | null => {
  if (!isRecord(value)) {
    return null
  }

  const { id, text, context, origin, openedAt, closedAt, note } = value
  // Only closing writes a note, so a note on an open thread is broken.
  const isValid =
    isPositiveInteger(id) &&
    typeof text === 'string' &&
    (context === undefined || typeof context === 'string') &&
    (origin === 'claude' || origin === 'user') &&
    isTimestamp(openedAt) &&
    (closedAt === undefined || isTimestamp(closedAt)) &&
    (note === undefined || (typeof note === 'string' && closedAt !== undefined))

  if (!isValid) {
    return null
  }

  return {
    id,
    text,
    ...(typeof context === 'string' ? { context } : {}),
    origin,
    openedAt,
    ...(typeof closedAt === 'string' ? { closedAt } : {}),
    ...(typeof note === 'string' ? { note } : {}),
  }
}

/**
 * Reads a stored value. A missing key is an empty project; a v1 or v2 value
 * (or one with no `v`) whose counter and every thread are valid, with no id used
 * twice, is that project; anything else is unrecognised, whole: no thread is
 * dropped to make it fit.
 */
export const parseProject = (raw: unknown): ParsedProject => {
  if (raw === undefined) {
    return { kind: 'ok', project: emptyProject() }
  }

  if (!isRecord(raw) || !Array.isArray(raw.threads)) {
    return UNRECOGNISED
  }

  const isKnownVersion = READS_VERSIONS.includes(raw.v)

  if (!isKnownVersion || !isPositiveInteger(raw.nextId)) {
    return UNRECOGNISED
  }

  const threads = raw.threads.map(parseThread)
  const valid = threads.filter((one): one is Thread => one !== null)
  const hasUniqueIds = new Set(valid.map(one => one.id)).size === valid.length

  return valid.length === threads.length && hasUniqueIds
    ? { kind: 'ok', project: { nextId: raw.nextId, threads: valid } }
    : UNRECOGNISED
}

/** The project as the store keeps it, tagged with this version. */
export const toStored = (project: Project): StoredProject => ({
  v: STORE_VERSION,
  nextId: project.nextId,
  threads: project.threads,
})

/** The next free id: past the counter and past every id in the list. */
export const nextId = (project: Project): number =>
  project.threads.reduce(
    (next, one) => Math.max(next, one.id + 1),
    Math.max(1, project.nextId),
  )

export const isOpen = (thread: Thread): boolean => thread.closedAt === undefined

export const isClosed = (thread: Thread): thread is ClosedThread =>
  thread.closedAt !== undefined

/** Newest closure first. */
const byClosedDesc = (a: ClosedThread, b: ClosedThread): number =>
  Date.parse(b.closedAt) - Date.parse(a.closedAt)

/** Keeps every open thread and the `keep` most recently closed, in order. */
export const trimClosed = (
  threads: readonly Thread[],
  keep: number = KEEP_CLOSED,
): Thread[] => {
  const kept = new Set<Thread>(
    threads.filter(isClosed).sort(byClosedDesc).slice(0, keep),
  )

  return threads.filter(one => isOpen(one) || kept.has(one))
}

/**
 * A project the start sweep deletes: nothing open, and no closure within
 * `days` (a list with no threads at all goes too).
 */
export const isSweepable = (
  project: Project,
  nowMs: number,
  days: number = SWEEP_DAYS,
): boolean => {
  if (project.threads.some(isOpen)) {
    return false
  }

  const newest = project.threads
    .filter(isClosed)
    .reduce((latest, one) => Math.max(latest, Date.parse(one.closedAt)), 0)

  return nowMs - newest > days * DAY
}

// Any run of whitespace, line breaks and tabs included: matches "a\n\tb" at
// "\n\t"; rejects "ab".
// https://regex101.com/?regex=%5Cs%2B&testString=a%0A%09b
const WHITESPACE_RUN = /\s+/g

/** Text on one trimmed line: every whitespace run is one space. */
export const oneLine = (text: string): string =>
  text.replace(WHITESPACE_RUN, ' ').trim()

/** A label as stored: on one line, at most `MAX_LABEL` chars. */
export const normaliseLabel = (text: string): string =>
  oneLine(text).slice(0, MAX_LABEL)

/** A context as stored: on one line, at most `MAX_CONTEXT` chars. */
export const normaliseContext = (text: string): string =>
  oneLine(text).slice(0, MAX_CONTEXT)

/** What two labels are compared by when deduping. */
export const labelKey = (text: string): string =>
  normaliseLabel(text).toLowerCase()

export const MAX_OPEN = 15
export const CLOSE_SHOWS = 5

/** The open threads, oldest first (by `openedAt`, then id). */
export const openThreads = (threads: readonly Thread[]): Thread[] =>
  threads
    .filter(isOpen)
    .sort(
      (a, b) =>
        Date.parse(a.openedAt) - Date.parse(b.openedAt) || a.id - b.id,
    )

/** One point to park: its label, and where it came from when known. */
export type ParkItem = { readonly label: string; readonly context?: string }

/** One parked label: the id it got, and whether it was open already. */
export type Parked = { id: number; isExisting: boolean }

/** What parking answers: the ids, or that it would pass the open cap. */
export type ParkOutcome =
  | { kind: 'parked'; parked: Parked[] }
  | { kind: 'full' }

/**
 * Parks `items` (labels already validated as non-blank). A label already
 * open (case-insensitive, trimmed, the batch included) answers that thread's
 * id and leaves the thread, context included, as it was. A blank context is
 * left out. With a `cap`, a park that would leave more open than it is
 * refused whole.
 */
export const parkLabels = (
  project: Project,
  items: readonly ParkItem[],
  origin: Thread['origin'],
  nowIso: string,
  cap?: number,
): Mutation<ParkOutcome> => {
  const initial = {
    threads: [...project.threads],
    parked: [] as Parked[],
    next: nextId(project),
  }
  const done = items.reduce((acc, item) => {
    const text = normaliseLabel(item.label)
    const context = normaliseContext(item.context ?? '')
    const found = acc.threads.find(
      one => isOpen(one) && labelKey(one.text) === labelKey(text),
    )

    // A thread already in `parked` (one this batch made, or one open before
    // that an earlier label in the batch matched) is not listed twice; any
    // other was open before the batch and is listed as existing.
    if (found !== undefined) {
      return acc.parked.some(p => p.id === found.id)
        ? acc
        : { ...acc, parked: [...acc.parked, { id: found.id, isExisting: true }] }
    }

    const thread: Thread = {
      id: acc.next,
      text,
      ...(context === '' ? {} : { context }),
      origin,
      openedAt: nowIso,
    }

    return {
      threads: [...acc.threads, thread],
      parked: [...acc.parked, { id: thread.id, isExisting: false }],
      next: acc.next + 1,
    }
  }, initial)

  const created = done.parked.filter(p => !p.isExisting).length

  if (cap !== undefined && created > 0 && openThreads(done.threads).length > cap) {
    return { result: { kind: 'full' } }
  }

  if (created === 0) {
    return { result: { kind: 'parked', parked: done.parked } }
  }

  return {
    project: { nextId: done.next, threads: done.threads },
    result: { kind: 'parked', parked: done.parked },
  }
}

/**
 * Closes open thread `id` with an optional note, or answers no project when
 * no open thread has that id.
 */
export const closeThread = (
  project: Project,
  id: number,
  nowIso: string,
  note?: string,
): Project | undefined => {
  const target = project.threads.find(one => one.id === id && isOpen(one))

  if (target === undefined) {
    return undefined
  }

  const trimmedNote = oneLine(note ?? '')
  const closedOne: Thread = {
    ...target,
    closedAt: nowIso,
    ...(trimmedNote === '' ? {} : { note: trimmedNote }),
  }

  return {
    ...project,
    threads: project.threads.map(one => (one === target ? closedOne : one)),
  }
}

/** `#id label`, as the tools name a thread. */
export const threadRef = (thread: Thread): string => `#${thread.id} ${thread.text}`

export const formatPark = (parked: readonly Parked[]): string =>
  `Parked: ${parked
    .map(p => (p.isExisting ? `#${p.id} (already open)` : `#${p.id}`))
    .join(', ')}`

export const formatClose = (id: number, threads: readonly Thread[]): string => {
  const remaining = openThreads(threads).slice(0, CLOSE_SHOWS)

  return remaining.length === 0
    ? `Closed #${id}. Nothing else open.`
    : `Closed #${id}. Still open: ${remaining.map(threadRef).join(', ')}`
}

export const formatList = (threads: readonly Thread[]): string => {
  const shown = openThreads(threads)

  return shown.length === 0 ? 'No loose ends.' : shown.map(threadRef).join('\n')
}

export const THREADS_SHOWS_CLOSED = 5

/** The day part of a stored timestamp, `2026-11-10` (UTC). */
const day = (at: string): string => at.slice(0, 10)

/**
 * What `/loose pull` puts in the prompt box: the thread as a sentence the
 * model can pick up cold, its context after it, and for a closed thread when
 * it was tied and with what note.
 */
export const formatPull = (thread: Thread): string => {
  const head = `Let's pick up loose end #${thread.id} "${thread.text}" (parked ${day(thread.openedAt)}).`
  const context = thread.context === undefined ? '' : ` Context: ${thread.context}`
  const tied =
    thread.closedAt === undefined
      ? ''
      : ` It was tied ${day(thread.closedAt)}${thread.note === undefined ? '.' : `: ${thread.note}`}`

  return `${head}${context}${tied}`
}

/**
 * A thread id as typed after a command (`3` or `#3`): a positive integer, or
 * undefined for anything else.
 */
export const parseThreadId = (token: string): number | undefined => {
  // Digits with an optional leading `#`: matches "3" and "#3"; rejects "x1",
  // "1.5" and "#".
  // https://regex101.com/?regex=%5E%23%3F(%5Cd%2B)%24&testString=%233
  const match = /^#?(\d+)$/.exec(token)
  const id = match === null ? 0 : Number(match[1])

  return Number.isSafeInteger(id) && id > 0 ? id : undefined
}

/** Removes thread `id`, open or closed, or answers no project when absent. */
export const dropThread = (
  project: Project,
  id: number,
): Project | undefined =>
  project.threads.some(one => one.id === id)
    ? { ...project, threads: project.threads.filter(one => one.id !== id) }
    : undefined

const ELLIPSIS = '…'

/**
 * `text` cut to `columns` cells, ending `…` when cut. Counts each code point
 * as one cell, so a character outside the BMP is one cell, not two. Not
 * handled: wide CJK and emoji (two cells each, counted as one) and combining
 * marks or ZWJ sequences (several code points drawn as one cell, counted as
 * several), so such a line can come out wider or narrower than `columns`.
 */
export const fitColumns = (text: string, columns: number): string => {
  const cells = Array.from(text)

  if (cells.length <= columns) {
    return text
  }

  return columns < 1 ? '' : `${cells.slice(0, columns - 1).join('')}${ELLIPSIS}`
}

/** `text` cut or padded with spaces to exactly `columns` cells (as `fitColumns` counts). */
export const padColumns = (text: string, columns: number): string => {
  const fitted = fitColumns(text, columns)

  return fitted + ' '.repeat(Math.max(0, columns - Array.from(fitted).length))
}

/** `text` padded on the left to `columns` cells; never cut. */
export const padStartColumns = (text: string, columns: number): string =>
  ' '.repeat(Math.max(0, columns - Array.from(text).length)) + text

/** Whole days from `at` to `nowMs`, rounded down, never below 0. */
export const ageDays = (at: string, nowMs: number): number =>
  Math.max(0, Math.floor((nowMs - Date.parse(at)) / DAY))

/** An age as the pane and status line show it: `today`, else `Nd`. */
export const ageText = (days: number): string => (days === 0 ? 'today' : `${days}d`)

/** How long a thread has waited, as the pane colours it. */
export type AgeTone = 'fresh' | 'aging' | 'stale'

/** Cells in an age bar. */
export const AGE_BAR_CELLS = 5

/** Days each filled cell of the age bar stands for. */
const DAYS_PER_CELL = 3

/**
 * Filled cells of the age bar: one at once, one more every three days, all
 * five from 12 days.
 */
export const ageCells = (days: number): number =>
  Math.min(AGE_BAR_CELLS, 1 + Math.floor(days / DAYS_PER_CELL))

/** The most filled cells a thread still reads as aging rather than stale. */
const AGING_CELLS = 3

/** fresh under 3 days, aging under 9, stale from 9: the bar's 1, 2–3 and 4–5 cells. */
export const ageTone = (days: number): AgeTone => {
  const cells = ageCells(days)

  if (cells === 1) {
    return 'fresh'
  }

  return cells <= AGING_CELLS ? 'aging' : 'stale'
}

/** The age bar, `▮▮▯▯▯`. */
export const ageBar = (days: number): string => {
  const filled = ageCells(days)

  return '▮'.repeat(filled) + '▯'.repeat(AGE_BAR_CELLS - filled)
}

/** The closed threads, newest closure first. */
export const recentClosed = (
  threads: readonly Thread[],
  count: number,
): ClosedThread[] => threads.filter(isClosed).sort(byClosedDesc).slice(0, count)

/**
 * The status line, `◦ 3 loose ends · oldest 12d` (`◦ 1 loose end · today`),
 * or undefined with nothing open.
 */
export const statusText = (
  threads: readonly Thread[],
  nowMs: number,
): string | undefined => {
  const shown = openThreads(threads)
  const oldest = shown[0]

  if (oldest === undefined) {
    return undefined
  }

  const noun = shown.length === 1 ? 'loose end' : 'loose ends'
  const age = ageText(ageDays(oldest.openedAt, nowMs))

  return shown.length === 1
    ? `◦ 1 ${noun} · ${age}`
    : `◦ ${shown.length} ${noun} · oldest ${age}`
}

const closedLine = (thread: ClosedThread, nowMs: number): string => {
  const base = `#${thread.id} · tied ${ageDays(thread.closedAt, nowMs)}d · ${thread.text}`

  return thread.note === undefined ? base : `${base} → ${thread.note}`
}

/**
 * What `/threads` prints where the pane is not placed: `— open —` and the
 * open threads oldest first as `#id · Nd · label`, then `— closed —` and the
 * latest closed, newest first, as `#id · tied Nd · label → note`. A section
 * with nothing in it is left out.
 */
export const formatThreads = (
  threads: readonly Thread[],
  nowMs: number,
  closedShown: number = THREADS_SHOWS_CLOSED,
): string => {
  const openLines = openThreads(threads).map(
    one => `#${one.id} · ${ageDays(one.openedAt, nowMs)}d · ${one.text}`,
  )
  const closedLines = recentClosed(threads, closedShown).map(one =>
    closedLine(one, nowMs),
  )

  if (openLines.length === 0 && closedLines.length === 0) {
    return 'No loose ends.'
  }

  return [
    ...(openLines.length === 0 ? [] : ['— open —', ...openLines]),
    ...(closedLines.length === 0 ? [] : ['— closed —', ...closedLines]),
  ].join('\n')
}
