// UI layer. All PDF work is delegated to worker.js; this file only handles
// state, coordinates and DOM.

const PRESET = 'Книги на испанском от hispanoteca.ru'
const $ = (id) => document.getElementById(id)

// ------------------------------------------------------------------ worker RPC

// Version query in step with index.html: without it a stale worker.js can be
// served from cache against a fresh app.js.
const worker = new Worker('worker.js?v=3', { type: 'module' })
const pending = new Map()
let seq = 0

worker.onmessage = (ev) => {
  if (ev.data && ev.data.ready) { boot(); return }
  const { id, ok, result, error } = ev.data
  const p = pending.get(id)
  if (!p) return
  pending.delete(id)
  ok ? p.resolve(result) : p.reject(new Error(error))
}
worker.onerror = (e) => {
  $('boot').textContent = 'Could not start the PDF engine: ' + (e.message || 'unknown error')
}

function call (type, payload = {}) {
  const id = ++seq
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject })
    const transfer = payload.bytes ? [payload.bytes] : []
    worker.postMessage({ id, type, ...payload }, transfer)
  })
}

// ------------------------------------------------------------------ state

const S = { pages: [], sel: new Set(), thumbs: new Map(), name: 'document.pdf' }
let gen = 0                    // bumped whenever page indices change, invalidating thumbs

// ------------------------------------------------------------------ chrome

let busyDepth = 0
async function busy (label, fn) {
  busyDepth++
  $('busy-text').textContent = label
  $('busy').hidden = false
  try { return await fn() } finally {
    if (--busyDepth === 0) $('busy').hidden = true
  }
}

let toastTimer
function toast (msg, bad = false) {
  const t = $('toast')
  t.textContent = msg
  t.classList.toggle('bad', bad)
  t.hidden = false
  clearTimeout(toastTimer)
  toastTimer = setTimeout(() => { t.hidden = true }, bad ? 6000 : 3200)
}

// Inline SVG rather than glyphs: U+27F2/U+27F3 are absent from many system font
// stacks and fall back to tofu boxes.
const ICON = {
  rotl: '<svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M2.5 6.5h5v-5"/><path d="M2.9 6.1A5.5 5.5 0 1 1 2.5 9.6"/></svg>',
  rotr: '<svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M13.5 6.5h-5v-5"/><path d="M13.1 6.1A5.5 5.5 0 1 0 13.5 9.6"/></svg>',
  del:  '<svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><path d="M4 4l8 8M12 4l-8 8"/></svg>',
}

function boot () {
  $('boot').hidden = true
  $('empty').hidden = false
  $('needles').value = PRESET
}

// Any operation that can change the document funnels through here.
async function apply (label, type, payload) {
  try {
    const meta = await busy(label, () => call(type, payload))
    if (meta && meta.pages) adopt(meta)
    $('undo').disabled = false
    return meta
  } catch (err) {
    toast(err.message, true)
    throw err
  }
}

function adopt (meta) {
  // Page indices are about to change, so any open overlay is now pointing at
  // the wrong page.
  $('viewer').hidden = true
  $('editor').hidden = true
  gen++
  thumbQ.length = 0
  for (const url of S.thumbs.values()) URL.revokeObjectURL(url)
  S.thumbs.clear()
  S.pages = meta.pages
  S.sel.clear()
  $('doc-stat').textContent =
    `${meta.pageCount} page${meta.pageCount === 1 ? '' : 's'} · ${(meta.size / 1048576).toFixed(2)} MB`
  $('download').disabled = false
  $('add-label').hidden = false
  $('empty').hidden = true
  $('work').hidden = false
  $('sanitize').disabled = true
  $('safety-out').hidden = true
  renderGrid()
  syncSelection()
}

// Bulk actions are meaningless with nothing selected, so they stay disabled
// rather than being clickable and then complaining via a toast.
function syncSelection () {
  const n = S.sel.size
  const total = S.pages.length
  $('sel-stat').textContent = n
    ? `${n} of ${total} page${total === 1 ? '' : 's'} selected`
    : 'Nothing selected'
  $('sel-none').disabled = n === 0
  $('rot-sel').disabled = n === 0
  $('export-sel').disabled = n === 0
  $('del-sel').disabled = n === 0 || n === total
  $('sel-all').disabled = total > 0 && n === total
}

