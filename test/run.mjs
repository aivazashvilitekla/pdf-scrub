// Zero-dependency test suite. Drives the real worker.js in Node with a fake
// worker scope, using only the libraries already vendored into the site.
//
//   node test/run.mjs
//
// The Cyrillic fixture is a checked-in 3-page PDF carrying the hispanoteca
// watermark four times; the marker fixture is generated here.

import fs from 'node:fs'
import path from 'node:path'
import * as mupdf from '../vendor/mupdf/mupdf.js'
import { PDFDocument, StandardFonts } from '../vendor/pdf-lib.esm.min.js'

const HERE = path.dirname(new URL(import.meta.url).pathname)
const PHRASE = 'Книги на испанском от hispanoteca.ru'

// ---------------------------------------------------------------- harness
const replies = new Map()
let seq = 0
globalThis.self = {
  onmessage: null,
  postMessage (m) {
    if (m.ready) return
    const r = replies.get(m.id)
    if (r) { replies.delete(m.id); m.ok ? r.resolve(m.result) : r.reject(new Error(m.error)) }
  },
}
await import('../worker.js')

const call = (type, payload = {}) => new Promise((resolve, reject) => {
  const id = ++seq
  replies.set(id, { resolve, reject })
  globalThis.self.onmessage({ data: { id, type, ...payload } })
})

const textOf = (bytes) => {
  const d = mupdf.Document.openDocument(bytes, 'application/pdf')
  return Array.from({ length: d.countPages() }, (_, i) => d.loadPage(i).toStructuredText().asText())
}

