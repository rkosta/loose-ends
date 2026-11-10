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
  MAX_OPEN,
  closeThread,
  formatClose,
  formatList,
  formatPark,
  parkLabels,
} from './threads'
import type { ParkOutcome } from './threads'

// Helpers handed `$` are function declarations: past an import the engine
// follows `$` only into those.

/** What a tool hook answers: the model reads `result`, or `deny` as an error. */
export type ToolAnswer = { result: string } | { deny: string }

/** A tool call's arguments as they arrive, spread on `e` beside `agentId`. */
export type ToolArgs = { readonly [argument: string]: unknown }

const FULL = `${MAX_OPEN} loose ends open — ask the user to /tie or /drop some first`

/**
 * Registers park, close and list, always listed (never behind ToolSearch).
 * Waits for all three, then rejects naming each one that failed, so the
 * caller knows a partial registration from a full one.
 */
export async function registerTools($: EngineInterface): Promise<void> {
  const settledAll = await Promise.allSettled([
    $.tool.register({
      name: 'park',
      description:
        'Park discussion points the user has not answered yet, each as a short noun-phrase label of about 50 characters (cut at 60). Returns their thread ids.',
      inputSchema: {
        type: 'object',
        properties: {
          items: { type: 'array', items: { type: 'string' }, minItems: 1 },
        },
        required: ['items'],
      },
      isDeferred: false,
    }),
    $.tool.register({
      name: 'close',
      description:
        'Close a parked thread once it is settled, with an optional one-line note. Returns what is still open.',
      inputSchema: {
        type: 'object',
        properties: { id: { type: 'integer' }, note: { type: 'string' } },
        required: ['id'],
      },
      isDeferred: false,
    }),
    $.tool.register({
      name: 'list',
      description: "List this project's open parked threads.",
      inputSchema: { type: 'object' },
      isDeferred: false,
    }),
  ])
  const failed = TOOL_NAMES.flatMap((name, i) => {
    const one = settledAll[i]

    return one?.status === 'rejected' ? [`${name} (${describeError(one.reason)})`] : []
  })

  if (failed.length > 0) {
    throw new Error(`not registered: ${failed.join(', ')}`)
  }
}

/** The tools `registerTools` registers, in its order. */
const TOOL_NAMES = ['park', 'close', 'list'] as const

const parkAnswer = (outcome: ParkOutcome): ToolAnswer =>
  outcome.kind === 'full'
    ? { deny: FULL }
    : { result: formatPark(outcome.parked) }

export async function park(
  $: EngineInterface,
  args: ToolArgs,
): Promise<ToolAnswer> {
  if (args.agentId !== undefined) {
    return { deny: 'parking is main-thread only' }
  }

  const { items } = args

  if (!Array.isArray(items) || items.length === 0) {
    return { deny: 'park needs at least one item' }
  }

  const labels = items.filter(
    (item): item is string => typeof item === 'string' && item.trim() !== '',
  )

  if (labels.length !== items.length) {
    return { deny: 'park items must be non-blank strings' }
  }

  try {
    const written = await writeThreads($, (project, nowIso) =>
      parkLabels(project, labels, 'claude', nowIso, MAX_OPEN),
    )

    return written.kind === 'unreadable'
      ? { deny: UNREADABLE_WRITE }
      : parkAnswer(written.result)
  } catch (error) {
    logDebug($, `loose-ends: park failed: ${describeError(error)}`)

    return { deny: 'loose-ends: park failed' }
  }
}

export async function close(
  $: EngineInterface,
  args: ToolArgs,
): Promise<ToolAnswer> {
  const { id, note } = args

  if (typeof id !== 'number' || !Number.isInteger(id)) {
    return { deny: 'close needs an integer id' }
  }

  try {
    const written = await writeThreads($, (project, nowIso) => {
      const next = closeThread(
        project,
        id,
        nowIso,
        typeof note === 'string' ? note : undefined,
      )

      return { project: next, result: next }
    })

    if (written.kind === 'unreadable') {
      return { deny: UNREADABLE_WRITE }
    }

    const closed = written.result

    return closed === undefined
      ? { deny: `no open thread #${id}` }
      : { result: formatClose(id, closed.threads) }
  } catch (error) {
    logDebug($, `loose-ends: close failed: ${describeError(error)}`)

    return { deny: 'loose-ends: close failed' }
  }
}

export async function list($: EngineInterface): Promise<ToolAnswer> {
  try {
    const parsed = await readProject($, await projectKey($))

    return parsed.kind === 'unrecognised'
      ? { deny: UNREADABLE_READ }
      : { result: formatList(parsed.project.threads) }
  } catch (error) {
    logDebug($, `loose-ends: list failed: ${describeError(error)}`)

    return { deny: 'loose-ends: list failed' }
  }
}
