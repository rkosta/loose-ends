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
  MAX_LABEL,
  closeThread,
  dropThread,
  formatPull,
  formatThreads,
  normaliseLabel,
  oneLine,
  parkLabels,
  parseThreadId,
} from './threads'
import type { Project } from './threads'
import type { Thread } from '../types'

// Helpers handed `$` are function declarations: past an import the engine
// follows `$` only into those.

/** What a command hook answers: one transcript row, which the model reads too. */
export type CommandAnswer = { text: string }

/** The one command; every action is a verb after it. */
export const COMMAND = 'loose'

const VERBS_HINT = '[park <text> | pull <id> | tie <id> [note] | drop <id> | list]'
const LOOSE_USAGE = `Usage: /loose ${VERBS_HINT}`
const PARK_USAGE = 'Usage: /loose park <text>'
const PULL_USAGE = 'Usage: /loose pull <id>'
const TIE_USAGE = 'Usage: /loose tie <id> [note]'
const DROP_USAGE = 'Usage: /loose drop <id>'

/** Registers /loose. */
export async function registerCommands($: EngineInterface): Promise<void> {
  await $.command.register({
    name: COMMAND,
    description: "This project's loose ends: park, pull into the prompt, tie, drop or list",
    argumentHint: VERBS_HINT,
  })
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

/**
 * Runs `/loose <verb> …`. Bare `/loose` and `list` print the list; the pane
 * open for bare `/loose` is the caller's, which can reach the pane.
 */
export async function looseCommand(
  $: EngineInterface,
  args: string,
): Promise<CommandAnswer> {
  const { token, rest } = splitId(args)

  switch (token.toLowerCase()) {
    case '':
    case 'list':
      return rest === '' ? threadsCommand($) : { text: LOOSE_USAGE }
    case 'park':
      return parkCommand($, rest)
    case 'pull':
      return pullCommand($, rest)
    case 'tie':
      return tieCommand($, rest)
    case 'drop':
      return dropCommand($, rest)
    default:
      return { text: LOOSE_USAGE }
  }
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

  // A label is cut at MAX_LABEL; what the person typed past it is kept
  // whole as the context, so nothing they wrote is lost.
  const isLong = oneLine(args).length > MAX_LABEL
  const item = isLong ? { label: args, context: args } : { label: args }

  try {
    const written = await writeThreads($, (project, nowIso) =>
      parkLabels(project, [item], 'user', nowIso),
    )

    if (written.kind === 'unreadable') {
      return { text: UNREADABLE_WRITE }
    }

    const outcome = written.result
    const parked = outcome.kind === 'parked' ? outcome.parked[0] : undefined

    if (parked === undefined) {
      // Not reached today: /park passes no cap and one non-blank label always
      // parks or matches one. The types allow `full` and an empty list.
      logDebug($, 'loose-ends: /loose park unexpected outcome')

      return { text: 'loose-ends: /loose park failed' }
    }

    if (parked.isExisting) {
      return { text: `Already open as #${parked.id}.` }
    }

    return { text: `Parked #${parked.id}: ${normaliseLabel(args)}` }
  } catch (error) {
    logDebug($, `loose-ends: /loose park failed: ${describeError(error)}`)

    return { text: 'loose-ends: /loose park failed' }
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
    logDebug($, `loose-ends: /loose list failed: ${describeError(error)}`)

    return { text: 'loose-ends: /loose list failed' }
  }
}

/**
 * Puts thread `id` (open or closed) into the prompt box as a draft the
 * person edits or sends, at the cursor so what they typed stays. Where no
 * box takes it, the draft is the answer instead, so it still reaches them.
 */
export async function pullCommand(
  $: EngineInterface,
  args: string,
): Promise<CommandAnswer> {
  const { token, rest } = splitId(args)
  const id = rest === '' ? parseThreadId(token) : undefined

  if (id === undefined) {
    return { text: PULL_USAGE }
  }

  try {
    const parsed = await readProject($, await projectKey($))

    if (parsed.kind === 'unrecognised') {
      return { text: UNREADABLE_READ }
    }

    const thread = findThread(parsed.project, id)

    if (thread === undefined) {
      return { text: `No thread #${id}.` }
    }

    const draft = formatPull(thread)
    const filled = await $.prompt.fill({ text: draft, mode: 'insert' })

    return filled.isFilled ? { text: `Pulled #${id} into the prompt.` } : { text: draft }
  } catch (error) {
    logDebug($, `loose-ends: /loose pull failed: ${describeError(error)}`)

    return { text: 'loose-ends: /loose pull failed' }
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
    logDebug($, `loose-ends: /loose tie failed: ${describeError(error)}`)

    return { text: 'loose-ends: /loose tie failed' }
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
    logDebug($, `loose-ends: /loose drop failed: ${describeError(error)}`)

    return { text: 'loose-ends: /loose drop failed' }
  }
}
