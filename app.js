// Optional: If you prefer CSV instead, set this and flip USE_CSV = true.
//   https://docs.google.com/spreadsheets/d/SPREADSHEET_ID/export?format=csv
const SHEET_CSV_URL =
  "https://docs.google.com/spreadsheets/d/e/2PACX-1vSBHs9gkUWmf9ANIWJn6B9JBIRlMbe-IJ0hH_gOIUZxzprhYRk0swY8zd_r83BebKl9Q6Qj7I4m1z5-/pub?output=csv";

// If you ever flip USE_CSV = false, set your GViz JSON endpoint here.
// (Leaving this defined prevents ReferenceErrors in logging.)
const SHEET_JSON_URL = "";

// Toggle if you want to fetch CSV instead of JSON.
const USE_CSV = true;

// Toggle for "Presented By" sponsor section
const SHOW_PRESENTED_BY = true;

// Locker branding configuration
const LOCKER_BRANDING = {
  "1": { name: "Away LR", logo: "./assets/locker_generic.png" },
  "2": { name: "Away LR", logo: "./assets/locker_generic.png" },
  "3": { name: "Stateline LR", logo: "./assets/stateline_logo.png" },
  "4": { name: "GSC LR", logo: "./assets/gsc_logo.png" },
  "5": { name: "GCDS Boys LR", logo: "./assets/gcds_logo.png" },
  "6": { name: "GCDS Girls LR", logo: "./assets/gcds_logo.png" },
  FLEX: { name: "FLEX LR", logo: "./assets/locker_generic.png" },
};

/************************************
 * GENERAL SETTINGS (tweak as needed)
 ************************************/
const NEXT_WINDOW_MINUTES = 90; // kept for reference (not used in "today" mode)
const REFRESH_EVERY_MS = 60_000; // pull new data every 60s
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
  const opts = {
    hour: "numeric",
    minute: "2-digit",
    second: undefined,
    weekday: "short",
    month: "short",
    day: "numeric",
    timeZone: tz,
  };
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
    let segment = listMatch[1] || "";

    // Normalize separators outside parentheses
    let normalized = "";
    let parenDepth = 0;

    for (const char of segment) {
      if (char === "(") {
        parenDepth++;
        normalized += char;
      } else if (char === ")") {
        parenDepth--;
        normalized += char;
      } else if (char === "|" && parenDepth === 0) {
        normalized += "<<<SEP>>>";
      } else if (char === "&" && parenDepth === 0 && !segment.includes("&&")) {
        normalized += "<<<SEP>>>";
      } else if (char === "+" && parenDepth === 0) {
        normalized += "<<<SEP>>>";
      } else if (char === "/" && parenDepth === 0) {
        normalized += "<<<SEP>>>";
      } else {
        normalized += char;
      }
    }

    // Handle "and" outside parentheses
    normalized = normalized.replace(/\s+and\s+/gi, "<<<SEP>>>");

    // Split by marker OR commas outside parentheses
    const entries = [];
    let current = "";
    parenDepth = 0;

    for (let i = 0; i < normalized.length; i++) {
      const char = normalized[i];

      if (normalized.substring(i, i + 9) === "<<<SEP>>>") {
        if (current.trim()) entries.push(current.trim());
        current = "";
        i += 8;
        continue;
      }

      if (char === "(") {
        parenDepth++;
        current += char;
      } else if (char === ")") {
        parenDepth--;
        current += char;
      } else if (char === "," && parenDepth === 0) {
        if (current.trim()) entries.push(current.trim());
        current = "";
      } else {
        current += char;
      }
    }
    if (current.trim()) entries.push(current.trim());

    const lockerEntries = [];
    for (const entry of entries) {
      const match = entry.match(/([A-Za-z0-9\-]+(?:\s*\([^)]*(?:\([^)]*\)[^)]*)*\))?)/);
      if (match && match[1]) lockerEntries.push(match[1].trim());
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
  const re = /\b(?:rink|arena)\s*([A-Za-z])/i;
  const m = text.match(re);
  return m ? m[1].toUpperCase() : null;
}

