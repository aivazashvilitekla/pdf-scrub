// All PDF work happens here, off the main thread.
//
// Division of labour:
//   MuPDF WASM (AGPL) - text search, true redaction, page rendering, and swapping
//                       a scanned page's image for a whitened copy.
//   pdf-lib (MIT)     - structural edits: reorder, delete, rotate, merge, split,
//                       lifting a region onto another page via a Form XObject, and
//                       laying pasted text out as a book.
//
// Coordinate systems, the thing most likely to bite:
//   MuPDF page space  - origin TOP-LEFT, y grows downward. All rects crossing the
//                       worker boundary use this, because it matches the rendered canvas.
//   pdf-lib user space - origin BOTTOM-LEFT, y grows upward. Converted only inside
//                       moveRegion(), against the page's CropBox (which is what MuPDF renders).

import * as mupdf from './vendor/mupdf/mupdf.js'
import { PDFDocument, StandardFonts, degrees, rgb, setWordSpacing, pushGraphicsState, popGraphicsState } from './vendor/pdf-lib.esm.min.js'

let bytes = null      // Uint8Array: the current document, single source of truth
let doc = null        // cached MuPDF PDFDocument opened from `bytes`
const undoStack = []  // previous versions of `bytes`
const UNDO_LIMIT = 12

// ---------------------------------------------------------------- plumbing

function openPdf () {
  if (!doc) {
    if (!bytes) throw new Error('No document loaded.')
    const d = mupdf.Document.openDocument(bytes, 'application/pdf')
    if (d.needsPassword()) throw new Error('This PDF is password protected.')
    doc = d.asPDF()
    if (!doc) throw new Error('That file is not a PDF.')
  }
  return doc
}

function dropDoc () {
  if (doc) { try { doc.destroy() } catch (e) {} }
  doc = null
}

// Replace the document, remembering the old bytes so Undo can get back.
function commit (next, { snapshot = true } = {}) {
  if (snapshot && bytes) {
    undoStack.push(bytes)
    if (undoStack.length > UNDO_LIMIT) undoStack.shift()
  }
  bytes = next
  dropDoc()
}

// MuPDF hands back views that may live in wasm memory; always copy before we keep
// or transfer them, otherwise the buffer can be freed or detached underneath us.
function copyOut (view) { return new Uint8Array(view) }

function saveMupdf (d) {
  let buf
  try {
    buf = d.saveToBuffer('compress=yes,garbage=compact')
  } catch (e) {
    buf = d.saveToBuffer()          // fall back if the option string is rejected
  }
  const out = copyOut(buf.asUint8Array())
  try { buf.destroy() } catch (e) {}
  return out
}

const loadLib = (b) => PDFDocument.load(b, { ignoreEncryption: true })

// ---------------------------------------------------------------- reads

function meta () {
  const d = openPdf()
  const n = d.countPages()
  const pages = []
  for (let i = 0; i < n; i++) {
    const page = d.loadPage(i)
    const b = page.getBounds()
    let rotate = 0
    try {
      const r = page.getObject().get('Rotate')
      if (r && !r.isNull()) rotate = ((r.asNumber() % 360) + 360) % 360
    } catch (e) {}
    pages.push({ w: b[2] - b[0], h: b[3] - b[1], rotate })
    try { page.destroy() } catch (e) {}
  }
  return { pageCount: n, pages, size: bytes.length }
}

function render (index, scale) {
  const d = openPdf()
  const page = d.loadPage(index)
  const pix = page.toPixmap(mupdf.Matrix.scale(scale, scale), mupdf.ColorSpace.DeviceRGB, false)
  const png = copyOut(pix.asPNG())
  const w = pix.getWidth(), h = pix.getHeight()
  try { pix.destroy() } catch (e) {}
  try { page.destroy() } catch (e) {}
  return { index, png, w, h, scale }
}

// Count occurrences without touching the file, so a strip can be confirmed first.
function scan (needles) {
  const d = openPdf()
  const perPage = []
  let total = 0
  for (let i = 0; i < d.countPages(); i++) {
    const page = d.loadPage(i)
    let n = 0
    for (const needle of needles) {
      try { n += page.search(needle).length } catch (e) {}
    }
    if (n) perPage.push({ page: i, hits: n })
    total += n
    try { page.destroy() } catch (e) {}
  }
  return { total, perPage }
}

// ---------------------------------------------------------------- writes

function strip (needles) {
  const d = openPdf()
  const perPage = []
  let total = 0
  for (let i = 0; i < d.countPages(); i++) {
    const page = d.loadPage(i)
    let n = 0
    for (const needle of needles) {
      let hits = []
      try { hits = page.search(needle) } catch (e) { continue }
      for (const quads of hits) {
        const annot = page.createAnnotation('Redact')
        annot.setQuadPoints(quads)
        annot.update()
        n++
      }
    }
    if (n) {
      // black_boxes=false  -> strip, do not paint a black rectangle over it
      // image=NONE(0), lineArt=NONE(0)  -> leave artwork alone, this is a text pass
      // text=REMOVE(0)     -> actually delete the glyphs from the content stream
      page.applyRedactions(false, 0, 0, 0)
      perPage.push({ page: i, hits: n })
      total += n
    }
    try { page.destroy() } catch (e) {}
  }
  if (total) commit(saveMupdf(d))
  return { total, perPage }
}

function redactRect (index, rect, killGraphics) {
  const d = openPdf()
  const page = d.loadPage(index)
  const annot = page.createAnnotation('Redact')
  annot.setRect(rect)
  annot.update()
  // killGraphics: IMAGE_REMOVE(1) + LINE_ART_REMOVE_IF_TOUCHED(2) also clear artwork.
  page.applyRedactions(false, killGraphics ? 1 : 0, killGraphics ? 2 : 0, 0)
  commit(saveMupdf(d))
  try { page.destroy() } catch (e) {}
  return meta()
}

// Genuinely delete everything outside `rect` on a single-page document.
//
// Why this exists: pdf-lib's embedPage clips a page to a bounding box, but clipping
// only hides content, it does not remove it. Text outside the box stays in the
// stream and remains extractable, so a naive move drags the rest of the source page
// along invisibly - including a watermark that had already been stripped elsewhere.
// Redacting the four surrounding bands first means the Form XObject really only
// contains the region the user selected.
function cropByRedaction (pageBytes, rect) {
  const d = mupdf.Document.openDocument(pageBytes, 'application/pdf').asPDF()
  const page = d.loadPage(0)
  const b = page.getBounds()
  const [x0, y0, x1, y1] = rect
  const pad = 5000                    // reach well past the page edges

  const bands = [
    [b[0] - pad, b[1] - pad, b[2] + pad, y0],          // above the selection
    [b[0] - pad, y1,         b[2] + pad, b[3] + pad],  // below it
    [b[0] - pad, y0,         x0,         y1],          // left of it
    [x1,         y0,         b[2] + pad, y1],          // right of it
  ]
  for (const r of bands) {
    const annot = page.createAnnotation('Redact')
    annot.setRect(r)
    annot.update()
  }
  // IMAGE_PIXELS(2) clears only the covered pixels, so an image straddling the
  // selection edge keeps the part inside. LINE_ART_REMOVE_IF_COVERED(1) is likewise
  // conservative: artwork is dropped only when fully covered.
  page.applyRedactions(false, 2, 1, 0)
  const out = saveMupdf(d)
  try { page.destroy() } catch (e) {}
  try { d.destroy() } catch (e) {}
  return out
}

