/* ==========================================================================
 * Pittsburgh Event-Aware Router
 * - Pulls live road events from Toronto's CKAN Open Data "Road Restrictions"
 *   feed, draws them, and recommends the walking route that passes the fewest.
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

// Community incident reports -> colour by severity, stored server-side
// (see server.py) so a report from one device shows up on every device
// polling GET /api/reports.
const REPORT_CATEGORIES = {
  burglary:    { color: "#ef4444", label: "Burglary" },
  assault:     { color: "#f97316", label: "Assault" },
  disturbance: { color: "#eab308", label: "Disturbance" },
};
const REPORTS_API = "/api/reports";
const REPORT_POLL_MS = 5000;

let map, directionsService;
let allEvents = [];                 // normalized events from CKAN
const markers = new Map();          // id -> google.maps.Marker
let allReports = [];                // community incident reports from the server
const reportMarkers = new Map();    // report id -> google.maps.Marker
let selectedReportCategory = null;
const neighborhoodRisk = new Map(); // normalized boundary name -> 0..100 risk
let infoWindow;
const activeFilters = new Set(Object.keys(CATEGORIES)); // categories shown
let activeOnly = false;

// Routing state
let originMarker = null, destMarker = null;
let origin = null, dest = null;
const routeRenderers = [];          // google.maps.Polyline route overlays

// Live navigation state
let recommendedRoute = null;        // the currently recommended scored route
let userLocationMarker = null;
let navigating = false;

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
  setupReportForm();

  await loadEvents();
  await loadReports();
  setInterval(loadReports, REPORT_POLL_MS);
};

function loadNeighborhoodBoundaries() {
  // Google Data renders GeoJSON as a native map overlay. The guard keeps the
  // no-key projected demo working with the lightweight mock Maps SDK.
  if (!map.data || !CFG.NEIGHBORHOODS_GEOJSON) return;
  const style = (feature) => {
    const risk = neighborhoodRisk.get(normalizeNeighborhoodName(feature.getProperty("hood")));
    return {
    fillColor: riskColor(risk),
    fillOpacity: risk == null ? 0.035 : 0.18,
    strokeColor: "#9dbbff",
    strokeOpacity: 0.48,
    strokeWeight: 1.2,
    zIndex: 1,
    };
  };
  map.data.setStyle(style);
  map.data.addListener("mouseover", (event) => {
    map.data.overrideStyle(event.feature, {
      strokeColor: "#d5e2ff", strokeOpacity: 0.9, strokeWeight: 2.2,
    });
  });
  map.data.addListener("mouseout", (event) => map.data.revertStyle(event.feature));
  map.data.addListener("click", (event) => {
    const name = event.feature.getProperty("hood") || "Pittsburgh neighborhood";
    const risk = neighborhoodRisk.get(normalizeNeighborhoodName(name));
    const riskText = risk == null ? "No incident data" : `${risk.toFixed(1)} / 100 · ${riskCategory(risk)}`;
    infoWindow.setContent(`<div style="font:600 13px sans-serif;color:#17202e;padding:2px 4px"><div>${escapeHtml(name)}</div><div style="font-weight:400;margin-top:3px">${riskText}</div></div>`);
    infoWindow.setPosition(event.latLng);
    infoWindow.open({ map });
  });
  // Keep the raw polygons too (beyond what map.data exposes for hit-testing)
  // so routing can measure how much of a route sits inside each boundary.
  map.data.loadGeoJson(CFG.NEIGHBORHOODS_GEOJSON, null, (features) => {
    neighborhoodIndex = buildNeighborhoodIndex(features);
    rescoreIfReady();
  });
  loadNeighborhoodRisk();
}

// The two data sources spell a couple of neighborhoods differently — the
// boundary layer's `hood` field uses the city's official short form, the
// police data's `INCIDENTNEIGHBORHOOD` a longer variant. Canonicalize the
// known cases after stripping punctuation/case so both sides land on the
// same key.
const NEIGHBORHOOD_NAME_ALIASES = {
  "mount oliver": "mt oliver",
  "central north side": "central northside",
};
function normalizeNeighborhoodName(name) {
  const key = String(name || "").toLowerCase().replace(/[.’']/g, "").replace(/[^a-z0-9]+/g, " ").trim().replace(/\s+/g, " ");
  return NEIGHBORHOOD_NAME_ALIASES[key] || key;
}

// Same 0-100 buckets as risk_category() in query.py, so the map and the
// data pipeline agree on what "High Risk" means.
function riskCategory(score) {
  if (score < 12) return "Safe";
  if (score < 25) return "Low Risk";
  if (score < 45) return "Moderate Risk";
  if (score < 75) return "High Risk";
  return "Very High Risk";
}
const RISK_CATEGORY_COLOR = {
  "Safe": "#22c55e",
  "Low Risk": "#fff23f",
  "Moderate Risk": "#d48a08",
  "High Risk": "#ef4444",
  "Very High Risk": "#8b0a0a",
};
function riskColor(score) {
  if (score == null) return "#4d8dff";
  return RISK_CATEGORY_COLOR[riskCategory(score)];
}

async function loadNeighborhoodRisk() {
  if (!CFG.NEIGHBORHOOD_RISK_API || !map.data) return;
  try {
    const res = await fetch(CFG.NEIGHBORHOOD_RISK_API);
    if (!res.ok) throw new Error("HTTP " + res.status);
    const rows = (await res.json()).result.records || [];
    const totals = new Map();
    rows.forEach((r) => {
      const name = normalizeNeighborhoodName(r.INCIDENTNEIGHBORHOOD);
      const h = Number(r.HIERARCHY);
      if (!name || !Number.isFinite(h) || h <= 0) return;
      totals.set(name, (totals.get(name) || 0) + 1 / h);
    });
    const values = [...totals.values()];
    const min = Math.min(...values), max = Math.max(...values);
    totals.forEach((value, name) => neighborhoodRisk.set(name, max > min ? ((value - min) / (max - min)) * 100 : 0));
    map.data.setStyle((feature) => {
      const risk = neighborhoodRisk.get(normalizeNeighborhoodName(feature.getProperty("hood")));
      return { fillColor: riskColor(risk), fillOpacity: risk == null ? 0.035 : 0.18, strokeColor: "#9dbbff", strokeOpacity: 0.48, strokeWeight: 1.2, zIndex: 1 };
    });
    rescoreIfReady();
  } catch (err) {
    console.warn("Neighborhood risk data unavailable:", err);
  }
}

/* --------------------------------------------------------------------------
 * Neighborhood danger for routing — average crime-risk of the neighborhoods
 * a route actually passes through, built from the same boundaries + risk
 * data that drive the map overlay above.
 * ------------------------------------------------------------------------ */
