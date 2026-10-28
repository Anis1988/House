// House shell: the device switch at the top, each device's own bottom tabs, Settings and Guide,
// plus theme, toasts, bottom sheets and the update banner. Each device lives in its own file and
// registers itself with House.side({...}).

const $ = (id) => document.getElementById(id);
const buzz = (ms = 10) => { try { navigator.vibrate(ms); } catch {} };
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const store = {
  get(k, d = null) { try { const v = localStorage.getItem(k); return v === null ? d : v; } catch { return d; } },
  set(k, v) {
    try { v === null || v === undefined ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch {}
    // Device logins changed: hand them to the native side, which runs scene timers with the app closed.
    if (/^(lg|ss|nest|wyze|lifx)\.|^wifi\.(router|range)$|^pc\.list$|^wifi\.last$/.test(k)) House?.syncCreds?.();
  },
  json(k, d) { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } },
  setJson(k, v) { this.set(k, JSON.stringify(v)); },
};

let toastTimer;
function toast(text, err) {
  const t = $("toast");
  t.textContent = text;
  t.className = "toast glass show" + (err ? " err" : "");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.className = "toast glass"), 2400);
}

function setSlider(input, out, v, suffix = "%") {
  input.value = v;
  const min = +input.min || 0, max = +input.max || 100;
  input.style.setProperty("--p", ((v - min) / (max - min)) * 100 + "%");
  if (out) out.textContent = v + suffix;
}

/** Calls fn at most every ms while it keeps being called (slider drags), always ending with the last value. */
function throttled(fn, ms = 120) {
  let last = 0, timer = null, pending = null;
  const run = () => { last = Date.now(); timer = null; const a = pending; pending = null; fn(...a); };
  return (...args) => {
    pending = args;
    if (timer) return;
    timer = setTimeout(run, Math.max(0, last + ms - Date.now()));
  };
}

