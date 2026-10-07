/**
 * VolumeStore tests.
 *
 * The seam under test is persistence itself, so the two mandatory cases run
 * against the real filesystem (ADR §7.1 — a mocked seam proves nothing):
 *
 *   - a P3 write/read round trip observed on disk, and again through a fresh
 *     provider instance (the closest in-process proxy for a restart), and
 *   - a real damaged document, asserting the `.corrupt-<ts>` preservation.
 *
 * Providers injected as fakes are not a mocked seam: `providers` IS the
 * store's injection point, so a fake provider exercises the real selector,
 * the real stickiness rule, and the real write-error propagation.
 *
 * `node --test tests/store.test.mjs`, from the repository root.
 */

import assert from 'node:assert/strict'
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'

import { createVolumeStore, dshStorageDomainProvider, fileStoreProvider } from '../lib/host/store.mjs'

/** Expected failures log by design; keep the run's output readable. */
const quiet = { warn() {}, error() {} }

const STATE_FILE = 'state.json'

/**
 * Build a fake tier that records how often each entry point ran.
 *
 * @param kind - Tier name reported back through `source`/`kind`.
 * @param options - Availability, seed value, and an optional write failure.
 * @returns The provider descriptor plus its call ledger.
 */
function fakeTier(kind, { available = true, initial = null, writeError = null } = {}) {
  const calls = { available: 0, open: 0, read: 0, write: 0, close: 0 }
  const box = { value: initial }
  let alive = available
  return {
    kind,
    calls,
    box,
    /** Flip availability between reads to prove the selection is sticky. */
    setAvailable(next) {
      alive = next
    },
    async available() {
      calls.available += 1
      return alive
    },
    async open() {
      calls.open += 1
      return {
        async read() {
          calls.read += 1
          return box.value
        },
        async write(volume) {
          calls.write += 1
          if (writeError) throw writeError
          box.value = volume
        },
        async close() {
          calls.close += 1
        },
      }
    },
  }
}

/** @returns A real, empty temporary directory. */
async function tempDir(label) {
  return await mkdtemp(join(tmpdir(), `perlica-${label}-`))
}

/** @returns The `.corrupt-*` siblings of `state.json`. */
async function corruptSiblings(directory) {
  const entries = await readdir(directory)
  return entries.filter(name => name.startsWith(`${STATE_FILE}.corrupt-`))
}

describe('tier selection', () => {
  it('P1 wins over P2 and the loser is never opened', async () => {
    const p1 = fakeTier('P1', { initial: 22 })
    const p2 = fakeTier('P2', { initial: 77 })
    const store = createVolumeStore({ providers: [p1, p2], logger: quiet })

    assert.deepEqual(await store.read(), { volume: 22, source: 'P1' })
    assert.equal(p2.calls.open, 0, 'P2 must not be opened once P1 has won')

    assert.deepEqual(await store.write(41), { ok: true, source: 'P1' })
    assert.equal(p2.calls.write, 0)
    assert.deepEqual(await store.read(), { volume: 41, source: 'P1' })
  })

  it('falls to P2 when P1 reports unavailable', async () => {
    const p1 = fakeTier('P1', { available: false })
    const p2 = fakeTier('P2', { initial: 33 })
    const store = createVolumeStore({ providers: [p1, p2], logger: quiet })

    assert.deepEqual(await store.read(), { volume: 33, source: 'P2' })
    assert.equal(p1.calls.open, 0, 'an unavailable tier is never opened')
  })

  it('keeps the chosen tier even after a better one becomes available', async () => {
    const p1 = fakeTier('P1', { initial: 11 })
    const p2 = fakeTier('P2', { initial: 66 })
    const store = createVolumeStore({ providers: [p1, p2], logger: quiet })

    assert.equal((await store.read()).source, 'P1')
    p1.setAvailable(false)
    assert.equal((await store.read()).source, 'P1', 'selection is fixed, not re-evaluated per read')
    assert.equal(p1.calls.open, 1, 'the winning tier opened exactly once')
    assert.equal(p2.calls.open, 0)
  })

  it('reports the default when no tier is available', async () => {
    const p1 = fakeTier('P1', { available: false })
    const p2 = fakeTier('P2', { available: false })
    const store = createVolumeStore({ providers: [p1, p2], logger: quiet })

    assert.deepEqual(await store.read(), { volume: 100, source: 'default' })
    assert.deepEqual(store.capabilities(), { persistent: false, kind: 'none' })
  })

  it('reports the default for an empty provider list', async () => {
    const store = createVolumeStore({ providers: [], logger: quiet })
    assert.deepEqual(await store.read(), { volume: 100, source: 'default' })
    assert.deepEqual(store.capabilities(), { persistent: false, kind: 'none' })
  })

  it('throws from write when no tier could be opened', async () => {
    const p1 = fakeTier('P1', { available: false })
    const store = createVolumeStore({ providers: [p1], logger: quiet })

    await assert.rejects(() => store.write(50), /no volume store is available/)
  })

  it('degrades once when a tier throws from open, and never retries it', async () => {
    const directory = await tempDir('degrade')
    const broken = {
      kind: 'P1',
      async available() {
        return true
      },
      async open() {
        broken.openCount += 1
        throw new Error('tier exploded')
      },
      openCount: 0,
    }
    const store = createVolumeStore({
      providers: [broken, fileStoreProvider({ stateDir: directory })],
      logger: quiet,
    })

    // An empty tier reports where the VALUE came from (the fallback), while
    // capabilities reports where a WRITE would go. Conflating the two made the
    // assembly layer discard the configured volume (defect D1).
    assert.deepEqual(await store.read(), { volume: 100, source: 'default' })
    assert.deepEqual(store.capabilities(), { persistent: true, kind: 'P3' })
    assert.equal(broken.openCount, 1, 'a failed tier is recorded once, not retried per read')
    await store.read()
    assert.equal(broken.openCount, 1)

    await store.dispose()
    await rm(directory, { recursive: true, force: true })
  })

  it('reports capabilities as the selected tier after a write', async () => {
    const p1 = fakeTier('P1')
    const store = createVolumeStore({ providers: [p1], logger: quiet })

    assert.deepEqual(store.capabilities(), { persistent: false, kind: 'none' }, 'nothing is selected yet')
    await store.write(9)
    assert.deepEqual(store.capabilities(), { persistent: true, kind: 'P1' })
  })

  it('closes the winning handle on dispose and refuses later writes', async () => {
    const p1 = fakeTier('P1')
    const store = createVolumeStore({ providers: [p1], logger: quiet })

    await store.read()
    await store.dispose()
    assert.equal(p1.calls.close, 1)
    assert.deepEqual(store.capabilities(), { persistent: false, kind: 'none' })
    await assert.rejects(() => store.write(10), /disposed/)
    await store.dispose()
    assert.equal(p1.calls.close, 1, 'dispose is idempotent')
  })
})

