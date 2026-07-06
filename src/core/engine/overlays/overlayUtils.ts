import * as THREE from 'three'

export function makeMarker(color: string, radius = 0.5): THREE.Mesh {
  const marker = new THREE.Mesh(
    new THREE.SphereGeometry(radius, 12, 8),
    new THREE.MeshBasicMaterial({ color, depthTest: false, transparent: true }),
  )
  marker.renderOrder = 999
  return marker
}

export function makeLabelSprite(text: string, color: string): { sprite: THREE.Sprite; aspect: number } {
  const dpr = 2
  const font = `600 ${36 * dpr}px ui-monospace, SF Mono, Menlo, monospace`
  const canvas = document.createElement('canvas')
  const ctx = canvas.getContext('2d')!
  ctx.font = font
  const pad = 16 * dpr
  const textW = ctx.measureText(text).width
  canvas.width = Math.ceil(textW + pad * 2)
  canvas.height = 64 * dpr

  ctx.font = font
  ctx.textBaseline = 'middle'
  const r = 14 * dpr
  ctx.beginPath()
  ctx.roundRect(dpr, dpr, canvas.width - 2 * dpr, canvas.height - 2 * dpr, r)
  ctx.fillStyle = 'rgba(24, 22, 18, 0.92)'
  ctx.fill()
  ctx.lineWidth = 2 * dpr
  ctx.strokeStyle = color
  ctx.stroke()
  ctx.fillStyle = '#f2efe9'
  ctx.fillText(text, pad, canvas.height / 2 + 2 * dpr)

  const texture = new THREE.CanvasTexture(canvas)
  texture.colorSpace = THREE.SRGBColorSpace
  const sprite = new THREE.Sprite(
    new THREE.SpriteMaterial({ map: texture, depthTest: false, transparent: true }),
  )
  sprite.renderOrder = 1000
  return { sprite, aspect: canvas.width / canvas.height }
}
