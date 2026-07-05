import {
  Camera,
  Grid3X3,
  ImageDown,
  Maximize,
  Move3D,
  Rotate3D,
  RotateCw,
  Scale3D,
  Sparkles,
} from 'lucide-react'
import { getEngine } from '@/app/engine'
import {
  downloadClientPreview,
  downloadSnapshot,
  setBackground,
  setDisplayMode,
  setGridVisible,
  setPostFX,
} from '@/features/theme'
import type { DisplayMode, GizmoMode, ViewPreset } from '@/core/types'
import { useAppStore } from '@/store/appStore'
import { Button } from '@/components/ui/button'
import { Select } from '@/components/ui/select'
import { cn } from '@/lib/utils'

const PRESETS: { id: ViewPreset; label: string }[] = [
  { id: 'top', label: 'Top' },
  { id: 'front', label: 'Front' },
  { id: 'left', label: 'Left' },
  { id: 'right', label: 'Right' },
  { id: 'iso', label: 'Iso' },
]

const DISPLAY_MODES: { id: DisplayMode; label: string }[] = [
  { id: 'gold', label: 'Polished gold' },
  { id: 'silver', label: 'Polished silver' },
  { id: 'studio', label: 'Neutral studio' },
  { id: 'wireframe', label: 'Wireframe' },
  { id: 'normals', label: 'Normals debug' },
  { id: 'backface', label: 'Backface debug' },
]

const GIZMO_MODES: { id: GizmoMode; icon: React.ElementType; label: string }[] = [
  { id: 'translate', icon: Move3D, label: 'Move' },
  { id: 'rotate', icon: Rotate3D, label: 'Rotate' },
  { id: 'scale', icon: Scale3D, label: 'Scale' },
]

export function TopBar() {
  const displayMode = useAppStore((s) => s.displayMode)
  const projection = useAppStore((s) => s.projection)
  const setProjection = useAppStore((s) => s.setProjection)
  const gizmoMode = useAppStore((s) => s.gizmoMode)
  const setGizmoMode = useAppStore((s) => s.setGizmoMode)
  const gridVisible = useAppStore((s) => s.gridVisible)
  const turntable = useAppStore((s) => s.turntable)
  const setTurntable = useAppStore((s) => s.setTurntable)
  const background = useAppStore((s) => s.background)
  const selectedId = useAppStore((s) => s.selectedId)
  const postFX = useAppStore((s) => s.postFX)

  return (
    <header className="absolute inset-x-0 top-0 z-30 flex flex-wrap items-center gap-x-3 gap-y-1.5 px-4 py-2">
      <h1 className="select-none text-sm font-semibold tracking-wide">
        <span className="text-primary">GoldSmith</span> Studio
      </h1>

      <div className="panel-glass flex items-center gap-0.5 p-1">
        {PRESETS.map((p) => (
          <Button
            key={p.id}
            variant="ghost"
            size="sm"
            onClick={() => getEngine().setViewPreset(p.id)}
          >
            {p.label}
          </Button>
        ))}
        <Button variant="ghost" size="iconSm" title="Fit to view" onClick={() => getEngine().fitToView()}>
          <Maximize />
        </Button>
        <Button
          variant="ghost"
          size="sm"
          title="Toggle projection"
          onClick={() => {
            const next = projection === 'perspective' ? 'orthographic' : 'perspective'
            getEngine().setProjection(next)
            setProjection(next)
          }}
        >
          {projection === 'perspective' ? 'Persp' : 'Ortho'}
        </Button>
      </div>

      <div className="panel-glass flex items-center gap-0.5 p-1">
        {GIZMO_MODES.map(({ id, icon: Icon, label }) => (
          <Button
            key={id}
            variant="ghost"
            size="iconSm"
            title={label}
            disabled={!selectedId}
            className={cn(gizmoMode === id && selectedId && 'bg-accent text-accent-foreground')}
            onClick={() => {
              setGizmoMode(id)
              getEngine().setGizmoMode(id)
            }}
          >
            <Icon />
          </Button>
        ))}
      </div>

      <div className="ml-auto flex items-center gap-2">
        <Select
          className="w-44"
          value={displayMode}
          onChange={(e) => setDisplayMode(e.target.value as DisplayMode)}
          title="Display material"
        >
          {DISPLAY_MODES.map((m) => (
            <option key={m.id} value={m.id}>
              {m.label}
            </option>
          ))}
        </Select>
        <Select
          className="w-32"
          value={background}
          onChange={(e) => setBackground(e.target.value)}
          title="Background"
        >
          <option value="studio">Studio</option>
          <option value="charcoal">Charcoal</option>
          <option value="slate">Slate</option>
          <option value="black">Black</option>
        </Select>
        <div className="panel-glass flex items-center gap-0.5 p-1">
          <Button
            variant="ghost"
            size="iconSm"
            title="Toggle grid"
            className={cn(gridVisible && 'bg-accent text-accent-foreground')}
            onClick={() => setGridVisible(!gridVisible)}
          >
            <Grid3X3 />
          </Button>
          <Button
            variant="ghost"
            size="iconSm"
            title="Turntable"
            className={cn(turntable && 'bg-accent text-accent-foreground')}
            onClick={() => {
              getEngine().setTurntable(!turntable)
              setTurntable(!turntable)
            }}
          >
            <RotateCw />
          </Button>
          <Button
            variant="ghost"
            size="iconSm"
            title="Render quality (AO + bloom)"
            className={cn(postFX && 'bg-accent text-accent-foreground')}
            onClick={() => setPostFX(!postFX)}
          >
            <Sparkles />
          </Button>
          <Button variant="ghost" size="iconSm" title="Snapshot PNG" onClick={downloadSnapshot}>
            <Camera />
          </Button>
          <Button
            variant="ghost"
            size="iconSm"
            title="Client preview render (high-res PNG, helpers hidden)"
            onClick={downloadClientPreview}
          >
            <ImageDown />
          </Button>
        </div>
      </div>
    </header>
  )
}
