# pdf-scrub

A browser-only PDF tool: strips a repeated watermark line, edits text line by line,
whitens the gray paper of scanned pages, moves a region of one page onto another,
does page operations, and scans for active content. Deployed to Vercel as a static site.

Live repo: `github.com/aivazashvilitekla/pdf-scrub`.

---

## This project is not Drupal work

The parent folder's `CLAUDE.md` covers drupal.org contribution work. **Those rules do
not apply here.** In particular:

- **Build the code directly.** Do not write a guide and hand it over. That
  preference is about drupal.org issues, where the user does the work themselves.
- There is no ddev site, no module checkout, no issue node, no MR.
- **This directory IS a git repo** (unlike the ddev sites one level up).

What still applies, because they are global: **never use an em dash, use a plain
hyphen**, and verify every factual claim before stating it.

---

## Architecture

```
index.html   markup only
styles.css   all styling
app.js       DOM, state, coordinates. NO PDF logic.
worker.js    ALL PDF work, in a module worker, off the main thread.
vendor/      pinned library copies, committed deliberately
test/run.mjs 73 assertions, driven in Node with a fake worker scope
tools/       inspect.mjs, a CLI safety scanner for a file on disk
```

Everything crosses the boundary through `call(type, payload)` in `app.js` and the
`handlers` map at the bottom of `worker.js`. Current handlers:

`load` `meta` `render` `scan` `strip` `redactRect` `moveRegion` `pageOps`
`append` `extract` `inspect` `sanitize` `textLines` `replaceLine` `cleanScan`
`download` `undo`

### Division of labour, and why

| Concern | Library | Why not the other one |
| --- | --- | --- |
| Text search, true redaction, rendering, object walking, image pixels in/out (`cleanScan`) | **MuPDF 1.28.0** (wasm) | pdf-lib cannot remove text, render, or decode an image's pixels |
| Reorder, delete, rotate, merge, split, region embed, draw text | **pdf-lib 1.17.1** | MuPDF's JS bindings make these far more work |

MuPDF is **AGPL-3.0-or-later**, which is why `LICENSE` and `SOURCE.md` exist and the
footer links to them. Keep that honest if the deployment stays public.

### Two coordinate systems

The single easiest thing to get wrong.

- **MuPDF page space**: origin **top-left**, y grows **downward**. Matches the
  rendered canvas. **Every rect crossing the worker boundary uses this.**
- **pdf-lib user space**: origin **bottom-left**, y grows **upward**.

Convert in as few places as possible, against the page's **CropBox** (which is what
MuPDF renders), not the MediaBox:

```js
pdfY = cb.y + (cb.height - mupdfY)
```

Currently converted only in `moveRegion()` and `replaceLine()`. Keep it that way.

---

## Testing

```
npm test        # 59 assertions, zero dependencies to install
npm run dev     # http://127.0.0.1:8123/
```

**There is no browser automation in this environment.** The Chrome extension was
declined. So `test/run.mjs` imports the real `worker.js` with a fake worker scope and
drives every handler in Node, plus four static guards that stand in for the browser:

1. `[hidden]` cannot be overridden by any class rule
2. every `$('id')` in `app.js` exists in `index.html`
3. every `call()` targets a real worker handler
4. no positioned class doubles as a modifier, and every HTML class is defined

**When you add a guard, prove it fails without the fix.** Temporarily revert the fix,
watch the test go red, restore. A test that cannot fail is worse than no test - one
was shipped here (`(() => true)()`) and had to be replaced.

**When a diagnostic confirms your hypothesis, suspect the diagnostic.** Both times a
probe here "confirmed" a bug, the probe was wrong: a leak test whose fixture already
contained the string it searched for, and a byte-level check defeated by stream
compression.

---

## Gotchas, all learned the hard way

1. **`[hidden]` loses to any class rule that sets `display`.** `[hidden]` in the UA
   stylesheet is specificity 0,1,0, identical to a class, so `.busy { display: grid }`
   wins on cascade order and pins the element on screen forever. `styles.css` has a
   load-bearing `[hidden] { display: none !important; }` near the top. Do not remove it.
2. **Never reuse a class name that sets `position: absolute`.** `.ghost` was both the
   editor's drag box and a `.btn.ghost` button variant, which yanked 14 buttons out of
   flow and stacked them. It is `.movebox` now. A test enforces this.
3. **Bump `?v=` on the app's own assets when a fix must reach an existing user.**
   `index.html` versions `styles.css` and `app.js`; `app.js` versions `worker.js`.
   Cache headers alone do not help, because a browser holding a long-lived copy never
   revalidates. This hid three rounds of fixes.
4. **Validate before destroying.** `replaceLine` deletes glyphs then draws new ones,
   so the font-encoding check must run *first*, or a rejected edit loses the original
   with nothing to put back. Same shape of rule applies to any new destructive op.
5. **A PDF cannot reflow.** It stores the printed result, not a document model. Text
   replacement is per line; a longer replacement will not rewrap. Do not promise
   Word-like editing. Acrobat has the same limit for the same reason.
6. **Built-in fonts are WinAnsi.** All Spanish and Western European text works,
   including accents, em dashes and curly quotes. Cyrillic and Greek do not. pdf-lib
   throws `WinAnsi cannot encode "К" (0x041a)`; surface that, do not swallow it.
7. **Copy anything MuPDF hands back before keeping or transferring it.** Views can
   point into wasm memory. `copyOut()` exists for this.
8. **Normalise through MuPDF on load.** Ebooks are often encrypted with an empty user
   password, so `needsPassword()` is false while the streams are still encrypted.
   MuPDF decrypts correctly, pdf-lib does not. `handlers.load` re-saves for this reason.
9. **Grep the raw bytes and you find nothing.** Most PDF objects live inside
   compressed object streams. `inspect`/`sanitize` walk every indirect object instead.
10. **Reorder and delete rebuild the document**, dropping bookmarks and metadata.
    Rotation alone is applied in place to preserve them. `pageOps` branches on this.
11. **A grid-centred item wider than its track cannot be scrolled to.** It overflows
    both sides equally. The viewer uses `display: block` + `margin: 0 auto` so zoom
    scrolls from the left.
12. **Take every `getPixels()` view after the last wasm allocation.** The view is a
    window into wasm memory; allocating another Pixmap can grow that memory and
    detach every earlier view, which then reads as empty with no error. `whitenPixmap`
    allocates its output first and only then takes both views. Same family as gotcha 7.
13. **`cleanScan` swaps the image XObject, it does not re-render the page.** That is
    what keeps the OCR text layer, the geometry and the content stream intact. It
    skips stencil masks, soft-masked images, anything under 300x300 px and any image
    whose pixels are less than half light, so photos survive.
14. **`aspect-ratio` only sets a preferred size.** `min-height: auto` lets intrinsic
    content win, which stretched the page thumbnails. They carry `min-height: 0`.

---

## Deploy

Static, no build step. Push to `main` and Vercel redeploys.

```
npx vercel --prod     # only if the git integration is not doing it
```

`vercel.json` caches `vendor/` for a year (pinned copies, genuinely immutable) and
serves the app's own files `max-age=0, must-revalidate`. See gotcha 3.
