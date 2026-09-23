# PhotoGrid (web)

A photo layout studio: drag photos in, arrange them in a customisable grid (default 4 × 5), crop each photo to a square cell (default 4.4 cm × 4.4 cm), add cutting borders and a name footer, then export a print-ready PDF or Word file.

## Privacy

**Your photos never leave this device.** Everything — decoding HEIC, cropping, generating PDF/DOCX — runs inside your browser. There is no server, no upload, no analytics, no telemetry. The only network requests the page ever makes are to load the app code itself (HTML/CSS/JS and a handful of library files), and after the first visit those are cached, so subsequent loads make zero network requests for your photos or anything else.

You can verify this yourself by opening DevTools → Network while you drop photos in. Nothing fires.

## Offline

PhotoGrid is a fully installable PWA.

**To install:**

- **Chrome / Edge / Brave (desktop or Android):** an "Install app" button appears in the top bar once the page passes the install criteria (manifest + service worker + a few seconds of engagement). You can also use the browser's address-bar install icon, or menu → "Install PhotoGrid".
- **Safari (iOS / iPadOS):** Share → "Add to Home Screen". A tip explaining this appears the first time you visit on an iOS device.
- **Safari (macOS):** File → "Add to Dock" (Safari 17+).
- **Firefox:** doesn't currently expose install for normal sites; use Chrome/Edge if you want to install.

Once installed:

- Runs in its own standalone window, no browser chrome.
- The app shell and every CDN library are cached by a service worker, so it loads and works fully **with no internet connection**.
- A tiny dot in the top-right shows your connection state — green = online, grey + "offline" label = offline. Either way, the app works the same.

**App icons** are provided as 192 px and 512 px PNGs, plus a maskable variant so the app looks right under Android's adaptive-icon mask, plus an SVG that scales to any size.

## Quick deploy with the GitHub CLI

```
bash deploy.sh photogrid
```

This creates a public GitHub repo named `photogrid`, pushes the code, and enables GitHub Pages via the included Actions workflow. The first deploy takes ~30–60 s.

For a private repo: `bash deploy.sh photogrid private`.

Once it's up, your site is at `https://<your-username>.github.io/photogrid/`. Any later push to `main` redeploys automatically.

## Running locally

It's static HTML/JS/CSS, so you can open `index.html` directly — *but* most browsers refuse to load HEIC files from a `file://` URL. Either:

```
python3 -m http.server 8000   # then open http://localhost:8000/
```

or any other simple static server (`npx serve`, `caddy file-server`, etc.).

## Features

- **Studio layout.** A tool bar on the left (Photos, Crop, Layout, Borders, Footer) opens a side panel. The pages sit on a canvas, with a toolbar above for the selected photo and page, and a bottom bar for moving between pages and zooming (slider, Ctrl/⌘ + scroll, or *Fit*). On a phone the panel becomes a bottom sheet.
- **Drag-and-drop anywhere** in the window, or click *Upload photos*.
- **Per-photo crop.** Select a photo and open *Crop*: drag to choose what shows in the cell, and zoom with the slider or the scroll wheel. Every cell showing that photo updates live.
- **Portrait or landscape — per page or all pages.** With *Apply to all pages* ticked, the orientation control changes every page. Untick it and it changes only the selected page (click a page, or a photo on it, to select it). If the grid doesn't fit a page's shape, it turns sideways (4 × 5 becomes 5 × 4), so every page keeps the same number of photos. The rotate button above each page and the right-click menu do the same.
- **Cell borders** (off by default; *Borders* panel). When turned on they start as light grey dashes, a handy cutting guide. Styles: Regular, Thick, Dashed, Dotted, Dash-dot, Dual parallel, Tri-lined, Thin-thick, Zig-zag and Dual zig-zag, in any colour. The preview, PDF and Word file use the same settings; Word draws the zig-zag styles as smooth waves.
- **File-name footer** (on by default; *Footer* panel). When you export, the name you give the file is printed at the bottom of every page, so it's easy to tell whose sheet is whose. Font (sans serif, serif, monospace), size, bold, italic, alignment and colour are all adjustable. Clicking the footer on a page opens its settings.
- **Save dialog first.** Export asks for the file name *before* building the document so the footer can use it. Chrome and Edge show their normal *Save as* dialog; Safari and Firefox show a name box in the app and then download the file.
- **Compress images** (on by default; *Export* card). Each photo is cut down to the part visible in its cell and resized to its printed size at the chosen resolution. Photos are never enlarged. This keeps files small (about 110 KB per photo at *Print*) and avoids printing problems with lots of high-resolution photos:
  - *Print*: 300 DPI, JPEG quality 0.92
  - *Reduced*: 200 DPI, quality 0.82
  - *Minimum*: 110 DPI, quality 0.72

  Turn it off to keep each photo's full resolution (still cropped). Files get much bigger.
- **Live preview** of the printed pages: rows × columns, cell size, paper size, margins and spacing. A warning appears if the grid is too big for a page.
- **Keyboard**: arrow keys move the selection, Ctrl/⌘ + ↑/↓ reorders, Delete removes.
- **PDF and Word match the preview.** Same page sizes and orientations, same photo positions, borders and footer.
- **HEIC support** via the system codec where available, otherwise libheif (WASM) in a worker.
- **Fast ingestion**: photos are decoded in parallel and small thumbnails drive the UI; full-resolution photos are only read at export time.
- **Light + dark mode** automatic.

## Customisation defaults (all editable in the UI)

| Setting | Default |
|--|--|
| Columns × Rows | 4 × 5 |
| Cell size | 4.4 cm × 4.4 cm (square) |
| Page | A4 portrait, all pages |
| Margins | 12 mm |
| Gap between photos | 3 mm |
| Trim unused rows on last page | on |
| Crop photos to fill cells | on |
| Cell borders | off (when turned on: dashed, light grey) |
| File-name footer | on (sans serif, 10 pt, dark grey, centred) |
| Compress images | on (Print, 300 DPI) |

## Tech

- Static HTML/CSS/JS — no build step.
- `layout.js` works out page geometry (orientation, grid, footer position) and `borders.js` describes the border styles; both are shared by the preview, the PDF export and the Word export.
- `heic2any` for HEIC decode (libheif/WASM).
- `jsPDF` for PDF export.
- `docx` (`docx.js`) for Word export.
- `file-saver` for the download.

All libraries load from jsDelivr CDN.
