import type { EngineInterface } from 'claude-code'

import {
  UNREADABLE_READ,
  UNREADABLE_WRITE,
  describeError,
  logDebug,
  projectKey,
  readProject,
  writeThreads,
} from './state'
import {
  closeThread,
  dropThread,
  formatThreads,
  normaliseLabel,
  parkLabels,
  parseThreadId,
} from './threads'
import type { Project } from './threads'
import type { Thread } from '../types'

// Helpers handed `$` are function declarations: past an import the engine
// follows `$` only into those.

/** What a command hook answers: one transcript row, which the model reads too. */
export type CommandAnswer = { text: string }

const PARK_USAGE = 'Usage: /park <text>'
const TIE_USAGE = 'Usage: /tie <id> [note]'
const DROP_USAGE = 'Usage: /drop <id>'

/** Registers /park, /threads, /tie and /drop. */
export async function registerCommands($: EngineInterface): Promise<void> {
  await Promise.all([
    $.command.register({
      name: 'park',
      description: 'Park a loose end for this project',
      argumentHint: '<text>',
    }),
    $.command.register({
      name: 'threads',
      description: "List this project's loose ends, open and recently tied",
    }),
    $.command.register({
      name: 'tie',
      description: 'Tie off a loose end, with an optional note',
      argumentHint: '<id> [note]',
    }),
    $.command.register({
      name: 'drop',
      description: 'Remove a loose end parked by mistake',
      argumentHint: '<id>',
    }),
  ])
}

/** Splits `"#3 a note"` into its id token and the rest. */
const splitId = (args: string): { token: string; rest: string } => {
  // The first run of non-blanks, then everything after the blanks that follow
  // it: matches "#3 a note" (token "#3", rest "a note"); rejects "" and "   ".
  // https://regex101.com/?regex=%5E(%5CS%2B)%5Cs*(%5B%5Cs%5CS%5D*)%24&testString=%233%20a%20note
  const match = /^(\S+)\s*([\s\S]*)$/.exec(args.trim())

  return match === null
    ? { token: '', rest: '' }
    : { token: match[1] ?? '', rest: match[2] ?? '' }
}

const findThread = (
  project: Project | undefined,
  id: number,
): Thread | undefined => project?.threads.find(one => one.id === id)

export async function parkCommand(
  $: EngineInterface,
  args: string,
): Promise<CommandAnswer> {
  if (args.trim() === '') {
    return { text: PARK_USAGE }
  }

  try {
    const written = await writeThreads($, (project, nowIso) =>
      parkLabels(project, [args], 'user', nowIso),
    )

    if (written.kind === 'unreadable') {
      return { text: UNREADABLE_WRITE }
    }

    const outcome = written.result
    const parked = outcome.kind === 'parked' ? outcome.parked[0] : undefined

    if (parked === undefined) {
      // Not reached today: /park passes no cap and one non-blank label always
      // parks or matches one. The types allow `full` and an empty list.
      logDebug($, 'loose-ends: /park unexpected outcome')

      return { text: 'loose-ends: /park failed' }
    }

    if (parked.isExisting) {
      return { text: `Already open as #${parked.id}.` }
    }

    return { text: `Parked #${parked.id}: ${normaliseLabel(args)}` }
  } catch (error) {
    logDebug($, `loose-ends: /park failed: ${describeError(error)}`)

    return { text: 'loose-ends: /park failed' }
  }
}

export async function threadsCommand(
  $: EngineInterface,
): Promise<CommandAnswer> {
  try {
    const parsed = await readProject($, await projectKey($))

    if (parsed.kind === 'unrecognised') {
      return { text: UNREADABLE_READ }
    }

    return { text: formatThreads(parsed.project.threads, await $.clock.now()) }
  } catch (error) {
    logDebug($, `loose-ends: /threads failed: ${describeError(error)}`)

    return { text: 'loose-ends: /threads failed' }
  }
}

export async function tieCommand(
  $: EngineInterface,
  args: string,
): Promise<CommandAnswer> {
  const { token, rest } = splitId(args)
  const id = parseThreadId(token)

  if (id === undefined) {
    return { text: TIE_USAGE }
  }

  try {
    const written = await writeThreads($, (project, nowIso) => {
      const next = closeThread(project, id, nowIso, rest)

      return { project: next, result: next }
    })

    if (written.kind === 'unreadable') {
      return { text: UNREADABLE_WRITE }
    }

    const thread = findThread(written.result, id)

    if (thread === undefined) {
      return { text: `No open thread #${id}.` }
    }

    const tied = `Tied #${thread.id} ${thread.text}`

    return { text: thread.note === undefined ? tied : `${tied} → ${thread.note}` }
  } catch (error) {
    logDebug($, `loose-ends: /tie failed: ${describeError(error)}`)

    return { text: 'loose-ends: /tie failed' }
  }
}

export async function dropCommand(
  $: EngineInterface,
  args: string,
): Promise<CommandAnswer> {
  const { token, rest } = splitId(args)
  const id = rest === '' ? parseThreadId(token) : undefined

  if (id === undefined) {
    return { text: DROP_USAGE }
  }

  try {
    const written = await writeThreads($, project => ({
      project: dropThread(project, id),
      result: findThread(project, id),
    }))

    if (written.kind === 'unreadable') {
      return { text: UNREADABLE_WRITE }
    }

    const dropped = written.result

    return dropped === undefined
      ? { text: `No thread #${id}.` }
      : { text: `Dropped #${dropped.id} ${dropped.text}` }
  } catch (error) {
    logDebug($, `loose-ends: /drop failed: ${describeError(error)}`)

    return { text: 'loose-ends: /drop failed' }
  }
}
