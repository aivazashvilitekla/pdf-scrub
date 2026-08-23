// Structural scan of a PDF for active/embedded content.
//
//   node tools/inspect.mjs <file.pdf> [--sanitize <out.pdf>]
//
// Walks every indirect object rather than grepping the raw bytes, because most
// objects live inside compressed object streams where a keyword search finds
// nothing. Read-only unless --sanitize is passed.

import fs from 'node:fs'
import * as mupdf from '../vendor/mupdf/mupdf.js'

const [, , file, mode, out] = process.argv
if (!file) { console.error('usage: node tools/inspect.mjs <file.pdf> [--sanitize <out.pdf>]'); process.exit(2) }

const bytes = new Uint8Array(fs.readFileSync(file))
const doc = mupdf.Document.openDocument(bytes, 'application/pdf').asPDF()
if (!doc) { console.error('Not a PDF.'); process.exit(2) }

console.log(`file      ${file}`)
console.log(`size      ${(bytes.length / 1048576).toFixed(2)} MB`)
console.log(`version   PDF ${doc.getVersion() / 10}`)
console.log(`pages     ${doc.countPages()}`)
console.log(`encrypted ${doc.needsPassword() ? 'yes, needs a password' : 'no password needed'}`)

// key -> what it means. Severity: 'active' can run or fetch something, 'embed'
// carries another file, 'info' is worth knowing but not itself a risk.
const KEYS = {
  JS:            ['active', 'JavaScript action payload'],
  JavaScript:    ['active', 'document-level JavaScript'],
  OpenAction:    ['active', 'runs automatically when the file opens'],
  AA:            ['active', 'additional actions (page open/close, field triggers)'],
  Launch:        ['active', 'launches an external application'],
  SubmitForm:    ['active', 'submits form data to a URL'],
  ImportData:    ['active', 'imports data from a file'],
  GoToR:         ['active', 'jumps into a remote document'],
  GoToE:         ['active', 'jumps into an embedded document'],
  RichMedia:     ['active', 'embedded Flash/video media'],
  XFA:           ['active', 'XFA form (its own scripting engine)'],
  EmbeddedFile:  ['embed',  'a file embedded inside the PDF'],
  EF:            ['embed',  'embedded-file reference'],
  Filespec:      ['embed',  'file specification'],
  URI:           ['info',   'external link'],
  AcroForm:      ['info',   'interactive form'],
  Movie:         ['info',   'movie annotation'],
  Sound:         ['info',   'sound annotation'],
}
const SUBTYPES = { Screen: 'active', Movie: 'info', Sound: 'info', RichMedia: 'active', FileAttachment: 'embed', '3D': 'active' }

const hits = new Map()   // label -> Set of object numbers
const note = (label, num) => {
  if (!hits.has(label)) hits.set(label, new Set())
  hits.get(label).add(num)
}

const total = doc.countObjects()
let scanned = 0
for (let num = 1; num < total; num++) {
  let obj
  try { obj = doc.newIndirect(num).resolve() } catch (e) { continue }
  if (!obj || obj.isNull()) continue
  scanned++
  if (!obj.isDictionary()) continue
  try {
    obj.forEach((val, key) => {
      const k = String(key)
      if (KEYS[k]) note(k, num)
      if ((k === 'S' || k === 'Subtype' || k === 'Type') && val && !val.isNull()) {
        let name = null
        try { name = val.asName() } catch (e) {}
        if (name && KEYS[name]) note(name, num)
        if (name && SUBTYPES[name]) note(name, num)
      }
    })
  } catch (e) {}
}

console.log(`objects   ${scanned} live of ${total} slots\n`)

const bySeverity = { active: [], embed: [], info: [] }
for (const [label, nums] of hits) {
  const meta = KEYS[label] || [SUBTYPES[label] || 'info', 'annotation subtype']
  bySeverity[meta[0]].push([label, nums.size, meta[1]])
}
const show = (sev, heading) => {
  const rows = bySeverity[sev]
  if (!rows.length) return
  console.log(heading)
  for (const [label, n, why] of rows.sort((a, b) => b[1] - a[1])) {
    console.log(`  /${label.padEnd(13)} ${String(n).padStart(5)} object(s)   ${why}`)
  }
  console.log()
}
show('active', 'ACTIVE CONTENT (can execute or fetch something):')
show('embed',  'EMBEDDED FILES:')
show('info',   'WORTH KNOWING (not itself a risk):')

const dangerous = bySeverity.active.length + bySeverity.embed.length
console.log(dangerous
  ? `VERDICT: ${dangerous} category/categories of active or embedded content found.`
  : 'VERDICT: no JavaScript, no auto-run actions, no embedded files. Structurally inert.')

// ---------------------------------------------------------------- sanitise
if (mode === '--sanitize') {
  if (!out) { console.error('\n--sanitize needs an output path'); process.exit(2) }
  const STRIP = ['JS', 'JavaScript', 'OpenAction', 'AA', 'Launch', 'SubmitForm',
                 'ImportData', 'GoToR', 'GoToE', 'RichMedia', 'XFA', 'EmbeddedFile', 'EF']
  let removed = 0
  for (let num = 1; num < total; num++) {
    let obj
    try { obj = doc.newIndirect(num).resolve() } catch (e) { continue }
    if (!obj || obj.isNull() || !obj.isDictionary()) continue
    for (const k of STRIP) {
      try {
        const v = obj.get(k)
        if (v && !v.isNull()) { obj.delete(k); removed++ }
      } catch (e) {}
    }
  }
  // Also clear the catalog's Names/JavaScript tree and any AcroForm XFA.
  try {
    const root = doc.getTrailer().get('Root')
    for (const path of [['Names', 'JavaScript'], ['AcroForm', 'XFA'], ['OpenAction'], ['AA']]) {
      try {
        const parent = path.length > 1 ? root.get(path[0]) : root
        const key = path[path.length - 1]
        if (parent && !parent.isNull()) {
          const v = parent.get(key)
          if (v && !v.isNull()) { parent.delete(key); removed++ }
        }
      } catch (e) {}
    }
  } catch (e) {}

  // sanitize=yes also rewrites content streams; garbage=deduplicate drops
  // objects nothing references any more, so stripped payloads do not linger.
  let buf
  try { buf = doc.saveToBuffer('compress=yes,garbage=deduplicate,sanitize=yes') }
  catch (e) { buf = doc.saveToBuffer('compress=yes,garbage=compact') }
  fs.writeFileSync(out, buf.asUint8Array())
  console.log(`\nSANITISED: removed ${removed} entr(ies), wrote ${out}`)
  console.log(`           ${(fs.statSync(out).size / 1048576).toFixed(2)} MB`)
}
