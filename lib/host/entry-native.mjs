/**
 * Native channel entry: the package's Cordis plugin, loaded by the DSH Loader
 * through `dsh.bundle.patch` (cordis.patch.yml → the `dsh-perlica-ding` row).
 *
 * This channel is the live one on every DSH deployment. The dsh-std facet
 * (lib/host/facet-std.mjs) shares the same activation and yields to whichever
 * channel claims the activation token first — see ADR 0001 §4.1.
 */
import { activateHost } from './activate.mjs'
import { Config } from './config.mjs'

export { Config }

/** Cordis plugin name (Loader entry id). */
export const name = 'dsh-perlica-ding'

/** Hard dependency: the subprocess seam used to play sounds. */
export const inject = ['subprocess']

export function apply(ctx, config) {
  return activateHost(ctx, Config(config ?? {}), { channel: 'native' })
}
