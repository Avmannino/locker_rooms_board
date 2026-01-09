// Optional: If you prefer CSV instead, set this and flip USE_CSV = true.
//   https://docs.google.com/spreadsheets/d/SPREADSHEET_ID/export?format=csv
const SHEET_CSV_URL = "https://docs.google.com/spreadsheets/d/e/2PACX-1vSBHs9gkUWmf9ANIWJn6B9JBIRlMbe-IJ0hH_gOIUZxzprhYRk0swY8zd_r83BebKl9Q6Qj7I4m1z5-/pub?output=csv";

// Toggle if you want to fetch CSV instead of JSON.
const USE_CSV = true;

// Toggle for "Presented By" sponsor section
const SHOW_PRESENTED_BY = true;

// Locker branding configuration
const LOCKER_BRANDING = {
  '1': { name: 'Away LR', logo: './assets/locker_generic.png' },
  '2': { name: 'Away LR', logo: './assets/locker_generic.png' },
  '3': { name: 'Stateline LR', logo: './assets/stateline_logo.png' },
  '4': { name: 'GSC LR', logo: './assets/gsc_logo.png' },
  '5': { name: 'GCDS Boys LR', logo: './assets/gcds_logo.png' },
  '6': { name: 'GCDS Girls LR', logo: './assets/gcds_logo.png' },
  'FLEX': { name: 'FLEX LR', logo: './assets/locker_generic.png' }
};

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

    // Handle the specific formats:
    // Simple: "2 | 4" or "2, 4"
    // Detailed: "2 (Team 1) | 4 (Team 2)" or "2 (Red, White), 4 (Bantam A)"

    // First, normalize pipe separators to a unique marker (outside parens only)
    let normalized = "";
    let parenDepth = 0;
    for (const char of segment) {
      if (char === '(') {
        parenDepth++;
        normalized += char;
      } else if (char === ')') {
        parenDepth--;
        normalized += char;
      } else if (char === '|' && parenDepth === 0) {
        normalized += '<<<SEP>>>';
      } else if (char === '&' && parenDepth === 0 && !segment.includes('&&')) {
        normalized += '<<<SEP>>>';
      } else if (char === '+' && parenDepth === 0) {
        normalized += '<<<SEP>>>';
      } else if (char === '/' && parenDepth === 0) {
        normalized += '<<<SEP>>>';
      } else {
        normalized += char;
      }
    }

    // Also handle "and" outside parentheses
    normalized = normalized.replace(/\s+and\s+/gi, '<<<SEP>>>');

    // Now split by our marker OR by commas outside parentheses
    const entries = [];
    let current = "";
    parenDepth = 0;

    for (let i = 0; i < normalized.length; i++) {
      const char = normalized[i];
      // Check for our separator marker
      if (normalized.substring(i, i + 9) === '<<<SEP>>>') {
        if (current.trim()) entries.push(current.trim());
        current = "";
        i += 8; // Skip the marker (loop will add 1 more)
        continue;
      }
      if (char === '(') {
        parenDepth++;
        current += char;
      } else if (char === ')') {
        parenDepth--;
        current += char;
      } else if (char === ',' && parenDepth === 0) {
        if (current.trim()) entries.push(current.trim());
        current = "";
      } else {
        current += char;
      }
    }
    if (current.trim()) entries.push(current.trim());

    // Now extract just the locker entries (number/name + optional parenthesized team name)
    const lockerEntries = [];
    for (const entry of entries) {
      // Match: alphanumeric identifier (number or text like FLEX) followed by optional space and parenthesized content
      const match = entry.match(/([A-Za-z0-9\-]+(?:\s*\([^)]*(?:\([^)]*\)[^)]*)*\))?)/);
      if (match && match[1]) {
        lockerEntries.push(match[1].trim());
      }
    }
    if (lockerEntries.length) return lockerEntries.join(", ");
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
  
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}: ${res.statusText} for URL: ${url}`);
  }
  
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
  
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}: ${res.statusText} for URL: ${url}`);
  }
  
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
function createLockerRows(ev, context) {
  const lockerRows = [];

  // Parse the locker assignments from the description
  const lockerStr = ev.locker || "—";

  if (lockerStr === "—") {
    return lockerRows;
  }

  // Smart split: don't split on commas inside parentheses
  // e.g., "2 (Red, White), 4 (Bantam A)" should become ["2 (Red, White)", "4 (Bantam A)"]
  const lockerAssignments = [];
  let current = "";
  let parenDepth = 0;

  for (const char of lockerStr) {
    if (char === '(') {
      parenDepth++;
      current += char;
    } else if (char === ')') {
      parenDepth--;
      current += char;
    } else if (char === ',' && parenDepth === 0) {
      // Only split on comma when not inside parentheses
      if (current.trim()) {
        lockerAssignments.push(current.trim());
      }
      current = "";
    } else {
      current += char;
    }
  }
  // Don't forget the last segment
  if (current.trim()) {
    lockerAssignments.push(current.trim());
  }

  lockerAssignments.forEach(assignment => {
    // Extract locker number/name and optional team name - support FLEX and numeric lockers
    const match = assignment.match(/^(FLEX|\d+)(?:\s*\((.+)\))?$/i);
    if (match) {
      const lockerNum = match[1].toUpperCase(); // Handle FLEX case-insensitively
      const teamName = match[2] || null; // Only use explicit team names, not event titles

      // Handle FLEX lockers or check if numeric locker exists in branding
      if (lockerNum === 'FLEX' || LOCKER_BRANDING[lockerNum]) {
        lockerRows.push(renderBrandedLockerRoom(lockerNum, teamName ? teamName.trim() : null));
      }
    }
  });
  
  // Fallback: if no matches found, try the old method for backward compatibility
  if (lockerRows.length === 0) {
    // Handle multi-game events with && separator (legacy support)
    const teamTitle = ev.team || ev.titleRaw;
    const games = teamTitle.split('&&').map(game => game.trim());
    const lockerParts = (ev.rawLocker || ev.locker || "").split('&&').map(locker => locker.trim());
    
    if (games.length > 1) {
      // Multi-game: create a row for each game/locker combination
      games.forEach((game, index) => {
        const rawGameLocker = lockerParts[index] || ev.rawLocker || ev.locker || "—";
        const gameLocker = parseLocker(rawGameLocker) || rawGameLocker || "—";
        
        // Parse individual locker numbers from the gameLocker string
        const lockerNumbers = gameLocker.split(/[,|]/).map(l => l.trim().replace(/[^\d]/g, '')).filter(Boolean);
        
        lockerNumbers.forEach(lockerNum => {
          if (LOCKER_BRANDING[lockerNum]) {
            // Only use game name if it looks like a team name (not an event title)
            const teamName = game.toLowerCase().includes('skate') || 
                           game.toLowerCase().includes('lesson') || 
                           game.toLowerCase().includes('practice') ? null : game;
            lockerRows.push(renderBrandedLockerRoom(lockerNum, teamName));
          }
        });
      });
    } else {
      // Single game: create rows for each locker
      const lockerNumbers = lockerStr.split(/[,|]/).map(l => l.trim().replace(/[^\d]/g, '')).filter(Boolean);
      
      // Only use team name if it's actually a team (not an event like "Public Skate")
      const actualTeamName = ev.team || ev.titleRaw || teamTitle;
      const isEventTitle = actualTeamName.toLowerCase().includes('skate') || 
                          actualTeamName.toLowerCase().includes('lesson') || 
                          actualTeamName.toLowerCase().includes('practice') ||
                          actualTeamName.toLowerCase().includes('public');
      
      lockerNumbers.forEach(lockerNum => {
        if (LOCKER_BRANDING[lockerNum]) {
          lockerRows.push(renderBrandedLockerRoom(lockerNum, isEventTitle ? null : actualTeamName));
        }
      });
    }
  }
  
  return lockerRows;
}