// Lift `rect` off page `srcIdx` and place it on page `dstIdx` at `dstXY`.
// The copy is a Form XObject, so text stays real selectable text.
// The copy MUST happen before the original is redacted away.
async function moveRegion ({ srcIdx, rect, dstIdx, dstXY, deleteOriginal = true }) {
  const [x0, y0, x1, y1] = rect
  const w = x1 - x0, h = y1 - y0
  if (w < 2 || h < 2) throw new Error('That selection is too small.')

  // 1. Isolate the source page into its own one-page document.
  const srcDoc = await loadLib(bytes)
  const iso = await PDFDocument.create()
  const [copied] = await iso.copyPages(srcDoc, [srcIdx])
  iso.addPage(copied)

  // 2. Strip everything outside the selection from that isolated copy.
  const cleanBytes = cropByRedaction(new Uint8Array(await iso.save()), rect)

  // 3. Embed the cleaned region onto the target page.
  const cleanDoc = await loadLib(cleanBytes)
  const dstDoc = await loadLib(bytes)
  const sp = cleanDoc.getPage(0)
  const cb = sp.getCropBox()

  // MuPDF top-left rect -> pdf-lib bottom-left bounding box
  const embedded = await dstDoc.embedPage(sp, {
    left:   cb.x + x0,
    right:  cb.x + x1,
    bottom: cb.y + (cb.height - y1),
    top:    cb.y + (cb.height - y0),
  })

  const tp = dstDoc.getPage(dstIdx)
  const tcb = tp.getCropBox()
  tp.drawPage(embedded, {
    x: tcb.x + dstXY[0],
    y: tcb.y + (tcb.height - dstXY[1] - h),
    width: w,
    height: h,
  })

  commit(new Uint8Array(await dstDoc.save()))

  // 4. Clear the vacated area on the original page.
  if (deleteOriginal) {
    const d = openPdf()
    const page = d.loadPage(srcIdx)
    const annot = page.createAnnotation('Redact')
    annot.setRect(rect)
    annot.update()
    page.applyRedactions(false, 1, 2, 0)
    commit(saveMupdf(d), { snapshot: false })   // same user action, one undo step
    try { page.destroy() } catch (e) {}
  }
  return meta()
}

// order: source page indices in the wanted order; omitting one deletes it.
// rotate: { sourceIndex: extraDegrees }
async function pageOps ({ order, rotate = {} }) {
  const src = await loadLib(bytes)
  const total = src.getPageCount()
  const identity = order.length === total && order.every((v, i) => v === i)

  if (identity) {
    // Nothing structural changed, so mutate in place and keep outline/metadata intact.
    for (const [idx, deg] of Object.entries(rotate)) {
      if (!deg) continue
      const p = src.getPage(Number(idx))
      p.setRotation(degrees((((p.getRotation().angle + deg) % 360) + 360) % 360))
    }
    commit(new Uint8Array(await src.save()))
  } else {
    const out = await PDFDocument.create()
    const copied = await out.copyPages(src, order)
    copied.forEach((p, i) => {
      const deg = rotate[order[i]] || 0
      if (deg) p.setRotation(degrees((((p.getRotation().angle + deg) % 360) + 360) % 360))
      out.addPage(p)
    })
    commit(new Uint8Array(await out.save()))
  }
  return meta()
}

async function append (extraBytes) {
  const base = await loadLib(bytes)
  const add = await loadLib(extraBytes)
  const copied = await base.copyPages(add, add.getPageIndices())
  copied.forEach((p) => base.addPage(p))
  commit(new Uint8Array(await base.save()))
  return meta()
}

// Export a subset without changing the working document.
async function extract (indices) {
  const src = await loadLib(bytes)
  const out = await PDFDocument.create()
  const copied = await out.copyPages(src, indices)
  copied.forEach((p) => out.addPage(p))
  return { bytes: new Uint8Array(await out.save()) }
}

// ---------------------------------------------------------------- text editing
//
// A PDF stores the printed result, not a document model: each line is an
// independently positioned run of glyphs with no paragraph relationship. So text
// can be replaced line by line, but nothing reflows - a longer replacement will
// not rewrap the paragraph or push the following lines down. This is the same
// limitation Acrobat has, for the same reason.

const STD = {
  sans:  ['Helvetica', 'HelveticaBold', 'HelveticaOblique', 'HelveticaBoldOblique'],
  serif: ['TimesRoman', 'TimesRomanBold', 'TimesRomanItalic', 'TimesRomanBoldItalic'],
  mono:  ['Courier', 'CourierBold', 'CourierOblique', 'CourierBoldOblique'],
}
const stdName = (family, bold, italic) =>
  (STD[family] || STD.sans)[(bold ? 1 : 0) + (italic ? 2 : 0)]

// MuPDF colours are 1 (gray), 3 (RGB) or 4 (CMYK) components, 0..1.
function normColor (c) {
  if (!Array.isArray(c)) return [0, 0, 0]
  if (c.length === 1) return [c[0], c[0], c[0]]
  if (c.length === 3) return c
  if (c.length === 4) {
    const [cy, m, y, k] = c
    return [1 - Math.min(1, cy + k), 1 - Math.min(1, m + k), 1 - Math.min(1, y + k)]
  }
  return [0, 0, 0]
}

function textLines ({ index }) {
  const d = openPdf()
  const page = d.loadPage(index)
  const st = page.toStructuredText()
  const lines = []
  let cur = null
  st.walk({
    beginLine (bbox) { cur = { bbox, text: '' } },
    onChar (c, origin, font, size, quad, color) {
      if (!cur) return
      if (!cur.text.length) {
        // The first character carries the line's baseline, size, face and colour.
        cur.x = origin[0]
        cur.y = origin[1]
        cur.size = size
        cur.color = color
        try {
          cur.name = font.getName()
          cur.bold = font.isBold()
          cur.italic = font.isItalic()
          cur.family = font.isMono() ? 'mono' : (font.isSerif() ? 'serif' : 'sans')
        } catch (e) {}
      }
      cur.text += c
    },
    endLine () {
      if (cur && cur.text.trim()) {
        lines.push({
          rect: [cur.bbox[0], cur.bbox[1], cur.bbox[2], cur.bbox[3]],
          x: cur.x, y: cur.y,
          size: cur.size || 12,
          text: cur.text,
          name: cur.name || '',
          bold: !!cur.bold,
          italic: !!cur.italic,
          family: cur.family || 'sans',
          color: normColor(cur.color),
        })
      }
      cur = null
    },
  })
  try { st.destroy() } catch (e) {}
  try { page.destroy() } catch (e) {}
  return { index, lines }
}

async function replaceLine ({ index, rect, x, y, size, text, family = 'sans', bold = false, italic = false, color = [0, 0, 0] }) {
  const next = String(text == null ? '' : text)

  // Validate BEFORE deleting anything. Redacting first and then discovering the
  // font cannot encode the replacement would destroy the original text and leave
  // nothing in its place.
  const faceName = stdName(family, bold, italic)
  if (next.trim()) {
    const probe = await PDFDocument.create()
    const probeFont = await probe.embedFont(StandardFonts[faceName])
    const bad = [...new Set(Array.from(next))].filter((ch) => {
      if (ch === '\n' || ch === '\r') return true
      try { probeFont.widthOfTextAtSize(ch, 10); return false } catch (e) { return true }
    })
    if (bad.length) {
      throw new Error(
        'The built-in fonts cover Western European text only and cannot render: ' +
        bad.map((c) => JSON.stringify(c)).join(' '))
    }
  }

  // 1. delete the old glyphs. Text only: artwork behind the line is left alone.
  const d = openPdf()
  const page = d.loadPage(index)
  const annot = page.createAnnotation('Redact')
  annot.setRect(rect)
  annot.update()
  page.applyRedactions(false, 0, 0, 0)
  commit(saveMupdf(d))
  try { page.destroy() } catch (e) {}

  // Clearing a line is a legitimate way to delete it.
  if (!next.trim()) return meta()

  // 2. draw the replacement on the same baseline.
  const doc = await loadLib(bytes)
  const font = await doc.embedFont(StandardFonts[faceName])
  const target = doc.getPage(index)
  const cb = target.getCropBox()
  const [r, g, b] = color.map((v) => Math.max(0, Math.min(1, Number(v) || 0)))
  target.drawText(next, {
    x: cb.x + x,
    y: cb.y + (cb.height - y),   // MuPDF baseline is top-left origin, pdf-lib bottom-left
    size,
    font,
    color: rgb(r, g, b),
  })
  commit(new Uint8Array(await doc.save()), { snapshot: false })   // same user action
  return meta()
}

