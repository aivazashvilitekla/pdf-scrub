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

**Whiten a scan.** A scanned book page is one big photo of the paper, so its
"white" is a light gray that a printer covers in ink. *Clean up a scan* measures
the paper colour on each page image, stretches the levels so the paper becomes
pure white and the print black, and swaps the image in place. Page size, layout
and any OCR text layer are untouched; photos, stencil masks and small logos are
left alone. Three strengths, optional conversion to grayscale, and the file
usually gets smaller because a mostly-white image compresses far better.

**Make a book from text.** *New from text* opens a box to paste into. Every line
break starts a paragraph (or, in blank-line mode, blank lines do), `# ` starts a
chapter on a fresh page, `## ` is a subheading and `***` a scene break. With
*detect chapter titles* on, a line in CAPITALS, a roman numeral alone or
*Part One* opens a chapter too, so a novel pasted from an ebook needs no markup.
Chapters open centred a fifth of the way down the page, body pages carry the
title as a running head, and the title page takes an optional subtitle. Choose A4 / A5 / Letter, serif
or sans, the size, justification and page numbers; an optional title and author
make a title page. The output is real, searchable text in the built-in fonts, so a
whole novel is a few hundred kilobytes. Western European text only - see below.

**Match an original.** With a PDF open, the book maker can *Use its text* (the
text layer, rebuilt into paragraphs, hyphenation undone, page numbers dropped) and
*Match its layout* (page size, margins, text size, leading, indent, justification
and page numbers, measured from the text positions). Paste a corrected or
different text and the new book comes out on the same page as the original. The
typeface itself cannot be read from a scan, so serif or sans stays your choice.

**View a page.** Click any thumbnail to open it large. Arrow keys page through,
`+` / `-` / `0` or Ctrl-scroll zoom from 50% to 600% (100% fits the pane), and drag
to pan once the page is bigger than the window.

**Edit text.** Open a page, hit *Edit text*, and every line of text becomes
clickable. Click one, retype it, press Enter. The original glyphs are deleted and
the replacement is drawn on the same baseline at the same size, in a matched face
(serif/sans/mono, bold, italic) and the line's original colour, all detected from
the file. Clearing the box deletes the line. One Undo reverts the whole edit.

Two limits worth knowing before you rely on it:

- **Nothing reflows.** A PDF stores the printed result, not a document model:
  each line is an independently positioned run of glyphs with no paragraph
  relationship. A longer replacement runs past the original line's width rather
  than rewrapping the paragraph or pushing later lines down. Acrobat has the same
  limitation for the same reason. This is not Word and cannot be.
- **Western European text only.** Replacements use the fonts built into every PDF
  reader, so they add nothing to page weight and always render. That covers all
  Spanish and Western European text, including accents, em dashes and curly
  quotes, but not Cyrillic or Greek. Typing an unencodable character is refused
  *before* anything is deleted, so a rejected edit never costs you the original.

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

96 assertions driving the real `worker.js` in Node against checked-in fixtures.
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
- **No positioned class doubles as a modifier.** A class setting
  `position: absolute` is a layout primitive; combined with a component class on the
  same element it silently pulls that component out of flow. `.ghost` was both the
  editor's drag-placement box and the `.btn.ghost` button variant, which stacked
  twelve buttons on top of one another with a dashed accent border. It is now
  `.movebox`, and the test fails if any positioned class is ever combined again.
- **Every class used in the HTML is defined in the CSS**, which catches typos and
  leftovers.
- **A refused text edit destroys nothing.** `replaceLine` deletes the old glyphs
  and then draws the new ones, so validating the font encoding *after* the
  deletion would lose the original text with nothing to put back. The test drives
  a Cyrillic replacement through the real worker and asserts the page is byte-for-
  byte unchanged.

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
| Text search, true redaction, page rendering, image swap for scan clean-up | MuPDF WASM |
| Reorder, delete, rotate, merge, split, region relocation, book layout | pdf-lib |

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

## Caching

`vendor/` is immutable and cached for a year. The app's own files
(`index.html`, `app.js`, `worker.js`, `styles.css`) are served
`max-age=0, must-revalidate` and their URLs carry a `?v=` query.

Both halves matter. Without the header the CDN and browser cache the app
indefinitely; without the version bump an already-cached copy is never
revalidated, so a browser holding an old stylesheet keeps using it. Bump the `?v=`
in `index.html` (and the `worker.js?v=` in `app.js`, in step) whenever a fix has
to reach people who already loaded the page.

## Known limitations

- **Moving is disabled on rotated pages.** The selection is taken in rotated page
  space while the placement maths works in unrotated space. Rather than silently
  producing a wrong result, the button is disabled with an explanation. Set the
  rotation back to 0, move, then rotate again.
- **Scanned pages have no text layer.** If a PDF is page images with no embedded
  text, there is nothing for the search to match. Use *Redact an area* instead.
- **The book maker uses the built-in WinAnsi fonts.** Spanish and other Western
  European text is fine; Cyrillic and Greek are refused with the offending
  characters listed, or replaced with `?` if you tick that option. There is no
  hyphenation, and widows and orphans are not controlled.
- **Scan clean-up is a levels adjustment, not OCR or deskew.** It only touches
  images at least 300x300 px that are mostly light; a page drawn as a gray vector
  rectangle rather than an image is left as is.
- **A phrase split across two lines may not match.** Add a shorter fragment such
  as `hispanoteca.ru` on its own line.
- **The UI is marked `translate="no"`.** The page shows Russian and Spanish text, so
  a browser translator could decide the whole page is foreign and rewrite the
  interface labels. This is precautionary hardening, not a fix for anything observed.
- **Reordering and deleting rebuild the document,** which drops bookmarks and
  document metadata. Rotation alone is applied in place and keeps them.

## Licence

This site links against MuPDF and is therefore distributed under the
**AGPL-3.0-or-later**. Because the AGPL covers network use, deploying it publicly
means offering its source to users; the footer links to `SOURCE.md`, which points
back here. See `SOURCE.md` for the full component breakdown.
