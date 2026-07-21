// Phase 1 endpoint discovery for the Odyssey IMAX 70MM monitor.
//
// Confirmed so far:
//   Theater:  Cinemark Dallas XD and IMAX, TheaterId = 207
//   Movie:    "The Odyssey IMAX 70MM", CinemarkMovieId = 104867
//            (standard Odyssey = 108919, En Espanol = 110488)
//   Data source: the AJAX partial the site's own date picker calls:
//     GET https://www.cinemark.com/umbraco/surface/Theater/GetShowtimes?theaterId=207&showDate=YYYY-MM-DD
//   It returns server-rendered HTML with a block per movie
//   (class="showtimeMovieBlock 104867"). Bookable showtimes are links:
//     /TicketSeatMap/?TheaterId=207&ShowtimeId=NNNNNN&CinemarkMovieId=104867&Showtime=YYYY-MM-DDTHH:MM:SS
//   Sold-out and past showtimes render as <p class="off soldOut"> or
//   <p class="off past"> with only a time label, no ShowtimeId.
//   The list of valid dates comes from the theater page's date carousel
//   (data-datevalue attributes).
//
// Cloudflare notes: the full theater page challenges Node's fetch after
// 1-2 requests, but this partial endpoint tolerates sequential requests
// fine. We fetch the theater page once (for the date list), keep any
// cookies Cloudflare sets, and pace requests ~1/second.

const BASE = "https://www.cinemark.com";
const THEATER_PATH = "/theatres/tx-dallas/cinemark-dallas-xd-and-imax";
const SHOWTIMES_API = "/umbraco/surface/Theater/GetShowtimes";
const MOVIE_ID = "104867";
const THEATER_ID = "207";
const DELAY_MS = 1000;

const HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
  Accept: "text/html, */*; q=0.01",
  "Accept-Language": "en-US,en;q=0.9",
  "X-Requested-With": "XMLHttpRequest",
  Referer: BASE + THEATER_PATH,
};

const cookies = {};
function cookieHeader() {
  return Object.entries(cookies)
    .map(([k, v]) => `${k}=${v}`)
    .join("; ");
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchText(url, extraHeaders = {}) {
  const headers = { ...HEADERS, ...extraHeaders };
  if (Object.keys(cookies).length) headers.Cookie = cookieHeader();
  const res = await fetch(url, { headers });
  for (const sc of res.headers.getSetCookie?.() || []) {
    const [kv] = sc.split(";");
    const eq = kv.indexOf("=");
    if (eq > 0) cookies[kv.slice(0, eq).trim()] = kv.slice(eq + 1);
  }
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.text();
}

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

function parseShowtimes(block) {
  const byId = new Map();
  const off = [];
  const linkRe =
    /href="\/TicketSeatMap\/\?TheaterId=(\d+)&(?:amp;)?ShowtimeId=(\d+)&(?:amp;)?CinemarkMovieId=(\d+)&(?:amp;)?Showtime=([\dT:-]+)[^"]*"[^>]*>\s*([\d:]+[ap]m)/g;
  for (const m of block.matchAll(linkRe)) {
    byId.set(m[2], {
      status: "bookable",
      theaterId: m[1],
      showtimeId: m[2],
      movieId: m[3],
      showtimeIso: m[4],
      label: m[5],
      ticketUrl: `${BASE}/TicketSeatMap/?TheaterId=${m[1]}&ShowtimeId=${m[2]}&CinemarkMovieId=${m[3]}&Showtime=${m[4]}`,
    });
  }
  const offRe = /<p class="off (soldOut|past)"[^>]*>\s*([\d:]+[ap]m)/g;
  const seenOff = new Set();
  for (const m of block.matchAll(offRe)) {
    const key = `${m[1]}|${m[2]}`;
    if (seenOff.has(key)) continue;
    seenOff.add(key);
    off.push({ status: m[1] === "soldOut" ? "soldOut" : "past", label: m[2] });
  }
  return [...byId.values(), ...off];
}

async function main() {
  console.log(`Fetching date list from ${BASE}${THEATER_PATH}`);
  const baseHtml = await fetchText(BASE + THEATER_PATH, {
    Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  });
  const dates = extractDates(baseHtml);
  console.log(
    `Date carousel: ${dates.length} dates, ${dates[0]} .. ${dates[dates.length - 1]}\n`
  );

  let totalBookable = 0;
  let totalSoldOut = 0;
  let errors = 0;

  for (const date of dates) {
    await sleep(DELAY_MS);
    let shows;
    try {
      const html = await fetchText(
        `${BASE}${SHOWTIMES_API}?theaterId=${THEATER_ID}&showDate=${date}`
      );
      const block = extractMovieBlock(html, MOVIE_ID);
      shows = block ? parseShowtimes(block) : null;
    } catch (err) {
      errors++;
      console.log(`${date}: ERROR ${err}`);
      continue;
    }
    if (!shows || shows.length === 0) continue;
    console.log(`=== ${date} ===`);
    for (const s of shows) {
      if (s.status === "bookable") {
        totalBookable++;
        console.log(
          `  ${s.label.padStart(8)}  bookable  showtimeId=${s.showtimeId}  showtime=${s.showtimeIso}`
        );
        console.log(`            ${s.ticketUrl}`);
      } else {
        if (s.status === "soldOut") totalSoldOut++;
        console.log(`  ${s.label.padStart(8)}  ${s.status}`);
      }
    }
  }

  console.log(
    `\nSummary: theaterId=${THEATER_ID} movieId=${MOVIE_ID}, ${totalBookable} bookable, ${totalSoldOut} sold out, ${errors} errors across ${dates.length} dates.`
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