// ------------------------------------------------------------------ opening files

async function openFile (file) {
  if (!file) return
  if (!/\.pdf$/i.test(file.name) && file.type !== 'application/pdf') {
    return toast('That is not a PDF.', true)
  }
  S.name = file.name.replace(/\.pdf$/i, '')
  const buf = await file.arrayBuffer()
  try {
    const meta = await busy('Reading the PDF…', () => call('load', { bytes: buf }))
    adopt(meta)
    $('undo').disabled = true
    toast(`Opened ${file.name}`)
  } catch (err) { toast(err.message, true) }
}

$('file-in').addEventListener('change', async (e) => {
  await openFile(e.target.files[0])
  e.target.value = ''
})

// ---- drag and drop, the expected way to open a file in a tool like this
const dz = $('dropzone')
let dragDepth = 0
const hasFiles = (e) => e.dataTransfer && [...e.dataTransfer.types].includes('Files')

window.addEventListener('dragenter', (e) => {
  if (!hasFiles(e)) return
  e.preventDefault()
  dragDepth++
  if (!$('empty').hidden) dz.classList.add('hot')
})
window.addEventListener('dragover', (e) => { if (hasFiles(e)) e.preventDefault() })
window.addEventListener('dragleave', (e) => {
  if (!hasFiles(e)) return
  if (--dragDepth <= 0) { dragDepth = 0; dz.classList.remove('hot') }
})
window.addEventListener('drop', async (e) => {
  if (!hasFiles(e)) return
  e.preventDefault()
  dragDepth = 0
  dz.classList.remove('hot')
  const file = e.dataTransfer.files[0]
  if (!file) return
  // Dropping onto an already-open document means merge, not replace: silently
  // replacing would throw away edits that have not been downloaded yet.
  if (!$('work').hidden && S.pages.length) {
    await apply(`Merging ${file.name}…`, 'append', { bytes: await file.arrayBuffer() })
    toast(`Merged ${file.name}. Undo if you meant to open it instead.`)
  } else {
    await openFile(file)
  }
})

$('file-add').addEventListener('change', async (e) => {
  for (const file of e.target.files) {
    const buf = await file.arrayBuffer()
    await apply(`Merging ${file.name}…`, 'append', { bytes: buf })
  }
  if (e.target.files.length) toast('Merged.')
  e.target.value = ''
})

// ------------------------------------------------------------------ strip text

function needles () {
  return $('needles').value.split('\n').map((s) => s.trim()).filter(Boolean)
}

function describe (r) {
  if (!r.total) return 'No matches found.'
  const where = r.perPage.map((p) => `p${p.page + 1}${p.hits > 1 ? `×${p.hits}` : ''}`).join(', ')
  return `${r.total} occurrence${r.total === 1 ? '' : 's'} on ${r.perPage.length} page${r.perPage.length === 1 ? '' : 's'}: ${where}`
}

$('scan').addEventListener('click', async () => {
  const n = needles()
  if (!n.length) return toast('Add at least one phrase.', true)
  const out = $('scan-out')
  try {
    const r = await busy('Scanning…', () => call('scan', { needles: n }))
    out.textContent = describe(r)
    out.className = 'result ' + (r.total ? 'good' : 'bad')
  } catch (err) { toast(err.message, true) }
})

$('strip').addEventListener('click', async () => {
  const n = needles()
  if (!n.length) return toast('Add at least one phrase.', true)
  try {
    const r = await busy('Stripping…', () => call('strip', { needles: n }))
    const out = $('scan-out')
    if (!r.total) {
      out.textContent = 'No matches found, nothing changed.'
      out.className = 'result bad'
      return
    }
    out.textContent = 'Removed ' + describe(r)
    out.className = 'result good'
    $('undo').disabled = false
    adopt(await call('meta'))
    toast(`Removed ${r.total} occurrence${r.total === 1 ? '' : 's'}.`)
  } catch (err) { toast(err.message, true) }
})

// ------------------------------------------------------------------ page grid

const grid = $('grid')
const thumbQ = []
let thumbRunning = false

