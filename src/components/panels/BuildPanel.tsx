import { useRef, useState } from 'react'
import { Circle, Diamond, Plus, Ruler, Type, Upload } from 'lucide-react'
import { addGeneratedPart } from '@/app/studio'
import {
  defaultRingParams,
  generateBandRing,
  RING_PROFILES,
  type BandRingParams,
  type RingProfile,
} from '@/core/generators/bandRing'
import {
  GEM_CUTS,
  gemCutInfo,
  gemDefaultHeight,
  generateGem,
  generateGemCutter,
  type GemCut,
  type GemParams,
} from '@/core/generators/gems'
import {
  defaultTextParams,
  generateText3D,
  listFonts,
  registerFontFile,
  TEXT_PLACEMENTS,
  type Text3DParams,
} from '@/core/generators/text3d'
import {
  buildSizeChart,
  SIZE_SYSTEMS,
  sizeToDiameter,
  ukOptions,
  type SizeSystem,
} from '@/core/generators/ringSizes'
import { makeCylinder } from '@/core/generators/meshBuilder'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Select } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'

function Section({
  title,
  icon: Icon,
  children,
  defaultOpen,
}: {
  title: string
  icon: React.ElementType
  children: React.ReactNode
  defaultOpen?: boolean
}) {
  return (
    <details open={defaultOpen} className="rounded-lg bg-muted/40 px-3 py-2">
      <summary className="flex cursor-pointer select-none items-center gap-2 text-xs font-semibold">
        <Icon className="size-3.5 text-primary" /> {title}
      </summary>
      <div className="mt-3 flex flex-col gap-2.5">{children}</div>
    </details>
  )
}

function NumberField({
  label,
  value,
  onChange,
  step = 0.1,
  min = 0,
}: {
  label: string
  value: number
  onChange: (v: number) => void
  step?: number
  min?: number
}) {
  return (
    <label className="flex-1 text-[10px] text-muted-foreground">
      {label}
      <Input
        className="mt-0.5 h-8 text-xs"
        type="number"
        step={step}
        min={min}
        value={value}
        onChange={(e) => onChange(parseFloat(e.target.value) || 0)}
      />
    </label>
  )
}

// ---------- ring size helper (shared by band + sizer) ----------

function sizeDiameter(system: SizeSystem, value: number): number {
  return sizeToDiameter(system, value)
}

