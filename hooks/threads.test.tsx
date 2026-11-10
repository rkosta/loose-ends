import { expect, mock, test } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'
import type { On } from 'claude-code'

import type { Thread } from '../types'
import { REFRESH_MS } from './state'
import {
  ageBar,
  ageTone,
  fitColumns,
  isSweepable,
  nextId,
  normaliseLabel,
  padColumns,
  padStartColumns,
  parseProject,
  statusText,
  SWEEP_DAYS,
  trimClosed,
} from './threads'

type SetupOptions = {
  // What `$.session.repo()` answers with as `root`; null means "not a repo".
  repoRoot?: string | null
  // What `$.session.root()` answers.
  root?: string
  // What the store holds at the start, by key.
  store?: Readonly<Record<string, unknown>>
  // Where the mocked clock starts, in ms.
  now?: number
  // Makes every `$.store.set` fail, as a store over its 4 MiB would.
  failWrites?: boolean
  // Makes every `$.tool.register` reject, as a refused registration would.
  failToolRegister?: boolean
  // Makes only the registration of the tool with this name reject.
  failToolNamed?: string
  // Makes every `$.command.register` reject.
  failCommandRegister?: boolean
  // Makes every `$.ui.log` reject.
  failLog?: boolean
}

const DAY = 86_400_000
const NOW = Date.parse('2026-11-09T12:00:00.000Z')

/**
 * Stands up the engine beneath the plugin. Every `$` call the plugin makes is
 * answered here. The store is a Map the test owns, so a test can read back
 * and change what the plugin wrote (`mock.store` has no read-back).
 */
const setup = (on: On, options: SetupOptions = {}) => {
  const {
    repoRoot = null,
    root = '/p',
    store = {},
    now = NOW,
    failWrites = false,
    failToolRegister = false,
    failToolNamed,
    failCommandRegister = false,
    failLog = false,
  } = options
  const entries = new Map<string, unknown>(Object.entries(store))

  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.repo', () => ({
    value:
      repoRoot === null
        ? null
        : { root: repoRoot, remote: null, internal: false, name: null },
  }))
  on('session.root', () => ({ value: root }))
  const tools: unknown[] = []
  // Mutable, so a test can let registration succeed after a failed start, or
  // make store reads, threads-atom writes or tools-ready reads fail after a
  // good one.
  const flags = {
    failToolRegister,
    failReads: false,
    failAtomWrites: false,
    failReadyReads: false,
    failThreadReads: false,
    failNextWrite: false,
    holdNextRead: false,
    // Whether `$.ui.open` answers that the pane is drawn.
    isPanePlaced: false,
  }
  on('tool.register', (_, e) => {
    if (flags.failToolRegister || e.name === failToolNamed) {
      throw new Error('registration refused')
    }

    tools.push(e)

    return { value: { tool: `mcp__loose-ends__${e.name}` } }
  })
  const commands: unknown[] = []
  on('command.register', (_, e) => {
    if (failCommandRegister) {
      throw new Error('commands refused')
    }

    commands.push(e)

    return { value: { command: e.name } }
  })

  // With `flags.holdNextRead` the next read takes its value, then waits for
  // `readGate.release()`, so a test can land a write while it is in flight.
  const readGate = gate()
  on('store.get', async (_, e) => {
    // A deny rejects the plugin's call with this reason in its message.
    if (flags.failReads) {
      return { deny: 'store unreadable' }
    }

    const value = entries.get(e.key)

    if (flags.holdNextRead) {
      flags.holdNextRead = false
      readGate.signal()
      await readGate.released
    }

    return { value }
  })
  on('store.set', (_, e) => {
    if (failWrites) {
      return { deny: 'store full' }
    }

    // One refused write, then the store works again.
    if (flags.failNextWrite) {
      flags.failNextWrite = false
      return { deny: 'store full' }
    }

    entries.set(e.key, JSON.parse(JSON.stringify(e.value)))
    return { value: undefined }
  })
  on('store.delete', (_, e) => {
    entries.delete(e.key)
    return { value: undefined }
  })
  on('store.keys', () => ({ value: [...entries.keys()] }))

  // Every write of the threads atom passes through here on its way to the
  // engine, so a test can see what the plugin put in it (tests have no
  // `$.state`). Other atoms (the tools-ready flag) are passed on unrecorded.
  // With `flags.failReadyReads` a read of the tools-ready flag is denied, and
  // with `flags.failThreadReads` a read of the threads atom.
  on('state.get', async (_, e, next) => {
    if (e.key === 'toolsReady' && flags.failReadyReads) {
      return { deny: 'state gone' }
    }

    if (e.key === 'threads' && flags.failThreadReads) {
      return { deny: 'state gone' }
    }

    return next(e)
  })

  // With `flags.failAtomWrites` a threads write is denied and lands nowhere.
  const seen: unknown[] = []
  on('state.set', async (_, e, next) => {
    if (e.key === 'threads' && flags.failAtomWrites) {
      return { deny: 'atom refused' }
    }

    if (e.key === 'threads') {
      seen.push(e.value)
    }

    return next(e)
  })

  // Every `$.ui.log` line, with where it was sent.
  const logs: { text: string; to: string }[] = []
  on('ui.log', (_, e) => {
    if (failLog) {
      throw new Error('log unavailable')
    }

    logs.push({ text: e.text, to: e.to })

    return { value: undefined }
  })

  // Every pane open, status line and toast the plugin asked for.
  const opens: unknown[] = []
  on('ui.open', (_, e) => {
    opens.push(e)

    return {
      value: flags.isPanePlaced
        ? { isPlaced: true }
        : { isPlaced: false, reason: 'below 144 columns' },
    }
  })
  const statuses: (string | undefined)[] = []
  on('ui.status', (_, e) => {
    statuses.push(e.text)

    return { value: undefined }
  })
  const toasts: string[] = []
  on('ui.toast', (_, e) => {
    toasts.push(e.text)

    return { value: undefined }
  })
  // Every pane close the plugin asked for.
  const closes: unknown[] = []
  on('ui.close', (_, e) => {
    closes.push(e)

    return { value: undefined }
  })

  const clock = mock.clock(on, { now })

  return {
    store: entries,
    clock,
    seen,
    tools,
    commands,
    logs,
    flags,
    readGate,
    opens,
    statuses,
    toasts,
    closes,
  }
}

type Gate = {
  readonly reached: Promise<void>
  readonly released: Promise<void>
  readonly signal: () => void
  readonly release: () => void
}

/** Two one-shot signals: `reached` once `signal()` runs, `released` once `release()` does. */
const gate = (): Gate => {
  const reached = deferred()
  const released = deferred()

  return {
    reached: reached.promise,
    released: released.promise,
    signal: reached.resolve,
    release: released.resolve,
  }
}

/** A promise and the function that settles it. */
const deferred = (): { promise: Promise<void>; resolve: () => void } => {
  const holder = { resolve: (): void => undefined }
  const promise = new Promise<void>(resolve => {
    holder.resolve = resolve
  })

  return { promise, resolve: () => holder.resolve() }
}

// The runtime has timers; the plugin's type environment does not list them.
declare function setTimeout(callback: () => void, ms: number): unknown

/** Lets other pending work run for a moment (real time, not the mocked clock). */
const settle = (): Promise<void> =>
  new Promise<void>(resolve => {
    setTimeout(resolve, 20)
  })

type Engine = Parameters<TestBody>[0]

const start = ($: Engine, cwd = '/p') =>
  $.session.start({ cwd, surface: 'terminal', isInteractive: true })

test('session.start resolves with the plugin loaded', async ($, on) => {
  // Arrange
  const { store, clock } = setup(on, { now: NOW - DAY })

  // Act
  const started = await start($)

  // Assert
  expect(started.cwd).toBe('/p')
  expect(clock.now()).toBe(NOW - DAY)
  // Nothing was stored before, so the start loads an empty list and the
  // sweep finds nothing to delete.
  expect(store.size).toBe(0)
})

const iso = (ms: number) => new Date(ms).toISOString()

const open = (id: number, text = `t${id}`, at = NOW - DAY): Thread => ({
  id,
  text,
  origin: 'claude',
  openedAt: iso(at),
})

const closed = (id: number, closedAtMs: number, text = `t${id}`): Thread => ({
  id,
  text,
  origin: 'user',
  openedAt: iso(closedAtMs - DAY),
  closedAt: iso(closedAtMs),
})

// The atom is shaped: a write carries `{ shape, value }`. Answers the value
// of the last write, after checking it went under this version's tag.
const last = (seen: readonly unknown[]): unknown => {
  const written = seen[seen.length - 1]

  if (written === undefined) {
    return undefined
  }

  expect(written).toMatchObject({ shape: 'threads-1' })

  return (written as { value: unknown }).value
}

test('a worktree session loads the main checkout list', async ($, on) => {
  // Arrange
  const main = [open(1, 'from main')]
  const { seen } = setup(on, {
    repoRoot: '/main',
    root: '/main/.wt/x',
    store: {
      '/main': { nextId: 2, threads: main },
      '/main/.wt/x': { nextId: 2, threads: [open(1, 'from worktree')] },
    },
  })

  // Act
  await start($, '/main/.wt/x')

  // Assert
  expect(last(seen)).toEqual(main)
})

test('outside a repo the session root is the key', async ($, on) => {
  // Arrange
  const here = [open(1, 'here')]
  const { seen } = setup(on, {
    repoRoot: null,
    root: '/p',
    store: { '/p': { nextId: 2, threads: here }, '/q': { nextId: 2, threads: [open(1, 'there')] } },
  })

  // Act
  await start($)

  // Assert
  expect(last(seen)).toEqual(here)
})

test('session.start loads the stored threads into the atom', async ($, on) => {
  // Arrange
  const threads = [open(1, 'a'), closed(2, NOW - DAY, 'b'), open(3, 'c')]
  const { seen } = setup(on, { store: { '/p': { nextId: 4, threads } } })

  // Act
  await start($)

  // Assert
  expect(last(seen)).toEqual(threads)
})

test('a store change reaches the atom within one 30 s tick', async ($, on) => {
  // Arrange
  const { store, clock, seen } = setup(on, {
    store: { '/p': { nextId: 2, threads: [open(1, 'a')] } },
  })
  await start($)
  const changed = [open(1, 'a'), open(2, 'b')]
  store.set('/p', { nextId: 3, threads: changed })

  // Act
  await clock.advance(30_000)

  // Assert
  expect(last(seen)).toEqual(changed)
})

test('an unchanged store does not rewrite the atom on a tick', async ($, on) => {
  // Arrange
  const { clock, seen } = setup(on, {
    store: { '/p': { nextId: 2, threads: [open(1, 'a')] } },
  })
  await start($)
  const writes = seen.length

  // Act
  await clock.advance(30_000)

  // Assert
  expect(seen.length).toBe(writes)
})

test('a malformed store value loads as an empty list', async ($, on) => {
  // Arrange
  const { seen } = setup(on, {
    store: { '/p': { threads: [{ id: 'x' }, 42, null], nextId: 'no' } },
  })

  // Act
  await start($)

  // Assert: the atom starts empty, so an empty list needs no write, and
  // nothing broken was put in it.
  expect(seen).toEqual([])
})

test('the start sweep deletes only keys idle for over 90 days', async ($, on) => {
  // Arrange
  const { store } = setup(on, {
    store: {
      '/old': { nextId: 2, threads: [closed(1, NOW - 91 * DAY)] },
      '/recent': { nextId: 2, threads: [closed(1, NOW - 89 * DAY)] },
      '/busy': {
        nextId: 3,
        threads: [closed(1, NOW - 200 * DAY), open(2, 'x', NOW - 200 * DAY)],
      },
      '/empty': { nextId: 5, threads: [] },
    },
  })

  // Act
  await start($)

  // Assert
  expect([...store.keys()].sort()).toEqual(['/busy', '/recent'])
})

test('parseProject reads a missing key as an empty list', async () => {
  // Act
  const parsed = parseProject(undefined)

  // Assert
  expect(parsed).toEqual({ kind: 'ok', project: { nextId: 1, threads: [] } })
})

test('parseProject flags anything of the wrong top-level shape as unrecognised', async () => {
  // Arrange
  const inputs: unknown[] = [null, 7, 'x', { threads: 'no' }, [1, 2], { nextId: 1 }]

  // Act
  const parsed = inputs.map(parseProject)

  // Assert
  expect(parsed).toEqual(inputs.map(() => ({ kind: 'unrecognised' })))
})

