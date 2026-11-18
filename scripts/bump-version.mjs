#!/usr/bin/env node
/**
 * Bump Cutline Studio version consistently across:
 *   - version.json (version, versionCode, releasedAt, notes)
 *   - package.json (version)
 *   - app.js (APP_VERSION)
 *   - index.html (version badge + query-string cache buster)
 *   - service-worker.js (CACHE_VERSION)
 *
 * Usage:
 *   node scripts/bump-version.mjs 1.2.0 "Add new feature"
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const nextVersion = (process.argv[2] || "").replace(/^v/i, "").trim();
const nextNotes = process.argv.slice(3).join(" ").trim();

if (!/^\d+\.\d+\.\d+$/.test(nextVersion)) {
  console.error("Usage: node scripts/bump-version.mjs <major.minor.patch> [release notes]");
  process.exit(1);
}

const versionFile = path.join(root, "version.json");
const meta = JSON.parse(fs.readFileSync(versionFile, "utf8"));
meta.version = nextVersion;
meta.versionCode = (Number(meta.versionCode) || 1) + 1;
meta.releasedAt = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
if (nextNotes) meta.notes = nextNotes;
fs.writeFileSync(versionFile, JSON.stringify(meta, null, 2) + "\n", "utf8");

const pkgFile = path.join(root, "package.json");
const pkg = JSON.parse(fs.readFileSync(pkgFile, "utf8"));
pkg.version = nextVersion;
fs.writeFileSync(pkgFile, JSON.stringify(pkg, null, 2) + "\n", "utf8");

const appFile = path.join(root, "app.js");
let appJs = fs.readFileSync(appFile, "utf8");
appJs = appJs.replace(/const APP_VERSION = "[^"]+";/, `const APP_VERSION = "${nextVersion}";`);
fs.writeFileSync(appFile, appJs, "utf8");

const htmlFile = path.join(root, "index.html");
let html = fs.readFileSync(htmlFile, "utf8");
html = html.replace(/<span id="versionLabel">v[^<]+<\/span>/, `<span id="versionLabel">v${nextVersion}</span>`);
html = html.replace(/(src="(?:layout|borders|app)\.js\?v=)[^"]+"/g, `$1${nextVersion}"`);
fs.writeFileSync(htmlFile, html, "utf8");

const swFile = path.join(root, "service-worker.js");
let sw = fs.readFileSync(swFile, "utf8");
sw = sw.replace(/const CACHE_VERSION = "[^"]+";/, `const CACHE_VERSION = "v${nextVersion}-c${meta.versionCode}";`);
fs.writeFileSync(swFile, sw, "utf8");

console.log(`Updated Cutline Studio to v${nextVersion} (versionCode ${meta.versionCode})`);