// Icons (stroke paths, 24x24)
const ICON = {
  bulb: '<path d="M9 18h6M10 21h4M12 3a6 6 0 0 1 3.5 10.9c-.6.4-1 1.1-1 1.8V16h-5v-.3c0-.7-.4-1.4-1-1.8A6 6 0 0 1 12 3z"/>',
  tv: '<rect x="2" y="5" width="20" height="13" rx="2"/><path d="M8 21h8"/>',
  screen: '<rect x="3" y="4" width="18" height="12" rx="2"/><path d="M12 16v4M8 20h8"/>',
  thermo: '<path d="M14 14.8V4a2 2 0 1 0-4 0v10.8a4 4 0 1 0 4 0z"/>',
  cam: '<path d="M23 7l-7 5 7 5V7z"/><rect x="1" y="5" width="15" height="14" rx="2"/>',
  wifi: '<path d="M5 12.5a10 10 0 0 1 14 0M8.5 16a5 5 0 0 1 7 0M2 9a15 15 0 0 1 20 0"/><circle cx="12" cy="19.5" r="1"/>',
  star: '<path d="M12 3l1.9 5.8H20l-4.9 3.6 1.9 5.8-5-3.6-5 3.6 1.9-5.8L4 8.8h6.1z"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  gear: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>',
  remote: '<rect x="7" y="2" width="10" height="20" rx="5"/><circle cx="12" cy="8" r="2"/><path d="M12 14v.01M12 17v.01"/>',
  apps: '<rect x="3" y="3" width="7" height="7" rx="2"/><rect x="14" y="3" width="7" height="7" rx="2"/><rect x="3" y="14" width="7" height="7" rx="2"/><rect x="14" y="14" width="7" height="7" rx="2"/>',
  bell: '<path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9M13.7 21a2 2 0 0 1-3.4 0"/>',
  power: '<path d="M12 3v8"/><path d="M6.3 6.8a8 8 0 1 0 11.4 0"/>',
  refresh: '<path d="M21 12a9 9 0 1 1-2.6-6.4"/><path d="M21 3v6h-6"/>',
  dots: '<circle cx="5" cy="12" r="1.3"/><circle cx="12" cy="12" r="1.3"/><circle cx="19" cy="12" r="1.3"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
  moon: '<path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/>',
  auto: '<circle cx="12" cy="12" r="9"/><path d="M12 3a9 9 0 0 0 0 18z" fill="currentColor" stroke="none"/>',
  up: '<path d="M6 15l6-6 6 6"/>', down: '<path d="M6 9l6 6 6-6"/>', left: '<path d="M15 6l-6 6 6 6"/>', right: '<path d="M9 6l6 6-6 6"/>',
  x: '<path d="M6 6l12 12M18 6L6 18"/>',
  plus: '<path d="M12 5v14M5 12h14"/>', minus: '<path d="M5 12h14"/>',
  back: '<path d="M9 14L4 9l5-5"/><path d="M4 9h11a5 5 0 0 1 0 10h-1"/>',
  home: '<path d="M3 11l9-7 9 7v9a1 1 0 0 1-1 1h-5v-6h-6v6H4a1 1 0 0 1-1-1z"/>',
  mute: '<path d="M11 5L6 9H2v6h4l5 4V5zM23 9l-6 6M17 9l6 6"/>',
  vol: '<path d="M11 5L6 9H2v6h4l5 4V5zM15.5 8.5a5 5 0 0 1 0 7"/>',
  play: '<path d="M7 4l13 8-13 8z"/>', pause: '<path d="M8 4v16M16 4v16"/>',
  input: '<path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4M10 17l5-5-5-5M15 12H3"/>',
  menu: '<path d="M4 6h16M4 12h16M4 18h16"/>',
  link: '<path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7"/>',
  check: '<path d="M20 6L9 17l-5-5"/>',
  lock: '<rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>',
  phone: '<rect x="6" y="2" width="12" height="20" rx="2"/><path d="M11 18h2"/>',
  laptop: '<rect x="4" y="5" width="16" height="11" rx="1"/><path d="M2 20h20"/>',
  speaker: '<rect x="5" y="2" width="14" height="20" rx="3"/><circle cx="12" cy="14" r="4"/><path d="M12 6h.01"/>',
  car: '<path d="M5 17h14l-1.5-6h-11zM7 11l2-5h6l2 5"/><circle cx="8" cy="17" r="2"/><circle cx="16" cy="17" r="2"/>',
  garage: '<path d="M3 21V9l9-6 9 6v12M7 21v-8h10v8M7 16h10"/>',
  router: '<rect x="2" y="13" width="20" height="7" rx="2"/><path d="M6 17h.01M10 17h.01M15 13l3-7M9 13L6 6"/>',
  chip: '<rect x="6" y="6" width="12" height="12" rx="2"/><path d="M9 2v4M15 2v4M9 18v4M15 18v4M2 9h4M2 15h4M18 9h4M18 15h4"/>',
  leaf: '<path d="M11 20A7 7 0 0 1 9.8 6.1C15.5 5 17 4.5 19 2c1 2 2 4.2 2 8 0 5.5-4.8 10-10 10z"/><path d="M2 21c0-3 1.9-5.4 5.1-6"/>',
  drop: '<path d="M12 3s6 7 6 11a6 6 0 0 1-12 0c0-4 6-11 6-11z"/>',
  flame: '<path d="M12 22c4 0 7-3 7-7 0-5-5-7-5-12-3 2-4 5-4 7-1-1-2-2-2-4-2 2-3 5-3 9 0 4 3 7 7 7z"/>',
  snow: '<path d="M12 2v20M4.9 4.9l14.2 14.2M2 12h20M4.9 19.1L19.1 4.9"/>',
  chart: '<path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/>',
  key: '<circle cx="7.5" cy="15.5" r="5.5"/><path d="M21 2l-9.6 9.6M15.5 7.5l3 3L22 7l-3-3"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/>',
};
const svg = (name, extra = "") => `<svg viewBox="0 0 24 24" ${extra}>${ICON[name] || name}</svg>`;

