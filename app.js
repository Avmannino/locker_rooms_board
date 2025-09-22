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

function parseLocker(text) {
  if (!text) return null;

  // 1) Prefer explicit "Locker Room(s): ..." or "Room(s): ..."
  //    This captures the remainder of the line, then extracts entries like:
  //    1, 3 (Red), A1, 4 (CT Beer), etc.
  const reList = /\b(?:locker\s*rooms?|rooms?)\b\s*:?\s*([^\n\r;]*)/i;
  const m = text.match(reList);
  if (m) {
    const segment = (m[1] || "")
      // normalize separators to a single pipe so we don't split inside parentheses
      .replace(/[,/]+/g, "|");

    // Match "token (optional note)" groups; tokens can be numbers/letters/dashes
    const entries = [];
    const reEntry = /([A-Za-z0-9\-]+(?:\s*\([^)]+\))?)/g;
    let em;
    while ((em = reEntry.exec(segment)) !== null) {
      const val = em[1].trim();
      if (val) entries.push(val);
    }
    if (entries.length) return entries.join(", ");
  }

  // 2) Fallback simple single-room forms: "Locker 3", "Room 12", "LR 2", "LKR-A"
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
  // First, remove known locker suffixes if present
  const withoutLocker = title.replace(
    /\s*[-–—]\s*(locker(?:\s*room)?|room|rm|lr|lkr)\b.*$/i,
    ""
  );
  // Then trim anything after the first spaced dash ( -, – or — )
  // e.g. "Bantam Greenwich Skating Club - Private" -> "Bantam Greenwich Skating Club"
  // Keeps hyphenated words like "U-12" because it requires spaces around the dash.
  return withoutLocker.split(/\s[-–—]\s/)[0].trim();
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
    const startISO = r[0];           // "2025-10-26T16:40:00Z"
    const endISO   = r[1];
    const title    = r[2] || "";
    const desc     = r[3] || "";

    if (!startISO || !endISO || !title) continue;

    const start = new Date(startISO);
    const end   = new Date(endISO);
    if (isNaN(start) || isNaN(end)) continue;

    // Locker & rink extraction from title or description
    const locker = parseLocker(title) || parseLocker(desc) || "—";
    const rink   = parseRink(title) || parseRink(desc) || "C";

    events.push({
      startISO, endISO, start, end,
      titleRaw: title,
      team: cleanTeamName(title),
      description: desc,
      locker,
      rink
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
 * FILTER into Now / Next (Next = rest of TODAY)
 ************************************/
function splitNowNext(events, now = new Date()) {
  const nowList = [];
  const nextList = [];

  for (const ev of events) {
    if (ev.start <= now && now < ev.end) {
      nowList.push(ev);
    } else if (ev.start > now && sameDayInTZ(ev.start, now, FACILITY_TIMEZONE)) {
      // Anything later TODAY goes to "Next"
      nextList.push(ev);
    }
  }

  // Nice ordering
  nowList.sort((a, b) => a.end - b.end);      // ending soon first
  nextList.sort((a, b) => a.start - b.start); // soonest first
  return { nowList, nextList };
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

    // Insert red pipe between entries (not after the last one)
    if (idx < parts.length - 1) {
      const sep = document.createElement("span");
      sep.className = "room-sep";
      sep.textContent = "|";
      container.appendChild(sep);
    }
  });
}

/************************************
 * RENDER
 ************************************/
function createRow(ev, context /* "now" | "next" */) {
  const li = document.createElement("li");

  const left = document.createElement("div");
  left.className = "item";

  // Team name
  const team = document.createElement("div");
  team.className = "team";
  team.textContent = ev.team || ev.titleRaw;
  left.appendChild(team);

  // Room badge
  const room = document.createElement("div");
  room.className = "badge room";

  // Count entries robustly (each "123" possibly followed by "(note)")
  const entryMatches = (ev.locker || "").match(/([A-Za-z0-9\-]+(?:\s*\([^)]+\))?)/g);
  const count = entryMatches ? entryMatches.length : 0;
  const roomLabel = count > 1 ? "Rooms" : "Room";

  // Render label + red pipe-separated entries
  room.append(`${roomLabel} `);
  renderLockerBadgeContent(room, ev.locker);

  // Time badge
  const time = document.createElement("div");
  time.className = "badge time";
  const range = fmtTimeRange(ev.startISO, ev.endISO, FACILITY_TIMEZONE);
  time.textContent = range || "";

  // Warning if about to start (for "next" column)
  if (context === "next") {
    const minutesTo = Math.round((ev.start - new Date()) / 60000);
    if (minutesTo <= 10) {
      time.classList.add("warn");
    }
  }

  li.appendChild(time);
  li.appendChild(left);
  li.appendChild(room);
  return li;
}

function renderLists(nowList, nextList) {
  const nowUL = $("#nowList");
  const nextUL = $("#nextList");
  nowUL.innerHTML = "";
  nextUL.innerHTML = "";

  if (nowList.length === 0) {
    $("#nowEmpty").hidden = false;
  } else {
    $("#nowEmpty").hidden = true;
    nowList.forEach(ev => nowUL.appendChild(createRow(ev, "now")));
  }

  if (nextList.length === 0) {
    $("#nextEmpty").hidden = false;
  } else {
    $("#nextEmpty").hidden = true;
    nextList.forEach(ev => nextUL.appendChild(createRow(ev, "next")));
  }
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
    const { nowList, nextList } = splitNowNext(events, new Date());

    renderLists(nowList, nextList);

    // Update timestamp
    $("#updated").textContent = `Updated: ${fmtUpdated(new Date(), FACILITY_TIMEZONE)}`;
  } catch (err) {
    console.error("Failed to load sheet:", err);
    $("#updated").textContent = "Update failed—check network/sheet permissions.";
  }
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
