/**
 * The single source of truth for plugin configuration defaults.
 *
 * Two callers must agree on these values: the schemastery `Config` the native
 * channel resolves (lib/host/config.mjs) and the std facet, which has no schema
 * to resolve and therefore merges these defaults itself (lib/host/activate.mjs).
 * Keeping them in one dependency-free module makes drift structurally impossible;
 * this file must stay free of imports beyond the execution-tool list.
 */
import { DEFAULT_EXEC_TOOLS } from './exec-tools.mjs'

export const CONFIG_DEFAULTS = Object.freeze({
  /** Master switch; false silences every kind. */
  enabled: true,
  /** Minimum gap in ms between two plays of the SAME kind. */
  debounceMs: 2500,
  /** Directory holding plan.wav / done.wav / ask.wav / fail.wav; empty = session workspace. */
  soundDir: '',
  /** Initial playback volume in percent when no value has been persisted yet. */
  volume: 100,
  /** Tool names that count as executing a task; an empty array counts every tool. */
  execTools: DEFAULT_EXEC_TOOLS,
})