function createEventPane(ev, context, chipClass, chipText) {
  const eventPane = document.createElement("div");
  eventPane.className = "event-pane";
  
  // Get event title and match description
  const matchDescription = parseEventDescription(ev.description);
  // Always use team name as title (quoted descriptions go in the description area)
  const displayTitle = ev.team || ev.titleRaw;
  
  // Time display
  const timeRange = fmtTimeRange(ev.startISO, ev.endISO, FACILITY_TIMEZONE);
  
  eventPane.innerHTML = `
    <div class="status-row">
      <span class="chip ${chipClass}">${chipText}</span>
      <div class="time-badge">${timeRange}</div>
      <span class="locker-rooms-chip">Locker Rooms</span>
    </div>
    <div class="info-split">
      <div class="title-description-area">
        <div class="large-title"></div>
        <div class="description">${matchDescription || ''}</div>
      </div>
      <div class="locker-area">
        <ul class="locker-list"></ul>
      </div>
    </div>
  `;
  
  // Add locker rows
  const lockerList = eventPane.querySelector('.locker-list');
  const lockerRows = createLockerRows(ev, context);
  lockerRows.forEach(row => lockerList.appendChild(row));

  // Apply adaptive sizing based on number of lockers (0-6 teams)
  const numLockers = lockerRows.length;
  if (numLockers <= 2) {
    lockerList.classList.add('locker-list-xl');
  } else if (numLockers <= 4) {
    lockerList.classList.add('locker-list-large');
  } else if (numLockers === 5) {
    lockerList.classList.add('locker-list-medium');
  } else if (numLockers >= 6) {
    lockerList.classList.add('locker-list-compact');
  }
  
  // Setup scrolling for long titles in the left half
  const largeTitleElement = eventPane.querySelector('.large-title');
  if (largeTitleElement) {
    setTimeout(() => {
      setupScrollingTitle(largeTitleElement, displayTitle, context === 'upcoming');
    }, 250);
  }
  
  return eventPane;
}