test('parseProject reads a v1 value and an unversioned one alike', async () => {
  // Arrange
  const good = open(1, 'a')

  // Act
  const versioned = parseProject({ v: 1, nextId: 9, threads: [good] })
  const unversioned = parseProject({ nextId: 9, threads: [good] })

  // Assert
  expect(versioned).toEqual({ kind: 'ok', project: { nextId: 9, threads: [good] } })
  expect(unversioned).toEqual(versioned)
})

test('parseProject flags any version other than 1 as unrecognised', async () => {
  // Arrange
  const value = { nextId: 2, threads: [open(1, 'a')] }

  // Act / Assert
  expect(parseProject({ ...value, v: 2 })).toEqual({ kind: 'unrecognised' })
  expect(parseProject({ ...value, v: 0 })).toEqual({ kind: 'unrecognised' })
  expect(parseProject({ ...value, v: '1' })).toEqual({ kind: 'unrecognised' })
})

test('parseProject flags a list holding any broken thread as unrecognised', async () => {
  // Arrange
  const good = open(1, 'a')
  const raw = { nextId: 9, threads: [good, { id: 2 }, { ...good, id: 3, origin: 'bot' }] }

  // Act
  const parsed = parseProject(raw)

  // Assert
  expect(parsed).toEqual({ kind: 'unrecognised' })
})

test('parseProject flags an unparseable openedAt or closedAt as unrecognised', async () => {
  // Arrange
  const good = open(1, 'a')

  // Act / Assert
  expect(parseProject({ nextId: 2, threads: [{ ...good, openedAt: 'soon' }] })).toEqual({
    kind: 'unrecognised',
  })
  expect(
    parseProject({ nextId: 2, threads: [{ ...good, closedAt: 'never' }] }),
  ).toEqual({ kind: 'unrecognised' })
})

test('parseProject flags a note on a thread that is not closed as unrecognised', async () => {
  // Arrange: only closing writes a note, so an open thread with one is broken.
  const noted = { ...open(1, 'a'), note: 'n' }

  // Act
  const parsed = parseProject({ nextId: 2, threads: [noted] })

  // Assert
  expect(parsed).toEqual({ kind: 'unrecognised' })
  expect(parseProject({ nextId: 2, threads: [{ ...closed(1, NOW), note: 'n' }] }).kind).toBe(
    'ok',
  )
})

test('nextId is max+1 and never reuses a dropped top id', async () => {
  // Arrange
  const threads = [open(1), open(4)]

  // Act
  const fromIds = nextId({ nextId: 0, threads })
  const afterDrop = nextId({ nextId: 7, threads })
  const first = nextId({ nextId: 0, threads: [] })

  // Assert
  expect(fromIds).toBe(5)
  expect(afterDrop).toBe(7)
  expect(first).toBe(1)
})

test('trimClosed keeps every open thread and the 50 latest closed', async () => {
  // Arrange: #n closed ((n - 1) * 19 mod 52) + 1 days ago. 19 and 52 share no
  // factor, so every closing day from 1 to 52 is used once, out of array
  // order: the two oldest are #42 (52 days) and #31 (51 days), mid-array, so
  // keeping the first or last 50 in the array, or the highest ids, fails.
  const closedOnes = Array.from({ length: 52 }, (_, i) =>
    closed(i + 1, NOW - (((i * 19) % 52) + 1) * DAY),
  )
  const threads = [...closedOnes.slice(0, 26), open(53), ...closedOnes.slice(26)]

  // Act
  const trimmed = trimClosed(threads)

  // Assert
  expect(trimmed.length).toBe(51)
  expect(trimmed.filter(t => t.closedAt === undefined).map(t => t.id)).toEqual([53])
  expect(trimmed.some(t => t.id === 31 || t.id === 42)).toBe(false)
  // Kept in array order.
  expect(trimmed.map(t => t.id)).toEqual(
    threads.filter(t => t.id !== 31 && t.id !== 42).map(t => t.id),
  )
})

test('isSweepable at 91, 89 days, open and empty', async () => {
  // Arrange
  const at = (threads: Thread[]) => isSweepable({ nextId: 1, threads }, NOW)

  // Act / Assert
  expect(at([closed(1, NOW - 91 * DAY)])).toBe(true)
  expect(at([closed(1, NOW - 89 * DAY)])).toBe(false)
  expect(at([closed(1, NOW - 200 * DAY), open(2)])).toBe(false)
  expect(at([])).toBe(true)
})

test('normaliseLabel trims and truncates to 60 chars', async () => {
  // Arrange
  const long = `  ${'x'.repeat(70)}  `

  // Act
  const label = normaliseLabel(long)

  // Assert
  expect(label).toBe('x'.repeat(60))
  expect(normaliseLabel('  hi  ')).toBe('hi')
})

test('normaliseLabel puts a label on one line', async () => {
  // Act
  const label = normaliseLabel(' a\n\tb  \r\nc ')

  // Assert
  expect(label).toBe('a b c')
})

test('isSweepable keeps a project closed exactly 90 days ago', async () => {
  // Arrange
  const at = (ms: number) =>
    isSweepable({ nextId: 2, threads: [closed(1, ms)] }, NOW)

  // Act / Assert: the cut is strictly past 90 days
  expect(at(NOW - 90 * DAY)).toBe(false)
  expect(at(NOW - 90 * DAY - 1)).toBe(true)
})

test('isSweepable goes by the newest closure, not the oldest', async () => {
  // Arrange
  const threads = [closed(1, NOW - 200 * DAY), closed(2, NOW - 10 * DAY)]

  // Act / Assert
  expect(isSweepable({ nextId: 3, threads }, NOW)).toBe(false)
})

test('the start sweep keeps the 90 day boundary and spares open lists elsewhere', async ($, on) => {
  // Arrange
  const { store } = setup(on, {
    store: {
      '/edge': { nextId: 2, threads: [closed(1, NOW - 90 * DAY)] },
      '/over': { nextId: 2, threads: [closed(1, NOW - 90 * DAY - 1)] },
      '/other-open': { nextId: 2, threads: [open(1, 'x', NOW - 400 * DAY)] },
    },
  })

  // Act
  await start($)

  // Assert
  expect([...store.keys()].sort()).toEqual(['/edge', '/other-open'])
})

test('the start sweep leaves the store untouched when nothing is stale', async ($, on) => {
  // Arrange
  const value = { nextId: 2, threads: [open(1, 'a')] }
  const { store } = setup(on, { store: { '/p': value } })

  // Act
  await start($)

  // Assert
  expect(store.get('/p')).toEqual(value)
})

test('a store key deleted externally empties the atom on the next tick', async ($, on) => {
  // Arrange
  const { store, clock, seen } = setup(on, {
    store: { '/p': { nextId: 2, threads: [open(1, 'a')] } },
  })
  await start($)
  expect(last(seen)).toEqual([open(1, 'a')])
  store.delete('/p')

  // Act
  await clock.advance(30_000)

  // Assert
  expect(last(seen)).toEqual([])
})

test('a store value corrupted after start empties the atom on the next tick', async ($, on) => {
  // Arrange
  const { store, clock, seen } = setup(on, {
    store: { '/p': { nextId: 2, threads: [open(1, 'a')] } },
  })
  await start($)
  store.set('/p', 'garbage')

  // Act
  await clock.advance(30_000)

  // Assert
  expect(last(seen)).toEqual([])
})

test('parseProject flags threads of the wrong shape field by field', async () => {
  // Arrange
  const good = open(1, 'ok')
  const bad: unknown[] = [
    { ...good, id: 0 },
    { ...good, id: -3 },
    { ...good, id: 1.5 },
    { ...good, id: '2' },
    { ...good, text: 5 },
    { ...good, openedAt: 5 },
    { ...good, closedAt: 5 },
    { ...good, note: 5 },
    [good],
    'str',
    null,
  ]

  // Act
  const parsed = bad.map(one => parseProject({ nextId: 2, threads: [one, good] }))

  // Assert
  expect(parsed).toEqual(bad.map(() => ({ kind: 'unrecognised' })))
  expect(parseProject({ nextId: 2, threads: [good] }).kind).toBe('ok')
})

test('parseProject flags a bad nextId as unrecognised and strips extra thread fields', async () => {
  // Arrange
  const good = open(1, 'ok')
  const withExtra = { ...closed(2, NOW), junk: true, note: 'n' }
  const badCounters: unknown[] = [-4, 0, 2.5, '3', undefined]

  // Act
  const parsed = parseProject({ nextId: 3, threads: [good, withExtra] })

  // Assert
  expect(parsed).toEqual({
    kind: 'ok',
    project: { nextId: 3, threads: [good, { ...closed(2, NOW), note: 'n' }] },
  })
  expect(
    badCounters.map(counter => parseProject({ nextId: counter, threads: [] })),
  ).toEqual(badCounters.map(() => ({ kind: 'unrecognised' })))
})

// --- Unreadable store values are never deleted or overwritten ---

const UNREADABLE_WRITE =
  'stored loose ends for this project are unreadable — not overwriting'
const UNREADABLE_READ = 'stored loose ends for this project are unreadable'

test('the start sweep spares an unrecognised key and still deletes a stale one', async ($, on) => {
  // Arrange
  const garbage = 'garbage'
  const broken = { nextId: 2, threads: [{ id: 'x' }] }
  const { store } = setup(on, {
    store: {
      '/garbage': garbage,
      '/broken': broken,
      '/old': { v: 1, nextId: 2, threads: [closed(1, NOW - 91 * DAY)] },
    },
  })

  // Act
  await start($)

  // Assert
  expect([...store.keys()].sort()).toEqual(['/broken', '/garbage'])
  expect(store.get('/garbage')).toBe(garbage)
  expect(store.get('/broken')).toBe(broken)
})

test('the start sweep spares a value a later version stored', async ($, on) => {
  // Arrange: empty and long idle, so v1 would sweep it.
  const future = { v: 2, nextId: 1, threads: [], labels: ['kept'] }
  const { store } = setup(on, { store: { '/future': future } })

  // Act
  await start($)

  // Assert
  expect(store.get('/future')).toBe(future)
})

test('an unrecognised value loads as an empty list and the store keeps it', async ($, on) => {
  // Arrange
  const future = { v: 2, nextId: 3, threads: [open(1, 'a'), open(2, 'b')] }
  const { store, seen } = setup(on, { store: { '/p': future } })

  // Act
  await start($)

  // Assert
  expect(seen).toEqual([])
  expect(store.get('/p')).toBe(future)
})

test('a store value turning unrecognised after start empties the atom and stays', async ($, on) => {
  // Arrange
  const { store, clock, seen } = setup(on, {
    store: { '/p': { v: 1, nextId: 2, threads: [open(1, 'a')] } },
  })
  await start($)
  const future = { v: 2, nextId: 2, threads: [open(1, 'a')] }
  store.set('/p', future)

  // Act
  await clock.advance(30_000)

  // Assert
  expect(last(seen)).toEqual([])
  expect(store.get('/p')).toBe(future)
})

test('every write on an unrecognised value is refused and leaves the store byte-identical', async ($, on) => {
  // Arrange
  const future = { v: 2, nextId: 3, threads: [open(1, 'a'), open(2, 'b')] }
  const before = JSON.stringify(future)
  const { store } = setup(on, { store: { '/p': future } })
  await start($)

  // Act
  const answers = [
    await $.tool.call({ tool: PARK, items: ['x'] }),
    await $.tool.call({ tool: CLOSE, id: 1 }),
    await run($, 'park', 'y'),
    await run($, 'tie', '1 done'),
    await run($, 'drop', '2'),
  ]

  // Assert
  expect(answers).toEqual([
    { deny: UNREADABLE_WRITE },
    { deny: UNREADABLE_WRITE },
    expect.objectContaining({ text: UNREADABLE_WRITE }),
    expect.objectContaining({ text: UNREADABLE_WRITE }),
    expect.objectContaining({ text: UNREADABLE_WRITE }),
  ])
  expect(store.get('/p')).toBe(future)
  expect(JSON.stringify(store.get('/p'))).toBe(before)
  expect([...store.keys()]).toEqual(['/p'])
})

test('list and /threads on an unrecognised value say it is unreadable', async ($, on) => {
  // Arrange
  setup(on, { store: { '/p': 'garbage' } })
  await start($)

  // Act
  const listed = await $.tool.call({ tool: LIST })
  const threads = await run($, 'threads')

  // Assert
  expect(listed).toEqual({ deny: UNREADABLE_READ })
  expect(threads).toMatchObject({ text: UNREADABLE_READ })
})