let neighborhoodIndex = null; // [{ name, key, polygons, bbox }] once boundaries load

// A google.maps.Data.Geometry is a tree of Polygon / MultiPolygon / GeometryCollection
// nodes; flatten it into plain [lng,lat] ring arrays we can ray-cast against.
function geometryToPolygons(geometry) {
  const type = geometry.getType();
  if (type === "Polygon") {
    return [geometry.getArray().map((ring) => ring.getArray().map((ll) => [ll.lng(), ll.lat()]))];
  }
  if (type === "MultiPolygon" || type === "GeometryCollection") {
    return geometry.getArray().flatMap(geometryToPolygons);
  }
  return [];
}

function buildNeighborhoodIndex(features) {
  return features.map((feature) => {
    const name = feature.getProperty("hood") || "";
    const polygons = geometryToPolygons(feature.getGeometry());
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    polygons.forEach((rings) => rings[0].forEach(([x, y]) => {
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
    }));
    return { name, key: normalizeNeighborhoodName(name), polygons, bbox: [minX, minY, maxX, maxY] };
  }).filter((nb) => nb.polygons.length);
}

// Ray-casting point-in-polygon, with a bbox pre-check per feature so a lookup
// only walks the vertices of neighborhoods that could actually contain it.
function pointInRing(pt, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0], yi = ring[i][1];
    const xj = ring[j][0], yj = ring[j][1];
    const intersect = (yi > pt[1]) !== (yj > pt[1]) &&
      pt[0] < ((xj - xi) * (pt[1] - yi)) / (yj - yi) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}