let pass = 0, fail = 0
const check = (label, cond, extra = '') => {
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${extra ? '  ' + extra : ''}`)
  cond ? pass++ : fail++
}
const group = (t) => console.log(`\n--- ${t} ---`)

// ---------------------------------------------------------------- watermark stripping
const cyrillic = new Uint8Array(fs.readFileSync(path.join(HERE, 'fixture-cyrillic.pdf')))

group('load and inspect')
let meta = await call('load', { bytes: cyrillic.slice().buffer })
check('3 pages', meta.pageCount === 3)
check('page geometry read', Math.round(meta.pages[0].w) === 595 && Math.round(meta.pages[0].h) === 842)
check('no rotation', meta.pages.every((p) => p.rotate === 0))

group('scan does not mutate')
let r = await call('scan', { needles: [PHRASE] })
check('finds all 4 occurrences', r.total === 4, JSON.stringify(r.perPage))
check('file untouched', (await call('meta')).size === meta.size)

group('render')
const img = await call('render', { index: 0, scale: 0.5 })
check('PNG produced', img.png.length > 500 && img.png[0] === 0x89, `${img.w}x${img.h}`)

group('strip')
r = await call('strip', { needles: [PHRASE] })
check('stripped 4', r.total === 4)
let cur = (await call('download')).bytes
check('phrase no longer extractable', !textOf(cur).some((t) => t.includes('hispanoteca')))
check('surrounding text survived', textOf(cur)[0].includes('Lola Lago'))

group('page operations')
meta = await call('pageOps', { order: [0, 1, 2], rotate: { 1: 90 } })
check('rotate applied in place', meta.pages[1].rotate === 90)
meta = await call('pageOps', { order: [2, 1, 0] })
check('reorder keeps 3 pages', meta.pageCount === 3)
check('reorder moved old p3 first', textOf((await call('download')).bytes)[0].includes('debe sobrevivir'))
meta = await call('pageOps', { order: [0, 1] })
check('delete leaves 2', meta.pageCount === 2)
meta = await call('undo')
check('undo restores 3', meta.pageCount === 3)

group('extract and merge')
const ex = await call('extract', { indices: [0] })
check('single page exported', textOf(ex.bytes).length === 1)
check('working document unchanged', (await call('meta')).pageCount === 3)
check('merge doubles page count', (await call('append', { bytes: cyrillic.slice() })).pageCount === 6)

group('errors are reported, not swallowed')
try { await call('nonsense'); check('unknown op rejects', false) }
catch (e) { check('unknown op rejects', /Unknown operation/.test(e.message)) }
try { await call('moveRegion', { srcIdx: 0, rect: [10, 10, 11, 11], dstIdx: 1, dstXY: [0, 0] }); check('tiny selection rejects', false) }
catch (e) { check('tiny selection rejects', /too small/.test(e.message)) }

// ---------------------------------------------------------------- moving a region
group('move a region between pages')
const md = await PDFDocument.create()
const font = await md.embedFont(StandardFonts.Helvetica)
const A = md.addPage([400, 600])
A.drawText('KEEPME-inside-selection', { x: 40, y: 500, size: 14, font })
A.drawText('LEAKME-outside-selection', { x: 40, y: 200, size: 14, font })
const B = md.addPage([400, 600])
B.drawText('TARGET-page-original', { x: 40, y: 550, size: 14, font })
const markers = new Uint8Array(await md.save())
const RECT = [30, 86, 300, 106]        // the KEEPME line, in MuPDF top-left points

await call('load', { bytes: markers.slice().buffer })
await call('moveRegion', { srcIdx: 0, rect: RECT, dstIdx: 1, dstXY: [40, 260], deleteOriginal: true })
let t = textOf((await call('download')).bytes)
check('selection arrived as real text', t[1].includes('KEEPME'))
check('selection removed from source', !t[0].includes('KEEPME'))
check('content outside selection did not travel', !t[1].includes('LEAKME'))
check('content outside selection was not destroyed', t[0].includes('LEAKME'))
check('target page original content intact', t[1].includes('TARGET'))

await call('load', { bytes: markers.slice().buffer })
await call('moveRegion', { srcIdx: 0, rect: RECT, dstIdx: 1, dstXY: [40, 260], deleteOriginal: false })
t = textOf((await call('download')).bytes)
check('keep-original leaves a copy behind', t[0].includes('KEEPME') && t[1].includes('KEEPME'))

group('redact an arbitrary area')
await call('load', { bytes: markers.slice().buffer })
await call('redactRect', { index: 0, rect: RECT, killGraphics: true })
t = textOf((await call('download')).bytes)
check('area contents removed', !t[0].includes('KEEPME'))
check('rest of the page untouched', t[0].includes('LEAKME'))

// ---------------------------------------------------------------- CSS/DOM guard
//
// Every overlay in this app is shown and hidden with the `hidden` attribute.
// [hidden] { display: none } in the browser's own stylesheet has specificity
// 0,1,0 - identical to a class selector - so an author rule such as
// `.busy { display: grid }` wins on cascade order and pins the element on screen
// permanently. That shipped once and made the app look frozen behind a dead
// "Working..." overlay, so it is worth a test even though no browser runs here.
group('CSS cannot defeat the hidden attribute')
const css = fs.readFileSync(path.join(HERE, '..', 'styles.css'), 'utf8')
const html = fs.readFileSync(path.join(HERE, '..', 'index.html'), 'utf8')
const js = fs.readFileSync(path.join(HERE, '..', 'app.js'), 'utf8')

const globalRule = /\[hidden\]\s*\{[^}]*display:\s*none\s*!important/.test(css)
check('a global [hidden] display:none !important rule exists', globalRule)

// Cross-check: for every id toggled via .hidden, does its class declare a display?
const toggled = [...new Set([...js.matchAll(/\$\('([a-z-]+)'\)\.hidden/g)].map((m) => m[1]))]
check('found the elements toggled via .hidden', toggled.length > 0, toggled.join(', '))

const conflicts = []
for (const id of toggled) {
  const tag = html.match(new RegExp(`<[^>]*id="${id}"[^>]*>`))
  if (!tag) continue
  const cls = (tag[0].match(/class="([^"]*)"/) || [, ''])[1].split(/\s+/).filter(Boolean)
  for (const c of cls) {
    const rule = css.match(new RegExp(`(^|\\n)\\.${c}\\s*\\{[^}]*\\}`))
    if (rule && /display:\s*[a-z-]+/.test(rule[0])) conflicts.push(`#${id} (.${c})`)
  }
}
// Conflicts are fine *provided* the global rule neutralises them.
check('every display-declaring overlay is covered by the global rule',
  conflicts.length === 0 || globalRule,
  conflicts.length ? `relies on the global rule: ${conflicts.join(', ')}` : 'no conflicts at all')

