(() => {
  "use strict";

  const STYLE_URL = "https://tiles.openfreemap.org/styles/dark";
  const HOME = { center: [-80.19, 25.775], zoom: 11.2 };
  const COLORS = {
    hotel: "#ff4fa3", nightlife: "#c77dff", food: "#ffb347", shop: "#ffe66d",
    leisure: "#36e0e6", transport: "#6ea8ff", civic: "#9be564", work: "#ff7a59",
    home: "#f4a6d7", nature: "#4fd1a1", other: "#b8b3d9",
  };
  const CAT_ORDER = Object.keys(COLORS);
  const PHOTO_TTL = 14 * 24 * 3600 * 1000;

  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const fold = (s) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();

  const store = {
    get(key, fallback) {
      try { const v = localStorage.getItem(key); return v === null ? fallback : JSON.parse(v); }
      catch { return fallback; }
    },
    set(key, value) { try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* private mode */ } },
  };

  const state = {
    lang: "en",
    places: [], byId: new Map(), tours: [],
    q: "", cat: "all", district: "", onlyNew: false, onlyNamed: false,
    seen: new Set(store.get("ltm.seen", [])),
    selected: null, tour: null, tourIndex: 0,
    tab: "places", mapReady: false,
  };
  let map;

  /* ---------- language ---------- */

  function t(key, vars) {
    let s = (window.I18N[state.lang] && window.I18N[state.lang][key]) || window.I18N.en[key] || key;
    if (vars) for (const k in vars) s = s.replace(`{${k}}`, vars[k]);
    return s;
  }

  function pickLang() {
    const url = new URLSearchParams(location.search).get("lang");
    const saved = store.get("ltm.lang", null);
    const nav = (navigator.language || "en").slice(0, 2);
    const lang = url || saved || nav;
    return lang === "fr" ? "fr" : "en";
  }

  function applyLang() {
    document.documentElement.lang = state.lang;
    document.querySelectorAll("[data-i18n]").forEach((el) => { el.textContent = t(el.dataset.i18n); });
    document.querySelectorAll("[data-i18n-html]").forEach((el) => { el.innerHTML = t(el.dataset.i18nHtml); });
    document.querySelectorAll("[data-lang]").forEach((b) => b.setAttribute("aria-pressed", b.dataset.lang === state.lang));
    $("search").placeholder = t("search.placeholder");
    renderAll();
  }

  /* ---------- filtering ---------- */

  const realLabel = (p) => p.real.name || p.real.address.split(",")[0];
  const gameLabel = (p) => p.name || t("place.unnamed");

  function visiblePlaces() {
    const q = fold(state.q.trim());
    return state.places.filter((p) =>
      (state.cat === "all" || p.category === state.cat) &&
      (!state.district || p.district === state.district) &&
      (!state.onlyNew || !state.seen.has(p.id)) &&
      (!state.onlyNamed || p.named) &&
      (!q || p.search.includes(q)));
  }

  /* ---------- rendering: browse ---------- */

  function renderChips() {
    const counts = {};
    state.places.forEach((p) => { counts[p.category] = (counts[p.category] || 0) + 1; });
    const cats = ["all", ...CAT_ORDER.filter((c) => counts[c])];
    $("chips").innerHTML = cats.map((c) => `
      <button type="button" class="chip" data-cat="${c}" aria-pressed="${state.cat === c}"
        style="--c:${c === "all" ? "#ffffff" : COLORS[c]}">
        ${c === "all" ? "" : '<i aria-hidden="true"></i>'}${esc(c === "all" ? t("filter.all") : t("cat." + c))}
      </button>`).join("");
  }

  function renderDistricts() {
    const counts = new Map();
    state.places.forEach((p) => { if (p.district) counts.set(p.district, (counts.get(p.district) || 0) + 1); });
    const names = [...counts.keys()].sort((a, b) => a.localeCompare(b));
    $("district").innerHTML = `<option value="">${esc(t("filter.allDistricts"))}</option>` +
      names.map((n) => `<option value="${esc(n)}"${n === state.district ? " selected" : ""}>${esc(n)} (${counts.get(n)})</option>`).join("");
  }

  function renderList() {
    const items = visiblePlaces();
    $("count").textContent = items.length === 0 ? t("count.none")
      : items.length === 1 ? t("count.one") : t("count.many", { n: items.length });
    $("list").innerHTML = items.map((p) => `
      <li><button type="button" class="row${state.seen.has(p.id) ? " seen" : ""}" data-id="${p.id}">
        <i style="--c:${COLORS[p.category]}" aria-hidden="true"></i>
        <span class="row-text">
          <strong>${esc(p.named ? p.name : realLabel(p))}</strong>
          <small>${esc(p.named ? realLabel(p) : t("place.unnamedRow"))}</small>
        </span>
        <span class="row-district">${esc(p.district)}</span>
      </button></li>`).join("");
    updateMapData(items);
  }

  function renderTours() {
    $("tours").innerHTML = state.tours.map((tour) => {
      const done = tour.stops.filter((id) => state.seen.has(id)).length;
      return `
      <li class="tour">
        <h3>${esc(tour.title[state.lang])}</h3>
        <p>${esc(tour.blurb[state.lang])}</p>
        <div class="tour-meta">
          <span>${esc(t("tour.stops", { n: tour.stops.length }))} · ${done}/${tour.stops.length}</span>
          <button type="button" class="cta" data-tour="${tour.id}">${esc(t("tour.start"))}</button>
        </div>
      </li>`;
    }).join("");
  }

  function renderProgress() {
    const total = state.places.length;
    const n = state.places.filter((p) => state.seen.has(p.id)).length;
    $("progress-text").textContent = t("progress.text", { n, total });
    $("progress-fill").style.width = total ? `${(n / total) * 100}%` : "0";
  }

  function renderTabs() {
    ["places", "tours"].forEach((name) => {
      $("tab-" + name).setAttribute("aria-selected", state.tab === name);
      $("body-" + name).hidden = state.tab !== name;
    });
  }

  function renderAll() {
    if (!state.places.length) return;
    renderChips(); renderDistricts(); renderList(); renderTours(); renderProgress(); renderTabs();
    if (state.selected) renderCard(state.selected);
  }

  /* ---------- rendering: card ---------- */

  function renderCard(p) {
    const { lat, lng } = p.real;
    const query = encodeURIComponent(`${p.real.name ? p.real.name + ", " : ""}${p.real.address}`);
    const flags = p.flags.map((f) => `<span class="badge badge-${f}">${esc(t("flag." + f))}</span>`).join("");
    $("card").innerHTML = `
      <figure class="photo" id="photo"><div class="photo-empty">${esc(t("card.loadingPhoto"))}</div></figure>
      <div class="pair">
        <div class="side side-game">
          <span class="eyebrow">${esc(t("card.inGame"))}</span>
          <h2${p.named ? "" : ' class="unnamed"'}>${esc(gameLabel(p))}</h2>
          <p>${esc([p.district, p.city].filter(Boolean).join(" · "))}</p>
        </div>
        <div class="pair-arrow" aria-hidden="true">↓</div>
        <div class="side side-real">
          <span class="eyebrow">${esc(t("card.inReal"))}</span>
          <h2>${esc(realLabel(p))}</h2>
          <p>${esc(p.real.name ? p.real.address : t("card.noRealName"))}</p>
        </div>
      </div>
      <div class="badges">
        <span class="badge badge-cat" style="--c:${COLORS[p.category]}">${esc(t("cat." + p.category))}</span>${flags}
      </div>
      <div class="actions">
        <a class="btn" target="_blank" rel="noopener" href="https://www.google.com/maps/@?api=1&map_action=pano&viewpoint=${lat},${lng}">${esc(t("card.streetView"))}</a>
        <a class="btn" target="_blank" rel="noopener" href="https://www.google.com/maps/search/?api=1&query=${query}">${esc(t("card.directions"))}</a>
        <button type="button" class="btn" id="share">${esc(t("card.share"))}</button>
      </div>
      <a class="gtadb" target="_blank" rel="noopener" href="https://map.gtadb.org/#VI,${p.id}">${esc(t("card.gtadb"))} ↗</a>`;
    $("share").addEventListener("click", () => share(p));
    loadPhoto(p);

    const tour = state.tour;
    $("tour-nav").hidden = !tour;
    if (tour) {
      $("tour-pos").textContent = `${tour.title[state.lang]} · ${t("tour.pos", { i: state.tourIndex + 1, n: tour.stops.length })}`;
      $("tour-prev").disabled = state.tourIndex === 0;
      $("tour-next").disabled = state.tourIndex === tour.stops.length - 1;
    }
  }

  async function share(p) {
    const url = `${location.origin}${location.pathname}#/place/${p.id}`;
    try {
      if (navigator.share && matchMedia("(pointer: coarse)").matches) {
        await navigator.share({ title: `${gameLabel(p)} → ${realLabel(p)}`, url });
        return;
      }
      await navigator.clipboard.writeText(url);
      toast(t("card.copied"));
    } catch { /* dismissed or blocked */ }
  }

  /* ---------- photos (Wikimedia Commons, looked up in the visitor's browser) ---------- */

  const COMMONS = "https://commons.wikimedia.org/w/api.php?action=query&format=json&origin=*" +
    "&prop=imageinfo%7Ccoordinates&iiprop=url%7Cextmetadata%7Cmime&iiurlwidth=800" +
    "&iiextmetadatafilter=Artist%7CLicenseShortName";

  const stripHtml = (html) => {
    const d = document.createElement("div");
    d.innerHTML = html;
    d.querySelectorAll("style,script").forEach((n) => n.remove());
    return d.textContent.replace(/\s+/g, " ").trim();
  };

  function metres(a, b) {
    const dy = (a.lat - b.lat) * 111320;
    const dx = (a.lng - b.lng) * 111320 * Math.cos(((a.lat + b.lat) / 2) * Math.PI / 180);
    return Math.hypot(dx, dy);
  }

  async function commons(params, p, maxDistance) {
    const res = await fetch(COMMONS + params);
    if (!res.ok) throw new Error("commons " + res.status);
    const pages = Object.values((await res.json()).query?.pages || {});
    const usable = pages.map((page) => {
      const info = page.imageinfo && page.imageinfo[0];
      if (!info || info.mime !== "image/jpeg" || !info.thumburl) return null;
      const c = page.coordinates && page.coordinates[0];
      const far = c ? metres({ lat: c.lat, lng: c.lon }, p.real) : null;
      if (far !== null && far > maxDistance) return null;
      const meta = info.extmetadata || {};
      return {
        src: info.thumburl,
        page: info.descriptionurl,
        artist: stripHtml(meta.Artist?.value || "").slice(0, 80) || "Wikimedia Commons",
        license: stripHtml(meta.LicenseShortName?.value || ""),
        rank: (page.index || 99) + (far === null ? 5 : far / 100),
      };
    }).filter(Boolean).sort((a, b) => a.rank - b.rank);
    return usable[0] || null;
  }

  async function findPhoto(p) {
    const key = "ltm.photo." + p.id;
    const cached = store.get(key, null);
    if (cached && Date.now() - cached.at < PHOTO_TTL) return cached.photo;
    let photo = null;
    if (p.real.name) {
      const q = encodeURIComponent(`${p.real.name} Miami filetype:bitmap`);
      photo = await commons(`&generator=search&gsrnamespace=6&gsrlimit=8&gsrsearch=${q}`, p, 1500);
    }
    if (!photo) {
      photo = await commons(`&generator=geosearch&ggsnamespace=6&ggslimit=10&ggsradius=80&ggscoord=${p.real.lat}%7C${p.real.lng}`, p, 80);
      if (photo) photo.nearby = true;
    }
    store.set(key, { at: Date.now(), photo });
    return photo;
  }

  async function loadPhoto(p) {
    let photo = null;
    try { photo = await findPhoto(p); } catch { /* offline or rate limited: show the placeholder */ }
    if (state.selected !== p) return;
    const box = $("photo");
    if (!box) return;
    if (!photo) {
      box.innerHTML = `<div class="photo-empty">${esc(t("card.noPhoto"))}</div>`;
      return;
    }
    const credit = t("card.photoBy", { artist: photo.artist, license: photo.license || "free licence" });
    box.innerHTML = `
      <img alt="${esc(p.real.name || p.real.address)}" src="${esc(photo.src)}" loading="lazy">
      <figcaption>${photo.nearby ? `<b>${esc(t("card.photoNearby"))}</b> · ` : ""}<a href="${esc(photo.page)}" target="_blank" rel="noopener">${esc(credit)}</a></figcaption>`;
    box.querySelector("img").addEventListener("error", () => {
      box.innerHTML = `<div class="photo-empty">${esc(t("card.noPhoto"))}</div>`;
    });
  }

  /* ---------- map ---------- */

  function neon(style) {
    const paint = (id, props) => {
      const layer = style.layers.find((l) => l.id === id);
      if (layer) layer.paint = { ...layer.paint, ...props };
    };
    style.layers = style.layers.filter((l) => l.source !== "ne2_shaded");
    paint("background", { "background-color": "#1a1038" });
    paint("water", { "fill-color": "#0b1d4a" });
    paint("waterway", { "line-color": "#0b1d4a" });
    paint("landuse_residential", { "fill-color": "#1f1342", "fill-opacity": 0.6 });
    paint("landcover_wood", { "fill-color": "#143a3a" });
    paint("landuse_park", { "fill-color": "#143a3a" });
    paint("building", { "fill-color": "#2a1a55", "fill-outline-color": "#3a2670" });
    paint("aeroway-area", { "fill-color": "#241647" });
    paint("aeroway-runway", { "line-color": "#3a2670" });
    paint("aeroway-taxiway", { "line-color": "#30205f" });
    paint("highway_path", { "line-color": "#33215f" });
    paint("highway_minor", { "line-color": "#35225f" });
    paint("highway_major_casing", { "line-color": "#5b2a7a" });
    paint("highway_major_inner", { "line-color": "#3d2468" });
    paint("highway_major_subtle", { "line-color": "#5b2a7a" });
    paint("highway_motorway_casing", { "line-color": "#b0347f" });
    paint("highway_motorway_inner", { "line-color": "#5a2470" });
    paint("highway_motorway_subtle", { "line-color": "#5a2470" });
    ["road_area_pier"].forEach((id) => paint(id, { "fill-color": "#1a1038" }));
    paint("road_pier", { "line-color": "#1a1038" });
    style.layers.forEach((l) => {
      if (l.type !== "symbol" || !l.paint) return;
      if (l.id === "water_name") l.paint = { ...l.paint, "text-color": "#5d83d6", "text-halo-color": "#0b1d4a" };
      else if (l.id.startsWith("place_")) l.paint = { ...l.paint, "text-color": "#c9bdf2", "text-halo-color": "#140a2e" };
      else if (l.id.startsWith("highway_name")) l.paint = { ...l.paint, "text-color": "#8f7fc4", "text-halo-color": "#140a2e" };
    });
    return style;
  }

  function featureCollection(items) {
    return {
      type: "FeatureCollection",
      features: items.map((p) => ({
        type: "Feature",
        id: Number(p.id.slice(1)),
        geometry: { type: "Point", coordinates: [p.real.lng, p.real.lat] },
        properties: {
          id: p.id, name: p.name, tip: p.name || realLabel(p), size: p.named ? 1 : 0.62,
          color: COLORS[p.category],
          seen: state.seen.has(p.id), selected: state.selected === p,
        },
      })),
    };
  }

  function updateMapData(items) {
    if (!state.mapReady) return;
    map.getSource("places").setData(featureCollection(items || visiblePlaces()));
    const tour = state.tour;
    map.getSource("tour").setData({
      type: "FeatureCollection",
      features: tour ? [{
        type: "Feature", properties: {},
        geometry: { type: "LineString", coordinates: tour.stops.map((id) => state.byId.get(id)).map((p) => [p.real.lng, p.real.lat]) },
      }] : [],
    });
  }

  function mapPadding() {
    if (matchMedia("(max-width: 760px)").matches) {
      return { top: 70, bottom: Math.round(innerHeight * 0.55), left: 30, right: 30 };
    }
    return { top: 80, bottom: 40, left: 440, right: 40 };
  }

  async function initMap() {
    const style = neon(await (await fetch(STYLE_URL)).json());
    const font = (style.layers.find((l) => l.id === "place_suburb")?.layout || {})["text-font"] || ["Noto Sans Regular"];
    map = new maplibregl.Map({
      container: "map", style, center: HOME.center, zoom: HOME.zoom,
      maxBounds: [[-81.6, 24.9], [-79.2, 26.6]], attributionControl: { compact: true },
    });
    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "bottom-right");
    map.addControl(new maplibregl.GeolocateControl({ trackUserLocation: false }), "bottom-right");
    await new Promise((resolve) => map.on("load", resolve));

    map.addSource("places", { type: "geojson", data: featureCollection([]) });
    map.addSource("tour", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
    map.addLayer({
      id: "tour-line", type: "line", source: "tour",
      layout: { "line-cap": "round", "line-join": "round" },
      paint: { "line-color": "#ff4fa3", "line-width": 3, "line-opacity": 0.75, "line-dasharray": [0.2, 2] },
    });
    const size = ["get", "size"];
    const radius = ["interpolate", ["linear"], ["zoom"], 10, ["*", 4, size], 14, ["*", 7, size], 17, ["*", 11, size]];
    map.addLayer({
      id: "pins-glow", type: "circle", source: "places",
      paint: {
        "circle-color": ["get", "color"], "circle-blur": 1, "circle-opacity": 0.45,
        "circle-radius": ["interpolate", ["linear"], ["zoom"], 10, ["*", 9, size], 14, ["*", 16, size], 17, ["*", 24, size]],
      },
    });
    map.addLayer({
      id: "pins", type: "circle", source: "places",
      layout: { "circle-sort-key": size },
      paint: {
        "circle-radius": radius,
        "circle-color": ["case", ["get", "seen"], ["get", "color"], "#140a2e"],
        "circle-stroke-color": ["get", "color"],
        "circle-stroke-width": ["case", ["==", size, 1], 2, 1.4],
      },
    });
    map.addLayer({
      id: "pin-selected", type: "circle", source: "places", filter: ["==", ["get", "selected"], true],
      paint: {
        "circle-radius": ["interpolate", ["linear"], ["zoom"], 10, 9, 14, 13, 17, 18],
        "circle-color": "rgba(0,0,0,0)", "circle-stroke-color": "#ffffff", "circle-stroke-width": 2.5,
      },
    });
    map.addLayer({
      id: "pin-labels", type: "symbol", source: "places", minzoom: 14,
      layout: {
        "text-field": ["get", "name"], "text-font": font, "text-size": 12,
        "text-offset": [0, 1.1], "text-anchor": "top", "text-optional": true, "text-max-width": 9,
      },
      paint: { "text-color": "#ffffff", "text-halo-color": "#140a2e", "text-halo-width": 1.6 },
    });

    map.on("click", "pins", (e) => { location.hash = `#/place/${e.features[0].properties.id}`; });
    map.on("mouseenter", "pins", () => { map.getCanvas().style.cursor = "pointer"; });
    map.on("mouseleave", "pins", () => { map.getCanvas().style.cursor = ""; });

    const tip = new maplibregl.Popup({ closeButton: false, closeOnClick: false, offset: 12, className: "tip" });
    map.on("mousemove", "pins", (e) => {
      const f = e.features[0];
      tip.setLngLat(f.geometry.coordinates).setText(f.properties.tip).addTo(map);
    });
    map.on("mouseleave", "pins", () => tip.remove());

    state.mapReady = true;
    updateMapData();
    focusMap();
  }

  function focusMap() {
    if (!state.mapReady) return;
    const padding = mapPadding();
    if (state.selected) {
      const { lng, lat } = state.selected.real;
      map.flyTo({ center: [lng, lat], zoom: Math.max(map.getZoom(), 15.5), padding, speed: 1.4, essential: true });
    }
  }

  function fitTo(items) {
    if (!state.mapReady || !items.length) return;
    const b = new maplibregl.LngLatBounds();
    items.forEach((p) => b.extend([p.real.lng, p.real.lat]));
    map.fitBounds(b, { padding: mapPadding(), maxZoom: 15.5, duration: 900 });
  }

  /* ---------- navigation ---------- */

  function markSeen(p) {
    if (state.seen.has(p.id)) return;
    state.seen.add(p.id);
    store.set("ltm.seen", [...state.seen]);
  }

  function showCard(p) {
    state.selected = p;
    markSeen(p);
    $("view-browse").hidden = true;
    $("view-card").hidden = false;
    $("panel").classList.add("open");
    $("view-card").scrollTop = 0;
    renderCard(p);
    renderProgress();
    updateMapData();
    focusMap();
    document.title = `${gameLabel(p)} → ${realLabel(p)} · Leonida → Miami`;
  }

  function showBrowse() {
    state.selected = null;
    state.tour = null;
    $("view-card").hidden = true;
    $("view-browse").hidden = false;
    document.title = "Leonida → Miami";
    renderList(); renderTours(); renderProgress();
  }

  function route() {
    const parts = location.hash.replace(/^#\/?/, "").split("/");
    if (parts[0] === "place" && state.byId.has(parts[1])) {
      state.tour = null;
      showCard(state.byId.get(parts[1]));
    } else if (parts[0] === "tour") {
      const tour = state.tours.find((x) => x.id === parts[1]);
      if (!tour) return showBrowse();
      const first = state.tour !== tour;
      state.tour = tour;
      state.tourIndex = Math.min(Math.max((parseInt(parts[2], 10) || 1) - 1, 0), tour.stops.length - 1);
      showCard(state.byId.get(tour.stops[state.tourIndex]));
      if (first && state.tourIndex === 0) toast(tour.title[state.lang]);
      if (state.tourIndex === tour.stops.length - 1 && !first) toast(t("tour.done", { title: tour.title[state.lang] }));
    } else {
      showBrowse();
    }
  }

  let toastTimer;
  function toast(text) {
    const el = $("toast");
    el.textContent = text;
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.hidden = true; }, 2600);
  }

  /* ---------- events ---------- */

  function bind() {
    document.querySelectorAll("[data-lang]").forEach((b) => b.addEventListener("click", () => {
      state.lang = b.dataset.lang;
      store.set("ltm.lang", state.lang);
      applyLang();
    }));
    $("search").addEventListener("input", (e) => {
      state.q = e.target.value;
      if (state.selected) location.hash = "#/";
      state.tab = "places";
      renderTabs(); renderList();
      $("panel").classList.add("open");
    });
    $("chips").addEventListener("click", (e) => {
      const b = e.target.closest("[data-cat]");
      if (!b) return;
      state.cat = b.dataset.cat;
      renderChips(); renderList();
      fitTo(visiblePlaces());
    });
    $("district").addEventListener("change", (e) => {
      state.district = e.target.value;
      renderList();
      fitTo(visiblePlaces());
    });
    $("only-named").addEventListener("change", (e) => { state.onlyNamed = e.target.checked; renderList(); });
    $("only-new").addEventListener("change", (e) => { state.onlyNew = e.target.checked; renderList(); });
    $("list").addEventListener("click", (e) => {
      const b = e.target.closest("[data-id]");
      if (b) location.hash = `#/place/${b.dataset.id}`;
    });
    $("tours").addEventListener("click", (e) => {
      const b = e.target.closest("[data-tour]");
      if (b) location.hash = `#/tour/${b.dataset.tour}/1`;
    });
    document.querySelectorAll("[data-tab]").forEach((b) => b.addEventListener("click", () => {
      state.tab = b.dataset.tab;
      renderTabs();
    }));
    $("card-back").addEventListener("click", () => { location.hash = "#/"; });
    $("tour-prev").addEventListener("click", () => stepTour(-1));
    $("tour-next").addEventListener("click", () => stepTour(1));
    $("panel-handle").addEventListener("click", () => $("panel").classList.toggle("open"));
    $("reset").addEventListener("click", () => {
      if (!confirm(t("progress.resetConfirm"))) return;
      state.seen.clear();
      store.set("ltm.seen", []);
      renderAll();
    });
    document.addEventListener("keydown", (e) => {
      if (e.target.matches("input, select, textarea")) return;
      if (e.key === "Escape" && state.selected) location.hash = "#/";
      if (state.tour && e.key === "ArrowRight") stepTour(1);
      if (state.tour && e.key === "ArrowLeft") stepTour(-1);
    });
    addEventListener("hashchange", route);
  }

  function stepTour(delta) {
    if (!state.tour) return;
    const i = state.tourIndex + delta;
    if (i < 0 || i >= state.tour.stops.length) return;
    location.hash = `#/tour/${state.tour.id}/${i + 1}`;
  }

  /* ---------- start ---------- */

  async function start() {
    state.lang = pickLang();
    bind();
    applyLang();
    try {
      const data = await (await fetch("data/places.json")).json();
      const rank = (p) => (p.named ? (p.generic ? 1 : 0) : 2);
      const label = (p) => p.name || p.real.name || p.real.address;
      state.places = data.places.sort((a, b) => rank(a) - rank(b) || label(a).localeCompare(label(b)));
      state.places.forEach((p) => {
        p.search = fold(`${p.name} ${p.real.name} ${p.real.address} ${p.district} ${p.city}`);
        state.byId.set(p.id, p);
      });
      state.tours = data.tours;
    } catch {
      $("count").textContent = t("error.data");
      return;
    }
    renderAll();
    route();
    initMap().catch(() => toast(t("error.data")));
  }

  start();
})();