test('a park on a value with an unparseable timestamp is refused', async ($, on) => {
  // Arrange
  const value = { nextId: 2, threads: [{ ...open(1, 'a'), openedAt: 'yesterday' }] }
  const before = JSON.stringify(value)
  const { store } = setup(on, { store: { '/p': value } })
  await start($)

  // Act
  const parked = await $.tool.call({ tool: PARK, items: ['x'] })
  const tied = await run($, 'tie', '1')

  // Assert
  expect(parked).toEqual({ deny: UNREADABLE_WRITE })
  expect(tied).toMatchObject({ text: UNREADABLE_WRITE })
  expect(JSON.stringify(store.get('/p'))).toBe(before)
})

test('an unversioned value is read and rewritten as v1 on the next write', async ($, on) => {
  // Arrange
  const { store, seen } = setup(on, {
    store: { '/p': { nextId: 2, threads: [open(1, 'a')] } },
  })
  await start($)

  // Act
  const answer = await run($, 'park', 'b')

  // Assert
  expect(answer).toMatchObject({ text: 'Parked #2: b' })
  expect(store.get('/p')).toEqual({
    v: 1,
    nextId: 3,
    threads: [open(1, 'a'), { id: 2, text: 'b', origin: 'user', openedAt: iso(NOW) }],
  })
  expect(last(seen)).toEqual([
    open(1, 'a'),
    { id: 2, text: 'b', origin: 'user', openedAt: iso(NOW) },
  ])
})

test('parseProject ignores an unknown top-level field on a v1 value', async () => {
  // Arrange
  const raw = { v: 1, nextId: 2, threads: [open(1)], extra: 'x' }

  // Act / Assert
  expect(parseProject(raw)).toEqual({
    kind: 'ok',
    project: { nextId: 2, threads: [open(1)] },
  })
})

test('parseProject reads a string or non-1 numeric v as unrecognised', async () => {
  // Arrange
  const versions: unknown[] = ['1', 0, 2, null, true]

  // Act
  const parsed = versions.map(v => parseProject({ v, nextId: 1, threads: [] }))

  // Assert
  expect(parsed).toEqual(versions.map(() => ({ kind: 'unrecognised' })))
})

test('parseProject reads duplicate thread ids as unrecognised', async () => {
  // Arrange
  const raw = { nextId: 2, threads: [open(1, 'a'), open(1, 'b')] }

  // Act / Assert
  expect(parseProject(raw)).toEqual({ kind: 'unrecognised' })
})

test('a v1 empty list with no closures is swept, an unrecognised empty-looking one is not', async ($, on) => {
  // Arrange
  const badV = { v: '1', nextId: 1, threads: [] }
  const { store } = setup(on, {
    store: {
      '/empty': { v: 1, nextId: 1, threads: [] },
      '/badv': badV,
      '/badid': { v: 1, nextId: 0, threads: [] },
    },
  })

  // Act
  await start($)

  // Assert
  expect(store.has('/empty')).toBe(false)
  expect(store.get('/badv')).toBe(badV)
  expect(store.has('/badid')).toBe(true)
})

test('a stored value with duplicate ids is unreadable: a park is refused and the store kept', async ($, on) => {
  // Arrange
  const { store } = setup(on, {
    store: { '/p': { v: 1, nextId: 2, threads: [open(1, 'a'), open(1, 'b')] } },
  })
  await start($)
  const before = JSON.stringify(store.get('/p'))

  // Act
  const parked = await $.tool.call({ tool: PARK, items: ['c'] })

  // Assert
  expect(parked).toEqual({ deny: UNREADABLE_WRITE })
  expect(JSON.stringify(store.get('/p'))).toBe(before)
})

test('after the user fixes an unrecognised store the next tick shows the list again', async ($, on) => {
  // Arrange
  const { store, clock, seen } = setup(on, {
    store: { '/p': { v: 2, nextId: 2, threads: [open(1, 'a')] } },
  })
  await start($)
  expect(seen).toEqual([])
  store.set('/p', { v: 1, nextId: 2, threads: [open(1, 'a')] })

  // Act
  await clock.advance(30_000)

  // Assert
  expect(last(seen)).toEqual([open(1, 'a')])
  expect(await run($, 'park', 'b')).toMatchObject({ text: 'Parked #2: b' })
})

test('a park on an unversioned value with a stale counter writes v1 and keeps the counter monotonic', async ($, on) => {
  // Arrange
  const { store } = setup(on, {
    store: { '/p': { nextId: 1, threads: [open(4, 'a')] } },
  })
  await start($)

  // Act
  await run($, 'park', 'b')
  await run($, 'drop', '5')
  await run($, 'park', 'c')

  // Assert
  expect(stored(store)).toMatchObject({ v: 1, nextId: 7 })
  expect(stored(store).threads.map(t => t.id)).toEqual([4, 6])
})

test('a later successful session.start sets the rule back after a failed registration', async ($, on) => {
  // Arrange
  const { flags } = setup(on, { failToolRegister: true })
  on('prompt.compose', () => ({ sections: [] }))
  await start($)
  const before = await $.prompt.compose(COMPOSE)
  flags.failToolRegister = false

  // Act
  await start($)
  const after = await $.prompt.compose(COMPOSE)

  // Assert
  expect(before.sections).toEqual([])
  expect(after.sections.map(s => s.id)).toEqual(['loose-ends:rule'])
})

test('a registration that fails on a later start takes the rule out again', async ($, on) => {
  // Arrange
  const { flags } = setup(on)
  on('prompt.compose', () => ({ sections: [] }))
  await start($)
  flags.failToolRegister = true

  // Act
  await start($)
  const { sections } = await $.prompt.compose(COMPOSE)

  // Assert
  expect(sections).toEqual([])
})

test('in a worktree every write lands under the main checkout key', async ($, on) => {
  // Arrange
  const { store } = setup(on, { repoRoot: '/main', root: '/main/.wt/x' })
  await start($, '/main/.wt/x')

  // Act
  await $.tool.call({ tool: PARK, items: ['from tool'] })
  await run($, 'park', 'from command')
  await run($, 'tie', '1 done')
  await run($, 'drop', '2')

  // Assert
  expect([...store.keys()]).toEqual(['/main'])
  expect(store.has('/main/.wt/x')).toBe(false)
  expect(store.get('/main')).toEqual({
    v: 1,
    nextId: 3,
    threads: [
      {
        id: 1,
        text: 'from tool',
        origin: 'claude',
        openedAt: iso(NOW),
        closedAt: iso(NOW),
        note: 'done',
      },
    ],
  })
})

test('nextId stays past the ids after the top one is removed and counter is stale', async () => {
  // Arrange
  const stale = { nextId: 2, threads: [open(1), open(5)] }

  // Act / Assert
  expect(nextId(stale)).toBe(6)
  expect(nextId({ nextId: 6, threads: [open(1)] })).toBe(6)
  expect(nextId({ nextId: -1, threads: [] })).toBe(1)
})

test('trimClosed keeps everything when closed threads are within the limit', async () => {
  // Arrange
  const threads = [closed(1, NOW - 3 * DAY), open(2), closed(3, NOW - DAY)]

  // Act / Assert
  expect(trimClosed(threads)).toEqual(threads)
  expect(trimClosed(threads, 1).map(t => t.id)).toEqual([2, 3])
  expect(trimClosed(threads, 0).map(t => t.id)).toEqual([2])
})

// --- T4: tools park / close / list ---

const PARK = 'mcp__loose-ends__park'
const CLOSE = 'mcp__loose-ends__close'
const LIST = 'mcp__loose-ends__list'

type Stored = { nextId: number; threads: Thread[] }

const stored = (store: ReadonlyMap<string, unknown>, key = '/p'): Stored =>
  store.get(key) as Stored

test('session.start registers park, close and list, none deferred', async ($, on) => {
  // Arrange
  const { tools } = setup(on)

  // Act
  await start($)

  // Assert
  expect(tools).toHaveLength(3)
  expect(tools).toEqual([
    expect.objectContaining({ name: 'park', isDeferred: false }),
    expect.objectContaining({ name: 'close', isDeferred: false }),
    expect.objectContaining({ name: 'list', isDeferred: false }),
  ])
  expect(tools[0]).toMatchObject({
    inputSchema: {
      type: 'object',
      properties: { items: { type: 'array', items: { type: 'string' }, minItems: 1 } },
      required: ['items'],
    },
  })
  expect(tools[1]).toMatchObject({
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'integer' }, note: { type: 'string' } },
      required: ['id'],
    },
  })
  expect(tools[2]).toMatchObject({ inputSchema: { type: 'object' } })
})

test('park creates claude threads with sequential ids and returns them', async ($, on) => {
  // Arrange
  const { store, seen } = setup(on, {
    store: { '/p': { nextId: 3, threads: [open(1, 'a'), closed(2, NOW - DAY, 'b')] } },
  })
  await start($)

  // Act
  const answer = await $.tool.call({ tool: PARK, items: ['  naming  ', 'caching'] })

  // Assert
  expect(answer).toEqual({ result: 'Parked: #3, #4' })
  const { threads, nextId: counter } = stored(store)
  expect(threads.slice(2)).toEqual([
    { id: 3, text: 'naming', origin: 'claude', openedAt: iso(NOW) },
    { id: 4, text: 'caching', origin: 'claude', openedAt: iso(NOW) },
  ])
  expect(counter).toBe(5)
  // AC4: the atom holds what the store holds.
  expect(last(seen)).toEqual(threads)
})

test('park truncates a label to 60 chars', async ($, on) => {
  // Arrange
  const { store } = setup(on)
  await start($)

  // Act
  await $.tool.call({ tool: PARK, items: [`  ${'y'.repeat(150)}`] })

  // Assert
  expect(stored(store).threads[0]?.text).toBe('y'.repeat(60))
})

test('park dedupes case-insensitively against open threads and within the batch', async ($, on) => {
  // Arrange
  const { store } = setup(on, {
    store: {
      '/p': { nextId: 3, threads: [open(1, 'Alpha'), closed(2, NOW - DAY, 'beta')] },
    },
  })
  await start($)

  // Act
  const answer = await $.tool.call({
    tool: PARK,
    items: [' alpha ', 'Beta', 'BETA', 'gamma'],
  })

  // Assert: a closed thread does not count, so beta opens anew, once.
  expect(answer).toEqual({ result: 'Parked: #1 (already open), #3, #4' })
  expect(stored(store).threads.map(t => [t.id, t.text])).toEqual([
    [1, 'Alpha'],
    [2, 'beta'],
    [3, 'Beta'],
    [4, 'gamma'],
  ])
})

test('park of only open labels writes nothing new', async ($, on) => {
  // Arrange
  const value = { nextId: 2, threads: [open(1, 'a')] }
  const { store } = setup(on, { store: { '/p': value } })
  await start($)

  // Act
  const answer = await $.tool.call({ tool: PARK, items: ['A'] })

  // Assert
  expect(answer).toEqual({ result: 'Parked: #1 (already open)' })
  expect(stored(store).threads).toEqual(value.threads)
})

test('park from a subagent is denied and writes nothing', async ($, on) => {
  // Arrange
  const { store, seen } = setup(on)
  await start($)
  const writes = seen.length

  // Act
  const answer = await $.tool.call({ tool: PARK, items: ['x'], agentId: 'a1' })

  // Assert
  expect(answer).toEqual({ deny: 'parking is main-thread only' })
  expect(store.size).toBe(0)
  expect(seen.length).toBe(writes)
})

test('park with no items or a blank label is denied and writes nothing', async ($, on) => {
  // Arrange
  const { store } = setup(on)
  await start($)

  // Act
  const answers = await Promise.all([
    $.tool.call({ tool: PARK }),
    $.tool.call({ tool: PARK, items: [] }),
    $.tool.call({ tool: PARK, items: ['ok', '   '] }),
    $.tool.call({ tool: PARK, items: ['ok', 7] }),
    $.tool.call({ tool: PARK, items: 'ok' }),
  ])

  // Assert
  expect(answers).toEqual([
    { deny: 'park needs at least one item' },
    { deny: 'park needs at least one item' },
    { deny: 'park items must be non-blank strings' },
    { deny: 'park items must be non-blank strings' },
    { deny: 'park needs at least one item' },
  ])
  expect(store.size).toBe(0)
})

test('park past 15 open threads is denied and writes nothing', async ($, on) => {
  // Arrange
  const threads = Array.from({ length: 14 }, (_, i) => open(i + 1))
  const value = { nextId: 15, threads }
  const { store } = setup(on, { store: { '/p': value } })
  await start($)

  // Act
  const over = await $.tool.call({ tool: PARK, items: ['n1', 'n2'] })
  const before = stored(store)
  const upTo = await $.tool.call({ tool: PARK, items: ['n1'] })
  const dupeAtCap = await $.tool.call({ tool: PARK, items: ['t3'] })

  // Assert
  expect(over).toEqual({
    deny: '15 loose ends open — ask the user to /tie or /drop some first',
  })
  expect(before).toEqual(value)
  expect(upTo).toEqual({ result: 'Parked: #15' })
  expect(dupeAtCap).toEqual({ result: 'Parked: #3 (already open)' })
})

