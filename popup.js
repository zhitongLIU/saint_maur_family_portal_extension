// Global variables
const BUTTON_TEXT = {
  default: 'Download',
  loading: 'Loading...'
};

const CSV_HEADER = 'month;category;description;quantity;tarif;montant';

const pdfExports = [];
let pdfExportSeq = 0;
const MAX_PDF_FILES = 24;

function getCategoryFromDescription(description) {
  const dRaw = normalizeTokenText(description);
  const d = normalizedComparable(dRaw);
  if (d.startsWith('accueil ') || d === 'accueil' || d.startsWith('vacances ') || d === 'vacances' || d.startsWith('penalite accueil')) return 'Garde';
  if (d.startsWith('restauration ') || d === 'restauration') return 'Resturation';
  return 'Other';
}

// Populate year dropdowns
function populateYears() {
  const currentYear = new Date().getFullYear();
  const fromYear = document.getElementById('fromYear');
  const toYear = document.getElementById('toYear');
  
  for (let year = currentYear - 1; year <= currentYear + 1; year++) {
    const option = document.createElement('option');
    option.value = year;
    option.textContent = year;
    fromYear.appendChild(option.cloneNode(true));
    toYear.appendChild(option);
  }

  // Set default values to current year
  fromYear.value = currentYear;
  toYear.value = currentYear;
}

// Set default month to current month
function setDefaultMonths() {
  const currentMonth = (new Date().getMonth() + 1).toString().padStart(2, '0');
  document.getElementById('fromMonth').value = currentMonth;
  document.getElementById('toMonth').value = currentMonth;
}

// Get the last day of a month
function getLastDayOfMonth(year, month) {
  // month is 1-based in our selectors but Date expects 0-based month
  return new Date(year, month, 0).getDate();
}

// Check if we're on the correct page and update UI accordingly
function updateUIBasedOnURL(url) {
  const saveButton = document.getElementById('saveEvents');
  const warningMessage = document.getElementById('warningMessage');
  
  if (!url || !url.includes('portalssl.agoraplus.fr')) {
    saveButton.disabled = true;
    warningMessage.innerHTML = 'Merci de vous connecter sur le <a href="https://portalssl.agoraplus.fr/smdf/pck_home.home_view#/" target="_blank" rel="noopener noreferrer">portail famille</a>';
    warningMessage.style.display = 'block';
  } else {
    saveButton.disabled = false;
    warningMessage.style.display = 'none';
  }
}

function setPdfStatus(text, { isError = false } = {}) {
  const statusEl = document.getElementById('pdfStatus');
  if (!statusEl) return;
  statusEl.textContent = text || '';
  statusEl.classList.toggle('error', !!isError);
}

function getReadyExports() {
  return pdfExports.filter(e => e.status === 'ready');
}

function getPdfResultsListEl() {
  return document.getElementById('pdfResultsList');
}

function updateMergeButtonState() {
  const mergeBtn = document.getElementById('downloadMergedCsv');
  if (!mergeBtn) return;
  mergeBtn.disabled = getReadyExports().length === 0;
}

function renderPdfExports() {
  const listEl = getPdfResultsListEl();
  if (!listEl) return;
  listEl.innerHTML = '';

  for (const exp of pdfExports) {
    const itemEl = document.createElement('div');
    itemEl.className = 'pdf-item';

    const leftEl = document.createElement('div');
    leftEl.className = 'pdf-item-left';

    if (exp.status === 'parsing') {
      const spinner = document.createElement('div');
      spinner.className = 'spinner';
      leftEl.appendChild(spinner);
    }

    const titleWrap = document.createElement('div');
    titleWrap.style.minWidth = '0';

	    const titleEl = document.createElement('div');
	    titleEl.className = 'pdf-item-title';
	    if (exp.status === 'ready') {
	      titleEl.textContent = `${exp.month} | ${exp.rows.length} lignes | ${exp.sourceFilename}`;
	    } else if (exp.status === 'parsing') {
	      titleEl.textContent = `Analyse en cours — ${exp.sourceFilename}`;
	    } else {
	      titleEl.textContent = `Erreur — ${exp.sourceFilename}`;
	    }
	    // Show full text on hover (native tooltip), since the title is ellipsized in the UI.
	    titleEl.title = titleEl.textContent;
	    titleWrap.appendChild(titleEl);

    if (exp.status === 'error') {
      const metaEl = document.createElement('div');
      metaEl.className = 'pdf-item-meta';
      metaEl.textContent = exp.errorMessage || 'Erreur inconnue';
      titleWrap.appendChild(metaEl);
    }

    leftEl.appendChild(titleWrap);

    const actionsEl = document.createElement('div');
    actionsEl.className = 'pdf-item-actions';

    if (exp.status === 'ready') {
      const downloadBtn = document.createElement('button');
      downloadBtn.className = 'tiny-button';
      downloadBtn.textContent = 'Download';
      downloadBtn.addEventListener('click', () => downloadSingleExport(exp.id));
      actionsEl.appendChild(downloadBtn);
    }

    if (exp.status !== 'parsing') {
      const removeBtn = document.createElement('button');
      removeBtn.className = 'tiny-button danger';
      removeBtn.textContent = 'Remove';
      removeBtn.addEventListener('click', () => removeExport(exp.id));
      actionsEl.appendChild(removeBtn);
    }

    itemEl.appendChild(leftEl);
    itemEl.appendChild(actionsEl);
    listEl.appendChild(itemEl);
  }

  updateMergeButtonState();
}

