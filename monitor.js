// Showtime and seat monitor for "The Odyssey IMAX 70MM" at
// Cinemark Dallas XD and IMAX (theaterId 207, movieId 104867).
//
// Data sources (discovered in Phase 1, see discover.js):
//   Date list:  theater page date carousel (data-datevalue attributes)
//   Showtimes:  GET /umbraco/surface/Theater/GetShowtimes?theaterId=207&showDate=YYYY-MM-DD
//               (the AJAX partial the site's own date picker calls)
//   Seat maps:  GET /TicketSeatMap/?TheaterId=..&ShowtimeId=..&CinemarkMovieId=..&Showtime=..
//               (seat grid is server-rendered as <button available="True|False"
//                info="ROWLETTER,SEATNUM,physRow,physCol,showtimeId">)
//
// Alerts go to a Discord webhook (env DISCORD_WEBHOOK_URL). State lives in
// state.json, committed back to the repo by the GitHub Actions workflow.

const fs = require("fs");
const path = require("path");

const BASE = "https://www.cinemark.com";
const THEATER_PATH = "/theatres/tx-dallas/cinemark-dallas-xd-and-imax";
const SHOWTIMES_API = "/umbraco/surface/Theater/GetShowtimes";
const THEATER_ID = "207";
const MOVIE_ID = "104867";
const MOVIE_TITLE = "The Odyssey IMAX 70MM";

const STATE_FILE = path.join(__dirname, "state.json");
const WATCHLIST_FILE = path.join(__dirname, "watchlist.json");

const DELAY_MS = 1000; // pacing between requests, keeps Cloudflare happy
const SEAT_DELAY_MS = 2000; // slower pacing for full-page seat map fetches
const SEAT_BATCH = 8; // seat maps checked per run, rotating through the watchlist
const ERROR_ALERT_COOLDOWN_MS = 6 * 60 * 60 * 1000; // 6 hours
const REOPEN_ALERT_COOLDOWN_MS = 3 * 60 * 60 * 1000; // 3 hours
const WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL || "";

const COLORS = {
  newShowtime: 0x2ecc71,
  newBlock: 0xe74c3c,
  seats: 0x3498db,
  reopen: 0xf39c12,
  error: 0x95a5a6,
};

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

const HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
  "Accept-Language": "en-US,en;q=0.9",
  Referer: BASE + THEATER_PATH,
};

const cookies = {};
function cookieHeader() {
  return Object.entries(cookies)
    .map(([k, v]) => `${k}=${v}`)
    .join("; ");
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchText(url, accept, attempts = 3) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    if (i > 0) await sleep(5000 * i);
    try {
      const headers = { ...HEADERS, Accept: accept };
      if (accept.includes("q=0.01")) headers["X-Requested-With"] = "XMLHttpRequest";
      if (Object.keys(cookies).length) headers.Cookie = cookieHeader();
      const res = await fetch(url, { headers });
      for (const sc of res.headers.getSetCookie?.() || []) {
        const [kv] = sc.split(";");
        const eq = kv.indexOf("=");
        if (eq > 0) cookies[kv.slice(0, eq).trim()] = kv.slice(eq + 1);
      }
      if (!res.ok) {
        lastErr = new Error(`HTTP ${res.status} for ${url}`);
        continue;
      }
      return await res.text();
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr;
}

const fetchPage = (url, attempts) =>
  fetchText(
    url,
    "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    attempts
  );
const fetchPartial = (url) => fetchText(url, "text/html, */*; q=0.01");

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

function extractDates(html) {
  const dates = new Set();
  for (const m of html.matchAll(/data-datevalue="(\d{4}-\d{2}-\d{2})"/g)) {
    dates.add(m[1]);
  }
  return [...dates].sort();
}

function extractMovieBlock(html, movieId) {
  const start = html.indexOf(`showtimeMovieBlock ${movieId}`);
  if (start === -1) return null;
  const rest = html.slice(start + 10);
  const next = rest.search(/showtimeMovieBlock \d+/);
  return next === -1 ? html.slice(start) : html.slice(start, start + 10 + next);
}

// Returns { bookable: Map(showtimeId -> show), soldOutLabels: [..] } for one
// business date. Sold-out and past shows have no ShowtimeId in the markup.
function parseShowtimes(block, date) {
  const bookable = new Map();
  const soldOutLabels = [];
  const linkRe =
    /href="\/TicketSeatMap\/\?TheaterId=(\d+)&(?:amp;)?ShowtimeId=(\d+)&(?:amp;)?CinemarkMovieId=(\d+)&(?:amp;)?Showtime=([\dT:-]+)[^"]*"[^>]*>\s*([\d:]+[ap]m)/g;
  for (const m of block.matchAll(linkRe)) {
    bookable.set(m[2], {
      date,
      time: m[5],
      showtimeId: m[2],
      showtimeIso: m[4],
      ticketUrl: `${BASE}/TicketSeatMap/?TheaterId=${m[1]}&ShowtimeId=${m[2]}&CinemarkMovieId=${m[3]}&Showtime=${m[4]}`,
    });
  }
  const offRe = /<p class="off (soldOut|past)"[^>]*>\s*([\d:]+[ap]m)/g;
  const seen = new Set();
  for (const m of block.matchAll(offRe)) {
    if (m[1] !== "soldOut" || seen.has(m[2])) continue;
    seen.add(m[2]);
    soldOutLabels.push(m[2]);
  }
  return { bookable, soldOutLabels };
}

