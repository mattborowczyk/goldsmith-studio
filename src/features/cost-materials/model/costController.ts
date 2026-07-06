import { saveFile } from '@/app/files'
import {
  applySpotPrices,
  costOf,
  defaultMaterials,
  historyToCSV,
  weightGrams,
  type HistoryEntry,
  type Material,
} from '@/core/calc/materials'
import { fetchSpotPricesPerGram, type Currency } from '@/core/calc/spotPrices'
import { getEngine, guardWrite, requireSelection } from '@/core/controller/context'
import { volumeAndArea } from '@/core/geometry/measure'
import {
  addHistoryEntries,
  clearHistoryStore,
  deleteHistoryEntry,
  kvGet,
  kvSet,
  loadHistory,
  loadMaterials,
  saveMaterials,
} from '@/core/persist/db'
import { useAppStore, type CostSettings } from '@/store/appStore'

const KV_COST_SETTINGS = 'costSettings'
const KV_ASSIGNMENTS = 'partMaterials'
const KV_MEASURE_COLOR = 'measureColor'

export async function initCostData() {
  const store = useAppStore.getState()
  try {
    let materials = await loadMaterials()
    if (materials.length === 0) {
      materials = defaultMaterials()
      await guardWrite(saveMaterials(materials))
    } else {
      const rank = new Map(defaultMaterials().map((m, i) => [m.id, i]))
      materials.sort((a, b) => (rank.get(a.id) ?? 1e9) - (rank.get(b.id) ?? 1e9))
    }
    const [settings, assignments, history, color] = await Promise.all([
      kvGet<CostSettings>(KV_COST_SETTINGS),
      kvGet<Record<string, string>>(KV_ASSIGNMENTS),
      loadHistory(),
      kvGet<string>(KV_MEASURE_COLOR),
    ])
    store.patchCost({
      materials,
      history,
      ...(settings ? { settings } : {}),
      ...(assignments ? { assignments } : {}),
    })
    if (color) store.patchMeasure({ color })
  } catch (err) {
    console.warn('Cost data init failed', err)
  }
}

let volumeTimer: ReturnType<typeof setTimeout> | null = null

export function scheduleVolumeRecompute() {
  if (volumeTimer) clearTimeout(volumeTimer)
  volumeTimer = setTimeout(recomputeVolumes, 300)
}

export function recomputeVolumes() {
  try {
    const eng = getEngine()
    const volumes: Record<string, number> = {}
    for (const info of eng.listParts()) {
      const mesh = eng.getWorldMeshData(info.id)
      if (mesh) volumes[info.id] = volumeAndArea(mesh).volume
    }
    useAppStore.getState().patchCost({ volumes })
  } catch {
    // ignore if engine not init
  }
}

export function setPartMaterial(partId: string, materialId: string) {
  const store = useAppStore.getState()
  const assignments = { ...store.cost.assignments }
  if (materialId) assignments[partId] = materialId
  else delete assignments[partId]
  store.patchCost({ assignments })
  void guardWrite(kvSet(KV_ASSIGNMENTS, assignments))
}

export function updateCostSettings(patch: Partial<CostSettings>) {
  const store = useAppStore.getState()
  const settings = { ...store.cost.settings, ...patch }
  store.patchCost({ settings })
  void guardWrite(kvSet(KV_COST_SETTINGS, settings))
}

export function updateMaterial(id: string, patch: Partial<Material>) {
  const store = useAppStore.getState()
  const materials = store.cost.materials.map((m) => (m.id === id ? { ...m, ...patch } : m))
  store.patchCost({ materials })
  void guardWrite(saveMaterials(materials))
}

export function addCustomMaterial() {
  const store = useAppStore.getState()
  const custom: Material = {
    id: `custom-${Date.now()}`,
    name: 'Custom material',
    density: 10,
    pricePerGram: 0,
    color: '#9aa0a8',
    builtin: false,
  }
  const materials = [...store.cost.materials, custom]
  store.patchCost({ materials })
  void guardWrite(saveMaterials(materials))
}

export function deleteMaterial(id: string) {
  const store = useAppStore.getState()
  const target = store.cost.materials.find((m) => m.id === id)
  if (!target || target.builtin) return
  const materials = store.cost.materials.filter((m) => m.id !== id)
  const assignments = Object.fromEntries(
    Object.entries(store.cost.assignments).filter(([, matId]) => matId !== id),
  )
  store.patchCost({ materials, assignments })
  void guardWrite(saveMaterials(materials))
  void guardWrite(kvSet(KV_ASSIGNMENTS, assignments))
}

export function resetMaterialLibrary() {
  const store = useAppStore.getState()
  const custom = store.cost.materials.filter((m) => !m.builtin)
  const materials = [...defaultMaterials(), ...custom]
  store.patchCost({ materials })
  void guardWrite(saveMaterials(materials))
}

export async function refreshMarketPrices(): Promise<void> {
  const store = useAppStore.getState()
  store.patchCost({ refreshing: true, error: null })
  try {
    const perGram = await fetchSpotPricesPerGram(store.cost.settings.currency)
    const materials = applySpotPrices(useAppStore.getState().cost.materials, perGram)
    useAppStore.getState().patchCost({ materials, refreshing: false })
    await guardWrite(saveMaterials(materials))
    updateCostSettings({ pricesUpdatedAt: new Date().toISOString() })
  } catch (err) {
    useAppStore.getState().patchCost({
      refreshing: false,
      error: err instanceof Error ? err.message : String(err),
    })
  }
}

export async function saveCalculationToHistory(): Promise<void> {
  const store = useAppStore.getState()
  const { assignments, volumes, materials, settings } = store.cost
  const entries: HistoryEntry[] = []
  for (const part of store.parts) {
    const material = materials.find((m) => m.id === assignments[part.id])
    const volume = volumes[part.id]
    if (!material || volume === undefined) continue
    const weightG = weightGrams(volume, material.density)
    entries.push({
      id: `h-${Date.now()}-${part.id}`,
      date: new Date().toISOString(),
      model: part.name,
      material: material.name,
      volumeMm3: volume,
      weightG,
      cost: costOf(weightG, material.pricePerGram, settings.lossFactorPct),
      currency: settings.currency,
    })
  }
  if (!entries.length) return
  await addHistoryEntries(entries)
  store.patchCost({ history: await loadHistory() })
}

export async function removeHistoryEntry(id: string): Promise<void> {
  await deleteHistoryEntry(id)
  useAppStore.getState().patchCost({ history: await loadHistory() })
}

export async function clearHistoryLog(): Promise<void> {
  await clearHistoryStore()
  useAppStore.getState().patchCost({ history: [] })
}

export function exportHistoryCSV() {
  const csv = historyToCSV(useAppStore.getState().cost.history)
  void saveFile(csv, `goldsmith-history-${new Date().toISOString().slice(0, 10)}.csv`, 'text/csv', {
    description: 'CSV spreadsheet',
    accept: { 'text/csv': ['.csv'] },
  })
}

export function applyShrinkage(pct: number) {
  const id = requireSelection((msg) => useAppStore.getState().patchCost({ error: msg }))
  if (!id || !(pct > -100)) return
  getEngine().applyScale(id, 1 + pct / 100)
}

export function formatMoney(value: number, currency: Currency): string {
  return new Intl.NumberFormat(undefined, {
    style: 'currency',
    currency,
    maximumFractionDigits: 2,
  }).format(value)
}