function removeExport(id) {
  const idx = pdfExports.findIndex(e => e.id === id);
  if (idx !== -1) pdfExports.splice(idx, 1);
  renderPdfExports();
}

function buildCsvFromRows(rows) {
  const lines = [CSV_HEADER];
  for (const row of rows) {
    lines.push([
      csvEscape(row.month),
      csvEscape(getCategoryFromDescription(row.description)),
      csvEscape(row.description),
      csvEscape(row.quantity),
      csvEscape(row.tarif),
      csvEscape(row.montant)
    ].join(';'));
  }
  return lines.join('\n') + '\n';
}

function makeUniqueFilename(baseFilename) {
  // baseFilename is like facture_2025-04.csv
  const seen = new Set(pdfExports.filter(e => e.status === 'ready').map(e => e.filename).filter(Boolean));
  if (!seen.has(baseFilename)) return baseFilename;
  const dot = baseFilename.lastIndexOf('.');
  const stem = dot === -1 ? baseFilename : baseFilename.slice(0, dot);
  const ext = dot === -1 ? '' : baseFilename.slice(dot);
  let i = 2;
  while (seen.has(`${stem}_${i}${ext}`)) i++;
  return `${stem}_${i}${ext}`;
}

function fixMojibakeUtf8(str) {
  // Repair common UTF-8-as-latin1 mojibake like "QuantitÃ©" -> "Quantité"
  const s = String(str ?? '');
  if (!/[ÃÂ]/.test(s)) return s;
  try {
    // eslint-disable-next-line no-undef
    return decodeURIComponent(escape(s));
  } catch {
    return s;
  }
}

function isPdfFile(file) {
  if (!file) return false;
  if (file.type === 'application/pdf') return true;
  return /\.pdf$/i.test(file.name || '');
}

