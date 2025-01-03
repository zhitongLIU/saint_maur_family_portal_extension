// Global variables
const BUTTON_TEXT = {
  default: 'Download',
  loading: 'Loading...'
};

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
    warningMessage.innerHTML = 'Merci de vous connecter sur le <a href="https://portalssl.agoraplus.fr/smdf/pck_home.home_view#/" target="_blank">portail famille</a>';
    warningMessage.style.display = 'block';
  } else {
    saveButton.disabled = false;
    warningMessage.style.display = 'none';
  }
}

// Initialize date selectors and UI
document.addEventListener('DOMContentLoaded', () => {
  populateYears();
  setDefaultMonths();
  
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
});

// Function to be executed in the tab context
function getSessionIdFromTab() {
  return sessionStorage.getItem("SESSION_ID_smdf");
} 