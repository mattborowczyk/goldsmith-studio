import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFImage, type PDFPage } from 'pdf-lib'
import { formatMoney, type ReportModel } from './reportModel'

/**
 * Branded PDF report (plan §2.7), built with pdf-lib — pure JS, no DOM — so it
 * honours the core "DOM-light" rule and could move to a worker later. Images
 * (logo, viewport render) are passed in as bytes by the caller; this module
 * never touches the canvas or Three.
 */

export interface ReportAssets {
  /** Logo image bytes (PNG or JPEG), or undefined. */
  logo?: Uint8Array
  /** Viewport render bytes (PNG), or undefined. */
  render?: Uint8Array
}

// A4 portrait, points.
const PAGE_W = 595.28
const PAGE_H = 841.89
const MARGIN = 48
const CONTENT_W = PAGE_W - MARGIN * 2

const INK = rgb(0.13, 0.12, 0.1)
const MUTED = rgb(0.45, 0.43, 0.4)
const GOLD = rgb(0.82, 0.66, 0.31)
const RULE = rgb(0.82, 0.8, 0.76)

export async function buildReportPDF(model: ReportModel, assets: ReportAssets): Promise<Uint8Array> {
  const doc = await PDFDocument.create()
  doc.setTitle(`${model.templateLabel} — ${model.title}`)
  doc.setCreator('GoldSmith Studio')
  const font = await doc.embedFont(StandardFonts.Helvetica)
  const bold = await doc.embedFont(StandardFonts.HelveticaBold)

  const logo = assets.logo ? await embedImage(doc, assets.logo) : null
  const render = assets.render ? await embedImage(doc, assets.render) : null
  const money = (v: number) => formatMoney(v, model.currency)

  const ctx: Ctx = { doc, font, bold, page: doc.addPage([PAGE_W, PAGE_H]), y: 0 }
  ctx.y = PAGE_H - MARGIN

  // ---- header: logo + business name/contact ----
  const headerTop = ctx.y
  if (logo) {
    const dims = fit(logo, 120, 56)
    ctx.page.drawImage(logo, { x: MARGIN, y: headerTop - dims.h, width: dims.w, height: dims.h })
  }
  let hy = headerTop - 4
  if (model.branding.businessName) {
    ctx.page.drawText(model.branding.businessName, {
      x: rightTextX(model.branding.businessName, bold, 16),
      y: hy - 14,
      size: 16,
      font: bold,
      color: INK,
    })
    hy -= 22
  }
  for (const line of model.branding.contact.split('\n').map((l) => l.trim()).filter(Boolean)) {
    ctx.page.drawText(line, {
      x: rightTextX(line, font, 9),
      y: hy - 10,
      size: 9,
      font,
      color: MUTED,
    })
    hy -= 12
  }
  ctx.y = Math.min(headerTop - (logo ? 64 : 0), hy) - 16
  rule(ctx)

  // ---- title + date ----
  text(ctx, model.templateLabel.toUpperCase(), { size: 9, font: bold, color: GOLD, gap: 4 })
  text(ctx, model.title, { size: 20, font: bold, color: INK, gap: 4 })
  text(ctx, model.dateLabel, { size: 10, font, color: MUTED, gap: 14 })

  // ---- render image ----
  if (render) {
    const dims = fit(render, CONTENT_W, 300)
    ensureSpace(ctx, dims.h + 16)
    ctx.page.drawImage(render, {
      x: MARGIN + (CONTENT_W - dims.w) / 2,
      y: ctx.y - dims.h,
      width: dims.w,
      height: dims.h,
    })
    ctx.y -= dims.h + 16
  }

  // ---- overall dimensions ----
  if (model.sceneBbox) {
    const [x, y, z] = model.sceneBbox
    heading(ctx, 'Overall size')
    text(ctx, `${x.toFixed(2)} × ${y.toFixed(2)} × ${z.toFixed(2)} mm`, { size: 11, font, color: INK, gap: 12 })
  }

  // ---- parts table ----
  heading(ctx, 'Parts')
  const cols = model.show.cost
    ? [
        { label: 'Part', w: 0.32, align: 'left' as const },
        { label: 'Material', w: 0.24, align: 'left' as const },
        { label: 'Weight', w: 0.14, align: 'right' as const },
        { label: 'Volume', w: 0.15, align: 'right' as const },
        { label: 'Cost', w: 0.15, align: 'right' as const },
      ]
    : [
        { label: 'Part', w: 0.34, align: 'left' as const },
        { label: 'Material', w: 0.26, align: 'left' as const },
        { label: 'Weight', w: 0.2, align: 'right' as const },
        { label: 'Volume', w: 0.2, align: 'right' as const },
      ]
  tableRow(ctx, cols, cols.map((c) => c.label), { font: bold, color: MUTED, size: 8 })
  ctx.y -= 2
  rule(ctx)
  for (const p of model.parts) {
    const cells = [
      p.name,
      p.materialName ?? '—',
      `${p.weightG.toFixed(2)} g`,
      `${p.volumeMm3.toFixed(1)} mm³`,
    ]
    if (model.show.cost) cells.push(p.cost !== null ? money(p.cost) : '—')
    tableRow(ctx, cols, cells, { font, color: INK, size: 10 })
  }

  // ---- totals ----
  ctx.y -= 4
  rule(ctx)
  for (const t of model.materialTotals) {
    const right = model.show.cost && t.cost > 0 ? `${t.weightG.toFixed(2)} g · ${money(t.cost)}` : `${t.weightG.toFixed(2)} g`
    labelValue(ctx, t.name, right, { strong: false })
  }
  labelValue(ctx, 'Total weight', `${model.grandWeightG.toFixed(2)} g`, { strong: true })
  if (model.lossFactorPct > 0) {
    text(ctx, `incl. ${model.lossFactorPct}% casting loss`, { size: 8, font, color: MUTED, gap: 8 })
  }

  // ---- gemstones ----
  if (model.show.gems) {
    heading(ctx, 'Gemstones')
    for (const g of model.gems) {
      labelValue(ctx, `${g.cut} · ${g.sizeMm} mm`, `${g.qty}×`, { strong: false })
    }
  }

  // ---- metal prices disclosure ----
  if (model.show.metalPrices) {
    heading(ctx, 'Metal prices')
    for (const t of model.materialTotals) {
      if (t.pricePerGram > 0) labelValue(ctx, t.name, `${money(t.pricePerGram)} / g`, { strong: false })
    }
  }

  // ---- labour ----
  if (model.show.labour && model.labour) {
    heading(ctx, 'Labour')
    labelValue(
      ctx,
      `${model.labour.billedHours.toFixed(2)} h × ${money(model.labour.rate)} / h`,
      money(model.labour.cost),
      { strong: false },
    )
  }

  // ---- grand total ----
  if (model.show.cost) {
    ctx.y -= 4
    rule(ctx)
    labelValue(ctx, 'Total', money(model.grandTotal), { strong: true, size: 13, color: GOLD })
  }

  // ---- notes ----
  if (model.show.notes) {
    heading(ctx, 'Notes')
    for (const line of wrap(model.notes, font, 10, CONTENT_W)) {
      text(ctx, line, { size: 10, font, color: INK, gap: 2 })
    }
  }

  return doc.save()
}

