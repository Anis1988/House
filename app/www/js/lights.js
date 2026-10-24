// 💡 Lights: LIFX bulbs over the home Wi-Fi (native LightsPlugin). Tabs: Lights · Scenes · Timers · Settings.

const MOCK_BUILTINS = [
  { id: "bright", name: "Bright", icon: "sun", lights: { "*": { mode: "on", bri: 100, kelvin: 4000 } } },
  { id: "movie", name: "Movie", icon: "tv", lights: { "*": { mode: "on", bri: 12, kelvin: 2200 } } },
  { id: "night", name: "Night light", icon: "moon", lights: { "*": { mode: "on", bri: 3, kelvin: 1500 } } },
  { id: "off", name: "All off", icon: "power", lights: { "*": { mode: "off" } } },
];
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
    getVacation: async () => store.json("mock.vac", { on: false, from: "sunset", until: 1410, next: 0 }),
    setVacation: async (v) => (store.setJson("mock.vac", { ...v, next: v.on ? Date.now() + 3600e3 : 0 }), store.json("mock.vac")),
    getScenes: async () => ({ scenes: store.json("mock.scenes", null) || MOCK_BUILTINS }), setScenes: async ({ scenes }) => store.setJson("mock.scenes", scenes),
    restoreScenes: async () => { const s = store.json("mock.scenes", []); const out = [...MOCK_BUILTINS.filter((b) => !s.some((x) => x.id === b.id)), ...s]; store.setJson("mock.scenes", out); return { scenes: out }; },
    runScene: async () => ({ failed: [] }), setCreds: async () => {}, setLocation: async () => {},
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
      { id: "scenes", label: "Scenes", icon: "star", html: House.scenes.scenesHtml },
      { id: "timers", label: "Timers", icon: "clock", html: House.scenes.timersHtml },
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
      </div>` + House.scenes.settingsHtml,
    guide: [
      ["bulb", "Turn a light on or off", "Tap its tile. Drag the bar on the tile to dim it. The ⋯ button opens the details: colour and warm–cool on bulbs that have them."],
      ["power", "All lights and rooms", "The big switch turns every light on or off; the bar under it dims all lights that are on. Each room has its own Turn on / Turn off."],
      ["apps", "Home-screen widget", "Long-press your home screen → Widgets → House to add All on / All off."],
      ["search", "A bulb is missing", "Check its wall switch is on. Then Settings → scan every address. Names and rooms come from the LIFX app."],
      ...House.scenes.guide,
    ],
    mount() {
      House.scenes.mount();
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
      House.scenes.onShow(tab);
      renderSummary();
      if (tab === "lights") refresh();
    },
    /** For the Wi-Fi list: bulbs we know by address. */
    /** For the Home side: the bulbs as they are, a scene that just ran, and a fresh look. */
    list: () => lights,
    applyScene(s) {
      const every = s.lights?.["*"];
      for (const l of lights) { const w = s.lights?.[l.id] || every; if (w) { l.on = w.mode === "on"; if (w.mode === "on" && w.bri) l.bri = w.bri / 100 * 65535; } }
      render();
      setTimeout(() => refresh(), 1800);
    },
    refresh: () => refresh(),
    known: () => lights.map((l) => ({ ip: l.ip, mac: l.id.match(/../g).join(":"), name: l.label, type: "bulb", hint: `LIFX · ${l.group || ""}`, online: l.online })),
  });
})();
