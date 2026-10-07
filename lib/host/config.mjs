/**
 * Plugin configuration (schemastery), shared by both host channels.
 *
 * The key set is frozen: enabled / volume / debounceMs / soundDir / execTools.
 * ADR 0001 §4.3 — renaming any of them breaks existing user configuration.
 */
import z from '@deepseek-ai/schemastery'
import { DEFAULT_EXEC_TOOLS } from '../core/exec-tools.mjs'

export const Config = z.object({
  /** Master switch; false silences every kind. */
  enabled: z.boolean().default(true),
  /** Minimum gap in ms between two plays of the SAME kind. */
  debounceMs: z.number().min(100).max(60000).default(2500),
  /**
   * Directory holding plan.wav / done.wav / ask.wav / fail.wav.
   * Empty falls back to the session workspace, then to the bundled sounds.
   */
  soundDir: z.string().default(''),
  /**
   * Initial playback volume in percent when no persisted value exists.
   * The persisted value (storage domain, std LocalStorage, or the state file)
   * wins once the user changes it.
   */
  volume: z.number().min(0).max(100).default(100),
  /**
   * Tool names that count as executing a task. An empty array counts every tool
   * (legacy behavior). See lib/core/exec-tools.mjs for the default set.
   */
  execTools: z.array(z.string()).default(DEFAULT_EXEC_TOOLS),
})

/** Resolve defaults for a channel that has no Loader-supplied config (the std facet). */
export function resolveConfig(raw) {
  return Config(raw ?? {})
}