// ---------- layout primitives ----------

interface Ctx {
  doc: PDFDocument
  font: PDFFont
  bold: PDFFont
  page: PDFPage
  y: number
}

function newPage(ctx: Ctx) {
  ctx.page = ctx.doc.addPage([PAGE_W, PAGE_H])
  ctx.y = PAGE_H - MARGIN
}

function ensureSpace(ctx: Ctx, needed: number) {
  if (ctx.y - needed < MARGIN) newPage(ctx)
}

function rule(ctx: Ctx) {
  ctx.page.drawLine({
    start: { x: MARGIN, y: ctx.y },
    end: { x: PAGE_W - MARGIN, y: ctx.y },
    thickness: 0.75,
    color: RULE,
  })
  ctx.y -= 10
}

function text(
  ctx: Ctx,
  str: string,
  opts: { size: number; font: PDFFont; color: ReturnType<typeof rgb>; gap: number },
) {
  ensureSpace(ctx, opts.size + opts.gap)
  ctx.page.drawText(str, { x: MARGIN, y: ctx.y - opts.size, size: opts.size, font: opts.font, color: opts.color })
  ctx.y -= opts.size + opts.gap
}

function heading(ctx: Ctx, str: string) {
  ctx.y -= 8
  ensureSpace(ctx, 24)
  text(ctx, str.toUpperCase(), { size: 9, font: ctx.bold, color: GOLD, gap: 6 })
}

