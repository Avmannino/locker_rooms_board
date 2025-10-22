// Optional: If you prefer CSV instead, set this and flip USE_CSV = true.
//   https://docs.google.com/spreadsheets/d/SPREADSHEET_ID/export?format=csv
const SHEET_CSV_URL = "https://docs.google.com/spreadsheets/d/e/2PACX-1vSBHs9gkUWmf9ANIWJn6B9JBIRlMbe-IJ0hH_gOIUZxzprhYRk0swY8zd_r83BebKl9Q6Qj7I4m1z5-/pub?output=csv";

// Toggle if you want to fetch CSV instead of JSON.
const USE_CSV = true;

/************************************
 * GENERAL SETTINGS (tweak as needed)
 ************************************/
const NEXT_WINDOW_MINUTES = 90;         // kept for reference (not used in "today" mode)
const REFRESH_EVERY_MS = 60_000;        // pull new data every 60s
const FACILITY_TIMEZONE = "America/New_York";

/************************************
 * UTILITIES
 ************************************/
const $ = (sel) => document.querySelector(sel);

function toTzDate(d) {
  // Ensures display in the facility timezone
  return new Date(d);
}

function fmtTimeRange(start, end, tz = FACILITY_TIMEZONE) {
  // Returns "3:15–4:05 PM"
  try {
    const s = new Date(start);
    const e = new Date(end);
    const opt = { hour: "numeric", minute: "2-digit", timeZone: tz };
    const sStr = new Intl.DateTimeFormat(undefined, opt).format(s);
    const eStr = new Intl.DateTimeFormat(undefined, opt).format(e);
    return `${sStr}–${eStr}`;
  } catch {
    return "";
  }
}

function fmtClock(now = new Date(), tz = FACILITY_TIMEZONE) {
  const opts = { hour: "numeric", minute: "2-digit", second: undefined, weekday: "short", month: "short", day: "numeric", timeZone: tz };
  return new Intl.DateTimeFormat(undefined, opts).format(now);
}

function fmtUpdated(now = new Date(), tz = FACILITY_TIMEZONE) {
  const opts = { hour: "numeric", minute: "2-digit", second: "2-digit", timeZone: tz };
  return new Intl.DateTimeFormat(undefined, opts).format(now);
}

/************************************
 * LOCKER / RINK PARSERS
 ************************************/