test('close sets closedAt and note and names what is still open', async ($, on) => {
  // Arrange
  const { store, seen, clock } = setup(on, {
    store: { '/p': { nextId: 3, threads: [open(1, 'a'), open(2, 'b')] } },
  })
  await start($)
  await clock.advance(DAY)

  // Act
  const answer = await $.tool.call({ tool: CLOSE, id: 1, note: 'went with a' })

  // Assert
  expect(answer).toEqual({ result: 'Closed #1. Still open: #2 b' })
  const { threads } = stored(store)
  expect(threads[0]).toEqual({ ...open(1, 'a'), closedAt: iso(NOW + DAY), note: 'went with a' })
  expect(last(seen)).toEqual(threads)
})

test('close of the last open thread says nothing else is open', async ($, on) => {
  // Arrange
  const { store } = setup(on, { store: { '/p': { nextId: 2, threads: [open(1, 'a')] } } })
  await start($)

  // Act
  const answer = await $.tool.call({ tool: CLOSE, id: 1 })

  // Assert
  expect(answer).toEqual({ result: 'Closed #1. Nothing else open.' })
  expect(stored(store).threads[0]).toEqual({ ...open(1, 'a'), closedAt: iso(NOW) })
})

test('close of an unknown or already-closed id is denied', async ($, on) => {
  // Arrange
  const value = { nextId: 3, threads: [open(1, 'a'), closed(2, NOW - DAY, 'b')] }
  const { store } = setup(on, { store: { '/p': value } })
  await start($)

  // Act
  const unknown = await $.tool.call({ tool: CLOSE, id: 9 })
  const done = await $.tool.call({ tool: CLOSE, id: 2 })
  const bad = await $.tool.call({ tool: CLOSE, id: 'x' })

  // Assert
  expect(unknown).toEqual({ deny: 'no open thread #9' })
  expect(done).toEqual({ deny: 'no open thread #2' })
  expect(bad).toEqual({ deny: 'close needs an integer id' })
  expect(stored(store)).toEqual(value)
})

test('close lists at most 5 remaining open threads, oldest first', async ($, on) => {
  // Arrange
  const threads = [
    open(1, 'one', NOW - 9 * DAY),
    open(7, 'seven', NOW - 8 * DAY),
    open(2, 'two', NOW - 7 * DAY),
    open(3, 'three', NOW - 6 * DAY),
    open(4, 'four', NOW - 5 * DAY),
    open(5, 'five', NOW - 4 * DAY),
    open(6, 'six', NOW - 3 * DAY),
  ]
  setup(on, { store: { '/p': { nextId: 8, threads } } })
  await start($)

  // Act
  const answer = await $.tool.call({ tool: CLOSE, id: 1 })

  // Assert
  expect(answer).toEqual({
    result: 'Closed #1. Still open: #7 seven, #2 two, #3 three, #4 four, #5 five',
  })
})

test('list returns the open threads, one per line, oldest first', async ($, on) => {
  // Arrange
  const threads = [
    open(2, 'later', NOW - DAY),
    closed(3, NOW - DAY, 'gone'),
    open(1, 'earlier', NOW - 2 * DAY),
  ]
  setup(on, { store: { '/p': { nextId: 4, threads } } })
  await start($)

  // Act
  const answer = await $.tool.call({ tool: LIST })

  // Assert
  expect(answer).toEqual({ result: '#1 earlier\n#2 later' })
})

test('list with nothing open says so', async ($, on) => {
  // Arrange
  setup(on, { store: { '/p': { nextId: 2, threads: [closed(1, NOW - DAY)] } } })
  await start($)

  // Act
  const answer = await $.tool.call({ tool: LIST })

  // Assert
  expect(answer).toEqual({ result: 'No loose ends.' })
})

test('an id removed from the top of the list is not handed out again', async ($, on) => {
  // Arrange
  const { store } = setup(on)
  await start($)
  await $.tool.call({ tool: PARK, items: ['a', 'b'] })
  const after = stored(store)
  store.set('/p', { ...after, threads: after.threads.filter(t => t.id !== 2) })

  // Act
  const answer = await $.tool.call({ tool: PARK, items: ['c'] })

  // Assert
  expect(answer).toEqual({ result: 'Parked: #3' })
})

test('a park trims to the 50 latest closed in both store and atom', async ($, on) => {
  // Arrange
  const closedOnes = Array.from({ length: 52 }, (_, i) =>
    closed(i + 1, NOW - (52 - i) * DAY),
  )
  const { store, seen } = setup(on, {
    store: { '/p': { nextId: 54, threads: [...closedOnes, open(53, 'kept')] } },
  })
  await start($)

  // Act
  await $.tool.call({ tool: PARK, items: ['new'] })

  // Assert
  const { threads } = stored(store)
  expect(threads.filter(t => t.closedAt !== undefined)).toHaveLength(50)
  expect(threads.filter(t => t.closedAt === undefined).map(t => t.id)).toEqual([53, 54])
  expect(threads.some(t => t.id === 1 || t.id === 2)).toBe(false)
  expect(last(seen)).toEqual(threads)
})

test('a park the store refuses is denied with a one-line reason', async ($, on) => {
  // Arrange
  setup(on, { failWrites: true })
  await start($)

  // Act
  const answer = await $.tool.call({ tool: PARK, items: ['x'] })

  // Assert
  expect(answer).toEqual({ deny: 'loose-ends: park failed' })
})

test('park keeps a 60 char label whole and cuts a 61 char one', async ($, on) => {
  // Arrange
  const { store } = setup(on)
  await start($)

  // Act
  await $.tool.call({ tool: PARK, items: ['a'.repeat(60), 'b'.repeat(61)] })

  // Assert
  expect(stored(store).threads.map(t => t.text)).toEqual(['a'.repeat(60), 'b'.repeat(60)])
})

test('park of a label past 60 chars dedupes against its stored truncation', async ($, on) => {
  // Arrange
  setup(on, { store: { '/p': { nextId: 2, threads: [open(1, 'c'.repeat(60))] } } })
  await start($)

  // Act
  const answer = await $.tool.call({ tool: PARK, items: [` ${'C'.repeat(70)} `] })

  // Assert
  expect(answer).toEqual({ result: 'Parked: #1 (already open)' })
})

test('parking a label after closing it creates a new thread with a new id', async ($, on) => {
  // Arrange
  const { store } = setup(on)
  await start($)
  await $.tool.call({ tool: PARK, items: ['topic'] })
  await $.tool.call({ tool: CLOSE, id: 1 })

  // Act
  const answer = await $.tool.call({ tool: PARK, items: ['Topic'] })

  // Assert
  expect(answer).toEqual({ result: 'Parked: #2' })
  expect(stored(store).threads.map(t => [t.id, t.closedAt === undefined])).toEqual([
    [1, false],
    [2, true],
  ])
})

test('close with a blank note omits the note and trims a real one', async ($, on) => {
  // Arrange
  const { store } = setup(on, {
    store: { '/p': { nextId: 3, threads: [open(1, 'a'), open(2, 'b')] } },
  })
  await start($)

  // Act
  await $.tool.call({ tool: CLOSE, id: 1, note: '   ' })
  await $.tool.call({ tool: CLOSE, id: 2, note: '  done  ' })

  // Assert
  const [one, two] = stored(store).threads
  expect(one).not.toHaveProperty('note')
  expect(two?.note).toBe('done')
})

test('close from a subagent is allowed', async ($, on) => {
  // Arrange
  const { store } = setup(on, { store: { '/p': { nextId: 2, threads: [open(1, 'a')] } } })
  await start($)

  // Act
  const answer = await $.tool.call({ tool: CLOSE, id: 1, agentId: 'a1' })

  // Assert
  expect(answer).toEqual({ result: 'Closed #1. Nothing else open.' })
  expect(stored(store).threads[0]?.closedAt).toBe(iso(NOW))
})

test('list orders by openedAt and breaks ties by id', async ($, on) => {
  // Arrange
  const threads = [
    open(5, 'e', NOW - DAY),
    open(3, 'c', NOW - DAY),
    open(9, 'old', NOW - 5 * DAY),
    open(4, 'd', NOW - DAY),
  ]
  setup(on, { store: { '/p': { nextId: 10, threads } } })
  await start($)

  // Act
  const answer = await $.tool.call({ tool: LIST })

  // Assert
  expect(answer).toEqual({ result: '#9 old\n#3 c\n#4 d\n#5 e' })
})

test('park of a new label plus a dupe at 14 open is denied, dupe alone is not', async ($, on) => {
  // Arrange
  const threads = Array.from({ length: 14 }, (_, i) => open(i + 1))
  const value = { nextId: 15, threads }
  const { store } = setup(on, { store: { '/p': value } })
  await start($)

  // Act
  const mixed = await $.tool.call({ tool: PARK, items: ['t1', 'fresh', 'fresher'] })
  const unchanged = stored(store)
  const mixedFits = await $.tool.call({ tool: PARK, items: ['T1', 'fresh'] })

  // Assert
  expect(mixed).toEqual({
    deny: '15 loose ends open — ask the user to /tie or /drop some first',
  })
  expect(unchanged).toEqual(value)
  expect(mixedFits).toEqual({ result: 'Parked: #1 (already open), #15' })
})

// --- T5: slash commands /park /threads /tie /drop ---

// Runs `/command args` as the person typing it in the terminal would.
const run = ($: Engine, command: string, args = '') =>
  $.command.run({
    command,
    args,
    origin: { kind: 'composer' },
    presentation: { isFullscreen: false, columns: 80 },
  })

test('session.start registers /park /threads /tie /drop with hints', async ($, on) => {
  // Arrange
  const { commands } = setup(on)

  // Act
  await start($)

  // Assert
  expect(commands).toEqual([
    expect.objectContaining({ name: 'park', argumentHint: '<text>' }),
    expect.objectContaining({ name: 'threads' }),
    expect.objectContaining({ name: 'tie', argumentHint: '<id> [note]' }),
    expect.objectContaining({ name: 'drop', argumentHint: '<id>' }),
  ])
})

test('/park adds a user thread and dedupes against open ones', async ($, on) => {
  // Arrange
  const { store, seen } = setup(on, {
    store: { '/p': { nextId: 2, threads: [open(1, 'naming')] } },
  })
  await start($)

  // Act
  const added = await run($, 'park', '  caching layer  ')
  const dupe = await run($, 'park', 'NAMING')

  // Assert
  expect(added).toMatchObject({ text: 'Parked #2: caching layer' })
  expect(dupe).toMatchObject({ text: 'Already open as #1.' })
  expect(stored(store).threads).toEqual([
    open(1, 'naming'),
    { id: 2, text: 'caching layer', origin: 'user', openedAt: iso(NOW) },
  ])
  expect(last(seen)).toEqual(stored(store).threads)
})

test('/park is not capped at 15 open threads', async ($, on) => {
  // Arrange
  const threads = Array.from({ length: 15 }, (_, i) => open(i + 1))
  const { store } = setup(on, { store: { '/p': { nextId: 16, threads } } })
  await start($)

  // Act
  const answer = await run($, 'park', 'one more')

  // Assert
  expect(answer).toMatchObject({ text: 'Parked #16: one more' })
  expect(stored(store).threads).toHaveLength(16)
})

test('/park with no text answers usage and writes nothing', async ($, on) => {
  // Arrange
  const { store } = setup(on)
  await start($)

  // Act
  const empty = await run($, 'park')
  const blank = await run($, 'park', '   ')

  // Assert
  expect(empty).toMatchObject({ text: 'Usage: /park <text>' })
  expect(blank).toMatchObject({ text: 'Usage: /park <text>' })
  expect(store.size).toBe(0)
})

test('/tie closes a thread with a note, by 3 or #3', async ($, on) => {
  // Arrange
  const { store, seen } = setup(on, {
    store: { '/p': { nextId: 4, threads: [open(1, 'a'), open(2, 'b'), open(3, 'c')] } },
  })
  await start($)

  // Act
  const withNote = await run($, 'tie', '3   went with  plan b ')
  const hashed = await run($, 'tie', '#1')

  // Assert
  expect(withNote).toMatchObject({ text: 'Tied #3 c → went with plan b' })
  expect(hashed).toMatchObject({ text: 'Tied #1 a' })
  const after = stored(store).threads
  expect(after[2]).toEqual({ ...open(3, 'c'), closedAt: iso(NOW), note: 'went with plan b' })
  expect(after[0]).toEqual({ ...open(1, 'a'), closedAt: iso(NOW) })
  expect(after[1]).toEqual(open(2, 'b'))
  expect(last(seen)).toEqual(after)
})