const io = new IntersectionObserver((entries) => {
  for (const e of entries) {
    if (!e.isIntersecting) continue
    io.unobserve(e.target)
    thumbQ.push({ i: +e.target.dataset.i, img: e.target, g: gen })
  }
  pumpThumbs()
}, { rootMargin: '300px' })

async function pumpThumbs () {
  if (thumbRunning) return
  thumbRunning = true
  while (thumbQ.length) {
    const job = thumbQ.shift()
    if (job.g !== gen) continue
    try {
      const page = S.pages[job.i]
      if (!page) continue
      const { png } = await call('render', { index: job.i, scale: Math.min(1.5, 300 / page.w) })
      if (job.g !== gen) continue
      const url = URL.createObjectURL(new Blob([png], { type: 'image/png' }))
      S.thumbs.set(job.i, url)
      job.img.src = url
    } catch (e) { /* a page that failed to render just stays blank */ }
  }
  thumbRunning = false
}

function renderGrid () {
  grid.textContent = ''
  S.pages.forEach((p, i) => grid.appendChild(card(p, i)))
}

function card (page, i) {
  const el = document.createElement('div')
  el.className = 'card'
  el.dataset.i = i
  el.draggable = true

  const thumb = document.createElement('div')
  thumb.className = 'card-thumb'
  const img = document.createElement('img')
  img.alt = `Page ${i + 1}`
  img.dataset.i = i
  if (S.thumbs.has(i)) img.src = S.thumbs.get(i)
  else io.observe(img)
  thumb.appendChild(img)
  thumb.title = 'Click to open this page'
  thumb.addEventListener('click', () => openViewer(i))

  const foot = document.createElement('div')
  foot.className = 'card-foot'
  const cb = document.createElement('input')
  cb.type = 'checkbox'
  cb.checked = S.sel.has(i)
  cb.addEventListener('change', () => {
    cb.checked ? S.sel.add(i) : S.sel.delete(i)
    el.classList.toggle('sel', cb.checked)
    syncSelection()
  })
  const num = document.createElement('span')
  num.className = 'num'
  num.textContent = i + 1
  foot.append(cb, num)

  for (const [label, title, act] of [
    [ICON.rotl, 'Rotate left', 'rotl'],
    [ICON.rotr, 'Rotate right', 'rotr'],
    ['Edit', 'Redact or move part of this page', 'edit'],
    [ICON.del, 'Delete this page', 'del'],
  ]) {
    const b = document.createElement('button')
    b.className = 'icon'
    if (label.startsWith('<svg')) b.innerHTML = label
    else b.textContent = label
    b.title = title
    b.setAttribute('aria-label', title)
    b.addEventListener('click', () => pageAction(act, i))
    foot.appendChild(b)
  }

  el.append(thumb, foot)
  el.classList.toggle('sel', S.sel.has(i))
  wireDrag(el, i)
  return el
}

function pageAction (act, i) {
  if (act === 'rotl') return apply('Rotating…', 'pageOps', { order: allIdx(), rotate: { [i]: -90 } })
  if (act === 'rotr') return apply('Rotating…', 'pageOps', { order: allIdx(), rotate: { [i]: 90 } })
  if (act === 'del') {
    if (S.pages.length === 1) return toast('That is the only page.', true)
    return apply('Deleting…', 'pageOps', { order: allIdx().filter((x) => x !== i) })
  }
  if (act === 'edit') return openEditor(i)
}

const allIdx = () => S.pages.map((_, i) => i)

// -------- drag to reorder
let dragFrom = null
function wireDrag (el, i) {
  el.addEventListener('dragstart', (e) => {
    dragFrom = i
    el.classList.add('drag')
    e.dataTransfer.effectAllowed = 'move'
    e.dataTransfer.setData('text/plain', String(i))
  })
  el.addEventListener('dragend', () => { el.classList.remove('drag'); dragFrom = null })
  el.addEventListener('dragover', (e) => { e.preventDefault(); if (dragFrom !== i) el.classList.add('over') })
  el.addEventListener('dragleave', () => el.classList.remove('over'))
  el.addEventListener('drop', (e) => {
    e.preventDefault()
    el.classList.remove('over')
    if (dragFrom === null || dragFrom === i) return
    const order = allIdx()
    const [moved] = order.splice(dragFrom, 1)
    order.splice(i, 0, moved)
    apply('Reordering…', 'pageOps', { order })
  })
}

