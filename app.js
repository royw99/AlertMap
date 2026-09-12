/* ==========================================================================
 * Toronto Event-Aware Router
 * - Pulls live road events from Toronto's CKAN Open Data "Road Restrictions"
 *   feed, draws them, and recommends the driving route that passes the fewest.
 * ======================================================================== */

const CFG = window.CONFIG;

// Event categories -> colour + label. Derived from the feed's `type` and
// `specialEvent` fields.
const CATEGORIES = {
  event:        { color: "#a855f7", label: "Special event" },
  closure:      { color: "#ef4444", label: "Road closed" },
  construction: { color: "#f59e0b", label: "Construction" },
  hazard:       { color: "#eab308", label: "Hazard" },
  other:        { color: "#64748b", label: "Other" },
};

let map, directionsService, placesReady = false;
let allEvents = [];                 // normalized events from CKAN
const markers = new Map();          // id -> google.maps.Marker
let infoWindow;
const activeFilters = new Set(Object.keys(CATEGORIES)); // categories shown
let activeOnly = false;

// Routing state
let originMarker = null, destMarker = null;
let origin = null, dest = null;
const routeRenderers = [];          // google.maps.Polyline route overlays
let pickMode = null;                // null | "origin" | "dest"

/* --------------------------------------------------------------------------
 * Entry point (called by the Maps SDK once it finishes loading)
 * ------------------------------------------------------------------------ */
window.initApp = async function initApp() {
  map = new google.maps.Map(document.getElementById("map"), {
    center: CFG.DEFAULT_CENTER,
    zoom: CFG.DEFAULT_ZOOM,
    mapTypeControl: false,
    streetViewControl: false,
    fullscreenControl: false,
    styles: DARK_MAP_STYLE,
  });
  infoWindow = new google.maps.InfoWindow();
  directionsService = new google.maps.DirectionsService();
  loadNeighborhoodBoundaries();

  const srcLink = document.getElementById("srcLink");
  if (srcLink && CFG.CKAN) srcLink.href = CFG.CKAN.portal;

  setupControls();
  setupPlaces();
  setupClickToSet();

  await loadEvents();
};

function loadNeighborhoodBoundaries() {
  // Google Data renders GeoJSON as a native map overlay. The guard keeps the
  // no-key projected demo working with the lightweight mock Maps SDK.
  if (!map.data || !CFG.NEIGHBORHOODS_GEOJSON) return;
  map.data.setStyle((feature) => ({
    fillColor: "#4d8dff",
    fillOpacity: 0.035,
    strokeColor: "#9dbbff",
    strokeOpacity: 0.48,
    strokeWeight: 1.2,
    zIndex: 1,
  }));
  map.data.addListener("mouseover", (event) => {
    map.data.overrideStyle(event.feature, {
      fillColor: "#4d8dff", fillOpacity: 0.12,
      strokeColor: "#d5e2ff", strokeOpacity: 0.9, strokeWeight: 2.2,
    });
  });
  map.data.addListener("mouseout", (event) => map.data.revertStyle(event.feature));
  map.data.addListener("click", (event) => {
    const name = event.feature.getProperty("hood") || "Pittsburgh neighborhood";
    infoWindow.setContent(`<div style="font:600 13px sans-serif;color:#17202e;padding:2px 4px">${escapeHtml(name)}</div>`);
    infoWindow.setPosition(event.latLng);
    infoWindow.open({ map });
  });
  map.data.loadGeoJson(CFG.NEIGHBORHOODS_GEOJSON);
}

/* --------------------------------------------------------------------------
 * Data: fetch + normalize the CKAN Road Restrictions feed
 * ------------------------------------------------------------------------ */