test('/tie of an unknown or closed id answers not found and writes nothing', async ($, on) => {
  // Arrange
  const value = { nextId: 3, threads: [open(1, 'a'), closed(2, NOW - DAY, 'b')] }
  const { store } = setup(on, { store: { '/p': value } })
  await start($)

  // Act
  const unknown = await run($, 'tie', '9 note')
  const done = await run($, 'tie', '#2')

  // Assert
  expect(unknown).toMatchObject({ text: 'No open thread #9.' })
  expect(done).toMatchObject({ text: 'No open thread #2.' })
  expect(stored(store)).toEqual(value)
})

test('/tie and /drop with a missing or non-numeric id answer usage', async ($, on) => {
  // Arrange
  const value = { nextId: 2, threads: [open(1, 'a')] }
  const { store } = setup(on, { store: { '/p': value } })
  await start($)

  // Act
  const answers = await Promise.all([
    run($, 'tie'),
    run($, 'tie', 'abc'),
    run($, 'tie', '#'),
    run($, 'tie', '0'),
    run($, 'tie', '1.5'),
    run($, 'drop'),
    run($, 'drop', 'x1'),
    run($, 'drop', '-1'),
  ])

  // Assert
  expect(answers.map(a => a.text)).toEqual([
    'Usage: /tie <id> [note]',
    'Usage: /tie <id> [note]',
    'Usage: /tie <id> [note]',
    'Usage: /tie <id> [note]',
    'Usage: /tie <id> [note]',
    'Usage: /drop <id>',
    'Usage: /drop <id>',
    'Usage: /drop <id>',
  ])
  expect(stored(store)).toEqual(value)
})

test('/drop removes a thread entirely, open or closed', async ($, on) => {
  // Arrange
  const { store, seen } = setup(on, {
    store: { '/p': { nextId: 4, threads: [open(1, 'a'), closed(2, NOW - DAY, 'b'), open(3, 'c')] } },
  })
  await start($)

  // Act
  const first = await run($, 'drop', '1')
  const second = await run($, 'drop', '#2')

  // Assert
  expect(first).toMatchObject({ text: 'Dropped #1 a' })
  expect(second).toMatchObject({ text: 'Dropped #2 b' })
  expect(stored(store).threads).toEqual([open(3, 'c')])
  expect(last(seen)).toEqual([open(3, 'c')])
})

test('/drop of an unknown id answers not found and writes nothing', async ($, on) => {
  // Arrange
  const value = { nextId: 2, threads: [open(1, 'a')] }
  const { store } = setup(on, { store: { '/p': value } })
  await start($)

  // Act
  const answer = await run($, 'drop', '7')

  // Assert
  expect(answer).toMatchObject({ text: 'No thread #7.' })
  expect(stored(store)).toEqual(value)
})

test('/drop of the top id then /park does not reuse it', async ($, on) => {
  // Arrange
  const { store } = setup(on, {
    store: { '/p': { nextId: 3, threads: [open(1, 'a'), open(2, 'b')] } },
  })
  await start($)

  // Act
  await run($, 'drop', '2')
  const answer = await run($, 'park', 'c')

  // Assert
  expect(answer).toMatchObject({ text: 'Parked #3: c' })
  expect(stored(store).nextId).toBe(4)
  expect(stored(store).threads.map(t => t.id)).toEqual([1, 3])
})

test('/threads lists open then the last 5 closed, with floor-day ages', async ($, on) => {
  // Arrange
  const HOUR = 3_600_000
  const threads: Thread[] = [
    open(1, 'oldest', NOW - 12 * DAY - HOUR),
    open(4, 'fresh', NOW - HOUR),
    { ...closed(2, NOW - DAY - HOUR, 'settled'), note: 'went with a' },
    closed(3, NOW - 2 * DAY, 'no note'),
    closed(5, NOW - 3 * DAY, 'c5'),
    closed(6, NOW - 4 * DAY, 'c6'),
    closed(7, NOW - 5 * DAY, 'c7'),
    closed(8, NOW - 6 * DAY, 'c8'),
  ]
  setup(on, { store: { '/p': { nextId: 9, threads } } })
  await start($)

  // Act
  const answer = await run($, 'threads')

  // Assert
  expect(answer).toMatchObject({
    text: [
      '— open —',
      '#1 · 12d · oldest',
      '#4 · 0d · fresh',
      '— closed —',
      '#2 · tied 1d · settled → went with a',
      '#3 · tied 2d · no note',
      '#5 · tied 3d · c5',
      '#6 · tied 4d · c6',
      '#7 · tied 5d · c7',
    ].join('\n'),
  })
})

test('/threads ages follow the mocked clock', async ($, on) => {
  // Arrange
  const { clock } = setup(on, {
    store: { '/p': { nextId: 2, threads: [open(1, 'a', NOW)] } },
  })
  await start($)
  const before = await run($, 'threads')

  // Act
  await clock.advance(3 * DAY)
  const after = await run($, 'threads')

  // Assert
  expect(before).toMatchObject({ text: '— open —\n#1 · 0d · a' })
  expect(after).toMatchObject({ text: '— open —\n#1 · 3d · a' })
})

test('/threads with only closed threads shows the closed section', async ($, on) => {
  // Arrange
  setup(on, { store: { '/p': { nextId: 2, threads: [closed(1, NOW - DAY, 'x')] } } })
  await start($)

  // Act
  const answer = await run($, 'threads')

  // Assert
  expect(answer).toMatchObject({ text: '— closed —\n#1 · tied 1d · x' })
})

test('/threads with no threads says No loose ends.', async ($, on) => {
  // Arrange
  setup(on)
  await start($)

  // Act
  const answer = await run($, 'threads')

  // Assert
  expect(answer).toMatchObject({ text: 'No loose ends.' })
})

test('a command whose store write fails answers one line', async ($, on) => {
  // Arrange
  setup(on, { failWrites: true })
  await start($)

  // Act
  const answer = await run($, 'park', 'x')

  // Assert
  expect(answer).toMatchObject({ text: 'loose-ends: /park failed' })
})

test('/park of a label matching a closed thread creates a new thread', async ($, on) => {
  // Arrange
  const { store } = setup(on, {
    store: { '/p': { nextId: 2, threads: [closed(1, NOW - DAY, 'naming')] } },
  })
  await start($)

  // Act
  const answer = await run($, 'park', 'Naming')

  // Assert
  expect(answer).toMatchObject({ text: 'Parked #2: Naming' })
  expect(stored(store).threads).toHaveLength(2)
  expect(stored(store).threads[0]).toEqual(closed(1, NOW - DAY, 'naming'))
})

test('/park of an over-long label stores and shows the truncated label', async ($, on) => {
  // Arrange
  const { store } = setup(on)
  await start($)
  const long = 'x'.repeat(200)

  // Act
  const answer = await run($, 'park', long)
  const listed = await run($, 'threads')

  // Assert
  expect(answer).toMatchObject({ text: `Parked #1: ${'x'.repeat(60)}` })
  expect(stored(store).threads[0]?.text).toBe('x'.repeat(60))
  expect(listed).toMatchObject({ text: `— open —\n#1 · 0d · ${'x'.repeat(60)}` })
})

test('/tie tolerates surrounding whitespace around the id and note', async ($, on) => {
  // Arrange
  const { store } = setup(on, {
    store: { '/p': { nextId: 4, threads: [open(1, 'a'), open(2, 'b'), open(3, 'c')] } },
  })
  await start($)

  // Act
  const answer = await run($, 'tie', '  #3   done  ')

  // Assert
  expect(answer).toMatchObject({ text: 'Tied #3 c → done' })
  expect(stored(store).threads[2]).toEqual({ ...open(3, 'c'), closedAt: iso(NOW), note: 'done' })
})

test('/tie keeps an arrow inside the note as typed', async ($, on) => {
  // Arrange
  const { store } = setup(on, {
    store: { '/p': { nextId: 2, threads: [open(1, 'a')] } },
  })
  await start($)

  // Act
  const answer = await run($, 'tie', '1 a → b')
  const listed = await run($, 'threads')

  // Assert
  expect(answer).toMatchObject({ text: 'Tied #1 a → a → b' })
  expect(stored(store).threads[0]?.note).toBe('a → b')
  expect(listed).toMatchObject({ text: '— closed —\n#1 · tied 0d · a → a → b' })
})

test('/drop with extra text after the id answers usage and drops nothing', async ($, on) => {
  // Arrange
  const value = { nextId: 2, threads: [open(1, 'a')] }
  const { store } = setup(on, { store: { '/p': value } })
  await start($)

  // Act
  const answer = await run($, 'drop', '1 please')

  // Assert
  expect(answer).toMatchObject({ text: 'Usage: /drop <id>' })
  expect(stored(store)).toEqual(value)
})

test('/threads ages floor: 0d for the same day and at 23h59, 1d at 24h', async ($, on) => {
  // Arrange
  const MIN = 60_000
  const threads: Thread[] = [
    open(1, 'now', NOW),
    open(2, 'almost', NOW - DAY + MIN),
    open(3, 'exact', NOW - DAY),
  ]
  setup(on, { store: { '/p': { nextId: 4, threads } } })
  await start($)

  // Act
  const answer = await run($, 'threads')

  // Assert
  expect(answer).toMatchObject({
    // Oldest first.
    text: ['— open —', '#3 · 1d · exact', '#2 · 0d · almost', '#1 · 0d · now'].join('\n'),
  })
})

test('/threads with more than 5 closed shows only the 5 most recently closed', async ($, on) => {
  // Arrange
  // The array order follows neither id nor closing order, and the five newest
  // closures (#7, #2, #5, #8, #3) are neither the first nor the last five in
  // the array, nor the highest or lowest ids: only a sort by closedAt finds them.
  const closedDaysAgo = (id: number, days: number): Thread =>
    closed(id, NOW - days * DAY, `c${id}`)
  const threads: Thread[] = [
    closedDaysAgo(3, 5),
    closedDaysAgo(7, 1),
    closedDaysAgo(1, 6),
    closedDaysAgo(5, 3),
    closedDaysAgo(2, 2),
    closedDaysAgo(8, 4),
    closedDaysAgo(4, 8),
    closedDaysAgo(6, 7),
  ]
  setup(on, { store: { '/p': { nextId: 9, threads } } })
  await start($)

  // Act
  const answer = await run($, 'threads')

  // Assert
  expect(answer).toMatchObject({
    text: [
      '— closed —',
      '#7 · tied 1d · c7',
      '#2 · tied 2d · c2',
      '#5 · tied 3d · c5',
      '#8 · tied 4d · c8',
      '#3 · tied 5d · c3',
    ].join('\n'),
  })
})

// The rule as the plan gives it, written out here so a change to the module
// constant shows up as a failing test.
const RULE_TEXT =
  '**Loose ends.** This project keeps a list of open discussion threads (tools `park`, `close`, `list`). If your previous reply raised 2+ separate points that needed the user\'s input (in prose or as questions in a question dialog) and their reply took up only some or none of them, call `park` with the rest, then say "Parked: …" in one line. A label is a short noun phrase of about 50 characters naming the decision, not the question with its options ("repo hosting", "HANDOFF.md: README or docs/"), clear without this conversation, with no prefix shared across labels. When a parked thread is settled, call `close` with a one-line note; if threads remain open, add one line, "Still open: #id label, …". When the user\'s reply changes what a thread asks, close it with a note saying so and park the new question. Never park implementation steps, todo items or trivia. After `/clear` or at session start, call `list` only when you need to know what\'s pending.'

const COMPOSE = {
  model: 'claude-test',
  promptModel: 'claude-test',
  surfaces: ['terminal'],
  tools: [],
  outputStyle: null,
  traits: [],
} as const

test('prompt.compose appends the rule after the sections beneath, unchanged', async ($, on) => {
  // Arrange
  const below = [
    { id: 'intro', scope: 'shared', text: 'Intro text.' },
    { id: 'env', scope: 'session', text: 'Env text.' },
  ] as const
  setup(on)
  on('prompt.compose', () => ({ sections: below }))
  await start($)

  // Act
  const { sections } = await $.prompt.compose(COMPOSE)

  // Assert
  expect(sections).toEqual([
    ...below,
    { id: 'loose-ends:rule', scope: 'session', text: RULE_TEXT },
  ])
})

test('the rule stays last when the sections beneath end with a session section', async ($, on) => {
  // Arrange
  setup(on)
  on('prompt.compose', () => ({
    sections: [
      { id: 'a', scope: 'session', text: 'A' },
      { id: 'z', scope: 'session', text: 'Z' },
    ],
  }))
  await start($)

  // Act
  const { sections } = await $.prompt.compose(COMPOSE)

  // Assert
  expect(sections.map((s) => s.id)).toEqual(['a', 'z', 'loose-ends:rule'])
})