// NEW: More robust locker parser for Adult League formats
function parseLocker(text) {
  if (!text) return null;

  // 0) HOME / AWAY pairs: "Home: 1  Away: 3" or "Away-4, Home 2"
  const mHome = text.match(/\bhome\b\s*[:#-]?\s*([A-Za-z0-9\-]+)/i);
  const mAway = text.match(/\baway\b\s*[:#-]?\s*([A-Za-z0-9\-]+)/i);
  if (mHome || mAway) {
    const parts = [];
    if (mHome && mHome[1]) parts.push(`${mHome[1]} (Home)`);
    if (mAway && mAway[1]) parts.push(`${mAway[1]} (Away)`);
    if (parts.length) return parts.join(", ");
  }

  // 1) Explicit labels: "Locker Room(s): ..." | "Locker Rooms - ..." | "Lockers ..." | "Rooms ..."
  //    Also supports "AL Rooms" (Adult League shorthand)
  const reList = /\b(?:al\s*rooms?|locker\s*rooms?|lockers?|rooms?)\b\s*[:\-]?\s*([^\n\r;]+)/i;
  const listMatch = text.match(reList);
  if (listMatch) {
    let segment = (listMatch[1] || "");

    // Normalize common separators to a single pipe so we can split safely
    // (&, +, " and ", commas, slashes) - but protect && for game separation
    segment = segment
      .replace(/\s+(and)\s+/gi, "|")
      .replace(/(?<!&)&(?!&)/g, "|") // Replace single & but not &&
      .replace(/[+]/g, "|")
      .replace(/[,/]/g, "|")
      .replace(/\s*\|\s*/g, "|"); // collapse spaces around pipes

    // Extract entries like: 1, 3 (Red), A1, 4 (CT Beer)
    const entries = [];
    const reEntry = /([A-Za-z0-9\-]+(?:\s*\([^)]+\))?)/g;
    let em;
    while ((em = reEntry.exec(segment)) !== null) {
      const val = (em[1] || "").trim();
      if (val) entries.push(val);
    }
    if (entries.length) return entries.join(", ");
  }

  // 2) Simple single-room forms: "Locker 3", "Room 12", "LR 2", "LKR-A"
  const simple1 = /\b(?:locker|room)\b\s*#?\s*([A-Za-z0-9\-]+(?:\s*\([^)]+\))?)/i.exec(text);
  if (simple1) return simple1[1];

  const simple2 = /\b(?:lr|lkr)\b\s*#?\s*([A-Za-z0-9\-]+(?:\s*\([^)]+\))?)/i.exec(text);
  if (simple2) return simple2[1];

  return null;
}

function parseRink(text) {
  if (!text) return null;
  // e.g., "Rink A", "Arena B", "South Rink"
  const re = /\b(?:rink|arena)\s*([A-Za-z])/i;
  const m = text.match(re);
  return m ? (m[1].toUpperCase()) : null;
}

function cleanTeamName(title) {
  if (!title) return "";
  // Remove trailing " - Locker 3" patterns, " - Rink Program", and "(Wings Ice Rink)" to keep team name clean
  return title
    .replace(/\s*[-–—]\s*(locker(?:\s*room)?|room|rm|lr|lkr)\b.*$/i, "")
    .replace(/\s*[-–—]\s*rink\s+program\s*$/i, "")
    .replace(/\s*\(\s*wings\s+ice\s+rink\s*\)\s*/gi, "")
    .trim();
}

/************************************
 * FETCHERS — JSON (gviz) & CSV
 ************************************/
async function fetchGVizJSON(url) {
  const res = await fetch(url, { cache: "no-store" });
  const text = await res.text();
  // Strip JS wrapper: google.visualization.Query.setResponse(...)
  const json = JSON.parse(text.replace(/^[^{]+/, "").replace(/;?\s*$/, ""));
  const rows = json.table.rows || [];
  // Expect columns: 0 Start, 1 End, 2 Title, 3 Description
  const data = rows.map(r => (r.c || []).map(c => (c ? c.v : "")));
  return data;
}

async function fetchCSV(url) {
  const res = await fetch(url, { cache: "no-store" });
  const csv = await res.text();
  return parseCsv(csv);
}

function parseCsv(csv) {
  // Simple RFC4180-ish parser (handles quoted commas and newlines)
  const rows = [];
  let row = [], cur = "", inQuotes = false;
  for (let i = 0; i < csv.length; i++) {
    const ch = csv[i];
    if (ch === '"') {
      if (inQuotes && csv[i + 1] === '"') {
        cur += '"'; i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (ch === ',' && !inQuotes) {
      row.push(cur); cur = "";
    } else if ((ch === '\n' || ch === '\r') && !inQuotes) {
      if (cur !== "" || row.length) { row.push(cur); rows.push(row); row = []; cur = ""; }
    } else {
      cur += ch;
    }
  }
  if (cur !== "" || row.length) { row.push(cur); rows.push(row); }
  return rows;
}

/************************************
 * CORE: transform sheet rows → events
 ************************************/
function rowsToEvents(rows) {
  if (!rows || rows.length === 0) return [];
  // If first row looks like a header, drop it
  const headerLikely = String(rows[0][0]).toLowerCase().includes("start");
  const startIndex = headerLikely ? 1 : 0;

  const events = [];
  for (let i = startIndex; i < rows.length; i++) {
    const r = rows[i] || [];
    const startISO = r[0];           // Column A: Start Date/Time
    const endISO   = r[1];           // Column B: End Date/Time
    const eventTitle = r[2] || "";   // Column C: Event Title (from EZFacility)
    const customTitle = r[3] || "";  // Column D: Custom Event Title
    const desc     = r[4] || "";     // Column E: Description (Locker Rooms)
    // Column F: Local Start Time (not used in current logic)

    // Use custom title if available, fallback to event title
    const displayTitle = customTitle.trim() || eventTitle.trim();
    
    if (!startISO || !endISO || !displayTitle) continue;

    const start = new Date(startISO);
    const end   = new Date(endISO);
    if (isNaN(start) || isNaN(end)) continue;

    // Locker & rink extraction from description (primary) or titles (fallback)
    const locker = parseLocker(desc) || parseLocker(displayTitle) || parseLocker(eventTitle) || "—";
    const rink   = parseRink(desc) || parseRink(displayTitle) || parseRink(eventTitle) || "C";
    
    // Keep raw locker text for && parsing
    const rawLocker = desc || displayTitle || eventTitle || "—";

    events.push({
      startISO, endISO, start, end,
      titleRaw: displayTitle,
      team: cleanTeamName(displayTitle),
      description: desc,
      locker,
      rawLocker, // Preserve original text for && splitting
      rink,
      originalTitle: eventTitle, // Keep original for debugging if needed
      customTitle: customTitle
    });
  }

  // Sort by start time ascending
  events.sort((a, b) => a.start - b.start);
  return events;
}

// Helper: are two Date objects on the same calendar day in a given timezone?
function sameDayInTZ(a, b, tz = FACILITY_TIMEZONE) {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit"
  });
  const pa = fmt.formatToParts(a).reduce((o, p) => (o[p.type] = p.value, o), {});
  const pb = fmt.formatToParts(b).reduce((o, p) => (o[p.type] = p.value, o), {});
  return pa.year === pb.year && pa.month === pb.month && pa.day === pb.day;
}

/************************************
 * FILTER into On Ice / Up Next / Upcoming
 ************************************/
function splitThreeSections(events, now = new Date()) {
  const onIceList = [];
  const upNextList = [];
  const upcomingList = [];

  // Get events happening today
  const todayEvents = events.filter(ev => sameDayInTZ(ev.start, now, FACILITY_TIMEZONE));
  
  // Separate current vs future
  const currentEvents = [];
  const futureEvents = [];
  for (const ev of todayEvents) {
    if (ev.start <= now && now < ev.end) {
      currentEvents.push(ev);
    } else if (ev.start > now) {
      futureEvents.push(ev);
    }
  }

  // Sort future events by start time
  futureEvents.sort((a, b) => a.start - b.start);

  // Assign lists
  onIceList.push(...currentEvents);

  // Up Next = earliest remaining today
  // Upcoming = all other remaining today (exclude the one shown in Up Next)
  if (futureEvents.length > 0) {
    upNextList.push(futureEvents[0]);
    upcomingList.push(...futureEvents.slice(1)); // <-- exclude "Up Next" to avoid duplication
  }

  // Sort each list
  onIceList.sort((a, b) => a.end - b.end);
  upNextList.sort((a, b) => a.start - b.start);
  upcomingList.sort((a, b) => a.start - b.start);
  
  return { onIceList, upNextList, upcomingList };
}

/************************************
 * Render helper: "1 (Red) | 3 (A1) | 4"
 ************************************/
function renderLockerBadgeContent(container, lockerStr) {
  if (!lockerStr) {
    container.append("—");
    return;
  }

  // parseLocker returns a comma-separated list like "1 (Red), 3 (A1), 4"
  const parts = lockerStr.split(/\s*,\s*/).filter(Boolean);

  parts.forEach((part, idx) => {
    // Keep the text exactly as-is (numbers + optional parentheses)
    container.append(part);

    // Insert red pipe between entries (not after the last one) with spaces
    if (idx < parts.length - 1) {
      const sep = document.createElement("span");
      sep.className = "room-sep";
      sep.textContent = " | ";
      container.appendChild(sep);
    }
  });
}

/************************************
 * RENDER
 ************************************/
function createRow(ev, context /* "on-ice" | "up-next" | "upcoming" */, isInTwoSectionMode = false) {
  const li = document.createElement("li");

  // Content row with time, team, and room aligned horizontally
  const contentRow = document.createElement("div");
  contentRow.className = "content-row";

  // Time badge
  const time = document.createElement("div");
  time.className = "badge time";
  const range = fmtTimeRange(ev.startISO, ev.endISO, FACILITY_TIMEZONE);
  time.textContent = range || "";

  // Warning if about to start (for "up-next" column)
  if (context === "up-next") {
    const minutesTo = Math.round((ev.start - new Date()) / 60000);
    if (minutesTo <= 10) {
      time.classList.add("warn");
    }
  }

  // Handle multi-game events with && separator
  const teamTitle = ev.team || ev.titleRaw;
  const teamContainer = document.createElement("div");
  teamContainer.className = "team-container";
  
  // Check for multi-game separator
  const games = teamTitle.split('&&').map(game => game.trim());
  const lockerParts = (ev.rawLocker || ev.locker || "").split('&&').map(locker => locker.trim());
  
  if (games.length > 1) {
    // Multi-game display
    contentRow.classList.add("multi-game");
    games.forEach((game, index) => {
      const gameRow = document.createElement("div");
      gameRow.className = "game-row";
      
      const teamDiv = document.createElement("div");
      teamDiv.className = "team";
      // Apply appropriate scrolling based on context
      setupScrollingTitle(teamDiv, game, context === "upcoming");
      gameRow.appendChild(teamDiv);
      
      // Use corresponding locker or fallback to combined
      const rawGameLocker = lockerParts[index] || ev.rawLocker || ev.locker || "—";
      const gameLocker = parseLocker(rawGameLocker) || rawGameLocker || "—";
      const roomDiv = document.createElement("div");
      roomDiv.className = "room-numbers";
      
      // Just render the numbers/letters without "Room" prefix
      renderLockerBadgeContent(roomDiv, gameLocker);
      gameRow.appendChild(roomDiv);
      
      teamContainer.appendChild(gameRow);
    });
    
    // For multi-games, we structure differently
    contentRow.appendChild(time);
    contentRow.appendChild(teamContainer);
  } else {
    // Single game display (existing logic)
    const team = document.createElement("div");
    team.className = "team";
    // Apply appropriate scrolling based on context
    setupScrollingTitle(team, teamTitle, context === "upcoming");

    const room = document.createElement("div");
    room.className = "room-numbers";

    // Just render the numbers/letters without "Room" prefix
    renderLockerBadgeContent(room, ev.locker);

    contentRow.appendChild(time);
    contentRow.appendChild(team);
    contentRow.appendChild(room);
  }

  // Assemble the row
  li.appendChild(contentRow);
  return li;
}

function renderLists(onIceList, upNextList, upcomingList) {
  const onIceUL = $("#onIceList");
  const upNextUL = $("#upNextList");
  const upcomingUL = $("#upcomingList");
  const mainContainer = $(".triple-split");
  
  onIceUL.innerHTML = "";
  upNextUL.innerHTML = "";
  upcomingUL.innerHTML = "";

  // Determine if we should use two-section mode
  const isInTwoSectionMode = onIceList.length === 0;
  
  // Update layout class
  if (isInTwoSectionMode) {
    mainContainer.classList.add("two-section");
    // Update chip text for two-section mode
    const upNextChip = $(".panel-up-next .chip-up-next");
    if (upNextChip) upNextChip.textContent = "Up Next";
  } else {
    mainContainer.classList.remove("two-section");
    // Update chip text for three-section mode
    const upNextChip = $(".panel-up-next .chip-up-next");
    if (upNextChip) upNextChip.textContent = "Next";
  }

  // On Ice section
  if (onIceList.length === 0) {
    $("#onIceEmpty").hidden = false;
  } else {
    $("#onIceEmpty").hidden = true;
    onIceList.forEach(ev => onIceUL.appendChild(createRow(ev, "on-ice", isInTwoSectionMode)));
  }

  // Up Next section
  if (upNextList.length === 0) {
    $("#upNextEmpty").hidden = false;
  } else {
    $("#upNextEmpty").hidden = true;
    upNextList.forEach(ev => upNextUL.appendChild(createRow(ev, "up-next", isInTwoSectionMode)));
  }
  
  // Upcoming section
  if (upcomingList.length === 0) {
    $("#upcomingEmpty").hidden = false;
    stopTicker(); // Stop ticker if no items
  } else {
    $("#upcomingEmpty").hidden = true;
    upcomingList.forEach(ev => upcomingUL.appendChild(createRow(ev, "upcoming", isInTwoSectionMode)));
    
    // Start ticker after a brief delay to ensure DOM is ready
    setTimeout(() => {
      startTicker();
      // After ticker is initialized, setup scrolling for upcoming titles
      setTimeout(() => {
        setupScrollingForUpcomingTitles();
      }, 50);
    }, 100);
  }
}

/************************************
 * TICKER FUNCTIONALITY FOR UPCOMING
 ************************************/
let tickerInterval = null;
let currentTickerIndex = 0;
let tickerItems = [];

function startTicker() {
  const ul = document.querySelector("#upcomingList");
  tickerItems = Array.from(ul.children);

  // Reset any previous ticker state
  ul.classList.remove("ticker");
  tickerItems.forEach(li => li.classList.remove("active", "exit"));

  // If 0 or 1 items: no ticker — show the single item normally
  if (tickerItems.length <= 1) {
    if (tickerInterval) {
      clearInterval(tickerInterval);
      tickerInterval = null;
    }
    return; // with no .ticker class, CSS will render items normally
  }

  // Ticker mode ONLY when 2+ items
  ul.classList.add("ticker");

  // Clear any existing interval
  if (tickerInterval) clearInterval(tickerInterval);

  // Initially show first
  tickerItems.forEach(item => item.classList.remove("active", "exit"));
  tickerItems[0].classList.add("active");
  currentTickerIndex = 0;

  // Rotate
  tickerInterval = setInterval(() => {
    if (tickerItems.length <= 1) return;

    const current = tickerItems[currentTickerIndex];
    const nextIndex = (currentTickerIndex + 1) % tickerItems.length;
    const next = tickerItems[nextIndex];

    current.classList.remove("active");
    current.classList.add("exit");

    setTimeout(() => {
      current.classList.remove("exit");
      next.classList.add("active");
      currentTickerIndex = nextIndex;
    }, 400);
  }, 8000);
}

function stopTicker() {
  if (tickerInterval) {
    clearInterval(tickerInterval);
    tickerInterval = null;
  }

  const upcomingList = $("#upcomingList");
  upcomingList.classList.remove('ticker');

  // Reset all items to normal state
  tickerItems.forEach(item => {
    item.classList.remove('active', 'exit');
  });
}

/************************************
 * REFRESH LOOP
 ************************************/
async function loadAndRender() {
  try {
    const rows = USE_CSV
      ? await fetchCSV(SHEET_CSV_URL)
      : await fetchGVizJSON(SHEET_JSON_URL);

    const events = rowsToEvents(rows);
    const { onIceList, upNextList, upcomingList } = splitThreeSections(events, new Date());

    renderLists(onIceList, upNextList, upcomingList);
    
    // Update print view with all remaining events
    updatePrintView(onIceList, upNextList, upcomingList);

    // Update timestamp
    $("#updated").textContent = `Updated: ${fmtUpdated(new Date(), FACILITY_TIMEZONE)}`;
  } catch (err) {
    console.error("Failed to load sheet:", err);
    $("#updated").textContent = "Update failed—check network/sheet permissions.";
  }
}

/************************************
| * SCROLLING TITLE HELPER
| ************************************/
function setupScrollingTitle(teamElement, titleText, isUpcoming = false) {
  // Skip upcoming titles initially - they'll be handled after ticker setup
  if (isUpcoming) {
    // Just set the text content for now
    teamElement.innerHTML = '';
    const textSpan = document.createElement('span');
    textSpan.className = 'team-text';
    textSpan.textContent = titleText;
    teamElement.appendChild(textSpan);
    return;
  }
  
  // Reset any previous scrolling setup and temporarily hide ellipsis
  teamElement.classList.remove('scrolling', 'scrolling-upcoming');
  teamElement.classList.add('checking-overflow');
  teamElement.innerHTML = '';
  
  // Create a wrapper span for the text
  const textSpan = document.createElement('span');
  textSpan.className = 'team-text';
  textSpan.textContent = titleText;
  teamElement.appendChild(textSpan);
  
  // Force a reflow to ensure the element is rendered, then measure
  setTimeout(() => {
    // Force browser to calculate layout
    teamElement.offsetHeight; // This forces a reflow
    
    const containerWidth = teamElement.offsetWidth;
    const textWidth = textSpan.scrollWidth;
    
    // If textWidth is still 0, try alternative measurement
    let actualTextWidth = textWidth;
    if (textWidth === 0) {
      // Create a temporary element to measure text width
      const tempSpan = document.createElement('span');
      tempSpan.style.visibility = 'hidden';
      tempSpan.style.position = 'absolute';
      tempSpan.style.whiteSpace = 'nowrap';
      tempSpan.style.fontSize = window.getComputedStyle(teamElement).fontSize;
      tempSpan.style.fontFamily = window.getComputedStyle(teamElement).fontFamily;
      tempSpan.style.fontWeight = window.getComputedStyle(teamElement).fontWeight;
      tempSpan.textContent = titleText;
      document.body.appendChild(tempSpan);
      actualTextWidth = tempSpan.offsetWidth;
      document.body.removeChild(tempSpan);
    }
    
    // Debug logging for all sections
    console.log('Title check:', {
      title: titleText,
      containerWidth,
      textWidth,
      actualTextWidth,
      overflow: actualTextWidth > containerWidth,
      section: isUpcoming ? 'upcoming' : 'in-progress/next'
    });
    
    // Remove the checking class
    teamElement.classList.remove('checking-overflow');
    
    if (actualTextWidth > containerWidth) {
      // Calculate how far we need to scroll to show the end
      const scrollDistance = actualTextWidth - containerWidth + 20; // Add 20px padding
      teamElement.style.setProperty('--scroll-distance', `-${scrollDistance}px`);
      teamElement.classList.add('scrolling');
      console.log('Applied scrolling class to:', titleText);
    } else {
      console.log('Text fits, no scrolling needed for:', titleText);
    }
  }, 250); // Increased delay to ensure proper DOM rendering
}

function setupScrollingForUpcomingTitles() {
  const upcomingList = document.querySelector("#upcomingList");
  const teamElements = upcomingList.querySelectorAll('.team');
  
  teamElements.forEach(teamElement => {
    const textSpan = teamElement.querySelector('.team-text');
    if (!textSpan) return;
    
    const titleText = textSpan.textContent;
    
    // Reset and check for overflow
    teamElement.classList.remove('scrolling', 'scrolling-upcoming');
    teamElement.classList.add('checking-overflow');
    
    // Measure after a brief delay to ensure ticker positioning is stable
    setTimeout(() => {
      // Force browser to calculate layout
      teamElement.offsetHeight; // This forces a reflow
      
      const containerWidth = teamElement.offsetWidth;
      const textWidth = textSpan.scrollWidth;
      
      // If textWidth is still 0, try alternative measurement
      let actualTextWidth = textWidth;
      if (textWidth === 0) {
        // Create a temporary element to measure text width
        const tempSpan = document.createElement('span');
        tempSpan.style.visibility = 'hidden';
        tempSpan.style.position = 'absolute';
        tempSpan.style.whiteSpace = 'nowrap';
        tempSpan.style.fontSize = window.getComputedStyle(teamElement).fontSize;
        tempSpan.style.fontFamily = window.getComputedStyle(teamElement).fontFamily;
        tempSpan.style.fontWeight = window.getComputedStyle(teamElement).fontWeight;
        tempSpan.textContent = titleText;
        document.body.appendChild(tempSpan);
        actualTextWidth = tempSpan.offsetWidth;
        document.body.removeChild(tempSpan);
      }
      
      console.log('Upcoming title check (post-ticker):', {
        title: titleText,
        containerWidth,
        textWidth,
        actualTextWidth,
        overflow: actualTextWidth > containerWidth,
        tickerActive: teamElement.closest('.ticker') !== null
      });
      
      // Remove the checking class
      teamElement.classList.remove('checking-overflow');
      
      if (actualTextWidth > containerWidth) {
        // Calculate how far we need to scroll to show the end
        const scrollDistance = actualTextWidth - containerWidth + 20; // Add 20px padding
        teamElement.style.setProperty('--scroll-distance', `-${scrollDistance}px`);
        teamElement.classList.add('scrolling-upcoming');
        console.log('Applied scrolling-upcoming class to:', titleText);
      } else {
        console.log('Text fits, no scrolling needed for:', titleText);
      }
    }, 150); // Slightly longer delay for upcoming section
  });
}

/************************************
| * PRINT VIEW FUNCTIONALITY
| ************************************/
function updatePrintView(onIceList, upNextList, upcomingList) {
  // Combine all events and sort chronologically
  const allEvents = [];
  
  // Add current events with status
  onIceList.forEach(ev => {
    allEvents.push({
      ...ev,
      status: 'in-progress',
      statusLabel: 'In Progress'
    });
  });
  
  // Add up next events
  upNextList.forEach(ev => {
    allEvents.push({
      ...ev,
      status: 'up-next',
      statusLabel: 'Up Next'
    });
  });
  
  // Add upcoming events
  upcomingList.forEach(ev => {
    allEvents.push({
      ...ev,
      status: 'upcoming',
      statusLabel: 'Upcoming'
    });
  });
  
  // Sort by start time
  allEvents.sort((a, b) => a.start - b.start);
  
  // Update print date
  const printDate = document.getElementById('printDate');
  const now = new Date();
  const dateStr = new Intl.DateTimeFormat('en-US', {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    timeZone: FACILITY_TIMEZONE
  }).format(now);
  printDate.textContent = `${dateStr} - Remaining Events`;
  
  // Populate print table
  const tbody = document.getElementById('printTableBody');
  tbody.innerHTML = '';
  
  allEvents.forEach(ev => {
    const row = document.createElement('tr');
    
    // Time column
    const timeCell = document.createElement('td');
    timeCell.className = 'print-time';
    const timeRange = fmtTimeRange(ev.startISO, ev.endISO, FACILITY_TIMEZONE);
    timeCell.innerHTML = `
      ${timeRange}<br>
      <span class="print-status ${ev.status}">${ev.statusLabel}</span>
    `;
    
    // Event name column
    const eventCell = document.createElement('td');
    eventCell.className = 'print-event';
    
    // Handle multi-game events
    const teamTitle = ev.team || ev.titleRaw;
    const games = teamTitle.split('&&').map(game => game.trim());
    
    if (games.length > 1) {
      // Multi-game display
      const gamesList = games.map(game => `• ${game}`).join('<br>');
      eventCell.innerHTML = gamesList;
    } else {
      // Single game
      eventCell.textContent = teamTitle;
    }
    
    // Locker rooms column
    const roomsCell = document.createElement('td');
    roomsCell.className = 'print-rooms';
    
    if (games.length > 1) {
      // Multi-game locker rooms
      const lockerParts = (ev.rawLocker || ev.locker || "").split('&&').map(locker => locker.trim());
      const roomsList = games.map((game, index) => {
        const rawGameLocker = lockerParts[index] || ev.rawLocker || ev.locker || "—";
        const gameLocker = parseLocker(rawGameLocker) || rawGameLocker || "—";
        return gameLocker;
      }).join('<br>');
      roomsCell.innerHTML = roomsList;
    } else {
      // Single game locker room
      roomsCell.textContent = ev.locker || "—";
    }
    
    row.appendChild(timeCell);
    row.appendChild(eventCell);
    row.appendChild(roomsCell);
    tbody.appendChild(row);
  });
}

function startClock() {
  const tick = () => { $("#clock").textContent = fmtClock(new Date(), FACILITY_TIMEZONE); };
  tick();
  setInterval(tick, 30_000); // every 30s is fine for a lobby
}

window.addEventListener("DOMContentLoaded", () => {
  startClock();
  loadAndRender();
  setInterval(loadAndRender, REFRESH_EVERY_MS);
});
