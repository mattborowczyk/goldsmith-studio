import { getEngine, guardWrite } from '@/core/controller/context'
import {
  export3MF,
  exportOBJ,
  exportPLY,
  exportSTL,
  mergeMeshData,
  scaleMeshDataCopy,
  type NamedMesh,
  type MeshFormat,
} from '@/core/io/exporters'
import { kvGet, kvSet } from '@/core/persist/db'
import type { ReportBranding } from '@/core/report/reportModel'
import { deliverFiles, safeFilename, type SaveData, type SaveType } from '@/app/files'
import type { DeliverState } from '@/store/appStore'
import { useAppStore } from '@/store/appStore'

export const KV_BRANDING = 'reportBranding'
const KV_REPORT_PREFS = 'reportPrefs'

interface ReportPrefs {
  template: DeliverState['template']
  labourRate: number
  billing: DeliverState['billing']
  showMetalPrices: boolean
  exportFormat: MeshFormat
  exportScope: 'merged' | 'per-part'
  applyShrinkage: boolean
  shrinkagePct: number
}

export function isSupportedLogoDataURL(value: string): boolean {
  return value === '' || /^data:image\/(?:png|jpeg);base64,/i.test(value)
}

function keepEnum<K extends keyof ReportPrefs>(
  patch: Partial<DeliverState>,
  prefs: ReportPrefs,
  key: K,
  allowed: readonly ReportPrefs[K][],
) {
  const value = prefs[key]
  if (allowed.includes(value)) (patch as Record<K, ReportPrefs[K]>)[key] = value
}

export async function initDeliverData() {
  try {
    const [branding, prefs] = await Promise.all([
      kvGet<ReportBranding>(KV_BRANDING),
      kvGet<ReportPrefs>(KV_REPORT_PREFS),
    ])
    const patch: Partial<DeliverState> = {}
    if (branding && typeof branding === 'object') {
      const nextBranding: ReportBranding = { businessName: '', contact: '', logo: '' }
      if (typeof branding.businessName === 'string') nextBranding.businessName = branding.businessName
      if (typeof branding.contact === 'string') nextBranding.contact = branding.contact
      if (typeof branding.logo === 'string' && isSupportedLogoDataURL(branding.logo)) {
        nextBranding.logo = branding.logo
      }
      patch.branding = nextBranding
    }
    if (prefs && typeof prefs === 'object') {
      keepEnum(patch, prefs, 'template', ['quote', 'casting', 'internal'])
      keepEnum(patch, prefs, 'billing', ['exact', '15min', '30min', '1h'])
      keepEnum(patch, prefs, 'exportFormat', ['stl', 'obj', 'glb', 'ply', '3mf'])
      keepEnum(patch, prefs, 'exportScope', ['merged', 'per-part'])
      if (typeof prefs.showMetalPrices === 'boolean') patch.showMetalPrices = prefs.showMetalPrices
      if (typeof prefs.applyShrinkage === 'boolean') patch.applyShrinkage = prefs.applyShrinkage
      if (Number.isFinite(prefs.labourRate)) patch.labourRate = prefs.labourRate
      if (Number.isFinite(prefs.shrinkagePct)) patch.shrinkagePct = prefs.shrinkagePct
    }
    if (Object.keys(patch).length) useAppStore.getState().patchDeliver(patch)
  } catch (err) {
    console.warn('Deliver data init failed', err)
  }
}

export function persistReportPrefs() {
  const d = useAppStore.getState().deliver
  const prefs: ReportPrefs = {
    template: d.template,
    labourRate: d.labourRate,
    billing: d.billing,
    showMetalPrices: d.showMetalPrices,
    exportFormat: d.exportFormat,
    exportScope: d.exportScope,
    applyShrinkage: d.applyShrinkage,
    shrinkagePct: d.shrinkagePct,
  }
  void guardWrite(kvSet(KV_REPORT_PREFS, prefs))
}

export function patchDeliver(patch: Partial<DeliverState>) {
  useAppStore.getState().patchDeliver(patch)
  persistReportPrefs()
}

function preparedMeshes(): NamedMesh[] {
  const eng = getEngine()
  const d = useAppStore.getState().deliver
  const factor = d.applyShrinkage ? 1 + d.shrinkagePct / 100 : 1
  const out: NamedMesh[] = []
  for (const info of eng.listParts()) {
    const mesh = eng.getWorldMeshData(info.id)
    if (!mesh) continue
    out.push({ name: info.name, mesh: factor === 1 ? mesh : scaleMeshDataCopy(mesh, factor) })
  }
  return out
}

const MESH_MIME: Record<MeshFormat, string> = {
  stl: 'model/stl',
  obj: 'text/plain',
  glb: 'model/gltf-binary',
  ply: 'application/octet-stream',
  '3mf': 'model/3mf',
}

const MESH_SAVE_TYPE: Record<MeshFormat, SaveType> = {
  stl: { description: 'STL mesh', accept: { 'model/stl': ['.stl'] } },
  obj: { description: 'OBJ mesh', accept: { 'text/plain': ['.obj'] } },
  glb: { description: 'glTF binary', accept: { 'model/gltf-binary': ['.glb'] } },
  ply: { description: 'PLY mesh', accept: { 'application/octet-stream': ['.ply'] } },
  '3mf': { description: '3MF package', accept: { 'model/3mf': ['.3mf'] } },
}

export async function exportMesh(opts: { share?: boolean } = {}): Promise<void> {
  const store = useAppStore.getState()
  const d = store.deliver
  if (d.applyShrinkage && !(1 + d.shrinkagePct / 100 > 0)) {
    store.patchDeliver({ error: 'Shrinkage % must be greater than −100.' })
    return
  }
  const prepared = preparedMeshes()
  if (!prepared.length) {
    store.patchDeliver({ error: 'Nothing to export — import or generate a part first.' })
    return
  }
  store.patchDeliver({ exporting: true, error: null })
  const base = safeFilename(d.title || 'goldsmith-export')
  const mime = MESH_MIME[d.exportFormat]
  try {
    const files: NamedMesh[] = d.exportScope === 'merged'
      ? [{ name: base, mesh: mergeMeshData(prepared.map((p) => p.mesh)) }]
      : prepared
    const built: { data: SaveData; name: string; mime: string }[] = []
    for (const file of files) {
      const fname = `${safeFilename(file.name)}.${d.exportFormat}`
      if (d.exportFormat === 'stl') {
        built.push({ data: exportSTL(file.mesh), name: fname, mime })
      } else if (d.exportFormat === 'obj') {
        built.push({ data: exportOBJ([file]), name: fname, mime })
      } else if (d.exportFormat === 'ply') {
        built.push({ data: exportPLY(file.mesh), name: fname, mime })
      } else if (d.exportFormat === '3mf') {
        built.push({ data: export3MF([file]), name: fname, mime })
      } else {
        built.push({ data: await getEngine().exportGLTF([file], { binary: true }), name: fname, mime })
      }
    }
    await deliverFiles(built, { share: opts.share, title: base, type: MESH_SAVE_TYPE[d.exportFormat] })
    useAppStore.getState().patchDeliver({ exporting: false })
  } catch (err) {
    useAppStore.getState().patchDeliver({
      exporting: false,
      error: err instanceof Error ? err.message : String(err),
    })
  }
}