function pointInPolygon(pt, rings) {
  if (!pointInRing(pt, rings[0])) return false;
  for (let k = 1; k < rings.length; k++) if (pointInRing(pt, rings[k])) return false; // inside a hole
  return true;
}
function neighborhoodAt(lat, lng) {
  if (!neighborhoodIndex) return null;
  const pt = [lng, lat];
  for (const nb of neighborhoodIndex) {
    if (lng < nb.bbox[0] || lng > nb.bbox[2] || lat < nb.bbox[1] || lat > nb.bbox[3]) continue;
    if (nb.polygons.some((rings) => pointInPolygon(pt, rings))) {
      const risk = neighborhoodRisk.get(nb.key);
      return { name: nb.name, risk: risk == null ? null : risk };
    }
  }
  return null;
}

function haversineMetres(a, b) {
  const R = 6371000, rad = (d) => (d * Math.PI) / 180;
  const dLat = rad(b.lat() - a.lat()), dLng = rad(b.lng() - a.lng());
  const s = Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(a.lat())) * Math.cos(rad(b.lat())) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

// Walk the route geometry and weight each neighborhood's risk score by how
// much of the route (in metres) actually sits inside it. Segments outside
// every known boundary, or inside one whose risk hasn't loaded yet, are
// skipped rather than counted as either safe or dangerous.
function routeNeighborhoodProfile(route) {
  const path = route.overview_path || [];
  const byName = new Map();
  let coveredMetres = 0, weightedRisk = 0;

  for (let i = 1; i < path.length; i++) {
    const a = path[i - 1], b = path[i];
    const segMetres = haversineMetres(a, b);
    if (segMetres <= 0) continue;
    const nb = neighborhoodAt((a.lat() + b.lat()) / 2, (a.lng() + b.lng()) / 2);
    if (!nb || nb.risk == null) continue;
    coveredMetres += segMetres;
    weightedRisk += nb.risk * segMetres;
    const cur = byName.get(nb.name) || { name: nb.name, risk: nb.risk, metres: 0 };
    cur.metres += segMetres;
    byName.set(nb.name, cur);
  }

  const avgRisk = coveredMetres > 0 ? weightedRisk / coveredMetres : 0;
  const breakdown = [...byName.values()].sort((x, y) => y.metres - x.metres);
  return { avgRisk, coveredMetres, breakdown };
}

// Safety slider (0 = ignore risk, 100 = avoid risk) doubles as the max
// average neighborhood-risk score the user will tolerate on a route.
function neighborhoodThreshold() {
  const risk = document.getElementById("riskWeight");
  const v = risk ? +risk.value : CFG.DANGER.defaultSafety;
  return 100 - v;
}

