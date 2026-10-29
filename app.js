(() => {
  "use strict";

  // ---------- constants ----------
  const DAYS = [
    { value: "2026-10-29", label: "Thu Oct 29" },
    { value: "2026-10-30", label: "Fri Oct 30" },
    { value: "2026-10-31", label: "Sat Oct 31 🎃" },
    { value: "2026-11-01", label: "Sun Nov 1" },
    { value: "2026-11-02", label: "Mon Nov 2" },
    { value: "", label: "No day yet" },
  ];
  const JSONBLOB = "https://jsonblob.com/api/jsonBlob";
  const POLL_MS = 10000;
  const LS = {
    pass: "chi.passcode",
    name: "chi.name",
    sync: "chi.syncUrl",
    cache: "chi.cache",
    pending: "chi.pending",
  };

  // ---------- small helpers ----------
  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => [...el.querySelectorAll(s)];
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const store = {
    get(k, fallback = null) {
      try { const v = localStorage.getItem(k); return v === null ? fallback : JSON.parse(v); } catch { return fallback; }
    },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
    del(k) { try { localStorage.removeItem(k); } catch {} },
  };
  const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
  const fromB64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
  const toB64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)));
  const gmapsSearch = (it) => {
    const q = it.address ? `${it.title}, ${it.address}` : (it.lat != null ? `${it.lat},${it.lng}` : `${it.title}, Chicago`);
    return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(q)}`;
  };
  const dayLabel = (v) => (DAYS.find((d) => d.value === v) || DAYS[DAYS.length - 1]).label;

  let toastTimer;
  function toast(msg) {
    const t = $("#toast");
    t.textContent = msg;
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (t.hidden = true), 2600);
  }
  async function copy(text, what = "Copied") {
    try { await navigator.clipboard.writeText(text); toast(`${what} ✓`); }
    catch { window.prompt("Copy this:", text); }
  }

  // ---------- crypto ----------
  let KEY = null;
  async function deriveKey(passcode, salt, iterations) {
    const base = await crypto.subtle.importKey("raw", new TextEncoder().encode(passcode), "PBKDF2", false, ["deriveKey"]);
    return crypto.subtle.deriveKey(
      { name: "PBKDF2", salt, iterations, hash: "SHA-256" },
      base, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]
    );
  }
  async function decryptEnvelope(env) {
    const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: fromB64(env.iv) }, KEY, fromB64(env.ct));
    return JSON.parse(new TextDecoder().decode(pt));
  }
  async function encryptEnvelope(obj) {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, KEY, new TextEncoder().encode(JSON.stringify(obj)));
    return { app: "chi-trip", v: 1, iv: toB64(iv), ct: toB64(ct) };
  }

  // ---------- state ----------
  let TRIP = null;            // decrypted private trip info
  let ME = "";
  let syncUrl = null;
  let remote = store.get(LS.cache, { items: [] });   // last known shared state
  let pending = store.get(LS.pending, []);            // ops not yet pushed
  let syncState = "local";    // local | ok | syncing | error

  function applyOps(state, ops) {
    const s = { items: state.items.map((i) => ({ ...i, votes: [...(i.votes || [])] })) };
    for (const op of ops) {
      const idx = s.items.findIndex((i) => i.id === op.id);
      if (op.type === "upsert") {
        if (idx >= 0) s.items[idx] = { ...s.items[idx], ...op.item };
        else s.items.push(op.item);
      } else if (idx < 0) {
        continue;
      } else if (op.type === "delete") {
        s.items.splice(idx, 1);
      } else if (op.type === "patch") {
        Object.assign(s.items[idx], op.fields);
      } else if (op.type === "vote") {
        const v = new Set(s.items[idx].votes);
        op.on ? v.add(op.name) : v.delete(op.name);
        s.items[idx].votes = [...v];
      }
    }
    return s;
  }
  const view = () => applyOps(remote, pending);

  function queue(op) {
    pending.push(op);
    store.set(LS.pending, pending);
    render();
    flush();
  }

  // ---------- sync ----------
  async function pull() {
    const res = await fetch(syncUrl, { headers: { Accept: "application/json" }, cache: "no-store" });
    if (!res.ok) throw new Error(`GET ${res.status}`);
    const body = await res.json();
    if (!body || !body.ct) return { items: [] };
    return decryptEnvelope(body);
  }
  async function push(state) {
    const res = await fetch(syncUrl, {
      method: "PUT",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(await encryptEnvelope(state)),
    });
    if (!res.ok) throw new Error(`PUT ${res.status}`);
  }

  let busy = false;
  async function flush() {
    if (!syncUrl) {
      // Local-only mode: fold pending ops straight into the cache.
      remote = view(); pending = [];
      store.set(LS.cache, remote); store.set(LS.pending, pending);
      setSync("local"); render();
      return;
    }
    if (busy) return;
    busy = true;
    setSync("syncing");
    try {
      const latest = await pull();
      const ops = pending.slice();
      if (ops.length) {
        const merged = applyOps(latest, ops);
        await push(merged);
        remote = merged;
        pending = pending.slice(ops.length);
      } else {
        remote = latest;
      }
      store.set(LS.cache, remote);
      store.set(LS.pending, pending);
      setSync("ok");
    } catch (e) {
      console.warn("sync failed", e);
      setSync("error");
    } finally {
      busy = false;
      render();
      if (pending.length && syncState === "ok") flush();
    }
  }

  function setSync(s) {
    syncState = s;
    const pill = $("#sync-pill");
    const map = {
      local: ["warn", "Not shared"],
      syncing: ["warn", "Syncing…"],
      ok: ["ok", "Synced"],
      error: ["bad", pending.length ? `Offline · ${pending.length} unsaved` : "Offline"],
    };
    pill.className = "pill " + map[s][0];
    pill.textContent = map[s][1];
    $("#sync-setup").hidden = !!syncUrl;
  }

  function inviteLink() {
    return `${location.origin}${location.pathname}#join=${encodeURIComponent(syncUrl)}`;
  }

  function connect(url) {
    syncUrl = url.replace(/^http:/, "https:");
    store.set(LS.sync, syncUrl);
    flush();
  }

  async function createShared() {
    const btn = $("#create-sync");
    btn.disabled = true; btn.textContent = "Creating…";
    try {
      const res = await fetch(JSONBLOB, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify(await encryptEnvelope(view())),
      });
      if (!res.ok) throw new Error(`POST ${res.status}`);
      let id = res.headers.get("X-jsonblob");
      const loc = res.headers.get("Location");
      if (!id && loc) id = loc.split("/").pop();
      if (!id) throw new Error("no blob id in response");
      remote = view(); pending = [];
      store.set(LS.pending, pending);
      connect(`${JSONBLOB}/${id}`);
      copy(inviteLink(), "Invite link copied — paste it in the group chat");
    } catch (e) {
      console.warn(e);
      alert("Couldn't create the shared list automatically (" + e.message + ").\n\nFallback: open jsonblob.com, save an empty {} blob, and paste its URL with “I have a link”.");
    } finally {
      btn.disabled = false; btn.textContent = "Create shared list";
    }
  }

  function parseSyncInput(text) {
    text = (text || "").trim();
    const m = text.match(/#join=([^&\s]+)/);
    if (m) return decodeURIComponent(m[1]);
    if (/^https?:\/\//.test(text)) return text;
    return null;
  }

  // ---------- rendering: stay & rules ----------
  function renderStay() {
    const s = TRIP.stay;
    $("#stay-title").textContent = s.title;
    const a = $("#stay-address");
    a.textContent = s.address;
    a.href = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(s.address)}`;
    $("#stay-directions").href = `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(s.address)}`;
    $("#stay-listing").href = s.listingUrl;
    $("#stay-guidebook").href = s.guidebookUrl;
    $("#stay-in").textContent = s.checkInLabel;
    $("#stay-out").textContent = s.checkOutLabel;

    $("#codes").innerHTML = s.codes.map((c) => `
      <div class="kv"><span>${esc(c.label)}</span>
        <b class="${c.copy ? "copy code-val" : ""}" ${c.copy ? `data-copy="${esc(c.value)}"` : ""}>${esc(c.value)}</b></div>`).join("");
    setCopy($("#res-code"), s.reservationCode);
    setCopy($("#wifi-net"), s.wifi.network);
    setCopy($("#wifi-pass"), s.wifi.password);
    $("#steps").innerHTML = s.checkInSteps.map((x) => `<li>${esc(x)}</li>`).join("");
    $("#sections").innerHTML = s.sections.map((x) => `
      <div class="card"><h3>${esc(x.title)}</h3><div class="small">${esc(x.body)}</div></div>`).join("") + `
      <div class="card">
        <h3>Sharing this page</h3>
        <div class="small muted">Send friends the invite link <b>and</b> the passcode (separately is best).</div>
        <div class="row wrap" style="margin-top:10px">
          <button class="btn" id="copy-invite">Copy invite link</button>
          <button class="btn" id="export">Download backup</button>
          <button class="btn" id="switch-name">I'm not ${esc(ME)}</button>
        </div>
      </div>`;
    $("#rules").innerHTML = TRIP.rules.map((r) => `
      <div class="card rule"><div class="ic">${r.icon}</div>
        <div><b>${esc(r.title)}</b>${r.body ? `<p>${esc(r.body)}</p>` : ""}</div></div>`).join("");
  }
  function setCopy(el, value) { el.textContent = value; el.dataset.copy = value; }

  function renderCountdown() {
    const now = Date.now();
    const inT = Date.parse(TRIP.stay.checkIn), outT = Date.parse(TRIP.stay.checkOut);
    let txt;
    if (now < inT) {
      const h = Math.round((inT - now) / 36e5);
      txt = h < 48 ? `Check-in in ${h} hr${h === 1 ? "" : "s"}` : `Check-in in ${Math.ceil(h / 24)} days`;
    } else if (now < outT) {
      const day = Math.floor((now - inT) / 864e5) + 1;
      txt = `Day ${day} · checkout Mon 10 AM`;
    } else txt = "Trip's over — hope it was great";
    $("#countdown").textContent = `${txt} · hi ${ME}`;
  }

  async function loadWeather() {
    const s = TRIP.stay;
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${s.lat}&longitude=${s.lng}` +
      `&daily=weathercode,temperature_2m_max,temperature_2m_min,precipitation_probability_max` +
      `&temperature_unit=fahrenheit&timezone=America%2FChicago&start_date=2026-10-29&end_date=2026-11-02`;
    const icon = (c) => c === 0 ? "☀️" : c <= 2 ? "🌤️" : c === 3 ? "☁️" : c <= 48 ? "🌫️" : c <= 67 ? "🌧️" : c <= 77 ? "🌨️" : c <= 82 ? "🌦️" : c <= 86 ? "🌨️" : "⛈️";
    try {
      const d = (await (await fetch(url)).json()).daily;
      $("#weather").innerHTML = d.time.map((t, i) => `
        <div class="wx"><div class="small">${DAYS[i] ? DAYS[i].label.split(" ")[0] : t}</div>
          <div class="ic">${icon(d.weathercode[i])}</div>
          <div><span class="hi">${Math.round(d.temperature_2m_max[i])}°</span> <span class="muted">${Math.round(d.temperature_2m_min[i])}°</span></div>
          <div class="small muted">${d.precipitation_probability_max[i] ?? 0}% 💧</div></div>`).join("");
    } catch {
      $("#weather").innerHTML = `<a href="https://forecast.weather.gov/MapClick.php?lat=${s.lat}&lon=${s.lng}" target="_blank" rel="noopener">See forecast →</a>`;
    }
  }

  // ---------- rendering: lists ----------
  function itemCard(it) {
    const votes = it.votes || [];
    const mine = votes.includes(ME);
    const meta = [it.category, it.status === "plan" && it.time ? it.time : "", it.addedBy ? `added by ${it.addedBy}` : ""].filter(Boolean).join(" · ");
    return `
      <div class="card item ${it.status} ${it.done ? "done" : ""}" data-id="${esc(it.id)}">
        <div class="bar"></div>
        <div class="item-body">
          <div class="item-title">${esc(it.title)}</div>
          <div class="item-meta">${esc(meta)}${it.address ? `<br>${esc(it.address)}` : ""}</div>
          ${it.notes ? `<div class="item-notes">${esc(it.notes)}</div>` : ""}
          <div class="item-actions">
            <button class="btn small vote ${mine ? "on" : ""}" data-act="vote" title="${esc(votes.join(", ") || "No votes yet")}">👍 ${votes.length || ""}</button>
            ${it.status === "idea"
              ? `<button class="btn small" data-act="toplan">→ Plan</button>`
              : `<button class="btn small" data-act="done">${it.done ? "Undo" : "✓ Done"}</button>
                 <button class="btn small" data-act="toidea">→ Maybe</button>`}
            <a class="btn small" href="${esc(gmapsSearch(it))}" target="_blank" rel="noopener">Maps</a>
            ${it.url ? `<a class="btn small" href="${esc(it.url)}" target="_blank" rel="noopener">Link</a>` : ""}
            <button class="btn small" data-act="edit">Edit</button>
          </div>
          ${votes.length ? `<div class="item-meta" style="margin-top:6px">👍 ${esc(votes.join(", "))}</div>` : ""}
        </div>
      </div>`;
  }

  function renderLists() {
    const items = view().items;
    const plan = items.filter((i) => i.status === "plan");
    const ideas = items.filter((i) => i.status !== "plan")
      .sort((a, b) => (b.votes?.length || 0) - (a.votes?.length || 0) || (b.createdAt || 0) - (a.createdAt || 0));

    if (!plan.length) {
      $("#plan-list").innerHTML = `<div class="empty">Nothing locked in yet.<br>Add something, or promote an idea from the Maybe list.</div>`;
    } else {
      const timeKey = (t) => {
        const m = String(t || "").match(/(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i);
        if (!m) return 9999;
        let h = +m[1] % 12; if (/pm/i.test(m[3] || "")) h += 12; if (!m[3] && +m[1] < 7) h += 12;
        return h * 60 + (+m[2] || 0);
      };
      $("#plan-list").innerHTML = DAYS.map((d) => {
        const list = plan.filter((i) => (i.day || "") === d.value).sort((a, b) => timeKey(a.time) - timeKey(b.time));
        return list.length ? `<div class="day-head">${esc(d.label)}</div>${list.map(itemCard).join("")}` : "";
      }).join("");
    }
    $("#ideas-list").innerHTML = ideas.length ? ideas.map(itemCard).join("")
      : `<div class="empty">No ideas yet. Search below or tap + on a suggestion.</div>`;
    renderSuggestions();
  }

  let suggFilter = "All";
  function renderSuggestions() {
    const taken = new Set(view().items.map((i) => i.title.toLowerCase()));
    const cats = ["All", "Near us", ...new Set(window.SUGGESTIONS.map((s) => s.category))];
    $("#sugg-filters").innerHTML = cats.map((c) => `<button class="chip ${c === suggFilter ? "on" : ""}" data-filter="${esc(c)}">${esc(c)}</button>`).join("");
    const list = window.SUGGESTIONS.filter((s) => suggFilter === "All" || s.category === suggFilter || (suggFilter === "Near us" && s.area === "Near us"));
    $("#suggestions").innerHTML = list.map((s) => {
      const i = window.SUGGESTIONS.indexOf(s);
      const added = taken.has(s.title.toLowerCase());
      return `
        <div class="card sugg">
          <div class="item-body">
            <div class="item-title">${esc(s.title)}</div>
            <div class="item-meta">${esc(s.category)} · ${esc(s.area)}</div>
            ${s.notes ? `<div class="small muted">${esc(s.notes)}</div>` : ""}
          </div>
          ${added ? `<span class="small muted">Added ✓</span>` : `<button class="btn small" data-sugg="${i}">+ Maybe</button>`}
        </div>`;
    }).join("");
  }

  function render() {
    if (!TRIP) return;
    renderLists();
    if (mapReady) renderMap();
  }

  // ---------- item actions ----------
  function addItem(fields) {
    const item = {
      id: uid(), title: "", status: "idea", day: "", time: "", category: "Other",
      address: "", url: "", notes: "", lat: null, lng: null,
      addedBy: ME, votes: [ME], done: false, createdAt: Date.now(), ...fields,
    };
    queue({ type: "upsert", id: item.id, item });
    toast(`Added to ${item.status === "plan" ? "the plan" : "Maybe"}`);
  }

  function onItemAction(e) {
    const btn = e.target.closest("[data-act]");
    if (!btn) return;
    const id = btn.closest("[data-id]").dataset.id;
    const it = view().items.find((i) => i.id === id);
    if (!it) return;
    switch (btn.dataset.act) {
      case "vote": queue({ type: "vote", id, name: ME, on: !(it.votes || []).includes(ME) }); break;
      case "toplan": openEditor({ ...it, status: "plan" }); break;
      case "toidea": queue({ type: "patch", id, fields: { status: "idea", done: false } }); break;
      case "done": queue({ type: "patch", id, fields: { done: !it.done } }); break;
      case "edit": openEditor(it); break;
    }
  }

  // ---------- editor ----------
  const editor = $("#editor"), form = $("#editor-form");
  let editingId = null;
  form.day.innerHTML = DAYS.map((d) => `<option value="${d.value}">${esc(d.label)}</option>`).join("");

  function openEditor(it = {}) {
    editingId = it.id || null;
    $("#editor-title").textContent = editingId ? "Edit" : "Add something";
    $("#editor-delete").hidden = !editingId;
    $("#geo-status").textContent = it.lat != null ? "📍 On the map" : "";
    for (const k of ["title", "address", "status", "day", "time", "category", "url", "notes", "lat", "lng"]) {
      form[k].value = it[k] ?? (k === "status" ? "idea" : k === "category" ? "Food" : "");
    }
    editor.showModal();
    if (!editingId) form.title.focus();
  }

  async function geocode(q) {
    const url = `https://photon.komoot.io/api/?q=${encodeURIComponent(q)}&lat=41.9&lon=-87.68&bbox=-88.05,41.6,-87.5,42.15&limit=8`;
    const res = await fetch(url);
    if (!res.ok) throw new Error("search failed");
    return (await res.json()).features.map((f) => {
      const p = f.properties;
      const street = [p.housenumber, p.street].filter(Boolean).join(" ");
      return {
        title: p.name || street || q,
        address: [street, p.district || p.locality, p.city].filter(Boolean).join(", "),
        type: (p.osm_value || "").replace(/_/g, " "),
        lat: f.geometry.coordinates[1], lng: f.geometry.coordinates[0],
      };
    });
  }

  $("#geo-btn").addEventListener("click", async () => {
    const q = form.address.value.trim() || form.title.value.trim();
    if (!q) return;
    $("#geo-status").textContent = "Searching…";
    try {
      const [hit] = await geocode(q);
      if (!hit) { $("#geo-status").textContent = "Couldn't find that — it'll still save, just without a pin."; return; }
      form.lat.value = hit.lat; form.lng.value = hit.lng;
      if (!form.address.value.trim()) form.address.value = hit.address;
      $("#geo-status").textContent = `📍 Found: ${hit.title}${hit.address ? " — " + hit.address : ""}`;
    } catch { $("#geo-status").textContent = "Search is unavailable right now."; }
  });
  form.address.addEventListener("input", () => { form.lat.value = ""; form.lng.value = ""; $("#geo-status").textContent = ""; });

  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(form));
    f.lat = f.lat === "" ? null : +f.lat;
    f.lng = f.lng === "" ? null : +f.lng;
    if (editingId) queue({ type: "upsert", id: editingId, item: { ...f, id: editingId } });
    else addItem(f);
    editor.close();
  });
  $("#editor-cancel").addEventListener("click", () => editor.close());
  $("#editor-delete").addEventListener("click", () => {
    if (editingId && confirm("Delete this for everyone?")) { queue({ type: "delete", id: editingId }); editor.close(); }
  });

  // ---------- search ----------
  let lastResults = [];
  $("#search-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const q = $("#search-q").value.trim();
    if (!q) return;
    const box = $("#search-results");
    box.innerHTML = `<div class="small muted">Searching…</div>`;
    const google = `<a class="btn small" href="https://www.google.com/maps/search/${encodeURIComponent(q + " near Chicago")}" target="_blank" rel="noopener">See reviews & hours on Google Maps →</a>`;
    try {
      lastResults = await geocode(q);
      box.innerHTML = (lastResults.length ? lastResults.map((r, i) => `
        <div class="card sugg">
          <div class="item-body"><div class="item-title">${esc(r.title)}</div>
            <div class="item-meta">${esc([r.type, r.address].filter(Boolean).join(" · "))}</div></div>
          <div class="row"><button class="btn small" data-res="${i}" data-to="idea">+ Maybe</button>
            <button class="btn small" data-res="${i}" data-to="plan">+ Plan</button></div>
        </div>`).join("") : `<div class="small muted">No matches — try a specific name.</div>`) + `<div style="margin:8px 0 4px">${google}</div>`;
    } catch {
      box.innerHTML = `<div class="small muted">Search unavailable.</div>${google}`;
    }
  });
  $("#search-results").addEventListener("click", (e) => {
    const b = e.target.closest("[data-res]");
    if (!b) return;
    const r = lastResults[+b.dataset.res];
    const fields = { title: r.title, address: r.address, lat: r.lat, lng: r.lng, category: "Other", status: b.dataset.to };
    if (b.dataset.to === "plan") openEditor(fields);
    else { addItem(fields); b.closest(".card").remove(); }
  });

  // ---------- map ----------
  let map, layer, mapReady = false;
  const pinIcon = (cls, html = "") => L.divIcon({ className: "", html: `<div class="pin ${cls}">${html}</div>`, iconSize: cls === "home" ? [28, 28] : [18, 18], iconAnchor: cls === "home" ? [14, 14] : [9, 9] });

  function initMap() {
    if (mapReady) { map.invalidateSize(); return; }
    map = L.map("map", { zoomControl: true }).setView([TRIP.stay.lat, TRIP.stay.lng], 12);
    L.tileLayer("https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png", {
      maxZoom: 19, subdomains: "abcd",
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://carto.com/">CARTO</a>',
    }).addTo(map);
    layer = L.layerGroup().addTo(map);
    mapReady = true;
    renderMap(true);
  }

  function renderMap(fit = false) {
    layer.clearLayers();
    const s = TRIP.stay;
    const pts = [[s.lat, s.lng]];
    L.marker([s.lat, s.lng], { icon: pinIcon("home", "🏠"), zIndexOffset: 1000 }).addTo(layer)
      .bindPopup(`<b>Our Airbnb</b>${esc(s.address)}`);
    for (const it of view().items) {
      if (it.lat == null) continue;
      pts.push([it.lat, it.lng]);
      L.marker([it.lat, it.lng], { icon: pinIcon(it.status === "plan" ? "plan" : "idea") }).addTo(layer)
        .bindPopup(`<b>${esc(it.title)}</b>${it.status === "plan" ? esc(dayLabel(it.day)) + (it.time ? " · " + esc(it.time) : "") : "Maybe"}
          <br><a href="https://www.google.com/maps/dir/?api=1&origin=${encodeURIComponent(s.address)}&destination=${it.lat},${it.lng}" target="_blank" rel="noopener">Directions from Airbnb</a>`);
    }
    if ($("#show-sugg").checked) {
      const taken = new Set(view().items.map((i) => i.title.toLowerCase()));
      window.SUGGESTIONS.forEach((sg, i) => {
        if (sg.lat == null || taken.has(sg.title.toLowerCase())) return;
        L.marker([sg.lat, sg.lng], { icon: L.divIcon({ className: "", html: `<div class="pin" style="background:var(--sugg);width:14px;height:14px"></div>`, iconSize: [14, 14], iconAnchor: [7, 7] }) })
          .addTo(layer).bindPopup(`<b>${esc(sg.title)}</b>${esc(sg.notes)}<br><button class="btn small" data-sugg="${i}" style="margin-top:6px">+ Add to Maybe</button>`);
      });
    }
    if (fit && pts.length > 1) map.fitBounds(pts, { padding: [40, 40], maxZoom: 14 });
  }

  // ---------- tabs ----------
  function showTab(name) {
    $$(".tabbar button").forEach((b) => b.classList.toggle("active", b.dataset.tab === name));
    $$(".tab").forEach((t) => (t.hidden = t.id !== `tab-${name}`));
    if (name === "map") requestAnimationFrame(initMap);
    window.scrollTo(0, 0);
    try { sessionStorage.setItem("chi.tab", name); } catch {}
  }

  // ---------- boot ----------
  async function unlock(passcode) {
    const env = await (await fetch("trip.enc.json", { cache: "no-store" })).json();
    KEY = await deriveKey(passcode, fromB64(env.salt), env.iterations);
    TRIP = await decryptEnvelope(env);   // throws on a wrong passcode
  }

  async function start() {
    $("#lock").hidden = true;
    $("#app").hidden = false;
    renderStay();
    renderCountdown();
    setInterval(renderCountdown, 60000);
    loadWeather();
    render();
    let tab = "stay";
    try { tab = sessionStorage.getItem("chi.tab") || "stay"; } catch {}
    showTab(tab);
    flush();
    setInterval(() => { if (!document.hidden && syncUrl) flush(); }, POLL_MS);
    document.addEventListener("visibilitychange", () => { if (!document.hidden && syncUrl) flush(); });
  }

  // invite link in the URL?
  const joined = parseSyncInput(location.hash);
  if (joined) {
    store.set(LS.sync, joined);
    history.replaceState(null, "", location.pathname);
  }
  syncUrl = store.get(LS.sync);

  $("#myname").value = store.get(LS.name, "");
  $("#lock-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const pass = $("#passcode").value, name = $("#myname").value.trim();
    const btn = e.submitter || $("#lock-form button");
    btn.disabled = true; btn.textContent = "Unlocking…";
    try {
      await unlock(pass);
      ME = name; store.set(LS.pass, pass); store.set(LS.name, name);
      start();
    } catch {
      $("#lock-error").textContent = "Wrong passcode.";
      $("#lock-error").hidden = false;
    } finally { btn.disabled = false; btn.textContent = "Unlock"; }
  });

  (async () => {
    const pass = store.get(LS.pass), name = store.get(LS.name);
    if (pass && name) {
      try { await unlock(pass); ME = name; start(); return; } catch { store.del(LS.pass); }
    }
    if (joined) $("#lock .muted").textContent = "You've been invited ✶ enter the passcode from the group chat";
  })();

  // ---------- global events ----------
  document.addEventListener("click", (e) => {
    const c = e.target.closest("[data-copy]");
    if (c) return copy(c.dataset.copy);
    const sg = e.target.closest("[data-sugg]");
    if (sg) {
      const s = window.SUGGESTIONS[+sg.dataset.sugg];
      addItem({ title: s.title, category: s.category, notes: s.notes, lat: s.lat, lng: s.lng, status: "idea" });
      if (map) map.closePopup();
      return;
    }
    const f = e.target.closest("[data-filter]");
    if (f) { suggFilter = f.dataset.filter; renderSuggestions(); return; }
    if (e.target.closest("#copy-invite")) {
      return syncUrl ? copy(inviteLink(), "Invite link copied") : toast("Create the shared list first (banner at the top)");
    }
    if (e.target.closest("#export")) {
      const blob = new Blob([JSON.stringify(view(), null, 2)], { type: "application/json" });
      const a = Object.assign(document.createElement("a"), { href: URL.createObjectURL(blob), download: "chicago-trip-backup.json" });
      a.click(); return;
    }
    if (e.target.closest("#switch-name")) {
      const n = prompt("Your name?", ME);
      if (n && n.trim()) { ME = n.trim(); store.set(LS.name, ME); renderStay(); renderCountdown(); render(); }
    }
  });
  $("#plan-list").addEventListener("click", onItemAction);
  $("#ideas-list").addEventListener("click", onItemAction);
  $$(".add-btn").forEach((b) => b.addEventListener("click", () => openEditor({ status: b.dataset.status })));
  $$(".tabbar button").forEach((b) => b.addEventListener("click", () => showTab(b.dataset.tab)));
  $("#show-sugg").addEventListener("change", () => renderMap());
  $("#create-sync").addEventListener("click", createShared);
  $("#paste-sync").addEventListener("click", () => {
    const url = parseSyncInput(prompt("Paste the invite link:"));
    if (url) connect(url); else toast("That doesn't look like an invite link");
  });
  $("#sync-pill").addEventListener("click", () => {
    if (syncUrl) { flush(); copy(inviteLink(), "Synced · invite link copied"); }
    else toast("Not shared yet — use the banner to create the shared list");
  });
})();
