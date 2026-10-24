// 💡 Lights: LIFX bulbs over the home Wi-Fi (native LightsPlugin). Tabs: Lights · Scenes · Timers · Settings.

const Lights = plugin("Lights", (() => {
  // Outside the app: a small fake house so the page still works in a desktop browser.
  const L = [["Living Room 1", "Living Room"], ["Living Room 2", "Living Room"], ["Living_4", "Living Room"], ["Bed Anis", "Bedroom"], ["bed Roza", "Bedroom"], ["Hallway 1", "Hallway"], ["Hallway 2", "Hallway"], ["Hallway 3", "Hallway"]]
    .map(([label, group], i) => ({ id: "d073d5" + i, ip: "192.168.50." + (40 + i), label, group, on: i % 3 !== 1, bri: 52000, hue: 0, sat: 0, kelvin: 3500, online: true, color: false, tunable: false, kMin: 3500, kMax: 3500 }));
  const pick = (ids) => L.filter((l) => !ids || ids.includes(l.id));
  const res = () => ({ lights: L, subnet: "192.168.50" });
  return {
    cached: async () => res(), scan: async () => (await sleep(500), res()), forget: async () => {},
    power: async ({ ids, on }) => (pick(ids).forEach((l) => (l.on = on)), { confirmed: pick(ids).length }),
    color: async ({ ids, bri }) => (pick(ids).forEach((l) => { if (bri != null) l.bri = bri / 100 * 65535; }), {}),
    scene: async ({ name }) => (L.forEach((l) => (l.on = name !== "off")), {}),
    getBedtime: async () => ({ on: false, minutes: 1410, next: 0 }), setBedtime: async (b) => ({ ...b, next: Date.now() + 3600e3 }),
    getScenes: async () => ({ scenes: store.json("mock.scenes", []) }), setScenes: async ({ scenes }) => store.setJson("mock.scenes", scenes),
    runScene: async ({ scene }) => { for (const l of L) { const s = scene.lights[l.id]; if (s) { l.on = s.mode === "on"; if (s.bri) l.bri = s.bri / 100 * 65535; } } return {}; },
    getTimers: async () => ({ timers: store.json("mock.timers", []), next: 0 }), setTimers: async ({ timers }) => (store.setJson("mock.timers", timers), { timers, next: 0 }),
    appVersion: async () => ({ version: "dev" }), openUrl: async () => { throw new Error("browser"); }, setTheme: async () => {},
  };
})());

