/**
 * PCM gain scaling: rescale a WAV file's samples instead of touching system
 * volume, so the plugin needs no audio toolchain and no OS-level side effect.
 *
 * Cache identity is a **content digest** (sha256 of the file bytes, truncated)
 * plus the volume — not `basename + size`. The old key silently served the
 * wrong audio whenever two same-named, same-length sources existed (T3 K7), and
 * it survived a source swap that happened to keep the byte length.
 *
 * Writes land through a temporary file plus `rename`, so a concurrent play can
 * never observe a half-written cache entry (T3 N15). Failing to write the cache
 * is not fatal: the freshly scaled buffer is used for this play only.
 *
 * Supported formats: PCM 8/16/24/32-bit and IEEE float 32-bit, including
 * `WAVE_FORMAT_EXTENSIBLE`-wrapped PCM. Everything else returns the original
 * path unchanged (BC7: a non-PCM source keeps its own level, and the caller has
 * nothing else to fall back to).
 *
 * Frozen contract: `docs/adr/0001-persistence-seam.md` §5,
 * `docs/workstreams/03-plugin-audit.md` BC7 + K7/N15.
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { clampVolume, DEFAULT_VOLUME } from './volume.mjs'

/** Cache directory for volume-scaled copies, per platform temp dir. */
export const DEFAULT_CACHE_DIR = join(tmpdir(), 'dsh-perlica-ding')

/** Digest prefix length used in a cache key; 16 hex chars of sha256. */
const DIGEST_CHARS = 16

/** `WAVE_FORMAT_EXTENSIBLE`: the real format is in the sub-format GUID. */
const FORMAT_EXTENSIBLE = 0xfffe

/** File-system operations, injectable so the module is unit-testable in memory. */
const defaultIo = {
  exists: (path) => existsSync(path),
  readFile: (path) => readFileSync(path),
  writeFile: (path, data) => writeFileSync(path, data),
  rename: (from, to) => renameSync(from, to),
  mkdir: (path) => mkdirSync(path, { recursive: true }),
}

/**
 * Content digest of one WAV buffer, as used in cache keys.
 * @param buf File bytes.
 * @returns First 16 hex characters of the sha256 digest.
 */
export function contentDigest(buf) {
  return createHash('sha256').update(buf).digest('hex').slice(0, DIGEST_CHARS)
}

/**
 * Cache file name for one source buffer at one volume.
 * @param buf Source file bytes.
 * @param volume Scaled volume in percent.
 * @returns A stable file name; equal inputs always yield an equal name.
 */
export function cacheKeyFor(buf, volume) {
  return `snd-${contentDigest(buf)}-v${volume}.wav`
}

/**
 * Locate the PCM `data` chunk and describe the encoding.
 * @param buf Whole WAV file bytes.
 * @returns `null` when the file is not a readable PCM/float WAVE buffer.
 */
function parseWav(buf) {
  if (buf.length < 44) return null
  if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') return null
  let offset = 12
  let audioFormat = 0
  let bitsPerSample = 0
  let dataOffset = -1
  let dataSize = 0
  while (offset + 8 <= buf.length) {
    const id = buf.toString('ascii', offset, offset + 4)
    const chunkSize = buf.readUInt32LE(offset + 4)
    const body = offset + 8
    if (id === 'fmt ' && chunkSize >= 16) {
      audioFormat = buf.readUInt16LE(body)
      bitsPerSample = buf.readUInt16LE(body + 14)
      if (audioFormat === FORMAT_EXTENSIBLE && chunkSize >= 40 && buf.readUInt16LE(body + 24) === 1) {
        audioFormat = 1
      }
    } else if (id === 'data') {
      dataOffset = body
      dataSize = Math.min(chunkSize, buf.length - body)
    }
    if (dataOffset >= 0 && bitsPerSample > 0) break
    // Chunk sizes are attacker-ish input: stop instead of walking off the buffer.
    if (body + chunkSize <= body) return null
    offset = body + chunkSize + (chunkSize % 2)
  }
  if (dataOffset < 0 || dataSize <= 0) return null
  return { audioFormat, bitsPerSample, dataOffset, dataSize }
}