test('without its tools registered the rule is left out and the failure is logged to debug', async ($, on) => {
  // Arrange
  const below = [{ id: 'a', scope: 'shared', text: 'A' }] as const
  const { logs, commands } = setup(on, { failToolRegister: true })
  on('prompt.compose', () => ({ sections: below }))
  await start($)

  // Act
  const { sections } = await $.prompt.compose(COMPOSE)

  // Assert
  expect(sections).toEqual(below)
  expect(logs).toContainEqual({
    text: expect.stringContaining('tool registration failed'),
    to: 'debug',
  })
  // The commands and the band do not depend on the tools.
  expect(commands).toHaveLength(4)
})

test('before session.start has registered the tools the rule is left out', async ($, on) => {
  // Arrange
  const below = [{ id: 'a', scope: 'shared', text: 'A' }] as const
  on('prompt.compose', () => ({ sections: below }))

  // Act
  const { sections } = await $.prompt.compose(COMPOSE)

  // Assert
  expect(sections).toEqual(below)
})

test('a failed command registration is logged to debug and the rule still goes in', async ($, on) => {
  // Arrange
  const { logs } = setup(on, { failCommandRegister: true })
  on('prompt.compose', () => ({ sections: [] }))
  await start($)

  // Act
  const { sections } = await $.prompt.compose(COMPOSE)

  // Assert
  expect(logs).toContainEqual({
    text: expect.stringContaining('command registration failed'),
    to: 'debug',
  })
  expect(sections.map((s) => s.id)).toEqual(['loose-ends:rule'])
})

test('a throwing debug log breaks neither session.start nor a refresh tick', async ($, on) => {
  // Arrange: tool registration fails, so start logs, and the log throws.
  const stale = { nextId: 1, threads: [closed(1, NOW - (SWEEP_DAYS + 1) * DAY)] }
  const here = [open(1, 'here')]
  const { store, commands, seen, clock, flags } = setup(on, {
    failToolRegister: true,
    failLog: true,
    store: { '/old': stale, '/p': { nextId: 1, threads: here } },
  })

  // Act
  await start($)

  // Assert: the rest of start ran — commands, sweep and the first refresh.
  expect(commands.map(c => (c as { name: string }).name)).toEqual([
    'park',
    'threads',
    'tie',
    'drop',
  ])
  expect(store.has('/old')).toBe(false)
  expect(last(seen)).toEqual(here)

  // Act: a tick whose refresh fails, so it logs, and the log throws.
  flags.failReads = true

  // Assert: the tick settles; safeRefresh never rejects.
  await expect(clock.advance(REFRESH_MS)).resolves.toBeUndefined()
})

test('the rule appears exactly once, however often compose runs', async ($, on) => {
  // Arrange
  setup(on)
  on('prompt.compose', () => ({ sections: [{ id: 'a', scope: 'shared', text: 'A' }] }))
  await start($)

  // Act
  await $.prompt.compose(COMPOSE)
  const { sections } = await $.prompt.compose(COMPOSE)

  // Assert
  expect(sections.filter((s) => s.id === 'loose-ends:rule')).toHaveLength(1)
  expect(sections).toHaveLength(2)
})

test('the rule text does not change with the stored threads', async ($, on) => {
  // Arrange
  setup(on, { store: { '/p': { nextId: 3, threads: [open(1), open(2)] } } })
  on('prompt.compose', () => ({ sections: [] }))
  await start($)

  // Act
  const { sections } = await $.prompt.compose(COMPOSE)

  // Assert
  expect(sections).toEqual([
    { id: 'loose-ends:rule', scope: 'session', text: RULE_TEXT },
  ])
})

// --- The pane and the status line ---

const PANE_PROPS = {
  title: 'Loose ends',
  isFocused: false,
  bodyColumns: 60,
  placement: 'dock',
  scroll: { offset: 0, bodyRows: 30 },
  view: {},
} as const

type PaneProps = {
  bodyColumns?: number
  placement?: 'dock' | 'inline'
  isFocused?: boolean
}

const mountPane = (
  $: Engine,
  surface: 'terminal' | 'desktop' = 'terminal',
  props: PaneProps = {},
) =>
  $.ui.mount({
    plugin: 'loose-ends',
    component: 'Pane',
    requestId: 'loose-ends',
    surface,
    props: { ...PANE_PROPS, ...props },
  })

type MountedPane = Awaited<ReturnType<typeof mountPane>>

/** The ids of the open rows the pane draws, in order. */
const rowIds = async (ui: MountedPane): Promise<number[]> =>
  (await ui.findAll({ type: 'Button' }))
    .map(one => one.key ?? '')
    .filter(key => key.startsWith('thread-'))
    .map(key => Number(key.slice('thread-'.length)))

/** The whole text of open row `id`, as drawn. */
const rowText = async (ui: MountedPane, id: number): Promise<string | undefined> =>
  (await ui.find({ type: 'Button', key: `thread-${id}` }))?.text

/** The pane's empty-state line. */
const NOTHING_OPEN = 'Nothing open.'

/** Whether some Text in the pane shows `text` (a string matches by inclusion). */
const hasText = async (ui: MountedPane, text: string): Promise<boolean> =>
  (await ui.find({ type: 'Text', text })) !== undefined

test('statusText counts the open threads and names the oldest age', async () => {
  // Arrange
  const many = [open(2, 'b', NOW - DAY), open(1, 'a', NOW - 12 * DAY), closed(3, NOW, 'c')]
  const one = [open(4, 'only', NOW)]

  // Act
  const manyLine = statusText(many, NOW)
  const oneLine = statusText(one, NOW)
  const none = statusText([closed(1, NOW)], NOW)

  // Assert
  expect(manyLine).toBe('◦ 2 loose ends · oldest 12d')
  expect(oneLine).toBe('◦ 1 loose end · today')
  expect(none).toBeUndefined()
})

test('the age bar fills a cell every three days and tones fresh, aging, stale', async () => {
  // Arrange
  const days = [0, 2, 3, 8, 9, 12, 40]

  // Act
  const bars = days.map(ageBar)
  const tones = days.map(ageTone)

  // Assert
  expect(bars).toEqual(['▮▯▯▯▯', '▮▯▯▯▯', '▮▮▯▯▯', '▮▮▮▯▯', '▮▮▮▮▯', '▮▮▮▮▮', '▮▮▮▮▮'])
  expect(tones).toEqual(['fresh', 'fresh', 'aging', 'aging', 'stale', 'stale', 'stale'])
})

test('padColumns cuts or pads to exactly the width, counting an arrow as one cell', async () => {
  // Arrange
  const widths = [6, 5, 4, 0, -2]

  // Act
  const padded = widths.map(columns => padColumns('x→y z', columns))

  // Assert
  expect(padded).toEqual(['x→y z ', 'x→y z', 'x→y…', '', ''])
  expect(padStartColumns('3d', 6)).toBe('    3d')
  expect(padStartColumns('longer', 3)).toBe('longer')
})

test('the pane follows park and close on terminal and desktop', async ($, on) => {
  // Arrange
  setup(on)
  await start($)
  await $.tool.call({ tool: PARK, items: ['a', 'b'] })
  const terminal = await mountPane($, 'terminal')
  const desktop = await mountPane($, 'desktop')

  // Act
  const parked = [await rowIds(terminal), await rowIds(desktop)]
  await $.tool.call({ tool: CLOSE, id: 1 })
  const closedIds = [await rowIds(terminal), await rowIds(desktop)]

  // Assert
  expect(parked).toEqual([[1, 2], [1, 2]])
  expect(closedIds).toEqual([[2], [2]])
  await terminal.unmount()
  await desktop.unmount()
})

test('a docked row is mark, id, label, age bar and age, padded to the pane', async ($, on) => {
  // Arrange: 60 columns less the card's frame of 4 leaves 56; the label gets
  // what the 19 fixed cells leave, 37.
  setup(on, { store: { '/p': { nextId: 3, threads: [open(1, 'alpha', NOW - 4 * DAY), open(2, 'beta', NOW)] } } })
  await start($)

  // Act
  const ui = await mountPane($)

  // Assert: the oldest is picked by default.
  expect(await rowText(ui, 1)).toBe(`› #1   ${'alpha'.padEnd(37)} ▮▮▯▯▯    4d`)
  expect(await rowText(ui, 2)).toBe(`  #2   ${'beta'.padEnd(37)} ▮▯▯▯▯ today`)
  await ui.unmount()
})

test('a row is coloured by its age and the open card by the oldest', async ($, on) => {
  // Arrange
  setup(on, {
    store: {
      '/p': { nextId: 3, threads: [open(1, 'old', NOW - 10 * DAY), open(2, 'new', NOW)] },
    },
  })
  await start($)

  // Act
  const ui = await mountPane($)
  const staleBar = await ui.find({ type: 'Text', text: '▮▮▮▮▯' })
  const freshBar = await ui.find({ type: 'Text', text: '▮▯▯▯▯' })
  // The card's own title, not the header's "2 OPEN": matches "OPEN"; rejects
  // "2 OPEN".
  // https://regex101.com/?regex=%5EOPEN%24&testString=OPEN
  const title = await ui.find({ type: 'Text', text: /^OPEN$/ })

  // Assert
  expect(staleBar?.props).toMatchObject({ color: 'error' })
  expect(freshBar?.props).toMatchObject({ color: 'success' })
  expect(title?.props).toMatchObject({ color: 'error' })
  await ui.unmount()
})

test('a narrow pane cuts the label with an ellipsis', async ($, on) => {
  // Arrange: at 30 columns the label keeps its minimum of 8 cells.
  setup(on, { store: { '/p': { nextId: 2, threads: [open(1, 'a long label here', NOW)] } } })
  await start($)

  // Act
  const ui = await mountPane($, 'terminal', { bodyColumns: 30 })

  // Assert
  expect(await rowText(ui, 1)).toBe('› #1   a long … ▮▯▯▯▯ today')
  await ui.unmount()
})

test('with nothing open the pane says so and offers no tie or drop', async ($, on) => {
  // Arrange
  setup(on, { store: { '/p': { nextId: 2, threads: [closed(1, NOW - DAY)] } } })
  await start($)

  // Act
  const ui = await mountPane($)

  // Assert
  expect(await hasText(ui, NOTHING_OPEN)).toBe(true)
  expect(await ui.find({ type: 'Button', key: 'tie' })).toBeUndefined()
  expect(await ui.find({ type: 'Button', key: 'drop' })).toBeUndefined()
  await ui.unmount()
})

test('an atom stored under an earlier shape draws an empty pane', async ($, on) => {
  // Arrange: what an earlier version stored, with no shape tag.
  on('state.get', () => ({ value: { value: [open(1, 'a')], version: 1 } }))
  mock.clock(on, { now: NOW })

  // Act
  const ui = await mountPane($)

  // Assert
  expect(await rowIds(ui)).toEqual([])
  expect(await hasText(ui, NOTHING_OPEN)).toBe(true)
  await ui.unmount()
})

test('a store change reaches the pane within one 30 s tick', async ($, on) => {
  // Arrange
  const { store, clock } = setup(on, {
    store: { '/p': { nextId: 2, threads: [open(1, 'a')] } },
  })
  await start($)
  const ui = await mountPane($)
  store.set('/p', { nextId: 3, threads: [open(1, 'a'), open(2, 'b')] })

  // Act
  await clock.advance(30_000)

  // Assert
  expect(await rowIds(ui)).toEqual([1, 2])
  await ui.unmount()
})

test('docked, the pane lists the latest settled threads with their notes', async ($, on) => {
  // Arrange
  setup(on, {
    store: {
      '/p': {
        nextId: 3,
        threads: [{ ...closed(1, NOW - DAY, 'hosting'), note: 'public GitHub' }, open(2, 'a')],
      },
    },
  })
  await start($)

  // Act
  const docked = await mountPane($)
  const inline = await mountPane($, 'desktop', { placement: 'inline' })

  // Assert
  expect(await hasText(docked, 'SETTLED')).toBe(true)
  expect(await hasText(docked, 'hosting')).toBe(true)
  expect(await hasText(docked, '→ public GitHub')).toBe(true)
  expect(await hasText(inline, 'SETTLED')).toBe(false)
  await docked.unmount()
  await inline.unmount()
})