// Parse every seat button out of a TicketSeatMap page.
function parseSeatMap(html) {
  const seats = [];
  for (const m of html.matchAll(/<button\b[^>]*>/g)) {
    const tag = m[0];
    const info = /\binfo="([^"]+)"/.exec(tag);
    const cls = /\bclass="([^"]+)"/.exec(tag);
    if (!info || !cls || !/seatBlock/.test(cls[1])) continue;
    const parts = info[1].split(",");
    if (parts.length < 4) continue;
    seats.push({
      label: parts[0] + parts[1],
      row: Number(parts[2]),
      col: Number(parts[3]),
      available: /\bavailable="True"/.test(tag),
      regular: /\bseatAvailable\b|\bseatUnavailable\b/.test(cls[1]),
    });
  }
  return seats;
}

// Center section: middle third of columns in the back two-thirds of rows.
// Only regular seats count (wheelchair and companion spots excluded).
function centerAvailable(seats) {
  const rowIds = [...new Set(seats.map((s) => s.row))].sort((a, b) => a - b);
  const backRows = new Set(rowIds.slice(Math.floor(rowIds.length / 3)));
  const totalCols = Math.max(...seats.map((s) => s.col)) + 1;
  const colLo = Math.floor(totalCols / 3);
  const colHi = Math.ceil((totalCols * 2) / 3) - 1;
  return seats
    .filter(
      (s) =>
        s.regular &&
        s.available &&
        backRows.has(s.row) &&
        s.col >= colLo &&
        s.col <= colHi
    )
    .map((s) => s.label)
    .sort();
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

function loadState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
  } catch {
    return null;
  }
}

function saveState(state) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2) + "\n");
}

function loadWatchlistConfig() {
  try {
    const data = JSON.parse(fs.readFileSync(WATCHLIST_FILE, "utf8"));
    if (Array.isArray(data)) return { showtimeIds: data.map(String), rules: [] };
    return {
      showtimeIds: (data.showtimeIds || []).map(String),
      rules: data.rules || [],
    };
  } catch {
    return { showtimeIds: [], rules: [] };
  }
}

// "7:45am" -> minutes since midnight.
function timeLabelToMinutes(label) {
  const m = /^(\d{1,2}):(\d{2})([ap])m$/.exec(label.trim().toLowerCase());
  if (!m) return null;
  let h = Number(m[1]) % 12;
  if (m[3] === "p") h += 12;
  return h * 60 + Number(m[2]);
}

// Minutes since midnight of the show's BUSINESS date, so a 2:30am late show
// listed under Sunday counts as 26:30, not 2:30, and "until 7:00pm" on
// Sunday correctly excludes it.
function effectiveMinutes(show) {
  let mins = timeLabelToMinutes(show.time);
  if (mins === null) return null;
  if (show.showtimeIso.slice(0, 10) > show.date) mins += 1440;
  return mins;
}

function weekdayOf(date) {
  return new Date(date + "T12:00:00Z").toLocaleDateString("en-US", {
    weekday: "short",
    timeZone: "UTC",
  });
}