function SizePicker({
  system,
  value,
  onSystem,
  onValue,
}: {
  system: SizeSystem
  value: number
  onSystem: (s: SizeSystem) => void
  onValue: (v: number) => void
}) {
  return (
    <div className="flex gap-2">
      <label className="flex-1 text-[10px] text-muted-foreground">
        System
        <Select
          className="mt-0.5"
          value={system}
          onChange={(e) => onSystem(e.target.value as SizeSystem)}
        >
          {SIZE_SYSTEMS.map((s) => (
            <option key={s.id} value={s.id}>
              {s.label}
            </option>
          ))}
        </Select>
      </label>
      <label className="flex-1 text-[10px] text-muted-foreground">
        Size
        {system === 'UK' ? (
          <Select className="mt-0.5" value={value} onChange={(e) => onValue(parseFloat(e.target.value))}>
            {ukOptions().map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </Select>
        ) : (
          <Input
            className="mt-0.5 h-8 text-xs"
            type="number"
            step={0.5}
            value={value}
            onChange={(e) => onValue(parseFloat(e.target.value) || 0)}
          />
        )}
      </label>
    </div>
  )
}

// ---------- band ring ----------

function BandRingSection() {
  const [p, setP] = useState<BandRingParams>(defaultRingParams())
  const [system, setSystem] = useState<SizeSystem>('US')
  const [size, setSize] = useState(7)
  const patch = (q: Partial<BandRingParams>) => setP((prev) => ({ ...prev, ...q }))

  const applySize = (s: SizeSystem, v: number) => {
    setSystem(s)
    setSize(v)
    patch({ innerDiameter: sizeDiameter(s, v) })
  }

  return (
    <Section title="Band Ring" icon={Circle} defaultOpen>
      <SizePicker
        system={system}
        value={size}
        onSystem={(s) => applySize(s, size)}
        onValue={(v) => applySize(system, v)}
      />
      <NumberField
        label="Inner Ø mm"
        value={p.innerDiameter}
        step={0.05}
        onChange={(innerDiameter) => patch({ innerDiameter })}
      />
      <label className="text-[10px] text-muted-foreground">
        Profile
        <Select
          className="mt-0.5"
          value={p.profile}
          onChange={(e) => patch({ profile: e.target.value as RingProfile })}
        >
          {RING_PROFILES.map((pr) => (
            <option key={pr.id} value={pr.id}>
              {pr.label}
            </option>
          ))}
        </Select>
      </label>

      <div className="flex items-center justify-between">
        <span className="text-[10px] text-muted-foreground">Variable width/thickness</span>
        <Switch
          checked={p.mode === 'variable'}
          onCheckedChange={(v) => patch({ mode: v ? 'variable' : 'uniform' })}
        />
      </div>

      {p.mode === 'uniform' ? (
        <div className="flex gap-2">
          <NumberField label="Width mm" value={p.width} onChange={(width) => patch({ width })} />
          <NumberField
            label="Thickness mm"
            value={p.thickness}
            onChange={(thickness) => patch({ thickness })}
          />
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          {(['top', 'shoulder', 'bottom'] as const).map((region) => (
            <div key={region} className="flex items-end gap-2">
              <span className="w-14 pb-2 text-[10px] capitalize text-muted-foreground">{region}</span>
              <NumberField
                label="W"
                value={p[region].width}
                onChange={(width) => patch({ [region]: { ...p[region], width } } as Partial<BandRingParams>)}
              />
              <NumberField
                label="T"
                value={p[region].thickness}
                onChange={(thickness) =>
                  patch({ [region]: { ...p[region], thickness } } as Partial<BandRingParams>)
                }
              />
            </div>
          ))}
          <label className="text-[10px] text-muted-foreground">
            Interpolation
            <Select
              className="mt-0.5"
              value={p.interpolation}
              onChange={(e) => patch({ interpolation: e.target.value as 'smooth' | 'classic' })}
            >
              <option value="smooth">Smooth (spline)</option>
              <option value="classic">Classic (linear)</option>
            </Select>
          </label>
        </div>
      )}

      <Button
        size="sm"
        onClick={() => addGeneratedPart(`Band ${p.innerDiameter.toFixed(1)}mm`, generateBandRing(p))}
      >
        <Plus /> Add band ring
      </Button>
    </Section>
  )
}

// ---------- gemstone ----------

function GemSection() {
  const [cut, setCut] = useState<GemCut>('round')
  const [length, setLength] = useState(6)
  const [width, setWidth] = useState(6)
  const [autoHeight, setAutoHeight] = useState(true)
  const [height, setHeight] = useState(gemDefaultHeight('round', 6, 6))
  const [clearance, setClearance] = useState(0.05)
  const info = gemCutInfo(cut)

  const params = (): GemParams => ({
    cut,
    length,
    width: info.square ? length : width,
    height: autoHeight ? null : height,
  })

  const changeCut = (c: GemCut) => {
    setCut(c)
    setHeight(gemDefaultHeight(c, length, gemCutInfo(c).square ? length : width))
  }

  return (
    <Section title="Gemstone" icon={Diamond}>
      <label className="text-[10px] text-muted-foreground">
        Cut ({GEM_CUTS.length} shapes)
        <Select className="mt-0.5" value={cut} onChange={(e) => changeCut(e.target.value as GemCut)}>
          {GEM_CUTS.map((c) => (
            <option key={c.id} value={c.id}>
              {c.label}
            </option>
          ))}
        </Select>
      </label>
      <div className="flex gap-2">
        <NumberField label="Length mm" value={length} step={0.1} onChange={setLength} />
        {!info.square && <NumberField label="Width mm" value={width} step={0.1} onChange={setWidth} />}
      </div>
      <div className="flex items-center justify-between">
        <span className="text-[10px] text-muted-foreground">Auto height (industry ratio)</span>
        <Switch checked={autoHeight} onCheckedChange={setAutoHeight} />
      </div>
      {!autoHeight && <NumberField label="Height mm" value={height} step={0.1} onChange={setHeight} />}

      <Button
        size="sm"
        onClick={() => addGeneratedPart(`${info.label} ${length.toFixed(1)}mm`, generateGem(params()))}
      >
        <Plus /> Add gem
      </Button>

      <div className="flex items-end gap-2 border-t border-border/60 pt-2">
        <NumberField
          label="Seat clearance mm"
          value={clearance}
          step={0.01}
          onChange={setClearance}
        />
        <Button
          variant="secondary"
          size="sm"
          title="Oversized negative for boolean-subtracting a seat"
          onClick={() =>
            addGeneratedPart(`${info.label} cutter`, generateGemCutter(params(), clearance))
          }
        >
          Add cutter
        </Button>
      </div>
    </Section>
  )
}

// ---------- 3D text ----------

function TextSection() {
  const [p, setP] = useState<Text3DParams>(defaultTextParams())
  const [fonts, setFonts] = useState(listFonts())
  const [error, setError] = useState<string | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const patch = (q: Partial<Text3DParams>) => setP((prev) => ({ ...prev, ...q }))
  const curved = p.placement !== 'flat'

  const onUpload = async (file: File) => {
    try {
      const id = registerFontFile(file.name, await file.arrayBuffer())
      setFonts(listFonts())
      patch({ fontId: id })
      setError(null)
    } catch {
      setError('Could not parse that font file (need TTF/OTF).')
    }
  }

  const generate = () => {
    try {
      addGeneratedPart(`Text "${p.text}"`, generateText3D(p))
      setError(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  return (
    <Section title="3D Text" icon={Type}>
      <label className="text-[10px] text-muted-foreground">
        Text
        <Input
          className="mt-0.5 h-8 text-xs"
          value={p.text}
          onChange={(e) => patch({ text: e.target.value })}
        />
      </label>
      <div className="flex gap-2">
        <label className="flex-1 text-[10px] text-muted-foreground">
          Font
          <Select className="mt-0.5" value={p.fontId} onChange={(e) => patch({ fontId: e.target.value })}>
            {fonts.map((f) => (
              <option key={f.id} value={f.id}>
                {f.label}
              </option>
            ))}
          </Select>
        </label>
        <button
          title="Upload TTF/OTF"
          onClick={() => fileRef.current?.click()}
          className="mt-4 flex size-8 shrink-0 items-center justify-center rounded-md border border-border bg-input/50 text-muted-foreground hover:text-foreground"
        >
          <Upload className="size-4" />
        </button>
        <input
          ref={fileRef}
          type="file"
          accept=".ttf,.otf"
          className="hidden"
          onChange={(e) => e.target.files?.[0] && void onUpload(e.target.files[0])}
        />
      </div>
      <div className="flex gap-2">
        <NumberField label="Height mm" value={p.sizeMm} onChange={(sizeMm) => patch({ sizeMm })} />
        <NumberField label="Depth mm" value={p.depthMm} onChange={(depthMm) => patch({ depthMm })} />
      </div>
      <label className="text-[10px] text-muted-foreground">
        Placement
        <Select
          className="mt-0.5"
          value={p.placement}
          onChange={(e) => patch({ placement: e.target.value as Text3DParams['placement'] })}
        >
          {TEXT_PLACEMENTS.map((pl) => (
            <option key={pl.id} value={pl.id}>
              {pl.label}
            </option>
          ))}
        </Select>
      </label>
      {curved && (
        <>
          <NumberField
            label="Ref. diameter mm"
            value={p.diameter}
            step={0.5}
            onChange={(diameter) => patch({ diameter })}
          />
          {p.placement === 'ring-inside' && (
            <div className="flex items-center justify-between">
              <span className="text-[10px] text-muted-foreground">Cutter (engrave inward)</span>
              <Switch checked={p.cutter} onCheckedChange={(cutter) => patch({ cutter })} />
            </div>
          )}
        </>
      )}
      {error && <p className="text-[10px] text-destructive">{error}</p>}
      <Button size="sm" onClick={generate}>
        <Plus /> Add 3D text
      </Button>
    </Section>
  )
}

// ---------- ring size chart + sizer ----------

function SizeChartSection() {
  const [system, setSystem] = useState<SizeSystem>('US')
  const [size, setSize] = useState(7)
  const chart = buildSizeChart()
  const diameter = sizeDiameter(system, size)

  const spawnSizer = () => {
    // a thin disc the inner Ø of the chosen size, to drop beside a model
    addGeneratedPart(`Sizer Ø${diameter.toFixed(2)}`, makeCylinder(diameter / 2, 1.5))
  }

  return (
    <Section title="Ring Size Chart" icon={Ruler}>
      <SizePicker system={system} value={size} onSystem={setSystem} onValue={setSize} />
      <p className="readout rounded-md bg-muted/40 px-3 py-2 text-xs">
        Inner Ø <span className="font-semibold text-primary">{diameter.toFixed(2)} mm</span> ·{' '}
        {(diameter * Math.PI).toFixed(2)} mm circ.
      </p>
      <Button variant="secondary" size="sm" onClick={spawnSizer}>
        <Plus /> Spawn sizer disc
      </Button>

      <details className="mt-1">
        <summary className="cursor-pointer select-none text-[10px] font-medium text-muted-foreground">
          Full conversion chart
        </summary>
        <div className="mt-2 max-h-56 overflow-y-auto">
          <table className="w-full text-[10px]">
            <thead className="sticky top-0 bg-card text-muted-foreground">
              <tr>
                <th className="px-1 text-left">Ø mm</th>
                <th className="px-1">US</th>
                <th className="px-1">UK</th>
                <th className="px-1">EU</th>
                <th className="px-1">JP</th>
              </tr>
            </thead>
            <tbody className="readout">
              {chart.map((r) => (
                <tr key={r.us} className="odd:bg-muted/30">
                  <td className="px-1">{r.diameter.toFixed(2)}</td>
                  <td className="px-1 text-center">{r.us}</td>
                  <td className="px-1 text-center">{r.uk}</td>
                  <td className="px-1 text-center">{r.eu.toFixed(1)}</td>
                  <td className="px-1 text-center">{Math.round(r.jp)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </Section>
  )
}

export function BuildPanel() {
  return (
    <div className="flex flex-col gap-2.5">
      <p className="text-[11px] text-muted-foreground">
        Generators output real meshes into the scene — export them or sculpt over them in Nomad.
      </p>
      <BandRingSection />
      <GemSection />
      <TextSection />
      <SizeChartSection />
    </div>
  )
}