test('inline, the pane shows three open rows and how many more', async ($, on) => {
  // Arrange
  setup(on, {
    store: {
      '/p': {
        nextId: 6,
        threads: [1, 2, 3, 4, 5].map(id => open(id, `t${id}`, NOW - (10 - id) * DAY)),
      },
    },
  })
  await start($)

  // Act
  const ui = await mountPane($, 'terminal', { placement: 'inline' })

  // Assert
  expect(await rowIds(ui)).toEqual([1, 2, 3])
  expect(await hasText(ui, '  +2 more · /threads')).toBe(true)
  expect(await hasText(ui, 'LOOSE ENDS')).toBe(false)
  await ui.unmount()
})

test('pressing tie ties the oldest open thread and toasts what it did', async ($, on) => {
  // Arrange
  const { store, toasts } = setup(on, {
    store: { '/p': { nextId: 3, threads: [open(1, 'a', NOW - 2 * DAY), open(2, 'b')] } },
  })
  await start($)
  const ui = await mountPane($, 'terminal', { isFocused: true })

  // Act
  await ui.press({ key: 'tie' })

  // Assert
  expect(toasts).toEqual(['Tied #1 a'])
  expect(await rowIds(ui)).toEqual([2])
  expect(store.get('/p')).toMatchObject({
    threads: [{ id: 1, closedAt: iso(NOW) }, { id: 2 }],
  })
  await ui.unmount()
})

test('pressing a row picks it, and drop arms then drops that one', async ($, on) => {
  // Arrange
  const { store, toasts } = setup(on, {
    store: { '/p': { nextId: 3, threads: [open(1, 'a', NOW - 2 * DAY), open(2, 'b')] } },
  })
  await start($)
  const ui = await mountPane($, 'terminal', { isFocused: true })

  // Act
  await ui.press({ key: 'thread-2' })
  const pickedLabel = (await ui.find({ type: 'Button', key: 'drop' }))?.text
  await ui.press({ key: 'drop' })
  const armedLabel = (await ui.find({ type: 'Button', key: 'drop' }))?.text
  const toastsWhileArmed = [...toasts]
  const rowsWhileArmed = await rowIds(ui)
  await ui.press({ key: 'drop' })

  // Assert: the first press only arms; the second drops.
  expect(pickedLabel).toBe('drop #2')
  expect(armedLabel).toBe('drop #2? d again')
  expect(toastsWhileArmed).toEqual([])
  expect(rowsWhileArmed).toEqual([1, 2])
  expect(toasts).toEqual(['Dropped #2 b'])
  expect(await rowIds(ui)).toEqual([1])
  expect(store.get('/p')).toMatchObject({ threads: [{ id: 1 }] })
  await ui.unmount()
})

test('picking a row disarms a drop, so the next drop press arms again', async ($, on) => {
  // Arrange: arm the oldest, then pick another row and the oldest again.
  const { store, toasts } = setup(on, {
    store: { '/p': { nextId: 3, threads: [open(1, 'a', NOW - 2 * DAY), open(2, 'b')] } },
  })
  await start($)
  const ui = await mountPane($, 'terminal', { isFocused: true })
  await ui.press({ key: 'drop' })

  // Act
  await ui.press({ key: 'thread-2' })
  await ui.press({ key: 'thread-1' })
  const label = (await ui.find({ type: 'Button', key: 'drop' }))?.text
  await ui.press({ key: 'drop' })

  // Assert: that press armed #1 again and dropped nothing.
  expect(label).toBe('drop #1')
  expect(toasts).toEqual([])
  expect(await rowIds(ui)).toEqual([1, 2])
  expect(store.get('/p')).toMatchObject({ threads: [{ id: 1 }, { id: 2 }] })
  await ui.unmount()
})

test('tie disarms drop, so the next target needs two presses', async ($, on) => {
  // Arrange: arm drop on the oldest, #1.
  const { toasts } = setup(on, {
    store: {
      '/p': { nextId: 4, threads: [open(1, 'a', NOW - 2 * DAY), open(2, 'b'), open(3, 'c')] },
    },
  })
  await start($)
  const ui = await mountPane($, 'terminal', { isFocused: true })
  await ui.press({ key: 'drop' })

  // Act: tie the armed #1; #2 becomes the target.
  await ui.press({ key: 'tie' })
  await ui.press({ key: 'drop' })

  // Assert: the drop press armed #2 rather than dropping it.
  expect(toasts).toEqual(['Tied #1 a'])
  expect((await ui.find({ type: 'Button', key: 'drop' }))?.text).toBe('drop #2? d again')
  expect(await rowIds(ui)).toEqual([2, 3])
  await ui.unmount()
})

test('the pane draws at a tiny bodyColumns without throwing', async ($, on) => {
  // Arrange
  setup(on, { store: { '/p': { nextId: 2, threads: [open(1, 'a')] } } })
  await start($)
  const columns = [5, 1, 0]

  // Act
  const drawn = await columns.reduce<Promise<readonly number[][]>>(async (pending, bodyColumns) => {
    const done = await pending
    const ui = await mountPane($, 'terminal', { bodyColumns })
    const ids = await rowIds(ui)
    await ui.unmount()
    return [...done, ids]
  }, Promise.resolve([]))

  // Assert
  expect(drawn).toEqual([[1], [1], [1]])
})

test('an atom stored under the current shape draws its rows', async ($, on) => {
  // Arrange: the same read as the earlier-shape test, under this version's tag.
  on('state.get', () => ({
    value: { value: { shape: 'threads-1', value: [open(1, 'a')] }, version: 1 },
  }))
  mock.clock(on, { now: NOW })

  // Act
  const ui = await mountPane($)

  // Assert
  expect(await rowIds(ui)).toEqual([1])
  await ui.unmount()
})

test('the status line follows the open count from start, park and close', async ($, on) => {
  // Arrange
  const { statuses } = setup(on, { store: { '/p': { nextId: 2, threads: [open(1, 'a', NOW - 3 * DAY)] } } })

  // Act
  await start($)
  const atStart = statuses.at(-1)
  await $.tool.call({ tool: PARK, items: ['b'] })
  const afterPark = statuses.at(-1)
  await $.tool.call({ tool: CLOSE, id: 1 })
  await $.tool.call({ tool: CLOSE, id: 2 })
  const afterClose = statuses.at(-1)

  // Assert
  expect(atStart).toBe('◦ 1 loose end · 3d')
  expect(afterPark).toBe('◦ 2 loose ends · oldest 3d')
  expect(afterClose).toBeUndefined()
})

test('the start opens the pane unasked only while something is open', async ($, on) => {
  // Arrange
  const empty = setup(on)

  // Act
  await start($)
  const beforePark = [...empty.opens]
  await $.tool.call({ tool: PARK, items: ['a'] })

  // Assert
  expect(beforePark).toEqual([])
  expect(empty.opens).toEqual([{ id: 'loose-ends', title: 'Loose ends' }])
})

test('the close button closes the pane and stops unasked opens until /threads', async ($, on) => {
  // Arrange
  const { opens, closes } = setup(on, { store: { '/p': { nextId: 2, threads: [open(1, 'a')] } } })
  await start($)
  const ui = await mountPane($, 'terminal', { isFocused: true })

  // Act
  await ui.press({ key: 'hide' })
  const opensBefore = opens.length
  await $.tool.call({ tool: PARK, items: ['b'] })
  const opensAfterPark = opens.length
  await run($, 'threads')
  await $.tool.call({ tool: PARK, items: ['c'] })

  // Assert: the park after the close opened nothing; /threads did, and so
  // did the park after it.
  expect(closes).toEqual([{ id: 'loose-ends', origin: { kind: 'plugin' } }])
  expect(opensAfterPark).toBe(opensBefore)
  expect(opens.slice(opensBefore)).toEqual([
    { id: 'loose-ends', title: 'Loose ends', focus: true },
    { id: 'loose-ends', title: 'Loose ends' },
  ])
  await ui.unmount()
})

// Not covered here: a close from the engine's own mark (origin `person`). The
// test kit's `$` raises no `ui.close` of its own, so `noteClose` runs only in
// a session.
test('/threads opens the pane with the keyboard and answers in one line once it is drawn', async ($, on) => {
  // Arrange
  const { opens, flags } = setup(on, { store: { '/p': { nextId: 2, threads: [open(1, 'a')] } } })
  await start($)
  flags.isPanePlaced = true

  // Act
  const answer = await run($, 'threads')

  // Assert
  expect(answer).toMatchObject({ text: 'Opened the loose ends pane.' })
  expect(opens).toEqual([
    { id: 'loose-ends', title: 'Loose ends' },
    { id: 'loose-ends', title: 'Loose ends', focus: true },
  ])
})

// --- Every caught failure answers one line and says why in the debug log ---

const debugLines = (logs: readonly { text: string; to: string }[]): string[] =>
  logs.filter(one => one.to === 'debug').map(one => one.text)

// What the plugin's error says when a setup hook denies its call: the engine
// prefixes the deny reason with the plugin and the call.
const denied = (call: string, reason: string): string => `loose-ends: ${call}: ${reason}`

const STORE_FULL = denied('$.store.set', 'store full')
const STORE_UNREADABLE = denied('$.store.get', 'store unreadable')
const STATE_GONE = denied('$.state.get', 'state gone')
const ATOM_REFUSED = denied('$.state.set', 'atom refused')

test('a park or /park the store refuses says why in the debug log', async ($, on) => {
  // Arrange
  const { logs } = setup(on, { failWrites: true })
  await start($)

  // Act
  const tool = await $.tool.call({ tool: PARK, items: ['x'] })
  const command = await run($, 'park', 'y')

  // Assert
  expect(tool).toEqual({ deny: 'loose-ends: park failed' })
  expect(command).toMatchObject({ text: 'loose-ends: /park failed' })
  expect(debugLines(logs)).toEqual([
    `loose-ends: park failed: ${STORE_FULL}`,
    `loose-ends: /park failed: ${STORE_FULL}`,
  ])
})

test('a close the store refuses is denied with one line and says why', async ($, on) => {
  // Arrange
  const value = { nextId: 2, threads: [open(1, 'a')] }
  const { store, logs } = setup(on, { failWrites: true, store: { '/p': value } })
  await start($)

  // Act
  const answer = await $.tool.call({ tool: CLOSE, id: 1 })

  // Assert
  expect(answer).toEqual({ deny: 'loose-ends: close failed' })
  expect(debugLines(logs)).toEqual([`loose-ends: close failed: ${STORE_FULL}`])
  expect(stored(store)).toEqual(value)
})

test('list and /threads on a store that cannot be read answer one line and say why', async ($, on) => {
  // Arrange
  const { logs, flags } = setup(on, {
    store: { '/p': { nextId: 2, threads: [open(1, 'a')] } },
  })
  await start($)
  flags.failReads = true

  // Act
  const listed = await $.tool.call({ tool: LIST })
  const threads = await run($, 'threads')

  // Assert
  expect(listed).toEqual({ deny: 'loose-ends: list failed' })
  expect(threads).toMatchObject({ text: 'loose-ends: /threads failed' })
  expect(debugLines(logs)).toEqual([
    `loose-ends: list failed: ${STORE_UNREADABLE}`,
    `loose-ends: /threads failed: ${STORE_UNREADABLE}`,
  ])
})

test('/tie and /drop answer one line when the store cannot be written or read', async ($, on) => {
  // Arrange
  const value = { nextId: 2, threads: [open(1, 'a')] }
  const { store, logs, flags } = setup(on, { failWrites: true, store: { '/p': value } })
  await start($)

  // Act
  const onWrite = [await run($, 'tie', '1 done'), await run($, 'drop', '1')]
  flags.failReads = true
  const onRead = [await run($, 'tie', '1 done'), await run($, 'drop', '1')]

  // Assert
  const tie = expect.objectContaining({ text: 'loose-ends: /tie failed' })
  const drop = expect.objectContaining({ text: 'loose-ends: /drop failed' })
  expect([...onWrite, ...onRead]).toEqual([tie, drop, tie, drop])
  expect(debugLines(logs)).toEqual([
    `loose-ends: /tie failed: ${STORE_FULL}`,
    `loose-ends: /drop failed: ${STORE_FULL}`,
    `loose-ends: /tie failed: ${STORE_UNREADABLE}`,
    `loose-ends: /drop failed: ${STORE_UNREADABLE}`,
  ])
  expect(stored(store)).toEqual(value)
})

test('a failed refresh says why in the debug log and keeps the pane as it was', async ($, on) => {
  // Arrange
  const { logs, flags, clock, seen } = setup(on, {
    store: { '/p': { nextId: 2, threads: [open(1, 'a')] } },
  })
  await start($)
  const ui = await mountPane($)
  const writes = seen.length
  flags.failReads = true

  // Act
  await clock.advance(REFRESH_MS)

  // Assert
  expect(debugLines(logs)).toEqual([`loose-ends: refresh failed: ${STORE_UNREADABLE}`])
  expect(seen).toHaveLength(writes)
  expect(await rowIds(ui)).toEqual([1])
  await ui.unmount()
})