/**
 * Scale `buf` in place by `gain`.
 * @param buf Mutable copy of the source bytes.
 * @param encoding Result of {@link parseWav}.
 * @param gain Linear gain, already validated.
 * @returns `false` when the encoding is outside the supported set.
 */
function applyGain(buf, encoding, gain) {
  const { audioFormat, bitsPerSample, dataOffset, dataSize } = encoding
  if (audioFormat === 1 && bitsPerSample === 16) {
    for (let i = 0; i + 1 < dataSize; i += 2) {
      const pos = dataOffset + i
      const v = Math.round(buf.readInt16LE(pos) * gain)
      buf.writeInt16LE(v > 32767 ? 32767 : v < -32768 ? -32768 : v, pos)
    }
    return true
  }
  if (audioFormat === 1 && bitsPerSample === 8) {
    // 8-bit PCM is unsigned with a 128 midpoint.
    for (let i = 0; i < dataSize; i++) {
      const pos = dataOffset + i
      const v = Math.round((buf.readUInt8(pos) - 128) * gain + 128)
      buf.writeUInt8(v > 255 ? 255 : v < 0 ? 0 : v, pos)
    }
    return true
  }
  if (audioFormat === 1 && bitsPerSample === 24) {
    for (let i = 0; i + 2 < dataSize; i += 3) {
      const pos = dataOffset + i
      let v = Math.round(buf.readIntLE(pos, 3) * gain)
      if (v > 8388607) v = 8388607
      else if (v < -8388608) v = -8388608
      buf.writeIntLE(v, pos, 3)
    }
    return true
  }
  if (audioFormat === 1 && bitsPerSample === 32) {
    for (let i = 0; i + 3 < dataSize; i += 4) {
      const pos = dataOffset + i
      const scaled = Math.round(buf.readInt32LE(pos) * gain)
      buf.writeInt32LE(scaled > 2147483647 ? 2147483647 : scaled < -2147483648 ? -2147483648 : scaled, pos)
    }
    return true
  }
  if (audioFormat === 3 && bitsPerSample === 32) {
    for (let i = 0; i + 3 < dataSize; i += 4) {
      const pos = dataOffset + i
      // Float samples are already normalized to [-1, 1]; clamp instead of wrapping.
      const v = Math.max(-1, Math.min(1, buf.readFloatLE(pos) * gain))
      buf.writeFloatLE(v, pos)
    }
    return true
  }
  return false
}

/**
 * Scale a WAV file's PCM samples by `volume` percent.
 *
 * @param srcPath Source audio path.
 * @param volume Target volume in percent; invalid values fall back to 100 (BC7).
 * @param options Optional seam overrides.
 * @param options.cacheDir Directory for scaled copies; defaults to the OS temp dir.
 * @param options.io File-system operations; defaults to `node:fs`.
 * @returns Path of a playable file — a cached scaled copy, the just-scaled
 *   buffer written to a unique temp path, or `srcPath` when nothing was scaled.
 */
export function scaleWavVolume(srcPath, volume, options = {}) {
  const target = clampVolume(volume)
  // 100 (and any rounding of it) is a no-op: never pay for a byte-identical copy.
  if (target === DEFAULT_VOLUME) return srcPath

  const io = { ...defaultIo, ...options.io }
  const cacheDir = options.cacheDir ?? DEFAULT_CACHE_DIR

  let buf
  try {
    buf = io.readFile(srcPath)
  } catch {
    return srcPath
  }

  const encoding = parseWav(buf)
  if (encoding === null) return srcPath

  const gain = target / DEFAULT_VOLUME
  const scaled = Buffer.from(buf)
  if (!applyGain(scaled, encoding, gain)) return srcPath

  const cached = join(cacheDir, cacheKeyFor(buf, target))
  try {
    if (io.exists(cached)) return cached
  } catch {
    /* an unreadable cache dir just means we skip the cache */
  }

  const temp = `${cached}.tmp-${process.pid}-${Date.now()}`
  try {
    io.mkdir(cacheDir)
    io.writeFile(temp, scaled)
    io.rename(temp, cached)
    return cached
  } catch {
    // Caching is an optimization: play the scaled bytes even if they cannot be kept.
    return temp
  }
}
