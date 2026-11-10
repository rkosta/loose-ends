import { atom, read, update } from 'claude-code'
import type {
  Color,
  EngineInterface,
  PaneCloseInput,
  RenderElement,
  RenderInput,
} from 'claude-code'

import { dropCommand, tieCommand } from './commands'
import type { CommandAnswer } from './commands'
import { describeError, logDebug } from './state'
import {
  AGE_BAR_CELLS,
  THREADS_ATOM_SHAPE,
  ageBar,
  ageDays,
  ageText,
  ageTone,
  fitColumns,
  isClosed,
  openThreads,
  padColumns,
  padStartColumns,
  recentClosed,
} from './threads'
import type { AgeTone, ClosedThread } from './threads'
import type { Thread } from '../types'

// Helpers handed `$` are function declarations: past an import the engine
// follows `$` only into those.

/** The pane's id: what `$.ui.open` names and the `Pane` render hook matches. */
export const PANE_ID = 'loose-ends'
const PANE_TITLE = 'Loose ends'

// The atom `state.ts` writes, declared again here: the engine lists the state
// a module reads only from an atom made in that module, and its source scan
// needs the plugin and key written as literals here. Keep them equal to
// `threadsAtom` there; the shape tag is shared.
const shownThreads = atom({ plugin: 'loose-ends', key: 'threads' } as const, [], {
  shape: THREADS_ATOM_SHAPE,
})

// The open thread tie and drop act on; 0 is none picked, which means the
// oldest. A picked thread that closes falls back to the oldest too.
const pickedId = atom({ plugin: 'loose-ends', key: 'picked' } as const, 0)

// The thread a first drop press armed; a second press on the same thread
// drops it. 0 is none armed. Picking a row or pressing tie disarms it.
const armedDrop = atom({ plugin: 'loose-ends', key: 'dropArmed' } as const, 0)

// Set when the person closes the pane by hand, so this session stops opening
// it on its own; `/threads` clears it.
const isDismissed = atom({ plugin: 'loose-ends', key: 'paneDismissed' } as const, false)

const TONE_COLOR: Readonly<Record<AgeTone, Color>> = {
  fresh: 'success',
  aging: 'warning',
  stale: 'error',
}

/** The colour of a card or label with nothing to grade. */
const QUIET: Color = 'subtle'

// Column widths of a thread row, in cells: the pick mark, `#12`, the gap
// before the bar, the bar, the right-aligned age.
const MARK_COLUMNS = 2
const ID_COLUMNS = 5
const GAP_COLUMNS = 1
const AGE_COLUMNS = 6
const ROW_FIXED = MARK_COLUMNS + ID_COLUMNS + GAP_COLUMNS + AGE_BAR_CELLS + AGE_COLUMNS

/** A settled row's `✓ #12` column. */
const SETTLED_ID_COLUMNS = MARK_COLUMNS + ID_COLUMNS

/** A card's round border and its one-cell padding, both sides. */
const CARD_FRAME = 4

/** Narrowest a label column gets; a narrower pane cuts the row instead. */
const MIN_LABEL = 8

/** Open rows an inline pane shows before `+N more`. */
const INLINE_ROWS = 3

/** Settled threads a docked pane lists. */
const SETTLED_SHOWS = 5

/** What a press does to the picked thread: what `/tie` or `/drop` does. */
type Act = 'tie' | 'drop'

/** The threads to draw, or none when the read fails (logged). */
async function readShown($: EngineInterface): Promise<readonly Thread[]> {
  try {
    return await read($, shownThreads)
  } catch (error) {
    logDebug($, `loose-ends: pane read failed: ${describeError(error)}`)

    return []
  }
}

/** The picked id, or 0 (none) when the read fails (logged). */
async function readPicked($: EngineInterface): Promise<number> {
  try {
    return await read($, pickedId)
  } catch (error) {
    logDebug($, `loose-ends: pane read failed: ${describeError(error)}`)

    return 0
  }
}

/** The armed id, or 0 (none) when the read fails (logged). */
async function readArmed($: EngineInterface): Promise<number> {
  try {
    return await read($, armedDrop)
  } catch (error) {
    logDebug($, `loose-ends: pane read failed: ${describeError(error)}`)

    return 0
  }
}

/** Arms drop on thread `id` (0 disarms); a failed write is logged. */
async function arm($: EngineInterface, id: number): Promise<void> {
  try {
    await update($, armedDrop, () => id)
  } catch (error) {
    logDebug($, `loose-ends: drop arm failed: ${describeError(error)}`)
  }
}

