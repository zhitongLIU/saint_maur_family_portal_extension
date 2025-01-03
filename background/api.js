// API related functions
async function fetchChildIds(sessionId) {
  try {
    const response = await fetch('https://smdf.agoraplus.fr/InternalApi/API_CALENDAR_COMPONENT/target/?idContext=1&idFamily=', {
      headers: { 'session_id': sessionId, ref_year: 42, a_access: "agora" }
    });
    const data = await response.json();

    if (data && data.DATA && data.DATA.TARGETS) {
      return data.DATA.TARGETS.map(target => ({
        id: target.ID,
        name: target.NAME,
        lastName: target.LAST_NAME
      }));
    } else {
      console.error("Unexpected response structure:", data);
      return [];
    }
  } catch (error) {
    console.error("Error fetching child IDs:", error);
    return [];
  }
}

async function fetchEvents(sessionId, targetId) {
  // Get the date range from storage
  const { fromDate, toDate } = await chrome.storage.local.get(['fromDate', 'toDate']);
  
  const [fromDay, fromMonth, fromYear] = fromDate.split('/');
  const [toDay, toMonth, toYear] = toDate.split('/');
  
  const startDate = new Date(fromYear, parseInt(fromMonth) - 1, 1);
  const endDate = new Date(toYear, parseInt(toMonth) - 1, parseInt(toDay));
  
  let allEvents = [];
  
  // Fetch events month by month
  for (let currentDate = startDate; currentDate <= endDate; ) {
    const year = currentDate.getFullYear();
    const month = (currentDate.getMonth() + 1).toString().padStart(2, '0');
    
    // Calculate first and last day of the month
    const firstDay = '01';
    const lastDay = new Date(year, currentDate.getMonth() + 1, 0).getDate().toString().padStart(2, '0');
    
    // Format dates for API call
    const monthStartDate = `${firstDay}/${month}/${year}`;
    const monthEndDate = `${lastDay}/${month}/${year}`;
    
    try {
      const response = await fetch(
        `https://smdf.agoraplus.fr/InternalApi/API_CALENDAR_COMPONENT/events/?idContext=1&targets=${targetId}&startDate=${monthStartDate}&endDate=${monthEndDate}`,
        {
          headers: { 'session_id': sessionId, ref_year: 42, a_access: "agora" }
        }
      );
      const data = await response.json();
      
      if (data && data.DATA && data.DATA.EVENTS) {
        allEvents = allEvents.concat(data.DATA.EVENTS);
      }
    } catch (error) {
      console.error(`Error fetching events for ${month}/${year}:`, error);
    }
    
    // Move to next month
    currentDate.setMonth(currentDate.getMonth() + 1);
  }
  
  return allEvents;
}

export { fetchChildIds, fetchEvents }; 