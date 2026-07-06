import { dataURLtoBytes, deliverFiles, safeFilename } from '@/app/files'
import { getEngine, guardWrite } from '@/core/controller/context'
import { volumeAndArea } from '@/core/geometry/measure'
import { kvSet } from '@/core/persist/db'
import { buildReportPDF } from '@/core/report/pdf'
import {
  buildReportModel,
  reportToText,
  type GemListEntry,
  type ReportInput,
  type ReportBranding,
  type ReportPartInput,
} from '@/core/report/reportModel'
import type { Vec3 } from '@/core/types'
import { useAppStore } from '@/store/appStore'
import { KV_BRANDING, isSupportedLogoDataURL } from './deliverController'

export function setBranding(patch: Partial<ReportBranding>) {
  const current = useAppStore.getState().deliver.branding
  const branding: ReportBranding = {
    businessName: typeof patch.businessName === 'string' ? patch.businessName : current.businessName,
    contact: typeof patch.contact === 'string' ? patch.contact : current.contact,
    logo:
      typeof patch.logo === 'string' && isSupportedLogoDataURL(patch.logo)
        ? patch.logo
        : current.logo,
  }
  useAppStore.getState().patchDeliver({ branding })
  void guardWrite(kvSet(KV_BRANDING, branding))
}

export function setLogoFromFile(file: File): void {
  if (!/^image\/(?:png|jpeg)$/i.test(file.type)) return
  const reader = new FileReader()
  reader.onload = () => {
    if (typeof reader.result === 'string' && isSupportedLogoDataURL(reader.result)) {
      setBranding({ logo: reader.result })
    }
  }
  reader.readAsDataURL(file)
}

function deriveGemList(): GemListEntry[] {
  const groups = new Map<string, GemListEntry>()
  for (const info of useAppStore.getState().parts) {
    if (info.material !== 'gem') continue
    const match = /^(.*?)\s+([\d.]+)\s*mm$/i.exec(info.name)
    const cut = match ? match[1].trim() : info.name
    const sizeMm = match ? match[2] : '—'
    const key = `${cut}|${sizeMm}`
    const entry = groups.get(key) ?? { cut, sizeMm, qty: 0 }
    entry.qty += 1
    groups.set(key, entry)
  }
  return [...groups.values()]
}

function buildReportInputFromState(): ReportInput {
  const s = useAppStore.getState()
  const { cost, deliver } = s
  const eng = getEngine()
  const parts: ReportPartInput[] = []
  for (const info of eng.listParts()) {
    if (info.material === 'gem' || info.material === 'cutter') continue
    const mesh = eng.getWorldMeshData(info.id)
    const va = mesh ? volumeAndArea(mesh) : { volume: 0, area: 0 }
    const material = cost.materials.find((m) => m.id === cost.assignments[info.id])
    parts.push({
      name: info.name,
      materialName: material?.name ?? null,
      density: material?.density ?? null,
      pricePerGram: material?.pricePerGram ?? 0,
      volumeMm3: va.volume,
      areaMm2: va.area,
      bbox: [info.bbox.x, info.bbox.y, info.bbox.z],
    })
  }
  const bounds = eng.getSceneBounds()
  const sceneBbox = bounds
    ? ([
        bounds.max[0] - bounds.min[0],
        bounds.max[1] - bounds.min[1],
        bounds.max[2] - bounds.min[2],
      ] as Vec3)
    : null
  return {
    template: deliver.template,
    branding: deliver.branding,
    title: deliver.title,
    date: new Date().toISOString(),
    currency: cost.settings.currency,
    lossFactorPct: cost.settings.lossFactorPct,
    labour: { hours: deliver.labourHours, rate: deliver.labourRate, billing: deliver.billing },
    showMetalPrices: deliver.showMetalPrices,
    notes: deliver.notes,
    parts,
    gems: deriveGemList(),
    sceneBbox,
  }
}

export async function generateReportPDF(opts: { share?: boolean } = {}): Promise<void> {
  const store = useAppStore.getState()
  if (store.parts.length === 0) {
    store.patchDeliver({ error: 'Nothing to report — import or generate a part first.' })
    return
  }
  store.patchDeliver({ generating: true, error: null })
  try {
    const model = buildReportModel(buildReportInputFromState())
    const render = dataURLtoBytes(getEngine().renderPreviewPNG(1600))
    const logo = model.branding.logo ? dataURLtoBytes(model.branding.logo) : undefined
    const bytes = await buildReportPDF(model, { render, logo })
    const base = safeFilename(store.deliver.title || 'goldsmith')
    await deliverFiles(
      [{ data: bytes, name: `${base}-${model.template}.pdf`, mime: 'application/pdf' }],
      {
        share: opts.share,
        title: store.deliver.title || 'GoldSmith report',
        type: { description: 'PDF report', accept: { 'application/pdf': ['.pdf'] } },
      },
    )
    useAppStore.getState().patchDeliver({ generating: false })
  } catch (err) {
    useAppStore.getState().patchDeliver({
      generating: false,
      error: err instanceof Error ? err.message : String(err),
    })
  }
}

export async function copyReportText(): Promise<void> {
  const store = useAppStore.getState()
  try {
    const model = buildReportModel(buildReportInputFromState())
    if (!globalThis.navigator?.clipboard) throw new Error('Clipboard not available')
    await globalThis.navigator.clipboard.writeText(reportToText(model))
    store.patchDeliver({ copied: true, error: null })
    setTimeout(() => useAppStore.getState().patchDeliver({ copied: false }), 1500)
  } catch (err) {
    store.patchDeliver({ error: err instanceof Error ? err.message : String(err) })
  }
}