// -------- bulk actions
$('sel-all').addEventListener('click', () => { S.pages.forEach((_, i) => S.sel.add(i)); renderGrid(); syncSelection() })
$('sel-none').addEventListener('click', () => { S.sel.clear(); renderGrid(); syncSelection() })

$('rot-sel').addEventListener('click', () => {
  if (!S.sel.size) return toast('Select some pages first.', true)
  const rotate = {}
  for (const i of S.sel) rotate[i] = 90
  apply('Rotating…', 'pageOps', { order: allIdx(), rotate })
})

$('del-sel').addEventListener('click', () => {
  if (!S.sel.size) return toast('Select some pages first.', true)
  if (S.sel.size === S.pages.length) return toast('That would delete every page.', true)
  apply('Deleting…', 'pageOps', { order: allIdx().filter((i) => !S.sel.has(i)) })
})

$('export-sel').addEventListener('click', async () => {
  if (!S.sel.size) return toast('Select the pages you want to export.', true)
  const indices = [...S.sel].sort((a, b) => a - b)
  try {
    const { bytes } = await busy('Exporting…', () => call('extract', { indices }))
    save(bytes, `${S.name}-pages-${indices[0] + 1}-${indices[indices.length - 1] + 1}.pdf`)
  } catch (err) { toast(err.message, true) }
})

$('undo').addEventListener('click', async () => {
  try {
    adopt(await busy('Undoing…', () => call('undo')))
    toast('Undone.')
  } catch (err) { toast(err.message, true) }
})

$('download').addEventListener('click', async () => {
  try {
    const { bytes } = await busy('Preparing…', () => call('download'))
    save(bytes, `${S.name}-clean.pdf`)
  } catch (err) { toast(err.message, true) }
})

function save (bytes, filename) {
  const url = URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' }))
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 4000)
}

// ------------------------------------------------------------------ editor

const ED = { src: 0, dst: 0, srcScale: 1, dstScale: 1, rect: null, ghost: null }
const PANE_W = 520

async function paint (canvas, index, cssWidth) {
  const page = S.pages[index]
  const dpr = Math.min(2, window.devicePixelRatio || 1)
  const cssScale = cssWidth / page.w
  const { png, w, h } = await call('render', { index, scale: cssScale * dpr })
  const bmp = await createImageBitmap(new Blob([png], { type: 'image/png' }))
  canvas.width = w
  canvas.height = h
  canvas.style.width = w / dpr + 'px'
  canvas.style.height = h / dpr + 'px'
  canvas.getContext('2d').drawImage(bmp, 0, 0)
  bmp.close()
  return cssScale
}

async function openEditor (i) {
  ED.src = i
  ED.rect = null
  ED.ghost = null
  $('ed-num').textContent = i + 1
  $('sel-box').hidden = true
  $('ghost').hidden = true
  $('editor').hidden = false

  const sel = $('dst-page')
  sel.textContent = ''
  S.pages.forEach((_, n) => {
    const o = document.createElement('option')
    o.value = n
    o.textContent = `Page ${n + 1}${n === i ? ' (this page)' : ''}`
    sel.appendChild(o)
  })
  ED.dst = S.pages.length > i + 1 ? i + 1 : i
  sel.value = String(ED.dst)

  await busy('Rendering…', async () => {
    ED.srcScale = await paint($('src-canvas'), ED.src, PANE_W)
    ED.dstScale = await paint($('dst-canvas'), ED.dst, PANE_W)
  })
  syncButtons()
}

$('ed-close').addEventListener('click', () => { $('editor').hidden = true })
$('editor').addEventListener('click', (e) => { if (e.target === $('editor')) $('editor').hidden = true })
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { $('editor').hidden = true; $('viewer').hidden = true; return }
  if ($('viewer').hidden) return
  if (e.key === 'ArrowLeft') { e.preventDefault(); vwStep(-1) }
  if (e.key === 'ArrowRight') { e.preventDefault(); vwStep(1) }
  if (e.key === '+' || e.key === '=') { e.preventDefault(); vwZoom(1) }
  if (e.key === '-' || e.key === '_') { e.preventDefault(); vwZoom(-1) }
  if (e.key === '0') { e.preventDefault(); VW.z = FIT_INDEX; scheduleViewer() }
})