// ---------------------------------------------------------------- scan clean-up
//
// A scanned book page is one big image whose "white" is really a light gray, with
// the paper tint, scanner shading and noise on top. Printing it lays ink over the
// whole page. This finds every page-sized image, estimates the paper colour from
// the pixels, and stretches the levels so the paper goes to pure white and the
// ink to black. The image is then swapped in place in the page's XObject
// resources, so the page's content stream, geometry and any OCR text layer are
// untouched. Nothing is rendered or re-rasterised.

// How far below the estimated paper colour a pixel may sit and still count as
// paper. Bigger clears more shading near the spine, at the cost of thinning
// light strokes.
const CLEAN_TOLERANCE = { light: 20, normal: 35, strong: 55 }

// A whitened page is stored as 8-bit gray (or RGB) with Flate. Lossless, and it
// compresses very well once most pixels are exactly 255. JPEG was rejected: its
// ringing puts a light gray halo back around every glyph, which is the ink the
// user was trying to save.
function whitenPixmap (src, { tolerance, gray }) {
  const w = src.getWidth(), h = src.getHeight()
  const st = src.getStride(), n = src.getNumberOfComponents()
  const alpha = src.getAlpha() ? 1 : 0
  const nc = n - alpha                          // colour components, 1 or 3
  const outGray = gray || nc === 1
  // Allocate the output BEFORE taking any pixel view. getPixels() returns a view
  // into wasm memory, and a large allocation can grow that memory, which detaches
  // every earlier view and silently leaves it empty.
  const out = new mupdf.Pixmap(outGray ? mupdf.ColorSpace.DeviceGray : mupdf.ColorSpace.DeviceRGB, [0, 0, w, h], false)
  const px = src.getPixels()
  const op = out.getPixels(), ost = out.getStride()
  const lum = nc >= 3
    ? (o) => (px[o] * 299 + px[o + 1] * 587 + px[o + 2] * 114) / 1000
    : (o) => px[o]

  // Paper estimate: the median of the bright population, sampled on a grid.
  // The median beats the histogram mode when scanner shading spreads the
  // paper across a wide range, and beats the mean because ink drags that down.
  const hist = new Uint32Array(256)
  let bright = 0, sampled = 0
  const step = Math.max(1, Math.floor(Math.sqrt((w * h) / 250000)))
  for (let y = 0; y < h; y += step) {
    for (let x = 0; x < w; x += step) {
      const l = lum(y * st + x * n) | 0
      hist[l]++
      sampled++
      if (l >= 128) bright++
    }
  }
  // A photo or a dark illustration is not paper. Levels would wreck it.
  if (bright < sampled * 0.5) { try { out.destroy() } catch (e) {} return null }

  let acc = 0, median = 255
  for (let i = 128; i < 256; i++) { acc += hist[i]; if (acc >= bright / 2) { median = i; break } }
  const white = Math.max(96, median - tolerance)
  const black = Math.round(white * 0.3)
  const lut = new Uint8Array(256)
  for (let i = 0; i < 256; i++) {
    lut[i] = i <= black ? 0 : i >= white ? 255 : Math.round(((i - black) * 255) / (white - black))
  }

  for (let y = 0; y < h; y++) {
    let o = y * st, q = y * ost
    for (let x = 0; x < w; x++, o += n) {
      if (outGray) {
        op[q++] = lut[lum(o) | 0]
      } else {
        op[q++] = lut[px[o]]; op[q++] = lut[px[o + 1]]; op[q++] = lut[px[o + 2]]
      }
    }
  }
  return { out, paper: median, white, black }
}

// Walk a resource dictionary's XObjects, recursing into Form XObjects, and hand
// every image reference to `visit`. `seen` stops shared resources being walked twice.
//
// Deliberately never calls ref.resolve(). Holding a resolved wrapper of an image
// that carries an /SMask across a garbage=compact save made MuPDF 1.28 write that
// object WITHOUT its stream, which silently erased the text layer of every MRC
// scan (background JPX + soft-masked foreground). Reading fields through the
// indirect reference itself (ref.get('Subtype')) is safe. See the regression test.
function eachImage (d, resources, visit, seen, depth = 0) {
  if (!resources || resources.isNull() || depth > 4) return
  let xobjs
  try { xobjs = resources.get('XObject') } catch (e) { return }
  if (!xobjs || xobjs.isNull() || !xobjs.isDictionary()) return
  const entries = []
  try { xobjs.forEach((val, key) => entries.push([String(key), val])) } catch (e) { return }
  for (const [key, ref] of entries) {
    if (!ref || ref.isNull()) continue
    let sub = ''
    try { sub = ref.get('Subtype').asName() } catch (e) {}
    if (sub === 'Form') {
      const id = ref.isIndirect() ? ref.asIndirect() : null
      if (id !== null) { if (seen.has('f' + id)) continue; seen.add('f' + id) }
      let inner = null
      try { inner = ref.get('Resources') } catch (e) {}
      eachImage(d, inner, visit, seen, depth + 1)
    } else if (sub === 'Image') {
      visit(xobjs, key, ref)
    }
  }
}

// Fraction of "ink" on a page: pixels well below the paper tone, where the paper
// tone is the page's median luminance. Relative to the median so that gray paper
// before and white paper after are compared on equal terms. Used to prove a
// clean-up kept the print before the result is committed.
function inkFraction (pdfBytes, index) {
  const d = mupdf.Document.openDocument(pdfBytes, 'application/pdf')
  const page = d.loadPage(index)
  const pix = page.toPixmap(mupdf.Matrix.scale(0.6, 0.6), mupdf.ColorSpace.DeviceGray, false)
  const px = pix.getPixels(), st = pix.getStride(), w = pix.getWidth(), h = pix.getHeight()
  const hist = new Uint32Array(256)
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) hist[px[y * st + x]]++
  let acc = 0, median = 255
  for (let i = 0; i < 256; i++) { acc += hist[i]; if (acc >= (w * h) / 2) { median = i; break } }
  const cut = Math.max(64, median - 60)
  let dark = 0
  for (let i = 0; i < cut; i++) dark += hist[i]
  const f = dark / Math.max(1, w * h)
  try { pix.destroy() } catch (e) {}
  try { page.destroy() } catch (e) {}
  try { d.destroy() } catch (e) {}
  return f
}