/** Picks thread `id` for tie and drop, and disarms drop; a failed write is logged. */
async function pick($: EngineInterface, id: number): Promise<void> {
  await arm($, 0)
  try {
    await update($, pickedId, () => id)
  } catch (error) {
    logDebug($, `loose-ends: pick failed: ${describeError(error)}`)
  }
}

/**
 * A drop press: the first on a thread arms it, the second drops it. `isArmed`
 * is what the drawn pane showed, so a press always does what its label said.
 */
async function pressDrop($: EngineInterface, id: number, isArmed: boolean): Promise<void> {
  if (isArmed) {
    await act($, 'drop', id)
  } else {
    await arm($, id)
  }
}

/** Runs tie or drop on thread `id` and toasts what it answered. Never throws. */
async function act($: EngineInterface, kind: Act, id: number): Promise<void> {
  await arm($, 0)
  // The commands never throw: a failure is their one-line answer.
  const answer: CommandAnswer =
    kind === 'tie' ? await tieCommand($, String(id)) : await dropCommand($, String(id))

  try {
    $.ui.toast(answer.text)
  } catch (error) {
    logDebug($, `loose-ends: toast failed: ${describeError(error)}`)
  }
}

/**
 * Opens the pane. Asked (`/threads`), it takes the keyboard and is placed at
 * any width, and the person's earlier close is forgotten. Unasked, it opens
 * only while something is open and the person has not closed it by hand this
 * session; the engine docks it from 144 columns and holds it back below.
 * Answers whether it is drawn. Never throws.
 */
export async function openPane($: EngineInterface, isAsked: boolean): Promise<boolean> {
  try {
    if (isAsked) {
      await update($, isDismissed, () => false)
    } else {
      const isQuiet =
        (await read($, isDismissed)) || openThreads(await read($, shownThreads)).length === 0

      if (isQuiet) {
        return false
      }
    }

    const opened = await $.ui.open({
      id: PANE_ID,
      title: PANE_TITLE,
      ...(isAsked ? { focus: true as const } : {}),
    })

    return opened.isPlaced
  } catch (error) {
    logDebug($, `loose-ends: pane open failed: ${describeError(error)}`)

    return false
  }
}

/**
 * The pane's own close button: some hosts (Orca) take the engine's close mark
 * and ctrl+x for themselves. Counts as the person's close, so this session
 * stops opening it unasked until `/threads`. Never throws.
 */
async function closePane($: EngineInterface): Promise<void> {
  try {
    await update($, isDismissed, () => true)
    await $.ui.close({ id: PANE_ID })
  } catch (error) {
    logDebug($, `loose-ends: pane close failed: ${describeError(error)}`)
  }
}

/** Remembers a close by the person's own hand. Never throws. */
export async function noteClose($: EngineInterface, e: PaneCloseInput): Promise<void> {
  if (e.id !== PANE_ID || e.origin.kind !== 'person') {
    return
  }

  try {
    await update($, isDismissed, () => true)
  } catch (error) {
    logDebug($, `loose-ends: pane close failed: ${describeError(error)}`)
  }
}

/** `label → note` cut to `columns`: the label part and the note part. */
const settledParts = (
  thread: ClosedThread,
  columns: number,
): { label: string; note: string } => {
  const label = fitColumns(thread.text, columns)
  const rest = columns - Array.from(label).length
  const note = thread.note === undefined ? '' : ` → ${thread.note}`

  return { label, note: padColumns(note, rest) }
}

/**
 * The pane: open threads with an age bar, oldest first, and tie and drop for
 * the picked one; docked, a header and the latest settled threads too.
 * Reading the threads atom subscribes it, so every write redraws it.
 */
