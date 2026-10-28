// Wi-Fi controls through the ASUS router (native RouterControl). On the Devices tab: what's
// paused right now, then foldable Pause everyone, Focus time, Profiles, Internet bedtime and
// Device priority, and the Router and Data use tools. In Settings: Guest Wi-Fi, Wi-Fi password
// and the devices Pause everyone keeps on.
// Used by the Wi-Fi side (wifi.js). Profiles group a person's devices: kept on this phone.

(() => {
  let filters = {};   // { mac: { paused, bedtime: { on, days, start, end } | null } }
  let status = { timers: [], pausedAll: null, prio: {} };
  let guest = null, health = null, reboot = null, usage = null, usageDura = 24;
  let live = null, liveOn = false, liveTimer = 0, livePrev = null;
  let focusMin = 30, guestHours = 2;
  const signed = () => !!store.json("wifi.router", {}).pass;
  const devs = () => (House.byId("wifi")?.list?.() || []).filter((d) => d.mac);
  const profiles = () => store.json("wifi.profiles", []);
  const saveProfiles = (p) => store.setJson("wifi.profiles", p);
  const keepList = () => store.json("wifi.keep", []);
  const lc = (m) => (m || "").toLowerCase();
  const nameOf = (mac) => devs().find((d) => lc(d.mac) === lc(mac))?.label || mac.toUpperCase();
  const namesFor = (macs) => Object.fromEntries(macs.map((m) => [m.toUpperCase(), nameOf(m)]));
  const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const hhmm = (s) => { const d = new Date(2000, 0, 1, +s.slice(0, 2), +s.slice(2)); return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }); };
  const daysText = (mask) => mask === 127 ? "Every day" : mask === 62 ? "Mon–Fri" : mask === 65 ? "Weekends" : mask === 31 ? "Sun–Thu" : DAYS.filter((_, i) => mask & (1 << i)).join(", ");
  const left = (at) => { const m = Math.max(1, Math.round((at - Date.now()) / 60000)); return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60 ? `${m % 60} min` : ""}`.trim(); };
  const bytes = (b) => b >= 1e9 ? `${(b / 1e9).toFixed(1)} GB` : b >= 1e6 ? `${Math.round(b / 1e6)} MB` : `${Math.round(b / 1e3)} KB`;

  // Away from home: the last known state, with when it was seen. Kept on this phone.
  const away = () => House.wifiAway?.() === true;
  let showingCache = { control: false, tools: false };
  const awayNote = (at) => `<div class="card glass away-note"><b>You're away from home</b><p class="note" style="margin:4px 0 0">Showing how things were ${at ? `at ${House.wifiAsOf(at)}` : "last time"}. Changes need the home Wi-Fi (or a VPN to your router).</p></div>`;

  async function R(op, args = {}, quiet) {
    try { return await Net.router({ op, ...args }); }
    catch (e) { if (!quiet) toast(e.message || "The router didn't answer", true); throw e; }
  }

  // "Who" pickers: profiles first, then devices with a MAC.
  function whoOptions(sel = "") {
    const ps = profiles().map((p) => `<option value="p:${esc(p.id)}" ${sel === `p:${p.id}` ? "selected" : ""}>${esc(p.name)} (${p.macs.length} device${p.macs.length === 1 ? "" : "s"})</option>`).join("");
    const ds = devs().slice().sort((a, b) => a.label.localeCompare(b.label)).map((d) => `<option value="d:${esc(lc(d.mac))}" ${sel === `d:${lc(d.mac)}` ? "selected" : ""}>${esc(d.label)}${d.online ? "" : " (offline)"}</option>`).join("");
    return (ps ? `<optgroup label="Profiles">${ps}</optgroup>` : "") + `<optgroup label="Devices">${ds}</optgroup>`;
  }
  function resolve(who) {
    if (who.startsWith("p:")) { const p = profiles().find((x) => x.id === who.slice(2)); return p ? { macs: p.macs, label: p.name } : { macs: [], label: "" }; }
    const mac = who.slice(2);
    return { macs: mac ? [mac] : [], label: nameOf(mac) };
  }

  /* ---- Controls (Devices tab) and their settings ---- */
  const F = (key, title, icon, body, opts) => House.fold("wifi." + key, title, icon, body, opts);
  const controlHtml = `
    <div class="card glass" id="wcNeed" hidden><p class="note" style="margin:0">Sign in to your ASUS router (Settings → Router) to pause devices, set bedtimes and more.</p></div>
    <div id="wcBody">
      <div id="wcAway"></div>
      <div class="card glass" id="wcNow"><p class="note" style="margin:0">Checking the router…</p></div>
      ${F("pauseAll", "Pause everyone", "power", `
        <label class="fld" style="margin-top:0">For<select class="field" id="wcAllMin"><option value="0">Until I resume</option><option value="30">30 min</option><option value="60">1 h</option><option value="120">2 h</option></select></label>
        <div class="list"><button class="ghost center danger" id="wcAllGo">Pause everyone else</button></div>`, { subId: "wcAllSub" })}
      ${F("focus", "Focus time", "clock", `
        <label class="fld" style="margin-top:0">Who<select class="field" id="wcFocusWho"></select></label>
        <div class="mini-seg" id="wcFocusMin" style="margin-top:10px"><button data-fm="30">30 min</button><button data-fm="60">1 h</button><button data-fm="120">2 h</button></div>
        <div class="list"><button class="primary full" id="wcFocusGo">Pause their internet</button></div>
        <p class="note">Comes back by itself when the time is up.</p>`, { sub: "Pause someone for a while" })}
      ${F("profiles", "Profiles", "phone", `<div id="wcProfiles"></div><div class="list"><button class="ghost center" id="wcNewProfile">New profile</button></div>
        <p class="note">A person's devices together: pause, Focus time, bedtime and priority then work on all of them.</p>`, { subId: "wcProfSub" })}
      ${F("bedtime", "Internet bedtime", "moon", `<div id="wcBeds"></div><div class="list"><button class="ghost center" id="wcBedAdd">Add a bedtime</button></div>
        <p class="note">Kept by the router, so it works with your phone away.</p>`, { subId: "wcBedSub" })}
      ${F("priority", "Device priority", "star", `
        <label class="fld" style="margin-top:0">Who<select class="field" id="wcPrioWho"></select></label>
        <label class="fld">For<select class="field" id="wcPrioMin"><option value="60">1 h</option><option value="120" selected>2 h</option><option value="240">4 h</option><option value="0">Until I stop it</option></select></label>
        <div class="list"><button class="primary full" id="wcPrioGo">Give priority</button></div>
        <p class="note">Gets bandwidth first, for a movie or a work call. Needs QoS on in the router.</p>`, { sub: "Bandwidth first for a while" })}
    </div>`;
  // For Settings.
  const guestHtml = `<div id="wcGuest" data-wc><p class="note" style="margin:0">Sign in to your router to turn the guest network on and off.</p></div>`;
  const passwordHtml = `<div data-wc>
    <label class="fld" style="margin-top:0">New password<input class="field" id="wcPass" type="password" autocomplete="new-password" minlength="8"></label>
    <label class="fld">Type it again<input class="field" id="wcPass2" type="password" autocomplete="new-password"></label>
    <div class="list"><button class="ghost center danger" id="wcPassGo">Change Wi-Fi password</button></div>
    <p class="note">Every device has to join again with the new password, including this phone. Sent only to your router.</p></div>`;
  const keepHtml = `<div data-wc><p class="note" style="margin-top:0">Pause everyone leaves these online:</p><div class="chips" id="wcKeep"></div></div>`;

  async function loadControl() {
    if (!signed()) { paintControl(); return; }
    const cache = store.json("wifi.ctl", null);
    if (away() && cache) { ({ filters, status, guest } = cache); showingCache.control = cache.at; paintControl(); }
    const [f, s, g] = await Promise.allSettled([R("filters", {}, true), R("status", {}, true), R("guest", {}, true)]);
    if (f.status === "rejected") {
      if (away()) { if (!cache) { showingCache.control = 0; paintControl(); } return; } // keep the last known
      toast(f.reason?.message || "Couldn't reach the router", true);
    } else {
      filters = f.value;
      showingCache.control = false;
    }
    if (s.status === "fulfilled") status = s.value;
    guest = g.status === "fulfilled" ? g.value : { error: g.reason?.message };
    if (f.status === "fulfilled") store.setJson("wifi.ctl", { filters, status, guest: guest.error ? null : guest, at: Date.now() });
    paintControl();
  }

  function paintControl() {
    if (!$("wcBody")) return;
    $("wcNeed").hidden = signed();
    $("wcBody").hidden = !signed();
    if (!signed()) return;
    $("wcBody").classList.toggle("away", showingCache.control !== false);
    $("wcAway").innerHTML = showingCache.control !== false ? awayNote(showingCache.control) : "";
    paintNow();
    paintProfiles();
    $("wcFocusWho").innerHTML = whoOptions($("wcFocusWho").value);
    $("wcPrioWho").innerHTML = whoOptions($("wcPrioWho").value);
    $("wcFocusMin").querySelectorAll("[data-fm]").forEach((b) => b.classList.toggle("on", +b.dataset.fm === focusMin));
    const keep = new Set(keepList());
    $("wcKeep").innerHTML = devs().filter((d) => d.online || keep.has(lc(d.mac))).sort((a, b) => a.label.localeCompare(b.label))
      .map((d) => `<button data-keep="${esc(lc(d.mac))}" class="${keep.has(lc(d.mac)) ? "on" : ""}">${esc(d.label)}</button>`).join("") || `<p class="note" style="margin:0">Refresh the Devices tab first.</p>`;
    paintBeds();
    paintGuest();
    const k = keepList();
    $("wcAllSub").textContent = k.length ? `Keeps on: ${k.map(nameOf).join(", ")}` : "Keeps nothing on (choose in Settings)";
    const n = profiles().length;
    $("wcProfSub").textContent = n ? `${n} profile${n === 1 ? "" : "s"}` : "A person's devices together";
  }

  function paintNow() {
    const rows = [];
    const timed = new Set();
    for (const t of status.timers || []) {
      (t.macs || []).forEach((m) => timed.add(lc(m)));
      const who = t.id === "pauseAll" ? "Everyone else" : t.label || t.macs.map(nameOf).join(", ");
      const what = t.kind === "prio" ? "Priority" : t.id === "pauseAll" ? "Paused" : "Focus time";
      rows.push(`<div class="set-row"><span class="dot ${t.kind === "prio" ? "on" : "bad"}"></span><div class="set-text"><b>${what}: ${esc(who)}</b><span>${t.retrying ? "Will finish when your phone is back home" : `${t.kind === "prio" ? "Ends" : "Back online"} in ${left(t.at)}`}</span></div><button class="ghost center auto" data-end="${esc(t.id)}">${t.kind === "prio" ? "Stop" : "End now"}</button></div>`);
    }
    for (const [mac, until] of Object.entries(status.prio || {})) if (!until) rows.push(`<div class="set-row"><span class="dot on"></span><div class="set-text"><b>Priority: ${esc(nameOf(mac))}</b><span>Until you stop it</span></div><button class="ghost center auto" data-unprio="${esc(mac)}">Stop</button></div>`);
    const all = status.pausedAll;
    if (all && !all.at) { all.macs.forEach((m) => timed.add(lc(m))); rows.push(`<div class="set-row"><span class="dot bad"></span><div class="set-text"><b>Everyone else is paused</b><span>${all.macs.length} device${all.macs.length === 1 ? "" : "s"}</span></div><button class="ghost center auto" data-resumeall>Resume all</button></div>`); }
    for (const [mac, f] of Object.entries(filters)) if (f.paused && !timed.has(mac)) rows.push(`<div class="set-row"><span class="dot bad"></span><div class="set-text"><b>${esc(nameOf(mac))}</b><span>Paused · no internet</span></div><button class="ghost center auto" data-resume="${esc(mac)}">Resume</button></div>`);
    $("wcNow").innerHTML = rows.join("") || `<div class="set-row"><span class="dot on"></span><div class="set-text"><b>Everyone's online</b><span>Nothing paused right now</span></div></div>`;
  }

  function profileState(p) {
    const fs = p.macs.map((m) => filters[lc(m)] || {});
    if (p.macs.length && fs.every((f) => f.paused)) return "paused";
    if (fs.some((f) => f.paused)) return "partly paused";
    if (fs.some((f) => f.bedtime)) return "has a bedtime";
    return "";
  }
  function paintProfiles() {
    $("wcProfiles").innerHTML = profiles().map((p) => {
      const st = profileState(p);
      return `<button class="set-row as-btn" data-profile="${esc(p.id)}"><span class="ic-sm">${svg("phone")}</span><div class="set-text"><b>${esc(p.name)}</b><span>${p.macs.length} device${p.macs.length === 1 ? "" : "s"}${st ? ` · ${st}` : ""}</span></div><span class="chev">${svg('<path d="M9 6l6 6-6 6"/>')}</span></button>`;
    }).join("") || `<p class="note" style="margin:0">No profiles yet.</p>`;
  }

  // Bedtimes: a profile whose devices all share the same one shows as one row.
  function paintBeds() {
    const rows = [], done = new Set();
    const key = (b) => b && `${b.days}|${b.start}|${b.end}`;
    for (const p of profiles()) {
      const bs = p.macs.map((m) => filters[lc(m)]?.bedtime);
      if (p.macs.length && bs.every((b) => b && key(b) === key(bs[0]))) {
        p.macs.forEach((m) => done.add(lc(m)));
        rows.push({ label: p.name, macs: p.macs, b: bs[0] });
      }
    }
    for (const [mac, f] of Object.entries(filters)) if (f.bedtime && !done.has(mac)) rows.push({ label: nameOf(mac), macs: [mac], b: f.bedtime });
    $("wcBedSub").textContent = rows.length ? rows.map((r) => r.label).join(", ") : "Internet off at night";
    $("wcBeds").innerHTML = rows.map((r) => `<div class="set-row"><span class="ic-sm">${svg("moon")}</span><div class="set-text"><b>${esc(r.label)}</b><span>${daysText(r.b.days)} · ${hhmm(r.b.start)} – ${hhmm(r.b.end)} offline</span></div><button class="ghost center auto danger" data-unbed="${esc(r.macs.join(","))}">Remove</button></div>`).join("")
      || `<p class="note" style="margin:0">No bedtimes. Add one to turn a device's internet off at night.</p>`;
  }

  function paintGuest() {
    const g = guest;
    if (!g) return;
    if (g.error) { $("wcGuest").innerHTML = `<p class="note" style="margin:0">${esc(g.error)}</p>`; return; }
    const line = g.on ? (g.left > 0 ? `On · turns off in ${left(Date.now() + g.left * 1000)}` : "On · until you turn it off") : "Off";
    $("wcGuest").innerHTML = `
      <div class="head-card"><div class="grow"><b>${esc(g.ssid || "Guest network")}</b><div class="status-line"><span class="dot ${g.on ? "on" : ""}"></span>${line}</div></div></div>
      <label class="fld">Guest Wi-Fi name<input class="field" id="wcGName" autocomplete="off" value="${esc(g.ssid || "")}" placeholder="Home Guest"></label>
      <label class="fld">Guest password<input class="field" id="wcGPass" type="password" autocomplete="off" value="${esc(g.open ? "" : g.pass || "")}"></label>
      <div class="mini-seg" id="wcGHours" style="margin-top:12px">${[[1, "1 h"], [2, "2 h"], [24, "1 day"], [0, "Always"]].map(([h, t]) => `<button data-gh="${h}" class="${h === guestHours ? "on" : ""}">${t}</button>`).join("")}</div>
      <div class="grid2" style="margin-top:12px;margin-bottom:0">
        <button class="${g.on ? "primary" : "primary"}" id="wcGOn">${g.on ? "Update" : "Turn on"}</button>
        <button class="ghost center" id="wcGOff" ${g.on ? "" : "disabled"}>Turn off</button>
      </div>
      <div class="list"><button class="ghost center" id="wcGQr">Show the QR code</button></div>
      <p class="note">The router turns it off by itself when the time is up. Wi-Fi restarts for a few seconds when you change it.</p>`;
  }

  async function act(btn, label, fn, done) {
    if (btn) { btn.disabled = true; btn.dataset.t = btn.textContent; btn.textContent = label; }
    try { const r = await fn(); if (done) toast(done); return r; }
    catch { /* toast already shown */ }
    finally { if (btn) { btn.disabled = false; btn.textContent = btn.dataset.t; } }
  }

  function openProfile(id) {
    const old = profiles().find((p) => p.id === id);
    const p = old ? JSON.parse(JSON.stringify(old)) : { id: "p" + Date.now().toString(36), name: "", macs: [] };
    const body = House.sheet(`
      <h3>${old ? esc(old.name) : "New profile"}</h3>
      <label class="fld">Name<input class="field" id="wpName" maxlength="24" placeholder="Kids" value="${esc(p.name)}"></label>
      <div class="label" style="margin-top:16px">Devices</div>
      <div class="chips" id="wpDevs"></div>
      ${old ? `<div class="label" style="margin-top:16px">Now</div>
        <div class="grid2" style="margin-bottom:0"><button class="ghost center danger" id="wpPause">Pause</button><button class="ghost center" id="wpResume">Resume</button></div>
        <div class="grid2" style="margin-top:8px;margin-bottom:0"><button class="ghost center" id="wpFocus">Focus 1 h</button><button class="ghost center" id="wpBed">Bedtime…</button></div>` : ""}
      <div class="list"><button class="primary full" id="wpSave">Save</button>${old ? `<button class="ghost center danger" id="wpDel">Delete profile</button>` : ""}</div>`);
    const paintDevs = () => {
      const sel = new Set(p.macs.map(lc));
      body.querySelector("#wpDevs").innerHTML = devs().sort((a, b) => a.label.localeCompare(b.label)).map((d) => `<button data-pd="${esc(lc(d.mac))}" class="${sel.has(lc(d.mac)) ? "on" : ""}">${esc(d.label)}</button>`).join("") || `<p class="note">Refresh the Devices tab first.</p>`;
    };
    paintDevs();
    body.querySelector("#wpDevs").onclick = (e) => { const b = e.target.closest("[data-pd]"); if (!b) return; buzz(6); const m = b.dataset.pd; p.macs = p.macs.map(lc).includes(m) ? p.macs.filter((x) => lc(x) !== m) : [...p.macs, m]; paintDevs(); };
    const save = () => { p.name = body.querySelector("#wpName").value.trim(); if (!p.name) { toast("Give the profile a name", true); return false; } saveProfiles([...profiles().filter((x) => x.id !== p.id), p]); return true; };
    body.querySelector("#wpSave").onclick = () => { if (!save()) return; House.closeSheet(); paintControl(); toast(`Saved “${p.name}”`); };
    body.querySelector("#wpDel")?.addEventListener("click", () => { if (!confirm(`Delete “${old.name}”? Its devices stay as they are.`)) return; saveProfiles(profiles().filter((x) => x.id !== p.id)); House.closeSheet(); paintControl(); });
    body.querySelector("#wpPause")?.addEventListener("click", async (e) => { save(); filters = (await act(e.currentTarget, "Pausing…", () => R("block", { macs: p.macs, names: namesFor(p.macs), on: true }), `${p.name} paused`)) || filters; paintControl(); });
    body.querySelector("#wpResume")?.addEventListener("click", async (e) => { save(); filters = (await act(e.currentTarget, "Resuming…", () => R("block", { macs: p.macs, on: false }), `${p.name} back online`)) || filters; paintControl(); });
    body.querySelector("#wpFocus")?.addEventListener("click", async (e) => { save(); const r = await act(e.currentTarget, "Pausing…", () => R("focus", { macs: p.macs, names: namesFor(p.macs), minutes: 60, label: p.name }), `${p.name}: back online in 1 h`); if (r) { status = r; loadControl(); } });
    body.querySelector("#wpBed")?.addEventListener("click", () => { save(); House.closeSheet(); setTimeout(() => openBedtime(`p:${p.id}`), 250); });
  }

  function openBedtime(who = "") {
    let days = 127;
    const body = House.sheet(`
      <h3>Internet bedtime</h3>
      <label class="fld">Who<select class="field" id="wbWho">${whoOptions(who)}</select></label>
      <div class="label" style="margin-top:16px">Days</div>
      <div class="days" id="wbDays">${DAYS.map((d, i) => `<button data-d="${i}">${d.slice(0, 2)}</button>`).join("")}</div>
      <div class="grid2" style="margin-top:12px;margin-bottom:0">
        <label class="fld" style="margin-top:0">Internet off at<input class="field" id="wbFrom" type="time" value="21:00"></label>
        <label class="fld" style="margin-top:0">Back on at<input class="field" id="wbTo" type="time" value="07:00"></label>
      </div>
      <div class="list"><button class="primary full" id="wbSave">Save bedtime</button></div>`);
    const paintDays = () => body.querySelectorAll("[data-d]").forEach((b) => b.classList.toggle("on", !!(days & (1 << +b.dataset.d))));
    paintDays();
    body.querySelector("#wbDays").onclick = (e) => { const b = e.target.closest("[data-d]"); if (!b) return; buzz(6); days ^= 1 << +b.dataset.d; paintDays(); };
    body.querySelector("#wbSave").onclick = async (e) => {
      const { macs, label } = resolve(body.querySelector("#wbWho").value);
      if (!macs.length) { toast("Pick who", true); return; }
      if (!days) { toast("Pick at least one day", true); return; }
      const start = body.querySelector("#wbFrom").value.replace(":", ""), end = body.querySelector("#wbTo").value.replace(":", "");
      const r = await act(e.currentTarget, "Saving…", () => R("bedtime", { macs, names: namesFor(macs), on: true, days, start, end }), `Bedtime set for ${label}`);
      if (r) { filters = r; House.closeSheet(); paintControl(); }
    };
  }

  /* ---- Tools (Devices tab): router health, data use. Loaded when opened. ---- */
  const toolsHtml = `
    ${F("router", "Router", "router", `<div id="wcHealth" data-wc></div>`, { subId: "wcHealthSub", sub: "Health, updates, restart" })}
    ${F("usage", "Data use", "chart", `<div id="wcUsage" data-wc></div>`, { sub: "Who used the most" })}`;
  const toolsOpen = () => !!document.querySelector('details[data-fold="wifi.router"][open], details[data-fold="wifi.usage"][open]');

  const upFor = (s) => { const d = Math.floor(s / 86400), h = Math.floor(s % 86400 / 3600); return d ? `${d} d ${h} h` : `${h} h ${Math.floor(s % 3600 / 60)} min`; };
  async function loadTools() {
    if (!signed()) { paintHealth(); paintUsage(); return; }
    const cache = store.json("wifi.tools", null);
    if (away() && cache) { ({ health, reboot, usage } = cache); showingCache.tools = cache.at; paintHealth(); paintUsage(); }
    const [h, rb, u] = await Promise.allSettled([R("health", {}, true), R("rebootSchedule", {}, true), R("usage", { dura: usageDura }, true)]);
    if (h.status === "rejected" && away()) {
      if (!cache) { health = { error: "You're away from home. The router can only be reached from the home Wi-Fi (or a VPN to it)." }; usage = { error: "Away from home: no data use until you're back." }; paintHealth(); paintUsage(); }
      return;
    }
    showingCache.tools = false;
    health = h.status === "fulfilled" ? h.value : { error: h.reason?.message };
    reboot = rb.status === "fulfilled" ? rb.value : null;
    usage = u.status === "fulfilled" ? u.value : { error: u.reason?.message };
    if (h.status === "fulfilled") store.setJson("wifi.tools", { health, reboot, usage: usage.error ? null : usage, at: Date.now() });
    paintHealth();
    paintUsage();
  }

  function paintHealth() {
    const box = $("wcHealth");
    if (!box) return;
    if (!signed()) { box.innerHTML = `<p class="note" style="margin:0">Sign in to your router (Settings) to see its health, check for updates and restart it.</p>`; return; }
    if (!health) { box.innerHTML = `<p class="note" style="margin:0">Checking the router…</p>`; return; }
    if (health.error) { box.innerHTML = `<p class="note" style="margin:0">${esc(health.error)}</p>`; return; }
    const h = health, r = reboot || { on: false, days: "1000000", time: "0300" };
    const day = Math.max(0, r.days.indexOf("1"));
    box.classList.toggle("away", showingCache.tools !== false);
    $("wcHealthSub").textContent = `${h.model || "Router"} · ${h.update ? "update ready" : "up to date"}${h.cpu != null ? ` · CPU ${h.cpu}%` : ""}`;
    box.innerHTML = (showingCache.tools !== false ? `<p class="note" style="margin-top:0"><b>You're away</b> · as of ${House.wifiAsOf(showingCache.tools)}</p>` : "") + `
      <div class="head-card"><div class="grow"><b>${esc(h.model || "ASUS router")}</b><div class="status-line"><span class="dot ${h.update ? "bad" : "on"}"></span>${h.update ? `Update ready: ${esc(h.update)}` : `Firmware ${esc(h.firmware)}`}</div></div><button class="round-btn glass" id="wcHRefresh" aria-label="Check again">${svg("refresh")}</button></div>
      <div class="stats" style="margin-top:10px">
        <div class="stat glass"><b>${h.cpu ?? "—"}%</b><span>CPU</span></div>
        <div class="stat glass"><b>${h.mem ?? "—"}%</b><span>Memory</span></div>
        <div class="stat glass"><b>${h.cpuTemp ?? h.wifiTemp ?? "—"}°</b><span>Temp °C</span></div>
      </div>
      <p class="note">${h.uptime ? `Running for ${upFor(h.uptime)}.` : ""} ${h.update ? "Install updates from the ASUS Router app or the router's web page." : ""}</p>
      <div class="grid2" style="margin-bottom:0"><button class="ghost center" id="wcUpd">Check for update</button><button class="ghost center danger" id="wcReboot">Restart router</button></div>
      <div class="set-row" style="margin-top:10px"><div class="set-text"><b>Weekly restart</b><span>The router restarts itself once a week, at night.</span></div><button class="tgl ${r.on ? "on" : ""}" id="wcRbTgl" aria-label="Weekly restart"><i></i></button></div>
      ${r.on ? `<div class="grid2" style="margin-bottom:0"><select class="field" id="wcRbDay">${DAYS.map((d, i) => `<option value="${i}" ${i === day ? "selected" : ""}>${d}</option>`).join("")}</select><input class="field" id="wcRbTime" type="time" value="${r.time.slice(0, 2)}:${r.time.slice(2)}"></div>` : ""}`;
  }
  async function saveReboot(on) {
    const day = +($("wcRbDay")?.value ?? Math.max(0, (reboot?.days || "1000000").indexOf("1")));
    const time = ($("wcRbTime")?.value || `${(reboot?.time || "0300").slice(0, 2)}:${(reboot?.time || "0300").slice(2)}`).replace(":", "");
    const days = DAYS.map((_, i) => (i === day ? "1" : "0")).join("");
    try { reboot = await R("rebootSchedule", { on, days, time }); toast(on ? `Restarts every ${DAYS[day]} at ${hhmm(time)}` : "Weekly restart off"); } catch {}
    paintHealth();
  }

  function paintUsage() {
    const box = $("wcUsage");
    if (!box) return;
    if (!signed()) { box.innerHTML = `<p class="note" style="margin:0">Sign in to your router (Settings) to see how much each device uses.</p>`; return; }
    if (!usage) { box.innerHTML = `<p class="note" style="margin:0">${showingCache.tools !== false ? "No data use saved from home yet." : "Asking the router…"}</p>`; return; }
    if (usage.error) { box.innerHTML = `<p class="note" style="margin:0">${esc(usage.error)}</p>`; return; }
    if (!usage.enabled) { box.innerHTML = `<p class="note" style="margin-top:0">Your router isn't counting data yet. Turn on its Traffic Analyzer to see who uses the most; it starts counting from now.</p><div class="list"><button class="primary full" id="wcUseOn">Turn on data tracking</button></div>`; return; }
    const seg = `<div class="mini-seg" id="wcUseDura"><button data-ud="24" class="${usageDura === 24 ? "on" : ""}">Today</button><button data-ud="7" class="${usageDura === 7 ? "on" : ""}">7 days</button><button data-ud="live" class="${liveOn ? "on" : ""}">Live</button></div>`;
    let rows;
    if (liveOn) {
      const list = (live || []).filter((d) => d.down + d.up > 0.05).sort((a, b) => b.down + b.up - (a.down + a.up)).slice(0, 10);
      const top = Math.max(1, ...list.map((d) => d.down + d.up));
      rows = list.map((d) => `<div class="use-row"><div class="row"><b class="grow">${esc(nameOf(d.mac))}</b><span class="muted small">${d.down.toFixed(1)} ↓ · ${d.up.toFixed(1)} ↑ Mbps</span></div><div class="use-bar"><i style="width:${(d.down + d.up) / top * 100}%"></i></div></div>`).join("")
        || `<p class="note">${live ? "Nothing busy right now." : "Measuring…"}</p>`;
    } else {
      const list = (usage.devices || []).filter((d) => d.down + d.up > 0).sort((a, b) => b.down + b.up - (a.down + a.up)).slice(0, 12);
      const top = Math.max(1, ...list.map((d) => d.down + d.up));
      rows = list.map((d) => `<div class="use-row"><div class="row"><b class="grow">${esc(nameOf(d.mac))}</b><span class="muted small">${bytes(d.down)} ↓ · ${bytes(d.up)} ↑</span></div><div class="use-bar"><i style="width:${(d.down + d.up) / top * 100}%"></i></div></div>`).join("")
        || `<p class="note">No data yet. The router counts as devices use the internet.</p>`;
    }
    box.innerHTML = seg + `<div style="margin-top:10px">${rows}</div>`;
  }
  async function liveTick() {
    clearTimeout(liveTimer);
    if (!liveOn || House.current !== "wifi" || House.tab !== "devices" || document.hidden || !document.querySelector('details[data-fold="wifi.usage"][open]')) return;
    try {
      const r = await R("live", {}, true);
      if (livePrev) {
        const dt = (r.at - livePrev.at) / 1000, prev = Object.fromEntries(livePrev.devices.map((d) => [d.mac, d]));
        live = r.devices.map((d) => { const p = prev[d.mac]; return { mac: d.mac, down: p && d.down >= p.down ? (d.down - p.down) * 8 / dt / 1e6 : 0, up: p && d.up >= p.up ? (d.up - p.up) * 8 / dt / 1e6 : 0 }; });
      }
      livePrev = r;
      paintUsage();
    } catch (e) { liveOn = false; toast(e.message || "Live data isn't available on this router", true); paintUsage(); return; }
    liveTimer = setTimeout(liveTick, 2500);
  }

  /* ---- Events ---- */
  function mount() {
    document.addEventListener("click", async (e) => {
      const t = e.target;
      if (!t.closest("#wcBody, [data-wc]")) return;
      let b;
      if ((b = t.closest("[data-fm]"))) { buzz(6); focusMin = +b.dataset.fm; paintControl(); return; }
      if ((b = t.closest("[data-keep]"))) { buzz(6); const k = new Set(keepList()); k.has(b.dataset.keep) ? k.delete(b.dataset.keep) : k.add(b.dataset.keep); store.setJson("wifi.keep", [...k]); paintControl(); return; }
      if ((b = t.closest("[data-profile]"))) { buzz(6); openProfile(b.dataset.profile); return; }
      if ((b = t.closest("[data-end]"))) { buzz(); const r = await act(b, "…", () => R("endTimer", { id: b.dataset.end }), "Done"); if (r) status = r; loadControl(); return; }
      if ((b = t.closest("[data-unprio]"))) { buzz(); const r = await act(b, "…", () => R("priority", { mac: b.dataset.unprio, on: false }), "Priority off"); if (r) status = r; loadControl(); return; }
      if ((b = t.closest("[data-resumeall]"))) { buzz(); const r = await act(b, "…", () => R("resumeAll"), "Everyone's back online"); if (r) status = r; loadControl(); return; }
      if ((b = t.closest("[data-resume]"))) { buzz(); const r = await act(b, "…", () => R("block", { macs: [b.dataset.resume], on: false }), `${nameOf(b.dataset.resume)} back online`); if (r) filters = r; paintControl(); return; }
      if ((b = t.closest("[data-unbed]"))) { buzz(); const macs = b.dataset.unbed.split(","); const r = await act(b, "…", () => R("bedtime", { macs, on: false, days: 127, start: "2100", end: "0700" }), "Bedtime removed"); if (r) filters = r; paintControl(); return; }
      if ((b = t.closest("[data-gh]"))) { buzz(6); guestHours = +b.dataset.gh; paintGuest(); return; }
      if ((b = t.closest("[data-ud]"))) {
        buzz(6);
        if (b.dataset.ud === "live") { liveOn = !liveOn; livePrev = null; live = null; paintUsage(); liveTick(); return; }
        liveOn = false; usageDura = +b.dataset.ud; usage = null; paintUsage();
        try { usage = await R("usage", { dura: usageDura }); } catch (err) { usage = { error: err.message }; }
        paintUsage();
        return;
      }
      switch (t.closest("button")?.id) {
        case "wcNewProfile": buzz(6); openProfile(null); break;
        case "wcBedAdd": buzz(6); openBedtime(); break;
        case "wcFocusGo": {
          const { macs, label } = resolve($("wcFocusWho").value);
          if (!macs.length) { toast("Pick who", true); break; }
          buzz();
          const r = await act(t.closest("button"), "Pausing…", () => R("focus", { macs, names: namesFor(macs), minutes: focusMin, label }), `${label}: back online in ${left(Date.now() + focusMin * 60e3)}`);
          if (r) { status = r; loadControl(); }
          break;
        }
        case "wcAllGo": {
          const keep = keepList(), minutes = +$("wcAllMin").value;
          if (!confirm(`Pause the internet for every device except ${keep.length ? keep.map(nameOf).join(", ") : "none"}${minutes ? ` for ${left(Date.now() + minutes * 60e3)}` : ""}?${keep.length ? "" : " This phone may lose internet too."}`)) break;
          const r = await act(t.closest("button"), "Pausing…", () => R("pauseAll", { macs: keep, minutes }), "Everyone else is paused");
          if (r) { status = r; loadControl(); }
          break;
        }
        case "wcPrioGo": {
          const { macs } = resolve($("wcPrioWho").value), minutes = +$("wcPrioMin").value;
          if (!macs.length) { toast("Pick who", true); break; }
          buzz();
          let r;
          for (const mac of macs) r = await act(t.closest("button"), "Setting…", () => R("priority", { mac, name: nameOf(mac), on: true, minutes }));
          if (r) { status = r; toast(minutes ? `Priority for ${left(Date.now() + minutes * 60e3)}` : "Priority on"); loadControl(); }
          break;
        }
        case "wcGOn": case "wcGOff": {
          const on = t.closest("button").id === "wcGOn";
          const ssid = $("wcGName").value.trim(), pass = $("wcGPass").value;
          if (on && ssid && pass.length < 8) { toast("The guest password needs at least 8 characters", true); break; }
          buzz();
          const r = await act(t.closest("button"), on ? "Turning on…" : "Turning off…", () => R("guest", { on, hours: guestHours, ssid: on && (ssid !== guest.ssid || pass !== guest.pass) ? ssid : "", pass }), on ? "Guest Wi-Fi on" : "Guest Wi-Fi off");
          if (r) { guest = { ...guest, ...r }; if (on && ssid) store.setJson("wifi.guest", { ssid, pass, sec: "WPA" }); paintGuest(); }
          break;
        }
        case "wcGQr": {
          const ssid = $("wcGName").value.trim(), pass = $("wcGPass").value;
          if (!ssid) { toast("Give the guest Wi-Fi a name first", true); break; }
          store.setJson("wifi.guest", { ssid, pass, sec: pass ? "WPA" : "none" });
          House.showTab("tools");
          break;
        }
        case "wcPassGo": {
          const p1 = $("wcPass").value, p2 = $("wcPass2").value;
          if (p1.length < 8 || p1.length > 63) { toast("Use 8 to 63 characters", true); break; }
          if (p1 !== p2) { toast("The two passwords don't match", true); break; }
          if (!confirm("Change the Wi-Fi password? Every device, including this phone, will need to join again with the new one.")) break;
          const r = await act(t.closest("button"), "Changing…", () => R("password", { pass: p1 }), "Wi-Fi password changed. Join again with the new one.");
          if (r) { $("wcPass").value = ""; $("wcPass2").value = ""; }
          break;
        }
        case "wcHRefresh": buzz(6); health = null; paintHealth(); loadTools(); break;
        case "wcUpd": {
          const r = await act(t.closest("button"), "Checking…", () => R("checkUpdate"));
          if (r) { health.update = r.update; toast(r.update ? `Update ready: ${r.update}` : "Your router is up to date"); paintHealth(); }
          break;
        }
        case "wcReboot":
          if (!confirm("Restart the router? Wi-Fi and internet will be off for about 2 minutes.")) break;
          await act(t.closest("button"), "Restarting…", () => R("reboot"), "The router is restarting (about 2 minutes)");
          break;
        case "wcRbTgl": buzz(); saveReboot(!reboot?.on); break;
        case "wcUseOn": {
          const r = await act(t.closest("button"), "Turning on…", () => R("enableUsage"), "Data tracking on. Check back later.");
          if (r) { usage = { enabled: true, devices: [] }; paintUsage(); }
          break;
        }
      }
    });
    document.addEventListener("change", (e) => { if (e.target.id === "wcRbDay" || e.target.id === "wcRbTime") saveReboot(true); });
    // Router and Data use load when opened.
    document.addEventListener("toggle", (e) => {
      const k = e.target.dataset?.fold;
      if (k === "wifi.router" || k === "wifi.usage") { if (e.target.open) loadTools(); else if (k === "wifi.usage") { liveOn = false; clearTimeout(liveTimer); } }
    }, true);
  }

  House.wifiControl = {
    controlHtml, toolsHtml, guestHtml, passwordHtml, keepHtml, mount,
    onShow(tab) {
      if (tab === "devices" || tab === "settings") loadControl();
      if (tab === "devices" && toolsOpen()) loadTools();
      if (tab !== "devices") { liveOn = false; clearTimeout(liveTimer); }
    },
    repaint() { paintControl(); },
  };
})();
