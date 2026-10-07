/**
 * The volume model: 0..100 integers, presets, and the two normalizers the rest
 * of the plugin is allowed to use.
 *
 * Two entry points on purpose — the seam decides the failure mode:
 *   - `normalizeVolume` is the *validating* seam: a write path (settings UI,
 *     config import) must fail loudly rather than store a wrong value.
 *   - `clampVolume` is the *tolerant* seam: a read/paint path must never throw
 *     on a corrupt stored value, so it falls back to the default (100).
 *
 * Frozen contract: `docs/adr/0001-persistence-seam.md` §5/§6 (out-of-range and
 * non-numeric values), `docs/workstreams/03-plugin-audit.md` BC7 + §6 row
 * "volume 越界/非数".
 */

/** Playback volumes offered as one-click presets in the settings page. */
export const VOLUME_PRESETS = [
  { value: 100, label: '原声' },
  { value: 60, label: '适中' },
  { value: 30, label: '轻声' },
  { value: 0, label: '静音' },
]

/** Lowest accepted volume. */
export const MIN_VOLUME = 0
/** Highest accepted volume. */
export const MAX_VOLUME = 100
/** Volume assumed for every invalid or missing value on a tolerant read. */
export const DEFAULT_VOLUME = 100

/**
 * Validate one volume, returning it as a 0..100 integer.
 *
 * Numbers are rounded and clamped into range. Booleans, numeric strings, `null`,
 * `undefined` and non-finite numbers are rejected: a stored audio level has no
 * sensible coercion for them, and silently accepting one would let a caller
 * write a value it never meant. `-5` normalizes to 0 (a valid mute), it is not
 * an error — range repair belongs here so no caller has to repeat it.
 *
 * @param value Candidate volume, in percent.
 * @returns Integer in [0, 100].
 * @throws {TypeError} when `value` is not a finite number.
 */
export function normalizeVolume(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new TypeError(`volume must be a finite number, got ${String(value)}`)
  }
  return Math.max(MIN_VOLUME, Math.min(MAX_VOLUME, Math.round(value)))
}

/**
 * Coerce a possibly-corrupt value into a usable volume. Never throws.
 *
 * @param value Candidate volume; anything unusable falls back to {@link DEFAULT_VOLUME}.
 * @returns Integer in [0, 100].
 */
export function clampVolume(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return DEFAULT_VOLUME
  return Math.max(MIN_VOLUME, Math.min(MAX_VOLUME, Math.round(value)))
}
