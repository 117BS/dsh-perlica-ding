/**
 * Plugin configuration (schemastery), used by the native channel.
 *
 * The key set is frozen: enabled / volume / debounceMs / soundDir / execTools.
 * ADR 0001 §4.3 — renaming any of them breaks existing user configuration.
 *
 * The default values live in lib/core/defaults.mjs, shared with the std facet,
 * which has no schema to resolve through schemastery.
 */
import z from '@deepseek-ai/schemastery'
import { CONFIG_DEFAULTS } from '../core/defaults.mjs'

export const Config = z.object({
  /** Master switch; false silences every kind. */
  enabled: z.boolean().default(CONFIG_DEFAULTS.enabled),
  /** Minimum gap in ms between two plays of the SAME kind. */
  debounceMs: z.number().min(100).max(60000).default(CONFIG_DEFAULTS.debounceMs),
  /**
   * Directory holding plan.wav / done.wav / ask.wav / fail.wav.
   * Empty falls back to the session workspace, then to the bundled sounds.
   */
  soundDir: z.string().default(CONFIG_DEFAULTS.soundDir),
  /**
   * Initial playback volume in percent when no persisted value exists.
   * The persisted value (std LocalStorage, the host storage domain, or the state
   * file) wins once the user changes it.
   */
  volume: z.number().min(0).max(100).default(CONFIG_DEFAULTS.volume),
  /**
   * Tool names that count as executing a task. An empty array counts every tool
   * (legacy behavior). See lib/core/exec-tools.mjs for the default set.
   */
  execTools: z.array(z.string()).default(CONFIG_DEFAULTS.execTools),
})

/** Resolve defaults for a channel that has no Loader-supplied config. */
export function resolveConfig(raw) {
  return Config(raw ?? {})
}