// Boundaries and risk numbers load asynchronously and independently; once
// both are in, refresh whatever route is already on screen so it picks up
// neighborhood-aware scoring without the user needing to re-search.
function rescoreIfReady() {
  if (neighborhoodIndex && neighborhoodRisk.size && lastRoutes) scoreAndRender(lastRoutes, false);
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
 * Community incident reports — fetched from / posted to server.py's SQLite-
 * backed API so every device sees every report.
 * ------------------------------------------------------------------------ */
async function loadReports() {
  try {
    const res = await fetch(REPORTS_API);
    if (!res.ok) throw new Error("HTTP " + res.status);
    allReports = await res.json();
    renderReportMarkers();
  } catch (err) {
    console.warn("Could not load community reports:", err);
  }
}

function reportMarkerIcon(color) {
  return {
    path: google.maps.SymbolPath.CIRCLE,
    fillColor: color,
    fillOpacity: 0.95,
    strokeColor: "#fff",
    strokeWeight: 2,
    scale: 8,
  };
}

function renderReportMarkers() {
  const seen = new Set();
  for (const r of allReports) {
    seen.add(r.id);
    if (reportMarkers.has(r.id)) continue;
    const cat = REPORT_CATEGORIES[r.category];
    if (!cat) continue;
    const m = new google.maps.Marker({
      position: new google.maps.LatLng(r.lat, r.lng),
      map,
      icon: reportMarkerIcon(cat.color),
      title: cat.label,
      zIndex: 10,
    });
    m.addListener("click", () => openReportInfo(r, m));
    reportMarkers.set(r.id, m);
  }
  for (const [id, m] of reportMarkers) {
    if (!seen.has(id)) { m.setMap(null); reportMarkers.delete(id); }
  }
}

function openReportInfo(r, marker) {
  const cat = REPORT_CATEGORIES[r.category];
  const when = fmtReportTime(r.created_at);
  infoWindow.setContent(`
    <div style="font-family:sans-serif;max-width:270px;color:#111">
      <div style="display:flex;gap:6px;align-items:center;margin-bottom:6px">
        <span style="font-size:11px;font-weight:700;color:#fff;background:${cat.color};padding:1px 7px;border-radius:999px">${cat.label}</span>
        <span style="font-size:11px;color:#888">${when}</span>
      </div>
      <div style="font-size:13px;color:#222">${escapeHtml(r.description)}</div>
      <div style="font-size:10px;color:#aaa;margin-top:6px">Reported by a nearby user</div>
    </div>`);
  infoWindow.open({ map, anchor: marker });
}

function fmtReportTime(iso) {
  const d = new Date(iso);
  if (isNaN(d)) return "";
  return d.toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

function setupReportForm() {
  const btn = document.getElementById("reportBtn");
  const form = document.getElementById("reportForm");
  const catBtns = [...document.querySelectorAll(".report-cat-btn")];
  const desc = document.getElementById("reportDesc");
  const submitBtn = document.getElementById("reportSubmitBtn");
  const cancelBtn = document.getElementById("reportCancelBtn");
  const hint = document.getElementById("reportHint");

  const updateSubmitState = () => {
    submitBtn.disabled = !selectedReportCategory || !desc.value.trim();
  };

  const resetReportForm = () => {
    selectedReportCategory = null;
    catBtns.forEach((x) => x.classList.remove("selected"));
    desc.value = "";
    updateSubmitState();
    hint.textContent = "Uses your current location.";
  };

  btn.addEventListener("click", () => {
    form.style.display = form.style.display === "none" ? "block" : "none";
  });

  catBtns.forEach((b) => b.addEventListener("click", () => {
    selectedReportCategory = b.dataset.cat;
    catBtns.forEach((x) => x.classList.toggle("selected", x === b));
    updateSubmitState();
  }));

  desc.addEventListener("input", updateSubmitState);

  cancelBtn.addEventListener("click", () => {
    form.style.display = "none";
    resetReportForm();
  });

  submitBtn.addEventListener("click", () => {
    if (!navigator.geolocation) {
      hint.textContent = "Geolocation isn't available in this browser.";
      return;
    }
    submitBtn.disabled = true;
    hint.textContent = "Getting your location…";
    const onceHere = (pos, err) => {
      geoListeners.delete(onceHere);
      if (err) {
        hint.textContent = "Couldn't get your location: " + err.message;
        updateSubmitState();
        return;
      }
      postReport(pos.coords.latitude, pos.coords.longitude);
    };
    watchLocation(onceHere);
  });

  async function postReport(lat, lng) {
    hint.textContent = "Submitting…";
    try {
      const res = await fetch(REPORTS_API, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ lat, lng, category: selectedReportCategory, description: desc.value.trim() }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || ("HTTP " + res.status));
      allReports.unshift(body);
      renderReportMarkers();
      map.panTo(new google.maps.LatLng(lat, lng));
      form.style.display = "none";
      resetReportForm();
      setStatus("Report submitted — thanks.");
    } catch (err) {
      hint.textContent = "Couldn't submit: " + err.message;
      updateSubmitState();
    }
  }
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
  // The risk slider re-scores the existing default routes instantly.
  {
    const input = document.getElementById("riskWeight");
    const label = document.getElementById("riskLabel");
    input.value = CFG.DANGER.defaultSafety;
    const update = () => {
      const v = +input.value;
      label.textContent = ["Safe", "Low Risk", "Moderate Risk", "High Risk", "Very High Risk"][Math.round(v / 25)];
      if (lastRoutes) scoreAndRender(lastRoutes, false);
    };
    update();
    input.addEventListener("input", update);
  }

  document.getElementById("locateBtn").addEventListener("click", locateMe);
  document.getElementById("navEndBtn").addEventListener("click", stopNavigation);
  document.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" || event.isComposing || navigating || !recommendedRoute) return;
    if (event.target.matches("textarea, button, input[type=range]")) return;
    event.preventDefault();
    startNavigation();
  });
  setupExport();
}

