/**
 * The four-kind decision: which sound (if any) one session event earns.
 *
 * This module is the whole "what should happen" half of the plugin, separated
 * from "how to make it happen" (playback) and from the harness (events,
 * services, files). It therefore imports no harness package, touches no file
 * system, and reads no clock except through an injected `now`.
 *
 * Per-agent turn state is a **flag, not a timestamp**: `claim` opens a turn and
 * clears the flag, `toolResult` raises it, `turnStopping` reads it. The old
 * implementation compared wall-clock timestamps (`Date.now()` against the
 * event payload), which misattributes work whenever two turns of one agent
 * overlap (T3 N3). A boolean cannot drift like that.
 *
 * Plan mode is resolved by the caller and handed in as `{ planActive }`; when
 * the caller cannot read it, it folds the session event log — that fallback
 * belongs to the harness, not here (T3 N4, fixed at the call site).
 *
 * **Debounce ownership.** This module answers *which* kind a turn earns;
 * `lib/host/engine.mjs` answers *whether* it may play now, and owns the
 * per-kind debounce window (BC4). `debounceMs`/`now` stay in this signature for
 * callers that want the rate limit decided alongside the kind, but the default
 * is `0` — disabled — so the engine's window is never narrowed by a second,
 * separately-clocked one (T3 §C.1: one policy owner).
 *
 * Frozen contract: `docs/adr/0001-persistence-seam.md` §5,
 * `docs/workstreams/03-plugin-audit.md` BC1/BC2/BC4/BC5 + K5/N2/N3.
 */
import { isExecutionTool } from './exec-tools.mjs'

/** Minimum gap between two plays of the same kind, in ms (BC4). */
export const DEFAULT_DEBOUNCE_MS = 2500

/**
 * Build the event-to-kind decider.
 *
 * `isRoot` is the single injected policy: given an agent id it answers whether
 * that agent is the main conversation (BC5). It is a function, not a predicate
 * over a structure, so this module needs no harness types. The **default
 * refuses everything** — an undecidable agent must stay silent, because a
 * subagent beeping violates the documented contract while a missed main-turn
 * sound only costs one notification (T3 K5: the old code returned `true` here).
 *
 * @param options Decision inputs.
 * @param options.isRoot Predicate: main-conversation agent? Defaults to refusing.
 * @param options.execTools Execution whitelist; `[]` means every tool counts (BC3).
 * @param options.debounceMs Per-kind minimum gap in ms; `0` leaves rate limiting
 *   to the engine (the default wiring).
 * @param options.now Clock in ms; injectable so tests need no real time.
 * @returns The decider.
 */
export function createDecider({ isRoot, execTools, debounceMs, now = () => Date.now() }) {
  const rootOf = typeof isRoot === 'function' ? isRoot : () => false
  // 0 disables this window; anything unusable is treated as disabled rather
  // than silently replaced by a default the caller did not ask for.
  const window = typeof debounceMs === 'number' && Number.isFinite(debounceMs) && debounceMs > 0
    ? debounceMs
    : 0
  const lastPlayed = new Map()
  const turns = new Map()

  /** Consume one kind's debounce window; `force` (preview) skips it. */
  const allow = (kind, force) => {
    if (force) return true
    if (window === 0) return true
    const stamp = now()
    const previous = lastPlayed.get(kind)
    if (previous !== undefined && stamp - previous < window) return false
    lastPlayed.set(kind, stamp)
    return true
  }

  return {
    /**
     * Open a turn for one agent: the claim event is the only pointer to "this
     * turn's work", so it resets the execution marker.
     * @param agentId Agent whose inbox was claimed.
     */
    claim(agentId) {
      turns.set(agentId, { executed: false, toolCount: 0, lastTool: null })
    },

    /**
     * Record one completed tool call. A non-root agent is ignored outright
     * (subagents do not drive notification).
     * @param agentId Agent that ran the tool.
     * @param toolName Tool name from `tools/result`.
     */
    toolResult(agentId, toolName) {
      if (!rootOf(agentId)) return
      let turn = turns.get(agentId)
      if (turn === undefined) {
        // Defensive: a turn we never saw claimed still counts its work rather
        // than losing it, so an early tool result cannot silence the turn.
        turn = { executed: false, toolCount: 0, lastTool: null }
        turns.set(agentId, turn)
      }
      if (!isExecutionTool(toolName, execTools)) return
      turn.executed = true
      turn.toolCount += 1
      turn.lastTool = toolName
    },

    /**
     * Close a turn and decide its sound.
     * @param agentId Agent whose turn is stopping.
     * @param context Plan-mode state for this agent, already resolved by the caller.
     * @param context.planActive Whether plan mode is active for the turn.
     * @returns `'plan'`, `'done'`, or `null` for silence.
     */
    turnStopping(agentId, { planActive } = {}) {
      const turn = turns.get(agentId)
      if (!rootOf(agentId)) return null
      if (planActive === true && allow('plan', false)) return 'plan'
      if (turn?.executed === true && allow('done', false)) return 'done'
      return null
    },

    /**
     * A question reached the user (ask_user_question or an approval request).
     * Root-gated like every other kind: a subagent's question is not the main
     * conversation asking for input (T3 N2).
     * @param agentId Agent that raised the question, when the caller knows it.
     * @returns `'ask'`, or `null` for silence.
     */
    ask(agentId) {
      if (agentId !== undefined && !rootOf(agentId)) return null
      return allow('ask', false) ? 'ask' : null
    },

    /**
     * The conversation errored.
     * @param agentId Agent that errored, when the caller knows it.
     * @returns `'fail'`, or `null` for silence.
     */
    error(agentId) {
      if (agentId !== undefined && !rootOf(agentId)) return null
      return allow('fail', false) ? 'fail' : null
    },

    /**
     * Read-only view of one agent's open turn; for diagnostics and tests.
     * @param agentId Agent to inspect.
     * @returns A copy of the turn marker, or `null` when no turn is open.
     */
    state(agentId) {
      const turn = turns.get(agentId)
      return turn === undefined ? null : { ...turn }
    },
  }
}