export async function drawPane(
  $: EngineInterface,
  e: RenderInput<'Pane'>,
): Promise<RenderElement> {
  const { Box, Button, Text } = $.ui.resolve(e)
  const threads = await readShown($)
  const picked = await readPicked($)
  const armed = await readArmed($)
  const nowMs = await $.clock.now()
  const isDocked = e.props.placement === 'dock'
  const open = openThreads(threads)
  const target = open.find(one => one.id === picked) ?? open[0]
  const oldest = open[0]
  const isArmed = target !== undefined && armed === target.id
  const cardColor = oldest === undefined ? QUIET : TONE_COLOR[ageTone(ageDays(oldest.openedAt, nowMs))]
  const inner = Math.max(0, e.props.bodyColumns - (isDocked ? CARD_FRAME : 0))
  const labelColumns = Math.max(MIN_LABEL, inner - ROW_FIXED)
  const rows = isDocked ? open : open.slice(0, INLINE_ROWS)
  const hidden = open.length - rows.length
  const settled = isDocked ? recentClosed(threads, SETTLED_SHOWS) : []
  const settledCount = threads.filter(isClosed).length
  const settledColumns = Math.max(MIN_LABEL, inner - SETTLED_ID_COLUMNS - AGE_COLUMNS)

  const openRows = rows.map(one => {
    const days = ageDays(one.openedAt, nowMs)
    const tone = TONE_COLOR[ageTone(days)]
    const isTarget = one.id === target?.id

    return (
      <Button key={`thread-${one.id}`} plain onPress={() => void pick($, one.id)}>
        <Text color={tone}>{isTarget ? '› ' : '  '}</Text>
        <Text color={tone}>{padColumns(`#${one.id}`, ID_COLUMNS)}</Text>
        <Text bold={isTarget}>{padColumns(one.text, labelColumns)}</Text>
        <Text>{' '.repeat(GAP_COLUMNS)}</Text>
        <Text color={tone}>{ageBar(days)}</Text>
        <Text dimColor>{padStartColumns(ageText(days), AGE_COLUMNS)}</Text>
      </Button>
    )
  })

  const openBody = (
    <Box flexDirection="column">
      <Box justifyContent="space-between">
        <Text bold color={cardColor}>
          OPEN
        </Text>
        <Text dimColor>{open.length === 1 ? '1 thread' : `${open.length} threads`}</Text>
      </Box>
      {open.length === 0 && <Text dimColor>Nothing open.</Text>}
      {openRows}
      {hidden > 0 && <Text dimColor>{`  +${hidden} more · /threads`}</Text>}
      <Box gap={2}>
        {target !== undefined && (
          <Button
            key="tie"
            plain
            hotkey="t"
            label={`tie #${target.id}`}
            onPress={() => void act($, 'tie', target.id)}
          />
        )}
        {target !== undefined && (
          <Button
            key="drop"
            plain
            hotkey="d"
            label={isArmed ? `drop #${target.id}? d again` : `drop #${target.id}`}
            onPress={() => void pressDrop($, target.id, isArmed)}
          />
        )}
        <Button key="hide" plain hotkey="x" label="close" onPress={() => void closePane($)} />
        {!e.props.isFocused && <Text dimColor>click to use</Text>}
      </Box>
    </Box>
  )

  if (!isDocked) {
    return openBody
  }

  return (
    <Box flexDirection="column" gap={1}>
      <Box flexDirection="column" alignItems="center">
        <Box>
          <Text bold color="claude">
            LOOSE ENDS
          </Text>
          <Text dimColor> · </Text>
          <Text bold>{`${open.length} OPEN`}</Text>
          <Text dimColor>{` · ${settledCount} SETTLED`}</Text>
        </Box>
        <Box gap={2}>
          <Text>
            <Text color={TONE_COLOR.fresh}>■</Text>
            <Text dimColor> fresh</Text>
          </Text>
          <Text>
            <Text color={TONE_COLOR.aging}>■</Text>
            <Text dimColor> aging</Text>
          </Text>
          <Text>
            <Text color={TONE_COLOR.stale}>■</Text>
            <Text dimColor> stale</Text>
          </Text>
        </Box>
      </Box>
      {/* A column, like the settled card, so the body stretches to the
          card's width and its title row spreads. */}
      <Box flexDirection="column" borderStyle="round" borderColor={cardColor} paddingX={1}>
        {openBody}
      </Box>
      {settled.length > 0 && (
        <Box flexDirection="column" borderStyle="round" borderColor={QUIET} paddingX={1}>
          <Box justifyContent="space-between">
            <Text bold color={QUIET}>
              SETTLED
            </Text>
            <Text dimColor>latest {settled.length}</Text>
          </Box>
          {settled.map(one => {
            const { label, note } = settledParts(one, settledColumns)

            return (
              <Box key={`settled-${one.id}`}>
                <Text color={TONE_COLOR.fresh}>{padColumns(`✓ #${one.id}`, SETTLED_ID_COLUMNS)}</Text>
                <Text dimColor>{label}</Text>
                <Text>{note}</Text>
                <Text dimColor>{padStartColumns(ageText(ageDays(one.closedAt, nowMs)), AGE_COLUMNS)}</Text>
              </Box>
            )
          })}
        </Box>
      )}
    </Box>
  )
}