function cleanScan ({ indices, strength = 'normal', gray = true }) {
  // A fresh document rather than the render-cached one: nothing else has touched
  // its objects, so no stale wrapper can interfere with the save (see eachImage).
  const d = mupdf.Document.openDocument(bytes, 'application/pdf').asPDF()
  const tolerance = CLEAN_TOLERANCE[strength] || CLEAN_TOLERANCE.normal
  const pageList = Array.isArray(indices) && indices.length
    ? indices
    : Array.from({ length: d.countPages() }, (_, i) => i)

  const replaced = new Map()      // old object number -> new ref, for images shared across pages
  const seen = new Set()
  let images = 0, skipped = 0
  const pagesTouched = new Set()

  for (const idx of pageList) {
    const page = d.loadPage(idx)
    let resources = null
    try { resources = page.getObject().getInheritable('Resources') } catch (e) {}
    eachImage(d, resources, (dict, key, ref) => {
      const num = ref.isIndirect() ? ref.asIndirect() : null
      if (num !== null && replaced.has(num)) {
        dict.put(key, replaced.get(num))
        pagesTouched.add(idx)
        return
      }
      // Stencil masks are already pure black and white; soft-masked or
      // colour-keyed images would lose their transparency if rebuilt. In an MRC
      // scan the soft-masked image IS the text, so this skip is what keeps it.
      const has = (k) => { try { const v = ref.get(k); return !!(v && !v.isNull()) } catch (e) { return false } }
      let isMask = false
      try { const m = ref.get('ImageMask'); isMask = !!(m && !m.isNull() && m.asBoolean()) } catch (e) {}
      if (isMask || has('SMask') || has('Mask')) { skipped++; return }
      let wpx = 0, hpx = 0
      try { wpx = ref.get('Width').asNumber(); hpx = ref.get('Height').asNumber() } catch (e) {}
      if (wpx * hpx < 90000) { skipped++; return }      // a logo, not a page

      let img = null, pix = null, res = null
      try {
        img = d.loadImage(ref)
        pix = img.toPixmap()
        const cs = pix.getColorSpace()
        const nc = pix.getNumberOfComponents() - (pix.getAlpha() ? 1 : 0)
        // Anything that is not plain gray or RGB (CMYK, Indexed, ICC, Lab...) is
        // converted first so the maths below sees 1 or 3 bytes per pixel.
        const plain = cs && ((nc === 1 && cs.isGray()) || (nc === 3 && cs.isRGB()))
        if (!plain || pix.getAlpha()) {
          const conv = pix.convertToColorSpace(nc === 1 ? mupdf.ColorSpace.DeviceGray : mupdf.ColorSpace.DeviceRGB, false)
          try { pix.destroy() } catch (e) {}
          pix = conv
        }
        res = whitenPixmap(pix, { tolerance, gray })
      } catch (e) {
        res = null
      }
      if (!res) {
        skipped++
      } else {
        const newImg = new mupdf.Image(res.out)
        const newRef = d.addImage(newImg)
        dict.put(key, newRef)
        if (num !== null) replaced.set(num, newRef)
        images++
        pagesTouched.add(idx)
        try { res.out.destroy() } catch (e) {}
        try { newImg.destroy() } catch (e) {}
      }
      try { pix && pix.destroy() } catch (e) {}
      try { img && img.destroy() } catch (e) {}
    }, seen)
    try { page.destroy() } catch (e) {}
  }

  const sizeBefore = bytes.length
  if (images) {
    const next = saveMupdf(d)
    try { d.destroy() } catch (e) {}
    // Validate before committing: whitening must keep the print. If the first
    // touched page lost most of its ink, something other than paper was
    // erased, and the user keeps the original rather than a blank book.
    const first = Math.min(...pagesTouched)
    const before = inkFraction(bytes, first)
    const after = inkFraction(next, first)
    if (before > 0.001 && after < before * 0.3) {
      throw new Error(
        `Whitening would have erased the print on page ${first + 1} ` +
        `(ink ${(before * 100).toFixed(1)}% before, ${(after * 100).toFixed(1)}% after), so nothing was changed.`)
    }
    commit(next)
  } else {
    try { d.destroy() } catch (e) {}
  }
  return { images, skipped, pages: pagesTouched.size, sizeBefore, sizeAfter: bytes.length, meta: meta() }
}

// ---------------------------------------------------------------- make a book
//
// Lays pasted text out as a printable book with pdf-lib: title page, chapter
// headings on fresh pages, indented paragraphs, optional justification and page
// numbers. Everything is real text in the built-in WinAnsi fonts, so the result
// is searchable and tiny. See replaceLine() for the character-set caveat.

const PAGE_SIZES = {
  a4:     [595.28, 841.89],
  a5:     [419.53, 595.28],
  letter: [612, 792],
}

// Characters WinAnsi lacks but that have an obvious stand-in. Anything else that
// fails to encode is either refused or replaced with "?", the caller's choice.
const FALLBACK = {
  '\u00a0': ' ', '\u2000': ' ', '\u2001': ' ', '\u2002': ' ', '\u2003': ' ', '\u2004': ' ',
  '\u2005': ' ', '\u2006': ' ', '\u2007': ' ', '\u2008': ' ', '\u2009': ' ', '\u200a': ' ',
  '\u202f': ' ', '\u205f': ' ', '\u3000': ' ',
  '\u200b': '', '\u200c': '', '\u200d': '', '\u2060': '', '\ufeff': '', '\u00ad': '',
  '\u2010': '-', '\u2011': '-', '\u2012': '-', '\u2212': '-', '\u2015': '\u2014',
  '\u2032': "'", '\u2035': "'", '\u02bc': "'", '\u2033': '"', '\u2036': '"',
  '\u201a': ',', '\u201e': '"', '\u2016': '|', '\u2044': '/',
}

// Lines that are obviously headings in pasted plain text, when autoHeadings is on:
// a line entirely in capitals ("THE FIRST NOTEBOOK", "EPILOGUE"), a roman numeral
// on its own ("I", "IV"), or "Part One" / "Chapter 3" / "Book II".
const ROMAN = /^(?=[IVXLC])M{0,3}(CM|CD|D?C{0,3})(XC|XL|L?X{0,3})(IX|IV|V?I{0,3})\.?$/
const NUMWORD = '(?:one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|(?:twenty|thirty|forty|fifty)(?:-(?:one|two|three|four|five|six|seven|eight|nine))?|primera|segunda|tercera|cuarta|quinta|uno|dos|tres|cuatro|cinco|seis|siete|ocho|nueve|diez)'
const PART = new RegExp('^(part|book|chapter|capítulo|parte|libro)\\s+([ivxlc]+|\\d+|' + NUMWORD + ')\\b[^.]*$', 'i')
function looksLikeHeading (line) {
  if (line.length > 70) return false
  if (ROMAN.test(line)) return true
  if (PART.test(line)) return true
  const letters = line.replace(/[^\p{L}]/gu, '')
  return letters.length >= 3 && letters === letters.toUpperCase() && letters !== letters.toLowerCase()
}

