# Agent notes (saint_maur_family_portal_extension)

This repository is a **Chrome Extension (Manifest V3)** written in **vanilla HTML/CSS/JavaScript** (no build step).

It provides two main utilities for the Saint-Maur Portail Famille (AgoraPlus):
1) Export **périscolaire reservations** to an **ICS calendar** file (importable into Google Calendar / Apple Calendar / etc.).
2) Convert **monthly invoice PDFs** (page 1 table) into **CSV** for expense exploration and reporting (incl. childcare-related categorization).

## Quick start (manual install)
- Open Chrome → `chrome://extensions/`
- Enable **Developer mode**
- Click **Load unpacked** and select this repo folder

## How it works
- `manifest.json`: MV3 entrypoint + permissions + host permissions.
- `popup.html` / `popup.js` / `popup.css`: Popup UI:
  - **ICS export**: pick date range + optional monthly payment reminder day; extracts `SESSION_ID_smdf` from the active portal tab's `sessionStorage`.
  - **PDF → CSV**: drag & drop (or file picker) invoice PDFs, parses page 1 with PDF.js, stores results in an in-memory list, supports per-file download and a merged CSV download.
- `background.js`: MV3 service worker; listens for `fetchReservations` and orchestrates API calls + ICS generation + download.
- `background/api.js`: Fetches child ids + calendar events from AgoraPlus endpoints using `session_id` header; fetches month-by-month across the selected range.
- `background/ics-generator.js`: Converts events (+ optional reminder) into an `.ics` payload.
- `background/file-handler.js`: Generates filenames and downloads files via the Downloads API (`.ics` and `.csv`).
- `vendor/pdfjs/*`: Vendored PDF.js runtime used for local PDF parsing in the popup.

## Development workflow
- Edit JS/HTML/CSS in place (no bundler).
- In `chrome://extensions/`, click **Reload** on the extension after changes.
- Use Chrome DevTools:
  - Popup: right-click popup → **Inspect**
  - Service worker: `chrome://extensions/` → extension → **Service worker** (inspect)

## Notes
- Extension targets `portalssl.agoraplus.fr` / `smdf.agoraplus.fr` (see `manifest.json`).
- Sample PDFs live in `invoices_examples/` (not required for running the extension).