function setupExport() {
  const dialog = document.getElementById("exportDialog");
  const open = () => {
    if (!recommendedRoute) {
      setStatus("Find a route before exporting.");
      return;
    }
    dialog.classList.add("open");
    document.getElementById("exportConfirmBtn").focus();
  };
  const close = () => dialog.classList.remove("open");
  document.getElementById("exportBtn").addEventListener("click", open);
  document.getElementById("exportCancelBtn").addEventListener("click", close);
  document.getElementById("exportConfirmBtn").addEventListener("click", async () => {
    close();
    await exportRoutePng();
  });
  dialog.addEventListener("click", (event) => {
    if (event.target === dialog) close();
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && dialog.classList.contains("open")) close();
  });
}

async function exportRoutePng() {
  const button = document.getElementById("exportBtn");
  button.disabled = true;
  setStatus('<span class="spin"></span> Preparing your route PNG…');
  try {
    const blob = document.getElementById("demoRibbon")
      ? await demoMapPng()
      : await staticMapPng();
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = "alertmap-route.png";
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
    setStatus("Route PNG downloaded.");
  } catch (err) {
    console.error("Could not export route:", err);
    setStatus("Could not export route: " + err.message);
  } finally {
    button.disabled = false;
  }
}

function staticMapPng() {
  const path = recommendedRoute.route.overview_path.map((point) => `${point.lat()},${point.lng()}`).join("|");
  const params = new URLSearchParams({
    size: "640x400", scale: "2", maptype: "roadmap", key: CFG.GOOGLE_MAPS_API_KEY,
    path: `color:0x22c55eff|weight:7|${path}`,
  });
  params.append("markers", `color:blue|label:A|${origin.lat()},${origin.lng()}`);
  params.append("markers", `color:green|label:B|${dest.lat()},${dest.lng()}`);
  const url = "https://maps.googleapis.com/maps/api/staticmap?" + params;
  return fetch(url).then((res) => {
    if (!res.ok) throw new Error("Static Maps returned HTTP " + res.status);
    return res.blob();
  });
}

function demoMapPng() {
  const svg = map && map.svg;
  if (!svg) return Promise.reject(new Error("Map is not ready"));
  const width = map.div.clientWidth || 800;
  const height = map.div.clientHeight || 600;
  const source = new XMLSerializer().serializeToString(svg);
  const image = new Image();
  const canvas = document.createElement("canvas");
  canvas.width = width * 2;
  canvas.height = height * 2;
  return new Promise((resolve, reject) => {
    image.onload = () => {
      const ctx = canvas.getContext("2d");
      ctx.fillStyle = "#0d1420";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
      canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error("PNG encoding failed")), "image/png");
    };
    image.onerror = () => reject(new Error("Could not render the demo map"));
    image.src = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(source);
  });
}

/* --------------------------------------------------------------------------
 * Current location + live navigation (Apple Maps-style "Start")
 *
 * A single navigator.geolocation.watchPosition() subscription is shared by
 * both "use current location" and "Start" navigation, opened lazily on
 * first use and left running for the rest of the session. Browsers only
 * show the permission prompt once per subscription, so calling
 * getCurrentPosition/watchPosition separately for each feature was asking
 * twice — this keeps it to a single ask.
 * ------------------------------------------------------------------------ */
let geoWatchId = null;
let lastKnownPosition = null;
let lastGeoError = null;
const geoListeners = new Set(); // (pos, err) => void

function ensureLocationWatch() {
  if (geoWatchId != null || !navigator.geolocation) return;
  geoWatchId = navigator.geolocation.watchPosition(
    (pos) => {
      lastKnownPosition = pos;
      lastGeoError = null;
      geoListeners.forEach((cb) => cb(pos, null));
    },
    (err) => {
      lastGeoError = err;
      geoListeners.forEach((cb) => cb(null, err));
    },
    { enableHighAccuracy: true, maximumAge: 2000, timeout: 15000 }
  );
}

// Subscribe `cb` to the shared watch and immediately replay the last known
// fix/error if we already have one, so callers don't wait on a new update.
function watchLocation(cb) {
  geoListeners.add(cb);
  ensureLocationWatch();
  if (lastKnownPosition) cb(lastKnownPosition, null);
  else if (lastGeoError) cb(null, lastGeoError);
}