// Turn the pasted text into a list of blocks the layout pass can consume.
//   mode 'lines': every line break starts a paragraph; a blank line adds a gap.
//   mode 'blank': paragraphs are separated by blank lines; single breaks are
//                 joined; two or more blank lines in a row add a gap.
// Lines starting with "# " / "## " are headings; "***", "* * *" or "---" alone on a
// line is a scene break. With autoHeadings, looksLikeHeading() lines are "# ".
function parseBook (text, mode, autoHeadings = false) {
  const lines = text.replace(/\r\n?/g, '\n').replace(/\t/g, ' ').split('\n').map((l) => l.replace(/\s+$/, ''))
  const blocks = []
  let gap = false
  let blanks = 0
  let buffer = []
  const flush = () => {
    if (buffer.length) {
      blocks.push({ kind: 'para', text: buffer.join(' ').replace(/ {2,}/g, ' ').trim(), gap })
      gap = false
    }
    buffer = []
  }
  for (const raw of lines) {
    const line = raw.trim()
    if (!line) {
      flush()
      blanks++
      // In blank-line mode one blank line is just the paragraph separator; it
      // takes a second to ask for visible space. In line mode any blank does.
      if (blocks.length && (mode !== 'blank' || blanks >= 2)) gap = true
      continue
    }
    blanks = 0
    let m
    if ((m = line.match(/^(#{1,2})\s+(.+)$/))) {
      flush()
      blocks.push({ kind: m[1].length === 1 ? 'h1' : 'h2', text: m[2].replace(/\s+#+$/, '') })
      gap = false
      continue
    }
    if (/^(\*\s*){3,}$|^-{3,}$|^_{3,}$/.test(line)) { flush(); blocks.push({ kind: 'break' }); gap = false; continue }
    if (autoHeadings && looksLikeHeading(line)) { flush(); blocks.push({ kind: 'h1', text: line }); gap = false; continue }
    if (mode === 'blank') buffer.push(line)
    else { buffer = [line]; flush() }
  }
  flush()
  return blocks
}

// layout (optional, from pageStyle()): { pageSize: [w, h], margins: { left, right,
// top, bottom }, leading, indent }. Anything present overrides the defaults.
async function makeBook ({ text, title = '', author = '', subtitle = '', size = 'a4', font = 'serif', fontSize = 11,
                           justify = true, pageNumbers = true, paragraphs = 'lines', unsupported = 'reject',
                           autoHeadings = false, runningHead = true, layout = null }) {
  const src = String(text == null ? '' : text)
  if (!src.trim()) throw new Error('Paste some text first.')
  const L = layout || {}
  const LM = L.margins || {}
  const num = (v, fallback) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : fallback)
  const [pw, ph] = Array.isArray(L.pageSize) && L.pageSize.length === 2
    ? [num(L.pageSize[0], 595.28), num(L.pageSize[1], 841.89)]
    : (PAGE_SIZES[size] || PAGE_SIZES.a4)
  const body = Math.max(7, Math.min(24, Number(fontSize) || 11))
  const faces = STD[font] || STD.serif

  const doc = await PDFDocument.create()
  const regular = await doc.embedFont(StandardFonts[faces[0]])
  const bold = await doc.embedFont(StandardFonts[faces[1]])
  const italic = await doc.embedFont(StandardFonts[faces[2]])

  // Character check BEFORE any layout, so a refusal costs nothing and the message
  // can list exactly what the built-in fonts cannot draw.
  let substituted = 0
  const bad = new Map()
  const ok = new Set()
  const clean = (str) => {
    let out = ''
    for (const ch of str) {
      if (ch in FALLBACK) { out += FALLBACK[ch]; substituted++; continue }
      const code = ch.codePointAt(0)
      if (code < 0x80 || ok.has(ch)) { out += ch; continue }
      if (bad.has(ch)) { bad.set(ch, bad.get(ch) + 1); out += '?'; continue }
      try { regular.widthOfTextAtSize(ch, 10); ok.add(ch); out += ch }
      catch (e) { bad.set(ch, 1); out += '?' }
    }
    return out
  }
  const blocks = parseBook(src, paragraphs, autoHeadings).map((b) => b.text == null ? b : { ...b, text: clean(b.text) })
  const cleanTitle = clean(title.trim()), cleanAuthor = clean(author.trim()), cleanSubtitle = clean(subtitle.trim())
  if (bad.size && unsupported !== 'replace') {
    const total = [...bad.values()].reduce((a, b) => a + b, 0)
    const list = [...bad.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12)
      .map(([ch, n]) => `${JSON.stringify(ch)}×${n}`).join(' ')
    throw new Error(
      `The built-in fonts cover Western European text only. ${total} character${total === 1 ? '' : 's'} ` +
      `cannot be drawn: ${list}${bad.size > 12 ? ' …' : ''}. Fix the text, or tick "replace unsupported characters".`)
  }
  substituted += [...bad.values()].reduce((a, b) => a + b, 0)

  // Geometry. Margins scale with the page so A5 does not end up all margin,
  // unless a measured layout says otherwise.
  const margin = Math.round(pw * 0.11)
  const mL = num(LM.left, margin), mR = num(LM.right, margin)
  const mT = num(LM.top, Math.round(margin * 1.0)), mB = num(LM.bottom, Math.round(margin * 1.15))
  const top = ph - mT
  const bottom = mB
  const headY = ph - Math.round(mT * 0.55)   // running head baseline
  const headRoom = mT >= body * 2.2           // a tight top margin has no room for one
  const width = pw - mL - mR
  if (width < body * 8 || top - bottom < body * 6) throw new Error('That layout leaves no room for text.')
  const lead = num(L.leading, body * 1.38)
  const indent = LM && Number.isFinite(Number(L.indent)) ? Math.max(0, Number(L.indent)) : body * 1.6
  const H1 = body * 1.8, H2 = body * 1.3

  const widthCache = new Map()
  const measure = (f, s, w) => {
    const k = f === bold ? 'b' + s + w : f === italic ? 'i' + s + w : 'r' + s + w
    let v = widthCache.get(k)
    if (v === undefined) { v = f.widthOfTextAtSize(w, s); widthCache.set(k, v) }
    return v
  }

  // Break one paragraph into lines. Returns [{ words, width, last }].
  function wrap (str, f, s, firstIndent) {
    const spaceW = measure(f, s, ' ')
    const words = str.split(' ').filter(Boolean)
    const out = []
    let cur = [], curW = 0, avail = width - firstIndent
    const push = (last) => { out.push({ words: cur, width: curW, last, indent: out.length ? 0 : firstIndent }); cur = []; curW = 0; avail = width }
    for (let w of words) {
      let ww = measure(f, s, w)
      // A single word wider than the line is split by characters.
      while (ww > avail && w.length > 1) {
        let cut = w.length - 1
        while (cut > 1 && measure(f, s, w.slice(0, cut)) > avail - (cur.length ? spaceW + curW : 0)) cut--
        if (cur.length) push(false)
        cur = [w.slice(0, cut)]; curW = measure(f, s, cur[0]); push(false)
        w = w.slice(cut); ww = measure(f, s, w)
      }
      const need = cur.length ? curW + spaceW + ww : ww
      if (need > avail && cur.length) push(false)
      curW = cur.length ? curW + spaceW + ww : ww
      cur.push(w)
    }
    if (cur.length) push(true)
    return out
  }

  let page = null, y = 0, pageIndex = 0
  const words = src.split(/\s+/).filter(Boolean).length
  const numberSize = body * 0.85

  // The number is stamped when the page is finished, not when it is started, so
  // it comes last in the content stream: text extraction and screen readers then
  // read the body before the folio instead of starting every page with a digit.
  let opener = false           // this page starts a chapter: no running head
  function stampNumber () {
    if (!page || (cleanTitle && pageIndex === 1)) return
    if (pageNumbers) {
      const label = String(pageIndex)
      page.drawText(label, { x: (pw - measure(regular, numberSize, label)) / 2, y: bottom * 0.45, size: numberSize, font: regular })
    }
    if (runningHead && headRoom && cleanTitle && !opener) {
      const headSize = body * 0.8
      const lbl = cleanTitle.length > 60 ? cleanTitle.slice(0, 57) + '...' : cleanTitle
      page.drawText(lbl, { x: (pw - measure(italic, headSize, lbl)) / 2, y: headY, size: headSize, font: italic, color: rgb(0.35, 0.35, 0.35) })
    }
  }
  function newPage (isOpener = false) {
    stampNumber()
    page = doc.addPage([pw, ph])
    pageIndex++
    y = top
    opener = isOpener
  }
  const ensure = (needed) => { if (!page || y - needed < bottom) newPage() }

  function drawLine (ln, f, s, justified) {
    const x = mL + ln.indent
    const str = ln.words.join(' ')
    const gaps = ln.words.length - 1
    if (justified && !ln.last && gaps > 0) {
      const extra = (width - ln.indent - ln.width) / gaps
      // Tw is text state: set it around drawText's own BT/ET so every space on
      // this line stretches, then restore.
      page.pushOperators(pushGraphicsState(), setWordSpacing(extra))
      page.drawText(str, { x, y, size: s, font: f })
      page.pushOperators(popGraphicsState())
    } else {
      page.drawText(str, { x, y, size: s, font: f })
    }
  }

  // Title page.
  if (cleanTitle) {
    newPage()
    const tSize = body * 2.4
    let ty = ph * 0.6
    for (const ln of wrap(cleanTitle, bold, tSize, 0)) {
      page.drawText(ln.words.join(' '), { x: (pw - ln.width) / 2, y: ty, size: tSize, font: bold })
      ty -= tSize * 1.2
    }
    if (cleanAuthor) {
      ty -= body * 1.5
      for (const ln of wrap(cleanAuthor, italic, body * 1.25, 0)) {
        page.drawText(ln.words.join(' '), { x: (pw - ln.width) / 2, y: ty, size: body * 1.25, font: italic })
        ty -= body * 1.6
      }
    }
    if (cleanSubtitle) {
      ty -= body * 0.6
      for (const ln of wrap(cleanSubtitle, regular, body * 0.95, 0)) {
        page.drawText(ln.words.join(' '), { x: (pw - ln.width) / 2, y: ty, size: body * 0.95, font: regular, color: rgb(0.35, 0.35, 0.35) })
        ty -= body * 1.3
      }
    }
    page = null   // the body starts on a fresh page (title page carries no number)
  }

  let afterHeading = true
  for (const b of blocks) {
    if (b.kind === 'h1') {
      // A chapter opens on a fresh page with the title centred a fifth of the
      // way down, the way a printed novel does it, then the text follows.
      newPage(true)
      y = top - ph * 0.12
      for (const ln of wrap(b.text, bold, H1, 0)) {
        page.drawText(ln.words.join(' '), { x: (pw - ln.width) / 2, y, size: H1, font: bold })
        y -= H1 * 1.25
      }
      y -= lead * 1.6
      afterHeading = true
    } else if (b.kind === 'h2') {
      ensure(H2 * 3 + lead * 2)      // never strand a subheading at the foot of a page
      // y sits at the top of the next line box, so step down a full heading
      // height before drawing the baseline, or it lands on the paragraph above.
      y -= lead * 0.7 + H2
      for (const ln of wrap(b.text, bold, H2, 0)) { drawLine(ln, bold, H2, false); y -= H2 * 1.3 }
      afterHeading = true
    } else if (b.kind === 'break') {
      ensure(lead * 3)
      y -= lead * 0.6 + body            // same reason as the subheading above
      const mark = '*  *  *'
      page.drawText(mark, { x: (pw - measure(regular, body, mark)) / 2, y, size: body, font: regular })
      y -= lead * 1.2
      afterHeading = true
    } else {
      if (!b.text) continue
      if (b.gap && !afterHeading) { ensure(lead); y -= lead * 0.5 }
      const lines = wrap(b.text, regular, body, afterHeading ? 0 : indent)
      for (const ln of lines) {
        ensure(lead)
        y -= body
        drawLine(ln, regular, body, justify)
        y -= lead - body
      }
      afterHeading = false
    }
  }
  if (!page) newPage()
  stampNumber()

  doc.setProducer('PDF Scrub')
  doc.setCreator('PDF Scrub')
  if (cleanTitle) doc.setTitle(cleanTitle)
  if (cleanAuthor) doc.setAuthor(cleanAuthor)

  undoStack.length = 0
  commit(new Uint8Array(await doc.save()), { snapshot: false })
  return { meta: meta(), words, paragraphs: blocks.filter((b) => b.kind === 'para').length, substituted }
}

// ---------------------------------------------------------------- reading a layout back
//
// A scanned book with an OCR text layer, or any real-text PDF, describes its own
// typography: where the lines sit gives the margins, the baseline spacing gives
// the leading, the glyph size gives the body size, the first-line offset gives
// the indent. pageStyle() measures those so makeBook() can reproduce the page.
// The typeface itself cannot be read from a scan (OCR layers use an invisible
// GlyphLessFont), so `family` is reported only when the PDF carries real fonts.

const median = (arr) => {
  if (!arr.length) return null
  const a = [...arr].sort((x, y) => x - y)
  return a[a.length >> 1]
}
const modeOf = (arr, step = 1) => {
  if (!arr.length) return null
  const counts = new Map()
  for (const v of arr) { const k = Math.round(v / step) * step; counts.set(k, (counts.get(k) || 0) + 1) }
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0]
}

// Lines of one page, with fragments on the same baseline merged left to right.
function pageLines (page) {
  const st = page.toStructuredText()
  const raw = []
  let cur = null
  st.walk({
    beginLine (bbox) { cur = { bbox: [...bbox], text: '', chars: 0 } },
    onChar (c, origin, font, size) {
      if (!cur) return
      if (!cur.chars) {
        cur.x = origin[0]; cur.y = origin[1]; cur.size = size
        try { cur.name = font.getName(); cur.serif = font.isSerif(); cur.mono = font.isMono() } catch (e) {}
      }
      cur.text += c
      cur.chars++
    },
    endLine () { if (cur && cur.text.trim()) raw.push(cur); cur = null },
  })
  try { st.destroy() } catch (e) {}
  raw.sort((a, b) => (Math.abs(a.y - b.y) < 2 ? a.bbox[0] - b.bbox[0] : a.y - b.y))
  const lines = []
  for (const ln of raw) {
    const prev = lines[lines.length - 1]
    if (prev && Math.abs(prev.y - ln.y) < 2 && ln.bbox[0] >= prev.bbox[2] - 2) {
      prev.text = prev.text.replace(/\s+$/, '') + ' ' + ln.text.replace(/^\s+/, '')
      prev.bbox[2] = Math.max(prev.bbox[2], ln.bbox[2])
      prev.bbox[1] = Math.min(prev.bbox[1], ln.bbox[1]); prev.bbox[3] = Math.max(prev.bbox[3], ln.bbox[3])
      prev.chars += ln.chars
    } else {
      lines.push(ln)
    }
  }
  return lines
}

const isFolio = (ln) => /^\s*[\divxlc]{1,4}\s*$/i.test(ln.text)

// Running heads repeat verbatim on page after page, at the very top or bottom.
// Both conditions matter: a body line such as "\u2014S\u00ed." also recurs on many
// pages, and dropping it would tear a hole in the text. Returns a Set of the
// texts to ignore.
function runningHeads (d, indices) {
  const seenOn = new Map()
  for (const idx of indices) {
    const page = d.loadPage(idx)
    const b = page.getBounds()
    const ph = b[3] - b[1]
    const lines = pageLines(page)
    try { page.destroy() } catch (e) {}
    const edge = new Set()
    for (const ln of lines) {
      const t = ln.text.trim()
      if (!t || t.length >= 80 || isFolio(ln)) continue
      if (ln.y < b[1] + ph * 0.12 || ln.y > b[3] - ph * 0.12) edge.add(t)
    }
    for (const t of edge) seenOn.set(t, (seenOn.get(t) || 0) + 1)
  }
  const heads = new Set()
  for (const [t, n] of seenOn) if (n >= 3 && n >= indices.length * 0.3) heads.add(t)
  return heads
}
const isFurniture = (ln, heads) => isFolio(ln) || heads.has(ln.text.trim())

function samplePages (total) {
  // skip front matter and the last leaves; sample up to 12 pages spread evenly
  const lo = Math.min(total - 1, total > 8 ? 3 : 0), hi = total > 8 ? total - 2 : total - 1
  const n = Math.min(12, hi - lo + 1)
  const out = []
  for (let i = 0; i < n; i++) out.push(Math.round(lo + (i * (hi - lo)) / Math.max(1, n - 1)))
  return [...new Set(out)]
}

function pageStyle () {
  const d = openPdf()
  const total = d.countPages()
  const widths = [], heights = [], sizes = [], leads = [], lefts = [], rights = [], tops = [], bottoms = [], indents = []
  let justifiedLines = 0, fullLines = 0, folios = 0, serifVotes = 0, sansVotes = 0, monoVotes = 0, realFont = false
  let pagesRead = 0
  const sample = samplePages(total)
  const heads = runningHeads(d, sample)
  for (const idx of sample) {
    const page = d.loadPage(idx)
    const b = page.getBounds()
    const pw = b[2] - b[0], ph = b[3] - b[1]
    const lines = pageLines(page).filter((ln) => {
      if (isFolio(ln)) { folios++; return false }
      return !heads.has(ln.text.trim())
    })
    try { page.destroy() } catch (e) {}
    if (lines.length < 4) continue
    pagesRead++
    widths.push(pw); heights.push(ph)
    for (const ln of lines) {
      for (let i = 0; i < Math.min(ln.chars, 200); i++) sizes.push(ln.size)
      if (ln.name && !/glyphless|invisible/i.test(ln.name)) { realFont = true; if (ln.mono) monoVotes++; else if (ln.serif) serifVotes++; else sansVotes++ }
    }
    const body = median(sizes) || 10
    const bodyLines = lines.filter((ln) => Math.abs(ln.size - body) < body * 0.35)
    if (bodyLines.length < 3) continue
    // Left edge: the most common start x among body lines. Right edge: the most
    // common end x among long lines.
    const left = modeOf(bodyLines.map((ln) => ln.bbox[0]), 2)
    const longLines = bodyLines.filter((ln) => ln.bbox[2] - ln.bbox[0] > pw * 0.45)
    const right = longLines.length ? modeOf(longLines.map((ln) => ln.bbox[2]), 2) : null
    lefts.push(left)
    if (right) rights.push(pw - right)
    tops.push(Math.min(...lines.map((ln) => ln.bbox[1])))
    bottoms.push(ph - Math.max(...bodyLines.map((ln) => ln.y)))
    for (let i = 1; i < bodyLines.length; i++) {
      const dy = bodyLines[i].y - bodyLines[i - 1].y
      if (dy > body * 0.9 && dy < body * 2.2) leads.push(dy)
    }
    for (const ln of bodyLines) {
      const off = ln.bbox[0] - left
      if (off > body * 0.4 && off < body * 5) indents.push(off)
      if (right && ln.bbox[2] - ln.bbox[0] > pw * 0.45) { fullLines++; if (Math.abs(ln.bbox[2] - right) < 3) justifiedLines++ }
    }
  }
  if (pagesRead < 1) throw new Error('This PDF has no text layer to measure. A scan needs OCR first.')
  const body = Math.round((median(sizes) || 10) * 2) / 2
  const leading = leads.length ? Math.round(median(leads) * 2) / 2 : Math.round(body * 1.38 * 2) / 2
  const pageSize = [Math.round(median(widths) * 10) / 10, Math.round(median(heights) * 10) / 10]
  const margins = {
    left: Math.round(median(lefts) || pageSize[0] * 0.11),
    right: Math.round((rights.length ? median(rights) : null) || pageSize[0] * 0.11),
    top: Math.round(median(tops) || pageSize[1] * 0.08),
    bottom: Math.round(median(bottoms) || pageSize[1] * 0.09),
  }
  const indent = indents.length >= 3 ? Math.round(modeOf(indents, 1)) : 0
  const justify = fullLines >= 5 && justifiedLines / fullLines > 0.5
  const pageNumbers = folios >= Math.max(2, pagesRead / 2)
  const family = realFont ? (monoVotes > serifVotes + sansVotes ? 'mono' : serifVotes >= sansVotes ? 'serif' : 'sans') : null
  return { pageSize, margins, fontSize: body, leading, indent, justify, pageNumbers, family, pagesRead }
}

// The document's text layer as plain text with blank lines between paragraphs,
// ready for makeBook in blank-line mode. A new paragraph starts on an indented
// line, after a vertical gap, or after a short line that ends a sentence.
// Hyphenated line ends ("comien-" / "do") are re-joined. Page numbers dropped.
function extractText () {
  const d = openPdf()
  const total = d.countPages()
  let style = null
  try { style = pageStyle() } catch (e) {}
  const body = style ? style.fontSize : 10
  // Glyph sizes in an OCR layer wobble by 20% from line to line, so only a PDF
  // with real fonts can have headings detected from size. A scan's chapter
  // titles are left for the "#" marker or the CAPS/roman-numeral detection.
  const exactSizes = !!(style && style.family)
  const paras = []
  let cur = ''
  let prev = null
  // Cover pages and blank leaves OCR into confetti like "==" or "0 YM"; keep a
  // paragraph only if it is mostly letters.
  const isText = (t) => {
    const letters = (t.match(/\p{L}/gu) || []).length
    const solid = t.replace(/\s+/g, '').length
    return letters >= 3 && letters / Math.max(1, solid) >= 0.5
  }
  const flush = () => { const t = cur.trim(); if (t && isText(t)) paras.push(t); cur = '' }
  const heads = runningHeads(d, samplePages(total))
  for (let i = 0; i < total; i++) {
    const page = d.loadPage(i)
    const lines = pageLines(page).filter((ln) => !isFurniture(ln, heads))
    try { page.destroy() } catch (e) {}
    const left = lines.length ? modeOf(lines.map((ln) => ln.bbox[0]), 2) : 0
    const right = lines.length ? Math.max(...lines.map((ln) => ln.bbox[2])) : 0
    let first = true
    for (const ln of lines) {
      const text = ln.text.replace(/\s+/g, ' ').trim()
      if (!text) continue
      const heading = exactSizes && ln.size >= body * 1.25 && text.length < 80
      const indented = ln.bbox[0] - left > body * 0.4
      const gap = prev && !first && (ln.y - prev.y) > body * 2.2
      const prevEnded = prev && /[.!?…»”"]$/.test(prev.text.trim())
      const prevShort = prevEnded && prev.bbox[2] < right - body * 3
      // A dash-led line after a finished sentence is a new speaker, even when
      // the OCR lost its indent.
      const dialogue = prevEnded && /^[-–—]/.test(text)
      if (heading) { flush(); if (isText(text)) paras.push('# ' + text); prev = ln; first = false; continue }
      if (indented || gap || prevShort || dialogue || (prev && prev.heading)) flush()
      if (cur && /[A-Za-zÀ-ÿ]-$/.test(cur) && /^[a-zà-ÿ]/.test(text)) cur = cur.slice(0, -1) + text
      else cur = cur ? cur + ' ' + text : text
      prev = { ...ln, heading: false }
      first = false
    }
    // a page break inside a paragraph is not a paragraph break: keep `cur` open
  }
  flush()
  return { text: paras.join('\n\n'), paragraphs: paras.length, style }
}

// ---------------------------------------------------------------- safety scan
//
// PDFs can carry JavaScript, auto-run actions, launch actions and embedded
// files. We walk every indirect object rather than grepping the raw bytes,
// because most objects live inside compressed object streams where a keyword
// search finds nothing at all.

const RISK = {
  JS:           ['active', 'JavaScript action payload'],
  JavaScript:   ['active', 'document-level JavaScript'],
  OpenAction:   ['active', 'runs automatically when the file opens'],
  AA:           ['active', 'additional actions (page open, field triggers)'],
  Launch:       ['active', 'launches an external application'],
  SubmitForm:   ['active', 'submits form data to a URL'],
  ImportData:   ['active', 'imports data from a file'],
  GoToR:        ['active', 'jumps into a remote document'],
  GoToE:        ['active', 'jumps into an embedded document'],
  RichMedia:    ['active', 'embedded Flash or video media'],
  XFA:          ['active', 'XFA form, which has its own scripting engine'],
  EmbeddedFile: ['embed',  'a file embedded inside the PDF'],
  EF:           ['embed',  'embedded-file reference'],
  Filespec:     ['embed',  'file specification carrying an embedded payload'],
  FileRef:      ['info',   'reference to an external file, no embedded payload'],
  Screen:       ['active', 'screen annotation'],
  '3D':         ['active', '3D annotation'],
  URI:          ['info',   'external link'],
  AcroForm:     ['info',   'interactive form'],
  Movie:        ['info',   'movie annotation'],
  Sound:        ['info',   'sound annotation'],
}

const STRIPPABLE = ['JS', 'JavaScript', 'OpenAction', 'AA', 'Launch', 'SubmitForm',
                    'ImportData', 'GoToR', 'GoToE', 'RichMedia', 'XFA', 'EmbeddedFile', 'EF']

function walkRisks (d, onHit) {
  const total = d.countObjects()
  for (let num = 1; num < total; num++) {
    let obj
    try { obj = d.newIndirect(num).resolve() } catch (e) { continue }
    if (!obj || obj.isNull() || !obj.isDictionary()) continue
    try {
      obj.forEach((val, key) => {
        const k = String(key)
        if (RISK[k]) onHit(k, num, obj)
        if ((k === 'S' || k === 'Subtype' || k === 'Type') && val && !val.isNull()) {
          let name = null
          try { name = val.asName() } catch (e) {}
          if (name && RISK[name]) onHit(name, num, obj)
        }
      })
    } catch (e) {}
  }
}

function summarise (counts) {
  const out = { active: [], embed: [], info: [], urls: [] }
  for (const [label, n] of counts) {
    const [sev, why] = RISK[label]
    out[sev].push({ key: label, count: n, why })
  }
  for (const k of ['active', 'embed', 'info']) out[k].sort((a, b) => b.count - a.count)
  return out
}

function inspect () {
  const d = openPdf()
  const counts = new Map()
  const urls = new Set()
  walkRisks(d, (label, num, obj) => {
    let key = label
    if (label === 'Filespec') {
      let hasPayload = false
      try { const ef = obj.get('EF'); hasPayload = !!(ef && !ef.isNull()) } catch (e) {}
      if (!hasPayload) key = 'FileRef'
    }
    counts.set(key, (counts.get(key) || 0) + 1)
    if (key === 'URI' && urls.size < 50) {
      try { const u = obj.get('URI'); if (u && !u.isNull()) urls.add(u.asString()) } catch (e) {}
    }
  })
  const report = summarise([...counts])
  report.urls = [...urls]
  report.objects = d.countObjects()
  return report
}

function sanitize () {
  const d = openPdf()
  let removed = 0
  const total = d.countObjects()
  for (let num = 1; num < total; num++) {
    let obj
    try { obj = d.newIndirect(num).resolve() } catch (e) { continue }
    if (!obj || obj.isNull() || !obj.isDictionary()) continue
    for (const k of STRIPPABLE) {
      try {
        const v = obj.get(k)
        if (v && !v.isNull()) { obj.delete(k); removed++ }
      } catch (e) {}
    }
  }
  // The catalog holds the document-level JavaScript name tree and the XFA form.
  try {
    const root = d.getTrailer().get('Root')
    const drop = (parent, key) => {
      if (!parent || parent.isNull()) return
      try {
        const v = parent.get(key)
        if (v && !v.isNull()) { parent.delete(key); removed++ }
      } catch (e) {}
    }
    drop(root, 'OpenAction')
    drop(root, 'AA')
    try { drop(root.get('Names'), 'JavaScript') } catch (e) {}
    try { drop(root.get('AcroForm'), 'XFA') } catch (e) {}
  } catch (e) {}

  if (removed) {
    // garbage=deduplicate drops objects nothing references any more, so the
    // stripped payloads are not left orphaned inside the file.
    let buf
    try { buf = d.saveToBuffer('compress=yes,garbage=deduplicate,sanitize=yes') }
    catch (e) { buf = d.saveToBuffer('compress=yes,garbage=compact') }
    const next = copyOut(buf.asUint8Array())
    try { buf.destroy() } catch (e) {}
    commit(next)
  }
  return { removed, report: inspect(), meta: meta() }
}

function undo () {
  if (!undoStack.length) throw new Error('Nothing to undo.')
  bytes = undoStack.pop()
  dropDoc()
  return meta()
}

// ---------------------------------------------------------------- dispatch

const handlers = {
  load: ({ bytes: b }) => {
    undoStack.length = 0
    commit(new Uint8Array(b), { snapshot: false })
    // Normalise through MuPDF before anything else touches the file. MuPDF
    // decrypts correctly; pdf-lib (which handles the structural edits) does not,
    // and ebooks are often encrypted with an empty user password, so the file can
    // look unprotected while its streams are not. Re-saving here removes that trap
    // and also repairs minor structural damage.
    commit(saveMupdf(openPdf()), { snapshot: false })
    return meta()
  },
  meta,
  render: ({ index, scale }) => render(index, scale),
  scan: ({ needles }) => scan(needles),
  strip: ({ needles }) => strip(needles),
  redactRect: ({ index, rect, killGraphics }) => redactRect(index, rect, killGraphics),
  moveRegion: (m) => moveRegion(m),
  pageOps: (m) => pageOps(m),
  append: ({ bytes: b }) => append(new Uint8Array(b)),
  extract: ({ indices }) => extract(indices),
  inspect,
  sanitize,
  textLines,
  replaceLine,
  cleanScan,
  makeBook,
  pageStyle,
  extractText,
  download: () => ({ bytes: new Uint8Array(bytes) }),
  undo,
}

self.onmessage = async (ev) => {
  const { id, type, ...rest } = ev.data
  try {
    const fn = handlers[type]
    if (!fn) throw new Error('Unknown operation: ' + type)
    const result = await fn(rest)
    // Transfer any big buffers rather than copying them across the boundary again.
    const transfer = []
    if (result && result.png) transfer.push(result.png.buffer)
    if (result && result.bytes) transfer.push(result.bytes.buffer)
    self.postMessage({ id, ok: true, result }, transfer)
  } catch (err) {
    self.postMessage({ id, ok: false, error: String((err && err.message) || err) })
  }
}

self.postMessage({ ready: true })
