// File handling related functions
function generateFilename(fromDate, toDate, childName, childLastName) {
  const [fromDay, fromMonth, fromYear] = fromDate.split('/');
  const [toDay, toMonth, toYear] = toDate.split('/');
  return `${childName}_${childLastName}-peri-scolaire_${fromYear}-${fromMonth}_${toYear}-${toMonth}.ics`;
}

function downloadICSFile(icsContent, filename) {
  return new Promise((resolve, reject) => {
    const blob = new Blob([icsContent], { type: 'text/calendar' });
    const reader = new FileReader();
    
    reader.onload = async (e) => {
      try {
        await chrome.downloads.download({
          url: e.target.result,
          filename: filename,
          saveAs: true
        });
        resolve();
      } catch (error) {
        reject(error);
      }
    };
    
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

export { generateFilename, downloadICSFile }; 