$('dst-page').addEventListener('change', async (e) => {
  ED.dst = Number(e.target.value)
  $('ghost').hidden = true
  ED.ghost = null
  await busy('Rendering…', async () => { ED.dstScale = await paint($('dst-canvas'), ED.dst, PANE_W) })
  if (ED.rect) placeGhost(12, 12)
  syncButtons()
})

const step = (d) => {
  const n = Math.min(S.pages.length - 1, Math.max(0, ED.dst + d))
  if (n === ED.dst) return
  $('dst-page').value = String(n)
  $('dst-page').dispatchEvent(new Event('change'))
}
$('ed-prev').addEventListener('click', () => step(-1))
$('ed-next').addEventListener('click', () => step(1))

// -------- drawing the source selection
const srcStage = $('src-stage')
let drawing = null

function stagePoint (stage, ev) {
  const canvas = stage.querySelector('canvas')
  const r = canvas.getBoundingClientRect()
  return [ev.clientX - r.left, ev.clientY - r.top]
}

srcStage.addEventListener('pointerdown', (ev) => {
  if (ev.button !== 0) return
  const [x, y] = stagePoint(srcStage, ev)
  drawing = { x0: x, y0: y }
  srcStage.setPointerCapture(ev.pointerId)
})

srcStage.addEventListener('pointermove', (ev) => {
  if (!drawing) return
  const [x, y] = stagePoint(srcStage, ev)
  const box = $('sel-box')
  const canvas = $('src-canvas')
  const left = Math.max(0, Math.min(drawing.x0, x))
  const top = Math.max(0, Math.min(drawing.y0, y))
  const right = Math.min(canvas.clientWidth, Math.max(drawing.x0, x))
  const bottom = Math.min(canvas.clientHeight, Math.max(drawing.y0, y))
  Object.assign(box.style, {
    left: canvas.offsetLeft + left + 'px',
    top: canvas.offsetTop + top + 'px',
    width: right - left + 'px',
    height: bottom - top + 'px',
  })
  box.hidden = false
  drawing.css = [left, top, right, bottom]
})

srcStage.addEventListener('pointerup', () => {
  if (!drawing || !drawing.css) { drawing = null; return }
  const [l, t, r, b] = drawing.css
  drawing = null
  if (r - l < 4 || b - t < 4) { $('sel-box').hidden = true; ED.rect = null; syncButtons(); return }
  // CSS px -> MuPDF page points
  ED.rect = [l / ED.srcScale, t / ED.srcScale, r / ED.srcScale, b / ED.srcScale]
  placeGhost(12, 12)
  syncButtons()
})

$('clear-sel').addEventListener('click', () => {
  ED.rect = null
  ED.ghost = null
  $('sel-box').hidden = true
  $('ghost').hidden = true
  syncButtons()
})

// -------- the draggable ghost on the target page
function placeGhost (cssX, cssY) {
  if (!ED.rect) return
  const [x0, y0, x1, y1] = ED.rect
  const canvas = $('dst-canvas')
  const w = (x1 - x0) * ED.dstScale
  const h = (y1 - y0) * ED.dstScale
  const x = Math.max(0, Math.min(cssX, canvas.clientWidth - w))
  const y = Math.max(0, Math.min(cssY, canvas.clientHeight - h))
  const g = $('ghost')
  Object.assign(g.style, {
    left: canvas.offsetLeft + x + 'px',
    top: canvas.offsetTop + y + 'px',
    width: w + 'px',
    height: h + 'px',
  })
  g.hidden = false
  ED.ghost = [x, y]
}

let ghostDrag = null
$('ghost').addEventListener('pointerdown', (ev) => {
  const g = $('ghost')
  const [px, py] = stagePoint($('dst-stage'), ev)
  ghostDrag = { dx: px - ED.ghost[0], dy: py - ED.ghost[1] }
  g.setPointerCapture(ev.pointerId)
  ev.preventDefault()
})
$('ghost').addEventListener('pointermove', (ev) => {
  if (!ghostDrag) return
  const [px, py] = stagePoint($('dst-stage'), ev)
  placeGhost(px - ghostDrag.dx, py - ghostDrag.dy)
})
$('ghost').addEventListener('pointerup', () => { ghostDrag = null })