/* Native plugins. In a desktop browser (no app around the page), small stand-ins so the page still renders. */
const NATIVE = !!window.Capacitor?.isNativePlatform?.();
// Browser stand-in for the router controls (RouterControl), so the Wi-Fi Control tab renders.
const mockRouter = (() => {
  const m = { filters: { "aa:bb:cc:00:00:01": { paused: true, bedtime: null }, "aa:bb:cc:00:00:02": { paused: false, bedtime: { on: true, days: 31, start: "2100", end: "0700" } } },
    status: { timers: [{ id: "focus:x", kind: "unblock", at: Date.now() + 23 * 60e3, macs: ["AA:BB:CC:00:00:03"], label: "Kids" }], pausedAll: null, prio: {} },
    guest: { on: true, ssid: "Home Guest", pass: "welcome123", open: false, left: 5400 } };
  return async (a) => {
    await sleep(300);
    switch (a.op) {
      case "filters": case "block": case "bedtime": return m.filters;
      case "status": case "focus": case "pauseAll": case "resumeAll": case "endTimer": case "priority": return m.status;
      case "guest": return a.on === undefined ? m.guest : (m.guest = { ...m.guest, on: a.on });
      case "health": return { model: "RT-AX88U", firmware: "3.0.0.4.388_24231", update: "", cpu: 7, mem: 41, cpuTemp: 62, uptime: 9 * 86400 + 4 * 3600 };
      case "rebootSchedule": return { on: !!a.on, days: a.days || "1000000", time: a.time || "0300" };
      case "usage": return { enabled: true, devices: [{ mac: "aa:bb:cc:00:00:01", down: 8.2e9, up: 4e8 }, { mac: "aa:bb:cc:00:00:02", down: 2.1e9, up: 1.2e8 }, { mac: "aa:bb:cc:00:00:03", down: 4.5e8, up: 3e7 }] };
      case "live": return { at: Date.now(), devices: [{ mac: "aa:bb:cc:00:00:01", down: Date.now() * 2, up: Date.now() / 5 }] };
      default: return {};
    }
  };
})();
const plugin = (name, fallback) => (NATIVE ? window.capacitorExports.registerPlugin(name) : fallback);
const Net = plugin("Net", {
  addListener: () => {}, open: async () => { throw new Error("Only in the app"); }, send: async () => {}, close: async () => {},
  fetchImage: async () => { throw new Error("no"); }, lanGet: async () => { throw new Error("no"); }, wake: async () => {},
  localPrefix: async () => ({ prefix: "192.168.50", gateway: "192.168.50.1" }), scan: async () => ({ hosts: [] }),
  sweep: async () => ({ alive: [] }), ssdp: async () => ({ devices: [] }), mdns: async () => ({ devices: [] }), md5: async ({ text }) => ({ hash: text }),
  getWatch: async () => ({ settings: store.json("mock.watch", {}), presence: {}, notifications: true }),
  setWatch: async ({ settings }) => (store.setJson("mock.watch", settings), { settings, presence: {}, notifications: true }),
  checkWatch: async () => ({ settings: store.json("mock.watch", {}), presence: {}, notifications: true }),
  getNestWatch: async () => ({ settings: store.json("mock.nestw", {}), history: Array.from({ length: 60 }, (_, i) => [Date.now() - (59 - i) * 15 * 60e3, 20 + Math.sin(i / 8), 40 + 5 * Math.cos(i / 10)]), notifications: true }),
  setNestWatch: async ({ settings }) => (store.setJson("mock.nestw", settings), { settings, history: [], notifications: true }),
  nestTick: async () => ({ settings: store.json("mock.nestw", {}), history: Array.from({ length: 60 }, (_, i) => [Date.now() - (59 - i) * 15 * 60e3, 20 + Math.sin(i / 8), 40 + 5 * Math.cos(i / 10)]), notifications: true }),
  nestTestEvents: async () => ({ events: 0 }),
  getWifiLog: async () => ({ devices: [{ at: Date.now() - 3600e3, key: "aa", name: "iPhone", ip: "192.168.50.127", event: "left" }, { at: Date.now() - 600e3, key: "bb", name: "Echo", ip: "192.168.50.79", event: "joined" }], outages: [{ start: Date.now() - 86400e3, end: Date.now() - 86400e3 + 900e3 }] }),
  clearWifiLog: async () => ({ devices: [], outages: [] }),
  checkInternet: async () => ({ up: true }),
  checkPresence: async () => ({ settings: store.json("mock.watch", {}), presence: {}, notifications: true }),
  addThisPhone: async ({ name }) => { const s = store.json("mock.watch", {}); s.people = [...(s.people || []).filter((p) => p.key !== "this-phone"), { key: "this-phone", name }]; store.setJson("mock.watch", s); return { settings: s, presence: { "this-phone": { home: true, since: Date.now() } }, notifications: true }; },
  speedTest: async () => (await sleep(1500), { down: 512.3, up: 41.7, ping: 12 }),
  flashTest: async () => {},
  getAuto: async () => ({ settings: store.json("mock.auto", {}), dark: true }),
  setAuto: async ({ settings }) => (store.setJson("mock.auto", settings), { settings, dark: true }),
  tvState: async () => ({ on: false }),
  getPcWake: async () => store.json("mock.pcwake", { on: false, minutes: 420, days: [] }),
  setPcWake: async (w) => (store.setJson("mock.pcwake", w), w),
  homeStatus: async () => ({ people: [{ key: "this-phone", name: "Anis", home: true, since: Date.now() - 7200e3, seenAt: Date.now() }, { key: "aa", name: "Roza", home: false, since: Date.now() - 1800e3, seenAt: Date.now() - 1800e3 }],
    atHome: true, netUp: true, lastSpeed: { down: 512.3, up: 41.7, ping: 12, at: Date.now() - 3600e3 },
    nest: { temp: 21.4, hum: 41, mode: "HEAT", eco: "OFF", heat: 21, scale: "CELSIUS", hvac: "HEATING", at: Date.now() }, ring: { at: Date.now() - 5400e3, kind: "ring", device: "Front door", image: null } }),
  nestQuick: async ({ dir }) => ({ temp: 21.4, hum: 41, mode: "HEAT", eco: "OFF", heat: 21 + 0.5 * (dir || 0), scale: "CELSIUS", hvac: "HEATING", at: Date.now() }),
  router: async (a) => mockRouter(a),
  qr: async () => ({ dataUrl: "data:image/svg+xml;utf8," + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="10" height="10" fill="#fff"/><rect x="1" y="1" width="3" height="3"/><rect x="6" y="1" width="3" height="3"/><rect x="1" y="6" width="3" height="3"/><rect x="5" y="5" width="2" height="2"/></svg>') }),
});

const House = {
  sides: [],
  current: null,      // side id
  tab: null,          // tab id within the side
  side(def) { this.sides.push(def); },
  byId(id) { return this.sides.find((s) => s.id === id); },
  hidden() { return store.json("house.hidden", []); },
  /* A foldable section: closed until opened, and it stays as you left it (kept per key).
     `sub` is a short line under the title (give it an id with subId to update it later). */
  fold(key, title, icon, body, { sub = "", subId = "", open = null } = {}) {
    const isOpen = open ?? store.json("fold", {})[key] === true;
    return `<details class="fold glass" data-fold="${esc(key)}"${isOpen ? " open" : ""}><summary>
      <span class="ic-sm">${svg(icon)}</span><span class="fold-t"><b>${title}</b><span class="fold-s"${subId ? ` id="${subId}"` : ""}>${sub}</span></span>
      <span class="fold-chev">${svg('<path d="M6 9l6 6 6-6"/>')}</span></summary><div class="fold-body">${body}</div></details>`;
  },

  /** Sends the TV, screen, Nest and Wyze logins to the native side (waits a moment to batch changes). */
  syncCreds() {
    clearTimeout(this._credsTimer);
    this._credsTimer = setTimeout(() => {
      const nest = store.json("nest.cfg", {}), tok = store.json("nest.tok", null), wy = store.json("wyze.acct", null), router = store.json("wifi.router", {});
      Lights.setCreds({ creds: {
        lgIp: store.get("lg.ip", ""), lgKey: store.get("lg.key", ""), lgMac: store.get("lg.mac", ""),
        lgManifest: JSON.stringify(typeof LG !== "undefined" ? LG.manifest : {}),
        ssIp: store.get("ss.ip", ""), ssToken: store.get("ss.token", ""), ssMac: store.get("ss.mac", ""),
        nestProject: nest.project || "", nestClient: nest.clientId || "", nestSecret: nest.secret || "", nestRefresh: tok?.refresh || "", nestSub: store.get("nest.sub", ""),
        wyzeAccess: wy?.access || "", wyzeRefresh: wy?.refresh || "", wyzePhone: store.get("wyze.phone", ""), wyzeCams: store.json("wyze.cams", []),
        routerAddr: router.addr || "", routerUser: router.user || "admin", routerPass: router.pass || "",
        lifxToken: store.get("lifx.token", ""),
        scanRange: store.get("wifi.range", ""),
        pcList: store.json("pc.list", []),
        // Names for the device picker of the Priority widget.
        wifiDevices: store.json("wifi.last", []).filter((d) => d.mac).map((d) => ({ mac: d.mac.toLowerCase(), label: d.label, kind: d.kind, online: !!d.online })),
      } }).catch(() => {});
    }, 400);
  },
  visible() { const h = this.hidden(); return this.sides.filter((s) => !h.includes(s.id)); },
  page(sideId, tabId) { return document.querySelector(`.page[data-page="${sideId}:${tabId}"]`); },

  start() {
    // Remember which foldable sections are open ("toggle" doesn't bubble, so listen while capturing).
    document.addEventListener("toggle", (e) => {
      const d = e.target;
      if (!d.matches?.("details[data-fold]")) return;
      const f = store.json("fold", {});
      if (d.open) f[d.dataset.fold] = true; else delete f[d.dataset.fold];
      store.setJson("fold", f);
    }, true);
    // Each side gets one page per tab (Settings and Guide are built here).
    const pages = $("pages");
    for (const s of this.sides) {
      for (const t of s.tabs) {
        const p = document.createElement("section");
        p.className = "page";
        p.dataset.page = `${s.id}:${t.id}`;
        p.innerHTML = t.id === "settings" ? this._settingsHtml(s) : t.html || "";
        pages.appendChild(p);
      }
      const g = document.createElement("section");
      g.className = "page guide";
      g.dataset.page = `${s.id}:guide`;
      g.innerHTML = `<div class="label">${esc(s.name)} guide</div>` + (s.guide || []).map(([icon, title, text]) =>
        `<div class="card glass"><h4>${svg(icon)}${esc(title)}</h4><p>${text}</p></div>`).join("");
      pages.appendChild(g);
    }
    for (const s of this.sides) s.mount?.();
    this.syncCreds();
    this._bindGeneral();
    this._buildSwitch();
    const want = store.get("house.side");
    const first = this.visible().find((s) => s.id === want) || this.visible()[0] || this.sides[0];
    this.show(first.id);
    $("guideBtn").onclick = () => { buzz(6); this.tab === "guide" ? this.showTab(this.byId(this.current).tabs[0].id) : this.showTab("guide"); };
    $("scrim").onclick = () => this.closeSheet();
    window.appBack = () => this.back();
    document.addEventListener("visibilitychange", () => { if (!document.hidden) this.byId(this.current)?.onShow?.(this.tab); });
    this._applyTheme();
    this._checkForUpdate(false);
    setInterval(() => this._checkForUpdate(false), 6 * 60 * 60 * 1000);
  },

  // Fade the row's edges where more chips are hidden, so it's clear the row scrolls.
  _edges() {
    const sw = $("switch");
    sw.classList.toggle("more-left", sw.scrollLeft > 4);
    sw.classList.toggle("more-right", sw.scrollLeft + sw.clientWidth < sw.scrollWidth - 4);
  },

  _buildSwitch() {
    if (!this._edgeWatch) {
      this._edgeWatch = true;
      $("switch").addEventListener("scroll", () => this._edges(), { passive: true });
      addEventListener("resize", () => this._edges());
    }
    const vis = this.visible();
    $("switch").innerHTML = vis.map((s) => `<button class="chip-side" role="tab" data-side="${s.id}">${svg(s.icon)}${esc(s.short || s.name)}</button>`).join("");
    $("switch").hidden = vis.length < 2;
    $("switch").querySelectorAll("[data-side]").forEach((b) => (b.onclick = () => { buzz(6); this.show(b.dataset.side); }));
    if (this.current) this._markSwitch();
  },
  _markSwitch() {
    $("switch").querySelectorAll("[data-side]").forEach((b) => b.classList.toggle("on", b.dataset.side === this.current));
    // Keep the chosen chip in the middle, so the chips on both sides stay in view.
    const sw = $("switch"), on = sw.querySelector(".on");
    if (on) sw.scrollTo({ left: on.offsetLeft - sw.offsetLeft - (sw.clientWidth - on.offsetWidth) / 2, behavior: "smooth" });
    this._edges();
  },

  /** Switch device: colours, logo, bottom tabs and pages all change, like opening another app. */
  show(sideId) {
    const s = this.byId(sideId);
    const swapped = this.current && this.current !== sideId;
    this.closeSheet();
    this.current = sideId;
    store.set("house.side", sideId);
    document.documentElement.dataset.side = sideId;
    document.body.classList.remove("dim");
    $("sideLogo").innerHTML = svg(s.icon);
    if (swapped) { const a = $("aurora"); a.classList.remove("swap"); void a.offsetWidth; a.classList.add("swap"); }
    this._markSwitch();
    const nav = $("nav");
    nav.style.setProperty("--n", s.tabs.length);
    nav.innerHTML = `<span class="indicator" id="indicator"></span>` + s.tabs.map((t) => `<button data-tab="${t.id}">${svg(t.icon)}${esc(t.label)}</button>`).join("");
    nav.querySelectorAll("[data-tab]").forEach((b) => (b.onclick = () => { buzz(6); this.showTab(b.dataset.tab); }));
    this.showTab(s.tabs[0].id);
  },

  showTab(tabId) {
    const s = this.byId(this.current);
    this.tab = tabId;
    document.querySelectorAll(".page").forEach((p) => p.classList.toggle("show", p.dataset.page === `${s.id}:${tabId}`));
    const i = s.tabs.findIndex((t) => t.id === tabId);
    $("nav").querySelectorAll("[data-tab]").forEach((b) => b.classList.toggle("on", b.dataset.tab === tabId));
    const ind = $("indicator");
    ind.style.opacity = i < 0 ? 0 : 1;
    if (i >= 0) ind.style.transform = `translateX(${i * 100}%)`;
    $("guideBtn").classList.toggle("on", tabId === "guide");
    this.page(s.id, tabId)?.scrollTo(0, 0);
    s.onShow?.(tabId);
  },

  // Back button: close a panel, then go to the side's first tab, then leave the app.
  back() {
    if ($("sheet").classList.contains("show")) { this.closeSheet(); return true; }
    const s = this.byId(this.current);
    if (this.tab !== s.tabs[0].id) { this.showTab(s.tabs[0].id); return true; }
    return false;
  },

  sheet(html) {
    $("sheetBody").innerHTML = html;
    $("sheet").classList.add("show");
    $("scrim").classList.add("show");
    $("sheet").scrollTop = 0;
    return $("sheetBody");
  },
  closeSheet() {
    if (!$("sheet").classList.contains("show")) return;
    $("sheet").classList.remove("show");
    $("scrim").classList.remove("show");
    this.onSheetClose?.();
    this.onSheetClose = null;
  },
  sheetOpen() { return $("sheet").classList.contains("show"); },

  /* Settings: the side's own sections first, then what's shared by every side. */
  _settingsHtml(s) {
    return (s.settingsHtml || "") + `
      <div class="label">Look</div>
      <div class="card glass">
        <div class="seg3">
          <button data-theme-set="auto">${svg("auto")}Auto</button>
          <button data-theme-set="light">${svg("sun")}Light</button>
          <button data-theme-set="dark">${svg("moon")}Dark</button>
        </div>
      </div>
      <div class="label">Devices in the app</div>
      <div class="card glass">
        ${this.sides.map((d) => `<div class="set-row">${svg(d.icon)}<div class="set-text"><b>${esc(d.name)}</b><span>${esc(d.blurb || "")}</span></div><button class="tgl" data-side-toggle="${d.id}" aria-label="Show ${esc(d.name)}"><i></i></button></div>`).join("")}
      </div>
      <div class="label">App</div>
      <div class="card glass">
        <div class="set-row"><div class="set-text"><b>House</b><span class="ver-text">Version —</span></div><button class="ghost center auto check-upd">Check for updates</button></div>
      </div>`;
  },
  _bindGeneral() {
    document.addEventListener("click", (e) => {
      const t = e.target.closest("[data-theme-set]");
      if (t) { buzz(6); this._setTheme(t.dataset.themeSet); return; }
      const d = e.target.closest("[data-side-toggle]");
      if (d) {
        buzz(6);
        const id = d.dataset.sideToggle, hidden = this.hidden();
        const hide = !hidden.includes(id);
        if (hide && this.visible().length <= 1) { toast("Keep at least one device"); return; }
        store.setJson("house.hidden", hide ? [...hidden, id] : hidden.filter((x) => x !== id));
        this._paintToggles();
        this._buildSwitch();
        toast(hide ? `${this.byId(id).name} hidden` : `${this.byId(id).name} shown`);
        return;
      }
      if (e.target.closest(".check-upd")) this._checkForUpdate(true);
    });
    this._paintToggles();
  },
  _paintToggles() {
    const h = this.hidden();
    document.querySelectorAll("[data-side-toggle]").forEach((b) => b.classList.toggle("on", !h.includes(b.dataset.sideToggle)));
  },

  /* Theme */
  _themePref() { return store.get("theme", "auto"); },
  _setTheme(pref) { store.set("theme", pref); this._applyTheme(); },
  _applyTheme() {
    const pref = this._themePref();
    const light = pref === "light" || (pref === "auto" && matchMedia("(prefers-color-scheme: light)").matches);
    document.documentElement.dataset.theme = light ? "light" : "dark";
    document.querySelectorAll("[data-theme-set]").forEach((b) => b.classList.toggle("on", b.dataset.themeSet === pref));
    Lights.setTheme({ dark: !light }).catch(() => {});
    if (!this._themeWatch) {
      this._themeWatch = true;
      matchMedia("(prefers-color-scheme: light)").addEventListener("change", () => this._applyTheme());
    }
  },

  /* Update banner: compare this install with the latest GitHub release */
  async _checkForUpdate(manual) {
    const parse = (v) => String(v || "").replace(/^v/i, "").split(".").map((n) => parseInt(n, 10) || 0);
    const newer = (a, b) => { a = parse(a); b = parse(b); for (let i = 0; i < 3; i++) if ((a[i] || 0) !== (b[i] || 0)) return (a[i] || 0) > (b[i] || 0); return false; };
    try {
      const installed = (await Lights.appVersion()).version;
      document.querySelectorAll(".ver-text").forEach((el) => (el.textContent = "Version " + String(installed).replace(/^v/i, "")));
      const rel = await (await fetch("https://api.github.com/repos/Anis1988/House/releases/latest", { cache: "no-store" })).json();
      const apk = (rel.assets || []).find((a) => a.name.endsWith(".apk"));
      if (!rel.tag_name || !newer(rel.tag_name, installed)) { if (manual) toast("You're on the latest version"); return; }
      if (store.get("updDismissed") === rel.tag_name && !manual) return;
      const url = apk ? apk.browser_download_url : rel.html_url;
      $("updVer").textContent = `${rel.tag_name} is ready to install`;
      $("updBanner").classList.add("show");
      $("updGo").onclick = () => { buzz(); Lights.openUrl({ url }).catch(() => toast("Couldn't open the download", true)); };
      $("updX").onclick = () => { $("updBanner").classList.remove("show"); store.set("updDismissed", rel.tag_name); };
      if (manual) this.showTab(this.byId(this.current).tabs[0].id);
    } catch {
      if (manual) toast("Couldn't check for updates", true);
    }
  },
};

/** Opens one of the allowed setup/sign-in links in the phone's browser. */
function openLink(url) {
  Lights.openUrl({ url }).catch(() => { if (!NATIVE) window.open(url, "_blank"); else toast("Couldn't open the link", true); });
}
document.addEventListener("click", (e) => {
  const a = e.target.closest("a[data-open]");
  if (a) { e.preventDefault(); openLink(a.getAttribute("href")); }
});