// ---------------------------------------------------------------- safety scan
//
// Build a PDF that really does carry active content, so the scanner is tested
// against a positive case rather than only against clean files.
group('safety scan and sanitise')
const base = await PDFDocument.create()
base.addPage([200, 200])
const plain = new Uint8Array(await base.save())

const doctored = (() => {
  const d = mupdf.Document.openDocument(plain, 'application/pdf').asPDF()
  const root = d.getTrailer().get('Root')

  // an action that runs the moment the file is opened
  const openAction = d.newDictionary()
  openAction.put('S', d.newName('JavaScript'))
  openAction.put('JS', d.newString("app.alert('this should never run')"))
  root.put('OpenAction', d.addObject(openAction))

  // a document-level JavaScript name tree
  const jsEntry = d.newDictionary()
  jsEntry.put('S', d.newName('JavaScript'))
  jsEntry.put('JS', d.newString('var x = 1'))
  const jsArray = d.newArray()
  jsArray.push(d.newString('script0'))
  jsArray.push(d.addObject(jsEntry))
  const jsDict = d.newDictionary()
  jsDict.put('Names', jsArray)
  const names = d.newDictionary()
  names.put('JavaScript', d.addObject(jsDict))
  root.put('Names', d.addObject(names))

  // an embedded file, reachable from the catalog so a garbage pass keeps it
  const efStream = d.addStream(new TextEncoder().encode('payload bytes'), (() => {
    const dict = d.newDictionary()
    dict.put('Type', d.newName('EmbeddedFile'))
    return dict
  })())
  const ef = d.newDictionary()
  ef.put('F', efStream)
  const spec = d.newDictionary()
  spec.put('Type', d.newName('Filespec'))
  spec.put('F', d.newString('payload.txt'))
  spec.put('EF', ef)
  root.put('PdfScrubTestAttachment', d.addObject(spec))

  return d.saveToBuffer('compress=yes').asUint8Array().slice()
})()

await call('load', { bytes: doctored.slice().buffer })
let rep = await call('inspect')
const keysOf = (r) => [...r.active, ...r.embed].map((x) => x.key).sort()
check('scanner finds the planted active content', rep.active.length > 0, keysOf(rep).join(', '))
check('scanner finds OpenAction', rep.active.some((x) => x.key === 'OpenAction'))
check('scanner finds JavaScript', rep.active.some((x) => x.key === 'JS' || x.key === 'JavaScript'))
check('scanner finds the embedded file', rep.embed.length > 0)
check('scanner reports how much it walked', rep.objects > 0, `${rep.objects} objects`)

const san = await call('sanitize')
check('sanitise removed entries', san.removed > 0, `${san.removed} removed`)
check('post-sanitise report is clean', san.report.active.length === 0 && san.report.embed.length === 0,
  keysOf(san.report).join(', ') || 'nothing left')
rep = await call('inspect')
check('a fresh scan also finds nothing', rep.active.length === 0 && rep.embed.length === 0)
check('the document still opens and has its page', (await call('meta')).pageCount === 1)
check('sanitise is undoable', (await call('undo')).pageCount === 1)

await call('load', { bytes: plain.slice().buffer })
rep = await call('inspect')
check('a clean file reports clean', rep.active.length === 0 && rep.embed.length === 0)

// ---------------------------------------------------------------- DOM wiring
//
// No browser runs here, so a mistyped id in $('...') would only surface as a
// null-dereference in front of the user. Check every lookup resolves.
group('every $(id) lookup exists in the HTML')
const ids = [...new Set([...js.matchAll(/\$\('([A-Za-z0-9_-]+)'\)/g)].map((m) => m[1]))]
const missing = ids.filter((id) => !new RegExp(`id="${id}"`).test(html))
check('all ids resolve', missing.length === 0,
  missing.length ? 'MISSING: ' + missing.join(', ') : `${ids.length} ids checked`)

