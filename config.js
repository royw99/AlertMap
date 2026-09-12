// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------
// 1. Get a Google Maps JavaScript API key:
//      https://console.cloud.google.com/google/maps-apis/credentials
// 2. Enable these APIs for the key:  Maps JavaScript API, Directions API,
//    Places API.
// 3. Paste the key below (replace YOUR_API_KEY) and reload the page.
//
// Nothing else needs a key — the event data comes from Toronto's public
// CKAN Open Data portal and requires no authentication.
// ---------------------------------------------------------------------------
window.CONFIG = {
  GOOGLE_MAPS_API_KEY: "AIzaSyDcXRBQ8sNQNiVVuN4klfu_Q2GzKvBIYHc",

  // Map defaults (Pittsburgh downtown).
  DEFAULT_CENTER: { lat: 40.4406, lng: -79.9959 },
  DEFAULT_ZOOM: 12,
  // Keep Pittsburgh fixtures while testing the real Google basemap.
  USE_SYNTHETIC_DATA: true,
  // Official City of Pittsburgh neighborhood boundaries, served as GeoJSON.
  NEIGHBORHOODS_GEOJSON: "https://pghbridgis.pittsburghpa.gov/federated/rest/services/Neighborhoods/FeatureServer/0/query?where=1%3D1&outFields=hood%2Cacres&f=geojson",

  // Toronto Open Data — "Road Restrictions" dataset (published via CKAN).
  //   Portal:   https://open.toronto.ca/dataset/road-restrictions/
  //   CKAN API: https://ckan0.cf.opendata.inter.prod-toronto.ca/api/3/action/package_show?id=road-restrictions
  //   Resource: 421c8a17-4ecf-4cae-b084-ccb005ea6cc3  (Version 3 - JSON, CORS-enabled)
  // The CKAN action API itself is not CORS-enabled, so we fetch the live
  // resource feed directly (it sends Access-Control-Allow-Origin: *).
  CKAN: {
    portal: "https://open.toronto.ca/dataset/road-restrictions/",
    resourceId: "421c8a17-4ecf-4cae-b084-ccb005ea6cc3",
    feedUrl: "https://secure.toronto.ca/opendata/cart/road_restrictions/v3?format=json",
  },

  // How close (in metres) a disruption must be to a route to count as
  // "on the route" when scoring alternatives.
  ROUTE_PROXIMITY_METRES: 150,

  // --- Danger / rerouting model -------------------------------------------
  // A route's cost = drive_minutes + lambda * danger_score, where lambda is
  // set by the "Fastest <-> Safest" slider. Each event's danger is:
  //   severity x type x direction x roadClass x active  (then x proximity)
  // Tune any of these weights to change how strongly the router avoids things.
  DANGER: {
    // City's own impact rating (currImpact, falling back to maxImpact).
    severity: { High: 6, Medium: 3, Low: 1.5, None: 1 },
    // Kind of disruption.
    type: { ROAD_CLOSED: 2.0, HAZARD: 1.8, CONSTRUCTION: 1.0 },
    specialEvent: 1.8,             // crowds / parades / unpredictable detours
    bothDirections: 1.4,           // fully blocks vs. one direction
    // Bigger roads mean bigger disruption + heavier surrounding traffic.
    roadClass: { Expressway: 1.5, "Major Arterial": 1.3, "Minor Arterial": 1.1, default: 1.0 },
    inactiveMultiplier: 0.4,       // scheduled-for-later / expired events count less
    // Slider maps 0..100 -> lambda 0..maxLambda (minutes of detour per danger point).
    maxLambda: 1.5,
    // Temporary local risk-service substitute. Replace mockRouteRisk() in
    // app.js with a fetch call when the real endpoint is available.
    mockBusynessWeight: 0.12,
    defaultSafety: 45,             // initial slider position (0 = fastest, 100 = safest)
    // Route-level danger tiers for the summary badge.
    tiers: { medium: 6, high: 16 },
  },
};
