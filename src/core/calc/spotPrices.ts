/**
 * "Refresh from market" (plan §2.4): free, key-less public APIs called straight
 * from the browser — gold-api.com for spot prices (USD/oz), frankfurter.dev
 * (ECB) for currency conversion. Failures must degrade gracefully to the last
 * manually-saved prices; callers catch and show the error.
 */
import type { SpotMetal } from './materials'

export const CURRENCIES = ['USD', 'EUR', 'GBP', 'PLN', 'CHF'] as const
export type Currency = (typeof CURRENCIES)[number]

const SYMBOL: Record<SpotMetal, string> = {
  gold: 'XAU',
  silver: 'XAG',
  platinum: 'XPT',
  palladium: 'XPD',
}

const TROY_OUNCE_GRAMS = 31.1034768

/**
 * Pure-metal spot prices per gram in `currency`. Metals that fail individually
 * are omitted; throws only when nothing could be fetched.
 */
export async function fetchSpotPricesPerGram(
  currency: Currency,
): Promise<Partial<Record<SpotMetal, number>>> {
  const fx = currency === 'USD' ? 1 : await fetchUsdRate(currency)
  const metals = Object.keys(SYMBOL) as SpotMetal[]
  const results = await Promise.allSettled(
    metals.map(async (metal) => {
      const res = await fetch(`https://api.gold-api.com/price/${SYMBOL[metal]}`)
      if (!res.ok) throw new Error(`${SYMBOL[metal]}: HTTP ${res.status}`)
      const json = (await res.json()) as { price: number }
      if (typeof json.price !== 'number' || !(json.price > 0)) {
        throw new Error(`${SYMBOL[metal]}: bad payload`)
      }
      return [metal, (json.price / TROY_OUNCE_GRAMS) * fx] as const
    }),
  )
  const out: Partial<Record<SpotMetal, number>> = {}
  for (const r of results) if (r.status === 'fulfilled') out[r.value[0]] = r.value[1]
  if (Object.keys(out).length === 0) {
    throw new Error('Could not fetch market prices — check your connection.')
  }
  return out
}

async function fetchUsdRate(currency: Currency): Promise<number> {
  const res = await fetch(`https://api.frankfurter.dev/v1/latest?base=USD&symbols=${currency}`)
  if (!res.ok) throw new Error(`FX rates: HTTP ${res.status}`)
  const json = (await res.json()) as { rates?: Record<string, number> }
  const rate = json.rates?.[currency]
  if (!rate) throw new Error(`No FX rate for ${currency}`)
  return rate
}