(() => {
  let lights = [];       // from the plugin; hue/sat/bri are 0-65535
  let subnet = "";
  let scanning = false;
  let dragging = 0;      // while a slider is held, a refresh doesn't move it
  let sheetId = null;
  const pct = (v) => Math.max(1, Math.round(v / 65535 * 100));
  const byId = (id) => lights.find((l) => l.id === id);
  const q = (sel) => document.querySelector(`[data-page^="lights:"] ${sel}`);

  /* The colour a bulb shines, for the tile glow */
  function kelvinRgb(k) {
    const t = k / 100;
    let r, g, b;
    if (t <= 66) { r = 255; g = 99.47 * Math.log(t) - 161.12; b = t <= 19 ? 0 : 138.52 * Math.log(t - 10) - 305.04; }
    else { r = 329.7 * Math.pow(t - 60, -0.1332); g = 288.12 * Math.pow(t - 60, -0.0755); b = 255; }
    const c = (v) => Math.max(0, Math.min(255, Math.round(v)));
    return `rgb(${c(r)},${c(g)},${c(b)})`;
  }
  function shine(l) {
    if (l.color && l.sat > 3000) return `hsl(${Math.round(l.hue / 65535 * 360)} ${Math.round(40 + l.sat / 65535 * 60)}% 60%)`;
    // Fixed-white bulbs report a nominal 3500K; draw them as the soft warm white they are.
    return kelvinRgb(l.tunable ? l.kelvin : 2700);
  }

  function renderSummary() {
    const online = lights.filter((l) => l.online);
    const on = online.filter((l) => l.on);
    if (House.current === "lights") document.body.classList.toggle("dim", lights.length > 0 && on.length === 0);
    const sw = $("allSwitch");
    sw.classList.toggle("on", on.length > 0);
    $("allLbl").textContent = on.length ? "ON" : "OFF";
    $("masterSub").innerHTML = `<span class="dot ${on.length ? "warm" : ""}"></span>` + (!lights.length ? (scanning ? "Looking for lights…" : "No lights found")
      : !online.length ? "No lights answering" : on.length === online.length ? `All ${on.length} on` : on.length ? `${on.length} of ${online.length} on` : `All ${online.length} off`);
    if (!dragging && on.length) setSlider($("allBri"), $("allBriOut"), Math.round(on.reduce((s, l) => s + pct(l.bri), 0) / on.length));
  }

  function render() {
    renderSummary();
    $("lightsEmpty").hidden = lights.length > 0;
    $("master").hidden = lights.length === 0;
    if (!lights.length) {
      $("emptyTitle").textContent = scanning ? "Looking for lights…" : "No lights found";
      $("emptyText").textContent = scanning ? "This takes a few seconds." : "Your phone needs to be on the home Wi-Fi. Still nothing? Settings → scan every address.";
      $("emptyScan").hidden = scanning;
      $("rooms").innerHTML = "";
      return;
    }
    if (dragging) return; // don't rebuild under a finger
    const rooms = {};
    for (const l of lights) (rooms[l.group || "Other"] ||= []).push(l);
    const names = Object.keys(rooms).sort((a, b) => (a === "Other") - (b === "Other") || a.localeCompare(b));
    $("rooms").innerHTML = names.map((room) => {
      const ls = rooms[room].sort((a, b) => a.label.localeCompare(b.label, undefined, { numeric: true }));
      const on = ls.filter((l) => l.on && l.online).length;
      return `<div class="label">${esc(room)}<span class="cnt">${on ? on + " on" : "off"}</span>
          <button class="room-btn${on ? " on" : ""}" data-room="${esc(room)}">${on ? "Turn off" : "Turn on"}</button></div>
        <div class="tiles">${ls.map(tile).join("")}</div>`;
    }).join("");
  }
  function tile(l) {
    const b = pct(l.bri);
    const sub = !l.online ? "Not responding" : l.on ? b + "%" : "Off";
    return `<div class="tile glass${l.on && l.online ? " on" : ""}${l.online ? "" : " offline"}" data-id="${l.id}" style="--c:${shine(l)};--b:${b / 100}">
      <div class="tile-top"><span class="bulb">${svg("bulb")}</span><button class="more" data-more="${l.id}" aria-label="More for ${esc(l.label)}">${svg("dots")}</button></div>
      <div class="tile-name">${esc(l.label)}</div>
      <div class="tile-sub">${sub}</div>
      <input type="range" min="1" max="100" value="${b}" style="--p:${b}%" data-bri="${l.id}" aria-label="${esc(l.label)} brightness">
    </div>`;
  }

  /* Sending: optimistic update, then the bulb. Slider drags send at most every 120 ms. */
  async function power(ids, on) {
    for (const l of lights) if (!ids || ids.includes(l.id)) l.on = on;
    render();
    try {
      const r = await Lights.power({ ids, on });
      const want = ids ? ids.length : lights.filter((l) => l.online).length;
      if (NATIVE && r.confirmed < want && want) toast(r.confirmed ? `${want - r.confirmed} light${want - r.confirmed === 1 ? "" : "s"} didn't answer` : "The lights didn't answer", !r.confirmed);
    } catch (e) { toast(e.message || "Couldn't reach the lights", true); }
  }
  const sendColor = throttled((ids, values) => Lights.color({ ids, ...values }).catch(() => {}));
  function setBri(ids, v) {
    for (const l of lights) if (!ids || ids.includes(l.id)) l.bri = v / 100 * 65535;
    sendColor(ids, { bri: v });
  }

  /* One bulb's details */
  const SWATCHES = [[0, 100], [30, 100], [55, 100], [120, 90], [200, 90], [275, 85], [320, 80], [0, 0]];
  function openLight(id) {
    sheetId = id;
    House.sheet(`
      <div class="sheet-head">
        <div><h3 id="shName"></h3><div class="sub" id="shSub"></div></div>
        <button class="pswitch" id="shSwitch" aria-label="On or off"><span class="lbl">OFF</span><span class="knob">${svg("power")}</span></button>
      </div>
      <div class="slide-lbl">Brightness</div>
      <div class="slide">${svg("sun")}<input type="range" id="shBri" min="1" max="100"><output id="shBriOut"></output></div>
      <div id="shKelvinBox">
        <div class="slide-lbl">Warm – cool</div>
        <div class="slide">${svg("thermo")}<input type="range" class="kelvin" id="shKelvin" step="100"><output id="shKelvinOut"></output></div>
      </div>
      <div id="shColorBox">
        <div class="slide-lbl">Colour</div>
        <div class="slide">${svg('<circle cx="12" cy="12" r="9"/>')}<input type="range" class="hue" id="shHue" min="0" max="359"><output id="shHueOut"></output></div>
        <div class="slide">${svg("drop")}<input type="range" class="sat" id="shSat" min="0" max="100"><output id="shSatOut"></output></div>
        <div class="swatches" id="swatches">${SWATCHES.map(([h, s]) => `<button data-h="${h}" data-s="${s}" style="--s:${s ? `hsl(${h} ${s}% 55%)` : "#fff4e0"}" aria-label="Colour"></button>`).join("")}</div>
      </div>
      <p class="note" id="shNote"></p>`);
    House.onSheetClose = () => { sheetId = null; };
    fillSheet();
    $("shSwitch").onclick = () => { buzz(14); const l = byId(sheetId); power([l.id], !l.on); fillSheet(); };
    $("shBri").oninput = (e) => {
      const v = +e.target.value, l = byId(sheetId);
      setSlider($("shBri"), $("shBriOut"), v);
      setBri([sheetId], v);
      if (!l.on) power([l.id], true).then(fillSheet);
    };
    $("shKelvin").oninput = (e) => {
      const v = +e.target.value, l = byId(sheetId);
      setSlider($("shKelvin"), $("shKelvinOut"), v, "K");
      l.kelvin = v; l.sat = 0;
      sendColor([sheetId], { kelvin: v, sat: 0 });
    };
    $("shHue").oninput = sendHueSat;
    $("shSat").oninput = sendHueSat;
    $("swatches").onclick = (e) => {
      const b = e.target.closest("button");
      if (!b) return;
      buzz(6);
      $("shHue").value = b.dataset.h; $("shSat").value = b.dataset.s;
      sendHueSat();
      setTimeout(render, 200);
    };
  }
  function fillSheet() {
    const l = byId(sheetId);
    if (!l) return House.closeSheet();
    $("shName").textContent = l.label;
    $("shSub").textContent = `${l.group || "No room"} · ${l.online ? l.ip : "not responding"}`;
    $("shSwitch").classList.toggle("on", l.on);
    $("shSwitch").querySelector(".lbl").textContent = l.on ? "ON" : "OFF";
    setSlider($("shBri"), $("shBriOut"), pct(l.bri));
    $("shKelvinBox").hidden = !l.tunable;
    $("shColorBox").hidden = !l.color;
    if (l.tunable) {
      $("shKelvin").min = l.kMin; $("shKelvin").max = l.kMax;
      setSlider($("shKelvin"), $("shKelvinOut"), l.kelvin, "K");
    }
    if (l.color) {
      const h = Math.round(l.hue / 65535 * 360), s = Math.round(l.sat / 65535 * 100);
      setSlider($("shHue"), $("shHueOut"), h, "°");
      setSlider($("shSat"), $("shSatOut"), s);
      $("shSat").style.setProperty("--sat-c", `hsl(${h} 100% 50%)`);
    }
    $("shNote").textContent = l.tunable ? "" : "This bulb is a fixed warm white, so it only dims.";
  }
  function sendHueSat() {
    const h = +$("shHue").value, s = +$("shSat").value, l = byId(sheetId);
    setSlider($("shHue"), $("shHueOut"), h, "°");
    setSlider($("shSat"), $("shSatOut"), s);
    $("shSat").style.setProperty("--sat-c", `hsl(${h} 100% 50%)`);
    l.hue = h / 360 * 65535; l.sat = s / 100 * 65535;
    sendColor([sheetId], { hue: h, sat: s });
  }

  /* Finding bulbs */
  async function refresh(opts = {}) {
    if (scanning) return;
    scanning = true;
    $("lightsRefresh").classList.add("spin");
    if (!lights.length) render();
    try {
      const r = await Lights.scan({ timeout: opts.timeout || 1500, range: opts.range });
      const before = lights.length;
      lights = r.lights;
      subnet = r.subnet || subnet;
      if (subnet) $("range").placeholder = subnet;
      if (opts.manual) {
        const n = lights.filter((l) => l.online).length;
        toast(n ? `Found ${n} light${n === 1 ? "" : "s"}${lights.length > before && before ? ` (${lights.length - before} new)` : ""}` : "No lights found", !n);
      }
    } catch {
      if (opts.manual) toast("Couldn't scan the network", true);
    } finally {
      scanning = false;
      $("lightsRefresh").classList.remove("spin");
      render();
      if (sheetId) fillSheet();
    }
  }

  /* Bedtime */
  const fmtTime = (m) => new Date(2000, 0, 1, Math.floor(m / 60), m % 60).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  function showBedtime(b) {
    $("bedTgl").classList.toggle("on", b.on);
    $("bedTimeRow").classList.toggle("disabled", !b.on);
    $("bedTime").value = `${String(Math.floor(b.minutes / 60)).padStart(2, "0")}:${String(b.minutes % 60).padStart(2, "0")}`;
    $("bedSub").textContent = b.on ? `All lights off every day at ${fmtTime(b.minutes)}` : "Turn every light off at a set time";
  }
  async function saveBedtime(on) {
    const [h, m] = $("bedTime").value.split(":").map(Number);
    const b = await Lights.setBedtime({ on, minutes: (h || 0) * 60 + (m || 0) });
    showBedtime(b);
    return b;
  }

  const SCENE_NAMES = { bright: "Bright", movie: "Movie", night: "Night light", off: "All off", on: "All on" };

  /* ---- Your own scenes ---- */
  let mine = [];   // [{ id, name, icon, lights: { <bulb id>: { mode: "on"|"off", bri, kelvin?, hue?, sat? } } }]
  let draft = null;
  const SCENE_ICONS = ["bulb", "sun", "moon", "tv", "star", "leaf", "flame", "home", "bell", "drop"];
  const sceneSummary = (s) => {
    const v = Object.values(s.lights || {});
    const on = v.filter((x) => x.mode === "on"), off = v.length - on.length;
    const avg = on.length ? Math.round(on.reduce((a, x) => a + (x.bri || 100), 0) / on.length) : 0;
    return [on.length ? `${on.length} on · ${avg}%` : "", off ? `${off} off` : ""].filter(Boolean).join(" · ") || "No lights set";
  };
  function renderMine() {
    $("myScenes").innerHTML = mine.map((s) => `
      <div class="scene glass mine" data-my="${s.id}" role="button" tabindex="0" style="--sc: var(--grad); --sc0: var(--a1)">
        <button class="scene-edit" data-edit="${s.id}" aria-label="Edit ${esc(s.name)}">${svg('<path d="M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/>')}</button>
        <span class="ic">${svg(s.icon || "star")}</span><b>${esc(s.name)}</b><span>${esc(sceneSummary(s))}</span>
      </div>`).join("") + `<button class="scene new-scene" id="newScene">${svg("plus")}<b>New scene</b><span>Set each light your way</span></button>`;
    $("newScene").onclick = () => { buzz(6); openScene(null); };
  }
  async function runMine(id, fromDraft) {
    const s = fromDraft ? draft : mine.find((x) => x.id === id);
    if (!s) return;
    buzz(14);
    try {
      await Lights.runScene({ scene: s });
      for (const l of lights) { const w = s.lights[l.id]; if (w) { l.on = w.mode === "on"; if (w.mode === "on" && w.bri) l.bri = w.bri / 100 * 65535; } }
      render();
      toast(fromDraft ? "Trying it on the lights" : s.name);
      setTimeout(() => refresh(), 1800);
    } catch { toast("Couldn't reach the lights", true); }
  }
  // How the lights are right now, as scene settings.
  const snapshot = () => Object.fromEntries(lights.filter((l) => l.online).map((l) => [l.id, l.on
    ? { mode: "on", bri: pct(l.bri), ...(l.tunable ? { kelvin: l.kelvin } : {}), ...(l.color && l.sat > 3000 ? { hue: Math.round(l.hue / 65535 * 360), sat: Math.round(l.sat / 65535 * 100) } : {}) }
    : { mode: "off" }]));

  function openScene(id) {
    const old = mine.find((x) => x.id === id);
    draft = old ? JSON.parse(JSON.stringify(old)) : { id: "s" + Date.now().toString(36), name: "", icon: "star", lights: snapshot() };
    const body = House.sheet(`
      <h3>${old ? "Edit scene" : "New scene"}</h3>
      <label class="fld">Name<input class="field" id="scName" maxlength="24" placeholder="Dinner" value="${esc(draft.name)}"></label>
      <div class="icon-pick" id="scIcons">${SCENE_ICONS.map((i) => `<button data-icon="${i}" aria-label="${i}">${svg(i)}</button>`).join("")}</div>
      <button class="ghost center" id="scCopy" style="margin-top:12px">Copy how the lights are now</button>
      <div id="scRows"></div>
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
    body.querySelector("#scTry").onclick = () => runMine(null, true);
    body.querySelector("#scSave").onclick = () => {
      draft.name = draft.name.trim();
      if (!draft.name) { toast("Give the scene a name", true); body.querySelector("#scName").focus(); return; }
      const i = mine.findIndex((x) => x.id === draft.id);
      if (i >= 0) mine[i] = draft; else mine.push(draft);
      const name = draft.name;
      saveMine();
      House.closeSheet();
      toast(`Saved “${name}”`);
    };
    if (old) body.querySelector("#scDelete").onclick = () => {
      const used = timers.filter((t) => t.scene === `custom:${old.id}`).length;
      if (!confirm(`Delete “${old.name}”?${used ? ` Its ${used} timer${used === 1 ? "" : "s"} will be deleted too.` : ""}`)) return;
      mine = mine.filter((x) => x.id !== old.id);
      if (used) { timers = timers.filter((t) => t.scene !== `custom:${old.id}`); saveTimers(); }
      saveMine();
      House.closeSheet();
      toast("Scene deleted");
    };
    paintRows();
  }
  function paintRows() {
    const rooms = {};
    for (const l of lights) (rooms[l.group || "Other"] ||= []).push(l);
    $("scRows").innerHTML = Object.keys(rooms).sort().map((room) => `<div class="slide-lbl" style="margin:16px 0 4px">${esc(room)}</div>` +
      rooms[room].sort((a, b) => a.label.localeCompare(b.label, undefined, { numeric: true })).map((l) => {
        const s = draft.lights[l.id];
        const mode = s ? s.mode : "leave";
        const b = s?.bri || 100;
        return `<div class="sc-row" data-bulb="${l.id}">
          <div class="row"><b class="grow">${esc(l.label)}</b>
            <div class="mini-seg">${[["on", "On"], ["off", "Off"], ["leave", "Leave"]].map(([m, t]) => `<button data-mode="${m}" class="${m === mode ? "on" : ""}">${t}</button>`).join("")}</div></div>
          ${mode === "on" ? `<div class="slide" style="margin-top:8px">${svg("sun")}<input type="range" min="1" max="100" value="${b}" style="--p:${b}%" data-sbri><output>${b}%</output></div>
            ${l.tunable ? `<div class="slide" style="margin-top:8px">${svg("thermo")}<input type="range" class="kelvin" min="${l.kMin}" max="${l.kMax}" step="100" value="${s.kelvin || l.kelvin}" data-skel><output>${s.kelvin || l.kelvin}K</output></div>` : ""}` : ""}
        </div>`;
      }).join("")).join("");
    const rows = $("scRows");
    rows.onclick = (e) => {
      const m = e.target.closest("[data-mode]");
      if (!m) return;
      buzz(6);
      const id = m.closest("[data-bulb]").dataset.bulb, l = byId(id);
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
  function saveMine() {
    renderMine();
    renderTimers();
    Lights.setScenes({ scenes: mine }).catch(() => toast("Couldn't save the scene", true));
  }

  /* ---- Scene timers ---- */
  let timers = []; // [{ id, scene, minutes, days: [1-7, Sunday = 1], fade: seconds, on }]
  const DAY_LETTERS = ["S", "M", "T", "W", "T", "F", "S"];
  const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const FADES = [[0, "Instant"], [60, "1 min"], [600, "10 min"], [1800, "30 min"]];
  const sceneName = (key) => key?.startsWith("custom:") ? mine.find((s) => `custom:${s.id}` === key)?.name || "Deleted scene" : SCENE_NAMES[key] || key;
  const daysText = (d) => {
    const s = [...(d || [])].sort();
    if (!s.length || s.length === 7) return "Every day";
    if (s.join() === "2,3,4,5,6") return "Weekdays";
    if (s.join() === "1,7") return "Weekends";
    return s.map((x) => DAY_NAMES[x - 1]).join(", ");
  };
  function nextFire(t, from = Date.now()) {
    if (!t.on) return 0;
    for (let i = 0; i < 8; i++) {
      const d = new Date(from);
      d.setDate(d.getDate() + i);
      d.setHours(Math.floor(t.minutes / 60), t.minutes % 60, 0, 0);
      if (d.getTime() > from && (!t.days?.length || t.days.includes(d.getDay() + 1))) return d.getTime();
    }
    return 0;
  }
  const fmtNext = (at) => {
    if (!at) return "—";
    const d = new Date(at), today = new Date();
    const day = d.toDateString() === today.toDateString() ? "today" : new Date(today.getTime() + 864e5).toDateString() === d.toDateString() ? "tomorrow" : DAY_NAMES[d.getDay()];
    return `${day} ${fmtTime(d.getHours() * 60 + d.getMinutes())}`;
  };
  function renderTimers() {
    if (!$("timerList")) return;
    $("timerList").innerHTML = timers.length ? `<div class="card glass" style="padding:6px 16px">` + timers
      .slice().sort((a, b) => a.minutes - b.minutes).map((t) => `
      <div class="set-row timer-row" data-timer="${t.id}">
        <div class="set-text"><b class="t-time">${fmtTime(t.minutes)}</b><span>${esc(sceneName(t.scene))} · ${daysText(t.days)}${t.fade ? ` · fade ${FADES.find((f) => f[0] === t.fade)?.[1] || ""}` : ""}</span></div>
        <button class="tgl${t.on ? " on" : ""}" data-ttoggle="${t.id}" aria-label="Timer on or off"><i></i></button>
      </div>`).join("") + `</div>`
      : `<div class="card glass"><p class="note" style="margin:0">No timers yet. Add one to run a scene at a set time, like a slow wake-up or the lights coming on for dinner.</p></div>`;
    const next = timers.map((t) => nextFire(t)).filter(Boolean).sort()[0];
    $("timerNext").textContent = next ? `next ${fmtNext(next)}` : "";
  }
  async function saveTimers(msg) {
    renderTimers();
    try { await Lights.setTimers({ timers }); if (msg) toast(msg); }
    catch { toast("Couldn't save the timer", true); }
  }
  function openTimer(id) {
    const old = timers.find((x) => x.id === id);
    const t = old ? { ...old, days: [...(old.days || [])] } : { id: "t" + Date.now().toString(36), scene: mine[0] ? `custom:${mine[0].id}` : "bright", minutes: 7 * 60, days: [], fade: 0, on: true };
    const opts = [...mine.map((s) => [`custom:${s.id}`, s.name]), ...Object.entries(SCENE_NAMES)];
    const hhmm = (m) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
    const body = House.sheet(`
      <h3>${old ? "Edit timer" : "New timer"}</h3>
      <label class="fld">Scene<select class="field" id="tmScene">${opts.map(([v, n]) => `<option value="${esc(v)}" ${v === t.scene ? "selected" : ""}>${esc(n)}</option>`).join("")}</select></label>
      <label class="fld">Time<input class="field" type="time" id="tmTime" value="${hhmm(t.minutes)}"></label>
      <div class="fld">Days <span style="font-weight:500">(none = every day)</span></div>
      <div class="days" id="tmDays">${DAY_LETTERS.map((d, i) => `<button data-day="${i + 1}" aria-label="${DAY_NAMES[i]}">${d}</button>`).join("")}</div>
      <div class="fld">Fade</div>
      <div class="seg3" id="tmFade" style="--n:4;margin-top:6px">${FADES.map(([s, n]) => `<button data-fade="${s}">${n}</button>`).join("")}</div>
      <p class="note" id="tmNext"></p>
      <div class="list"><button class="primary full" id="tmSave">Save timer</button>
      ${old ? `<button class="ghost center danger" id="tmDelete">Delete timer</button>` : ""}</div>`);
    const paint = () => {
      body.querySelectorAll("[data-day]").forEach((b) => b.classList.toggle("on", t.days.includes(+b.dataset.day)));
      body.querySelectorAll("[data-fade]").forEach((b) => b.classList.toggle("on", +b.dataset.fade === t.fade));
      body.querySelector("#tmNext").textContent = `${daysText(t.days)} at ${fmtTime(t.minutes)}. Next: ${fmtNext(nextFire({ ...t, on: true }))}.`;
    };
    paint();
    body.querySelector("#tmScene").onchange = (e) => (t.scene = e.target.value);
    body.querySelector("#tmTime").onchange = (e) => { const [h, m] = e.target.value.split(":").map(Number); t.minutes = (h || 0) * 60 + (m || 0); paint(); };
    body.querySelector("#tmDays").onclick = (e) => { const b = e.target.closest("[data-day]"); if (!b) return; buzz(6); const d = +b.dataset.day; t.days = t.days.includes(d) ? t.days.filter((x) => x !== d) : [...t.days, d]; paint(); };
    body.querySelector("#tmFade").onclick = (e) => { const b = e.target.closest("[data-fade]"); if (b) { buzz(6); t.fade = +b.dataset.fade; paint(); } };
    body.querySelector("#tmSave").onclick = () => {
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
  const scene = (id, name, sub, c1, c2, icon) => `<button class="scene glass" data-scene="${id}" style="--sc: linear-gradient(135deg,${c1},${c2}); --sc0:${c2}"><span class="ic">${svg(icon)}</span><b>${name}</b><span>${sub}</span></button>`;

  House.side({
    id: "lights", name: "Lights", icon: "bulb", blurb: "LIFX bulbs on your Wi-Fi",
    tabs: [
      { id: "lights", label: "Lights", icon: "bulb", html: `
        <div class="card glass" id="master">
          <div class="head-card">
            <div class="grow"><b>All lights</b><div class="status-line" id="masterSub">—</div></div>
            <button class="round-btn glass" id="lightsRefresh" aria-label="Look again">${svg("refresh")}</button>
            <button class="pswitch" id="allSwitch" aria-label="All lights on or off"><span class="lbl" id="allLbl">OFF</span><span class="knob">${svg("power")}</span></button>
          </div>
          <div class="slide">${svg("sun")}<input type="range" id="allBri" min="1" max="100" value="100"><output id="allBriOut">100%</output></div>
        </div>
        <div id="rooms"></div>
        <div class="card glass empty" id="lightsEmpty" hidden>
          <div class="big">${svg("bulb")}</div>
          <b id="emptyTitle">Looking for lights…</b>
          <p id="emptyText">Your phone needs to be on the home Wi-Fi.</p>
          <button class="primary" id="emptyScan">Find lights</button>
        </div>` },
      { id: "scenes", label: "Scenes", icon: "star", html: `
        <div class="label">Scenes</div>
        <div class="grid2">
          ${scene("bright", "Bright", "All on, full and neutral", "#ffe08a", "#ffb547", "sun")}
          ${scene("movie", "Movie", "Dim and warm", "#8b7bff", "#ff6bd5", "tv")}
          ${scene("night", "Night light", "Barely on, warmest", "#ff9f43", "#e0334d", "moon")}
          ${scene("off", "All off", "Every light, slow fade", "#6b7080", "#2a3150", "power")}
        </div>
        <div class="label">My scenes</div>
        <div class="grid2" id="myScenes"></div>` },
      { id: "timers", label: "Timers", icon: "clock", html: `
        <div class="label">Every day</div>
        <div class="card glass">
          <div class="set-row">
            <div class="set-text"><b>Bedtime</b><span id="bedSub">Turn every light off at a set time</span></div>
            <button class="tgl" id="bedTgl" aria-label="Bedtime on or off"><i></i></button>
          </div>
          <div class="set-row" id="bedTimeRow">
            <div class="set-text"><b>Time</b><span>Lights fade off over 3 seconds</span></div>
            <input class="field time-field" type="time" id="bedTime" value="23:30">
          </div>
        </div>
        <div class="label">Scene timers<span class="cnt" id="timerNext"></span></div>
        <div id="timerList"></div>
        <button class="ghost center" id="addTimer" style="flex:none">${svg("plus", 'style="width:18px;height:18px;vertical-align:-4px"')} Add a timer</button>
        <p class="note">Timers and Bedtime work with the app closed. If your phone restarts, they're set again on their own.</p>` },
      { id: "settings", label: "Settings", icon: "gear" },
    ],
    settingsHtml: `
      <div class="label">Lights</div>
      <div class="card glass">
        <button class="primary full" id="scanBtn">Find lights on Wi-Fi</button>
        <p class="note">Missing a bulb? Scan every address on your network instead. It takes a few seconds.</p>
        <div class="row" style="margin-top:10px">
          <input class="field" id="range" inputmode="decimal" placeholder="192.168.50" aria-label="Network to scan">
          <button class="primary" id="rangeBtn">Scan</button>
        </div>
        <div class="list"><button class="ghost center danger" id="forgetBtn">Forget all lights</button></div>
        <p class="note">LIFX bulbs only join <b>2.4 GHz</b> Wi-Fi. Names and rooms come from the LIFX app.</p>
      </div>`,
    guide: [
      ["bulb", "Turn a light on or off", "Tap its tile. Drag the bar on the tile to dim it. The ⋯ button opens the details: colour and warm–cool on bulbs that have them."],
      ["power", "All lights and rooms", "The big switch turns every light on or off; the bar under it dims all lights that are on. Each room has its own Turn on / Turn off."],
      ["star", "Scenes", "Bright, Movie (dim and warm), Night light and All off, for every light at once."],
      ["plus", "Your own scenes", "Scenes → New scene. Give it a name and an icon, then set each light to On (with its brightness), Off, or Leave as it is. “Copy how the lights are now” fills it in from the lights as they are. Try it before saving. Tap ✎ on a scene to change or delete it."],
      ["clock", "Scene timers", "Timers → Add a timer runs any scene at a time you pick, on the days you pick (none picked = every day). Fade in slowly for a gentle wake-up. They run even with the app closed."],
      ["moon", "Bedtime", "Timers → Bedtime turns every light off at the same time each day."],
      ["apps", "Home-screen widget", "Long-press your home screen → Widgets → House to add All on / All off."],
      ["search", "A bulb is missing", "Check its wall switch is on. Then Settings → scan every address. Names and rooms come from the LIFX app."],
    ],
    mount() {
      q("#rooms").addEventListener("click", (e) => {
        const room = e.target.closest("[data-room]");
        if (room) { buzz(); const ids = lights.filter((l) => (l.group || "Other") === room.dataset.room).map((l) => l.id); power(ids, !room.classList.contains("on")); return; }
        const more = e.target.closest("[data-more]");
        if (more) { buzz(6); openLight(more.dataset.more); return; }
        if (e.target.matches("input")) return;
        const t = e.target.closest(".tile");
        if (!t) return;
        const l = byId(t.dataset.id);
        if (!l.online) { toast(`${l.label} isn't answering. Is its switch on?`); return; }
        buzz();
        power([l.id], !l.on);
      });
      q("#rooms").addEventListener("input", (e) => {
        const id = e.target.dataset.bri;
        if (!id) return;
        const v = +e.target.value, l = byId(id);
        e.target.style.setProperty("--p", v + "%");
        const t = e.target.closest(".tile");
        t.querySelector(".tile-sub").textContent = v + "%";
        t.style.setProperty("--b", v / 100);
        setBri([id], v);
        if (!l.on) { l.on = true; t.classList.add("on"); Lights.power({ ids: [id], on: true }).catch(() => {}); }
        renderSummary();
      });
      const holdStart = (e) => { if (e.target.matches("input[type=range]")) dragging++; };
      const holdEnd = (e) => { if (e.target.matches("input[type=range]") && dragging) { dragging--; setTimeout(render, 300); } };
      document.addEventListener("pointerdown", holdStart, true);
      document.addEventListener("pointerup", holdEnd, true);
      document.addEventListener("pointercancel", holdEnd, true);

      $("allSwitch").onclick = () => { buzz(14); power(null, !lights.some((l) => l.on && l.online)); };
      $("allBri").oninput = (e) => {
        const v = +e.target.value;
        setSlider($("allBri"), $("allBriOut"), v);
        const ids = lights.filter((l) => l.on).map((l) => l.id);
        if (ids.length) setBri(ids, v);
      };
      $("lightsRefresh").onclick = () => { buzz(6); refresh({ timeout: 2500, manual: true }); };
      $("emptyScan").onclick = () => refresh({ timeout: 3000, manual: true });

      document.querySelectorAll("[data-scene]").forEach((b) => (b.onclick = async () => {
        buzz(14);
        const name = b.dataset.scene;
        toast(`${SCENE_NAMES[name]}…`);
        try {
          await Lights.scene({ name });
          for (const l of lights) l.on = name !== "off";
          render();
          toast(SCENE_NAMES[name]);
          setTimeout(() => refresh(), 1800);
        } catch { toast("Couldn't reach the lights", true); }
      }));

      $("myScenes").addEventListener("click", (e) => {
        const ed = e.target.closest("[data-edit]");
        if (ed) { buzz(6); openScene(ed.dataset.edit); return; }
        const c = e.target.closest("[data-my]");
        if (c) runMine(c.dataset.my);
      });
      $("timerList").addEventListener("click", (e) => {
        const tg = e.target.closest("[data-ttoggle]");
        if (tg) { buzz(); const t = timers.find((x) => x.id === tg.dataset.ttoggle); t.on = !t.on; saveTimers(t.on ? `Timer on · next ${fmtNext(nextFire(t))}` : "Timer off"); return; }
        const r = e.target.closest("[data-timer]");
        if (r) { buzz(6); openTimer(r.dataset.timer); }
      });
      $("addTimer").onclick = () => { buzz(6); openTimer(null); };
      Lights.getScenes().then((r) => { mine = r.scenes || []; renderMine(); }).catch(() => {});
      Lights.getTimers().then((r) => { timers = r.timers || []; renderTimers(); }).catch(() => {});

      $("bedTgl").onclick = async () => {
        buzz();
        const b = await saveBedtime(!$("bedTgl").classList.contains("on"));
        toast(b.on ? `Bedtime set for ${fmtTime(b.minutes)}` : "Bedtime off");
      };
      $("bedTime").onchange = () => saveBedtime(true);
      Lights.getBedtime().then(showBedtime).catch(() => {});

      $("scanBtn").onclick = () => { buzz(); refresh({ timeout: 3000, manual: true }); };
      $("rangeBtn").onclick = () => {
        const range = ($("range").value || $("range").placeholder).trim().replace(/\.\*?$/, "").split(".").slice(0, 3).join(".");
        if (!/^\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(range)) { toast("Type the first three parts, like 192.168.50", true); return; }
        buzz();
        toast(`Scanning ${range}.1 – 254…`);
        refresh({ timeout: 4000, range, manual: true });
      };
      $("forgetBtn").onclick = async () => {
        if (!confirm("Forget all lights? They'll be found again on the next scan.")) return;
        await Lights.forget();
        lights = [];
        render();
        toast("Lights forgotten");
      };

      // Show the last known bulbs at once, then check them. Re-check every 20 s while this side is open.
      Lights.cached().then((r) => { lights = r.lights; subnet = r.subnet; render(); }).catch(() => {}).finally(() => refresh({ timeout: 2500 }));
      setInterval(() => { if (!document.hidden && !dragging && House.current === "lights") refresh(); }, 20000);
    },
    onShow(tab) {
      renderSummary();
      if (tab === "lights") refresh();
    },
    /** For the Wi-Fi list: bulbs we know by address. */
    known: () => lights.map((l) => ({ ip: l.ip, mac: l.id.match(/../g).join(":"), name: l.label, type: "bulb", hint: `LIFX · ${l.group || ""}`, online: l.online })),
  });
})();
