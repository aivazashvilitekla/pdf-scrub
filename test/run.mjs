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

console.log(`\n=========== ${pass} passed, ${fail} failed ===========`)
process.exit(fail ? 1 : 0)