// A rule matches when every field it specifies matches (fields AND, rules OR).
// Supported fields: day ("Sat"), time (exact label "7:00pm"),
// until (label, show starts at or before it on its business date).
function ruleMatches(rule, show) {
  if (rule.day && weekdayOf(show.date) !== rule.day) return false;
  if (
    rule.time &&
    timeLabelToMinutes(show.time) !== timeLabelToMinutes(rule.time)
  )
    return false;
  if (rule.until) {
    const mins = effectiveMinutes(show);
    const cap = timeLabelToMinutes(rule.until);
    if (mins === null || cap === null || mins > cap) return false;
  }
  return true;
}

// Resolve explicit ids plus rules against the shows currently in state,
// skipping dates that are already over (theater runs on Chicago time).
function resolveWatchlist(state) {
  const { showtimeIds, rules } = loadWatchlistConfig();
  const ids = new Set(showtimeIds);
  const chicagoToday = new Date().toLocaleDateString("en-CA", {
    timeZone: "America/Chicago",
  });
  for (const show of Object.values(state.showtimes)) {
    if (show.date < chicagoToday) continue;
    if (rules.some((r) => ruleMatches(r, show))) ids.add(show.showtimeId);
  }
  return [...ids].sort();
}

// ---------------------------------------------------------------------------
// Discord
// ---------------------------------------------------------------------------

function fmtDate(date) {
  return new Date(date + "T12:00:00Z").toLocaleDateString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}

