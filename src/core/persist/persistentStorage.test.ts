import { afterEach, describe, expect, it, vi } from 'vitest'
import { estimateStorage, requestPersistentStorage } from './db'

/** Swap navigator.storage for the duration of one assertion. */
function withStorage(storage: unknown, fn: () => Promise<void>) {
  const nav = globalThis.navigator as { storage?: unknown }
  const originalStorage = Object.getOwnPropertyDescriptor(nav, 'storage')
  Object.defineProperty(nav, 'storage', { value: storage, configurable: true })
  return fn().finally(() => {
    if (originalStorage) Object.defineProperty(nav, 'storage', originalStorage)
    else delete nav.storage
  })
}

describe('requestPersistentStorage', () => {
  afterEach(() => vi.restoreAllMocks())

  it('returns null when the StorageManager API is unavailable', async () => {
    await withStorage({}, async () => {
      expect(await requestPersistentStorage()).toBeNull()
    })
  })

  it('short-circuits to true when already persisted (no second request)', async () => {
    const persist = vi.fn()
    await withStorage({ persisted: () => Promise.resolve(true), persist }, async () => {
      expect(await requestPersistentStorage()).toBe(true)
      expect(persist).not.toHaveBeenCalled()
    })
  })

  it('requests persistence and returns the grant result when not yet persisted', async () => {
    await withStorage(
      { persisted: () => Promise.resolve(false), persist: () => Promise.resolve(true) },
      async () => {
        expect(await requestPersistentStorage()).toBe(true)
      },
    )
    await withStorage(
      { persisted: () => Promise.resolve(false), persist: () => Promise.resolve(false) },
      async () => {
        expect(await requestPersistentStorage()).toBe(false)
      },
    )
  })

  it('swallows a throwing StorageManager and returns null', async () => {
    await withStorage(
      {
        persisted: () => Promise.resolve(false),
        persist: () => Promise.reject(new Error('boom')),
      },
      async () => {
        expect(await requestPersistentStorage()).toBeNull()
      },
    )
  })
})

describe('estimateStorage', () => {
  afterEach(() => vi.restoreAllMocks())

  it('returns null when the StorageManager API is unavailable', async () => {
    await withStorage({}, async () => {
      expect(await estimateStorage()).toBeNull()
    })
  })

  it('returns usage/quota when the browser reports them', async () => {
    await withStorage(
      { estimate: () => Promise.resolve({ usage: 1_200_000_000, quota: 4_000_000_000 }) },
      async () => {
        expect(await estimateStorage()).toEqual({ usage: 1_200_000_000, quota: 4_000_000_000 })
      },
    )
  })

  it('returns null for an unusable (zero/undefined quota) reading', async () => {
    await withStorage({ estimate: () => Promise.resolve({ usage: 0, quota: 0 }) }, async () => {
      expect(await estimateStorage()).toBeNull()
    })
    await withStorage({ estimate: () => Promise.resolve({ usage: 5 }) }, async () => {
      expect(await estimateStorage()).toBeNull()
    })
    await withStorage(
      { estimate: () => Promise.resolve({ usage: -1, quota: 4_000_000_000 }) },
      async () => {
        expect(await estimateStorage()).toBeNull()
      },
    )
    await withStorage(
      { estimate: () => Promise.resolve({ usage: NaN, quota: Infinity }) },
      async () => {
        expect(await estimateStorage()).toBeNull()
      },
    )
  })

  it('swallows a throwing StorageManager and returns null', async () => {
    await withStorage({ estimate: () => Promise.reject(new Error('boom')) }, async () => {
      expect(await estimateStorage()).toBeNull()
    })
  })
})