function csvEscape(value) {
  const str = String(value ?? '');
  if (/[;"\n\r]/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

function normalizeTokenText(str) {
  return normalizeSpaces(fixMojibakeUtf8(str));
}

function normalizedComparable(str) {
  return stripDiacritics(normalizeTokenText(str)).toLowerCase();
}

function parseMonthFromPeriodLine(text) {
  // Example: "Période du 01/09/2025 au 30/09/2025"
  const match = text.match(/P[ée]riode du\s+(\d{2})\/(\d{2})\/(\d{4})\s+au\s+(\d{2})\/(\d{2})\/(\d{4})/i);
  if (!match) return null;
  const month = match[2];
  const year = match[3];
  return `${year}-${month}`;
}

function parseMonthFromPeriscolaireTitle(text) {
  // Example: "PERISCOLAIRE SEPTEMBRE 2025"
  const match = text.match(/PERISCOLAIRE\s+([A-ZÉÈÊËÎÏÔÖÛÜÀÂÇ]+)\s+(\d{4})/i);
  if (!match) return null;
  const monthName = stripDiacritics(match[1]).toUpperCase();
  const year = match[2];
  const monthMap = {
    JANVIER: '01',
    FEVRIER: '02',
    MARS: '03',
    AVRIL: '04',
    MAI: '05',
    JUIN: '06',
    JUILLET: '07',
    AOUT: '08',
    SEPTEMBRE: '09',
    OCTOBRE: '10',
    NOVEMBRE: '11',
    DECEMBRE: '12'
  };
  const month = monthMap[monthName];
  if (!month) return null;
  return `${year}-${month}`;
}

function stripDiacritics(str) {
  return String(str || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

function normalizeSpaces(str) {
  return String(str || '').replace(/\s+/g, ' ').trim();
}

function isNumericFr(str) {
  const s = normalizeSpaces(str);
  return /^-?\d+(,\d+)?$/.test(s);
}

function nearestTokenByX(tokens, targetX) {
  let best = null;
  for (const t of tokens) {
    const dx = Math.abs(t.x - targetX);
    if (!best || dx < best.dx) best = { token: t, dx };
  }
  return best?.token || null;
}

function groupTokensByLine(tokens, yTolerance = 2.5) {
  const lines = [];
  const sorted = [...tokens].sort((a, b) => b.y - a.y || a.x - b.x);
  for (const token of sorted) {
    let line = null;
    for (const existing of lines) {
      if (Math.abs(existing.y - token.y) <= yTolerance) {
        line = existing;
        break;
      }
    }
    if (!line) {
      line = { y: token.y, tokens: [] };
      lines.push(line);
    }
    line.tokens.push(token);
  }
  for (const line of lines) {
    line.tokens.sort((a, b) => a.x - b.x);
  }
  // Sort top-to-bottom for easier scanning
  lines.sort((a, b) => b.y - a.y);
  return lines;
}

async function extractInvoiceRowsFromPdf(arrayBuffer) {
  if (!window.pdfjsLib) {
    throw new Error('PDF.js not loaded');
  }

  window.pdfjsLib.GlobalWorkerOptions.workerSrc = chrome.runtime.getURL('vendor/pdfjs/pdf.worker.min.js');

  const loadingTask = window.pdfjsLib.getDocument({ data: arrayBuffer });
  const pdf = await loadingTask.promise;
  const page = await pdf.getPage(1);
  const viewport = page.getViewport({ scale: 1.0 });
  const textContent = await page.getTextContent();

  const tokens = [];
  for (const item of textContent.items || []) {
    const raw = item.str;
    const str = normalizeTokenText(raw);
    if (!str) continue;
    // transform: [a, b, c, d, e, f] where e=x, f=y in PDF.js viewport space
    const [ , , , , e, f ] = item.transform;
    const x = e;
    const y = f;
    tokens.push({ str, x, y });
  }

  // Month detection (prefer "Période du ...")
  let month = null;
  const fullText = tokens.map(t => t.str).join('\n');
  for (const line of fullText.split('\n')) {
    month = parseMonthFromPeriodLine(line);
    if (month) break;
  }
  if (!month) {
    for (const line of fullText.split('\n')) {
      month = parseMonthFromPeriscolaireTitle(line);
      if (month) break;
    }
  }
  if (!month) throw new Error('Impossible de détecter le mois de facturation');

  // Group tokens into visual lines
  const lines = groupTokensByLine(tokens, 2.5);

  // Find header line containing Quantité/Tarif/Montant
  let headerLineIndex = -1;
  let xQty = null, xTarif = null, xMontant = null;
  for (let i = 0; i < lines.length; i++) {
    const lineTextNorm = lines[i].tokens.map(t => normalizedComparable(t.str)).join(' ');
    if (/\bquantite\b/i.test(lineTextNorm) && /\btarif\b/i.test(lineTextNorm) && /\bmontant\b/i.test(lineTextNorm)) {
      headerLineIndex = i;
      const qtyToken = lines[i].tokens.find(t => normalizedComparable(t.str) === 'quantite');
      const tarifToken = lines[i].tokens.find(t => normalizedComparable(t.str) === 'tarif');
      const montantToken = lines[i].tokens.find(t => normalizedComparable(t.str) === 'montant');
      xQty = qtyToken?.x ?? null;
      xTarif = tarifToken?.x ?? null;
      xMontant = montantToken?.x ?? null;
      break;
    }
  }
  if (headerLineIndex === -1 || xQty == null || xTarif == null || xMontant == null) {
    throw new Error('Impossible de localiser les colonnes (Quantité/Tarif/Montant)');
  }

  // Stop marker: first line containing "Sous-total"
  let stopIndex = lines.findIndex((l, idx) => idx > headerLineIndex && /\bSous-?total\b/i.test(l.tokens.map(t => t.str).join(' ')));
  if (stopIndex === -1) stopIndex = lines.length;

  const rows = [];
  for (let i = headerLineIndex + 1; i < stopIndex; i++) {
    const line = lines[i];
    const lineText = line.tokens.map(t => t.str).join(' ');
    if (!lineText) continue;

    const qtyToken = nearestTokenByX(line.tokens, xQty);
    const tarifToken = nearestTokenByX(line.tokens, xTarif);
    const montantToken = nearestTokenByX(line.tokens, xMontant);

    const quantity = qtyToken?.str ?? '';
    const tarif = tarifToken?.str ?? '';
    const montant = montantToken?.str ?? '';

    if (!isNumericFr(quantity) || !isNumericFr(tarif) || !isNumericFr(montant)) {
      continue;
    }

    const descriptionTokens = line.tokens.filter(t => t.x < xQty - 5);
    const description = normalizeSpaces(descriptionTokens.map(t => t.str).join(' '));
    if (!description) continue;

    rows.push({ month, description, quantity: normalizeSpaces(quantity), tarif: normalizeSpaces(tarif), montant: normalizeSpaces(montant) });
  }

  if (rows.length === 0) {
    throw new Error('Aucune ligne de tableau détectée sur la première page');
  }

  return { month, rows };
}

async function analyzePdfFileToList(file) {
  if (!isPdfFile(file)) {
    setPdfStatus('Fichier invalide: veuillez déposer un PDF.', { isError: true });
    return;
  }

  setPdfStatus('');
  const id = `pdf_${Date.now()}_${pdfExportSeq++}`;
  const exp = {
    id,
    sourceFilename: file.name || 'facture.pdf',
    status: 'parsing',
    month: null,
    rows: [],
    errorMessage: null,
    filename: null
  };
  pdfExports.unshift(exp);
  renderPdfExports();

  try {
    const arrayBuffer = await file.arrayBuffer();
    const { month, rows } = await extractInvoiceRowsFromPdf(arrayBuffer);
    exp.month = month;
    exp.rows = rows;
    exp.status = 'ready';
    exp.filename = makeUniqueFilename(`facture_${month}.csv`);
    renderPdfExports();
  } catch (err) {
    exp.status = 'error';
    exp.errorMessage = err?.message || String(err);
    renderPdfExports();
  }
}

async function analyzePdfFilesToList(filesLike) {
  const files = Array.from(filesLike || []).filter(Boolean);
  if (files.length === 0) return;
  if (files.length > MAX_PDF_FILES) {
    setPdfStatus(`Trop de fichiers: maximum ${MAX_PDF_FILES}.`, { isError: true });
    return;
  }
  // Parse sequentially to avoid overloading the popup with many concurrent PDF.js tasks.
  for (const file of files) {
    await analyzePdfFileToList(file);
  }
}

function downloadSingleExport(id) {
  const exp = pdfExports.find(e => e.id === id);
  if (!exp || exp.status !== 'ready') return;
  const csvContent = buildCsvFromRows(exp.rows);
  chrome.runtime.sendMessage({ action: 'downloadCsv', filename: exp.filename || `facture_${exp.month}.csv`, csvContent });
}

function downloadMergedCsv() {
  const ready = getReadyExports();
  if (ready.length === 0) return;

  const mergedRows = [];
  for (const exp of ready) {
    for (const row of exp.rows) mergedRows.push(row);
  }

  mergedRows.sort((a, b) => {
    if (a.month !== b.month) return a.month.localeCompare(b.month);
    return String(a.description || '').toLowerCase().localeCompare(String(b.description || '').toLowerCase());
  });

  const csvContent = buildCsvFromRows(mergedRows);
  chrome.runtime.sendMessage({ action: 'downloadCsv', filename: 'factures_merged.csv', csvContent });
}

// Initialize date selectors and UI
document.addEventListener('DOMContentLoaded', () => {
  populateYears();
  setDefaultMonths();

  // Default state until we confirm the active tab is on the portal.
  updateUIBasedOnURL(null);
  
  // Set initial button text
  document.getElementById('saveEvents').textContent = BUTTON_TEXT.default;
  
  // Load saved reminder day
  chrome.storage.local.get(['reminderDay'], (result) => {
    if (result.reminderDay) {
      document.getElementById('reminderDay').value = result.reminderDay;
    }
  });
  
  // Check current tab URL
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    if (tabs[0]) {
      updateUIBasedOnURL(tabs[0].url);
    }
  });

  // Populate reminder day options with just numbers
  const reminderSelect = document.getElementById('reminderDay');
  for (let i = 1; i <= 28; i++) {
    const option = document.createElement('option');
    option.value = i;
    option.textContent = i;
    reminderSelect.appendChild(option);
  }

  // PDF dropzone wiring
  const dropzone = document.getElementById('pdfDropzone');
  const fileInput = document.getElementById('pdfFileInput');
  if (dropzone && fileInput) {
    const onPickFiles = async (files) => analyzePdfFilesToList(files);

    dropzone.addEventListener('click', () => fileInput.click());
    dropzone.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        fileInput.click();
      }
    });

    fileInput.addEventListener('change', async () => {
      const files = fileInput.files ? Array.from(fileInput.files) : [];
      fileInput.value = '';
      if (files.length) await onPickFiles(files);
    });

    dropzone.addEventListener('dragover', (e) => {
      e.preventDefault();
      dropzone.classList.add('dragover');
    });
    dropzone.addEventListener('dragleave', () => {
      dropzone.classList.remove('dragover');
    });
    dropzone.addEventListener('drop', async (e) => {
      e.preventDefault();
      dropzone.classList.remove('dragover');
      const files = e.dataTransfer?.files ? Array.from(e.dataTransfer.files) : [];
      if (files.length) await onPickFiles(files);
    });
  }

  const mergeBtn = document.getElementById('downloadMergedCsv');
  if (mergeBtn) {
    mergeBtn.addEventListener('click', downloadMergedCsv);
  }
  updateMergeButtonState();
});

