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

console.log(`\n=========== ${pass} passed, ${fail} failed ===========`)
process.exit(fail ? 1 : 0)