async function sendEmbeds(embeds) {
  if (!embeds.length) return;
  if (!WEBHOOK_URL) {
    console.log("DISCORD_WEBHOOK_URL not set, printing alerts instead:");
    for (const e of embeds) console.log(`  [${e.title}] ${e.description}`);
    return;
  }
  for (let i = 0; i < embeds.length; i += 10) {
    const batch = embeds.slice(i, i + 10);
    for (let attempt = 0; attempt < 2; attempt++) {
      const res = await fetch(WEBHOOK_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: "70mm Monitor", embeds: batch }),
      });
      if (res.status === 429) {
        const body = await res.json().catch(() => ({}));
        await sleep((body.retry_after || 2) * 1000 + 500);
        continue;
      }
      if (!res.ok) console.error(`Discord webhook failed: HTTP ${res.status}`);
      break;
    }
    await sleep(500);
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const now = new Date().toISOString();
  let state = loadState();
  const firstRun = !state || !state.showtimes;
  if (firstRun) {
    state = { showtimes: {}, latestDate: null, seats: {}, lastErrorAlertAt: null };
  }
  state.seats = state.seats || {};

  // 1. Date list from the theater page carousel, with a fallback window if
  // the page is blocked, so one Cloudflare challenge does not kill the run.
  let dates;
  try {
    const baseHtml = await fetchPage(BASE + THEATER_PATH);
    dates = extractDates(baseHtml);
    if (!dates.length) throw new Error("date carousel parsed empty");
  } catch (err) {
    console.error(`Theater page failed (${err}), using fallback date window`);
    const today = new Date();
    const known = Object.values(state.showtimes).map((s) => s.date);
    const end = new Date(
      Math.max(
        today.getTime() + 45 * 86400000,
        known.length
          ? new Date(known.sort().at(-1) + "T00:00:00Z").getTime() + 14 * 86400000
          : 0
      )
    );
    dates = [];
    for (let d = new Date(today); d <= end && dates.length < 60; d.setUTCDate(d.getUTCDate() + 1)) {
      dates.push(d.toISOString().slice(0, 10));
    }
  }
  console.log(`Checking ${dates.length} dates (${dates[0]} .. ${dates.at(-1)})`);

  // 2. Fetch showtimes for every date.
  const current = new Map(); // showtimeId -> normalized show
  const fetchErrors = [];
  for (const date of dates) {
    await sleep(DELAY_MS);
    try {
      const html = await fetchPartial(
        `${BASE}${SHOWTIMES_API}?theaterId=${THEATER_ID}&showDate=${date}`
      );
      const block = extractMovieBlock(html, MOVIE_ID);
      if (!block) continue;
      const { bookable } = parseShowtimes(block, date);
      for (const [id, show] of bookable) current.set(id, show);
    } catch (err) {
      fetchErrors.push(`${date}: ${err}`);
    }
  }
  console.log(`Found ${current.size} bookable showtimes, ${fetchErrors.length} fetch errors`);

  // If everything failed, treat it as a scraper error rather than diffing
  // against an empty snapshot.
  if (current.size === 0 && fetchErrors.length === dates.length && dates.length > 0) {
    throw new Error(`All ${dates.length} date fetches failed. First: ${fetchErrors[0]}`);
  }

  const embeds = [];

  // 3. Diff against state.
  const prevLatest = state.latestDate;
  const newShows = [...current.values()].filter((s) => !state.showtimes[s.showtimeId]);
  const reopened = [...current.values()].filter((s) => {
    const prev = state.showtimes[s.showtimeId];
    if (!prev || prev.status !== "soldOut") return false;
    const last = prev.lastReopenAlertAt ? Date.parse(prev.lastReopenAlertAt) : 0;
    return Date.now() - last > REOPEN_ALERT_COOLDOWN_MS;
  });

  const currentDates = [...current.values()].map((s) => s.date).sort();
  const newLatest = currentDates.at(-1) || null;
  const isNewBlock = Boolean(prevLatest && newLatest && newLatest > prevLatest);
  const blockShows = isNewBlock ? newShows.filter((s) => s.date > prevLatest) : [];
  const ordinaryNew = newShows.filter((s) => !blockShows.includes(s));

  const showLine = (s) =>
    `**${fmtDate(s.date)} ${s.time}** [Tickets](${s.ticketUrl}) (id ${s.showtimeId})`;

  if (!firstRun && isNewBlock && blockShows.length) {
    embeds.push({
      title: `🚨 NEW BOOKING BLOCK: ${MOVIE_TITLE}`,
      description:
        `New dates just dropped! Bookable through **${fmtDate(newLatest)}** ` +
        `(was ${fmtDate(prevLatest)}).\n\n` +
        blockShows.map(showLine).join("\n").slice(0, 3800),
      color: COLORS.newBlock,
      timestamp: now,
    });
  }
  if (!firstRun && ordinaryNew.length) {
    embeds.push({
      title: `🎬 New showtimes: ${MOVIE_TITLE}`,
      description: ordinaryNew.map(showLine).join("\n").slice(0, 3800),
      color: COLORS.newShowtime,
      timestamp: now,
    });
  }
  if (!firstRun && reopened.length) {
    embeds.push({
      title: `🎟️ Sold-out show reopened: ${MOVIE_TITLE}`,
      description: reopened.map(showLine).join("\n").slice(0, 3800),
      color: COLORS.reopen,
      timestamp: now,
    });
  }

  // 4. Update showtime state. Entries persist after selling out so watched
  // showtimeIds keep their metadata; old dates get pruned.
  for (const [id, show] of current) {
    const prev = state.showtimes[id] || {};
    state.showtimes[id] = {
      ...prev,
      ...show,
      status: "bookable",
      firstSeen: prev.firstSeen || now,
      lastSeen: now,
    };
    if (reopened.some((r) => r.showtimeId === id)) {
      state.showtimes[id].lastReopenAlertAt = now;
    }
  }
  for (const [id, show] of Object.entries(state.showtimes)) {
    if (!current.has(id) && show.status === "bookable" && !fetchErrors.length) {
      show.status = "soldOut";
    }
  }
  const cutoff = new Date(Date.now() - 2 * 86400000).toISOString().slice(0, 10);
  for (const [id, show] of Object.entries(state.showtimes)) {
    if (show.date < cutoff) {
      delete state.showtimes[id];
      delete state.seats[id];
    }
  }
  if (newLatest && (!state.latestDate || newLatest > state.latestDate)) {
    state.latestDate = newLatest;
  }

  // 5. Seat watching for watchlisted showtimeIds (explicit ids plus rules).
  // Cloudflare tolerates only about a dozen full TicketSeatMap page loads
  // per IP, and each Actions run gets a fresh IP, so we check a rotating
  // batch per run instead of the whole watchlist. Once flagged, an IP stays
  // flagged, so two consecutive 403s abort the sweep for this run.
  const watchlist = resolveWatchlist(state);
  const cursor = Number.isInteger(state.seatCursor) ? state.seatCursor : 0;
  const batch = [];
  for (let i = 0; i < Math.min(SEAT_BATCH, watchlist.length); i++) {
    batch.push(watchlist[(cursor + i) % watchlist.length]);
  }
  console.log(
    `Watchlist resolved to ${watchlist.length} show(s), checking ${batch.length} this run (cursor ${cursor})`
  );
  let seatOk = 0;
  let seat403Streak = 0;
  for (const id of batch) {
    const show = state.showtimes[id];
    if (!show) {
      console.warn(`Watchlist id ${id} not found in state, skipping`);
      continue;
    }
    await sleep(SEAT_DELAY_MS + Math.floor(Math.random() * 1000));
    try {
      const html = await fetchPage(show.ticketUrl, 1);
      const seats = parseSeatMap(html);
      if (!seats.length) throw new Error("seat map parsed empty");
      seatOk++;
      seat403Streak = 0;
      const center = centerAvailable(seats);
      const prev = state.seats[id];
      if (prev && center.length > prev.count) {
        const opened = center.filter((l) => !prev.seats.includes(l));
        embeds.push({
          title: `💺 Center seats opened: ${fmtDate(show.date)} ${show.time}`,
          description:
            `${MOVIE_TITLE}\nCenter section: **${prev.count} → ${center.length}** available.\n` +
            `Newly open: **${opened.join(", ") || "(rearranged)"}**\n[Grab them](${show.ticketUrl})`,
          color: COLORS.seats,
          timestamp: now,
        });
      }
      state.seats[id] = { count: center.length, seats: center, updatedAt: now };
      console.log(`Watch ${id} (${show.date} ${show.time}): ${center.length} center seats`);
    } catch (err) {
      if (/HTTP 403/.test(String(err))) {
        seat403Streak++;
        console.warn(`Seat map 403 for ${id} (streak ${seat403Streak})`);
        if (seat403Streak >= 2) {
          console.warn("IP flagged for seat pages, aborting sweep until next run");
          break;
        }
      } else {
        fetchErrors.push(`seatmap ${id}: ${err}`);
      }
    }
  }
  if (watchlist.length) {
    state.seatCursor = (cursor + Math.max(seatOk, 1)) % watchlist.length;
    if (batch.length && seatOk === 0) {
      fetchErrors.push(`seat sweep: 0 of ${batch.length} seat maps fetched`);
    }
  }

  // 6. Error alert, rate limited to once per 6 hours.
  if (fetchErrors.length) {
    console.error(`Errors this run:\n  ${fetchErrors.join("\n  ")}`);
    const last = state.lastErrorAlertAt ? Date.parse(state.lastErrorAlertAt) : 0;
    if (Date.now() - last > ERROR_ALERT_COOLDOWN_MS) {
      state.lastErrorAlertAt = now;
      embeds.push({
        title: "⚠️ 70mm monitor: scrape errors",
        description:
          `${fetchErrors.length} error(s) this run. First few:\n` +
          fetchErrors.slice(0, 5).join("\n").slice(0, 3800),
        color: COLORS.error,
        timestamp: now,
      });
    }
  }

  if (firstRun) {
    console.log(
      `First run: baselined ${current.size} showtimes, latest date ${state.latestDate}. No alerts sent.`
    );
  }

  await sendEmbeds(embeds);
  saveState(state);
  console.log(
    `Done. ${embeds.length} alert embed(s). Latest known date: ${state.latestDate}.`
  );
}

main().catch(async (err) => {
  console.error(err);
  // Try to post the fatal error to Discord, still respecting the cooldown.
  const state = loadState() || { lastErrorAlertAt: null };
  const last = state.lastErrorAlertAt ? Date.parse(state.lastErrorAlertAt) : 0;
  if (Date.now() - last > ERROR_ALERT_COOLDOWN_MS) {
    state.lastErrorAlertAt = new Date().toISOString();
    await sendEmbeds([
      {
        title: "⚠️ 70mm monitor: run failed",
        description: String(err).slice(0, 3800),
        color: COLORS.error,
        timestamp: new Date().toISOString(),
      },
    ]).catch(() => {});
    try {
      saveState(state);
    } catch {}
  }
  process.exit(1);
});
