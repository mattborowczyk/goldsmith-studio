import { afterEach, describe, expect, it, vi } from 'vitest'
import { requestPersistentStorage } from './db'

/** Swap navigator.storage for the duration of one assertion. */
function withStorage(storage: unknown, fn: () => Promise<void>) {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'navigator')
  Object.defineProperty(globalThis.navigator, 'storage', {
    value: storage,
    configurable: true,
  })
  return fn().finally(() => {
    if (original) Object.defineProperty(globalThis, 'navigator', original)
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
