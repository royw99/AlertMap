/* ==========================================================================
 * mock-maps.js — a tiny stand-in for the Google Maps JS API, used ONLY when
 * config.js has no real key. It lets the whole app render and be tested with
 * the real CKAN event data and synthetic alternative routes. It is NOT a real
 * map (no tiles/roads) — it projects lat/lng into an SVG so you can see the
 * events, drop A/B points, and watch the danger-aware rerouting + slider work.
 * ======================================================================== */
(function () {
  const R = 6371000;
  const rad = (d) => (d * Math.PI) / 180;
  function haversine(a, b) {
    const dLat = rad(b.lat() - a.lat()), dLng = rad(b.lng() - a.lng());
    const s = Math.sin(dLat / 2) ** 2 +
      Math.cos(rad(a.lat())) * Math.cos(rad(b.lat())) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(s));
  }

  class LatLng {
    constructor(lat, lng) { this._lat = +lat; this._lng = +lng; }
    lat() { return this._lat; } lng() { return this._lng; }
  }
  class Point { constructor(x, y) { this.x = x; this.y = y; } }

  class LatLngBounds {
    constructor(sw, ne) {
      this.minLat = Infinity; this.maxLat = -Infinity;
      this.minLng = Infinity; this.maxLng = -Infinity;
      if (sw) this.extend(sw); if (ne) this.extend(ne);
    }
    extend(ll) {
      const lat = typeof ll.lat === "function" ? ll.lat() : ll.lat;
      const lng = typeof ll.lng === "function" ? ll.lng() : ll.lng;
      this.minLat = Math.min(this.minLat, lat); this.maxLat = Math.max(this.maxLat, lat);
      this.minLng = Math.min(this.minLng, lng); this.maxLng = Math.max(this.maxLng, lng);
      return this;
    }
    getSouthWest() { return new LatLng(this.minLat, this.minLng); }
    getNorthEast() { return new LatLng(this.maxLat, this.maxLng); }
    getCenter() { return new LatLng((this.minLat + this.maxLat) / 2, (this.minLng + this.maxLng) / 2); }
    contains(ll) {
      return ll.lat() >= this.minLat && ll.lat() <= this.maxLat &&
             ll.lng() >= this.minLng && ll.lng() <= this.maxLng;
    }
  }

  // Default view: Pittsburgh metro core.
  const DEFAULT_VIEW = { minLat: 40.38, maxLat: 40.51, minLng: -80.08, maxLng: -79.88 };

  class MockMap {
    constructor(div, opts) {
      this.div = div;
      this.view = { ...DEFAULT_VIEW };
      this.markers = new Set();
      this.polylines = new Set();
      this.clickCbs = [];
      this._dirty = false;

      div.style.position = "relative";
      div.style.background =
        "radial-gradient(circle at 30% 20%, #16202f, #0d1420 70%)";
      this.svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
      Object.assign(this.svg.style, { position: "absolute", inset: "0", width: "100%", height: "100%" });
      div.appendChild(this.svg);

      // grid + label
      const tag = document.createElement("div");
      tag.textContent = "DEMO MAP · projected view (no tiles)";
      Object.assign(tag.style, {
        position: "absolute", left: "10px", bottom: "8px", font: "11px sans-serif",
        color: "#5b6b82", pointerEvents: "none",
      });
      div.appendChild(tag);

      this.svg.addEventListener("click", (ev) => {
        if (ev.target.dataset && ev.target.dataset.markerId) return; // handled by marker
        const ll = this.unproject(ev.offsetX, ev.offsetY);
        this.clickCbs.forEach((cb) => cb({ latLng: ll }));
      });
      window.addEventListener("resize", () => this.render());
      requestAnimationFrame(() => this.render());
    }
    setCenter() {} setZoom() {} panTo() {}
    fitBounds(b, padFrac) {
      const pad = 0.12;
      const dLat = (b.maxLat - b.minLat) * pad || 0.01;
      const dLng = (b.maxLng - b.minLng) * pad || 0.01;
      this.view = { minLat: b.minLat - dLat, maxLat: b.maxLat + dLat,
                    minLng: b.minLng - dLng, maxLng: b.maxLng + dLng };
      this.scheduleRender();
    }
    addListener(ev, cb) { if (ev === "click") this.clickCbs.push(cb); }
    project(ll) {
      const w = this.div.clientWidth || 800, h = this.div.clientHeight || 600;
      const v = this.view;
      return {
        x: ((ll.lng() - v.minLng) / (v.maxLng - v.minLng)) * w,
        y: (1 - (ll.lat() - v.minLat) / (v.maxLat - v.minLat)) * h,
      };
    }
    unproject(x, y) {
      const w = this.div.clientWidth || 800, h = this.div.clientHeight || 600;
      const v = this.view;
      return new LatLng(v.minLat + (1 - y / h) * (v.maxLat - v.minLat),
                        v.minLng + (x / w) * (v.maxLng - v.minLng));
    }
    scheduleRender() {
      if (this._dirty) return;
      this._dirty = true;
      requestAnimationFrame(() => { this._dirty = false; this.render(); });
    }
    render() {
      const ns = "http://www.w3.org/2000/svg";
      this.svg.innerHTML = "";
      // routes first (under markers)
      const byZ = [...this.polylines];
      for (const pl of byZ) {
        if (!pl.visible) continue;
        const pts = pl.path.map((ll) => this.project(ll)).map((p) => `${p.x},${p.y}`).join(" ");
        const el = document.createElementNS(ns, "polyline");
        el.setAttribute("points", pts);
        el.setAttribute("fill", "none");
        el.setAttribute("stroke", pl.strokeColor || "#4d8dff");
        el.setAttribute("stroke-opacity", pl.strokeOpacity ?? 1);
        el.setAttribute("stroke-width", pl.strokeWeight || 4);
        el.setAttribute("stroke-linejoin", "round");
        el.setAttribute("stroke-linecap", "round");
        this.svg.appendChild(el);
      }
      // markers, sorted by zIndex
      const ms = [...this.markers].filter((m) => m.visible).sort((a, b) => (a.zIndex || 0) - (b.zIndex || 0));
      for (const m of ms) {
        const p = this.project(m.position);
        if (m.icon && m.label) {
          // endpoint pin
          const g = document.createElementNS(ns, "g");
          const c = document.createElementNS(ns, "circle");
          c.setAttribute("cx", p.x); c.setAttribute("cy", p.y); c.setAttribute("r", 11);
          c.setAttribute("fill", m.icon.fillColor || "#4d8dff");
          c.setAttribute("stroke", "#0b1017"); c.setAttribute("stroke-width", 2);
          const t = document.createElementNS(ns, "text");
          t.setAttribute("x", p.x); t.setAttribute("y", p.y + 4);
          t.setAttribute("text-anchor", "middle"); t.setAttribute("font-size", 12);
          t.setAttribute("font-weight", "700"); t.setAttribute("fill", "#fff");
          t.textContent = m.label.text || m.label;
          g.appendChild(c); g.appendChild(t); this.svg.appendChild(g);
        } else {
          const c = document.createElementNS(ns, "circle");
          const scale = (m.icon && m.icon.scale) || 5;
          c.setAttribute("cx", p.x); c.setAttribute("cy", p.y);
          c.setAttribute("r", Math.max(2.5, scale * 0.9));
          c.setAttribute("fill", (m.icon && m.icon.fillColor) || "#f59e0b");
          c.setAttribute("fill-opacity", 0.95);
          c.setAttribute("stroke", "#0b1017"); c.setAttribute("stroke-width", 1);
          c.style.cursor = "pointer";
          c.dataset.markerId = "1";
          c.addEventListener("click", (e) => { e.stopPropagation(); m._fire("click"); });
          this.svg.appendChild(c);
        }
      }
      if (this.infoWindow && this.infoWindow._anchor) this.infoWindow._place(this);
    }
  }

  class Marker {
    constructor(opts = {}) {
      this.position = opts.position;
      this.icon = opts.icon; this.label = opts.label;
      this.zIndex = opts.zIndex || 0; this.title = opts.title;
      this.visible = false; this.map = null; this._cbs = {};
      if (opts.map) this.setMap(opts.map);
    }
    setMap(map) {
      if (this.map && !map) { this.map.markers.delete(this); this.map.scheduleRender(); }
      this.map = map; this.visible = !!map;
      if (map) { map.markers.add(this); map.scheduleRender(); }
    }
    setIcon(icon) { this.icon = icon; this.map && this.map.scheduleRender(); }
    setZIndex(z) { this.zIndex = z; this.map && this.map.scheduleRender(); }
    setLabel(l) { this.label = l; }
    addListener(ev, cb) { this._cbs[ev] = cb; }
    _fire(ev) { this._cbs[ev] && this._cbs[ev](); }
  }

  class Polyline {
    constructor(opts = {}) {
      this.path = opts.path || []; this.map = null; this.visible = false;
      this.strokeColor = opts.strokeColor; this.strokeOpacity = opts.strokeOpacity;
      this.strokeWeight = opts.strokeWeight; this.zIndex = opts.zIndex || 0;
      if (opts.map) this.setMap(opts.map);
    }
    setMap(map) {
      if (this.map && !map) { this.map.polylines.delete(this); this.map.scheduleRender(); }
      this.map = map; this.visible = !!map;
      if (map) { map.polylines.add(this); map.scheduleRender(); }
    }
  }

  class InfoWindow {
    constructor() { this.el = null; this._anchor = null; this._html = ""; }
    setContent(html) { this._html = html; }
    open({ map, anchor }) {
      this.map = map; this._anchor = anchor;
      map.infoWindow = this;
      if (!this.el) {
        this.el = document.createElement("div");
        Object.assign(this.el.style, {
          position: "absolute", background: "#fff", color: "#111", borderRadius: "10px",
          padding: "10px 12px", boxShadow: "0 8px 30px rgba(0,0,0,.4)", zIndex: 1000,
          maxWidth: "300px", transform: "translate(-50%,-100%)", marginTop: "-14px",
        });
        map.div.appendChild(this.el);
      }
      this.el.innerHTML = this._html;
      this.el.style.display = "block";
      this._place(map);
    }
    _place(map) {
      if (!this._anchor) return;
      const p = map.project(this._anchor.position);
      this.el.style.left = p.x + "px"; this.el.style.top = p.y + "px";
    }
    close() { if (this.el) this.el.style.display = "none"; this._anchor = null; }
  }

  class Geocoder {
    geocode(req, cb) {
      const ll = req.location;
      cb([{ formatted_address: `${ll.lat().toFixed(5)}, ${ll.lng().toFixed(5)} (demo)` }], "OK");
    }
  }

  // Autocomplete is a no-op in demo mode (use click-to-set to place points).
  class Autocomplete { constructor() {} addListener() {} }

  // Synthesize 3 driving routes between two points so the danger scorer has
  // real alternatives to rank. Routes bow out by different perpendicular
  // offsets, so they pass through different events.
  function densify(a, b, stepM) {
    const d = haversine(a, b), n = Math.max(1, Math.round(d / stepM)), out = [];
    for (let i = 0; i <= n; i++) {
      out.push(new LatLng(a.lat() + (b.lat() - a.lat()) * (i / n),
                          a.lng() + (b.lng() - a.lng()) * (i / n)));
    }
    return out;
  }
  function bowedRoute(o, d, offset) {
    const mid = new LatLng((o.lat() + d.lat()) / 2, (o.lng() + d.lng()) / 2);
    // perpendicular direction in lat/lng space
    const dx = d.lng() - o.lng(), dy = d.lat() - o.lat();
    const len = Math.hypot(dx, dy) || 1e-6;
    const px = -dy / len, py = dx / len;
    const ctrl = new LatLng(mid.lat() + py * offset, mid.lng() + px * offset);
    return [...densify(o, ctrl, 250), ...densify(ctrl, d, 250)];
  }
  class DirectionsService {
    route(req, cb) {
      const o = req.origin, d = req.destination;
      const specs = [
        { off: 0.0, speed: 34 },    // direct / fastest
        { off: 0.012, speed: 30 },  // bow one way
        { off: -0.012, speed: 30 }, // bow other way
      ];
      const routes = specs.map((s) => {
        const path = bowedRoute(o, d, s.off);
        let dist = 0;
        for (let i = 1; i < path.length; i++) dist += haversine(path[i - 1], path[i]);
        const bounds = new LatLngBounds();
        path.forEach((p) => bounds.extend(p));
        const secs = dist / (s.speed * 1000 / 3600);
        return {
          overview_path: path, bounds,
          legs: [{
            duration: { value: secs, text: Math.round(secs / 60) + " min" },
            distance: { value: dist, text: (dist / 1000).toFixed(1) + " km" },
          }],
        };
      });
      setTimeout(() => cb({ routes }, "OK"), 60);
    }
  }

  window.google = {
    maps: {
      Map: MockMap, Marker, Polyline, InfoWindow, Geocoder, LatLng, LatLngBounds, Point,
      DirectionsService,
      SymbolPath: { CIRCLE: 0 },
      TravelMode: { DRIVING: "DRIVING" },
      places: { Autocomplete },
      geometry: { poly: { isLocationOnEdge: () => false } },
    },
  };
})();