const handlers = [...new Set([...fs.readFileSync(path.join(HERE, '..', 'worker.js'), 'utf8')
  .matchAll(/^\s{2}([a-zA-Z]+)[:,]/gm)].map((m) => m[1]))]
const called = [...new Set([...js.matchAll(/call\('([a-zA-Z]+)'/g)].map((m) => m[1]))]
const unknown = called.filter((c) => !handlers.includes(c))
check('every call() targets a real worker handler', unknown.length === 0,
  unknown.length ? 'UNKNOWN: ' + unknown.join(', ') : called.join(', '))

// ---------------------------------------------------------------- class collisions
//
// A class that establishes out-of-flow positioning is a layout primitive, not a
// modifier. Combined with a component class on the same element it silently pulls
// that component out of flow. This shipped: `.ghost` was both the editor's
// drag-placement box (position: absolute) and the `.btn.ghost` button variant, so
// twelve buttons were yanked out of flow and stacked on top of each other.
group('no positioned class doubles as a modifier')
const singleClassRules = [...css.matchAll(/^\.([a-zA-Z][\w-]*)\s*\{([^}]*)\}/gm)]
check('parsed the stylesheet', singleClassRules.length > 10, `${singleClassRules.length} single-class rules`)

const positioned = new Set(singleClassRules
  .filter((m) => /position:\s*(absolute|fixed)/.test(m[2]))
  .map((m) => m[1]))
check('found the positioned classes', positioned.size > 0, [...positioned].join(', '))

const collisions = []
for (const m of html.matchAll(/class="([^"]+)"/g)) {
  const list = m[1].trim().split(/\s+/)
  if (list.length < 2) continue
  for (const c of list) if (positioned.has(c)) collisions.push(`class="${m[1]}" (.${c} is positioned)`)
}
check('no positioned class is combined with others', collisions.length === 0,
  collisions.length ? collisions.join('; ') : 'clean')

// Every class referenced in the HTML should actually be defined somewhere, or it
// is a typo or a leftover.
const defined = new Set(singleClassRules.map((m) => m[1]))
for (const m of css.matchAll(/\.([a-zA-Z][\w-]*)/g)) defined.add(m[1])
const used = new Set()
for (const m of html.matchAll(/class="([^"]+)"/g)) m[1].trim().split(/\s+/).forEach((c) => used.add(c))
const undefinedClasses = [...used].filter((c) => !defined.has(c))
check('every class used in the HTML is defined in the CSS', undefinedClasses.length === 0,
  undefinedClasses.length ? 'UNDEFINED: ' + undefinedClasses.join(', ') : `${used.size} classes`)

// ---------------------------------------------------------------- text editing
group('replace text line by line')
const td = await PDFDocument.create()
const tf = await td.embedFont(StandardFonts.Helvetica)
const tp = td.addPage([400, 300])
tp.drawText('Precio: 25 euros', { x: 40, y: 240, size: 14, font: tf })
tp.drawText('No cambiar esta linea', { x: 40, y: 200, size: 14, font: tf })
const textFixture = new Uint8Array(await td.save())

await call('load', { bytes: textFixture.slice().buffer })
let tl = await call('textLines', { index: 0 })
check('finds both lines', tl.lines.length === 2, tl.lines.map((l) => JSON.stringify(l.text)).join(', '))
const target = tl.lines.find((l) => l.text.includes('Precio'))
check('reports a baseline', target && target.y > 0, target && `baseline y=${target.y.toFixed(1)}`)
check('reports the size', target && Math.round(target.size) === 14, target && `size=${target.size}`)
check('reports a colour', Array.isArray(target.color) && target.color.length === 3, JSON.stringify(target.color))