function cleanTeamName(title) {
  if (!title) return "";
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
  const json = JSON.parse(text.replace(/^[^{]+/, "").replace(/;?\s*$/, ""));
  const rows = json.table.rows || [];
  const data = rows.map((r) => (r.c || []).map((c) => (c ? c.v : "")));
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
  const rows = [];
  let row = [];
  let cur = "";
  let inQuotes = false;

  for (let i = 0; i < csv.length; i++) {
    const ch = csv[i];

    if (ch === '"') {
      if (inQuotes && csv[i + 1] === '"') {
        cur += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (ch === "," && !inQuotes) {
      row.push(cur);
      cur = "";
    } else if ((ch === "\n" || ch === "\r") && !inQuotes) {
      if (cur !== "" || row.length) {
        row.push(cur);
        rows.push(row);
        row = [];
        cur = "";
      }
    } else {
      cur += ch;
    }
  }

  if (cur !== "" || row.length) {
    row.push(cur);
    rows.push(row);
  }

  return rows;
}

/************************************
 * CORE: transform sheet rows → events
 ************************************/
function rowsToEvents(rows) {
  if (!rows || rows.length === 0) return [];
  const headerLikely = String(rows[0][0]).toLowerCase().includes("start");
  const startIndex = headerLikely ? 1 : 0;

  const events = [];
  for (let i = startIndex; i < rows.length; i++) {
    const r = rows[i] || [];
    const startISO = r[0];
    const endISO = r[1];
    const eventTitle = r[2] || "";
    const customTitle = r[3] || "";
    const desc = r[4] || "";

    const displayTitle = customTitle.trim() || eventTitle.trim();
    if (!startISO || !endISO || !displayTitle) continue;

    const start = new Date(startISO);
    const end = new Date(endISO);
    if (isNaN(start) || isNaN(end)) continue;

    const locker = parseLocker(desc) || parseLocker(displayTitle) || parseLocker(eventTitle) || "—";
    const rink = parseRink(desc) || parseRink(displayTitle) || parseRink(eventTitle) || "C";

    const rawLocker = desc || displayTitle || eventTitle || "—";

    events.push({
      startISO,
      endISO,
      start,
      end,
      titleRaw: displayTitle,
      team: cleanTeamName(displayTitle),
      description: desc,
      locker,
      rawLocker,
      rink,
      originalTitle: eventTitle,
      customTitle: customTitle,
    });
  }

  events.sort((a, b) => a.start - b.start);
  return events;
}

function sameDayInTZ(a, b, tz = FACILITY_TIMEZONE) {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const pa = fmt.formatToParts(a).reduce((o, p) => ((o[p.type] = p.value), o), {});
  const pb = fmt.formatToParts(b).reduce((o, p) => ((o[p.type] = p.value), o), {});
  return pa.year === pb.year && pa.month === pb.month && pa.day === pb.day;
}

/************************************
 * FILTER into On Ice / Up Next / Upcoming
 ************************************/
function splitThreeSections(events, now = new Date()) {
  const onIceList = [];
  const upNextList = [];
  const upcomingList = [];

  const todayEvents = events.filter((ev) => sameDayInTZ(ev.start, now, FACILITY_TIMEZONE));

  const currentEvents = [];
  const futureEvents = [];
  for (const ev of todayEvents) {
    if (ev.start <= now && now < ev.end) {
      currentEvents.push(ev);
    } else if (ev.start > now) {
      futureEvents.push(ev);
    }
  }

  futureEvents.sort((a, b) => a.start - b.start);

  onIceList.push(...currentEvents);

  if (futureEvents.length > 0) {
    upNextList.push(futureEvents[0]);
    upcomingList.push(...futureEvents.slice(1));
  }

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

  const parts = lockerStr.split(/\s*,\s*/).filter(Boolean);

  parts.forEach((part, idx) => {
    container.append(part);
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
  const lockerStr = ev.locker || "—";

  if (lockerStr === "—") return lockerRows;

  // Smart split: don't split on commas inside parentheses
  const lockerAssignments = [];
  let current = "";
  let parenDepth = 0;

  for (const char of lockerStr) {
    if (char === "(") {
      parenDepth++;
      current += char;
    } else if (char === ")") {
      parenDepth--;
      current += char;
    } else if (char === "," && parenDepth === 0) {
      if (current.trim()) lockerAssignments.push(current.trim());
      current = "";
    } else {
      current += char;
    }
  }
  if (current.trim()) lockerAssignments.push(current.trim());

  lockerAssignments.forEach((assignment) => {
    const match = assignment.match(/^(FLEX|\d+)(?:\s*\((.+)\))?$/i);
    if (!match) return;

    const lockerNum = match[1].toUpperCase();
    const teamName = match[2] || null;

    if (lockerNum === "FLEX" || LOCKER_BRANDING[lockerNum]) {
      lockerRows.push(renderBrandedLockerRoom(lockerNum, teamName ? teamName.trim() : null));
    }
  });

  // Fallback: legacy support
  if (lockerRows.length === 0) {
    const teamTitle = ev.team || ev.titleRaw;
    const games = teamTitle.split("&&").map((game) => game.trim());
    const lockerParts = (ev.rawLocker || ev.locker || "").split("&&").map((l) => l.trim());

    if (games.length > 1) {
      games.forEach((game, index) => {
        const rawGameLocker = lockerParts[index] || ev.rawLocker || ev.locker || "—";
        const gameLocker = parseLocker(rawGameLocker) || rawGameLocker || "—";
        const lockerNumbers = gameLocker
          .split(/[,|]/)
          .map((l) => l.trim().replace(/[^\d]/g, ""))
          .filter(Boolean);

        lockerNumbers.forEach((lockerNum) => {
          if (!LOCKER_BRANDING[lockerNum]) return;

          const teamName =
            game.toLowerCase().includes("skate") ||
            game.toLowerCase().includes("lesson") ||
            game.toLowerCase().includes("practice")
              ? null
              : game;

          lockerRows.push(renderBrandedLockerRoom(lockerNum, teamName));
        });
      });
    } else {
      const lockerNumbers = lockerStr
        .split(/[,|]/)
        .map((l) => l.trim().replace(/[^\d]/g, ""))
        .filter(Boolean);

      const actualTeamName = ev.team || ev.titleRaw || teamTitle;
      const isEventTitle =
        actualTeamName.toLowerCase().includes("skate") ||
        actualTeamName.toLowerCase().includes("lesson") ||
        actualTeamName.toLowerCase().includes("practice") ||
        actualTeamName.toLowerCase().includes("public");

      lockerNumbers.forEach((lockerNum) => {
        if (!LOCKER_BRANDING[lockerNum]) return;
        lockerRows.push(renderBrandedLockerRoom(lockerNum, isEventTitle ? null : actualTeamName));
      });
    }
  }

  return lockerRows;
}

function createEventPane(ev, context, chipClass, chipText) {
  const eventPane = document.createElement("div");
  eventPane.className = "event-pane";

  const matchDescription = parseEventDescription(ev.description);
  const displayTitle = ev.team || ev.titleRaw;
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
        <div class="description">${matchDescription || ""}</div>
      </div>

      <div class="locker-area">
        <ul class="locker-list"></ul>
      </div>
    </div>
  `;

  const lockerList = eventPane.querySelector(".locker-list");
  const lockerRows = createLockerRows(ev, context);
  lockerRows.forEach((row) => lockerList.appendChild(row));

  // Adaptive sizing based on number of lockers
  const numLockers = lockerRows.length;
  if (numLockers <= 2) lockerList.classList.add("locker-list-xl");
  else if (numLockers <= 4) lockerList.classList.add("locker-list-large");
  else if (numLockers === 5) lockerList.classList.add("locker-list-medium");
  else lockerList.classList.add("locker-list-compact");

  // Scrolling titles
  const largeTitleElement = eventPane.querySelector(".large-title");
  if (largeTitleElement) {
    setTimeout(() => {
      setupScrollingTitle(largeTitleElement, displayTitle, context === "upcoming");
    }, 250);
  }

  return eventPane;
}

function renderLists(onIceList, upNextList, upcomingList) {
  stopTicker();

  const onIceContainer = $("#onIceContainer");
  const upNextContainer = $("#upNextContainer");
  const upcomingContainer = $("#upcomingContainer");
  const mainContainer = $(".triple-split");

  onIceContainer.innerHTML = "";
  upNextContainer.innerHTML = "";
  upcomingContainer.innerHTML = "";

  const isInTwoSectionMode = onIceList.length === 0;

  if (isInTwoSectionMode) mainContainer.classList.add("two-section");
  else mainContainer.classList.remove("two-section");

  // On Ice
  if (onIceList.length === 0) {
    $("#onIceEmpty").hidden = false;
  } else {
    $("#onIceEmpty").hidden = true;
    onIceList.forEach((ev) => {
      const eventPane = createEventPane(ev, "on-ice", "chip-on-ice", "In Progress");
      onIceContainer.appendChild(eventPane);
    });
  }

  // Up Next
  if (upNextList.length === 0) {
    $("#upNextEmpty").hidden = false;
  } else {
    $("#upNextEmpty").hidden = true;
    const chipText = isInTwoSectionMode ? "Up Next" : "Next";
    upNextList.forEach((ev) => {
      const eventPane = createEventPane(ev, "up-next", "chip-up-next", chipText);
      upNextContainer.appendChild(eventPane);
    });
  }

  // Upcoming
  if (upcomingList.length === 0) {
    $("#upcomingEmpty").hidden = false;
    stopTicker();
  } else {
    $("#upcomingEmpty").hidden = true;

    upcomingList.forEach((ev, index) => {
      const eventPane = createEventPane(ev, "upcoming", "chip-upcoming", "Upcoming");
      if (index === 0) eventPane.classList.add("active");
      upcomingContainer.appendChild(eventPane);
    });

    if (upcomingList.length > 1) {
      setTimeout(() => startTickerForEventPanes(), 100);
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

  container.classList.remove("ticker");
  tickerItems.forEach((pane) => pane.classList.remove("active", "exit"));

  if (tickerItems.length <= 1) {
    if (tickerInterval) {
      clearInterval(tickerInterval);
      tickerInterval = null;
    }
    return;
  }

  container.classList.add("ticker");

  if (tickerInterval) clearInterval(tickerInterval);

  tickerItems.forEach((item) => item.classList.remove("active", "exit"));
  tickerItems[0].classList.add("active");
  currentTickerIndex = 0;

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
  }, 7000);
}

function startTicker() {
  startTickerForEventPanes();
}

function stopTicker() {
  if (tickerInterval) {
    clearInterval(tickerInterval);
    tickerInterval = null;
  }

  currentTickerIndex = 0;

  const upcomingContainer = $("#upcomingContainer");
  if (upcomingContainer) upcomingContainer.classList.remove("ticker");

  tickerItems.forEach((item) => item.classList.remove("active", "exit"));
  tickerItems = [];
}

/************************************
 * REFRESH LOOP
 ************************************/
async function loadAndRender() {
  try {
    const rows = USE_CSV ? await fetchCSV(SHEET_CSV_URL) : await fetchGVizJSON(SHEET_JSON_URL);

    const events = rowsToEvents(rows);
    const { onIceList, upNextList, upcomingList } = splitThreeSections(events, new Date());

    renderLists(onIceList, upNextList, upcomingList);

    updatePrintView(onIceList, upNextList, upcomingList);

    $("#updated").textContent = `Updated: ${fmtUpdated(new Date(), FACILITY_TIMEZONE)}`;
  } catch (err) {
    console.error("Failed to load sheet:", err);
    console.error("Error details:", {
      message: err?.message,
      stack: err?.stack,
      url: USE_CSV ? SHEET_CSV_URL : SHEET_JSON_URL,
      timestamp: new Date().toISOString(),
    });
    $("#updated").textContent = "Update failed—check network/sheet permissions.";
  }
}

/************************************
 * SCROLLING TITLE HELPER
 ************************************/
function setupScrollingTitle(teamElement, titleText, isUpcoming = false) {
  teamElement.classList.remove("scrolling", "scrolling-upcoming");
  teamElement.classList.add("checking-overflow");
  teamElement.innerHTML = "";

  const textSpan = document.createElement("span");
  textSpan.className = "team-text";
  textSpan.textContent = titleText;
  teamElement.appendChild(textSpan);

  const delay = isUpcoming ? 500 : 250;

  setTimeout(() => {
    teamElement.offsetHeight;

    const containerWidth = teamElement.offsetWidth;
    const textWidth = textSpan.scrollWidth;

    let actualTextWidth = textWidth;
    if (textWidth === 0) {
      const tempSpan = document.createElement("span");
      tempSpan.style.visibility = "hidden";
      tempSpan.style.position = "absolute";
      tempSpan.style.whiteSpace = "nowrap";
      tempSpan.style.fontSize = window.getComputedStyle(teamElement).fontSize;
      tempSpan.style.fontFamily = window.getComputedStyle(teamElement).fontFamily;
      tempSpan.style.fontWeight = window.getComputedStyle(teamElement).fontWeight;
      tempSpan.textContent = titleText;
      document.body.appendChild(tempSpan);
      actualTextWidth = tempSpan.offsetWidth;
      document.body.removeChild(tempSpan);
    }

    teamElement.classList.remove("checking-overflow");

    if (actualTextWidth > containerWidth) {
      const scrollDistance = actualTextWidth - containerWidth + 20;
      teamElement.style.setProperty("--scroll-distance", `-${scrollDistance}px`);
      teamElement.classList.add(isUpcoming ? "scrolling-upcoming" : "scrolling");
    }
  }, delay);
}

/************************************
 * PRINT VIEW FUNCTIONALITY
 ************************************/
async function updatePrintView(onIceList, upNextList, upcomingList) {
  try {
    const rows = USE_CSV ? await fetchCSV(SHEET_CSV_URL) : await fetchGVizJSON(SHEET_JSON_URL);
    const allEvents = rowsToEvents(rows);

    const now = new Date();
    const fiveDaysFromNow = new Date(now.getTime() + 5 * 24 * 60 * 60 * 1000);

    const next5DaysEvents = allEvents.filter((ev) => ev.start >= now && ev.start <= fiveDaysFromNow);
    next5DaysEvents.sort((a, b) => a.start - b.start);

    const printDate = document.getElementById("printDate");
    const startDateStr = new Intl.DateTimeFormat("en-US", {
      month: "short",
      day: "numeric",
      timeZone: FACILITY_TIMEZONE,
    }).format(now);
    const endDateStr = new Intl.DateTimeFormat("en-US", {
      month: "short",
      day: "numeric",
      year: "numeric",
      timeZone: FACILITY_TIMEZONE,
    }).format(fiveDaysFromNow);
    printDate.textContent = `${startDateStr} - ${endDateStr} (Next 5 Days)`;

    const tbody = document.getElementById("printTableBody");
    tbody.innerHTML = "";

    let currentDate = null;

    next5DaysEvents.forEach((ev) => {
      const eventDate = new Date(ev.start);
      const eventDateStr = new Intl.DateTimeFormat("en-US", {
        weekday: "long",
        month: "long",
        day: "numeric",
        timeZone: FACILITY_TIMEZONE,
      }).format(eventDate);

      if (eventDateStr !== currentDate) {
        currentDate = eventDateStr;

        const dateRow = document.createElement("tr");
        dateRow.className = "print-date-header";
        const dateCell = document.createElement("td");
        dateCell.colSpan = 3;
        dateCell.innerHTML = `<strong>${eventDateStr}</strong>`;
        dateRow.appendChild(dateCell);
        tbody.appendChild(dateRow);
      }

      const row = document.createElement("tr");

      const timeCell = document.createElement("td");
      timeCell.className = "print-time";
      timeCell.textContent = fmtTimeRange(ev.startISO, ev.endISO, FACILITY_TIMEZONE);

      const eventCell = document.createElement("td");
      eventCell.className = "print-event";

      const teamTitle = ev.team || ev.titleRaw;
      const games = teamTitle.split("&&").map((g) => g.trim());
      const matchDescription = parseEventDescription(ev.description);

      if (games.length > 1) {
        const gamesList = games.map((g) => `• ${g}`).join("<br>");
        eventCell.innerHTML =
          gamesList + (matchDescription ? `<br><span class="print-description">${matchDescription}</span>` : "");
      } else {
        eventCell.innerHTML =
          teamTitle + (matchDescription ? `<br><span class="print-description">${matchDescription}</span>` : "");
      }

      const roomsCell = document.createElement("td");
      roomsCell.className = "print-rooms";

      if (games.length > 1) {
        const lockerParts = (ev.rawLocker || ev.locker || "").split("&&").map((l) => l.trim());
        const roomsList = games
          .map((_, index) => {
            const rawGameLocker = lockerParts[index] || ev.rawLocker || ev.locker || "—";
            return parseLocker(rawGameLocker) || rawGameLocker || "—";
          })
          .join("<br>");
        roomsCell.innerHTML = roomsList;
      } else {
        roomsCell.textContent = ev.locker || "—";
      }

      row.appendChild(timeCell);
      row.appendChild(eventCell);
      row.appendChild(roomsCell);
      tbody.appendChild(row);
    });
  } catch (err) {
    console.error("Failed to load events for print view:", err);
    updatePrintViewFallback(onIceList, upNextList, upcomingList);
  }
}

function updatePrintViewFallback(onIceList, upNextList, upcomingList) {
  const allEvents = [];

  onIceList.forEach((ev) => allEvents.push({ ...ev, status: "in-progress", statusLabel: "In Progress" }));
  upNextList.forEach((ev) => allEvents.push({ ...ev, status: "up-next", statusLabel: "Up Next" }));
  upcomingList.forEach((ev) => allEvents.push({ ...ev, status: "upcoming", statusLabel: "Upcoming" }));

  allEvents.sort((a, b) => a.start - b.start);

  const printDate = document.getElementById("printDate");
  const now = new Date();
  const dateStr = new Intl.DateTimeFormat("en-US", {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
    timeZone: FACILITY_TIMEZONE,
  }).format(now);
  printDate.textContent = `${dateStr} - Remaining Events (Fallback)`;

  const tbody = document.getElementById("printTableBody");
  tbody.innerHTML = "";

  allEvents.forEach((ev) => {
    const row = document.createElement("tr");

    const timeCell = document.createElement("td");
    timeCell.className = "print-time";
    const timeRange = fmtTimeRange(ev.startISO, ev.endISO, FACILITY_TIMEZONE);
    timeCell.innerHTML = `${timeRange}<br><span class="print-status ${ev.status}">${ev.statusLabel}</span>`;

    const eventCell = document.createElement("td");
    eventCell.className = "print-event";

    const teamTitle = ev.team || ev.titleRaw;
    const games = teamTitle.split("&&").map((g) => g.trim());
    const matchDescription = parseEventDescription(ev.description);

    if (games.length > 1) {
      const gamesList = games.map((g) => `• ${g}`).join("<br>");
      eventCell.innerHTML =
        gamesList + (matchDescription ? `<br><span class="print-description">${matchDescription}</span>` : "");
    } else {
      eventCell.innerHTML =
        teamTitle + (matchDescription ? `<br><span class="print-description">${matchDescription}</span>` : "");
    }

    const roomsCell = document.createElement("td");
    roomsCell.className = "print-rooms";

    if (games.length > 1) {
      const lockerParts = (ev.rawLocker || ev.locker || "").split("&&").map((l) => l.trim());
      const roomsList = games
        .map((_, index) => {
          const rawGameLocker = lockerParts[index] || ev.rawLocker || ev.locker || "—";
          return parseLocker(rawGameLocker) || rawGameLocker || "—";
        })
        .join("<br>");
      roomsCell.innerHTML = roomsList;
    } else {
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
    presentedByElement.style.display = SHOW_PRESENTED_BY ? "flex" : "none";
  }
}

function renderBrandedLockerRoom(lockerNumber, teamName) {
  const branding = LOCKER_BRANDING[lockerNumber];

  if (!branding) {
    const lockerRow = document.createElement("li");
    lockerRow.className = "locker-row";
    lockerRow.innerHTML = `
      <div class="locker-logo-placeholder"></div>
      <span class="locker-brand locker-${lockerNumber}">
        <span class="locker-name-part">Locker ${lockerNumber}</span>${teamName ? ": " + teamName : ""}
      </span>
      <span></span>
    `;
    return lockerRow;
  }

  const lockerRow = document.createElement("li");
  lockerRow.className = "locker-row";
  lockerRow.innerHTML = `
    <img src="${branding.logo}" alt="${branding.name}" class="locker-logo"
         onerror="this.style.display='none'; this.nextElementSibling.style.display='block';" />
    <div class="locker-logo-placeholder" style="display:none;"></div>
    <span class="locker-brand locker-${lockerNumber}">
      <span class="locker-name-part">${branding.name} (${lockerNumber})</span>${teamName ? ": " + teamName : ""}
    </span>
    <span></span>
  `;
  return lockerRow;
}

function parseEventDescription(description) {
  if (!description) return null;
  const descMatch = description.match(/^Description:\s*"([^"]+)"/i);
  if (descMatch) return descMatch[1].trim();
  return null;
}

function startClock() {
  const tick = () => {
    $("#clock").textContent = fmtClock(new Date(), FACILITY_TIMEZONE);
  };
  tick();
  setInterval(tick, 30_000);
}

window.addEventListener("DOMContentLoaded", () => {
  updatePresentedByVisibility();
  startClock();
  loadAndRender();
  setInterval(loadAndRender, REFRESH_EVERY_MS);
});