test('a failed read of the tools-ready flag leaves the rule out and says why', async ($, on) => {
  // Arrange
  const { logs, flags } = setup(on)
  on('prompt.compose', () => ({ sections: [] }))
  await start($)
  flags.failReadyReads = true

  // Act
  const { sections } = await $.prompt.compose(COMPOSE)

  // Assert
  expect(sections).toEqual([])
  expect(debugLines(logs)).toEqual([
    `loose-ends: reading tool registration failed: ${STATE_GONE}`,
  ])
})

test('a write whose atom update fails still answers success and keeps the store change', async ($, on) => {
  // Arrange
  const { store, flags, logs, clock, seen } = setup(on, {
    store: { '/p': { nextId: 3, threads: [open(1, 'a'), open(2, 'b')] } },
  })
  await start($)
  flags.failAtomWrites = true

  // Act
  const closedAnswer = await $.tool.call({ tool: CLOSE, id: 1 })
  const parked = await $.tool.call({ tool: PARK, items: ['c'] })
  const tied = await run($, 'tie', '2 done')

  // Assert
  const expected: Thread[] = [
    { ...open(1, 'a'), closedAt: iso(NOW) },
    { ...open(2, 'b'), closedAt: iso(NOW), note: 'done' },
    { id: 3, text: 'c', origin: 'claude', openedAt: iso(NOW) },
  ]
  expect(closedAnswer).toEqual({ result: 'Closed #1. Still open: #2 b' })
  expect(parked).toEqual({ result: 'Parked: #3' })
  expect(tied).toMatchObject({ text: 'Tied #2 b → done' })
  expect(stored(store).threads).toEqual(expected)
  expect(debugLines(logs)).toEqual([
    `loose-ends: pane update failed: ${ATOM_REFUSED}`,
    `loose-ends: pane update failed: ${ATOM_REFUSED}`,
    `loose-ends: pane update failed: ${ATOM_REFUSED}`,
  ])

  // Act: the next tick, with the atom writable again, heals the band.
  flags.failAtomWrites = false
  await clock.advance(REFRESH_MS)

  // Assert
  expect(last(seen)).toEqual(expected)
})

// --- The write path re-reads the store: another session's change survives ---

test('a park keeps a thread another session parked since the last tick', async ($, on) => {
  // Arrange
  const { store } = setup(on, { store: { '/p': { nextId: 2, threads: [open(1, 'a')] } } })
  await start($)
  // Another session parks #2; no tick runs, so the atom still holds #1 alone.
  store.set('/p', { v: 1, nextId: 3, threads: [open(1, 'a'), open(2, 'external')] })

  // Act
  const answer = await $.tool.call({ tool: PARK, items: ['new'] })

  // Assert
  expect(answer).toEqual({ result: 'Parked: #3' })
  expect(stored(store).threads.map(t => [t.id, t.text])).toEqual([
    [1, 'a'],
    [2, 'external'],
    [3, 'new'],
  ])
})

test('a park keeps a /tie another session made since the last tick', async ($, on) => {
  // Arrange
  const { store } = setup(on, {
    store: { '/p': { nextId: 3, threads: [open(1, 'a'), open(2, 'b')] } },
  })
  await start($)
  const tiedElsewhere: Thread = { ...open(1, 'a'), closedAt: iso(NOW - DAY), note: 'elsewhere' }
  store.set('/p', { v: 1, nextId: 3, threads: [tiedElsewhere, open(2, 'b')] })

  // Act
  await run($, 'park', 'c')

  // Assert
  expect(stored(store).threads).toEqual([
    tiedElsewhere,
    open(2, 'b'),
    { id: 3, text: 'c', origin: 'user', openedAt: iso(NOW) },
  ])
})

test('through the plugin the pane lists oldest first by openedAt, not id', async ($, on) => {
  // Arrange
  setup(on, {
    store: {
      '/p': {
        nextId: 4,
        threads: [open(1, 'newest', NOW - DAY), open(2, 'oldest', NOW - 5 * DAY), open(3, 'middle', NOW - 3 * DAY)],
      },
    },
  })
  await start($)

  // Act
  const ui = await mountPane($)

  // Assert
  expect(await rowIds(ui)).toEqual([2, 3, 1])
  await ui.unmount()
})

test('a text of exactly the width is whole, one cell less is cut', async () => {
  // Arrange
  const text = 'abcde'

  // Act
  const exact = fitColumns(text, 5)
  const short = fitColumns(text, 4)

  // Assert
  expect(exact).toBe('abcde')
  expect(short).toBe('abc…')
})

// `writeThreads` is a read-modify-write: two writes from one session that
// overlap would both read the same project, and the later `$.store.set` would
// overwrite the earlier. The per-key write queue in state.ts runs them one
// after the other.
test('two parks in parallel from one session both land with distinct ids', async ($, on) => {
  // Arrange
  const { store } = setup(on)
  await start($)

  // Act: one message with two park calls, as the model can send.
  const answers = await Promise.all([
    $.tool.call({ tool: PARK, items: ['x'] }),
    $.tool.call({ tool: PARK, items: ['y'] }),
  ])

  // Assert
  const threads = stored(store).threads
  expect(threads.map(t => t.text).sort()).toEqual(['x', 'y'])
  expect(new Set(threads.map(t => t.id)).size).toBe(2)
  expect(answers).toEqual(
    expect.arrayContaining([{ result: 'Parked: #1' }, { result: 'Parked: #2' }]),
  )
})

test('a failed write does not block the write queued behind it', async ($, on) => {
  // Arrange
  const { store, flags } = setup(on)
  await start($)
  flags.failNextWrite = true

  // Act
  const answers = await Promise.all([
    $.tool.call({ tool: PARK, items: ['x'] }),
    $.tool.call({ tool: PARK, items: ['y'] }),
  ])

  // Assert
  expect(answers[0]).toEqual({ deny: 'loose-ends: park failed' })
  expect(answers[1]).toEqual({ result: 'Parked: #1' })
  expect(stored(store).threads.map(t => t.text)).toEqual(['y'])
})

test('a write queued after a failure re-reads the store', async ($, on) => {
  // Arrange
  const { store, flags } = setup(on)
  await start($)
  store.set('/p', { v: 1, nextId: 6, threads: [open(5, 'external')] })
  flags.failNextWrite = true

  // Act
  const answers = await Promise.all([
    $.tool.call({ tool: PARK, items: ['x'] }),
    $.tool.call({ tool: PARK, items: ['y'] }),
  ])

  // Assert
  expect(answers[0]).toEqual({ deny: 'loose-ends: park failed' })
  expect(answers[1]).toEqual({ result: 'Parked: #6' })
  expect(
    stored(store)
      .threads.map(t => [t.id, t.text])
      .sort(),
  ).toEqual([
    [5, 'external'],
    [6, 'y'],
  ])
})

test('sequential writes after the queue drained still land', async ($, on) => {
  // Arrange
  const { store } = setup(on)
  await start($)

  // Act
  const first = await $.tool.call({ tool: PARK, items: ['x'] })
  const second = await $.tool.call({ tool: PARK, items: ['y'] })

  // Assert
  expect(first).toEqual({ result: 'Parked: #1' })
  expect(second).toEqual({ result: 'Parked: #2' })
  expect(stored(store).threads.map(t => [t.id, t.text])).toEqual([
    [1, 'x'],
    [2, 'y'],
  ])
})

test('tools and commands writing in parallel from one session all land', async ($, on) => {
  // Arrange
  const { store, seen } = setup(on, {
    store: { '/p': { nextId: 3, threads: [open(1, 'a'), open(2, 'b')] } },
  })
  await start($)

  // Act: a park and a close from the model while the person types /park and
  // /drop.
  const [parked, closedAnswer, typed, dropped] = await Promise.all([
    $.tool.call({ tool: PARK, items: ['c'] }),
    $.tool.call({ tool: CLOSE, id: 1 }),
    run($, 'park', 'd'),
    run($, 'drop', '2'),
  ])

  // Assert: every effect is in the store.
  const { threads, nextId: counter } = stored(store)
  expect(threads.find(t => t.id === 1)).toEqual({ ...open(1, 'a'), closedAt: iso(NOW) })
  expect(threads.find(t => t.id === 2)).toBeUndefined()
  const added = threads.filter(t => t.id > 2)
  expect(added.map(t => t.text).sort()).toEqual(['c', 'd'])
  expect(added.map(t => t.id).sort()).toEqual([3, 4])
  expect(counter).toBe(5)
  // Each answer names the id its own write took.
  const parkedId = added.find(t => t.text === 'c')?.id
  const typedId = added.find(t => t.text === 'd')?.id
  expect(parked).toEqual({ result: `Parked: #${parkedId}` })
  expect(typed).toMatchObject({ text: `Parked #${typedId}: d` })
  expect(closedAnswer).toMatchObject({ result: expect.stringContaining('Closed #1.') })
  expect(dropped).toMatchObject({ text: 'Dropped #2 b' })
  // The last atom write is the store's final list.
  expect(last(seen)).toEqual(threads)
})

test('close of an id another session dropped is denied and leaves the store as it is', async ($, on) => {
  // Arrange
  const { store } = setup(on, {
    store: { '/p': { nextId: 3, threads: [open(1, 'a'), open(2, 'b')] } },
  })
  await start($)
  // Another session drops #2; no tick runs, so the atom still holds it.
  const afterDrop = { v: 1, nextId: 3, threads: [open(1, 'a')] }
  store.set('/p', afterDrop)

  // Act
  const answer = await $.tool.call({ tool: CLOSE, id: 2 })

  // Assert
  expect(answer).toEqual({ deny: 'no open thread #2' })
  expect(store.get('/p')).toEqual(afterDrop)
})

test('a pane whose threads read fails draws an empty list and says why', async ($, on) => {
  // Arrange
  const { logs, flags } = setup(on, {
    store: { '/p': { nextId: 2, threads: [open(1, 'a')] } },
  })
  await start($)
  flags.failThreadReads = true

  // Act
  const ui = await mountPane($)

  // Assert
  expect(await rowIds(ui)).toEqual([])
  expect(await hasText(ui, NOTHING_OPEN)).toBe(true)
  expect(debugLines(logs)).toEqual([`loose-ends: pane read failed: ${STATE_GONE}`])
  await ui.unmount()
})

// A refresh reads the store, then writes the atom. Run beside a park, it must
// not put back the list it read before the park landed.
test('a refresh tick running beside a park leaves the parked thread in the atom', async ($, on) => {
  // Arrange
  const { store, clock, seen, flags, readGate } = setup(on)
  await start($)
  store.set('/p', { v: 1, nextId: 6, threads: [open(5, 'external')] })
  flags.holdNextRead = true

  // Act: the tick's refresh reads the store and is held there; a park starts
  // and is given time to land; then the refresh goes on with what it read.
  const tick = clock.advance(REFRESH_MS)
  await readGate.reached
  const parked = $.tool.call({ tool: PARK, items: ['n'] })
  await settle()
  readGate.release()
  await Promise.all([tick, parked])
  // The timer does not await the refresh it starts: give it time to finish.
  await settle()

  // Assert
  const threads = stored(store).threads
  expect(threads.map(t => t.text)).toEqual(['external', 'n'])
  expect(last(seen)).toEqual(threads)
})

test('park and close keep labels and notes on one line', async ($, on) => {
  // Arrange
  const { store } = setup(on)
  await start($)

  // Act
  await $.tool.call({ tool: PARK, items: ['a\nb'] })
  const closedAnswer = await $.tool.call({ tool: CLOSE, id: 1, note: 'done\n\tsee PR' })
  const listed = await run($, 'threads')

  // Assert
  expect(stored(store).threads[0]).toMatchObject({ text: 'a b', note: 'done see PR' })
  expect(closedAnswer).toEqual({ result: 'Closed #1. Nothing else open.' })
  expect(listed).toMatchObject({ text: expect.stringContaining('a b → done see PR') })
})

test('a tool that fails to register is named in the debug log and the rule is left out', async ($, on) => {
  // Arrange
  const below = [{ id: 'a', scope: 'shared', text: 'A' }] as const
  const { logs, tools } = setup(on, { failToolNamed: 'close' })
  on('prompt.compose', () => ({ sections: below }))
  await start($)

  // Act
  const { sections } = await $.prompt.compose(COMPOSE)

  // Assert
  expect(tools).toHaveLength(2)
  expect(sections).toEqual(below)
  expect(debugLines(logs)).toEqual([
    expect.stringContaining('loose-ends: tool registration failed: not registered: close ('),
  ])
})
