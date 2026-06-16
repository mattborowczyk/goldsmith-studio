import { afterEach, describe, expect, it, vi } from 'vitest'
import { fetchSpotPricesPerGram } from './spotPrices'

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('market-price fetch timeouts', () => {
  it('caps each request with an 8s abort signal', async () => {
    const timeoutSpy = vi.spyOn(AbortSignal, 'timeout')
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: true, json: async () => ({ price: 6000 }) })),
    )

    // USD avoids the FX hop, so every call is a spot-price request.
    await fetchSpotPricesPerGram('USD')

    expect(timeoutSpy).toHaveBeenCalledWith(8000)
    const calls = vi.mocked(fetch).mock.calls
    expect(calls.length).toBeGreaterThan(0)
    for (const [, init] of calls) {
      expect(init?.signal).toBeInstanceOf(AbortSignal)
    }
  })

  it('falls back to the graceful error when every request times out', async () => {
    // Drive the abort manually so the test never waits the real 8s.
    const controller = new AbortController()
    vi.spyOn(AbortSignal, 'timeout').mockReturnValue(controller.signal)
    vi.stubGlobal(
      'fetch',
      vi.fn(
        (_url: string, init?: RequestInit) =>
          new Promise((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () =>
              reject(new DOMException('The operation timed out.', 'TimeoutError')),
            )
          }),
      ),
    )

    const pending = fetchSpotPricesPerGram('USD')
    controller.abort(new DOMException('The operation timed out.', 'TimeoutError'))

    await expect(pending).rejects.toThrow(/Could not fetch market prices/)
  })

  it('rejects when the FX request times out', async () => {
    const controller = new AbortController()
    vi.spyOn(AbortSignal, 'timeout').mockReturnValue(controller.signal)
    vi.stubGlobal(
      'fetch',
      vi.fn(
        (_url: string, init?: RequestInit) =>
          new Promise((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () =>
              reject(new DOMException('The operation timed out.', 'TimeoutError')),
            )
          }),
      ),
    )

    // Non-USD currency forces an FX lookup before any spot request runs.
    const pending = fetchSpotPricesPerGram('EUR')
    controller.abort(new DOMException('The operation timed out.', 'TimeoutError'))

    await expect(pending).rejects.toThrow()
  })
})
