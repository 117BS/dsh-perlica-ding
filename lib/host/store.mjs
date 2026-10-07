/**
 * VolumeStore — the plugin's single persistence seam.
 *
 * The store owns three ordered tiers and picks exactly one of them, once:
 *
 *   P1  a std-host provider injected by the caller (see docs/adr/0001 §4.2)
 *   P2  the host's own `ctx.storageDomain` data form
 *   P3  this plugin's own JSON file under `$DSH_HOME/dsh-perlica-ding/`
 *
 * The selection is *fixed* after it succeeds: every later read and write goes
 * to the tier that opened first, so a transient failure never migrates the
 * value to another medium mid-process.
 *
 * Two rules from the ADR are load-bearing here and are deliberately NOT
 * softened:
 *
 *   - `write()` MUST throw when the value could not be stored. The settings
 *     UI keys its "saved" state off the resolved promise, so a swallowed
 *     error would report success for a write that never landed (ADR §6).
 *   - A damaged P3 document is moved aside as `state.json.corrupt-<ts>`
 *     before the read falls back to the default, so a corrupt file is never
 *     silently overwritten (ADR §6).
 *
 * `lib/core/volume.mjs` is the only relative dependency: the 0..100 integer
 * model, its default, and the validating/tolerant split all live there and are
 * not restated here.
 *
 * Ordering note for callers: `capabilities()` is synchronous and reports the
 * tier that has already been selected, so prime the store with one
 * `await read()` before publishing capabilities to a UI.
 *
 * `read().source` and `capabilities().kind` answer two different questions and
 * must not be conflated:
 *
 *   - `read().source` is the origin of the RETURNED VALUE: the tier's key when
 *     a stored value was found, `'default'` when the tier holds nothing or the
 *     read failed. Reporting the tier for an empty store made the assembly
 *     layer treat the model default as a persisted user value and discard the
 *     configured `volume` entirely.
 *   - `capabilities().kind` is the SELECTED TIER, i.e. where a write would go.
 *     It stays the tier even while an empty store serves the default.
 *
 * @module dsh-perlica-ding/lib/host/store
 */

