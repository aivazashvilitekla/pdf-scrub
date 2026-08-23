// All PDF work happens here, off the main thread.
//
// Division of labour:
//   MuPDF WASM (AGPL) - text search, true redaction, page rendering.
//   pdf-lib (MIT)     - structural edits: reorder, delete, rotate, merge, split,
//                       and lifting a region onto another page via a Form XObject.
//
// Coordinate systems, the thing most likely to bite:
//   MuPDF page space  - origin TOP-LEFT, y grows downward. All rects crossing the
//                       worker boundary use this, because it matches the rendered canvas.
//   pdf-lib user space - origin BOTTOM-LEFT, y grows upward. Converted only inside
//                       moveRegion(), against the page's CropBox (which is what MuPDF renders).

import * as mupdf from './vendor/mupdf/mupdf.js'
import { PDFDocument, degrees } from './vendor/pdf-lib.esm.min.js'

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