// -------- editor actions
function syncButtons () {
  const has = !!ED.rect
  $('clear-sel').disabled = !has
  $('do-redact').disabled = !has

  const srcRot = S.pages[ED.src] && S.pages[ED.src].rotate
  const dstRot = S.pages[ED.dst] && S.pages[ED.dst].rotate
  const rotated = srcRot || dstRot
  $('do-move').disabled = !has || !!rotated

  $('ed-hint').textContent = has
    ? `Selected ${Math.round(ED.rect[2] - ED.rect[0])} × ${Math.round(ED.rect[3] - ED.rect[1])} pt`
    : 'Drag on the page to select an area.'
  $('move-hint').textContent = rotated
    ? 'Moving is off for rotated pages. Set rotation back to 0 first.'
    : has ? 'Drag the dashed box to position it, then Move here.'
          : 'Select an area on the left first.'
}

$('do-redact').addEventListener('click', async () => {
  if (!ED.rect) return
  await apply('Deleting the area…', 'redactRect', {
    index: ED.src, rect: ED.rect, killGraphics: $('kill-art').checked,
  })
  $('editor').hidden = true
  toast('Area removed.')
})

$('do-move').addEventListener('click', async () => {
  if (!ED.rect || !ED.ghost) return
  await apply('Moving…', 'moveRegion', {
    srcIdx: ED.src,
    rect: ED.rect,
    dstIdx: ED.dst,
    dstXY: [ED.ghost[0] / ED.dstScale, ED.ghost[1] / ED.dstScale],
    deleteOriginal: !$('keep-orig').checked,
  })
  $('editor').hidden = true
  toast(`Moved to page ${ED.dst + 1}.`)
})


// ------------------------------------------------------------------ safety check

const esc = (t) => String(t).replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]))

const safetyRow = (r) =>
  `<div class="safety-row"><span class="k">/${esc(r.key)}</span>` +
  `<span class="n">${r.count}\u00d7</span><span class="w">${esc(r.why)}</span></div>`

function renderSafety (rep, removedNote) {
  const box = $('safety-out')
  const risky = rep.active.length + rep.embed.length
  let html = ''
  if (removedNote) html += `<div class="safety-verdict clean">${esc(removedNote)}</div>`
  html += risky
    ? `<div class="safety-verdict dirty">${risky} categor${risky === 1 ? 'y' : 'ies'} of active or embedded content found.</div>`
    : '<div class="safety-verdict clean">No JavaScript, no auto-run actions, no embedded files. Structurally inert.</div>'

  const g = (title, rows) => rows.length
    ? `<div class="safety-group"><h4>${title}</h4>${rows.map(safetyRow).join('')}</div>` : ''
  html += g('Active content', rep.active)
  html += g('Embedded files', rep.embed)
  html += g('Worth knowing, not a risk', rep.info)

  if (rep.urls && rep.urls.length) {
    html += `<div class="safety-group"><h4>Links in this file (${rep.urls.length})</h4>` +
            `<div class="safety-urls">${rep.urls.map((u) => `<div>${esc(u)}</div>`).join('')}</div></div>`
  }
  html += `<div class="safety-group"><h4>Scanned</h4><div class="safety-row"><span class="w">` +
          `${rep.objects} objects, each walked individually rather than keyword-searched \u2013 ` +
          `most objects sit inside compressed streams where a text search finds nothing.` +
          `</span></div></div>`

  box.innerHTML = html
  box.hidden = false
  $('sanitize').disabled = risky === 0
  return risky
}

$('inspect').addEventListener('click', async () => {
  try {
    const rep = await busy('Checking the file…', () => call('inspect'))
    const risky = renderSafety(rep)
    toast(risky ? 'Active or embedded content found - see the report.' : 'Clean: nothing executable in this file.')
  } catch (err) { toast(err.message, true) }
})