function locateMe() {
  if (!navigator.geolocation) {
    setStatus("Geolocation isn't available in this browser.");
    return;
  }
  const btn = document.getElementById("locateBtn");
  btn.setAttribute("aria-busy", "true");
  setStatus('<span class="spin"></span> Finding your location…');

  const onceHere = (pos, err) => {
    geoListeners.delete(onceHere);
    btn.removeAttribute("aria-busy");
    if (err) {
      setStatus("Couldn't get your location: " + err.message);
      return;
    }
    const latLng = new google.maps.LatLng(pos.coords.latitude, pos.coords.longitude);
    setPoint("origin", latLng, "My Location");
    map.panTo(latLng);
    if (map.setZoom) map.setZoom(16);
    setStatus("Using your current location as the start.");
  };
  watchLocation(onceHere);
}

function startNavigation() {
  if (!recommendedRoute) {
    setStatus("Find a route before starting.");
    return;
  }
  if (!navigator.geolocation) {
    setStatus("Geolocation isn't available in this browser.");
    return;
  }
  navigating = true;
  lastRerouteLatLng = null;
  lastRerouteTime = 0;
  document.getElementById("navBar").style.display = "flex";
  watchLocation(onNavPosition);
}

function stopNavigation() {
  navigating = false;
  geoListeners.delete(onNavPosition);
  document.getElementById("navBar").style.display = "none";
}

function onNavPosition(pos, err) {
  if (err) {
    setStatus("Navigation location error: " + err.message);
    return;
  }
  const latLng = new google.maps.LatLng(pos.coords.latitude, pos.coords.longitude);
  placeUserLocationMarker(latLng);
  map.panTo(latLng);
  if (map.setZoom) map.setZoom(17);
  updateNavBanner(latLng);
  maybeRerouteFromPosition(latLng);
}

// Re-request Directions from wherever the user actually is so the drawn
// route keeps matching the road ahead instead of the path from the original
// search point. Throttled by distance/time so normal GPS jitter while
// walking doesn't fire an API call on every tick.
let lastRerouteLatLng = null;
let lastRerouteTime = 0;
const REROUTE_MIN_METRES = 20;
const REROUTE_MIN_MS = 8000;

function maybeRerouteFromPosition(latLng) {
  if (!navigating || !dest) return;
  const now = Date.now();
  if (lastRerouteLatLng) {
    const moved = haversineMetres(lastRerouteLatLng, latLng);
    if (moved < REROUTE_MIN_METRES && now - lastRerouteTime < REROUTE_MIN_MS) return;
  }
  lastRerouteLatLng = latLng;
  lastRerouteTime = now;
  directionsService.route(
    {
      origin: latLng, destination: dest,
      travelMode: google.maps.TravelMode.WALKING,
      provideRouteAlternatives: true,
    },
    (result, status) => {
      // Navigation may have been stopped (or arrival triggered) while this
      // request was in flight — don't resurrect the route display if so.
      if (status !== "OK" || !navigating) return;
      scoreAndRender(result.routes, false);
    }
  );
}

function placeUserLocationMarker(latLng) {
  if (!userLocationMarker) {
    userLocationMarker = new google.maps.Marker({
      position: latLng, map, zIndex: 1000,
      icon: {
        path: google.maps.SymbolPath.CIRCLE,
        fillColor: "#4d8dff", fillOpacity: 1,
        strokeColor: "#fff", strokeWeight: 3, scale: 8,
      },
    });
  } else if (userLocationMarker.setPosition) {
    userLocationMarker.setPosition(latLng);
  } else {
    userLocationMarker.position = latLng;
    userLocationMarker.map && userLocationMarker.map.scheduleRender && userLocationMarker.map.scheduleRender();
  }
}

// Distance remaining along the route's own path, not straight-line, so it
// reflects the road/sidewalk distance still ahead rather than as-the-crow-flies.
function remainingRouteDistance(route, latLng) {
  const path = route.overview_path;
  if (!path || !path.length) return null;
  const proj = projector(latLng.lat());
  const p = proj(latLng);
  let bestIdx = 0, bestDist = Infinity;
  for (let i = 1; i < path.length; i++) {
    const d = distToSegment(p, proj(path[i - 1]), proj(path[i]));
    if (d < bestDist) { bestDist = d; bestIdx = i; }
  }
  let remaining = haversineMetres(latLng, path[bestIdx]);
  for (let i = bestIdx; i < path.length - 1; i++) remaining += haversineMetres(path[i], path[i + 1]);
  return remaining;
}