async function loadEvents() {
  setStatus('<span class="spin"></span> Loading live events from CKAN…');
  try {
    // If local fixtures are present, use them first. This keeps the demo
    // independent of stale config caches and unavailable network feeds.
    if (document.getElementById("demoRibbon") || window.SYNTHETIC_ROAD_EVENTS) {
      const rows = window.SYNTHETIC_ROAD_EVENTS || [];
      allEvents = rows.map(normalizeEvent).filter((e) => e && isFinite(e.lat) && isFinite(e.lng));
      renderMarkers();
      setStatus(allEvents.length + " synthetic Pittsburgh road events loaded · click two points or search to route.");
      return;
    }
    const res = await fetch(CFG.CKAN.feedUrl);
    if (!res.ok) throw new Error("HTTP " + res.status);
    let text = await res.text();
    // The city feed emits invalid JSON string escapes (a lone backslash).
    // Escape any backslash not part of a valid JSON escape sequence.
    text = text.replace(/\\(?!["\\/bfnrtu])/g, "\\\\");
    const data = JSON.parse(text);
    const rows = Array.isArray(data.Closure) ? data.Closure : [];
    allEvents = rows.map(normalizeEvent).filter((e) => e && isFinite(e.lat) && isFinite(e.lng));
    renderMarkers();
    setStatus(allEvents.length + " live road events loaded · click two points or search to route.");
  } catch (err) {
    console.error(err);
    setStatus("Could not load events from CKAN: " + err.message);
  }
}

function normalizeEvent(r) {
  const lat = parseFloat(r.latitude);
  const lng = parseFloat(r.longitude);
  let category = "other";
  if (String(r.specialEvent).toLowerCase() === "yes") category = "event";
  else if (r.type === "ROAD_CLOSED") category = "closure";
  else if (r.type === "CONSTRUCTION") category = "construction";
  else if (r.type === "HAZARD") category = "hazard";

  const start = toDate(r.startTime);
  const end = toDate(r.endTime);
  // The city rates current impact (None/Low/Medium/High); when there's no
  // current impact, fall back to the maximum expected impact.
  const severityLabel = (r.currImpact && r.currImpact !== "None") ? r.currImpact
                        : (r.maxImpact || "None");
  return {
    id: r.id || `${lat},${lng}`,
    lat, lng, category,
    road: r.road || r.name || "Road event",
    name: r.name || r.road || "",
    description: r.description || "",
    workPeriod: r.workPeriod || "",
    start, end,
    // Signals used by the danger model:
    type: r.type || "",
    roadClass: r.roadClass || "",
    bothDirections: r.directionsAffected === "BOTH_DIRECTIONS",
    severityLabel,                 // "High" | "Medium" | "Low" | "None"
    latLng: new google.maps.LatLng(lat, lng),
  };
}

/* --------------------------------------------------------------------------
 * Danger model — intrinsic risk of a single event (before proximity)
 * ------------------------------------------------------------------------ */
function roadClassMult(rc) {
  const t = CFG.DANGER.roadClass;
  if (/Expressway/i.test(rc)) return t.Expressway;
  if (/Major Arterial/i.test(rc)) return t["Major Arterial"];
  if (/Minor Arterial/i.test(rc)) return t["Minor Arterial"];
  return t.default;
}

// The individual multipliers behind an event's danger — one source of truth
// for both the score and the "why" breakdown shown on click.
function dangerFactors(e) {
  const D = CFG.DANGER;
  const active = isActiveNow(e);
  return [
    { k: "Severity",   v: D.severity[e.severityLabel] ?? 1, note: `${e.severityLabel} impact` },
    { k: "Type",       v: e.category === "event" ? D.specialEvent : (D.type[e.type] ?? 1),
      note: e.category === "event" ? "special event" : CATEGORIES[e.category].label.toLowerCase() },
    { k: "Direction",  v: e.bothDirections ? D.bothDirections : 1,
      note: e.bothDirections ? "both directions" : "one direction" },
    { k: "Road class", v: roadClassMult(e.roadClass), note: e.roadClass || "unknown" },
    { k: "Timing",     v: active ? 1 : D.inactiveMultiplier, note: active ? "active now" : "not active now" },
  ];
}

function eventDanger(e) {
  return dangerFactors(e).reduce((p, f) => p * f.v, 1);
}

// Coarse High/Medium/Low tier for one event, for chips + colouring.
function eventTier(e) {
  const d = eventDanger(e);
  if (d >= 8) return "High";
  if (d >= 3.5) return "Medium";
  return "Low";
}
const TIER_COLOR = { High: "#ef4444", Medium: "#f59e0b", Low: "#eab308" };

function toDate(ms) {
  const n = parseInt(ms, 10);
  return isFinite(n) && n > 0 ? new Date(n) : null;
}

function isActiveNow(e) {
  const now = Date.now();
  if (e.start && now < e.start.getTime()) return false;
  if (e.end && now > e.end.getTime()) return false;
  return true;
}

/* --------------------------------------------------------------------------
 * Markers + info windows
 * ------------------------------------------------------------------------ */
function markerIcon(color, scale = 5) {
  return {
    path: google.maps.SymbolPath.CIRCLE,
    fillColor: color,
    fillOpacity: 0.95,
    strokeColor: "#0b1017",
    strokeWeight: 1.2,
    scale,
  };
}

function renderMarkers() {
  for (const e of allEvents) {
    const m = new google.maps.Marker({
      position: e.latLng,
      map,
      icon: markerIcon(CATEGORIES[e.category].color),
      title: e.road,
      zIndex: 2,
    });
    m.addListener("click", () => openEventInfo(e, m));
    markers.set(e.id, m);
  }
  applyFilters();
}

function openEventInfo(e, marker) {
  const c = CATEGORIES[e.category];
  const when = fmtWindow(e);
  const tier = eventTier(e);
  const factors = dangerFactors(e);
  const total = eventDanger(e);

  // "Why this score" — each multiplier, with the ones that raise risk emphasised.
  const rows = factors.map((f) => {
    const raised = f.v > 1;
    return `<tr>
      <td style="padding:1px 8px 1px 0;color:#555">${f.k}</td>
      <td style="padding:1px 8px 1px 0;color:#888">${escapeHtml(f.note)}</td>
      <td style="text-align:right;font-variant-numeric:tabular-nums;font-weight:${raised ? 700 : 400};
                 color:${raised ? "#b45309" : "#999"}">×${(Math.round(f.v * 10) / 10)}</td>
    </tr>`;
  }).join("");

  infoWindow.setContent(`
    <div style="font-family:sans-serif;max-width:290px;color:#111">
      <div style="font-weight:700;margin-bottom:4px">${escapeHtml(e.road)}</div>
      <div style="display:flex;gap:6px;align-items:center;margin-bottom:6px">
        <span style="font-size:11px;font-weight:700;color:#fff;background:${c.color};padding:1px 7px;border-radius:999px">${c.label}</span>
        <span style="font-size:11px;font-weight:700;color:#0b1017;background:${TIER_COLOR[tier]};padding:1px 7px;border-radius:999px">${tier} risk · ${(Math.round(total * 10) / 10)}</span>
      </div>
      ${when ? `<div style="font-size:12px;color:#555;margin-bottom:4px">🕑 ${when}</div>` : ""}
      ${e.description ? `<div style="font-size:12px;color:#333;margin-bottom:8px">${escapeHtml(e.description).slice(0, 300)}</div>` : ""}
      <div style="font-size:11px;text-transform:uppercase;letter-spacing:.5px;color:#999;border-top:1px solid #eee;padding-top:6px;margin-bottom:3px">Why this score</div>
      <table style="font-size:12px;border-collapse:collapse;width:100%">${rows}
        <tr><td colspan="2" style="padding-top:4px;border-top:1px solid #eee;font-weight:700">Danger score</td>
            <td style="padding-top:4px;border-top:1px solid #eee;text-align:right;font-weight:700">${(Math.round(total * 10) / 10)}</td></tr>
      </table>
      <div style="font-size:11px;color:#999;margin-top:4px">On a route this is scaled by how close it sits to your path.</div>
    </div>`);
  infoWindow.open({ map, anchor: marker });
}

function fmtWindow(e) {
  const opt = { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" };
  if (e.start && e.end) return `${e.start.toLocaleDateString([], opt)} → ${e.end.toLocaleDateString([], opt)}`;
  if (e.start) return `from ${e.start.toLocaleDateString([], opt)}`;
  return "";
}

/* --------------------------------------------------------------------------
 * Filters
 * ------------------------------------------------------------------------ */
function applyFilters() {
  for (const e of allEvents) {
    const m = markers.get(e.id);
    if (!m) continue;
    const show = activeFilters.has(e.category) && (!activeOnly || isActiveNow(e));
    m.setMap(show ? map : null);
  }
}

/* --------------------------------------------------------------------------
 * Origin / destination input
 * ------------------------------------------------------------------------ */
function setupPlaces() {
  if (!google.maps.places) return;
  placesReady = true;
  const bias = new google.maps.LatLngBounds(
    { lat: 40.35, lng: -80.12 }, { lat: 40.52, lng: -79.82 } // Pittsburgh-ish
  );
  ["origin", "dest"].forEach((id) => {
    const ac = new google.maps.places.Autocomplete(document.getElementById(id), {
      bounds: bias, fields: ["geometry", "name", "formatted_address"],
    });
    ac.addListener("place_changed", () => {
      const p = ac.getPlace();
      if (!p.geometry) return;
      const loc = p.geometry.location;
      if (id === "origin") setPoint("origin", loc, p.formatted_address || p.name);
      else setPoint("dest", loc, p.formatted_address || p.name);
      map.panTo(loc);
    });
  });
}

function setupControls() {
  document.getElementById("routeBtn").addEventListener("click", computeRoute);
  document.getElementById("swapBtn").addEventListener("click", swap);
  document.getElementById("clearBtn").addEventListener("click", clearRoute);

  // Risk and busyness sliders re-score the existing default routes instantly.
  ["riskWeight", "busyWeight"].forEach((id) => {
    const input = document.getElementById(id);
    const label = document.getElementById(id === "riskWeight" ? "riskLabel" : "busyLabel");
    input.value = CFG.DANGER.defaultSafety;
    const update = () => {
      const v = +input.value;
      label.textContent = v <= 15 ? "Low" : v < 40 ? "Prefer low" : v <= 60 ? "Balanced" : v < 85 ? "Prefer high" : "Maximum";
      if (lastRoutes) scoreAndRender(lastRoutes, false);
    };
    update();
    input.addEventListener("input", update);
  });
  const pickBtn = document.getElementById("pickBtn");
  pickBtn.addEventListener("click", () => {
    pickMode = pickMode ? null : (origin ? "dest" : "origin");
    pickBtn.setAttribute("aria-pressed", pickMode ? "true" : "false");
    updatePickHint();
  });
}

function setupClickToSet() {
  map.addListener("click", (ev) => {
    if (!pickMode) return;
    setPoint(pickMode, ev.latLng, null);
    reverseGeocode(ev.latLng, pickMode);
    pickMode = pickMode === "origin" ? "dest" : null;
    document.getElementById("pickBtn").setAttribute("aria-pressed", pickMode ? "true" : "false");
    updatePickHint();
  });
}

function updatePickHint() {
  const hint = document.getElementById("pickHint");
  if (!pickMode) { hint.hidden = true; return; }
  hint.hidden = false;
  document.getElementById("pickWhat").textContent = pickMode === "origin" ? "start" : "destination";
}

let geocoder;
function reverseGeocode(latLng, which) {
  geocoder = geocoder || new google.maps.Geocoder();
  geocoder.geocode({ location: latLng }, (res, status) => {
    if (status === "OK" && res[0]) {
      document.getElementById(which === "origin" ? "origin" : "dest").value = res[0].formatted_address;
    }
  });
}

function setPoint(which, latLng, label) {
  if (which === "origin") {
    origin = latLng;
    if (label != null) document.getElementById("origin").value = label;
    originMarker && originMarker.setMap(null);
    originMarker = endpointMarker(latLng, "A", "#4d8dff");
  } else {
    dest = latLng;
    if (label != null) document.getElementById("dest").value = label;
    destMarker && destMarker.setMap(null);
    destMarker = endpointMarker(latLng, "B", "#22c55e");
  }

  // Once both endpoints exist, automatically ask Directions for alternatives.
  // This makes autocomplete and click-to-set feel like one continuous flow;
  // the Find route button remains available when the user wants to refresh.
  if (origin && dest) computeRoute();
}

function endpointMarker(latLng, letter, color) {
  return new google.maps.Marker({
    position: latLng, map, zIndex: 999,
    label: { text: letter, color: "#fff", fontWeight: "700" },
    icon: {
      path: "M12 2C7.6 2 4 5.6 4 10c0 5.4 8 12 8 12s8-6.6 8-12c0-4.4-3.6-8-8-8z",
      fillColor: color, fillOpacity: 1, strokeColor: "#0b1017", strokeWeight: 1.5,
      scale: 1.6, anchor: new google.maps.Point(12, 22), labelOrigin: new google.maps.Point(12, 10),
    },
  });
}

function swap() {
  const o = document.getElementById("origin"), d = document.getElementById("dest");
  [o.value, d.value] = [d.value, o.value];
  const to = origin, td = dest;
  origin = td; dest = to;
  originMarker && originMarker.setMap(null);
  destMarker && destMarker.setMap(null);
  originMarker = destMarker = null;
  if (origin) originMarker = endpointMarker(origin, "A", "#4d8dff");
  if (dest) destMarker = endpointMarker(dest, "B", "#22c55e");
  if (origin && dest) computeRoute();
}

function clearRoute() {
  origin = dest = null;
  document.getElementById("origin").value = "";
  document.getElementById("dest").value = "";
  originMarker && originMarker.setMap(null);
  destMarker && destMarker.setMap(null);
  originMarker = destMarker = null;
  clearRouteOverlays();
  lastRoutes = null;
  highlightEvents([]);
  document.getElementById("summary").style.display = "none";
}

/* --------------------------------------------------------------------------
 * Routing + event-aware scoring
 * ------------------------------------------------------------------------ */
function clearRouteOverlays() {
  routeRenderers.forEach((r) => r.setMap(null));
  routeRenderers.length = 0;
}

function computeRoute() {
  if (!origin || !dest) {
    setStatus("Set both a start and a destination first.");
    return;
  }
  setStatus('<span class="spin"></span> Finding routes and checking events…');
  directionsService.route(
    {
      origin, destination: dest,
      travelMode: google.maps.TravelMode.DRIVING,
      provideRouteAlternatives: true,
    },
    (result, status) => {
      if (status !== "OK") {
        setStatus("Directions request failed: " + status);
        return;
      }
      scoreAndRender(result.routes);
    }
  );
}

// Only consider events that are relevant right now for routing.
function routingEvents() {
  return allEvents.filter((e) => activeFilters.has(e.category) && (!activeOnly || isActiveNow(e)));
}

// Local equirectangular projection (metres) — accurate at city scale, and
// lets us measure true point-to-route distance for proximity weighting.
function projector(lat0) {
  const kx = Math.cos((lat0 * Math.PI) / 180) * 111320;
  const ky = 110540;
  return (ll) => ({ x: ll.lng() * kx, y: ll.lat() * ky });
}
function distToSegment(p, a, b) {
  const dx = b.x - a.x, dy = b.y - a.y;
  const l2 = dx * dx + dy * dy;
  let t = l2 ? ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2 : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

// Find events within the proximity threshold of a route, with the true
// distance (metres) and a proximity-weighted danger contribution for each.
function eventsOnRoute(route) {
  const path = route.overview_path;
  const b = route.bounds;
  const proj = projector(b.getCenter().lat());
  const pts = path.map(proj);
  const T = CFG.ROUTE_PROXIMITY_METRES;

  // Pad bounds so events just off the box are still considered.
  const padded = new google.maps.LatLngBounds(b.getSouthWest(), b.getNorthEast());
  padded.extend(new google.maps.LatLng(b.getSouthWest().lat() - 0.01, b.getSouthWest().lng() - 0.01));
  padded.extend(new google.maps.LatLng(b.getNorthEast().lat() + 0.01, b.getNorthEast().lng() + 0.01));

  const hits = [];
  for (const e of routingEvents()) {
    if (!padded.contains(e.latLng)) continue;
    const p = proj(e.latLng);
    let d = Infinity;
    for (let i = 1; i < pts.length; i++) {
      const dd = distToSegment(p, pts[i - 1], pts[i]);
      if (dd < d) d = dd;
      if (d <= 1) break;
    }
    if (d > T) continue;
    const proximity = Math.max(0, 1 - d / T);     // 1 on the path -> 0 at threshold
    hits.push({ event: e, dist: d, danger: eventDanger(e) * proximity });
  }
  return hits;
}

// Current safety preference (0 = fastest, 100 = safest) -> lambda.
function currentLambda() {
  const risk = document.getElementById("riskWeight");
  const busy = document.getElementById("busyWeight");
  return {
    risk: ((risk ? +risk.value : CFG.DANGER.defaultSafety) / 100) * CFG.DANGER.maxLambda,
    busy: ((busy ? +busy.value : CFG.DANGER.defaultSafety) / 100) * CFG.DANGER.maxLambda,
  };
}

// Temporary deterministic stand-in for the future risk/busyness API.
// It returns a stable 0..100 score from the route geometry, so moving the
// slider produces believable, repeatable recommendations without a backend.
function mockRouteRisk(route) {
  const path = route.overview_path || [];
  if (!path.length) return 0;
  let signal = 0;
  path.forEach((p, i) => {
    const lat = typeof p.lat === "function" ? p.lat() : p.lat;
    const lng = typeof p.lng === "function" ? p.lng() : p.lng;
    signal += Math.abs(Math.sin(lat * 19.7 + lng * 11.3 + i * 0.73));
  });
  return Math.round((signal / path.length) * 100);
}

let lastRoutes = null; // cache so the slider can re-score without a new request

function scoreAndRender(routes, fit = true) {
  lastRoutes = routes;
  clearRouteOverlays();
  const lambda = currentLambda();

  const scored = routes.map((route, i) => {
    const hits = eventsOnRoute(route);
    const leg = route.legs[0];
    const durationSec = leg.duration ? leg.duration.value : Infinity;
    const dangerScore = hits.reduce((s, h) => s + h.danger, 0);
    const busyness = mockRouteRisk(route);
    const combinedRisk = dangerScore + busyness * CFG.DANGER.mockBusynessWeight;
    return {
      route, index: i, hits,
      count: hits.length,
      dangerScore,
      busyness,
      combinedRisk,
      durationSec,
      durationMin: durationSec / 60,
      durationText: leg.duration ? leg.duration.text : "",
      distanceText: leg.distance ? leg.distance.text : "",
      // Single blended cost: minutes + weighted danger.
      cost: durationSec / 60 + lambda.risk * dangerScore + lambda.busy * busyness * CFG.DANGER.mockBusynessWeight,
    };
  });

  // Fastest = Google's first route. Recommended = lowest blended cost.
  const fastest = scored.reduce((a, b) => (b.durationSec < a.durationSec ? b : a), scored[0]);
  const recommended = scored.slice().sort((a, b) => a.cost - b.cost || a.durationSec - b.durationSec)[0];

  // Draw non-recommended routes dimmed, recommended on top highlighted.
  scored.forEach((s) => {
    if (s === recommended) return;
    routeRenderers.push(new google.maps.Polyline({
      path: s.route.overview_path, map,
      strokeColor: "#7f8ea3", strokeOpacity: 0.55, strokeWeight: 5, zIndex: 3,
    }));
  });
  routeRenderers.push(new google.maps.Polyline({
    path: recommended.route.overview_path, map,
    strokeColor: "#22c55e", strokeOpacity: 0.95, strokeWeight: 7, zIndex: 4,
  }));

  // Fit map to the recommended route (only on a fresh route request).
  if (fit) map.fitBounds(recommended.route.bounds, 60);

  // Highlight the events sitting on the recommended route.
  highlightEvents(recommended.hits);

  renderSummary(fastest, recommended, scored);

  if (recommended === fastest) {
    setStatus(`Fastest route is also the safest (danger ${fmtScore(recommended.dangerScore)}).`);
  } else {
    const extraMin = Math.max(0, recommended.durationMin - fastest.durationMin);
    const cut = Math.round((1 - recommended.dangerScore / (fastest.dangerScore || 1)) * 100);
    setStatus(
      `Recommended route cuts danger ${cut}% (${fmtScore(fastest.dangerScore)} → ${fmtScore(recommended.dangerScore)})` +
      (extraMin >= 1 ? ` for +${Math.round(extraMin)} min.` : " at no time cost.")
    );
  }
}

let highlighted = [];
function highlightEvents(hits) {
  // reset previous highlights
  highlighted.forEach((e) => {
    const m = markers.get(e.id);
    if (m) m.setIcon(markerIcon(CATEGORIES[e.category].color));
  });
  highlighted = hits.map((h) => h.event);
  // Size the highlight by the event's danger tier so worse ones stand out.
  hits.forEach((h) => {
    const m = markers.get(h.event.id);
    if (!m) return;
    const tier = eventTier(h.event);
    m.setMap(map);
    m.setIcon(markerIcon(TIER_COLOR[tier], tier === "High" ? 8.5 : tier === "Medium" ? 7 : 5.5));
    m.setZIndex(50);
  });
}

function fmtScore(n) { return (Math.round(n * 10) / 10).toFixed(1); }

function routeTier(score) {
  const t = CFG.DANGER.tiers;
  return score >= t.high ? "High" : score >= t.medium ? "Medium" : "Low";
}

function renderSummary(fastest, recommended, scored) {
  const wrap = document.getElementById("summary");
  wrap.style.display = "block";
  const cards = document.getElementById("routeCards");
  cards.innerHTML = "";

  const card = (s, isRec) => {
    const tier = routeTier(s.dangerScore);
    return `
    <div class="route-card ${isRec ? "recommended" : ""}">
      <h3>
        <span class="swatch" style="background:${isRec ? "#22c55e" : "#7f8ea3"}"></span>
        ${isRec ? "Recommended" : "Fastest route"}
        ${isRec && recommended !== fastest ? '<span class="badge">safer</span>' : ""}
      </h3>
      <div class="metrics">
        <span><b>${s.durationText || "—"}</b></span>
        <span><b>${s.distanceText || "—"}</b></span>
        <span><b>${s.count}</b> event${s.count === 1 ? "" : "s"}</span>
        <span><b>${s.busyness}%</b> busy</span>
      </div>
      <div class="danger-row">
        <span class="danger-tag" style="background:${TIER_COLOR[tier] || "#64748b"}">${tier} risk</span>
        <div class="danger-bar"><div style="width:${Math.min(100, (s.dangerScore / (CFG.DANGER.tiers.high * 1.5)) * 100)}%"></div></div>
        <span class="danger-num">${fmtScore(s.dangerScore)}</span>
      </div>
    </div>`;
  };

  // Show fastest first, then recommended (unless identical).
  cards.insertAdjacentHTML("beforeend", card(fastest, fastest === recommended));
  if (recommended !== fastest) cards.insertAdjacentHTML("beforeend", card(recommended, true));
}

/* --------------------------------------------------------------------------
 * Helpers
 * ------------------------------------------------------------------------ */
function setStatus(html) { document.getElementById("status").innerHTML = html; }

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

/* Muted dark map style */
const DARK_MAP_STYLE = [
  { elementType: "geometry", stylers: [{ color: "#1b2635" }] },
  { elementType: "labels.text.stroke", stylers: [{ color: "#0f1622" }] },
  { elementType: "labels.text.fill", stylers: [{ color: "#8aa0bd" }] },
  { featureType: "poi", stylers: [{ visibility: "off" }] },
  { featureType: "transit", stylers: [{ visibility: "off" }] },
  { featureType: "road", elementType: "geometry", stylers: [{ color: "#2a3648" }] },
  { featureType: "road.arterial", elementType: "geometry", stylers: [{ color: "#33465e" }] },
  { featureType: "road.highway", elementType: "geometry", stylers: [{ color: "#3d5372" }] },
  { featureType: "road", elementType: "labels.text.fill", stylers: [{ color: "#9fb2cc" }] },
  { featureType: "water", elementType: "geometry", stylers: [{ color: "#0e1826" }] },
  { featureType: "landscape", elementType: "geometry", stylers: [{ color: "#1b2635" }] },
];
