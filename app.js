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
  const APP_VERSION = "17";   // keep in sync with version.json and the ?v= in index.html
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

  // Firebase Realtime Database root links become a single JSON document.
  function normalizeSyncUrl(url) {
    url = url.trim().replace(/^http:/, "https:");
    if (/\.(firebaseio\.com|firebasedatabase\.app)/.test(url) && !/\.json(\?|$)/.test(url)) {
      url = url.replace(/[#?].*$/, "").replace(/\/+$/, "") + "/chicago-trip.json";
    }
    return url;
  }

  // Connect to a storage URL. A brand-new (empty) store gets our current list.
  async function setupShared(url) {
    syncUrl = normalizeSyncUrl(url);
    const res = await fetch(syncUrl, { headers: { Accept: "application/json" }, cache: "no-store" });
    if (!res.ok) throw new Error(res.status === 401 || res.status === 403
      ? "the database refused access — make sure you picked “Start in test mode”"
      : `got HTTP ${res.status}`);
    const body = await res.json().catch(() => null);
    if (body && body.ct) {
      await decryptEnvelope(body);   // throws if it was made with a different passcode
    } else {
      await push(view());
    }
    remote = view(); pending = [];
    store.set(LS.pending, pending);
    connect(syncUrl);
    copy(inviteLink(), "Connected! Invite link copied — paste it in the group chat");
  }

  async function tryInstant() {
    const res = await fetch(JSONBLOB, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(await encryptEnvelope(view())),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    let id = res.headers.get("X-jsonblob");
    const loc = res.headers.get("Location");
    if (!id && loc) id = loc.split("/").pop();
    if (!id) throw new Error("no id returned");
    await setupShared(`${JSONBLOB}/${id}`);
  }

  async function runSetup(btn, label, fn) {
    const err = $("#sync-error");
    err.hidden = true;
    btn.disabled = true; btn.textContent = "Connecting…";
    try {
      await fn();
      $("#sync-dialog").close();
    } catch (e) {
      console.warn(e);
      syncUrl = store.get(LS.sync);
      const msg = e instanceof TypeError ? "couldn't reach it (network or blocked)" : e.name === "OperationError" ? "that list was made with a different passcode" : e.message;
      err.textContent = `Didn't work: ${msg}.`;
      err.hidden = false;
    } finally {
      btn.disabled = false; btn.textContent = label;
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
    const when = it.status === "plan" ? it.time : [it.day ? dayLabel(it.day) : "", it.time].filter(Boolean).join(" ");
    const meta = [it.category, when ? (it.status === "plan" ? when : `📅 ${when}`) : "", it.addedBy ? `added by ${it.addedBy}` : ""].filter(Boolean).join(" · ");
    return `
      <div class="card item ${it.status} ${it.done ? "done" : ""}" data-id="${esc(it.id)}">
        <div class="bar"></div>
        ${it.image ? `<img class="thumb" src="${esc(it.image)}" alt="" loading="lazy" referrerpolicy="no-referrer">` : ""}
        <div class="item-body">
          <div class="item-title">${esc(it.title)}</div>
          <div class="item-meta">${esc(meta)}${it.address ? `<br>${esc(it.address)}` : ""}${distLabel(it) ? `<br><b class="dist">${esc(distLabel(it))}</b>` : ""}</div>
          ${it.notes ? `<div class="item-notes">${esc(it.notes)}</div>` : ""}
          <div class="item-actions">
            <button class="btn small vote ${mine ? "on" : ""}" data-act="vote" title="${esc(votes.join(", ") || "No votes yet")}">👍 ${votes.length || ""}</button>
            ${it.status === "idea"
              ? `<button class="btn small" data-act="when">📅 ${it.day || it.time ? "Change time" : "When"}</button>
                 <button class="btn small" data-act="toplan">→ Plan</button>`
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

  // ---------- distance from the Airbnb ----------
  function milesFromHome(p) {
    if (!TRIP || p.lat == null || p.lng == null) return null;
    const R = 3958.8, rad = Math.PI / 180;
    const dLat = (p.lat - TRIP.stay.lat) * rad, dLng = (p.lng - TRIP.stay.lng) * rad;
    const a = Math.sin(dLat / 2) ** 2 + Math.cos(TRIP.stay.lat * rad) * Math.cos(p.lat * rad) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(a));
  }
  // Straight-line distance with a rough travel time (city grid ≈ 1.3× straight line).
  function distLabel(p) {
    const mi = milesFromHome(p);
    if (mi == null) return "";
    if (mi < 0.1) return "🏠 Right by home";
    const road = mi * 1.3;
    const how = road <= 1.2 ? `~${Math.max(2, Math.round(road * 20))} min walk` : `~${Math.round(6 + road * 3)} min drive`;
    return `🏠 ${mi.toFixed(1)} mi · ${how}`;
  }
  const RADII = [["Any", Infinity], ["< 1 mi", 1], ["< 3 mi", 3], ["< 6 mi", 6]];
  let sortBy = "votes", within = Infinity;
  let maybeView = "events";
  try { maybeView = sessionStorage.getItem("chi.maybeView") || "events"; } catch {}
  const inRange = (p) => within === Infinity || (milesFromHome(p) ?? Infinity) <= within;
  function renderDistControls() {
    $("#dist-controls").innerHTML =
      (maybeView === "places"
        ? `<span class="small muted">Sort</span>` +
          [["votes", "👍 Votes"], ["near", "🏠 Closest"]].map(([v, l]) => `<button class="chip ${sortBy === v ? "on" : ""}" data-sort="${v}">${l}</button>`).join("")
          + `<span class="small muted" style="margin-left:6px">From home</span>`
        : `<span class="small muted">Sorted by date · From home</span>`) +
      RADII.map(([l, v]) => `<button class="chip ${within === v ? "on" : ""}" data-within="${v}">${l}</button>`).join("");
  }

  const timeKey = (t) => {
    const m = String(t || "").match(/(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i);
    if (!m) return 9999;
    let h = +m[1] % 12; if (/pm/i.test(m[3] || "")) h += 12; if (!m[3] && +m[1] < 7) h += 12;
    if (/am/i.test(m[3] || "") && h < 5) h += 24;   // 1 AM sorts after 11 PM
    return h * 60 + (+m[2] || 0);
  };
  const EVENT_SITES = /eventbrite|partiful|lu\.ma|dice\.fm|ra\.co|ticketmaster|axs\.com|seetickets|songkick|bandsintown|meetup\.com/i;
  // Events have a date (or came from an event site); everything else is a place. "kind" overrides.
  const isEvent = (it) => (it.kind ? it.kind === "event" : !!it.day || EVENT_SITES.test(it.url || ""));
  const byDate = (a, b) => (a.day || "9999").localeCompare(b.day || "9999") || timeKey(a.time) - timeKey(b.time);

  function renderLists() {
    const items = view().items;
    const plan = items.filter((i) => i.status === "plan");
    const allIdeas = items.filter((i) => i.status !== "plan");
    const ideas = allIdeas.filter(inRange).sort(sortBy === "near"
      ? (a, b) => (milesFromHome(a) ?? Infinity) - (milesFromHome(b) ?? Infinity)
      : (a, b) => (b.votes?.length || 0) - (a.votes?.length || 0) || (b.createdAt || 0) - (a.createdAt || 0));
    renderDistControls();

    if (!plan.length) {
      $("#plan-list").innerHTML = `<div class="empty">Nothing locked in yet.<br>Add something, or promote an idea from the Maybe list.</div>`;
    } else {
      $("#plan-list").innerHTML = DAYS.map((d) => {
        const list = plan.filter((i) => (i.day || "") === d.value).sort((a, b) => timeKey(a.time) - timeKey(b.time));
        return list.length ? `<div class="day-head">${esc(d.label)}</div>${list.map(itemCard).join("")}` : "";
      }).join("");
    }
    const events = ideas.filter(isEvent).sort(byDate);
    const places = ideas.filter((i) => !isEvent(i));
    let lastDay = null;
    const eventHtml = events.map((it) => {
      const head = it.day !== lastDay ? `<div class="day-head">${esc(dayLabel(it.day || ""))}</div>` : "";
      lastDay = it.day;
      return head + itemCard(it);
    }).join("");
    const nEvents = allIdeas.filter(isEvent).length, nPlaces = allIdeas.length - nEvents;
    $("#maybe-seg").innerHTML = `
      <button type="button" data-view="events" class="${maybeView === "events" ? "on" : ""}">🎟 Events <span class="count">${nEvents}</span></button>
      <button type="button" data-view="places" class="${maybeView === "places" ? "on" : ""}">📍 Places <span class="count">${nPlaces}</span></button>`;
    const shown = maybeView === "events" ? events : places;
    const total = maybeView === "events" ? nEvents : nPlaces;
    const hiddenHere = total - shown.length;
    $("#ideas-list").innerHTML = (maybeView === "events"
      ? (events.length ? eventHtml : `<div class="empty">${nEvents ? "No events that close." : "No events yet.<br>Tap 🔗 Link for one, or <b>Bulk add</b> to paste a bunch at once."}</div>`)
      : (places.length ? places.map(itemCard).join("") : `<div class="empty">${nPlaces ? "Nothing that close yet." : "No places yet. Search below or tap + on a suggestion."}</div>`))
      + (hiddenHere ? `<div class="small muted" style="margin:-4px 0 8px">${hiddenHere} more farther away or without a location.</div>` : "");
    $("#find-section").hidden = maybeView !== "places";
    $("#bulk-btn").hidden = maybeView !== "events";
    renderSuggestions();
  }

  let suggFilter = "All";
  function renderSuggestions() {
    const taken = new Set(view().items.map((i) => i.title.toLowerCase()));
    const cats = ["All", "Infatuation", "Near us", ...new Set(window.SUGGESTIONS.map((s) => s.category))];
    $("#sugg-filters").innerHTML = cats.map((c) => `<button class="chip ${c === suggFilter ? "on" : ""}" data-filter="${esc(c)}">${esc(c)}</button>`).join("");
    const list = window.SUGGESTIONS.filter((s) => suggFilter === "All" || s.category === suggFilter || (suggFilter === "Near us" && s.area === "Near us") || (suggFilter === "Infatuation" && s.source === "Infatuation"))
      .filter((s) => within === Infinity || s.lat == null || inRange(s));
    if (sortBy === "near") list.sort((a, b) => (milesFromHome(a) ?? Infinity) - (milesFromHome(b) ?? Infinity));
    $("#suggestions").innerHTML = list.map((s) => {
      const i = window.SUGGESTIONS.indexOf(s);
      const added = taken.has(s.title.toLowerCase());
      return `
        <div class="card sugg">
          <div class="item-body">
            <div class="item-title">${esc(s.title)} ${s.source ? `<span class="src">${esc(s.source)}</span>` : ""}</div>
            <div class="item-meta">${esc(s.category)} · ${esc(s.area)}${s.url ? ` · <a href="${esc(s.url)}" target="_blank" rel="noopener">guide</a>` : ""}${distLabel(s) ? `<br><b class="dist">${esc(distLabel(s))}</b>` : ""}</div>
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
  function addItem(fields, { quiet = false } = {}) {
    const item = {
      id: uid(), title: "", status: "idea", day: "", time: "", category: "Other",
      address: "", url: "", notes: "", lat: null, lng: null,
      addedBy: ME, votes: [ME], done: false, createdAt: Date.now(), ...fields,
    };
    queue({ type: "upsert", id: item.id, item });
    if (!quiet) toast(`Added to ${item.status === "plan" ? "the plan" : "Maybe"}`);
    if (item.lat == null) autoPin(item);
    return item;
  }

  // Look the place up in the background so it lands on the map without extra typing.
  const norm = (x) => x.toLowerCase().normalize("NFD").replace(/[^a-z0-9 ]/g, "").replace(/\b(the|chicago)\b/g, "").trim();
  async function autoPin(item) {
    try {
      const hits = await geocode(item.address || item.title);
      const t = norm(item.title);
      const hit = item.address ? hits[0] : hits.find((h) => {
        const n = norm(h.title);
        return n && t && (n.includes(t) || t.includes(n));
      });
      if (!hit) return;
      const fields = { lat: hit.lat, lng: hit.lng };
      if (!item.address && hit.address) fields.address = hit.address;
      queue({ type: "patch", id: item.id, fields });
    } catch {}
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
      case "when": openEditor(it); $("#when").scrollIntoView({ block: "center" }); break;
    }
  }

  // ---------- editor ----------
  const editor = $("#editor"), form = $("#editor-form");
  let editingId = null;

  const TIMES = ["Any time"];
  for (let m = 7 * 60; m <= 26 * 60; m += 15) {
    const h24 = Math.floor(m / 60) % 24, h = h24 % 12 || 12;
    TIMES.push(`${h}:${String(m % 60).padStart(2, "0")} ${h24 < 12 ? "AM" : "PM"}`);
  }
  const ROW = 36;
  const wheel = $("#wheel");
  wheel.innerHTML = TIMES.map((t, i) => `<div data-i="${i}">${t}</div>`).join("");

  function wheelSet(value, smooth = false) {
    let i = TIMES.indexOf(value);
    if (i < 0) i = 0;
    wheel.scrollTo({ top: i * ROW, behavior: smooth ? "smooth" : "auto" });
    wheelMark(i);
  }
  function wheelMark(i) {
    $$("div", wheel).forEach((d, j) => d.classList.toggle("on", j === i));
    form.time.value = i === 0 ? "" : TIMES[i];
  }
  let wheelTimer;
  wheel.addEventListener("scroll", () => {
    clearTimeout(wheelTimer);
    wheelTimer = setTimeout(() => wheelMark(Math.max(0, Math.min(TIMES.length - 1, Math.round(wheel.scrollTop / ROW)))), 60);
  });
  wheel.addEventListener("click", (e) => {
    const d = e.target.closest("[data-i]");
    if (d) wheelSet(TIMES[+d.dataset.i], true);
  });

  $("#daybar").innerHTML = DAYS.map((d) => {
    const [dow, mon, num] = d.label.split(" ");
    return `<button type="button" data-v="${d.value}">${d.value ? `${dow}<b>${num}</b>` : `Not sure<b>?</b>`}</button>`;
  }).join("");
  function setDay(v) {
    form.day.value = v;
    $$("#daybar button").forEach((b) => b.classList.toggle("on", b.dataset.v === v));
  }
  $("#daybar").addEventListener("click", (e) => { const b = e.target.closest("button"); if (b) setDay(b.dataset.v); });

  function setStatus(v) {
    form.status.value = v;
    $$("#status-seg button").forEach((b) => b.classList.toggle("on", b.dataset.v === v));
    if (v === "plan" && !form.day.value && !editingId) setDay(defaultDay());
    $("#when-hint").hidden = v === "plan";
    requestAnimationFrame(() => wheelSet(form.time.value || "Any time"));
  }
  $("#status-seg").addEventListener("click", (e) => { const b = e.target.closest("button"); if (b) setStatus(b.dataset.v); });

  function defaultDay() {
    const today = new Date().toLocaleDateString("en-CA", { timeZone: "America/Chicago" });
    return DAYS.some((d) => d.value === today) ? today : DAYS[0].value;
  }

  function openEditor(it = {}) {
    editingId = it.id || null;
    $("#editor-title").textContent = editingId ? "Edit" : "Add something";
    $("#editor-delete").hidden = !editingId;
    $("#geo-status").textContent = it.lat != null ? "📍 On the map" : "";
    $("#link-in").value = "";
    $("#link-status").hidden = true;
    $("#reread").hidden = !(editingId && it.url);
    $("#link-img").hidden = !it.image;
    if (it.image) $("#link-img").src = it.image;
    form.kind.value = it.kind || "";
    for (const k of ["title", "address", "category", "url", "notes", "lat", "lng", "time", "image"]) {
      form[k].value = it[k] ?? (k === "category" ? "Other" : "");
    }
    $("details.more", form).open = !!(it.notes || it.url);
    const wasPlan = editingId && view().items.find((i) => i.id === editingId)?.status === "plan";
    setDay(it.day || (it.status === "plan" && !wasPlan ? defaultDay() : ""));
    editor.showModal();
    setStatus(it.status || "idea");
    wheelSet(form.time.value || "Any time");
    if (!editingId && !it.title) form.title.focus();
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
        osm: p.osm_type && p.osm_id ? `${p.osm_type}${p.osm_id}` : null,
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
    if (editingId) {
      queue({ type: "upsert", id: editingId, item: { ...f, id: editingId } });
      if (f.lat == null) autoPin({ ...f, id: editingId });
    } else addItem(f);
    editor.close();
  });
  $("#editor-cancel").addEventListener("click", () => editor.close());
  $("#editor-delete").addEventListener("click", () => {
    if (editingId && confirm("Delete this for everyone?")) { queue({ type: "delete", id: editingId }); editor.close(); }
  });

  // ---------- search ----------
  const CAT = {
    restaurant: "Food", fast_food: "Food", cafe: "Food", bakery: "Food", ice_cream: "Food", food_court: "Food",
    bar: "Drinks", pub: "Drinks", biergarten: "Drinks", brewery: "Drinks", nightclub: "Nightlife",
    museum: "Museum", gallery: "Museum", park: "Outdoors", garden: "Outdoors", attraction: "Sights", viewpoint: "Sights",
    theatre: "Activity", cinema: "Activity", arts_centre: "Activity", stadium: "Activity",
  };
  const clip = (t, n = 220) => (t && t.length > n ? t.slice(0, n).replace(/\s+\S*$/, "") + "…" : t || "");

  // Extra info for search hits: OSM tags (cuisine, hours, website) plus a Wikipedia summary when the place has one.
  async function placeDetails(results) {
    const ids = results.map((r) => r.osm).filter(Boolean);
    if (!ids.length) return;
    const res = await fetch(`https://nominatim.openstreetmap.org/lookup?osm_ids=${ids.join(",")}&format=json&extratags=1`);
    if (!res.ok) return;
    const byId = {};
    for (const p of await res.json()) byId[`${p.osm_type[0].toUpperCase()}${p.osm_id}`] = p.extratags || {};
    await Promise.all(results.map(async (r) => {
      const t = byId[r.osm];
      if (!t) return;
      r.cuisine = t.cuisine ? t.cuisine.replace(/_/g, " ").replace(/;/g, ", ") : "";
      r.hours = t.opening_hours ? t.opening_hours.replace(/;\s*/g, " · ") : "";
      r.website = t.website || t["contact:website"] || "";
      r.desc = t.description || "";
      let wiki = t.wikipedia && t.wikipedia.startsWith("en:") ? t.wikipedia.slice(3) : "";
      if (!wiki && t.wikidata) {
        try {
          const wd = await (await fetch(`https://www.wikidata.org/w/api.php?action=wbgetentities&ids=${t.wikidata}&props=sitelinks&sitefilter=enwiki&format=json&origin=*`)).json();
          wiki = wd.entities?.[t.wikidata]?.sitelinks?.enwiki?.title || "";
        } catch {}
      }
      if (wiki) {
        try {
          const w = await (await fetch(`https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(wiki.replace(/ /g, "_"))}`)).json();
          if (w.extract) r.desc = w.extract;
        } catch {}
      }
    }));
  }

  function detailsHtml(r) {
    const bits = [];
    if (r.desc) bits.push(`<span>${esc(clip(r.desc))}</span>`);
    if (r.cuisine) bits.push(`<span class="muted">🍽 ${esc(r.cuisine)}</span>`);
    if (r.hours) bits.push(`<span class="muted">🕒 ${esc(r.hours)}</span>`);
    if (r.website) bits.push(`<a href="${esc(r.website)}" target="_blank" rel="noopener">Website →</a>`);
    return bits.join("");
  }

  let lastResults = [];
  $("#search-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const q = $("#search-q").value.trim();
    if (!q) return;
    const box = $("#search-results");
    box.innerHTML = `<div class="small muted">Searching…</div>`;
    const google = `<a class="btn small" href="https://www.google.com/maps/search/${encodeURIComponent(q + " near Chicago")}" target="_blank" rel="noopener">See reviews & hours on Google Maps →</a>`;
    try {
      const results = lastResults = await geocode(q);
      box.innerHTML = (results.length ? results.map((r, i) => `
        <div class="card sugg">
          <div class="item-body"><div class="item-title">${esc(r.title)}</div>
            <div class="item-meta">${esc([r.type, r.address].filter(Boolean).join(" · "))}${distLabel(r) ? `<br><b class="dist">${esc(distLabel(r))}</b>` : ""}</div>
            <div class="res-details" data-details="${i}"></div></div>
          <div class="row"><button class="btn small" data-res="${i}" data-to="idea">+ Maybe</button>
            <button class="btn small" data-res="${i}" data-to="plan">+ Plan</button></div>
        </div>`).join("") : `<div class="small muted">No matches — try a specific name.</div>`) + `<div style="margin:8px 0 4px">${google}</div>`;
      await placeDetails(results).catch(() => {});
      if (lastResults !== results) return;
      results.forEach((r, i) => { const el = $(`[data-details="${i}"]`, box); if (el) el.innerHTML = detailsHtml(r); });
    } catch {
      box.innerHTML = `<div class="small muted">Search unavailable.</div>${google}`;
    }
  });
  $("#search-results").addEventListener("click", (e) => {
    const b = e.target.closest("[data-res]");
    if (!b) return;
    const r = lastResults[+b.dataset.res];
    const notes = [clip(r.desc, 400), r.cuisine && `Cuisine: ${r.cuisine}`, r.hours && `Hours: ${r.hours}`].filter(Boolean).join("\n");
    const fields = {
      title: r.title, address: r.address, lat: r.lat, lng: r.lng, notes, url: r.website || "",
      category: CAT[r.type.replace(/ /g, "_")] || "Other", status: b.dataset.to,
    };
    if (b.dataset.to === "plan") openEditor(fields);
    else { addItem(fields); b.closest(".card").remove(); }
  });

  // ---------- paste a link ----------
  const MONTHS = { oct: 9, october: 9, nov: 10, november: 10 };
  const tripIso = (mon, day) => {
    const iso = `2026-${String(MONTHS[mon.toLowerCase()] + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
    return DAYS.some((x) => x.value === iso) ? iso : null;
  };
  // Pull the trip day and time out of text like "Sat, Oct 31, 2026 at 9:00 PM", "31st Oct", "10/31" or "21:00".
  function findWhen(text) {
    text = String(text).replace(/[-_]/g, " ");
    const out = {};
    const md = text.match(/\b(oct(?:ober)?|nov(?:ember)?)\.?\s+(\d{1,2})(?:st|nd|rd|th)?\b/i);
    const dm = text.match(/\b(\d{1,2})(?:st|nd|rd|th)?\s+(?:of\s+)?(oct(?:ober)?|nov(?:ember)?)\b/i);
    const num = text.match(/\b(10|11)\/(\d{1,2})\b/);
    out.day = (md && tripIso(md[1].slice(0, 3), md[2])) || (dm && tripIso(dm[2].slice(0, 3), dm[1]))
      || (num && tripIso(num[1] === "10" ? "oct" : "nov", num[2])) || undefined;
    let h, m;
    const t = text.match(/\b(\d{1,2})(?::(\d{2}))?\s*([ap])\.?m\b/i);
    const t24 = text.match(/\b(1[3-9]|2[0-3]):([0-5]\d)\b/);
    if (t) { h = (+t[1] % 12) + (/p/i.test(t[3]) ? 12 : 0); m = +t[2] || 0; }
    else if (t24) { h = +t24[1]; m = +t24[2]; }
    if (h != null) {
      let mins = h * 60 + Math.round(m / 15) * 15;
      const hh = Math.floor(mins / 60) % 24, label = `${hh % 12 || 12}:${String(mins % 60).padStart(2, "0")} ${hh < 12 ? "AM" : "PM"}`;
      if (TIMES.includes(label)) out.time = label;
    }
    return out;
  }
  const titleCase = (x) => x.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()).trim();
  // Turn a preview title into a clean name, plus a venue when the site puts one in the title.
  function cleanTitle(title, url) {
    let t = (title || "").replace(/\s*[|–-]\s*(Eventbrite|Partiful|DICE|Dice\.fm)\s*$/i, "");
    let venue = "";
    if (/dice\.fm/i.test(url)) {
      const parts = t.split(/\s+\|\s+/);
      if (parts.length > 1) { t = parts[0]; venue = parts[1]; }
    }
    if (/(^|[/.])ra\.co\/|residentadvisor/i.test(url)) {
      // RA titles look like "RA: Night Moves at Smartbar, Chicago (2026)" or "Night Moves at Smartbar, Chicago · Tickets · RA".
      t = t.replace(/^RA:\s*/i, "").replace(/(\s*[·|]\s*(Tickets|RA|Resident Advisor))+\s*$/i, "").replace(/\s*\(\d{4}\)\s*$/, "");
      const at = t.match(/^(.*\S)\s+at\s+(.+)$/i);
      if (at) { t = at[1]; venue = at[2]; }
    }
    t = t.replace(/\s+Tickets?,?\s+(Mon|Tue|Wed|Thu|Fri|Sat|Sun)[^|]*$/i, "").replace(/\s+Tickets?$/i, "");
    if (!t) {
      const eb = url.match(/eventbrite\.[^/]+\/e\/([^/?#]+?)-tickets-\d+/i);
      const dice = url.match(/dice\.fm\/event\/[a-z0-9]+-([^/?#]+?)(?:-tickets)?(?:[/?#]|$)/i);
      if (eb) t = titleCase(eb[1]);
      else if (dice) t = titleCase(dice[1].replace(/\b\d{1,2}(st|nd|rd|th)-(oct|nov)\b.*$/i, ""));
    }
    return { title: t.trim(), venue: venue.trim() };
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  // Link previews from free services, tried in order until one returns a title.
  // Read the page's own tags: Open Graph for the name and picture, schema.org Event data for the exact
  // start time and venue (Eventbrite, Dice, RA and most ticket sites publish this).
  function parsePage(html, pageUrl) {
    const doc = new DOMParser().parseFromString(html, "text/html");
    const meta = (k) => doc.querySelector(`meta[property="${k}"], meta[name="${k}"]`)?.getAttribute("content") || "";
    const out = { title: meta("og:title") || doc.title, description: meta("og:description") || meta("description"), image: meta("og:image"), finalUrl: meta("og:url") || pageUrl };
    const isEvent = (x) => x && /Event$/.test([].concat(x["@type"] || "").join(" "));
    for (const s of doc.querySelectorAll('script[type="application/ld+json"]')) {
      try {
        let j = JSON.parse(s.textContent);
        j = [].concat(j["@graph"] || j).find(isEvent);
        if (!j) continue;
        out.title = j.name || out.title;
        out.startDate = j.startDate || "";
        const loc = [].concat(j.location || [])[0] || {};
        const a = loc.address || {};
        out.venue = loc.name || "";
        out.venueAddress = typeof a === "string" ? a : [a.streetAddress, a.addressLocality].filter(Boolean).join(", ");
        if (!out.description && j.description) out.description = j.description;
        if (!out.image && j.image) out.image = [].concat(j.image)[0]?.url || [].concat(j.image)[0];
        break;
      } catch {}
    }
    return out;
  }

  // Give up on a preview service after a few seconds so one slow site can't stall a bulk add.
  function timedFetch(url, opts = {}, ms = 9000) {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), ms);
    return fetch(url, { ...opts, signal: ctl.signal }).finally(() => clearTimeout(t));
  }

  const PREVIEWERS = [
    async (url) => {
      for (let attempt = 0; attempt < 3; attempt++) {
        const res = await timedFetch(`https://api.microlink.io/?url=${encodeURIComponent(url)}&palette=false&audio=false&video=false&iframe=false`);
        if (res.status === 429 || res.status >= 500) { await sleep(1500 * (attempt + 1)); continue; }
        const body = await res.json();
        const d = body.status === "success" ? body.data || {} : {};
        return { title: d.title, description: d.description, image: d.image?.url, finalUrl: d.url };
      }
      return {};
    },
    async (url) => {
      // Downloads the page (following share-link redirects) so we can read its tags ourselves.
      const res = await timedFetch(`https://api.allorigins.win/get?url=${encodeURIComponent(url)}`);
      if (!res.ok) return {};
      const body = await res.json();
      if (!body.contents) return {};
      return parsePage(body.contents, body.status?.url || url);
    },
    async (url) => {
      // Renders the page first, so it can read sites that build their pages with JavaScript.
      const res = await timedFetch(`https://r.jina.ai/${url}`, { headers: { Accept: "application/json", "X-Return-Format": "markdown" } });
      if (!res.ok) return {};
      const d = (await res.json()).data || {};
      const text = String(d.content || "").replace(/!\[[^\]]*\]\([^)]*\)/g, "").replace(/\[([^\]]*)\]\([^)]*\)/g, "$1");
      return { title: d.title, description: d.description || clip(text.replace(/\s+/g, " "), 400), image: d.images ? Object.values(d.images)[0] : "", extra: text.slice(0, 4000), finalUrl: d.url };
    },
    async (url) => {
      const res = await timedFetch(`https://api.dub.co/metatags?url=${encodeURIComponent(url)}`);
      if (!res.ok) return {};
      const d = await res.json();
      return { title: d.title, description: d.description, image: d.image };
    },
  ];
  // Titles that mean we got a gate, redirect or app-download page instead of the event.
  const JUNK_TITLE = {
    test: (t) => /^(just a moment|attention required|access denied|forbidden|404|page not found|redirecting|loading|please wait|one moment|checking your browser|verify(ing)? you are human|are you a robot|security check|captcha|open in app|get the .*app|download )/i.test(t)
      || /^(dice|dice\.fm|partiful|eventbrite|ticketmaster|luma|ra|ra\.co|resident advisor)(\s*[|·–-]\s*(the\s+)?(best|live|official|discover|find|buy|tickets?|events?|music|parties|app|home)\b.*)?$/i.test(t),
  };
  const SHORT_LINK = /^https?:\/\/(link\.dice\.fm|dice\.link|evt\.to|eventbrite\.com\/e\/?$|bit\.ly|tinyurl\.com|t\.co|lnkd\.in|ow\.ly|app\.link|[a-z0-9-]+\.app\.link|go\.dice\.fm)\//i;
  async function fetchMeta(url) {
    let finalUrl = "";
    // Ticket and share links: read the page itself first, since that's where the exact date and venue live.
    const order = EVENT_SITES.test(url) || SHORT_LINK.test(url) ? [1, 0, 2, 3] : [0, 1, 2, 3];
    for (const get of order.map((i) => PREVIEWERS[i])) {
      try {
        const d = await get(url);
        if (d?.finalUrl && d.finalUrl !== url && !finalUrl) finalUrl = d.finalUrl;
        if (d && d.title && !JUNK_TITLE.test(d.title.trim())) return { ...d, finalUrl: d.finalUrl || finalUrl };
      } catch {}
    }
    return { finalUrl };
  }

  // Everything we can learn about a link from its share preview.
  async function previewLink(url) {
    const shareUrl = url;
    let meta = await fetchMeta(url);
    // Share links (link.dice.fm and friends) forward to the real page — read that one instead.
    const real = meta.finalUrl && /^https?:\/\//.test(meta.finalUrl) && meta.finalUrl.replace(/[?#].*$/, "") !== url.replace(/[?#].*$/, "") ? meta.finalUrl : "";
    if (real && (!meta.title || SHORT_LINK.test(url))) {
      const again = await fetchMeta(real);
      if (again.title || !meta.title) meta = { ...again, finalUrl: real };
      url = real.replace(/[?&](sharer_id|utm_[a-z]+|aff|ref)=[^&#]*/g, "").replace(/\?$/, "");
    }
    const data = { title: meta.title, description: meta.description, image: { url: meta.image } };
    const { title, venue } = cleanTitle(data.title, url);
    let when = findWhen(`${data.title || ""} ${data.description || ""} ${decodeURIComponent(url)}`);
    const sd = String(meta.startDate || "").match(/^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})/);
    if (sd) {
      const h = +sd[2], m = Math.round(+sd[3] / 15) * 15, mins = h * 60 + m, hh = Math.floor(mins / 60) % 24;
      const label = `${hh % 12 || 12}:${String(mins % 60).padStart(2, "0")} ${hh < 12 ? "AM" : "PM"}`;
      if (DAYS.some((d) => d.value === sd[1])) when.day = sd[1];
      if (TIMES.includes(label)) when.time = label;
    }
    if (!when.day && meta.extra) when = { ...findWhen(meta.extra), ...Object.fromEntries(Object.entries(when).filter(([, v]) => v)) };
    const event = EVENT_SITES.test(url);
    return {
      ok: !!data.title,
      title, day: when.day || "", time: when.time || "",
      notes: clip(data.description || "", 500),
      image: data.image?.url || "",
      address: meta.venueAddress ? [meta.venue, meta.venueAddress].filter(Boolean).join(", ")
        : (venue || meta.venue) ? (/chicago/i.test(venue || meta.venue) ? (venue || meta.venue) : `${venue || meta.venue}, Chicago`) : "",
      url, shareUrl: shareUrl !== url ? shareUrl : "",
      kind: event ? "event" : "",
      category: event ? "Nightlife" : "",
    };
  }

  async function importLink(raw, { force = false } = {}) {
    const url = (raw || "").trim().match(/https?:\/\/\S+/)?.[0];
    const st = $("#link-status");
    if (!url) return;
    st.hidden = false;
    st.textContent = "Reading the link…";
    form.url.value = url;
    const p = await previewLink(url);
    if (p.ok) form.url.value = p.url;
    if (force && p.ok) {
      for (const k of ["title", "notes", "address"]) if (p[k]) form[k].value = "";
      if (p.address) { form.lat.value = ""; form.lng.value = ""; }
    }
    if (p.kind) form.kind.value = p.kind;
    if (p.category && (!form.category.value || form.category.value === "Other")) form.category.value = p.category;
    if (p.title && !form.title.value.trim()) form.title.value = p.title;
    if (p.notes && !form.notes.value.trim()) form.notes.value = p.notes;
    if (p.address && !form.address.value.trim()) form.address.value = p.address;
    if (p.image) {
      form.image.value = p.image;
      $("#link-img").src = p.image;
      $("#link-img").hidden = false;
    }
    if (p.day) setDay(p.day);
    if (p.time) { form.time.value = p.time; requestAnimationFrame(() => wheelSet(p.time)); }
    $("details.more", form).open = true;
    st.textContent = p.ok
      ? `✓ Got it${p.day ? ` — ${dayLabel(p.day)}${p.time ? " · " + p.time : ""}` : " — pick a day"}`
      : "Couldn't read that link — saved it, just type a name.";
    if (!form.title.value.trim()) form.title.focus();
  }
  $("#reread").addEventListener("click", () => importLink(form.url.value, { force: true }));
  $("#link-in").addEventListener("input", (e) => { if (/https?:\/\/\S+\.\S+/.test(e.target.value)) importLink(e.target.value); });
  $("#link-paste").addEventListener("click", async () => {
    try {
      const text = await navigator.clipboard.readText();
      $("#link-in").value = text;
      importLink(text);
    } catch { $("#link-in").focus(); toast("Long-press the box and tap Paste"); }
  });

  // ---------- bulk add ----------
  const bulk = $("#bulk-dialog");
  const urlsIn = (text) => [...new Set((String(text).match(/https?:\/\/[^\s<>"')\]]+/g) || []).map((u) => u.replace(/[.,;!]+$/, "")))];
  function bulkCount() {
    const n = urlsIn($("#bulk-text").value).length;
    $("#bulk-go").textContent = n ? `Add ${n} link${n === 1 ? "" : "s"}` : "Add all";
    $("#bulk-go").disabled = !n;
  }
  $("#bulk-text").addEventListener("input", bulkCount);
  $("#bulk-paste").addEventListener("click", async () => {
    try { $("#bulk-text").value += (await navigator.clipboard.readText()) + "\n"; bulkCount(); }
    catch { $("#bulk-text").focus(); toast("Long-press the box and tap Paste"); }
  });
  $("#bulk-cancel").addEventListener("click", () => bulk.close());
  function openBulk() {
    $("#bulk-text").value = "";
    $("#bulk-log").innerHTML = "";
    $("#bulk-text").hidden = false;
    $("#bulk-go").hidden = false;
    $("#bulk-paste").hidden = false;
    $("#bulk-retry").hidden = true;
    $("#bulk-cancel").textContent = "Cancel";
    bulkCount();
    bulk.showModal();
  }
  let bulkFailed = [];
  const shortUrl = (u) => u.replace(/^https?:\/\/(www\.)?/, "");
  function bulkRow(i, p, title) {
    const li = $(`[data-b="${i}"]`, $("#bulk-log"));
    if (!li) return;
    li.innerHTML = p.ok
      ? `✅ <b>${esc(title)}</b>${p.day ? ` <span class="muted">· ${esc(dayLabel(p.day))}${p.time ? " " + esc(p.time) : ""}</span>` : ` <span class="muted">· no date found — set it with 📅</span>`}`
      : `⚠️ <b>${esc(title)}</b> <span class="muted">· saved, but the site didn't share details</span>`;
  }
  function setRetry() {
    $("#bulk-retry").hidden = !bulkFailed.length;
    $("#bulk-retry").textContent = `↻ Retry ${bulkFailed.length} that didn't work`;
  }
  $("#bulk-go").addEventListener("click", async () => {
    const have = new Set(view().items.flatMap((i) => [i.url, i.shareUrl]).filter(Boolean).map((u) => u.replace(/\/+$/, "")));
    const urls = urlsIn($("#bulk-text").value);
    const log = $("#bulk-log");
    $("#bulk-text").hidden = true;
    $("#bulk-go").hidden = true;
    $("#bulk-paste").hidden = true;
    $("#bulk-cancel").textContent = "Close";
    log.innerHTML = urls.map((u, i) => `<li data-b="${i}"><span class="muted">⏳ ${esc(shortUrl(u).slice(0, 60))}</span></li>`).join("");
    bulkFailed = [];
    let added = 0;
    // One at a time: the free preview services turn away simultaneous requests.
    for (let i = 0; i < urls.length; i++) {
      const u = urls[i];
      if (have.has(u.replace(/\/+$/, ""))) {
        $(`[data-b="${i}"]`, log).innerHTML = `<span class="muted">↩︎ Already on the list · ${esc(shortUrl(u).slice(0, 50))}</span>`;
        continue;
      }
      $(`[data-b="${i}"]`, log).innerHTML = `<span class="muted">🔎 Reading ${esc(shortUrl(u).slice(0, 55))}…</span>`;
      const p = await previewLink(u);
      const title = p.title || shortUrl(u).split(/[/?#]/)[0];
      const item = addItem({ ...p, title, kind: p.kind || "event", category: p.category || "Nightlife", status: "idea" }, { quiet: true });
      added++;
      bulkRow(i, p, title);
      if (!p.ok) bulkFailed.push({ i, url: u, id: item.id });
      await sleep(400);
    }
    setRetry();
    toast(`Added ${added} event${added === 1 ? "" : "s"} to Maybe`);
  });
  $("#bulk-retry").addEventListener("click", async () => {
    const todo = bulkFailed;
    bulkFailed = [];
    $("#bulk-retry").hidden = true;
    for (const f of todo) {
      $(`[data-b="${f.i}"]`, $("#bulk-log")).innerHTML = `<span class="muted">🔎 Trying again: ${esc(shortUrl(f.url).slice(0, 50))}…</span>`;
      await sleep(1200);
      const p = await previewLink(f.url);
      const cur = view().items.find((x) => x.id === f.id);
      if (p.ok && cur) {
        const fields = {};
        for (const k of ["title", "notes", "image", "day", "time", "address"]) if (p[k] && !(k !== "title" && cur[k])) fields[k] = p[k];
        queue({ type: "patch", id: f.id, fields });
        if (fields.address && cur.lat == null) autoPin({ ...cur, ...fields });
      }
      if (!p.ok) bulkFailed.push(f);
      bulkRow(f.i, p, p.title || cur?.title || shortUrl(f.url));
    }
    setRetry();
  });

  // ---------- map ----------
  let map, layer, mapReady = false;
  const pinIcon = (cls, html = "") => L.divIcon({ className: "", html: `<div class="pin ${cls}">${html}</div>`, iconSize: cls === "home" ? [28, 28] : [18, 18], iconAnchor: cls === "home" ? [14, 14] : [9, 9] });

  function initMap() {
    if (mapReady) { map.invalidateSize(); return; }
    map = L.map("map", { zoomControl: true }).setView([TRIP.stay.lat, TRIP.stay.lng], 12);
    L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 19,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
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
        .bindPopup(`<b>${esc(it.title)}</b>${it.status === "plan" ? "" : "Maybe · "}${it.day || it.status === "plan" ? esc(dayLabel(it.day)) : ""}${it.time ? " · " + esc(it.time) : ""}
          ${distLabel(it) ? `<br>${esc(distLabel(it))}` : ""}<br><a href="https://www.google.com/maps/dir/?api=1&origin=${encodeURIComponent(s.address)}&destination=${it.lat},${it.lng}" target="_blank" rel="noopener">Directions from Airbnb</a>`);
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
    if (!syncUrl && TRIP.syncUrl) { syncUrl = TRIP.syncUrl; store.set(LS.sync, syncUrl); }
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

  // ---------- updates ----------
  async function checkForUpdate() {
    try {
      const v = (await (await fetch(`version.json?t=${Date.now()}`, { cache: "no-store" })).json()).v;
      $("#update-banner").hidden = String(v) === APP_VERSION;
    } catch {}
  }
  async function hardReload() {
    $("#reload").classList.add("spin");
    try { if (syncUrl) await flush(); } catch {}
    location.replace(`${location.pathname}?r=${Date.now()}`);
  }
  $("#reload").addEventListener("click", hardReload);
  $("#update-banner").addEventListener("click", hardReload);
  checkForUpdate();
  setInterval(checkForUpdate, 5 * 60000);
  document.addEventListener("visibilitychange", () => { if (!document.hidden) checkForUpdate(); });

  // ---------- global events ----------
  document.addEventListener("click", (e) => {
    const c = e.target.closest("[data-copy]");
    if (c) return copy(c.dataset.copy);
    const sg = e.target.closest("[data-sugg]");
    if (sg) {
      const s = window.SUGGESTIONS[+sg.dataset.sugg];
      addItem({ title: s.title, category: s.category, notes: s.notes, url: s.url || "", lat: s.lat, lng: s.lng, status: "idea" });
      if (map) map.closePopup();
      return;
    }
    const mv = e.target.closest("[data-view]");
    if (mv) { maybeView = mv.dataset.view; try { sessionStorage.setItem("chi.maybeView", maybeView); } catch {} renderLists(); return; }
    const so = e.target.closest("[data-sort]");
    if (so) { sortBy = so.dataset.sort; renderLists(); return; }
    const wi = e.target.closest("[data-within]");
    if (wi) { within = +wi.dataset.within; renderLists(); return; }
    const f = e.target.closest("[data-filter]");
    if (f) { suggFilter = f.dataset.filter; renderSuggestions(); return; }
    if (e.target.closest("#copy-invite")) {
      return syncUrl ? copy(inviteLink(), "Invite link copied") : toast("Set up the shared list first (banner at the top)");
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
  $("#bulk-btn").addEventListener("click", openBulk);
  $$(".link-btn").forEach((b) => b.addEventListener("click", () => { openEditor({ status: b.dataset.status }); $("#link-in").focus(); }));
  $$(".tabbar button").forEach((b) => b.addEventListener("click", () => showTab(b.dataset.tab)));
  $("#show-sugg").addEventListener("change", () => renderMap());
  $("#setup-sync").addEventListener("click", () => { $("#sync-error").hidden = true; $("#sync-dialog").showModal(); });
  $("#sync-cancel").addEventListener("click", () => $("#sync-dialog").close());
  $("#sync-form").addEventListener("submit", (e) => {
    e.preventDefault();
    const url = parseSyncInput($("#sync-url").value);
    if (!url) { $("#sync-error").textContent = "Paste the database link (starts with https://)."; $("#sync-error").hidden = false; return; }
    runSetup($("#sync-connect"), "Connect", () => setupShared(url));
  });
  $("#try-instant").addEventListener("click", () => runSetup($("#try-instant"), "Try instant setup instead", tryInstant));
  $("#paste-sync").addEventListener("click", () => {
    const url = parseSyncInput(prompt("Paste the invite link:"));
    if (url) connect(normalizeSyncUrl(url)); else toast("That doesn't look like an invite link");
  });
  $("#sync-pill").addEventListener("click", () => {
    if (syncUrl) { flush(); copy(inviteLink(), "Synced · invite link copied"); }
    else toast("Not shared yet — use the banner to set up the shared list");
  });
})();