$('sanitize').addEventListener('click', async () => {
  try {
    const res = await busy('Removing active content…', () => call('sanitize'))
    if (res.meta && res.meta.pages) adopt(res.meta)
    renderSafety(res.report, `Removed ${res.removed} entr${res.removed === 1 ? 'y' : 'ies'} and rebuilt the file.`)
    $('undo').disabled = false
    toast(`Removed ${res.removed} entr${res.removed === 1 ? 'y' : 'ies'}.`)
  } catch (err) { toast(err.message, true) }
})


// ------------------------------------------------------------------ page viewer
//
// A plain read-only look at one page, large. The editor is a two-pane redaction
// tool at 520px per pane, which is no use for reading an A4 page of small print.

// Zoom is expressed as a multiple of fit-to-width, so 100% means "fills the pane".
const ZOOM_STEPS = [0.5, 0.75, 1, 1.25, 1.5, 2, 2.5, 3, 4, 6]
const FIT_INDEX = ZOOM_STEPS.indexOf(1)
const VW = { i: 0, z: FIT_INDEX }

// Re-rendering the wasm page on every zoom tick would be sluggish, so coalesce
// rapid clicks into one render.
let vwPending = null
function scheduleViewer () {
  if (vwPending) clearTimeout(vwPending)
  vwPending = setTimeout(() => { vwPending = null; drawViewer() }, 90)
  paintZoomLabel()
}

function paintZoomLabel () {
  $('vw-pct').textContent = Math.round(ZOOM_STEPS[VW.z] * 100) + '%'
  $('vw-out').disabled = VW.z === 0
  $('vw-in').disabled = VW.z === ZOOM_STEPS.length - 1
  $('vw-fit').disabled = VW.z === FIT_INDEX
}

async function openViewer (i) {
  VW.i = i
  VW.z = FIT_INDEX
  setTextMode(false)
  $('viewer').hidden = false
  await drawViewer()
}

async function drawViewer () {
  const total = S.pages.length
  $('vw-num').textContent = VW.i + 1
  $('vw-total').textContent = total
  $('vw-prev').disabled = VW.i === 0
  $('vw-next').disabled = VW.i >= total - 1
  paintZoomLabel()

  const stage = $('vw-stage')
  // clientWidth is 0 on the first paint because the overlay was display:none a
  // moment ago, so fall back to the viewport.
  const avail = (stage.clientWidth || Math.min(window.innerWidth - 80, 1360)) - 32
  const cssWidth = Math.max(200, Math.min(avail, 1200) * ZOOM_STEPS[VW.z])
  try {
    VW.scale = await busy('Rendering\u2026', () => paint($('vw-canvas'), VW.i, cssWidth))
  } catch (err) { toast(err.message, true); return }
  if (textMode) drawTextLayer()
}

async function vwStep (d) {
  const next = VW.i + d
  if (next < 0 || next >= S.pages.length) return
  VW.i = next
  await drawViewer()
  if (textMode) await loadTextLines()
}

function vwZoom (d) {
  const next = Math.max(0, Math.min(ZOOM_STEPS.length - 1, VW.z + d))
  if (next === VW.z) return
  VW.z = next
  scheduleViewer()
}

$('vw-prev').addEventListener('click', () => vwStep(-1))
$('vw-next').addEventListener('click', () => vwStep(1))
$('vw-out').addEventListener('click', () => vwZoom(-1))
$('vw-in').addEventListener('click', () => vwZoom(1))
$('vw-fit').addEventListener('click', () => { VW.z = FIT_INDEX; scheduleViewer() })
$('vw-close').addEventListener('click', () => { $('viewer').hidden = true })
$('viewer').addEventListener('click', (e) => { if (e.target === $('viewer')) $('viewer').hidden = true })
$('vw-edit').addEventListener('click', () => {
  $('viewer').hidden = true
  openEditor(VW.i)
})

// Ctrl/Cmd + wheel zooms, matching every other document viewer.
$('vw-stage').addEventListener('wheel', (e) => {
  if (!e.ctrlKey && !e.metaKey) return
  e.preventDefault()
  vwZoom(e.deltaY < 0 ? 1 : -1)
}, { passive: false })