import { access, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { DEFAULT_VOLUME, clampVolume, normalizeVolume } from '../core/volume.mjs'

/** P3 directory under the harness home. */
const STATE_DIR_NAME = 'dsh-perlica-ding'

/** P3 document name. */
const STATE_FILE_NAME = 'state.json'

/** P2 domain identity. Must match `/^[a-z][a-z0-9_]*$/` (no hyphens). */
const DOMAIN_NAME = 'perlica_ding'

/** P2 table and record key holding the volume. */
const DOMAIN_TABLE = 'settings'
const VOLUME_KEY = 'volume'
const DOMAIN_VERSION = 1

/**
 * How long P2 waits for `storageDomain` to appear before giving up.
 *
 * `ctx.inject` fires whenever the service activates, which may be after this
 * plugin's `apply`. The wait is bounded so a host without the service degrades
 * to P3 instead of hanging the plugin's startup forever.
 */
const FACILITY_WAIT_MS = 1000

/**
 * Write one diagnostic line through a console-shaped sink.
 *
 * @param logger - Object exposing `warn`/`error`; `console` when omitted.
 * @param level - `'warn'` for a degradation, `'error'` for a failed operation.
 * @param message - Message without the plugin prefix.
 * @param detail - Optional error or value appended as a second argument.
 */
function emit(logger, level, message, detail) {
  const sink = logger && typeof logger[level] === 'function' ? logger[level] : null
  if (!sink) return
  const line = `[dsh-perlica-ding] ${message}`
  if (detail === undefined) sink.call(logger, line)
  else sink.call(logger, line, detail)
}

/** @returns Whether the path exists. */
async function exists(path) {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

/**
 * Create the ordered, sticky tier selector over the supplied providers.
 *
 * @param options - Store options.
 * @param options.providers - Ordered `{ kind, available, open }` descriptors;
 *   earlier entries win. A rejected `available()`/`open()` moves to the next.
 * @param options.logger - Console-shaped sink; defaults to `console`.
 * @returns The volume store described by ADR §5.
 */
export function createVolumeStore({ providers, logger = console } = {}) {
  const candidates = Array.isArray(providers)
    ? providers.filter(provider => provider && typeof provider.open === 'function')
    : []
  /** The tier that won selection; `null` until one opens, or after dispose. */
  let active = null
  /** One in-flight selection shared by every concurrent caller. */
  let selection = null
  let disposed = false

  const warn = (message, detail) => emit(logger, 'warn', message, detail)
  const fail = (message, detail) => emit(logger, 'error', message, detail)

  /**
   * Run selection once. The resulting promise is memoized, so a failing tier
   * is reported exactly one time and the chain is never re-walked.
   *
   * @returns The winning `{ kind, handle }`, or `null` when no tier opened.
   */
  function select() {
    if (selection) return selection
    selection = (async () => {
      for (const provider of candidates) {
        try {
          if (typeof provider.available === 'function' && !(await provider.available())) continue
          const handle = await provider.open()
          if (!handle || typeof handle.read !== 'function' || typeof handle.write !== 'function') {
            warn(`volume store '${provider.kind}' returned an unusable handle; falling back`)
            continue
          }
          active = { kind: provider.kind, handle }
          return active
        } catch (error) {
          // ADR §6: log once, drop to the next tier, never retry this process.
          warn(`volume store '${provider.kind}' is unavailable; falling back`, error)
        }
      }
      return null
    })()
    return selection
  }

  async function read() {
    const store = disposed ? null : await select()
    if (!store) return { volume: clampVolume(DEFAULT_VOLUME), source: 'default' }
    try {
      const stored = await store.handle.read()
      if (typeof stored === 'number' && Number.isFinite(stored)) {
        return { volume: clampVolume(stored), source: store.kind }
      }
      return { volume: clampVolume(DEFAULT_VOLUME), source: 'default' }
    } catch (error) {
      fail(`volume store '${store.kind}' read failed; serving the default`, error)
      return { volume: clampVolume(DEFAULT_VOLUME), source: 'default' }
    }
  }

  async function write(volume) {
    const next = normalizeVolume(volume)
    if (disposed) throw new Error('[dsh-perlica-ding] volume store is disposed')
    const store = await select()
    if (!store) throw new Error('[dsh-perlica-ding] no volume store is available to persist to')
    // Deliberately uncaught: a rejected write must reach the caller (ADR §6).
    await store.handle.write(next)
    return { ok: true, source: store.kind }
  }

  function capabilities() {
    if (disposed || !active) return { persistent: false, kind: 'none' }
    return { persistent: true, kind: active.kind }
  }

  async function dispose() {
    if (disposed) return
    disposed = true
    const store = active
    active = null
    selection = null
    if (!store) return
    try {
      if (typeof store.handle.close === 'function') await store.handle.close()
    } catch (error) {
      fail(`volume store '${store.kind}' close failed`, error)
    }
  }

  return { read, write, capabilities, dispose }
}

/**
 * Resolve `ctx.storageDomain`, waiting briefly when it activates later.
 *
 * @param ctx - Cordis context of the calling plugin.
 * @returns The domain facility.
 * @throws {Error} When the service is absent after {@link FACILITY_WAIT_MS}.
 */
function acquireFacility(ctx) {
  const present = ctx && typeof ctx.get === 'function' ? ctx.get('storageDomain') : undefined
  if (present) return Promise.resolve(present)
  if (!ctx || typeof ctx.inject !== 'function') {
    return Promise.reject(new Error('[dsh-perlica-ding] ctx.inject is unavailable; cannot wait for storageDomain'))
  }
  return new Promise((resolve, reject) => {
    let settled = false
    let unregister = null
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      if (typeof unregister === 'function') {
        try {
          unregister()
        } catch {
          // The registration is already gone; nothing to release.
        }
      }
      reject(new Error(`[dsh-perlica-ding] storageDomain was not provided within ${FACILITY_WAIT_MS}ms`))
    }, FACILITY_WAIT_MS)
    const settleReject = error => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(error)
    }
    try {
      unregister = ctx.inject(['storageDomain'], scope => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve(scope.storageDomain)
      })
    } catch (error) {
      settleReject(error)
    }
  })
}

/**
 * P2: persist the volume through the host's own `storageDomain` data form.
 *
 * Both packages are imported dynamically inside `open()`. A static import
 * would turn a missing package into a module-load failure for the whole
 * plugin, which is exactly the "hard require" the ADR forbids.
 *
 * @param ctx - Cordis context of the calling plugin.
 * @returns The P2 provider descriptor.
 */