function renderLists(onIceList, upNextList, upcomingList) {
  // Stop any existing ticker before clearing content
  stopTicker();
  
  const onIceContainer = $("#onIceContainer");
  const upNextContainer = $("#upNextContainer");
  const upcomingContainer = $("#upcomingContainer");
  const mainContainer = $(".triple-split");
  
  // Clear previous content
  onIceContainer.innerHTML = "";
  upNextContainer.innerHTML = "";
  upcomingContainer.innerHTML = "";

  // Determine if we should use two-section mode
  const isInTwoSectionMode = onIceList.length === 0;
  
  // Update layout class
  if (isInTwoSectionMode) {
    mainContainer.classList.add("two-section");
  } else {
    mainContainer.classList.remove("two-section");
  }

  // On Ice section
  if (onIceList.length === 0) {
    $("#onIceEmpty").hidden = false;
  } else {
    $("#onIceEmpty").hidden = true;
    onIceList.forEach(ev => {
      const eventPane = createEventPane(ev, "on-ice", "chip-on-ice", "In Progress");
      onIceContainer.appendChild(eventPane);
    });
  }

  // Up Next section
  if (upNextList.length === 0) {
    $("#upNextEmpty").hidden = false;
  } else {
    $("#upNextEmpty").hidden = true;
    const chipText = isInTwoSectionMode ? "Up Next" : "Next";
    upNextList.forEach(ev => {
      const eventPane = createEventPane(ev, "up-next", "chip-up-next", chipText);
      upNextContainer.appendChild(eventPane);
    });
  }
  
  // Upcoming section
  if (upcomingList.length === 0) {
    $("#upcomingEmpty").hidden = false;
    stopTicker();
  } else {
    $("#upcomingEmpty").hidden = true;
    
    // Create all event panes but only show one at a time
    upcomingList.forEach((ev, index) => {
      const eventPane = createEventPane(ev, "upcoming", "chip-upcoming", "Upcoming");
      if (index === 0) {
        eventPane.classList.add("active");
      }
      upcomingContainer.appendChild(eventPane);
    });
    
    // Start ticker for upcoming events if there are multiple
    if (upcomingList.length > 1) {
      setTimeout(() => {
        startTickerForEventPanes();
      }, 100);
    } else {
      stopTicker();
    }
  }
}

/************************************
 * TICKER FUNCTIONALITY FOR UPCOMING
 ************************************/
let tickerInterval = null;
let currentTickerIndex = 0;
let tickerItems = [];