// Drag to pan once the page is bigger than the pane.
let pan = null
$('vw-stage').addEventListener('pointerdown', (e) => {
  const st = $('vw-stage')
  if (st.scrollWidth <= st.clientWidth && st.scrollHeight <= st.clientHeight) return
  pan = { x: e.clientX, y: e.clientY, l: st.scrollLeft, t: st.scrollTop }
  st.classList.add('grabbing')
  st.setPointerCapture(e.pointerId)
})
$('vw-stage').addEventListener('pointermove', (e) => {
  if (!pan) return
  const st = $('vw-stage')
  st.scrollLeft = pan.l - (e.clientX - pan.x)
  st.scrollTop = pan.t - (e.clientY - pan.y)
})
$('vw-stage').addEventListener('pointerup', () => {
  pan = null
  $('vw-stage').classList.remove('grabbing')
})


// ------------------------------------------------------------------ text editing
//
// A PDF has no paragraph model, so this replaces text one line at a time and
// nothing reflows. See the note above replaceLine() in worker.js.

let textMode = false
let textLines = []

function setTextMode (on) {
  textMode = on
  $('vw-text').classList.toggle('primary', on)
  $('vw-layer').hidden = !on
  if (!on) {
    $('vw-layer').textContent = ''
    $('vw-count').textContent = ''
    textLines = []
  }
}

$('vw-text').addEventListener('click', async () => {
  setTextMode(!textMode)
  if (textMode) await loadTextLines()
})

async function loadTextLines () {
  try {
    const res = await busy('Finding text\u2026', () => call('textLines', { index: VW.i }))
    textLines = res.lines
    drawTextLayer()
  } catch (err) {
    toast(err.message, true)
    setTextMode(false)
  }
}

function drawTextLayer () {
  const layer = $('vw-layer')
  layer.textContent = ''
  if (!textMode) return
  const s = VW.scale || 1
  textLines.forEach((ln, i) => {
    const box = document.createElement('div')
    box.className = 'tline'
    box.style.left = ln.rect[0] * s + 'px'
    box.style.top = ln.rect[1] * s + 'px'
    box.style.width = Math.max(8, (ln.rect[2] - ln.rect[0]) * s) + 'px'
    box.style.height = Math.max(8, (ln.rect[3] - ln.rect[1]) * s) + 'px'
    box.title = ln.text
    box.addEventListener('click', (e) => { e.stopPropagation(); editLine(i, box) })
    layer.appendChild(box)
  })
  $('vw-count').textContent = textLines.length
    ? `${textLines.length} line${textLines.length === 1 ? '' : 's'} \u2013 click one to retype it`
    : 'no text layer on this page'
}

function editLine (i, box) {
  const ln = textLines[i]
  const s = VW.scale || 1
  const input = document.createElement('input')
  input.className = 'tedit'
  input.value = ln.text
  input.style.left = box.style.left
  input.style.top = box.style.top
  // Give it room to grow: the replacement is usually longer than the original.
  input.style.width = Math.max(80, parseFloat(box.style.width) + 60) + 'px'
  input.style.height = Math.max(16, parseFloat(box.style.height) + 4) + 'px'
  input.style.fontSize = Math.max(9, ln.size * s * 0.9) + 'px'
  $('vw-layer').appendChild(input)
  input.focus()
  input.select()

  let settled = false
  const finish = async (save) => {
    if (settled) return
    settled = true
    const value = input.value
    input.remove()
    if (!save || value === ln.text) return
    try {
      await apply('Replacing text\u2026', 'replaceLine', {
        index: VW.i,
        rect: ln.rect, x: ln.x, y: ln.y, size: ln.size,
        text: value,
        family: ln.family, bold: ln.bold, italic: ln.italic, color: ln.color,
      })
      // apply() calls adopt(), which closes every overlay because page indices
      // may have moved. Nothing structural changed here, so come straight back.
      $('viewer').hidden = false
      setTextMode(true)
      await drawViewer()
      await loadTextLines()
      toast(value.trim() ? 'Text replaced.' : 'Line removed.')
    } catch (err) { /* apply() has already surfaced the message */ }
  }

  // Stop keys reaching the viewer's own arrow/zoom shortcuts while typing.
  input.addEventListener('keydown', (e) => {
    e.stopPropagation()
    if (e.key === 'Enter') { e.preventDefault(); finish(true) }
    if (e.key === 'Escape') { e.preventDefault(); finish(false) }
  })
  input.addEventListener('blur', () => finish(true))
}
