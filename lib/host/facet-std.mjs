/**
 * dsh-std host facet entry, referenced by `dsh-plugin.json` → facets.host.entry.
 *
 * Contract evidence (@dsh-std@2c131ba, packages/adapter-dsh/src/index.ts): the
 * adapter imports this module and takes `namespace.default ?? namespace.facet`,
 * then asserts `typeof activate === 'function'`. A plain object is therefore a
 * conforming facet module — this package does not need @dsh-std/sdk at runtime,
 * which keeps the native channel dependency-free.
 *
 * The facet shares the activation token with the native entry, so a DSH profile
 * that loads both channels plays and writes exactly once (ADR 0001 §3.1/§4.1).
 */
import { activateHost, deactivateHost, hostSnapshot } from './activate.mjs'
import { resolveConfig } from './config.mjs'

export async function activate(context) {
  const ctx = context?.scope ?? context
  if (ctx === undefined || ctx === null) throw new Error('dsh-perlica-ding: the std facet needs an activation scope')
  activateHost(ctx, resolveConfig(undefined), { channel: 'std' })
}

export async function deactivate(reason) {
  await deactivateHost(reason)
}

export function snapshot() {
  return hostSnapshot()
}

export default { activate, deactivate, snapshot }
