import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import {
  dropCommand,
  parkCommand,
  registerCommands,
  threadsCommand,
  tieCommand,
} from './commands'
import { PANE_ID, drawPane, noteClose, openPane } from './pane'
import { withRule } from './rule'
import { REFRESH_MS, describeError, logDebug, safeRefresh, sweep } from './state'
import { close, list, park, registerTools } from './tools'

// Whether this load's `session.start` registered park, close and list. The
// rule names those tools, so `prompt.compose` adds it only once they are
// registered. It starts false: the engine awaits the first `session.start`
// before the first prompt (so the first compose already sees it set), and a
// compose that runs before any start, or after a failed registration, sends
// no rule rather than one naming tools the model cannot call. Kept in `$.state`
// rather than a module variable so it outlives a hot reload, and declared here
// because only the module that declares an atom may read or update it.
const toolsReady = atom({ plugin: 'loose-ends', key: 'toolsReady' } as const, false)

/** Says in the debug log what failed during start; never throws. */
function logFailure($: EngineInterface, step: string, error: unknown): void {
  logDebug($, `loose-ends: ${step} failed: ${describeError(error)}`)
}

/** Records whether the tools are registered; a failed write is logged. */
async function setToolsReady($: EngineInterface, isReady: boolean): Promise<void> {
  try {
    await update($, toolsReady, () => isReady)
  } catch (error) {
    logFailure($, 'recording tool registration', error)
  }
}

/** Whether the tools are registered; unknown reads as not, and is logged. */
async function areToolsReady($: EngineInterface): Promise<boolean> {
  try {
    return await read($, toolsReady)
  } catch (error) {
    logFailure($, 'reading tool registration', error)

    return false
  }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    try {
      await registerTools($)
      await setToolsReady($, true)
    } catch (error) {
      // Without its tools the list still loads for the band and commands,
      // and the rule is left out of the system prompt.
      logFailure($, 'tool registration', error)
      await setToolsReady($, false)
    }
    try {
      await registerCommands($)
    } catch (error) {
      // Without its commands the tools and the band still work.
      logFailure($, 'command registration', error)
    }
    try {
      await sweep($, await $.clock.now())
    } catch (error) {
      // A failed sweep leaves old lists for the next start.
      logFailure($, 'sweep', error)
    }
    // Logs its own failure to the debug log.
    await safeRefresh($)
    // Opens the pane on its own while something is open; never throws. An
    // open the engine holds back (a narrow terminal) resolves at once,
    // undrawn, so awaiting it does not hold the start.
    await openPane($, false)
    try {
      $.clock.every(REFRESH_MS, () => safeRefresh($))
    } catch (error) {
      // Without the timer another session's changes show only after this
      // session's own writes; the start still completes.
      logFailure($, 'refresh timer', error)
    }

    return next(e)
  })

  // Each tool hook answers its own tool and never throws: a failure is a
  // one-line deny the model reads as an error. Matchers stay literal so
  // validate can name them.
  on('tool.call', { tool: 'mcp__loose-ends__park' }, async ($, e) => {
    const answer = await park($, e)

    if ('result' in answer) {
      // Something is open now: show the pane unless the person closed it.
      await openPane($, false)
    }

    return answer
  })
  on('tool.call', { tool: 'mcp__loose-ends__close' }, ($, e) => close($, e))
  on('tool.call', { tool: 'mcp__loose-ends__list' }, $ => list($))

  // Each command hook answers its own command (it never reads `next`) and
  // never throws: a failure is a one-line answer.
  on('command.run', { command: 'park' }, ($, e) => parkCommand($, e.args))
  // /threads opens the pane; where no surface draws it, the list as text.
  on('command.run', { command: 'threads' }, async $ =>
    (await openPane($, true)) ? { text: 'Opened the loose ends pane.' } : threadsCommand($),
  )
  on('command.run', { command: 'tie' }, ($, e) => tieCommand($, e.args))
  on('command.run', { command: 'drop' }, ($, e) => dropCommand($, e.args))

  // The rule goes last, after every section beneath, which pass unchanged;
  // it is left out while the tools it names are not registered.
  on('prompt.compose', async ($, e, next) => {
    const composed = await next(e)

    return (await areToolsReady($)) ? withRule(composed) : composed
  })

  // The pane: docked beside the transcript in fullscreen, inline above the
  // prompt elsewhere. The status line (set by every write and refresh) says
  // the count where the pane is not drawn.
  on('ui.render', { component: 'Pane', requestId: 'loose-ends' }, ($, e) => drawPane($, e))

  // A close by the person's hand stops this session reopening it unasked.
  on('ui.close', async ($, e, next) => {
    if (e.id === PANE_ID) {
      await noteClose($, e)
    }

    return next(e)
  })
}