await call('replaceLine', { ...target, index: 0, text: 'Precio: 40 euros' })
let txt = textOf((await call('download')).bytes)[0].replace(/\s+/g, ' ')
check('new text is present', txt.includes('Precio: 40 euros'), JSON.stringify(txt))
check('old text is gone', !txt.includes('25 euros'))
check('the other line is untouched', txt.includes('No cambiar esta linea'))
// One edit must be one undo step: replaceLine redacts and then draws, so a
// careless second snapshot would make the user press Undo twice.
const undone = textOf((await call('undo')).pages ? (await call('download')).bytes : (await call('download')).bytes)[0]
check('one Undo fully reverts the edit',
  undone.includes('25 euros') && !undone.includes('40 euros'),
  JSON.stringify(undone.replace(/\s+/g, ' ')))

// Accents must survive: WinAnsi covers them and this is a Spanish-language tool.
await call('load', { bytes: textFixture.slice().buffer })
tl = await call('textLines', { index: 0 })
await call('replaceLine', { ...tl.lines.find((l) => l.text.includes('Precio')), index: 0, text: 'Habría 3 años ñ ü' })
txt = textOf((await call('download')).bytes)[0]
check('Spanish accents render', txt.includes('Habría 3 años'), JSON.stringify(txt.replace(/\s+/g, ' ').slice(0, 60)))

// Clearing a line deletes it.
await call('load', { bytes: textFixture.slice().buffer })
tl = await call('textLines', { index: 0 })
await call('replaceLine', { ...tl.lines.find((l) => l.text.includes('Precio')), index: 0, text: '   ' })
txt = textOf((await call('download')).bytes)[0]
check('blanking a line removes it', !txt.includes('Precio') && txt.includes('No cambiar'))

// The critical failure case: an unencodable character must be refused BEFORE the
// original text is deleted, or the edit destroys content and puts nothing back.
await call('load', { bytes: textFixture.slice().buffer })
tl = await call('textLines', { index: 0 })
const before = textOf((await call('download')).bytes)[0]
let refused = false
try {
  await call('replaceLine', { ...tl.lines.find((l) => l.text.includes('Precio')), index: 0, text: 'Книги' })
} catch (e) {
  refused = /cannot render/.test(e.message)
}
check('Cyrillic is refused with a clear message', refused)
const after = textOf((await call('download')).bytes)[0]
check('a refused edit destroys nothing', after === before,
  after === before ? 'original intact' : 'DATA LOSS: ' + JSON.stringify(after))

// ---------------------------------------------------------------- scan clean-up
//
// Build a fake scan: render the text fixture, then dirty the background the way
// a flatbed does (gray paper, shading toward the spine, noise) and embed it as a
// JPEG. A real text line is drawn on top to stand in for an OCR layer. Page 2 is
// a dark "photo" that whitening must leave alone.
group('whiten a scanned page')
const pageMean = (bytes, i) => {
  const d = mupdf.Document.openDocument(bytes, 'application/pdf')
  const pm = d.loadPage(i).toPixmap(mupdf.Matrix.scale(0.5, 0.5), mupdf.ColorSpace.DeviceGray, false)
  const q = pm.getPixels(), st = pm.getStride(), w = pm.getWidth(), h = pm.getHeight()
  let sum = 0, white = 0
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const v = q[y * st + x]; sum += v; if (v === 255) white++ }
  return { mean: sum / (w * h), white: white / (w * h) }
}
const scanFixture = await (async () => {
  const src = mupdf.Document.openDocument(cyrillic, 'application/pdf')
  const s = 100 / 72
  const pm = src.loadPage(0).toPixmap(mupdf.Matrix.scale(s, s), mupdf.ColorSpace.DeviceRGB, false)
  const W = pm.getWidth(), H = pm.getHeight(), st = pm.getStride(), n = pm.getNumberOfComponents()
  const px = pm.getPixels()
  let seed = 7
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff }
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const o = y * st + x * n
    const noise = Math.round(rnd() * 16 - 8)
    const paper = 222 - Math.round(30 * x / W)        // darker toward the spine
    for (let c = 0; c < 3; c++) {
      const v = px[o + c]
      px[o + c] = v > 200 ? Math.max(0, Math.min(255, paper + noise - (c === 2 ? 12 : 0))) : Math.min(255, v + 45)
    }
  }
  const jpg = new Uint8Array(pm.asJPEG(80, false))
  // the "photo": a dark gradient with nothing resembling paper
  const photo = new mupdf.Pixmap(mupdf.ColorSpace.DeviceRGB, [0, 0, 400, 400], false)
  const pp = photo.getPixels(), pst = photo.getStride()
  for (let y = 0; y < 400; y++) for (let x = 0; x < 400; x++) {
    const o = y * pst + x * 3
    pp[o] = 30 + (x >> 2); pp[o + 1] = 20 + (y >> 2); pp[o + 2] = 60
  }
  const photoJpg = new Uint8Array(photo.asJPEG(85, false))

  const doc = await PDFDocument.create()
  const f = await doc.embedFont(StandardFonts.Helvetica)
  const p0 = doc.addPage([595, 842])
  p0.drawImage(await doc.embedJpg(jpg), { x: 0, y: 0, width: 595, height: 842 })
  p0.drawText('OCR-LAYER-TEXT', { x: 40, y: 20, size: 10, font: f })
  const p1 = doc.addPage([595, 842])
  p1.drawImage(await doc.embedJpg(photoJpg), { x: 100, y: 300, width: 400, height: 400 })
  return new Uint8Array(await doc.save())
})()

