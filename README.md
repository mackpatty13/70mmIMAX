# The Odyssey IMAX 70MM showtime monitor

Watches the Cinemark Dallas XD and IMAX theater (11819 Webb Chapel Rd, Dallas)
for "The Odyssey IMAX 70MM" and posts to a Discord webhook when:

- a brand-new showtime appears inside one of the priority windows in
  `watchlist.json` (weekends only, see below)
- a new booking block drops (dates later than anything seen before, flagged
  with a 🚨 NEW BOOKING BLOCK alert), listing only the priority-window shows
- center-section seats open up on a watched show, and only when at least
  2 center seats are available (a lone stray seat is not worth an alert)

Deliberately silent on: Monday through Thursday shows, the 2:30am late
shows, and previously sold-out shows reopening (those are usually a single
leftover seat).

Priority windows (business date of the show; the 2:30am slot counts as the
previous day's late show and is excluded everywhere):

- **P1**: Friday evening, 5:00pm onward. Friday 7:00pm is the top pick and
  gets a ⭐ tag in alerts.
- **P2**: Sunday, any show up to and including 7:00pm.
- **P3**: Saturday 11:30am through 7:00pm, plus the 7:45am early show and
  the late-evening show (the ~10:45pm slot).

Runs on GitHub Actions every 5 minutes (GitHub's minimum; actual cadence is
best-effort and can stretch toward 10 to 15 minutes under load). State lives
in `state.json`, which the workflow commits back to the repo after each run.

## How it works

- Cinemark's legacy site renders showtimes server-side. The monitor calls the
  same AJAX partial the site's date picker uses:
  `https://www.cinemark.com/umbraco/surface/Theater/GetShowtimes?theaterId=207&showDate=YYYY-MM-DD`
- Theater ID: `207`. Movie ID for the 70mm listing: `104867` (it is a separate
  listing from the standard "The Odyssey", so every showtime it returns is a
  70mm show).
- Seat maps come from the `TicketSeatMap` page for a showtime. "Center
  section" means the middle third of columns in the back two-thirds of rows,
  regular seats only (wheelchair and companion spots are excluded).
- Requests are paced at about one per second with browser-like headers and
  cookie reuse. Cloudflare tolerates this; bursts of parallel requests get
  challenged.
- Sold-out shows render with no ShowtimeId on Cinemark's pages, so a show
  that was already sold out the first time the monitor ever saw it cannot be
  tracked until seats reopen. Shows seen bookable at least once keep their
  metadata in `state.json` even after selling out.

## Setup

1. Push this repo to GitHub.

2. Create a Discord webhook:
   - In your Discord server, open the target channel's settings
     (gear icon) > Integrations > Webhooks > New Webhook.
   - Name it whatever you like, then Copy Webhook URL.

3. Add the webhook URL as a repo secret:
   - GitHub repo > Settings > Secrets and variables > Actions >
     New repository secret.
   - Name: `DISCORD_WEBHOOK_URL`, value: the URL you copied.

4. Enable the workflow: the Actions tab may ask you to enable workflows for
   the repo. The monitor then runs every 5 minutes, or on demand via
   Actions > showtime-monitor > Run workflow.

The very first run baselines `state.json` without sending alerts, so you do
not get spammed with 100+ "new showtime" messages. Diffing starts from the
second run.

## Watching seats

`watchlist.json` supports explicit showtimeIds, rules, or both. The rules
also double as the alert filter: a brand-new showtime only triggers a "new
showtime" alert if it matches at least one rule. Current config:

```json
{
  "showtimeIds": [],
  "rules": [
    { "day": "Fri", "from": "5:00pm", "until": "11:59pm", "priority": 1 },
    { "day": "Sun", "until": "7:00pm", "priority": 2 },
    { "day": "Sat", "from": "11:30am", "until": "7:00pm", "priority": 3 },
    { "day": "Sat", "from": "7:30am", "until": "8:00am", "priority": 3 },
    { "day": "Sat", "from": "10:00pm", "until": "11:59pm", "priority": 3 }
  ]
}
```

You get an alert whenever the count of available center-section seats for a
watched show increases AND at least 2 center seats are available, including
which seat labels opened up.

Rules are re-evaluated against the current schedule every run, so when a new
booking block drops its matching shows are watched automatically. A rule
matches a show when every field it specifies matches; separate rules are OR'd
together. Fields:

- `day`: short weekday name ("Mon" .. "Sun") of the show's business date.
- `time`: exact showtime label, for example "7:00pm".
- `from`: match shows starting at or after this time.
- `until`: match shows starting at or before this time. Late-night shows
  (the 2:30am slot) belong to the previous day's schedule and count as after
  midnight, so any rule capped at "11:59pm" or earlier excludes them.
- `priority`: integer, lower is more important. Shown as [P1]/[P2]/[P3] in
  alerts and used to sort alert lines. Informational only; it does not
  change what gets watched.

Only shows the monitor has seen bookable at least once can be watched
(Cinemark's pages give sold-out shows no id), past dates are skipped
automatically, and sold-out shows are dropped from the seat-check rotation
so the Cloudflare-limited seat budget goes to shows that are actually
bookable.

Seat map pages are rate limited by Cloudflare far more aggressively than the
showtimes endpoint (roughly a dozen page loads per IP), so each run checks a
rotating batch of 8 watched shows and picks up where it left off next run.
The weekend-only rules keep the watchlist small (about 11 shows per weekend
on the schedule), so at a 5-minute cadence every watched show gets a seat
check roughly every 10 to 15 minutes. Keep the watchlist focused; watching
everything dilutes how often each show is checked.

### Finding a showtimeId

Any of these work:

- From an alert: every showtime alert includes `(id NNNNNN)`.
- From `state.json`: entries are keyed by showtimeId and include the date and
  time of each show.
- From cinemark.com: click a showtime and look at the URL, for example
  `https://www.cinemark.com/TicketSeatMap/?TheaterId=207&ShowtimeId=635630&...`
  The `ShowtimeId` query parameter is the id.

## Running locally

```
node monitor.js
```

With no `DISCORD_WEBHOOK_URL` set, alerts print to the console instead of
posting to Discord. `node discover.js` dumps the full raw showtime data for
every date the theater currently lists, useful for sanity checks.

## Error alerts

If scraping fails (Cloudflare block, site change, etc.) the monitor posts a
distinct error alert, rate limited to once per 6 hours so a broken endpoint
does not spam the channel. Errors are always visible in the Actions run logs
regardless of the cooldown.
