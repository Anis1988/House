// Scenes (lights + TV + screen + Nest + cameras in one tap) and the timers that run them, including
// sunrise/sunset and Bedtime. Shown on the Lights side as its Scenes and Timers tabs.
// Scenes and timers are kept natively (SceneTimers/HouseActions), so timers run with the app closed.

(() => {
  let scenes = [];  // [{ id, name, icon, lights: { <bulb id> | "*": {...} }, tv?, screen?, nest?, cams? }]
  let timers = [];  // [{ id, scene: "custom:<id>", when: "time"|"sunrise"|"sunset", minutes, offset, days, fade, on }]
  let draft = null;
  const bulbs = () => House.byId("lights")?.list?.() || [];
  const pct = (v) => Math.max(1, Math.round(v / 65535 * 100));
  const fmtTime = (m) => new Date(2000, 0, 1, Math.floor(m / 60), m % 60).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  const fmtClock = (ms) => new Date(ms).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  const SCENE_ICONS = ["bulb", "sun", "moon", "tv", "star", "leaf", "flame", "home", "bell", "power"];

  // Which other devices are set up, so the editor only offers those.
  const has = {
    tv: () => !!(store.get("lg.ip") && store.get("lg.key")),
    screen: () => !!(store.get("ss.ip") && store.get("ss.token")),
    nest: () => !!store.json("nest.tok", null)?.refresh,
    cams: () => !!store.json("wyze.acct", null),
  };
  const fahrenheit = () => store.get("nest.unit", "C") === "F";
  const showTemp = (c) => (fahrenheit() ? `${Math.round(c * 9 / 5 + 32)}°F` : `${Math.round(c * 2) / 2}°C`);
  const NEST_MODES = [["HEAT", "Heat"], ["COOL", "Cool"], ["HEATCOOL", "Heat · Cool"], ["ECO", "Eco"], ["OFF", "Off"]];

  /* ---- Scene cards ---- */
  function summary(s) {
    const parts = [];
    const v = s.lights || {};
    if (v["*"]) parts.push(v["*"].mode === "off" ? "All lights off" : `All lights ${v["*"].bri || 100}%`);
    else {
      const ls = Object.values(v), on = ls.filter((x) => x.mode === "on"), off = ls.length - on.length;
      if (on.length) parts.push(`${on.length} light${on.length === 1 ? "" : "s"} on`);
      if (off) parts.push(`${off} off`);
    }
    if (s.tv) parts.push(`TV ${s.tv.power}`);
    if (s.screen) parts.push(`Screen ${s.screen.power}`);
    if (s.nest) parts.push(s.nest.mode === "ECO" ? "Nest Eco" : s.nest.mode === "OFF" ? "Nest off" : s.nest.temp ? `Nest ${showTemp(s.nest.temp)}` : "Nest");
    if (s.cams) parts.push(`Cameras ${s.cams.power}`);
    return parts.join(" · ") || "Nothing set yet";
  }
  function renderScenes() {
    const html = scenes.map((s) => `
      <div class="scene glass mine" data-run="${esc(s.id)}" role="button" tabindex="0" style="--sc: var(--grad); --sc0: var(--a1)">
        <button class="scene-edit" data-edit="${esc(s.id)}" aria-label="Edit ${esc(s.name)}">${svg('<path d="M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/>')}</button>
        <span class="ic">${svg(s.icon || "star")}</span><b>${esc(s.name)}</b><span>${esc(summary(s))}</span>
      </div>`).join("") + `<button class="scene new-scene" data-new>${svg("plus")}<b>New scene</b><span>Lights, TV, Nest, cameras…</span></button>`;
    document.querySelectorAll(".scenes-grid").forEach((g) => (g.innerHTML = html));
  }

  async function run(s, trying) {
    buzz(14);
    toast(trying ? "Trying it…" : `${s.name}…`);
    try {
      const r = await Lights.runScene({ scene: s });
      House.byId("lights")?.applyScene?.(s);
      const failed = r.failed || [];
      if (failed.length) toast(`${s.name}: ${failed.join(", ")} didn't answer`, true);
      else toast(trying ? "That's how it looks" : s.name);
    } catch { toast("Couldn't run the scene", true); }
  }

  /* ---- Scene editor ---- */
  const snapshot = () => Object.fromEntries(bulbs().filter((l) => l.online).map((l) => [l.id, l.on
    ? { mode: "on", bri: pct(l.bri), ...(l.tunable ? { kelvin: l.kelvin } : {}), ...(l.color && l.sat > 3000 ? { hue: Math.round(l.hue / 65535 * 360), sat: Math.round(l.sat / 65535 * 100) } : {}) }
    : { mode: "off" }]));
  const seg = (attr, value, opts) => `<div class="mini-seg">${opts.map(([v, t]) => `<button ${attr}="${v}" class="${v === value ? "on" : ""}">${t}</button>`).join("")}</div>`;

  function openScene(id) {
    const old = scenes.find((x) => x.id === id);
    draft = old ? JSON.parse(JSON.stringify(old)) : { id: "s" + Date.now().toString(36), name: "", icon: "star", lights: snapshot() };
    // A built-in "every light" setting becomes one row per bulb, so each can be changed.
    if (draft.lights?.["*"]) {
      const every = draft.lights["*"];
      draft.lights = Object.fromEntries(bulbs().map((l) => [l.id, { ...every }]));
    }
    const body = House.sheet(`
      <h3>${old ? "Edit scene" : "New scene"}</h3>
      <label class="fld">Name<input class="field" id="scName" maxlength="24" placeholder="Leaving" value="${esc(draft.name)}"></label>
      <div class="icon-pick" id="scIcons">${SCENE_ICONS.map((i) => `<button data-icon="${i}" aria-label="${i}">${svg(i)}</button>`).join("")}</div>
      <div class="label" style="margin-top:18px">Lights</div>
      <button class="ghost center" id="scCopy">Copy how the lights are now</button>
      <div id="scRows"></div>
      <div id="scDevices"></div>
      <div class="grid2" style="margin-top:14px;margin-bottom:0">
        <button class="ghost center" id="scTry">Try it</button>
        <button class="primary" id="scSave">Save</button>
      </div>
      ${old ? `<div class="list"><button class="ghost center danger" id="scDelete">Delete scene</button></div>` : ""}`);
    House.onSheetClose = () => { draft = null; };
    const paintIcons = () => body.querySelectorAll("[data-icon]").forEach((b) => b.classList.toggle("on", b.dataset.icon === draft.icon));
    paintIcons();
    body.querySelector("#scIcons").onclick = (e) => { const b = e.target.closest("[data-icon]"); if (b) { buzz(6); draft.icon = b.dataset.icon; paintIcons(); } };
    body.querySelector("#scName").oninput = (e) => (draft.name = e.target.value);
    body.querySelector("#scCopy").onclick = () => { buzz(); draft.lights = snapshot(); paintRows(); toast("Copied from the lights"); };
    body.querySelector("#scTry").onclick = () => run({ ...draft, name: draft.name || "Scene" }, true);
    body.querySelector("#scSave").onclick = () => {
      draft.name = draft.name.trim();
      if (!draft.name) { toast("Give the scene a name", true); body.querySelector("#scName").focus(); return; }
      const i = scenes.findIndex((x) => x.id === draft.id);
      if (i >= 0) scenes[i] = draft; else scenes.push(draft);
      const name = draft.name;
      saveScenes();
      House.closeSheet();
      toast(`Saved “${name}”`);
    };
    if (old) body.querySelector("#scDelete").onclick = () => {
      const used = timers.filter((t) => sceneKey(t.scene) === old.id).length;
      if (!confirm(`Delete “${old.name}”?${used ? ` Its ${used} timer${used === 1 ? "" : "s"} will be deleted too.` : ""}`)) return;
      scenes = scenes.filter((x) => x.id !== old.id);
      if (used) { timers = timers.filter((t) => sceneKey(t.scene) !== old.id); saveTimers(); }
      saveScenes();
      House.closeSheet();
      toast("Scene deleted");
    };
    paintRows();
    paintDevices();
  }

  function paintRows() {
    const rooms = {};
    for (const l of bulbs()) (rooms[l.group || "Other"] ||= []).push(l);
    $("scRows").innerHTML = Object.keys(rooms).sort().map((room) => `<div class="slide-lbl" style="margin:16px 0 4px">${esc(room)}</div>` +
      rooms[room].sort((a, b) => a.label.localeCompare(b.label, undefined, { numeric: true })).map((l) => {
        const s = draft.lights[l.id];
        const mode = s ? s.mode : "leave";
        const b = s?.bri || 100;
        return `<div class="sc-row" data-bulb="${l.id}">
          <div class="row"><b class="grow">${esc(l.label)}</b>${seg("data-mode", mode, [["on", "On"], ["off", "Off"], ["leave", "Leave"]])}</div>
          ${mode === "on" ? `<div class="slide" style="margin-top:8px">${svg("sun")}<input type="range" min="1" max="100" value="${b}" style="--p:${b}%" data-sbri><output>${b}%</output></div>
            ${l.tunable ? `<div class="slide" style="margin-top:8px">${svg("thermo")}<input type="range" class="kelvin" min="${l.kMin}" max="${l.kMax}" step="100" value="${s.kelvin || l.kelvin}" data-skel><output>${s.kelvin || l.kelvin}K</output></div>` : ""}` : ""}
        </div>`;
      }).join("")).join("") || `<p class="note">No lights found yet. Open the Lights side once.</p>`;
    const rows = $("scRows");
    rows.onclick = (e) => {
      const m = e.target.closest("[data-mode]");
      if (!m) return;
      buzz(6);
      const id = m.closest("[data-bulb]").dataset.bulb, l = bulbs().find((x) => x.id === id);
      if (m.dataset.mode === "leave") delete draft.lights[id];
      else if (m.dataset.mode === "off") draft.lights[id] = { mode: "off" };
      else draft.lights[id] = { mode: "on", bri: draft.lights[id]?.bri || pct(l.bri) || 100, ...(l.tunable ? { kelvin: l.kelvin } : {}) };
      paintRows();
    };
    rows.oninput = (e) => {
      const row = e.target.closest("[data-bulb]");
      if (!row) return;
      const s = draft.lights[row.dataset.bulb], v = +e.target.value;
      if (e.target.matches("[data-sbri]")) { s.bri = v; setSlider(e.target, e.target.nextElementSibling, v); }
      if (e.target.matches("[data-skel]")) { s.kelvin = v; setSlider(e.target, e.target.nextElementSibling, v, "K"); }
    };
  }

  // TV, screen, Nest and cameras: only the ones that are set up.
  function paintDevices() {
    const box = $("scDevices");
    const apps = store.json("lg.apps", []);
    const vols = ["", ...Array.from({ length: 12 }, (_, i) => String((i + 1) * 5))];
    const block = (title, icon, inner) => `<div class="label" style="margin-top:18px">${title}</div><div class="sc-row" style="border-top:0;padding-top:0">${inner}</div>`;
    let html = "";
    if (has.tv()) {
      const p = draft.tv;
      html += block("LG TV", "tv", `<div class="row"><b class="grow">TV</b>${seg("data-tv", p?.power || "leave", [["on", "On"], ["off", "Off"], ["leave", "Leave"]])}</div>
        ${p?.power === "on" ? `<div class="row" style="margin-top:8px">
          <select class="field" id="scTvApp" aria-label="App"><option value="">Don't change the app</option>${apps.map((a) => `<option value="${esc(a.id)}" ${a.id === p.app ? "selected" : ""}>${esc(a.title)}</option>`).join("")}</select>
          <select class="field" id="scTvVol" aria-label="Volume" style="flex:none;width:120px">${vols.map((v) => `<option value="${v}" ${String(p.volume ?? "") === v ? "selected" : ""}>${v ? `Vol ${v}` : "Volume"}</option>`).join("")}</select>
        </div>${apps.length ? "" : `<p class="note">Open the TV's Apps tab once to pick an app here.</p>`}` : ""}`);
    }
    if (has.screen()) html += block("Samsung screen", "screen", `<div class="row"><b class="grow">Screen</b>${seg("data-screen", draft.screen?.power || "leave", [["on", "On"], ["off", "Off"], ["leave", "Leave"]])}</div>`);
    if (has.nest()) {
      const p = draft.nest;
      const t = p?.temp ?? 21;
      const shown = fahrenheit() ? Math.round(t * 9 / 5 + 32) : t;
      html += block("Nest", "thermo", `<div class="row"><b class="grow">Thermostat</b>${seg("data-nest", p ? "set" : "leave", [["set", "Set"], ["leave", "Leave"]])}</div>
        ${p ? `<div class="row" style="margin-top:8px"><select class="field" id="scNestMode">${NEST_MODES.map(([v, n]) => `<option value="${v}" ${v === p.mode ? "selected" : ""}>${n}</option>`).join("")}</select></div>
          ${["HEAT", "COOL", "HEATCOOL"].includes(p.mode) ? `<div class="slide" style="margin-top:8px">${svg("thermo")}<input type="range" id="scNestTemp" min="${fahrenheit() ? 50 : 10}" max="${fahrenheit() ? 86 : 30}" step="${fahrenheit() ? 1 : 0.5}" value="${shown}"><output>${showTemp(t)}</output></div>` : ""}` : ""}`);
    }
    if (has.cams()) html += block("Wyze cameras", "cam", `<div class="row"><b class="grow">All cameras</b>${seg("data-cams", draft.cams?.power || "leave", [["on", "On"], ["off", "Off"], ["leave", "Leave"]])}</div>`);
    if (!html) html = `<p class="note">Set up the TV, Samsung screen, Nest or Wyze on their own sides to add them to scenes.</p>`;
    box.innerHTML = html;
    const temp = box.querySelector("#scNestTemp");
    if (temp) setSlider(temp, temp.nextElementSibling, +temp.value, "");
    if (temp) temp.nextElementSibling.textContent = showTemp(draft.nest.temp ?? 21);
    box.onclick = (e) => {
      const b = e.target.closest("[data-tv],[data-screen],[data-nest],[data-cams]");
      if (!b) return;
      buzz(6);
      if (b.dataset.tv) draft.tv = b.dataset.tv === "leave" ? undefined : { ...(draft.tv || {}), power: b.dataset.tv };
      if (b.dataset.screen) draft.screen = b.dataset.screen === "leave" ? undefined : { power: b.dataset.screen };
      if (b.dataset.cams) draft.cams = b.dataset.cams === "leave" ? undefined : { power: b.dataset.cams };
      if (b.dataset.nest) draft.nest = b.dataset.nest === "leave" ? undefined : draft.nest || { mode: "HEAT", temp: 21 };
      if (draft.tv?.power === "off") draft.tv = { power: "off" };
      paintDevices();
    };
    box.onchange = (e) => {
      if (e.target.id === "scTvApp") { if (e.target.value) draft.tv.app = e.target.value; else delete draft.tv.app; }
      if (e.target.id === "scTvVol") { if (e.target.value) draft.tv.volume = +e.target.value; else delete draft.tv.volume; }
      if (e.target.id === "scNestMode") { draft.nest.mode = e.target.value; if (!["HEAT", "COOL", "HEATCOOL"].includes(draft.nest.mode)) delete draft.nest.temp; else draft.nest.temp ??= 21; paintDevices(); }
    };
    box.oninput = (e) => {
      if (e.target.id !== "scNestTemp") return;
      const v = +e.target.value;
      draft.nest.temp = fahrenheit() ? Math.round((v - 32) * 5 / 9 * 2) / 2 : v;
      setSlider(e.target, null, v);
      e.target.nextElementSibling.textContent = showTemp(draft.nest.temp);
    };
  }

  function saveScenes() {
    renderScenes();
    renderTimers();
    Lights.setScenes({ scenes }).catch(() => toast("Couldn't save the scene", true));
  }

  /* ---- Sunrise / sunset (same formula as the native side) ---- */
  const loc = () => store.json("home.loc", null); // { name, lat, lon }
  function sunTime(day, rise) {
    const L0 = loc();
    if (!L0) return 0;
    const rad = Math.PI / 180, norm = (v, m) => ((v % m) + m) % m;
    const start = new Date(day.getFullYear(), 0, 0);
    const n = Math.round((new Date(day.getFullYear(), day.getMonth(), day.getDate()) - start) / 864e5); // round: DST makes some days 23 or 25 h
    const lngHour = L0.lon / 15;
    const t = n + ((rise ? 6 : 18) - lngHour) / 24;
    const M = 0.9856 * t - 3.289;
    const L = norm(M + 1.916 * Math.sin(M * rad) + 0.020 * Math.sin(2 * M * rad) + 282.634, 360);
    let RA = norm(Math.atan(0.91764 * Math.tan(L * rad)) / rad, 360);
    RA = (RA + Math.floor(L / 90) * 90 - Math.floor(RA / 90) * 90) / 15;
    const sinDec = 0.39782 * Math.sin(L * rad), cosDec = Math.cos(Math.asin(sinDec));
    const cosH = (Math.cos(90.833 * rad) - sinDec * Math.sin(L0.lat * rad)) / (cosDec * Math.cos(L0.lat * rad));
    if (cosH > 1 || cosH < -1) return 0;
    const H = (rise ? 360 - Math.acos(cosH) / rad : Math.acos(cosH) / rad) / 15;
    const UT = norm(H + RA - 0.06571 * t - 6.622 - lngHour, 24);
    let at = Date.UTC(day.getFullYear(), day.getMonth(), day.getDate()) + Math.round(UT * 3600e3);
    const got = new Date(at);
    const dayDiff = Math.round((new Date(day.getFullYear(), day.getMonth(), day.getDate()) - new Date(got.getFullYear(), got.getMonth(), got.getDate())) / 864e5);
    return at + dayDiff * 864e5;
  }

  /* ---- Timers ---- */
  const DAY_LETTERS = ["S", "M", "T", "W", "T", "F", "S"];
  const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const FADES = [[0, "Instant"], [60, "1 min"], [600, "10 min"], [1800, "30 min"]];
  const OFFSETS = [-90, -60, -45, -30, -15, 0, 15, 30, 45, 60, 90];
  const sceneKey = (k) => (k || "").replace(/^custom:/, "");
  const sceneName = (k) => scenes.find((s) => s.id === sceneKey(k))?.name || "Deleted scene";
  const daysText = (d) => {
    const s = [...(d || [])].sort();
    if (!s.length || s.length === 7) return "Every day";
    if (s.join() === "2,3,4,5,6") return "Weekdays";
    if (s.join() === "1,7") return "Weekends";
    return s.map((x) => DAY_NAMES[x - 1]).join(", ");
  };
  const whenText = (t) => {
    if ((t.when || "time") === "time") return fmtTime(t.minutes);
    const o = t.offset || 0, sun = t.when === "sunrise" ? "sunrise" : "sunset";
    return o === 0 ? `At ${sun}` : `${Math.abs(o)} min ${o < 0 ? "before" : "after"} ${sun}`;
  };
  function nextFire(t, from = Date.now()) {
    if (!t.on) return 0;
    for (let i = 0; i < 9; i++) {
      const d = new Date(from);
      d.setDate(d.getDate() + i);
      if (t.days?.length && !t.days.includes(d.getDay() + 1)) continue;
      let at;
      if ((t.when || "time") === "time") { d.setHours(Math.floor(t.minutes / 60), t.minutes % 60, 0, 0); at = d.getTime(); }
      else { const s = sunTime(d, t.when === "sunrise"); if (!s) continue; at = s + (t.offset || 0) * 60e3; at -= at % 60e3; }
      if (at > from) return at;
    }
    return 0;
  }
  const fmtNext = (at) => {
    if (!at) return "—";
    const d = new Date(at), today = new Date();
    const day = d.toDateString() === today.toDateString() ? "today" : new Date(today.getTime() + 864e5).toDateString() === d.toDateString() ? "tomorrow" : DAY_NAMES[d.getDay()];
    return `${day} ${fmtClock(at)}`;
  };
  function renderTimers() {
    const html = timers.length ? `<div class="card glass" style="padding:6px 16px">` + timers
      .slice().sort((a, b) => (nextFire({ ...a, on: true }) || 9e15) - (nextFire({ ...b, on: true }) || 9e15)).map((t) => `
      <div class="set-row timer-row" data-timer="${t.id}">
        <div class="set-text"><b class="t-time">${esc(whenText(t))}</b><span>${esc(sceneName(t.scene))} · ${daysText(t.days)}${t.fade ? ` · fade ${FADES.find((f) => f[0] === t.fade)?.[1] || ""}` : ""}${(t.when || "time") !== "time" && !loc() ? " · set your city first" : ""}</span></div>
        <button class="tgl${t.on ? " on" : ""}" data-ttoggle="${t.id}" aria-label="Timer on or off"><i></i></button>
      </div>`).join("") + `</div>`
      : `<div class="card glass"><p class="note" style="margin:0">No timers yet. Add one to run a scene at a set time or at sunset, like the lights coming on in the evening or a slow wake-up.</p></div>`;
    const next = timers.map((t) => nextFire(t)).filter(Boolean).sort()[0];
    document.querySelectorAll(".timers-list").forEach((el) => (el.innerHTML = html));
    document.querySelectorAll(".timer-next").forEach((el) => (el.textContent = next ? `next ${fmtNext(next)}` : ""));
  }
  async function saveTimers(msg) {
    renderTimers();
    try { await Lights.setTimers({ timers }); if (msg) toast(msg); }
    catch { toast("Couldn't save the timer", true); }
  }
  function openTimer(id) {
    const old = timers.find((x) => x.id === id);
    const t = old ? { when: "time", offset: 0, ...old, days: [...(old.days || [])], scene: `custom:${sceneKey(old.scene)}` }
      : { id: "t" + Date.now().toString(36), scene: scenes[0] ? `custom:${scenes[0].id}` : "", when: "time", minutes: 7 * 60, offset: 0, days: [], fade: 0, on: true };
    const hhmm = (m) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
    const body = House.sheet(`
      <h3>${old ? "Edit timer" : "New timer"}</h3>
      <label class="fld">Scene<select class="field" id="tmScene">${scenes.map((s) => `<option value="custom:${esc(s.id)}" ${`custom:${s.id}` === t.scene ? "selected" : ""}>${esc(s.name)}</option>`).join("")}</select></label>
      <div class="fld">When</div>
      <div class="seg3" id="tmWhen" style="margin-top:6px">${[["time", "At a time"], ["sunset", "Sunset"], ["sunrise", "Sunrise"]].map(([v, n]) => `<button data-when="${v}">${n}</button>`).join("")}</div>
      <label class="fld" id="tmTimeRow">Time<input class="field" type="time" id="tmTime" value="${hhmm(t.minutes ?? 420)}"></label>
      <label class="fld" id="tmOffRow">How long before or after<select class="field" id="tmOffset">${OFFSETS.map((o) => `<option value="${o}" ${o === t.offset ? "selected" : ""}>${o === 0 ? "Right then" : `${Math.abs(o)} min ${o < 0 ? "before" : "after"}`}</option>`).join("")}</select></label>
      <div class="fld">Days <span style="font-weight:500">(none = every day)</span></div>
      <div class="days" id="tmDays">${DAY_LETTERS.map((d, i) => `<button data-day="${i + 1}" aria-label="${DAY_NAMES[i]}">${d}</button>`).join("")}</div>
      <div class="fld">Lights fade</div>
      <div class="seg3" id="tmFade" style="--n:4;margin-top:6px">${FADES.map(([s, n]) => `<button data-fade="${s}">${n}</button>`).join("")}</div>
      <p class="note" id="tmNext"></p>
      <div class="list"><button class="primary full" id="tmSave">Save timer</button>
      ${old ? `<button class="ghost center danger" id="tmDelete">Delete timer</button>` : ""}</div>`);
    const paint = () => {
      const sun = t.when !== "time";
      body.querySelectorAll("[data-when]").forEach((b) => b.classList.toggle("on", b.dataset.when === t.when));
      body.querySelector("#tmTimeRow").hidden = sun;
      body.querySelector("#tmOffRow").hidden = !sun;
      body.querySelectorAll("[data-day]").forEach((b) => b.classList.toggle("on", t.days.includes(+b.dataset.day)));
      body.querySelectorAll("[data-fade]").forEach((b) => b.classList.toggle("on", +b.dataset.fade === t.fade));
      body.querySelector("#tmNext").textContent = sun && !loc() ? "Set your city in Lights → Settings so the app knows when the sun sets."
        : `${whenText(t)}, ${daysText(t.days).toLowerCase()}. Next: ${fmtNext(nextFire({ ...t, on: true }))}.`;
    };
    paint();
    body.querySelector("#tmScene").onchange = (e) => (t.scene = e.target.value);
    body.querySelector("#tmWhen").onclick = (e) => { const b = e.target.closest("[data-when]"); if (b) { buzz(6); t.when = b.dataset.when; paint(); } };
    body.querySelector("#tmTime").onchange = (e) => { const [h, m] = e.target.value.split(":").map(Number); t.minutes = (h || 0) * 60 + (m || 0); paint(); };
    body.querySelector("#tmOffset").onchange = (e) => { t.offset = +e.target.value; paint(); };
    body.querySelector("#tmDays").onclick = (e) => { const b = e.target.closest("[data-day]"); if (!b) return; buzz(6); const d = +b.dataset.day; t.days = t.days.includes(d) ? t.days.filter((x) => x !== d) : [...t.days, d]; paint(); };
    body.querySelector("#tmFade").onclick = (e) => { const b = e.target.closest("[data-fade]"); if (b) { buzz(6); t.fade = +b.dataset.fade; paint(); } };
    body.querySelector("#tmSave").onclick = () => {
      if (!t.scene) { toast("Make a scene first", true); return; }
      if (t.when !== "time" && !loc()) { toast("Set your city in Lights → Settings first", true); return; }
      t.on = true;
      const i = timers.findIndex((x) => x.id === t.id);
      if (i >= 0) timers[i] = t; else timers.push(t);
      House.closeSheet();
      saveTimers(`Timer saved · next ${fmtNext(nextFire(t))}`);
    };
    if (old) body.querySelector("#tmDelete").onclick = () => {
      if (!confirm("Delete this timer?")) return;
      timers = timers.filter((x) => x.id !== old.id);
      House.closeSheet();
      saveTimers("Timer deleted");
    };
  }

  /* ---- Bedtime (all lights off every day) ---- */
  function showBedtime(b) {
    const all = (sel, fn) => document.querySelectorAll(sel).forEach(fn);
    all("[data-bed-tgl]", (el) => el.classList.toggle("on", b.on));
    all("[data-bed-row]", (el) => el.classList.toggle("disabled", !b.on));
    all("[data-bed-time]", (el) => (el.value = `${String(Math.floor(b.minutes / 60)).padStart(2, "0")}:${String(b.minutes % 60).padStart(2, "0")}`));
    all("[data-bed-sub]", (el) => (el.textContent = b.on ? `All lights off every day at ${fmtTime(b.minutes)}` : "Turn every light off at a set time"));
    bedOn = b.on;
  }
  let bedOn = false;
  async function saveBedtime(on, value) {
    const [h, m] = (value || document.querySelector("[data-bed-time]").value).split(":").map(Number);
    const b = await Lights.setBedtime({ on, minutes: (h || 0) * 60 + (m || 0) });
    showBedtime(b);
    return b;
  }

  /* ---- City for sun times ---- */
  function paintCity() {
    const L = loc();
    $("homeCity").value = L?.name || "";
    if (!L) { $("homeSun").textContent = "Needed for sunrise and sunset timers."; return; }
    const today = new Date(), rise = sunTime(today, true), set = sunTime(today, false);
    $("homeSun").textContent = rise && set ? `Today: sunrise ${fmtClock(rise)}, sunset ${fmtClock(set)}.` : "No sunrise or sunset there today.";
  }
  async function findCity() {
    const q = $("homeCity").value.trim();
    if (!q) { toast("Type your city", true); return; }
    $("homeCityBtn").disabled = true;
    try {
      const r = await (await fetch(`https://geocoding-api.open-meteo.com/v1/search?count=1&language=en&name=${encodeURIComponent(q)}`)).json();
      const c = r.results?.[0];
      if (!c) { toast("Couldn't find that place. Try the city name only.", true); return; }
      const L = { name: [c.name, c.admin1, c.country_code].filter(Boolean).join(", "), lat: c.latitude, lon: c.longitude };
      store.setJson("home.loc", L);
      await Lights.setLocation({ lat: L.lat, lon: L.lon });
      paintCity();
      renderTimers();
      toast(`Location: ${L.name}`);
    } catch { toast("Couldn't look that up. Check the internet.", true); }
    finally { $("homeCityBtn").disabled = false; }
  }

  // The Scenes and Timers pages, shown on the Lights side.
  const SCENES_HTML = `
        <div class="label">Scenes</div>
        <div class="grid2 scenes-grid"></div>
        <p class="note" style="margin-top:0">Tap a scene to run it. ✎ changes or deletes it. A scene can set the lights, TV, Samsung screen, Nest and cameras together.</p>`;
  const TIMERS_HTML = `
        <div class="label">Scene timers<span class="cnt timer-next"></span></div>
        <div class="timers-list"></div>
        <button class="ghost center" data-add-timer style="flex:none">${svg("plus", 'style="width:18px;height:18px;vertical-align:-4px"')} Add a timer</button>
        <div class="label" style="margin-top:18px">Every night</div>
        <div class="card glass">
          <div class="set-row">
            <div class="set-text"><b>Bedtime</b><span data-bed-sub>Turn every light off at a set time</span></div>
            <button class="tgl" data-bed-tgl aria-label="Bedtime on or off"><i></i></button>
          </div>
          <div class="set-row" data-bed-row>
            <div class="set-text"><b>Time</b><span>Lights fade off over 3 seconds</span></div>
            <input class="field time-field" type="time" data-bed-time value="23:30">
          </div>
        </div>
        <p class="note">Timers and Bedtime work with the app closed. If your phone restarts, they're set again on their own.</p>`;


  // Not a side of its own: the Lights side shows these (Scenes and Timers tabs, its Settings, its Guide).
  House.scenes = {
    scenesHtml: SCENES_HTML,
    timersHtml: TIMERS_HTML,
    settingsHtml: `
      <div class="label">Location</div>
      <div class="card glass">
        <div class="row"><input class="field" id="homeCity" placeholder="Your city" autocomplete="address-level2"><button class="primary" id="homeCityBtn">Set</button></div>
        <p class="note" id="homeSun"></p>
      </div>
      <div class="label">Scenes</div>
      <div class="card glass"><button class="ghost center" id="homeRestore">Bring back built-in scenes</button>
        <p class="note">Puts back Bright, Movie, Night light and All off if you deleted them. Your own scenes stay.</p></div>`,
    guide: [
      ["star", "Scenes", "Tap a scene to run it. Bright, Movie, Night light and All off come with the app; change or delete them like your own."],
      ["plus", "Make a scene", "New scene → a name and an icon, then each light On (with its brightness), Off, or Leave as it is. Add the TV (on/off, an app, volume), the Samsung screen, Nest (mode and temperature, or Eco) and the cameras. Try it before saving."],
      ["clock", "Timers", "Run any scene at a time, or before/after sunset or sunrise, on the days you pick (none = every day). Lights can fade in slowly for a gentle wake-up."],
      ["sun", "Sunset and sunrise", "Set your city once in Settings. The timers then follow the sun through the year."],
      ["moon", "Bedtime", "Turns every light off at the same time each night."],
    ],
    mount() {
      // One listener for both copies (Home and Lights).
      document.addEventListener("click", (e) => {
        if (e.target.closest(".scenes-grid")) {
          const ed = e.target.closest("[data-edit]");
          if (ed) { buzz(6); openScene(ed.dataset.edit); return; }
          if (e.target.closest("[data-new]")) { buzz(6); openScene(null); return; }
          const c = e.target.closest("[data-run]");
          if (c) run(scenes.find((s) => s.id === c.dataset.run));
          return;
        }
        if (e.target.closest(".timers-list")) {
          const tg = e.target.closest("[data-ttoggle]");
          if (tg) { buzz(); const t = timers.find((x) => x.id === tg.dataset.ttoggle); t.on = !t.on; saveTimers(t.on ? `Timer on · next ${fmtNext(nextFire(t))}` : "Timer off"); return; }
          const r = e.target.closest("[data-timer]");
          if (r) { buzz(6); openTimer(r.dataset.timer); }
          return;
        }
        if (e.target.closest("[data-add-timer]")) { buzz(6); openTimer(null); return; }
        if (e.target.closest("[data-bed-tgl]")) {
          buzz();
          saveBedtime(!bedOn).then((b) => toast(b.on ? `Bedtime set for ${fmtTime(b.minutes)}` : "Bedtime off")).catch(() => {});
        }
      });
      document.addEventListener("change", (e) => { if (e.target.matches("[data-bed-time]")) saveBedtime(true, e.target.value); });
      $("homeCityBtn").onclick = findCity;
      $("homeCity").onkeydown = (e) => { if (e.key === "Enter") findCity(); };
      $("homeRestore").onclick = async () => {
        buzz();
        try { scenes = (await Lights.restoreScenes()).scenes || []; renderScenes(); renderTimers(); toast("Built-in scenes are back"); }
        catch { toast("Couldn't restore them", true); }
      };
      Lights.getScenes().then((r) => { scenes = r.scenes || []; renderScenes(); renderTimers(); }).catch(() => {});
      Lights.getTimers().then((r) => { timers = r.timers || []; renderTimers(); }).catch(() => {});
      Lights.getBedtime().then(showBedtime).catch(() => {});
      const L = loc();
      if (L) Lights.setLocation({ lat: L.lat, lon: L.lon }).catch(() => {});
      paintCity();
    },
    onShow(tab) {
      if (tab === "scenes") renderScenes();
      if (tab === "timers") renderTimers();
      if (tab === "settings") paintCity();
    },
  };
})();
