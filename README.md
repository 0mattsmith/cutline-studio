# Cutline Studio

A photo layout studio: drag or pick photos, arrange them in a customisable grid (default 4 × 5), crop each photo to a square cell (default 4.4 cm × 4.4 cm), add cutting borders and a name footer, then export a print-ready PDF or Word file.

Runs as:
- **Installable PWA** (Android phones & tablets including Honor Pad 10, iPadOS/iOS, Windows, macOS, Linux) with seamless automatic updates from GitHub Pages.
- **Native Android APK** (published automatically via GitHub Releases) with offline-first bundled assets and built-in GitHub release version checker & updater.
- **Microsoft Word Add-in** (Desktop / Web Word ribbon button via `manifest-prod.xml`).

## Privacy

**Your photos never leave this device.** Everything — decoding HEIC, cropping, generating PDF/DOCX — runs locally on-device. There is no upload server, no analytics, and no telemetry; all runtime libraries are vendored directly in `vendor/`.

## Offline & Auto-Updates

Cutline Studio is a fully installable PWA and standalone Android APK.

**To install:**

- **Android (Chrome / Edge, phones & tablets e.g. Honor Pad 10):** tap **Install app** in the top bar (or browser menu → *Install app*), or download the latest signed `.apk` from [GitHub Releases](https://github.com/0mattsmith/cutline-studio/releases).
- **Windows / macOS (Chrome / Edge):** click the address-bar install icon or **Install app** button.
- **Safari (iOS / iPadOS):** Share → **Add to Home Screen**.
- **Safari (macOS):** File → **Add to Dock**.

**Automatic updates:**

- **PWA:** checks `version.json` and the Service Worker on launch, when returning to the app, and periodically; applies updates seamlessly when idle (or prompts with **Update now** if photos are currently loaded).
- **Android APK:** automatically checks GitHub Releases on launch, downloads newer `.apk` releases in the background on Wi-Fi, and prompts with a one-tap **Install** (tap the version badge `vX.Y.Z` anytime to view status or check manually).

## Releasing a new version (PWA + Android APK)

1. Run `node scripts/bump-version.mjs 1.2.0 "Your release notes"` (keeps `version.json`, `package.json`, `app.js`, `index.html`, `service-worker.js`, and Android `versionName`/`versionCode` in sync).
2. Commit and push to `main` (e.g. `bash update.sh "Release v1.2.0"`).
3. GitHub Actions automatically deploys the updated PWA to GitHub Pages and builds, signs, and publishes `CutlineStudio-v1.2.0.apk` to GitHub Releases.

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

- Static HTML/CSS/JS — no web build step.
- `layout.js` works out page geometry (orientation, grid, footer position) and `borders.js` describes the border styles; both are shared by the preview, the PDF export and the Word export.
- Local vendored libraries in `vendor/` (no external runtime CDN dependencies): `libheif-js` (WASM HEIC decode), `jsPDF` (PDF export), `docx` (Word export), and `file-saver`.
- `android/` hosts a lightweight Kotlin + `WebViewAssetLoader` wrapper supporting Android phones and tablets (e.g. Honor Pad 10), native Downloads export/share, and GitHub Release self-updates.