function updateNavBanner(latLng) {
  const route = recommendedRoute.route;
  const distM = remainingRouteDistance(route, latLng);
  const distEl = document.getElementById("navDist");
  const etaEl = document.getElementById("navEta");

  if (distM != null && distM < 20) {
    distEl.textContent = "You've arrived";
    etaEl.textContent = "";
    stopNavigation();
    return;
  }

  distEl.textContent = distM == null ? "—"
    : (distM >= 1000 ? (distM / 1000).toFixed(1) + " km" : Math.round(distM) + " m") + " to destination";

  const leg = route.legs[0];
  const totalDist = leg.distance ? leg.distance.value : null;
  const totalDur = leg.duration ? leg.duration.value : null;
  if (distM != null && totalDist && totalDur) {
    const paceSecPerMetre = totalDur / totalDist;
    const eta = new Date(Date.now() + distM * paceSecPerMetre * 1000);
    etaEl.textContent = "ETA " + eta.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  } else {
    etaEl.textContent = "";
  }
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
      travelMode: google.maps.TravelMode.WALKING,
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
  return ((risk ? +risk.value : CFG.DANGER.defaultSafety) / 100) * CFG.DANGER.maxLambda;
}

let lastRoutes = null; // cache so the slider can re-score without a new request

function scoreAndRender(routes, fit = true) {
  lastRoutes = routes;
  clearRouteOverlays();
  const lambda = currentLambda();
  const threshold = neighborhoodThreshold();

  const scored = routes.map((route, i) => {
    const hits = eventsOnRoute(route);
    const leg = route.legs[0];
    const durationSec = leg.duration ? leg.duration.value : Infinity;
    const dangerScore = hits.reduce((s, h) => s + h.danger, 0);
    const neighborhood = routeNeighborhoodProfile(route);
    return {
      route, index: i, hits,
      count: hits.length,
      dangerScore,
      neighborhoodRisk: neighborhood.avgRisk,
      neighborhoodBreakdown: neighborhood.breakdown,
      meetsSafetyThreshold: neighborhood.coveredMetres === 0 || neighborhood.avgRisk <= threshold,
      durationSec,
      durationMin: durationSec / 60,
      durationText: leg.duration ? leg.duration.text : "",
      distanceText: leg.distance ? leg.distance.text : "",
      // Single blended cost: minutes + weighted danger (road events + the
      // crime-risk of the neighborhoods actually traversed).
      cost: durationSec / 60
        + lambda * dangerScore
        + lambda * neighborhood.avgRisk * CFG.DANGER.neighborhoodWeight,
    };
  });

  // Fastest = Google's first route. Best-cost = lowest blended cost.
  const fastest = scored.reduce((a, b) => (b.durationSec < a.durationSec ? b : a), scored[0]);
  const bestCost = scored.slice().sort((a, b) => a.cost - b.cost || a.durationSec - b.durationSec)[0];

  // The blended cost already leans away from dangerous neighborhoods as the
  // slider rises, but it's still a soft tradeoff against walk time. Enforce
  // the slider as a hard ceiling too: if the best-cost route's average
  // neighborhood risk still exceeds what the user said they'd tolerate,
  // switch to the fastest route that actually satisfies it. If nothing does,
  // fall back to whichever route runs through the lowest-risk neighborhoods.
  let recommended = bestCost;
  let safetyNote = null;
  if (!bestCost.meetsSafetyThreshold) {
    const withinThreshold = scored.filter((s) => s.meetsSafetyThreshold);
    if (withinThreshold.length) {
      const safer = withinThreshold.reduce((a, b) => (b.durationSec < a.durationSec ? b : a));
      if (safer !== bestCost) {
        recommended = safer;
        safetyNote = { kind: "switched", from: bestCost, to: safer, threshold };
      }
    } else {
      const lowestRisk = scored.slice().sort((a, b) => a.neighborhoodRisk - b.neighborhoodRisk)[0];
      recommended = lowestRisk;
      safetyNote = { kind: "none-meet", best: lowestRisk, threshold };
    }
  }

  recommendedRoute = recommended;

  // Show exactly one route: the current slider-selected route.
  routeRenderers.push(new google.maps.Polyline({
    path: recommended.route.overview_path, map,
    strokeColor: "#22c55e", strokeOpacity: 0.95, strokeWeight: 7, zIndex: 4,
  }));

  // Fit map to the recommended route (only on a fresh route request).
  if (fit) map.fitBounds(recommended.route.bounds, 60);

  // Highlight the events sitting on the recommended route.
  highlightEvents(recommended.hits);

  renderSummary(fastest, recommended, scored, safetyNote);

  if (safetyNote) {
    setStatus(safetyNote.kind === "switched"
      ? `Fastest pick ran through risk ${fmtScore(safetyNote.from.neighborhoodRisk)} neighborhoods — above your threshold of ${fmtScore(safetyNote.threshold)}. Switched to a safer route (risk ${fmtScore(safetyNote.to.neighborhoodRisk)}).`
      : `No route stays under your safety threshold of ${fmtScore(safetyNote.threshold)} — showing the lowest-risk option available (risk ${fmtScore(safetyNote.best.neighborhoodRisk)}).`
    );
  } else if (recommended === fastest) {
    setStatus(`Fastest route is also the safest (danger ${fmtScore(recommended.dangerScore)}, neighborhood risk ${fmtScore(recommended.neighborhoodRisk)}).`);
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

function renderSummary(fastest, recommended, scored, safetyNote) {
  const wrap = document.getElementById("summary");
  wrap.style.display = "block";
  document.getElementById("priorityBox").style.display = "block";

  const cards = document.getElementById("routeCards");
  cards.innerHTML = "";

  // Top 3 by risk, not by how much of the route sat inside them.
  const hoodChips = (s) => s.neighborhoodBreakdown.slice().sort((a, b) => b.risk - a.risk).slice(0, 3).map((n) => {
    const color = RISK_CATEGORY_COLOR[riskCategory(n.risk)];
    return `<span class="hood-chip" style="border-color:${color}">${escapeHtml(n.name)} <b style="color:${color}">${fmtScore(n.risk)}</b></span>`;
  }).join("");

  const card = (s) => {
    const tier = routeTier(s.dangerScore);
    const hasNeighborhoodData = s.neighborhoodBreakdown.length > 0;
    const nbColor = RISK_CATEGORY_COLOR[riskCategory(s.neighborhoodRisk)];
    const neighborhoods = s.neighborhoodBreakdown.slice().sort((a, b) => b.metres - a.metres);
    const neighborhoodLabel = neighborhoods.length ? neighborhoods.slice(0, 2).map((n) => escapeHtml(n.name)).join(" · ") : "Pittsburgh";
    return `
    <div class="route-card recommended">
      <h3>
        <span class="swatch" style="background:#22c55e"></span>
        ${neighborhoodLabel}
      </h3>
      <div class="metrics">
        <span><b>${s.distanceText || "—"}</b></span>
        <span><b>${s.durationText || "—"}</b></span>
        <span><b>${s.count}</b> event${s.count === 1 ? "" : "s"}</span>
      </div>
      <div class="danger-row">
        <span class="danger-tag" style="background:${TIER_COLOR[tier] || "#64748b"}">${tier} risk</span>
        <div class="danger-bar"><div style="width:${Math.min(100, (s.dangerScore / (CFG.DANGER.tiers.high * 1.5)) * 100)}%;background:${TIER_COLOR[tier] || "#64748b"}"></div></div>
        <span class="danger-num">${fmtScore(s.dangerScore)}</span>
      </div>
      ${hasNeighborhoodData ? `
      <div class="danger-row">
        <span class="danger-tag" style="background:${nbColor}">${riskCategory(s.neighborhoodRisk)}</span>
        <div class="danger-bar"><div style="width:${Math.min(100, s.neighborhoodRisk)}%;background:${nbColor}"></div></div>
        <span class="danger-num">${fmtScore(s.neighborhoodRisk)}</span>
      </div>
      <div class="hood-chips">${hoodChips(s)}</div>` : ""}
    </div>`;
  };

  cards.insertAdjacentHTML("beforeend", card(recommended));
  cards.style.display = "block";

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
