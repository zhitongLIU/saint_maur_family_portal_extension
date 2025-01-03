// ICS generation related functions
function generateICSContent(events, reminderDay, fromDate, toDate, childName, childLastName) {
  let icsContent = "BEGIN:VCALENDAR\nVERSION:2.0\nPRODID:-//Peri Scolaire//EN\n";
  
  // Add regular events
  events.forEach(event => {
    icsContent += createEventBlock(event, childName, childLastName);
  });
  
  // Add reminder events if configured, or cancel them if reminderDay is null
  if (reminderDay) {
    icsContent += createReminderEvents(reminderDay, fromDate, toDate, false);
  } else {
    // Create cancellation events for existing reminders
    icsContent += createReminderEvents(1, fromDate, toDate, true);
  }
  
  icsContent += "END:VCALENDAR";
  return icsContent;
}

function createEventBlock(event, childName, childLastName) {
  let eventContent = "BEGIN:VEVENT\n";
  eventContent += `SUMMARY:${event.FULL_DESCRIPTION}\n`;
  eventContent += `DTSTART:${formatDate(event.START_DATE_TIME)}\n`;
  eventContent += `DTEND:${formatDate(event.END_DATE_TIME)}\n`;
  eventContent += `DESCRIPTION:${childName} ${childLastName}\n`;
  
  const status = event.IS_SELECTED === 0 ? "CANCELLED" : "CONFIRMED";
  eventContent += `STATUS:${status}\n`;
  
  eventContent += `UID:${event.ID_INSCRIPTION}-${event.ID_EVENT}-${event.START_DATE_TIME.replace(/[^0-9]/g, '')}\n`;
  eventContent += "END:VEVENT\n";
  return eventContent;
}

function createReminderEvents(reminderDay, fromDate, toDate, cancelled = false) {
  let reminderContent = "";
  const [fromDay, fromMonth, fromYear] = fromDate.split('/');
  const [toDay, toMonth, toYear] = toDate.split('/');
  
  // Create reminders for all months of the selected years
  const startYear = parseInt(fromYear);
  const endYear = parseInt(toYear);
  
  for (let year = startYear; year <= endYear; year++) {
    // For each year, create 12 monthly reminders
    for (let month = 1; month <= 12; month++) {
      const monthStr = month.toString().padStart(2, '0');
      const day = reminderDay.toString().padStart(2, '0');
      
      reminderContent += "BEGIN:VEVENT\n";
      reminderContent += "SUMMARY:Paiement Frais Scolaires\n";
      reminderContent += `DTSTART;VALUE=DATE:${year}${monthStr}${day}\n`;
      const nextDay = (parseInt(day) + 1).toString().padStart(2, '0');
      reminderContent += `DTEND;VALUE=DATE:${year}${monthStr}${nextDay}\n`;
      reminderContent += "DESCRIPTION:Rappel de paiement frais scolaires\n";
      // Set status based on whether this is a cancellation
      reminderContent += cancelled ? "STATUS:CANCELLED\n" : "STATUS:CONFIRMED\n";
      reminderContent += `UID:SCHOOLFEE-${year}${monthStr}\n`;
      reminderContent += "END:VEVENT\n";
    }
  }
  
  return reminderContent;
}

function formatDate(dateTime) {
  const [datePart, timePart] = dateTime.split(' ');
  const [day, month, year] = datePart.split('/');
  const [hour, minute, second] = timePart.split(':');
  return `${year}${month}${day}T${hour}${minute}${second}`;
}

export { generateICSContent, formatDate }; 