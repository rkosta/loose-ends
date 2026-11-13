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
import type { ParkItem, ParkOutcome } from './threads'

// Helpers handed `$` are function declarations: past an import the engine
// follows `$` only into those.

/** What a tool hook answers: the model reads `result`, or `deny` as an error. */
export type ToolAnswer = { result: string } | { deny: string }

/** A tool call's arguments as they arrive, spread on `e` beside `agentId`. */
export type ToolArgs = { readonly [argument: string]: unknown }

const FULL = `${MAX_OPEN} loose ends open — ask the user to /loose tie or /loose drop some first`

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
        'Park discussion points the user has not answered yet. Each item has a label, a short noun phrase of about 50 characters (cut at 60), and a context of 1–3 sentences: where the point came up, the options on the table and what hinges on it, clear without this conversation (cut at 500). Returns their thread ids.',
      inputSchema: {
        type: 'object',
        properties: {
          items: {
            type: 'array',
            items: {
              type: 'object',
              properties: { label: { type: 'string' }, context: { type: 'string' } },
              required: ['label'],
            },
            minItems: 1,
          },
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

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const isFilled = (value: unknown): value is string =>
  typeof value === 'string' && value.trim() !== ''

/**
 * One park item as the model sent it: `{ label, context? }` as the schema
 * asks, or a bare label string as earlier schemas did; undefined when the
 * label is blank or anything is the wrong type.
 */
const toParkItem = (item: unknown): ParkItem | undefined => {
  if (isFilled(item)) {
    return { label: item }
  }

  if (!isRecord(item) || !isFilled(item.label)) {
    return undefined
  }

  const { label, context } = item

  if (context !== undefined && typeof context !== 'string') {
    return undefined
  }

  return context === undefined ? { label } : { label, context }
}

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

  const parsed = items.map(toParkItem)
  const parkItems = parsed.filter((item): item is ParkItem => item !== undefined)

  if (parkItems.length !== items.length) {
    return { deny: 'park items need a non-blank label and a string context' }
  }

  try {
    const written = await writeThreads($, (project, nowIso) =>
      parkLabels(project, parkItems, 'claude', nowIso, MAX_OPEN),
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
