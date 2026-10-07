/**
 * dsh-std host facet entry, referenced by `dsh-plugin.json` → facets.host.entry.
 *
 * Contract evidence (@dsh-std@2c131ba): the adapter imports this module, takes
 * `namespace.default ?? namespace.facet`, and asserts `typeof activate === 'function'`,
 * so a plain object is a conforming facet module — no @dsh-std/sdk runtime dependency.
 *
 * What this facet can and cannot do today — measured, not assumed (T13, 2026-10-07):
 * a std `ActivationContext` carries { identity, plan, scope, protocols, extensions }.
 * `scope` is a `CleanupScope` (see @dsh-std/lifecycle), and no member of the context
 * exposes the product's services. The notification engine needs exactly those: spawn a
 * player process, observe agent turns, register a settings route. dsh-std currently
 * defines no protocol for host-side side effects, and reaching into the adapter for its
 * own product context would be an undeclared private API (ADR 0001 §7.5). An earlier
 * revision of this file passed `context.scope` straight to the engine and took the whole
 * boot down with `TypeError: ctx.get is not a function` — that is why the guard below is
 * load-bearing and why this module must never throw.
 *
 * This module deliberately imports no product package, so a host that has never heard of
 * DeepSeek Harness can still load it and read an honest diagnosis.
 */
import { activateHost, deactivateHost, hostSnapshot } from './activate.mjs'

/** Why a std host cannot run the notification engine today. */
export const MISSING_HOST_CAPABILITY =
  'dsh-std defines no protocol for the host-side side effects this engine needs ' +
  '(process spawn for playback, agent-turn events, an HTTP route for the settings page); ' +
  'install the bundle entry on a DSH host instead'

let gapReason = null
/** Whether THIS facet started the engine; deactivation must not touch another channel's run. */
let startedByFacet = false

/** Whether `candidate` is a product context this engine can actually run on. */
function isProductContext(candidate) {
  return Boolean(candidate)
    && typeof candidate.get === 'function'
    && typeof candidate.on === 'function'
    && typeof candidate.effect === 'function'
}

/**
 * Standard facet activation.
 *
 * @param context - the std ActivationContext handed over by the host adapter.
 */
export async function activate(context) {
  // `context.scope` is a CleanupScope, not a product context. A host that ever passes
  // something runnable gets the engine; every other host gets one diagnosis line.
  // Neither path throws: a facet failure must never fail the host's boot.
  const candidate = context?.scope ?? context
  if (!isProductContext(candidate)) {
    gapReason = MISSING_HOST_CAPABILITY
    startedByFacet = false
    console.error(`[dsh-perlica-ding] ${MISSING_HOST_CAPABILITY}`)
    return
  }
  startedByFacet = true
  await activateHost(candidate, undefined, { channel: 'std' })
}

/** Standard facet deactivation: tear down only what this facet started. */
export async function deactivate(reason) {
  gapReason = null
  if (!startedByFacet) return
  startedByFacet = false
  await deactivateHost(reason)
}

/**
 * Facet projection for the host's component inventory: the component counts as active
 * whenever *either* channel runs the engine, and as degraded with a reason when this
 * facet is the only one a host could have run.
 */
export function snapshot() {
  const live = hostSnapshot()
  if (live.state === 'active') return live
  return { state: 'degraded', message: gapReason ?? MISSING_HOST_CAPABILITY }
}

export default { activate, deactivate, snapshot }
