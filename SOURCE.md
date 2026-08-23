# Source and licences

This site bundles third-party code. The complete corresponding source for each
component is available at the links below.

## MuPDF (`vendor/mupdf/`)

MuPDF.js 1.28.0, by Artifex Software, Inc.
Licensed under the **GNU Affero General Public License, version 3 or later**.
The full licence text is in `vendor/mupdf/LICENSE`.

- Upstream source: <https://cgit.ghostscript.com/mupdf.git/>
- npm package: <https://www.npmjs.com/package/mupdf>

The AGPL requires that users interacting with this software over a network be
offered its source. The files shipped here are the unmodified npm distribution
(`mupdf.js`, `mupdf-wasm.js`, `mupdf-wasm.wasm`), and the source of this site
itself is the repository containing this file.

## pdf-lib (`vendor/pdf-lib.esm.min.js`)

pdf-lib 1.17.1, MIT licensed. <https://github.com/Hopding/pdf-lib>

## This site

`index.html`, `app.js`, `worker.js`, `styles.css`. Because it links against
MuPDF, the combined work is distributed under the AGPL-3.0-or-later.