document.getElementById('saveEvents').addEventListener('click', () => {
  const saveButton = document.getElementById('saveEvents');
  saveButton.disabled = true;
  saveButton.textContent = BUTTON_TEXT.loading;

  const fromMonth = document.getElementById('fromMonth').value;
  const fromYear = document.getElementById('fromYear').value;
  const toMonth = document.getElementById('toMonth').value;
  const toYear = document.getElementById('toYear').value;
  const reminderDay = document.getElementById('reminderDay').value;

  const fromDate = `01/${fromMonth}/${fromYear}`;
  const lastDay = getLastDayOfMonth(toYear, toMonth);
  const toDate = `${lastDay}/${toMonth}/${toYear}`;

  // Store reminder day (or null if empty)
  chrome.storage.local.set({ 
    reminderDay: reminderDay ? parseInt(reminderDay) : null 
  });

  // Query the active tab in the current window
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    if (tabs.length === 0) {
      console.error("No active tab found.");
      saveButton.disabled = false;
      saveButton.textContent = BUTTON_TEXT.default;
      return;
    }

    const activeTab = tabs[0];
    updateUIBasedOnURL(activeTab.url);

    if (activeTab.url && activeTab.url.includes("portalssl.agoraplus.fr")) {
      chrome.scripting.executeScript({
        target: { tabId: activeTab.id },
        function: getSessionIdFromTab
      }, (results) => {
        if (results && results[0] && results[0].result) {
          const sessionId = results[0].result;
          chrome.storage.local.set({ 
            sessionId: sessionId.replaceAll("\"", ""),
            fromDate: fromDate,
            toDate: toDate
          }, () => {
            chrome.runtime.sendMessage({ action: 'fetchReservations' });
          });
        } else {
          console.error("Failed to retrieve session ID.");
          saveButton.disabled = false;
          saveButton.textContent = BUTTON_TEXT.default;
        }
      });
    } else {
      console.error("The active tab is not the correct page.");
      saveButton.disabled = false;
      saveButton.textContent = BUTTON_TEXT.default;
    }
  });
});

// Listen for completion message from background script
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'downloadComplete' || message.action === 'downloadError') {
    const saveButton = document.getElementById('saveEvents');
    saveButton.disabled = false;
    saveButton.textContent = BUTTON_TEXT.default;
  }
  if (message.action === 'downloadCsvComplete') {
    setPdfStatus('Téléchargement CSV terminé.');
  }
  if (message.action === 'downloadCsvError') {
    setPdfStatus('Erreur lors du téléchargement CSV.', { isError: true });
  }
});

// Function to be executed in the tab context
function getSessionIdFromTab() {
  return sessionStorage.getItem("SESSION_ID_smdf");
} 