await call('load', { bytes: scanFixture.slice().buffer })
let sizeBefore = (await call('meta')).size
const grayBefore = pageMean((await call('download')).bytes, 0)
check('fixture really is gray paper', grayBefore.mean < 205 && grayBefore.white < 0.01,
  `mean ${grayBefore.mean.toFixed(1)}, pure white ${(grayBefore.white * 100).toFixed(1)}%`)
const photoBefore = pageMean((await call('download')).bytes, 1)

let cl = await call('cleanScan', { indices: [0], strength: 'normal', gray: true })
check('one page image whitened', cl.images === 1 && cl.pages === 1, JSON.stringify({ images: cl.images, pages: cl.pages, skipped: cl.skipped }))
let cleaned = (await call('download')).bytes
const grayAfter = pageMean(cleaned, 0)
check('paper became pure white', grayAfter.white > 0.6 && grayAfter.mean > 225,
  `mean ${grayAfter.mean.toFixed(1)}, pure white ${(grayAfter.white * 100).toFixed(1)}%`)
check('the text layer survived', textOf(cleaned)[0].includes('OCR-LAYER-TEXT'))
check('the unselected page was not touched', Math.abs(pageMean(cleaned, 1).mean - photoBefore.mean) < 0.5)
check('the old image was garbage-collected, file got smaller', cl.sizeAfter < cl.sizeBefore,
  `${cl.sizeBefore} -> ${cl.sizeAfter} bytes`)
check('page geometry unchanged', cl.meta.pageCount === 2 && Math.round(cl.meta.pages[0].w) === 595 && Math.round(cl.meta.pages[0].h) === 842)
check('whitening is undoable', (await call('undo')).size === sizeBefore &&
  Math.abs(pageMean((await call('download')).bytes, 0).mean - grayBefore.mean) < 0.5)

cl = await call('cleanScan', { strength: 'strong', gray: false })
check('all pages: the photo is skipped, the scan is whitened', cl.images === 1 && cl.skipped === 1,
  JSON.stringify({ images: cl.images, skipped: cl.skipped }))
cleaned = (await call('download')).bytes
check('photo left alone', Math.abs(pageMean(cleaned, 1).mean - photoBefore.mean) < 0.5)
check('colour output also whitens', pageMean(cleaned, 0).white > 0.6)

// A real-text PDF has no page image; the document must come back byte-identical.
await call('load', { bytes: textFixture.slice().buffer })
sizeBefore = (await call('meta')).size
cl = await call('cleanScan', {})
check('a text PDF reports nothing to do', cl.images === 0 && cl.skipped === 0)
check('and is left byte-identical', (await call('meta')).size === sizeBefore)
let undoable = true
try { await call('undo') } catch (e) { undoable = false }
check('no-op did not push an undo step', !undoable)

console.log(`\n=========== ${pass} passed, ${fail} failed ===========`)
process.exit(fail ? 1 : 0)
