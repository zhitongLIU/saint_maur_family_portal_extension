import { fetchChildIds, fetchEvents } from './background/api.js';
import { generateICSContent } from './background/ics-generator.js';
import { generateFilename, downloadICSFile } from './background/file-handler.js';

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'fetchReservations') {
    handleReservations();
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