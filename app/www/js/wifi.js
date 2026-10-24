// 📶 Wi-Fi: every device on the home network. Without a router sign-in it finds devices itself
// (sweep + SSDP + mDNS + what the other sides know). Signed in to the ASUS router, it shows the
// router's own list: names, MAC makers, online, Wi-Fi band and signal. Tabs: Devices · Settings.

(() => {
  let devices = [];      // merged list
  let busy = false;
  let filter = "";
  let routerTok = null;  // asus_token for this session
  const names = () => store.json("wifi.names", {});            // your own names, by MAC or address
  const router = () => store.json("wifi.router", { addr: "", user: "admin", pass: "" });
  const UA = "asusrouter-Android-DUTUtil-1.0.0.245";

  // What kind of device, from its name / maker / announcements.
  const KINDS = [
    [/lifx|bulb|light/i, "bulb", "Light"],
    [/webos|lg.*tv|oled|\btv\b|bravia|roku|chromecast|fire ?tv/i, "tv", "TV"],
    [/odyssey|monitor|tizen|samsung.*(screen|dtv)/i, "screen", "Screen"],
    [/wyze|camera|cam\b|ring|arlo|blink|tuya.*cam/i, "cam", "Camera"],
    [/nest|thermostat|ecobee/i, "thermo", "Thermostat"],
    [/echo|alexa|amazon|spotify|sonos|homepod|speaker|google home/i, "speaker", "Speaker"],
    [/tesla/i, "car", "Car"],
    [/myq|chamberlain|liftmaster|garage/i, "garage", "Garage"],
    [/asus|router|gateway|rt-/i, "router", "Router"],
    [/iphone|android|galaxy|pixel|phone|oneplus|xiaomi/i, "phone", "Phone"],
    [/macbook|laptop|desktop|windows|pc\b|imac|surface|intel|dell|lenovo|hp\b/i, "laptop", "Computer"],
  ];
  const kindOf = (text) => KINDS.find(([re]) => re.test(text)) || [null, "chip", "Device"];
  // Makers for the first half of a MAC address, for the ones in this home.
  const OUI = { "d0:73:d5": "LIFX", "80:48:2c": "Wyze", "e8:9c:25": "ASUS", "4c:fc:aa": "Tesla", "fc:91:5d": "Google (Nest)", "b4:23:a2": "Google (Nest)",
    "d8:e3:5e": "LG", "f4:14:bf": "LG", "2c:99:75": "Samsung", "00:71:47": "Amazon", "28:24:c9": "Amazon", "8c:2a:85": "Amazon", "4c:60:ad": "Amazon", "64:82:14": "MyQ (FN-LINK)" };
  const makerOf = (mac) => { if (!mac) return ""; const p = mac.toLowerCase().replace(/-/g, ":").slice(0, 8); return OUI[p] || (/^.[26ae]/i.test(mac) ? "Private address (phone or laptop)" : ""); };

  // What the open ports say about a device, when nothing else names it.
  function portHint(ports = []) {
    const has = (p) => ports.includes(p);
    if (has(3001)) return { name: "LG TV", kind: "tv" };
    if (has(8001)) return { name: "Samsung TV or screen", kind: "screen" };
    if (has(62078)) return { name: "Apple device", kind: "phone" };
    if (has(8009)) return { name: "Google Cast device", kind: "speaker" };
    if (has(1400)) return { name: "Sonos speaker", kind: "speaker" };
    if (has(554) && has(6668)) return { name: "Smart camera (Tuya)", kind: "cam" };
    if (has(554)) return { name: "Camera", kind: "cam" };
    if (has(6668)) return { name: "Smart device (Tuya)", kind: "chip" };
    if (has(7000)) return { name: "AirPlay device", kind: "speaker" };
    if (has(80) || has(443) || has(8080)) return { hint: "Has a web page" };
    return {};
  }

  async function routerLogin() {
    const r = router();
    if (!r.pass) return null;
    const addr = (r.addr || (await Net.localPrefix().catch(() => ({}))).gateway || "192.168.50.1").replace(/\/$/, "");
    const base = /^https?:\/\//.test(addr) ? addr : `http://${addr}`;
    const res = await fetch(`${base}/login.cgi`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", "User-Agent": UA },
      body: `login_authorization=${encodeURIComponent(btoa(`${r.user || "admin"}:${r.pass}`))}`,
    });
    const j = await res.json().catch(() => ({}));
    if (!j.asus_token) {
      const why = { 3: "Wrong router username or password", 7: "The router paused sign-ins after too many tries. Wait a few minutes.", 10: "The router wants a captcha. Sign in once in its web page, then try again." }[j.error_status];
      throw new Error(why || "The router didn't accept the sign-in");
    }
    routerTok = { base, token: j.asus_token };
    return routerTok;
  }
  async function routerClients() {
    if (!routerTok) await routerLogin();
    if (!routerTok) return null;
    const get = async () => {
      const res = await fetch(`${routerTok.base}/appGet.cgi?hook=${encodeURIComponent("get_clientlist()")}`, {
        headers: { "User-Agent": UA, Cookie: `asus_token=${routerTok.token}`, Referer: `${routerTok.base}/index.asp` },
      });
      return res.json();
    };
    let j = await get().catch(() => null);
    if (!j?.get_clientlist) { await routerLogin(); j = await get(); }
    const list = j.get_clientlist || {};
    return (list.maclist || Object.keys(list).filter((k) => /^[0-9A-F]{2}(:[0-9A-F]{2}){5}$/i.test(k))).map((mac) => {
      const c = list[mac] || {};
      return { mac, ip: c.ip, name: c.nickName || c.name, maker: c.vendor, online: c.isOnline === "1", band: { 0: "Wired", 1: "2.4 GHz", 2: "5 GHz", 3: "5 GHz-2", 4: "6 GHz" }[c.isWL] || "", rssi: c.rssi && c.rssi !== "0" ? +c.rssi : null };
    }).filter((d) => d.ip || d.online);
  }

  async function load(manual) {
    if (busy) return;
    busy = true;
    $("wfRefresh").classList.add("spin");
    $("wfSub").textContent = "Looking…";
    try {
      const byKey = new Map();
      const add = (d) => {
        const key = (d.mac || "").toLowerCase() || d.ip;
        const hit = byKey.get(key) || [...byKey.values()].find((x) => d.ip && x.ip === d.ip);
        if (hit) { for (const [k, v] of Object.entries(d)) if (v !== undefined && v !== "" && (hit[k] === undefined || hit[k] === "" || k === "online")) hit[k] = v; }
        else byKey.set(key, { ...d });
      };
      let fromRouter = null;
      if (router().pass) {
        try { fromRouter = await routerClients(); } catch (e) { toast(e.message, true); }
      }
      if (fromRouter) fromRouter.forEach(add);
      else {
        const local = await Net.localPrefix();
        const prefix = store.get("wifi.range") || local.prefix;
        const gateway = local.prefix === prefix ? local.gateway : `${prefix}.1`;
        const [sw, ss, md] = await Promise.all([Net.sweep({ prefix }).catch(() => ({ alive: [] })), Net.ssdp().catch(() => ({ devices: [] })), Net.mdns().catch(() => ({ devices: [] }))]);
        const inRange = (ip) => ip && ip.startsWith(prefix + ".");
        sw.alive.forEach(({ ip, ports }) => add({ ip, online: true, ...portHint(ports) }));
        ss.devices.filter((d) => inRange(d.ip)).forEach((d) => add({ ip: d.ip, online: true, hint: (d.server || "").replace(/UPnP\/[\d.]+|DLNADOC\/[\d.]+|Portable SDK for UPnP devices/gi, "").replace(/[,\s]+$/, "").trim() }));
        md.devices.filter((d) => inRange(d.ip)).forEach((d) => {
          const model = d.names.find((n) => /^(md|model)=/.test(n))?.split("=")[1];
          const fn = d.names.find((n) => /^fn=/.test(n))?.slice(3);
          const name = fn || d.names.find((n) => !n.includes("=") && !/^[0-9a-f]{16,}|^SpotifyConnect/i.test(n)) || (d.names.some((n) => /^SpotifyConnect/i.test(n)) ? "Speaker (Spotify)" : "");
          add({ ip: d.ip, online: true, name, hint: model });
        });
        add({ ip: gateway, online: true, name: "Router", kind: "router" });
      }
      // What the other sides already know (bulbs, TV, screen, cameras) fills in names.
      for (const s of House.sides) for (const k of s.known?.() || []) {
        const hit = [...byKey.values()].find((x) => x.ip === k.ip || (k.mac && x.mac?.toLowerCase() === k.mac.toLowerCase()));
        if (hit) { hit.name ||= k.name; hit.kind ||= k.type; hit.hint ||= k.hint; hit.side = s.id; if (!fromRouter && k.online) hit.online = true; }
        else if (!fromRouter) add({ ...k, kind: k.type, online: !!k.online, side: s.id });
      }
      const own = names();
      devices = [...byKey.values()].map((d) => {
        const maker = d.maker || makerOf(d.mac);
        const text = `${d.name || ""} ${maker} ${d.hint || ""}`;
        const [, kind, kindName] = d.kind ? [null, d.kind, KINDS.find((k) => k[1] === d.kind)?.[2] || "Device"] : kindOf(text);
        return { ...d, maker, kind, kindName, label: own[(d.mac || "").toLowerCase()] || own[d.ip] || d.name || (maker && !maker.startsWith("Private") ? `${maker} device` : kindName === "Device" ? "Unknown device" : kindName) };
      }).sort((a, b) => (b.online - a.online) || ipNum(a.ip) - ipNum(b.ip));
      store.setJson("wifi.last", devices);
      scannedAt = Date.now();
      if (manual) toast(`${devices.filter((d) => d.online).length} devices on your Wi-Fi`);
    } catch (e) { toast(e.message || "Couldn't scan the network", true); }
    busy = false;
    $("wfRefresh").classList.remove("spin");
    paint();
  }
  const ipNum = (ip) => (ip || "999.999.999.999").split(".").reduce((n, p) => n * 256 + (+p || 0), 0);

  const GROUPS = [["Smart home", ["bulb", "tv", "screen", "cam", "thermo", "speaker", "car", "garage"]], ["Phones and computers", ["phone", "laptop"]], ["Network", ["router"]], ["Other", ["chip"]]];
  function paint() {
    const f = filter.toLowerCase();
    const list = devices.filter((d) => !f || `${d.label} ${d.ip} ${d.maker} ${d.mac} ${d.hint}`.toLowerCase().includes(f));
    const on = devices.filter((d) => d.online).length;
    $("wfSub").innerHTML = `<span class="dot ${on ? "on" : ""}"></span>` + (busy ? "Looking…" : devices.length ? `${on} online · ${router().pass ? "from your router" : "found by the app"}` : "Tap refresh to look");
    $("wfList").innerHTML = GROUPS.map(([title, kinds]) => {
      const ds = list.filter((d) => kinds.includes(d.kind));
      if (!ds.length) return "";
      return `<div class="label">${title}<span class="cnt">${ds.length}</span></div><div class="devs">${ds.map((d) => `
        <button class="dev glass${d.online ? "" : " off"}" data-dev="${esc(d.mac || d.ip)}">
          <span class="ic">${svg(d.kind)}</span>
          <span class="t"><b>${esc(d.label)}</b><span>${esc([d.ip, d.maker && d.maker !== d.label ? d.maker : d.hint].filter(Boolean).join(" · "))}</span></span>
          <span class="r">${d.online ? esc(d.band || "") + (d.rssi ? `<br>${d.rssi} dBm` : "") : "offline"}</span>
        </button>`).join("")}</div>`;
    }).join("") || (busy ? "" : `<div class="card glass empty"><div class="big">${svg("wifi")}</div><b>No devices yet</b><p>Tap refresh. Signing in to your router (Settings) gives the full list with names.</p></div>`);
    const r = router();
    $("wfAddr").value = r.addr;
    $("wfUser").value = r.user || "admin";
    $("wfSigned").hidden = !r.pass;
    paintHome();
    paintWatch();
  }

  /* ---- Who's home ---- */
  let watch = { settings: {}, presence: {}, notifications: true };
  const people = () => watch.settings.people || [];
  const personOf = (d) => people().find((p) => p.key === ((d.mac || "").toLowerCase() || d.ip));
  // This phone: what Android reported (instant). Others: home if a scan from the last few minutes
  // sees their phone, otherwise what the background check last decided. An old list never counts.
  let scannedAt = 0;
  function isHome(p) {
    const st = watch.presence[p.key];
    if (p.key === "this-phone") return { home: !!st?.home, since: st?.since, instant: true };
    const fresh = Date.now() - scannedAt < 5 * 60e3;
    const d = fresh && devices.find((x) => ((x.mac || "").toLowerCase() || x.ip) === p.key || x.ip === p.key);
    if (d?.online) return { home: true, since: st?.since };
    return { home: !!st?.home, since: st?.since };
  }
  const ago = (ts) => { if (!ts) return ""; const m = Math.round((Date.now() - ts) / 60000); return m < 1 ? "just now" : m < 60 ? `${m} min` : m < 1440 ? `${Math.round(m / 60)} h` : `${Math.round(m / 1440)} d`; };
  function paintHome() {
    const ps = people();
    $("wfHome").hidden = !ps.length;
    $("wfHome").innerHTML = `<div class="head-card" style="margin-bottom:6px"><div class="grow"><b>Who's home</b></div></div>` + ps.map((p) => {
      const h = isHome(p);
      return `<div class="set-row"><span class="dot ${h.home ? "on" : ""}"></span><div class="set-text"><b>${esc(p.name)}</b><span>${h.home ? "Home" : "Away"}${h.since ? ` · ${ago(h.since)}` : ""}</span></div></div>`;
    }).join("");
  }
  async function saveWatch(msg) {
    try { watch = await Net.setWatch({ settings: watch.settings }); if (msg) toast(msg); }
    catch { toast("Couldn't save that", true); }
    paint();
  }
  async function scenesList() {
    try { return (await Lights.getScenes()).scenes || []; } catch { return []; }
  }
  async function paintWatch() {
    if (!$("wfAlerts")) return;
    const s = watch.settings;
    $("wfAlerts").classList.toggle("on", !!s.alerts);
    $("wfNotifNote").hidden = !s.alerts || watch.notifications;
    $("wfThisPhone").hidden = people().some((p) => p.key === "this-phone");
    $("wfPeople").innerHTML = people().length ? people().map((p) => `<div class="set-row"><div class="set-text"><b>${esc(p.name)}</b><span>${p.key === "this-phone" ? "This phone · updates right away" : esc(p.key) + " · checked every 15 min"}</span></div><button class="ghost center auto danger" data-unperson="${esc(p.key)}">Remove</button></div>`).join("")
      : `<p class="note" style="margin:0">No one yet. On the Devices tab, tap someone's phone and choose “This is a person's phone”.</p>`;
    const sc = await scenesList();
    const opts = (val) => `<option value="">Nothing</option>` + sc.map((x) => `<option value="custom:${esc(x.id)}" ${val === `custom:${x.id}` ? "selected" : ""}>${esc(x.name)}</option>`).join("");
    $("wfArrive").innerHTML = opts(s.arrive || "");
    $("wfNoCloud").hidden = !s.leave || !!store.get("lifx.token");
    $("wfLeave").innerHTML = opts(s.leave || "");
  }

  /* ---- Speed test ---- */
  async function speedTest() {
    $("wfSpeedGo").disabled = true;
    $("wfSpeedGo").innerHTML = `${svg("refresh", 'style="width:18px;height:18px;vertical-align:-4px;animation:spin 1s linear infinite"')} Testing… about 20 seconds`;
    try {
      const r = await Net.speedTest();
      const hist = [{ ...r, at: Date.now() }, ...store.json("wifi.speed", [])].slice(0, 10);
      store.setJson("wifi.speed", hist);
      paintSpeed();
    } catch (e) { toast(e.message || "The speed test didn't finish", true); }
    $("wfSpeedGo").disabled = false;
    $("wfSpeedGo").textContent = "Run speed test";
  }
  function paintSpeed() {
    const hist = store.json("wifi.speed", []);
    const last = hist[0];
    $("wfSpeed").innerHTML = `
      <div class="stat glass"><b>${last ? last.down : "—"}</b><span>Down Mbps</span></div>
      <div class="stat glass"><b>${last ? last.up : "—"}</b><span>Up Mbps</span></div>
      <div class="stat glass"><b>${last ? last.ping : "—"}</b><span>Ping ms</span></div>`;
    $("wfSpeedHist").innerHTML = hist.length > 1 ? hist.slice(1).map((h) => `<div class="set-row"><div class="set-text"><b>${h.down} ↓ · ${h.up} ↑ Mbps</b><span>${new Date(h.at).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })} · ping ${h.ping} ms</span></div></div>`).join("") : "";
    $("wfSpeedWhen").textContent = last ? `Last test ${ago(last.at)} ago` : "Tests your internet through Cloudflare's speed test servers.";
  }

  /* ---- Guest Wi-Fi QR ---- */
  const guest = () => store.json("wifi.guest", { ssid: "", pass: "", sec: "WPA" });
  const qrEsc = (s) => s.replace(/([\\;,":])/g, "\\$1");
  async function paintGuest() {
    const g = guest();
    $("wfGuestSsid").value = g.ssid;
    $("wfGuestPass").value = g.pass;
    $("wfGuestSec").value = g.sec;
    if (!g.ssid) { $("wfQr").innerHTML = `<p class="note" style="margin:0">Type your Wi-Fi name and password below to make the code.</p>`; return; }
    const text = `WIFI:T:${g.sec === "none" ? "nopass" : g.sec};S:${qrEsc(g.ssid)};${g.sec === "none" ? "" : `P:${qrEsc(g.pass)};`};`;
    try {
      const { dataUrl } = await Net.qr({ text });
      $("wfQr").innerHTML = `<img class="qr" alt="Wi-Fi QR code for ${esc(g.ssid)}" src="${dataUrl}"><b>${esc(g.ssid)}</b><span class="muted small">Point a phone camera at the code to join</span>`;
    } catch { $("wfQr").innerHTML = `<p class="note">Couldn't make the code.</p>`; }
  }

  function openDev(key) {
    const d = devices.find((x) => (x.mac || x.ip) === key);
    if (!d) return;
    const side = d.side && House.byId(d.side) && !House.hidden().includes(d.side) ? House.byId(d.side) : null;
    const body = House.sheet(`
      <div class="sheet-head"><div><h3>${esc(d.label)}</h3><div class="sub">${esc(d.kindName)}${d.online ? " · online" : " · offline"}</div></div></div>
      <div class="kv">
        <span>Address</span><b>${esc(d.ip || "—")}</b>
        <span>MAC</span><b>${esc(d.mac || "Sign in to your router to see it")}</b>
        <span>Maker</span><b>${esc(d.maker || "—")}</b>
        ${d.hint ? `<span>Says</span><b>${esc(d.hint)}</b>` : ""}
        ${d.band ? `<span>Connection</span><b>${esc(d.band)}${d.rssi ? ` · ${d.rssi} dBm` : ""}</b>` : ""}
      </div>
      <label class="fld">Your name for it<input class="field" id="devName" value="${esc(names()[(d.mac || "").toLowerCase()] || names()[d.ip] || "")}" placeholder="${esc(d.label)}"></label>
      <div class="list">
        <button class="primary full" id="devSave">Save name</button>
        ${side ? `<button class="ghost center" id="devOpen">Open ${esc(side.name)}</button>` : ""}
      </div>
      <div class="label" style="margin-top:18px">Who's home</div>
      ${personOf(d) ? `<p class="note" style="margin-top:0">This is ${esc(personOf(d).name)}'s phone.</p><div class="list"><button class="ghost center danger" id="devUnperson">Not a person's phone</button></div>`
        : `<label class="fld" style="margin-top:0">This is a person's phone: whose?<input class="field" id="devPerson" placeholder="Anis"></label>
          <div class="list"><button class="ghost center" id="devPersonSave">Use for Who's home</button></div>
          ${d.mac ? "" : `<p class="note">Without the router sign-in the phone is known by its address, which can change. Signing in to the router is more reliable.</p>`}`}`);
    const pkey = (d.mac || "").toLowerCase() || d.ip;
    body.querySelector("#devPersonSave")?.addEventListener("click", () => {
      const name = $("devPerson").value.trim();
      if (!name) { toast("Type whose phone it is", true); return; }
      watch.settings.people = [...people().filter((p) => p.key !== pkey), { key: pkey, name }];
      House.closeSheet();
      saveWatch(`${name} added to Who's home`);
    });
    body.querySelector("#devUnperson")?.addEventListener("click", () => {
      watch.settings.people = people().filter((p) => p.key !== pkey);
      House.closeSheet();
      saveWatch("Removed from Who's home");
    });
    body.querySelector("#devSave").onclick = () => {
      const n = names(), k = (d.mac || "").toLowerCase() || d.ip, v = $("devName").value.trim();
      if (v) n[k] = v; else delete n[k];
      store.setJson("wifi.names", n);
      d.label = v || d.name || d.label;
      House.closeSheet();
      paint();
      toast("Saved");
    };
    if (side) body.querySelector("#devOpen").onclick = () => House.show(side.id);
  }

  House.side({
    id: "wifi", name: "Wi-Fi", icon: "wifi", blurb: "Every device on your network",
    tabs: [
      { id: "devices", label: "Devices", icon: "wifi", html: `
        <div class="card glass"><div class="head-card"><div class="grow"><b>Your Wi-Fi</b><div class="status-line" id="wfSub"></div></div><button class="round-btn glass" id="wfRefresh" aria-label="Look again">${svg("refresh")}</button></div></div>
        <div class="card glass" id="wfHome" hidden></div>
        <input class="field search" id="wfSearch" placeholder="Search by name, address or maker" aria-label="Search devices">
        <div id="wfList"></div>` },
      { id: "tools", label: "Tools", icon: '<path d="M14.7 6.3a4 4 0 0 0-5.4 5.4L3 18l3 3 6.3-6.3a4 4 0 0 0 5.4-5.4l-2.5 2.5-2.4-.6-.6-2.4z"/>', html: `
        <div class="label">Internet speed</div>
        <div class="card glass">
          <div class="stats" id="wfSpeed"></div>
          <p class="note" id="wfSpeedWhen"></p>
          <div class="list"><button class="primary full" id="wfSpeedGo">Run speed test</button></div>
          <div id="wfSpeedHist" style="margin-top:8px"></div>
        </div>
        <div class="label">Guest Wi-Fi</div>
        <div class="card glass">
          <div class="qr-box" id="wfQr"></div>
          <label class="fld">Wi-Fi name<input class="field" id="wfGuestSsid" autocomplete="off" placeholder="Your Wi-Fi name"></label>
          <label class="fld">Wi-Fi password<input class="field" id="wfGuestPass" type="password" autocomplete="off"></label>
          <label class="fld">Security<select class="field" id="wfGuestSec"><option value="WPA">WPA / WPA2 / WPA3</option><option value="WEP">WEP</option><option value="none">No password</option></select></label>
          <div class="list"><button class="ghost center" id="wfGuestSave">Make the code</button></div>
          <p class="note">Kept on this phone only. Use your guest network's name and password if you have one.</p>
        </div>` },
      { id: "settings", label: "Settings", icon: "gear" },
    ],
    settingsHtml: `
      <div class="label">Alerts</div>
      <div class="card glass">
        <div class="set-row"><div class="set-text"><b>New device alert</b><span>A notification when a device joins your Wi-Fi for the first time. Checked about every 15 min; it learns your devices for the first hour. Most reliable with the router signed in.</span></div><button class="tgl" id="wfAlerts" aria-label="New device alert"><i></i></button></div>
        <p class="note" id="wfNotifNote" hidden>Notifications are off for House. Turn them on in your phone's Settings → Apps → House → Notifications.</p>
      </div>
      <div class="label">Who's home</div>
      <div class="card glass">
        <div id="wfPeople"></div>
        <div id="wfThisPhone">
          <label class="fld">Add this phone (whose is it?)<input class="field" id="wfMeName" placeholder="Anis"></label>
          <div class="list"><button class="primary full" id="wfMeAdd">Add this phone</button></div>
          <p class="note">This phone knows the moment it leaves or joins your Wi-Fi, so it updates right away (away after 2 minutes off the Wi-Fi). Do this while connected to your home Wi-Fi.</p>
        </div>
        <label class="fld">When someone gets home, run<select class="field" id="wfArrive"></select></label>
        <label class="fld">When everyone has left, run<select class="field" id="wfLeave"></select></label>
        <p class="note err" id="wfNoCloud" hidden>Once your phone is off the home Wi-Fi it can't reach the bulbs. Add a LIFX cloud token in <b>Lights → Settings</b>, or the lights won't change when you leave.</p>
        <p class="note">Checked about every 15 min, so it can take a little while. Someone counts as gone after their phone is missing twice in a row. Phones with “private Wi-Fi address” turned off for this network are recognised more reliably. Lights can only be reached from the home Wi-Fi: for a leave scene, add a LIFX cloud token in Lights → Settings.</p>
      </div>
      <div class="label">Router (ASUS)</div>
      <div class="card glass">
        <p class="note" style="margin-top:0">Optional. With your router's sign-in, the list shows every device with its real name, maker, Wi-Fi band and signal. Without it, the app finds devices itself.</p>
        <label class="fld">Router address<input class="field" id="wfAddr" inputmode="url" placeholder="192.168.50.1 (found by itself)"></label>
        <label class="fld">Username<input class="field" id="wfUser" autocomplete="username" value="admin"></label>
        <label class="fld">Password<input class="field" id="wfPass" type="password" autocomplete="current-password"></label>
        <div class="list"><button class="primary full" id="wfSave">Sign in to the router</button></div>
        <div id="wfSigned" hidden><p class="note">${svg("check", 'style="width:16px;height:16px;vertical-align:-3px;color:var(--good)"')} Router sign-in saved on this phone.</p><div class="list"><button class="ghost center danger" id="wfOut">Forget router sign-in</button></div></div>
        <p class="note">Several wrong passwords make the router pause sign-ins for a few minutes.</p>
      </div>
      <div class="label">Network</div>
      <div class="card glass">
        <label class="fld" style="margin-top:0">Network to scan<input class="field" id="wfRange" inputmode="decimal" placeholder="Found by itself (like 192.168.50)"></label>
        <p class="note">Leave empty to scan the network your phone is on.</p>
      </div>
      <div class="label">Names</div>
      <div class="card glass"><button class="ghost center" id="wfNames">Clear the names I gave devices</button></div>`,
    guide: [
      ["wifi", "Your devices", "Everything connected to your Wi-Fi, grouped into smart home, phones and computers. Faded ones were seen before but aren't on now."],
      ["router", "Full list", "Sign in to your ASUS router in Settings for real names, makers, Wi-Fi band and signal strength. Your password stays on this phone."],
      ["chip", "Name a device", "Tap any device to give it your own name. Devices the app controls open their own page from there."],
      ["bell", "New device alert", "Settings → New device alert sends a notification when something joins your Wi-Fi for the first time."],
      ["phone", "Who's home", "Tap someone's phone → “This is a person's phone”. The Devices tab then shows who's home, and Settings can run a scene when someone arrives or everyone leaves."],
      ["refresh", "Speed test", "Tools → Run speed test measures your internet's download, upload and ping, and keeps the last results."],
      ["key", "Guest Wi-Fi", "Tools → type your Wi-Fi name and password once; guests point their camera at the code to join."],
    ],
    mount() {
      $("wfRefresh").onclick = () => { buzz(6); load(true); };
      $("wfSearch").oninput = (e) => { filter = e.target.value; paint(); };
      $("wfList").addEventListener("click", (e) => { const b = e.target.closest("[data-dev]"); if (b) { buzz(6); openDev(b.dataset.dev); } });
      $("wfSave").onclick = async () => {
        const r = { addr: $("wfAddr").value.trim(), user: $("wfUser").value.trim() || "admin", pass: $("wfPass").value };
        if (!r.pass) { toast("Type the router password", true); return; }
        store.setJson("wifi.router", r);
        routerTok = null;
        try { await routerLogin(); $("wfPass").value = ""; toast("Signed in to the router"); House.showTab("devices"); load(true); }
        catch (e) { store.setJson("wifi.router", { ...r, pass: "" }); toast(e.message, true); paint(); }
      };
      $("wfOut").onclick = () => { store.setJson("wifi.router", { ...router(), pass: "" }); routerTok = null; paint(); toast("Router sign-in forgotten"); };
      $("wfRange").value = store.get("wifi.range", "");
      $("wfRange").onchange = (e) => {
        const v = e.target.value.trim().replace(/\.\*?$/, "").split(".").slice(0, 3).join(".");
        if (v && !/^\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(v)) { toast("Type the first three parts, like 192.168.50", true); return; }
        store.set("wifi.range", v || null);
        e.target.value = v;
        toast(v ? `Will scan ${v}.1 – 254` : "Will scan your phone's network");
      };
      $("wfNames").onclick =() => { if (!confirm("Clear all your device names?")) return; store.set("wifi.names", null); load(); };
      $("wfMeAdd").onclick = async () => {
        const name = $("wfMeName").value.trim();
        if (!name) { toast("Type whose phone this is", true); return; }
        buzz();
        try { watch = await Net.addThisPhone({ name }); $("wfMeName").value = ""; toast(`${name} added: updates right away`); paint(); }
        catch (e) { toast(e.message || "Couldn't add this phone", true); }
      };
      $("wfAlerts").onclick = () => { buzz(); watch.settings.alerts = !watch.settings.alerts; saveWatch(watch.settings.alerts ? "New device alert on" : "New device alert off"); };
      $("wfPeople").addEventListener("click", (e) => {
        const b = e.target.closest("[data-unperson]");
        if (b) { watch.settings.people = people().filter((p) => p.key !== b.dataset.unperson); saveWatch("Removed from Who's home"); }
      });
      $("wfArrive").onchange = (e) => { watch.settings.arrive = e.target.value; saveWatch("Saved"); };
      $("wfLeave").onchange = (e) => { watch.settings.leave = e.target.value; saveWatch("Saved"); };
      $("wfSpeedGo").onclick = () => { buzz(); speedTest(); };
      $("wfGuestSave").onclick = () => {
        const g = { ssid: $("wfGuestSsid").value.trim(), pass: $("wfGuestPass").value, sec: $("wfGuestSec").value };
        if (!g.ssid) { toast("Type the Wi-Fi name", true); return; }
        if (g.sec !== "none" && !g.pass) { toast("Type the Wi-Fi password", true); return; }
        store.setJson("wifi.guest", g);
        paintGuest();
      };
      devices = store.json("wifi.last", []);
      Net.getWatch().then((w) => { watch = w; paint(); }).catch(() => {});
      paint();
      paintSpeed();
      paintGuest();
    },
    onShow(tab) {
      if (tab === "devices" && !busy && !devices.length) load(); else paint();
      if (tab === "devices" && people().length) Net.getWatch().then((w) => { watch = w; paintHome(); }).catch(() => {});
    },
  });
})();