function startTickerForEventPanes() {
  const container = document.querySelector("#upcomingContainer");
  tickerItems = Array.from(container.children);

  // Reset any previous ticker state
  container.classList.remove("ticker");
  tickerItems.forEach(pane => pane.classList.remove("active", "exit"));

  // If 0 or 1 items: no ticker — show the single item normally
  if (tickerItems.length <= 1) {
    if (tickerInterval) {
      clearInterval(tickerInterval);
      tickerInterval = null;
    }
    return;
  }

  // Ticker mode ONLY when 2+ items
  container.classList.add("ticker");

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
  }, 7000); // Changed to 7000 (7 seconds)
}

// Keep the old function for backward compatibility but redirect to new one
function startTicker() {
  startTickerForEventPanes();
}

function stopTicker() {
  if (tickerInterval) {
    clearInterval(tickerInterval);
    tickerInterval = null;
  }

  // Reset ticker state
  currentTickerIndex = 0;
  
  // Remove ticker class from container
  const upcomingContainer = $("#upcomingContainer");
  if (upcomingContainer) {
    upcomingContainer.classList.remove('ticker');
  }

  // Reset all items to normal state
  tickerItems.forEach(item => {
    item.classList.remove('active', 'exit');
  });
  
  tickerItems = [];
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
    console.error("Error details:", {
      message: err.message,
      stack: err.stack,
      url: USE_CSV ? SHEET_CSV_URL : SHEET_JSON_URL,
      timestamp: new Date().toISOString()
    });
    $("#updated").textContent = "Update failed—check network/sheet permissions.";
  }
}