describe('P3 tier on the real filesystem', () => {
  it('round-trips through a real file and survives a fresh provider instance', async () => {
    const directory = await tempDir('roundtrip')
    const file = join(directory, STATE_FILE)

    const first = createVolumeStore({ providers: [fileStoreProvider({ stateDir: directory })], logger: quiet })
    assert.deepEqual(await first.read(), { volume: 100, source: 'default' }, 'no document yet, so no value came from this tier')
    assert.deepEqual(await first.write(37), { ok: true, source: 'P3' })

    // The bytes are on the medium, not in the process.
    const onDisk = JSON.parse(await readFile(file, 'utf8'))
    assert.equal(onDisk.volume, 37)
    assert.ok(!Number.isNaN(Date.parse(onDisk.updatedAt)), `updatedAt must be an ISO timestamp, got ${onDisk.updatedAt}`)
    await first.dispose()

    // A different provider over the same directory is the restart proxy.
    const second = createVolumeStore({ providers: [fileStoreProvider({ stateDir: directory })], logger: quiet })
    assert.deepEqual(await second.read(), { volume: 37, source: 'P3' })
    assert.deepEqual(second.capabilities(), { persistent: true, kind: 'P3' })
    await second.dispose()
    await rm(directory, { recursive: true, force: true })
  })

  it('leaves no temporary file behind after a write', async () => {
    const directory = await tempDir('atomic')
    const store = createVolumeStore({ providers: [fileStoreProvider({ stateDir: directory })], logger: quiet })

    await store.write(12)
    const leftovers = (await readdir(directory)).filter(name => name.endsWith('.tmp'))
    assert.deepEqual(leftovers, [], 'the temp file is always renamed or removed')

    await store.dispose()
    await rm(directory, { recursive: true, force: true })
  })

  it('quarantines a document that is not valid JSON', async () => {
    const directory = await tempDir('corrupt-json')
    const file = join(directory, STATE_FILE)
    const garbage = '{"volume": 55,,,'
    await writeFile(file, garbage, 'utf8')

    const store = createVolumeStore({ providers: [fileStoreProvider({ stateDir: directory })], logger: quiet })
    assert.deepEqual(await store.read(), { volume: 100, source: 'default' }, 'a damaged document reads as no value')

    const quarantined = await corruptSiblings(directory)
    assert.equal(quarantined.length, 1, 'the damaged document is preserved exactly once')
    assert.equal(await readFile(join(directory, quarantined[0]), 'utf8'), garbage, 'the original bytes survive')
    await assert.rejects(() => readFile(file, 'utf8'), { code: 'ENOENT' }, 'the damaged name is released')

    await store.dispose()
    await rm(directory, { recursive: true, force: true })
  })

  it('quarantines a document whose volume is not a number', async () => {
    const directory = await tempDir('corrupt-value')
    const file = join(directory, STATE_FILE)
    const original = '{"volume":"loud","updatedAt":"2026-01-01T00:00:00.000Z"}'
    await writeFile(file, original, 'utf8')

    const store = createVolumeStore({ providers: [fileStoreProvider({ stateDir: directory })], logger: quiet })
    assert.deepEqual(await store.read(), { volume: 100, source: 'default' })

    const quarantined = await corruptSiblings(directory)
    assert.equal(quarantined.length, 1)
    assert.equal(await readFile(join(directory, quarantined[0]), 'utf8'), original)

    await store.dispose()
    await rm(directory, { recursive: true, force: true })
  })

  it('keeps a valid object that simply has no volume key', async () => {
    const directory = await tempDir('shape')
    await writeFile(join(directory, STATE_FILE), '{"somethingElse":1}', 'utf8')

    const store = createVolumeStore({ providers: [fileStoreProvider({ stateDir: directory })], logger: quiet })
    assert.deepEqual(await store.read(), { volume: 100, source: 'default' })
    assert.deepEqual(await corruptSiblings(directory), [], 'nothing is lost, so nothing is quarantined')

    await store.dispose()
    await rm(directory, { recursive: true, force: true })
  })

  it('clamps every stored value into 0..100 integers', async () => {
    const directory = await tempDir('clamp')
    const file = join(directory, STATE_FILE)
    const store = createVolumeStore({ providers: [fileStoreProvider({ stateDir: directory })], logger: quiet })

    await store.write(150)
    assert.equal(JSON.parse(await readFile(file, 'utf8')).volume, 100)

    await store.write(-5)
    assert.equal(JSON.parse(await readFile(file, 'utf8')).volume, 0)

    await store.write(63.4)
    const stored = JSON.parse(await readFile(file, 'utf8')).volume
    assert.ok(Number.isInteger(stored) && stored >= 0 && stored <= 100, `stored value must stay an integer in range, got ${stored}`)

    await store.dispose()
    await rm(directory, { recursive: true, force: true })
  })

  it('rejects a non-finite volume instead of storing it', async () => {
    const directory = await tempDir('nonfinite')
    const store = createVolumeStore({ providers: [fileStoreProvider({ stateDir: directory })], logger: quiet })

    await assert.rejects(() => store.write(Number.NaN), TypeError)
    await assert.rejects(() => store.write(Number.POSITIVE_INFINITY), TypeError)
    await assert.rejects(() => store.write('loud'), TypeError)
    assert.deepEqual(await readdir(directory), [], 'nothing was written')

    await store.dispose()
    await rm(directory, { recursive: true, force: true })
  })

  it('propagates a real write failure from the medium', async () => {
    const directory = await tempDir('writefail')
    const store = createVolumeStore({ providers: [fileStoreProvider({ stateDir: directory })], logger: quiet })

    assert.deepEqual(await store.read(), { volume: 100, source: 'default' }, 'nothing is stored yet')
    assert.deepEqual(store.capabilities(), { persistent: true, kind: 'P3' }, 'this read selects and opens P3')

    // Replace the state directory with a regular file: the temp write can no
    // longer land, which is a genuine medium failure rather than a mock.
    await rm(directory, { recursive: true, force: true })
    await writeFile(directory, 'not a directory', 'utf8')

    await assert.rejects(() => store.write(50), 'a failed write must reach the caller (ADR §6)')
    assert.deepEqual(store.capabilities(), { persistent: true, kind: 'P3' }, 'the tier stays selected; only the write failed')

    await store.dispose()
    await rm(directory, { force: true })
  })
})

describe('P2 provider', () => {
  it('rejects when storageDomain never arrives, without hanging', async () => {
    const ctx = {
      get() {
        return undefined
      },
      inject() {
        return () => {}
      },
    }
    await assert.rejects(() => dshStorageDomainProvider(ctx).open(), /storageDomain/)
  })

  it('rejects when the host refuses the domain as already open', async () => {
    const ctx = {
      get() {
        return {
          async open() {
            const error = new Error("domain 'perlica_ding' is already open")
            error.code = 'already-open'
            throw error
          },
        }
      },
    }
    await assert.rejects(() => dshStorageDomainProvider(ctx).open())
  })

  it('is not selected when the context cannot resolve services at all', async () => {
    const store = createVolumeStore({ providers: [dshStorageDomainProvider(undefined)], logger: quiet })
    assert.deepEqual(await store.read(), { volume: 100, source: 'default' })
    assert.deepEqual(store.capabilities(), { persistent: false, kind: 'none' })
  })
})