function labelValue(
  ctx: Ctx,
  label: string,
  value: string,
  opts: { strong: boolean; size?: number; color?: ReturnType<typeof rgb> },
) {
  const size = opts.size ?? 10
  const f = opts.strong ? ctx.bold : ctx.font
  const color = opts.color ?? INK
  ensureSpace(ctx, size + 6)
  ctx.page.drawText(label, { x: MARGIN, y: ctx.y - size, size, font: f, color })
  const vw = ctx.bold.widthOfTextAtSize(value, size)
  ctx.page.drawText(value, { x: PAGE_W - MARGIN - vw, y: ctx.y - size, size, font: f, color })
  ctx.y -= size + 6
}

function tableRow(
  ctx: Ctx,
  cols: { w: number; align: 'left' | 'right' }[],
  cells: string[],
  style: { font: PDFFont; color: ReturnType<typeof rgb>; size: number },
) {
  ensureSpace(ctx, style.size + 6)
  let x = MARGIN
  for (const [i, col] of cols.entries()) {
    const colW = col.w * CONTENT_W
    const cell = truncate(cells[i] ?? '', style.font, style.size, colW - 4)
    const tw = style.font.widthOfTextAtSize(cell, style.size)
    const tx = col.align === 'right' ? x + colW - tw - 4 : x
    ctx.page.drawText(cell, { x: tx, y: ctx.y - style.size, size: style.size, font: style.font, color: style.color })
    x += colW
  }
  ctx.y -= style.size + 6
}

// ---------- helpers ----------

async function embedImage(doc: PDFDocument, bytes: Uint8Array): Promise<PDFImage> {
  // PNG signature 0x89 'P' 'N' 'G'; everything else we treat as JPEG.
  const isPng = bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47
  return isPng ? doc.embedPng(bytes) : doc.embedJpg(bytes)
}

/** Scale an image to fit a box, preserving aspect, never upscaling past width. */
function fit(img: PDFImage, maxW: number, maxH: number): { w: number; h: number } {
  const scale = Math.min(maxW / img.width, maxH / img.height, 1)
  // very small logos may have scale 1 already; allow modest upscale of logos
  const s = scale === 1 && img.width < maxW ? Math.min(maxW / img.width, maxH / img.height) : scale
  return { w: img.width * s, h: img.height * s }
}

function rightTextX(str: string, font: PDFFont, size: number): number {
  return PAGE_W - MARGIN - font.widthOfTextAtSize(str, size)
}

function truncate(str: string, font: PDFFont, size: number, maxW: number): string {
  if (font.widthOfTextAtSize(str, size) <= maxW) return str
  let s = str
  while (s.length > 1 && font.widthOfTextAtSize(s + '…', size) > maxW) s = s.slice(0, -1)
  return s + '…'
}

function wrap(str: string, font: PDFFont, size: number, maxW: number): string[] {
  const lines: string[] = []
  for (const para of str.split('\n')) {
    const words = para.split(/\s+/)
    let line = ''
    for (const word of words) {
      const next = line ? `${line} ${word}` : word
      if (font.widthOfTextAtSize(next, size) > maxW && line) {
        lines.push(line)
        line = word
      } else {
        line = next
      }
    }
    lines.push(line)
  }
  return lines
}