/************************************
| * SCROLLING TITLE HELPER
| ************************************/
function setupScrollingTitle(teamElement, titleText, isUpcoming = false) {
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
  // Use longer delay for upcoming titles to ensure ticker is stable
  const delay = isUpcoming ? 500 : 250;
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
      // Use scrolling-upcoming class for upcoming titles, scrolling for others
      teamElement.classList.add(isUpcoming ? 'scrolling-upcoming' : 'scrolling');
      console.log('Applied scrolling class to:', titleText, isUpcoming ? '(upcoming)' : '');
    } else {
      console.log('Text fits, no scrolling needed for:', titleText);
    }
  }, delay);
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
async function updatePrintView(onIceList, upNextList, upcomingList) {
  try {
    // Fetch fresh data to get all events (not just today's)
    const rows = USE_CSV
      ? await fetchCSV(SHEET_CSV_URL)
      : await fetchGVizJSON(SHEET_JSON_URL);

    const allEvents = rowsToEvents(rows);
    
    // Get events for the next 5 days
    const now = new Date();
    const fiveDaysFromNow = new Date(now.getTime() + (5 * 24 * 60 * 60 * 1000));
    
    // Filter events for the next 5 days
    const next5DaysEvents = allEvents.filter(ev => {
      return ev.start >= now && ev.start <= fiveDaysFromNow;
    });
    
    // Sort by start time
    next5DaysEvents.sort((a, b) => a.start - b.start);
    
    // Update print date header
    const printDate = document.getElementById('printDate');
    const startDateStr = new Intl.DateTimeFormat('en-US', {
      month: 'short',
      day: 'numeric',
      timeZone: FACILITY_TIMEZONE
    }).format(now);
    const endDateStr = new Intl.DateTimeFormat('en-US', {
      month: 'short', 
      day: 'numeric',
      year: 'numeric',
      timeZone: FACILITY_TIMEZONE
    }).format(fiveDaysFromNow);
    printDate.textContent = `${startDateStr} - ${endDateStr} (Next 5 Days)`;
    
    // Populate print table with date grouping
    const tbody = document.getElementById('printTableBody');
    tbody.innerHTML = '';
    
    let currentDate = null;
    
    next5DaysEvents.forEach(ev => {
      // Check if we need a new date header
      const eventDate = new Date(ev.start);
      const eventDateStr = new Intl.DateTimeFormat('en-US', {
        weekday: 'long',
        month: 'long',
        day: 'numeric',
        timeZone: FACILITY_TIMEZONE
      }).format(eventDate);
      
      if (eventDateStr !== currentDate) {
        currentDate = eventDateStr;
        
        // Add date header row
        const dateRow = document.createElement('tr');
        dateRow.className = 'print-date-header';
        const dateCell = document.createElement('td');
        dateCell.colSpan = 3;
        dateCell.innerHTML = `<strong>${eventDateStr}</strong>`;
        dateRow.appendChild(dateCell);
        tbody.appendChild(dateRow);
      }
      
      // Add event row
      const row = document.createElement('tr');
      
      // Time column
      const timeCell = document.createElement('td');
      timeCell.className = 'print-time';
      const timeRange = fmtTimeRange(ev.startISO, ev.endISO, FACILITY_TIMEZONE);
      timeCell.textContent = timeRange;
      
      // Event name column
      const eventCell = document.createElement('td');
      eventCell.className = 'print-event';
      
      // Handle multi-game events
      const teamTitle = ev.team || ev.titleRaw;
      const games = teamTitle.split('&&').map(game => game.trim());
      
      // Get description
      const matchDescription = parseEventDescription(ev.description);
      
      if (games.length > 1) {
        // Multi-game display
        const gamesList = games.map(game => `• ${game}`).join('<br>');
        eventCell.innerHTML = gamesList + (matchDescription ? `<br><span class="print-description">${matchDescription}</span>` : '');
      } else {
        // Single game
        eventCell.innerHTML = teamTitle + (matchDescription ? `<br><span class="print-description">${matchDescription}</span>` : '');
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
    
  } catch (err) {
    console.error("Failed to load events for print view:", err);
    // Fallback to current day events if fetch fails
    updatePrintViewFallback(onIceList, upNextList, upcomingList);
  }
}

// Fallback function for current day events if 5-day fetch fails
function updatePrintViewFallback(onIceList, upNextList, upcomingList) {
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
  printDate.textContent = `${dateStr} - Remaining Events (Fallback)`;
  
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
    
    // Get description
    const matchDescription = parseEventDescription(ev.description);
    
    if (games.length > 1) {
      // Multi-game display
      const gamesList = games.map(game => `• ${game}`).join('<br>');
      eventCell.innerHTML = gamesList + (matchDescription ? `<br><span class="print-description">${matchDescription}</span>` : '');
    } else {
      // Single game
      eventCell.innerHTML = teamTitle + (matchDescription ? `<br><span class="print-description">${matchDescription}</span>` : '');
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

function updatePresentedByVisibility() {
  const presentedByElement = $("#presentedBy");
  if (presentedByElement) {
    presentedByElement.style.display = SHOW_PRESENTED_BY ? 'flex' : 'none';
  }
}

function renderBrandedLockerRoom(lockerNumber, teamName) {
  const branding = LOCKER_BRANDING[lockerNumber];
  
  if (!branding) {
    // Fallback for unmapped lockers
    const lockerRow = document.createElement('li');
    lockerRow.className = 'locker-row';
    lockerRow.innerHTML = `
      <div class="locker-logo-placeholder"></div>
      <span class="locker-brand locker-${lockerNumber}">
        <span class="locker-name-part">Locker ${lockerNumber}</span>${teamName ? ': ' + teamName : ''}
      </span>
      <span></span>
    `;
    return lockerRow;
  }
  
  const lockerRow = document.createElement('li');
  lockerRow.className = 'locker-row';
  
  lockerRow.innerHTML = `
    <img src="${branding.logo}" alt="${branding.name}" class="locker-logo" onerror="this.style.display='none'; this.nextElementSibling.style.display='block';" />
    <div class="locker-logo-placeholder" style="display: none;"></div>
    <span class="locker-brand locker-${lockerNumber}">
      <span class="locker-name-part">${branding.name} (${lockerNumber})</span>${teamName ? ': ' + teamName : ''}
    </span>
    <span></span>
  `;
  
  return lockerRow;
}

function parseEventDescription(description) {
  if (!description) return null;
  
  // Look for "Description: " prefix with quoted text
  const descMatch = description.match(/^Description:\s*"([^"]+)"/i);
  if (descMatch) {
    return descMatch[1].trim();
  }
  
  return null;
}

function startClock() {
  const tick = () => { $("#clock").textContent = fmtClock(new Date(), FACILITY_TIMEZONE); };
  tick();
  setInterval(tick, 30_000); // every 30s is fine for a lobby
}

window.addEventListener("DOMContentLoaded", () => {
  updatePresentedByVisibility();
  startClock();
  loadAndRender();
  setInterval(loadAndRender, REFRESH_EVERY_MS);
});
