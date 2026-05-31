import { fetchChildIds, fetchEvents } from './background/api.js';
import { generateICSContent } from './background/ics-generator.js';
import { generateFilename, downloadICSFile, downloadCSVFile } from './background/file-handler.js';
import { syncReservationsToGoogleCalendar } from './background/google-calendar.js';

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'fetchReservations') {
    handleReservations();
  }
  if (request.action === 'syncReservationsToGoogle') {
    (async () => {
      try {
        await handleGoogleSync();
        sendResponse({ ok: true });
      } catch (e) {
        sendResponse({ ok: false, error: e?.message || String(e) });
      }
    })();
    return true; // keep service worker alive for async work + sendResponse
  }
  if (request.action === 'downloadCsv') {
    handleCsvDownload(request);
  }
});

async function handleReservations() {
  try {
    const { sessionId, fromDate, toDate } = await chrome.storage.local.get(['sessionId', 'fromDate', 'toDate']);
    
    if (!sessionId) {
      console.error("Session ID not found.");
      chrome.runtime.sendMessage({ action: 'downloadError' });
      return;
    }

    const childIds = await fetchChildIds(sessionId);
    
    for (const child of childIds) {
      const events = await fetchEvents(sessionId, child.id);
      
      if (events.length > 0) {
        await handleEventProcessing(events, fromDate, toDate, child);
      } else {
        console.log("No events found");
        chrome.runtime.sendMessage({ action: 'downloadError' });
      }
    }
  } catch (error) {
    console.error("Error in handleReservations:", error);
    chrome.runtime.sendMessage({ action: 'downloadError' });
  }
} 

async function handleCsvDownload(request) {
  try {
    const { filename, csvContent } = request || {};
    if (!filename || !csvContent) {
      chrome.runtime.sendMessage({ action: 'downloadCsvError' });
      return;
    }
    await downloadCSVFile(csvContent, filename);
    chrome.runtime.sendMessage({ action: 'downloadCsvComplete' });
  } catch (error) {
    console.error("Error in handleCsvDownload:", error);
    chrome.runtime.sendMessage({ action: 'downloadCsvError' });
  }
}

async function handleEventProcessing(events, fromDate, toDate, child) {
  try {
    const { reminderDay } = await chrome.storage.local.get(['reminderDay']);
    const icsContent = generateICSContent(events, reminderDay, fromDate, toDate, child.name, child.lastName);
    const filename = generateFilename(fromDate, toDate, child.name, child.lastName);
    
    await downloadICSFile(icsContent, filename);
    chrome.runtime.sendMessage({ action: 'downloadComplete' });
  } catch (error) {
    console.error("Error processing events:", error);
    chrome.runtime.sendMessage({ action: 'downloadError' });
  }
} 

async function handleGoogleSync() {
  try {
    chrome.runtime.sendMessage({ action: 'syncProgress', stage: 'start', detail: 'Starting Google Calendar sync…' });
    const { sessionId, fromDate, toDate } = await chrome.storage.local.get(['sessionId', 'fromDate', 'toDate']);

    if (!sessionId) {
      chrome.runtime.sendMessage({ action: 'syncError', error: 'Portal session not found. Open the Portail Famille tab and try again.' });
      return;
    }

    chrome.runtime.sendMessage({ action: 'syncProgress', stage: 'portal', detail: 'Fetching children list from portal…' });
    const childIds = await fetchChildIds(sessionId);
    if (!childIds.length) {
      chrome.runtime.sendMessage({ action: 'syncError', error: 'No children found for this portal account.' });
      return;
    }

    const childrenWithEvents = [];
    for (const child of childIds) {
      chrome.runtime.sendMessage({ action: 'syncProgress', stage: 'portal', detail: `Fetching events for ${child.name}…` });
      const events = await fetchEvents(sessionId, child.id, ({ monthStartDate, monthEndDate }) => {
        chrome.runtime.sendMessage({
          action: 'syncProgress',
          stage: 'portal',
          detail: `[${monthStartDate} → ${monthEndDate}] Fetching events for ${child.name}…`
        });
      });
      childrenWithEvents.push({ child, events });
    }

    const result = await syncReservationsToGoogleCalendar(childrenWithEvents, { fromDate, toDate }, (progress) => {
      chrome.runtime.sendMessage({ action: 'syncProgress', ...progress });
    });
    chrome.runtime.sendMessage({ action: 'syncComplete', ...result });
  } catch (error) {
    console.error("Error in handleGoogleSync:", error);
    chrome.runtime.sendMessage({ action: 'syncError', error: error?.message || 'Unknown error while syncing.' });
    throw error;
  }
}