export function dshStorageDomainProvider(ctx) {
  return {
    kind: 'P2',
    async available() {
      // Presence is settled by open(): the service may activate after this
      // plugin's apply, and only open() can afford to wait for it.
      return !!ctx && typeof ctx.get === 'function'
    },
    async open() {
      // The facility is acquired first on purpose: without it the two imports
      // below are useless, and this ordering makes "the host never offered the
      // service" a deterministic, package-independent failure.
      const facility = await acquireFacility(ctx)
      const { defineDomain, domainTable } = await import('@deepseek-ai/dsh-storage-domain')
      const { z } = await import('zod')
      const spec = defineDomain({
        name: DOMAIN_NAME,
        version: DOMAIN_VERSION,
        invalidRecords: 'backup-and-skip',
        tables: {
          [DOMAIN_TABLE]: domainTable(z.object({ volume: z.number().int().min(0).max(100) })),
        },
      })
      let domain
      try {
        domain = await facility.open(spec)
      } catch (error) {
        if (error && error.code === 'already-open') {
          emit(console, 'warn', `storageDomain already holds domain '${DOMAIN_NAME}'; falling back`, error)
        }
        throw error
      }
      const table = domain.table(DOMAIN_TABLE)
      return {
        async read() {
          const record = table.get(VOLUME_KEY)
          const value = record && typeof record === 'object' ? record.volume : undefined
          return typeof value === 'number' && Number.isFinite(value) ? value : null
        },
        async write(volume) {
          await table.put(VOLUME_KEY, { volume })
        },
        async close() {
          if (typeof domain.close === 'function') await domain.close()
        },
      }
    },
  }
}

/**
 * Resolve the P3 directory: `$DSH_HOME/dsh-perlica-ding`.
 *
 * @returns The absolute state directory.
 */
function defaultStateDir() {
  const home = process.env.DSH_HOME || join(homedir(), '.dsh')
  return join(home, STATE_DIR_NAME)
}

/**
 * Move a damaged document aside so the next write cannot destroy it.
 *
 * @param file - The damaged document path.
 * @param reason - Human-readable diagnosis for the log line.
 * @throws {Error} When the document cannot be preserved.
 */
async function quarantine(file, reason) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  let target = `${file}.corrupt-${stamp}`
  for (let attempt = 1; attempt < 1000; attempt += 1) {
    if (!(await exists(target))) break
    target = `${file}.corrupt-${stamp}-${attempt}`
  }
  try {
    await rename(file, target)
    emit(console, 'warn', `volume state file was ${reason}; kept as ${basename(target)} and continuing without a stored value`)
  } catch (error) {
    emit(console, 'error', 'volume state file could not be quarantined; refusing to overwrite it', error)
    throw error
  }
}

/**
 * Read the stored volume from one document.
 *
 * Damage boundary: unparsable text, a non-object root, and a non-numeric
 * `volume` are all quarantined. An object with no `volume` key at all is read
 * as "no value" without quarantine — there is nothing to preserve, and the
 * shape may belong to a future version.
 *
 * @param file - Document path.
 * @returns The stored value, or `null` when none is usable.
 */
async function readState(file) {
  let text
  try {
    text = await readFile(file, 'utf8')
  } catch (error) {
    if (error && error.code === 'ENOENT') return null
    throw error
  }
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    await quarantine(file, 'not valid JSON')
    return null
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    await quarantine(file, 'not a JSON object')
    return null
  }
  if (!Object.hasOwn(parsed, 'volume')) return null
  const value = parsed.volume
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    await quarantine(file, `carrying a non-numeric volume (${JSON.stringify(value)})`)
    return null
  }
  return value
}

/**
 * Durably write the volume: temp file in the same directory, then rename.
 *
 * @param file - Document path.
 * @param volume - Clamped 0..100 integer.
 */
async function writeState(file, volume) {
  const directory = dirname(file)
  const temp = join(directory, `.${basename(file)}.${process.pid}.${Date.now().toString(36)}.tmp`)
  const body = `${JSON.stringify({ volume, updatedAt: new Date().toISOString() }, null, 2)}\n`
  await writeFile(temp, body, 'utf8')
  try {
    await rename(temp, file)
  } catch (error) {
    try {
      await rm(temp, { force: true })
    } catch {
      // The temp file is disposable either way.
    }
    throw error
  }
}

/**
 * P3: persist the volume in this plugin's own JSON document.
 *
 * This tier has no host dependency at all, which is the entire reason it
 * exists: it is the floor the seam degrades to.
 *
 * @param options - Provider options.
 * @param options.stateDir - Explicit state directory; `$DSH_HOME/dsh-perlica-ding` when omitted.
 * @returns The P3 provider descriptor.
 */
export function fileStoreProvider({ stateDir } = {}) {
  return {
    kind: 'P3',
    async available() {
      return true
    },
    async open() {
      const directory = stateDir || defaultStateDir()
      const file = join(directory, STATE_FILE_NAME)
      // A failing mkdir rejects the open, which is how the store reports a
      // tier it cannot use instead of writing somewhere unexpected.
      await mkdir(directory, { recursive: true })
      return {
        async read() {
          return readState(file)
        },
        async write(volume) {
          await writeState(file, volume)
        },
        async close() {
          // Every operation carries its own handle; there is nothing resident.
        },
      }
    },
  }
}
