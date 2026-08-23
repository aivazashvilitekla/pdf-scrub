# PDF Scrub

Strips a repeated watermark line out of a PDF and does light page editing.
Everything runs in the browser - the PDF is never uploaded anywhere.

Built for hispanoteca.ru book scans, whose pages carry
`Книги на испанском от hispanoteca.ru` as a footer on every page, but the phrase
list is editable so it works for any repeated string.

## What it does

**Strip watermark text.** Enter one phrase per line, hit *Scan* to see how many
occurrences exist and where, then *Strip*. Matching glyphs are deleted from the
content stream, so the text stops being selectable, searchable and copyable. It is
removed, not painted over.

**Page operations.** Reorder by dragging, rotate, delete, merge other PDFs in,
and export a selection of pages as a new file.

**Redact an area.** In the page editor, drag a rectangle and delete whatever is
inside it, images and vector artwork included. Useful for cover images you do not
want to print.

**Move part of a page elsewhere.** Drag a rectangle on one page, pick a target
page, drag the dashed box to position it, and the region moves across. The copy is
a PDF Form XObject, so text stays crisp real text rather than a screenshot. This is
the fix for a page that wastes a whole sheet on two lines: move the lines onto the
next page, delete the image, delete the empty page.

**Safety check.** For files downloaded from the internet. Walks every indirect
object looking for JavaScript, actions that fire when the file opens, launch
actions, remote-document jumps, XFA forms and embedded files, then lists any
external links. *Remove active content* strips all of it and rebuilds the file.

Objects are walked individually rather than keyword-searched, because most objects
live inside compressed object streams where a text search finds nothing at all.
There is a command-line version for a file already on disk:

    node tools/inspect.mjs some.pdf
    node tools/inspect.mjs some.pdf --sanitize clean.pdf

This reduces risk, it does not eliminate it. It removes active content and
rebuilds the file structure, which neutralises a whole class of malformed-PDF
tricks. It cannot detect an exploit aimed at a bug in an image codec, and it is
not a virus scanner. For something you genuinely distrust, scan it with real
anti-malware as well.

*Undo* steps back through the last 12 operations.

## Run it locally

    npm run dev        # then open http://127.0.0.1:8123/

Any static file server works. It must be served over HTTP - opening `index.html`
from the filesystem will not work, because module workers and WebAssembly are
blocked on `file://`.

## Tests

    npm test

43 assertions driving the real `worker.js` in Node against checked-in fixtures.
No dependencies to install; it uses the libraries already in `vendor/`.

Three of those groups exist because there is no browser in the loop:

- **`[hidden]` cannot be overridden.** `[hidden] { display: none }` in the browser's
  own stylesheet has specificity 0,1,0, identical to a class selector, so an author
  rule like `.busy { display: grid }` wins on cascade order and pins the element on
  screen forever. That shipped once and made the whole app look frozen behind a dead
  "Working…" overlay.
- **Every `$('id')` resolves.** A mistyped id would otherwise surface only as a
  null-dereference in front of a user.
- **Every `call()` targets a real worker handler.**

## Deploy to Vercel

The repo is a plain static site with no build step.

    npx vercel            # preview deployment
    npx vercel --prod     # production

Or connect the repo in the Vercel dashboard: framework preset **Other**, no build
command, output directory **the repository root**.

`vercel.json` only sets long-lived caching for `vendor/` and pins the wasm MIME
type. There are no serverless functions, so Vercel's 4.5 MB request body limit and
function timeouts do not apply - file size is bounded only by the browser's memory.

## How it works

| Concern | Library |
| --- | --- |
| Text search, true redaction, page rendering | MuPDF WASM |
| Reorder, delete, rotate, merge, split, region relocation | pdf-lib |

Both run inside `worker.js`, off the main thread, so the UI stays responsive.
`app.js` holds no PDF logic; it only manages state, coordinates and the DOM.

Two coordinate systems meet in this codebase, which is the easiest thing to get
wrong. MuPDF page space has its origin at the **top left** with y growing
downward, and matches the rendered canvas, so every rectangle crossing the worker
boundary uses it. pdf-lib user space has its origin at the **bottom left** with y
growing upward. The conversion happens in one place only, inside `moveRegion()`,
against each page's CropBox.

On open, the file is re-saved through MuPDF before anything else touches it.
MuPDF decrypts properly and pdf-lib does not, and ebooks are often encrypted with
an empty user password - which means a file can look unprotected while its streams
are not. Normalising up front removes that trap and repairs minor damage.

## Known limitations

- **Moving is disabled on rotated pages.** The selection is taken in rotated page
  space while the placement maths works in unrotated space. Rather than silently
  producing a wrong result, the button is disabled with an explanation. Set the
  rotation back to 0, move, then rotate again.
- **Scanned pages have no text layer.** If a PDF is page images with no embedded
  text, there is nothing for the search to match. Use *Redact an area* instead.
- **A phrase split across two lines may not match.** Add a shorter fragment such
  as `hispanoteca.ru` on its own line.
- **The UI is marked `translate="no"`.** The page shows Russian and Spanish text, so
  a browser translator decides the whole page is foreign and rewrites the interface
  labels, injecting duplicate text nodes that visibly overlap the originals. If you
  still see doubled-up button text, a translator extension is overriding this.
- **Reordering and deleting rebuild the document,** which drops bookmarks and
  document metadata. Rotation alone is applied in place and keeps them.

## Licence

This site links against MuPDF and is therefore distributed under the
**AGPL-3.0-or-later**. Because the AGPL covers network use, deploying it publicly
means offering its source to users; the footer links to `SOURCE.md`, which points
back here. See `SOURCE.md` for the full component breakdown.
