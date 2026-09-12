# Toronto Event-Aware Router

A single-page map that draws **live road events** from the City of Toronto's
**CKAN** Open Data portal and recommends the walking route that passes the
**fewest** of them — "rerouting based on local events."

![panel: search + legend | map: events + routes]

## What it does

- Fetches the [Road Restrictions](https://open.toronto.ca/dataset/road-restrictions/)
  dataset (published via Toronto's CKAN portal) — ~1,900 live disruptions with
  coordinates, each typed as **special event**, **road closed**, **construction**,
  or **hazard**, with a name, description, and active time window.
- Plots every event as a colour-coded marker with a popup; filter by type or by
  "active right now."
- Set a **start** and **destination** (Places autocomplete or click-to-drop),
  then it requests Google Directions **with alternatives** and gives each route
  a weighted **danger score** (see below) instead of a plain event count.
- Draws the **fastest** route dimmed and the **recommended** (least-dangerous)
  route highlighted, shows each route's risk tier + score, and lists the events
  on the recommended path worst-first (with High/Medium/Low chips and distance).
- A **Fastest ⟷ Safest** slider re-scores the routes live, letting you trade
  walk time against risk without another API call.
- **Report an incident** — click the button, pick a severity (burglary /
  assault / disturbance), add a description, and it drops a colour-coded
  marker at your current location. Reports are stored server-side, so
  anyone else with the page open (on any device) sees it too, within a few
  seconds.

## How rerouting weighs danger

Each route's cost is a single number:

```
cost = walk_minutes + lambda * danger_score
```

`lambda` (minutes you'll detour per danger point) comes from the slider. The
`danger_score` is the sum, over every event within ~150 m of the route, of:

```
severity x type x direction x roadClass x active_now x proximity
```

using the feed's own signals — all tunable in `config.js` under `DANGER`:

| Factor | Source field | Why it matters |
|---|---|---|
| **Severity** | `currImpact` / `maxImpact` (High/Med/Low) | The city's own impact rating — the strongest signal |
| **Type** | `type` / `specialEvent` | A full road closure or parade outweighs routine construction |
| **Direction** | `directionsAffected` | Both-directions closures block more than one-way |
| **Road class** | `roadClass` | Expressway/arterial disruptions ripple into surrounding traffic |
| **Active now** | `startTime` / `endTime` | Events scheduled for later count much less |
| **Proximity** | distance to route | On-the-path events count fully; ones ~150 m off fade to zero |

Proximity uses a true point-to-polyline distance (local equirectangular
projection), not just a boolean "near the line" test, so closeness is graded.

## Setup

1. Get a **Google Maps JavaScript API key** and enable these APIs for it:
   **Maps JavaScript API**, **Directions API**, **Places API**.
   → https://console.cloud.google.com/google/maps-apis/credentials
2. Open `config.js` and replace `YOUR_API_KEY` with your key.
3. Install the Python dependencies and start the app server (it serves the
   frontend *and* the incident-reports API, so use this instead of
   `python3 -m http.server`):
   ```bash
   poetry install
   poetry run python3 server.py
   ```
   Then open **http://localhost:8000** on this machine — that's all you need
   for solo testing.

4. **To let other devices (phones, etc.) use it too — including submitting
   reports** — they need to reach the server over HTTPS. `navigator.geolocation`
   (used by "Use current location" and "Report an incident") only works on a
   secure origin, and `localhost` is the only exception; a plain `http://`
   address on another device won't get a location. The simplest fix is a
   [Cloudflare Tunnel](https://github.com/cloudflare/cloudflared), which
   gives you a real, trusted HTTPS URL (no certificate warnings) with no
   account needed:
   ```bash
   brew install cloudflared      # one-time
   cloudflared tunnel --url http://localhost:8000
   ```
   It prints a URL like `https://some-random-words.trycloudflare.com` —
   share that with any device. It changes every time you restart the
   tunnel, and stops working as soon as you stop it (Ctrl+C). Note this
   briefly makes the app reachable by anyone with that link, not just your
   WiFi, for as long as the tunnel is running.

No key is needed for the event data — it comes from the public CKAN feed.
Incident reports are stored in a local SQLite file, `reports.db`, created
automatically next to `server.py` on first run.

## Files

| File         | Purpose                                                        |
|--------------|----------------------------------------------------------------|
| `index.html` | Layout, styles, and the Maps SDK bootstrap.                    |
| `app.js`     | Data fetch/normalize, markers, filters, routing + scoring.    |
| `config.js`  | Your API key and the CKAN source/tuning constants.            |
| `server.py`  | Flask app: serves the frontend + the `/api/reports` incident-report API (SQLite-backed). |

## Data source & notes

- Source: Toronto Open Data — *Road Restrictions* (Version 3 JSON resource
  `421c8a17-4ecf-4cae-b084-ccb005ea6cc3`). It sends `Access-Control-Allow-Origin: *`,
  so the browser can fetch it directly.
- The feed occasionally emits invalid JSON string escapes; `app.js` repairs
  them before parsing.
- "Events" here means anything the city reports as affecting the road network,
  including festivals/parades (`specialEvent = Yes`) and closures — exactly the
  things that justify a reroute. The dedicated *Festivals & Events* CKAN feed is
  currently returning "Access Denied" upstream, so this uses the richer, live,
  geocoded restrictions feed instead.
- Rerouting is done by ranking Google's alternative routes; it does not
  fabricate roads. If every alternative crosses an event, it picks the one with
  the fewest.
