// 🖥️ The PC tab on the Wi-Fi side: computers with the House PC helper (pc-helper/ in the repo).
// Power (sleep, lock, restart, shut down, and turn on with Wake-on-LAN), volume and media,
// open programs, a message on screen, a screenshot, health, and schedules: the nightly
// shutdown runs on the PC itself; "turn on at" is sent from this phone (native PcWake).
// Pairing asks "Allow?" on the PC and gives this phone a key, kept here (pc.list).

(() => {
  const PORT = 47801;
  const NEED = 2; // helper version this tab needs
  const pcs = () => store.json("pc.list", []); // [{ mac, ip, name, key }]
  const savePcs = (l) => store.setJson("pc.list", l);
  const lc = (m) => (m || "").toLowerCase();
  let state = {};   // mac → { online, uptime, user, version, unpaired }
  let health = null, apps = null, shot = null, pcSettings = null, wakeCfg = null;
  let current = store.get("pc.current", "");
  const cur = () => pcs().find((p) => lc(p.mac) === lc(current)) || pcs()[0];

  const timeout = (p, ms) => Promise.race([p, new Promise((_, no) => setTimeout(() => no(new Error("No answer")), ms))]);
  async function call(ip, path, { key, method = "GET", body, ms = 2500 } = {}) {
    const r = await timeout(fetch(`http://${ip}:${PORT}${path}`, {
      method, headers: { "Content-Type": "application/json", ...(key ? { "X-House-Key": key } : {}) }, body: body ? JSON.stringify(body) : undefined,
    }), ms);
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || `The PC said no (${r.status})`);
    return j;
  }
  // The PC's address now: from the device list (by MAC) when it's there.
  const ipOf = (pc) => (House.byId("wifi")?.list?.() || []).find((d) => lc(d.mac) === lc(pc.mac))?.ip || pc.ip;
  const on = (pc) => pc && state[lc(pc.mac)]?.online;
  const away = () => House.wifiAway?.() === true;

  async function hello(ip) {
    try { const j = await call(ip, "/hello", { ms: 1500 }); return j.app === "house-pc" ? j : null; } catch { return null; }
  }

  async function pair(ip, btn) {
    if (btn) { btn.disabled = true; btn.textContent = "Tap Yes on the PC…"; }
    try {
      const j = await call(ip, "/pair", { method: "POST", ms: 65000 });
      savePcs([...pcs().filter((p) => lc(p.mac) !== lc(j.mac)), { mac: lc(j.mac), ip: j.ip || ip, name: j.name, key: j.key }]);
      current = lc(j.mac);
      store.set("pc.current", current);
      toast(`${j.name} paired`);
      refresh();
      return true;
    } catch (e) {
      toast(e.message === "No answer" ? "The PC didn't answer" : e.message, true);
      return false;
    } finally { if (btn) { btn.disabled = false; btn.textContent = "Pair with this PC"; } }
  }

  const LABELS = { shutdown: "Shut down", restart: "Restart", sleep: "Sleep", lock: "Lock", cancel: "Cancel shutdown" };
  async function act(pc, action) {
    const name = pc.name || "the PC";
    if (["shutdown", "restart"].includes(action) && !confirm(`${LABELS[action]} ${name}? It starts in 10 seconds; anything unsaved is lost.`)) return;
    if (action === "sleep" && !confirm(`Put ${name} to sleep?`)) return;
    buzz();
    try {
      await call(ipOf(pc), "/cmd", { key: pc.key, method: "POST", body: { action } });
      if (LABELS[action]) toast(action === "shutdown" ? `${name} shuts down in 10 seconds` : action === "restart" ? `${name} restarts in 10 seconds` : action === "cancel" ? "Shutdown cancelled" : `${name}: ${LABELS[action].toLowerCase()}`);
      if (["shutdown", "sleep"].includes(action)) setTimeout(refresh, 15000);
    } catch (e) {
      toast(e.message === "No answer" ? `${name} isn't answering (off or asleep?)` : e.message, true);
    }
  }

  async function wake(pc) {
    buzz();
    try {
      await Net.wake({ mac: pc.mac, broadcast: ipOf(pc).split(".").slice(0, 3).join(".") + ".255" });
      toast(`Waking ${pc.name}… give it a minute`);
      waking = Date.now();
      paint();
    } catch { toast("Couldn't send the wake-up", true); }
  }

  // While the tab is open: check every 10 s while waking or starting up, otherwise every 30 s.
  let waking = 0, timer = 0;
  function poll() {
    clearTimeout(timer);
    if (House.current !== "wifi" || House.tab !== "pc" || document.hidden || !pcs().length) return;
    const st = state[lc(cur()?.mac)];
    if (waking && (st?.online || Date.now() - waking > 3 * 60e3)) waking = 0;
    timer = setTimeout(() => refresh().then(poll), waking || st?.starting ? 10000 : 30000);
  }
  document.addEventListener("visibilitychange", () => { if (!document.hidden && House.current === "wifi" && House.tab === "pc") refresh().then(poll); });

  async function refresh() {
    await Promise.all(pcs().map(async (pc) => {
      try { const j = await call(ipOf(pc), "/status", { key: pc.key, ms: 2500 }); state[lc(pc.mac)] = { online: true, ...j }; }
      catch (e) {
        const seen = (House.byId("wifi")?.list?.() || []).find((d) => lc(d.mac) === lc(pc.mac))?.online;
        state[lc(pc.mac)] = { online: false, unpaired: /paired/i.test(e.message), starting: !!seen && !/paired/i.test(e.message) };
      }
    }));
    paint();
    // Opened folds load their part.
    const pc = cur();
    if (pc && on(pc)) {
      if (isOpen("health")) loadHealth();
      if (isOpen("programs")) loadApps();
      if (isOpen("schedule")) loadSettings();
    }
  }

  const isOpen = (k) => !!document.querySelector(`details[data-fold="pc.${k}"][open]`);
  const upFor = (s) => { const d = Math.floor(s / 86400), h = Math.floor(s % 86400 / 3600); return d ? `${d} d ${h} h` : `${h} h ${Math.floor(s % 3600 / 60)} min`; };
  const gb = (b) => `${Math.round(b / 1e9)} GB`;
  const F = (k, t, i, body, opts) => House.fold("pc." + k, t, i, body, opts);

  /* ---- The tab ---- */
  const html = `<div id="pcTab"></div>`;

  function paint() {
    const box = $("pcTab");
    if (!box) return;
    const list = pcs(), pc = cur();
    if (!pc) { paintEmpty(box); return; }
    const st = state[lc(pc.mac)];
    const old = st?.online && (st.version || 1) < NEED;
    const opened = (k) => ({ open: document.querySelector(`details[data-fold="pc.${k}"]`)?.open ?? null });
    const line = !st ? "Checking…" : st.online ? `On · running for ${upFor(st.uptime)}${st.user ? ` · ${esc(st.user)}` : ""}` : st.unpaired ? "Pair again: open it in Devices" : away() ? "Can't see it from away" : st.starting ? "Starting up, or waiting for someone to sign in" : waking ? "Waking up… checking every few seconds" : "Off or asleep";
    box.innerHTML = (list.length > 1 ? `<div class="chips" style="margin-bottom:12px">${list.map((p) => `<button data-pc-pick="${esc(p.mac)}" class="${p === pc ? "on" : ""}">${esc(p.name)}</button>`).join("")}</div>` : "")
      + `<div class="card glass"><div class="head-card"><span class="pc-dot ${st?.online ? "on" : ""}"></span><div class="grow"><b>${esc(pc.name)}</b><div class="status-line">${line}</div></div>
          <button class="round-btn glass" id="pcRefresh" aria-label="Check again">${svg("refresh")}</button></div>
        ${st?.online ? `<div class="pc-btns">
            <button class="ghost center" data-pc-do="sleep">${svg("moon")}Sleep</button><button class="ghost center" data-pc-do="lock">${svg("key")}Lock</button>
            <button class="ghost center" data-pc-do="restart">${svg("refresh")}Restart</button><button class="ghost center danger" data-pc-do="shutdown">${svg("power")}Shut down</button></div>
            <div class="list" style="margin-top:6px"><button class="ghost center small-btn" data-pc-do="cancel">Cancel a shutdown or restart</button></div>`
          : `<div class="list"><button class="primary full" data-pc-do="wake">${svg("power")} Turn on</button></div>
             <p class="note">Turning on uses Wake-on-LAN: it works when the PC is plugged in by cable and Wake-on-LAN is on in its settings.</p>`}
        ${old ? `<p class="note err">This PC's helper is old. Run <b>pc-helper\\install.ps1</b> on it again for the features below.</p>` : ""}
      </div>`
      + (st?.online ? F("media", "Volume and media", "speaker", `<div class="pc-media">
            <button class="ghost center" data-pc-do="voldown" aria-label="Volume down">${svg("minus")}</button><button class="ghost center" data-pc-do="mute">Mute</button><button class="ghost center" data-pc-do="volup" aria-label="Volume up">${svg("plus")}</button>
            <button class="ghost center" data-pc-do="prev" aria-label="Previous">⏮</button><button class="ghost center" data-pc-do="playpause" aria-label="Play or pause">⏯</button><button class="ghost center" data-pc-do="next" aria-label="Next">⏭</button></div>`, { sub: "Volume, mute, play / pause", ...opened("media") })
        + F("programs", "Programs", "apps", `<div id="pcApps"><p class="note" style="margin:0">Loading…</p></div>`, { subId: "pcAppsSub", sub: "See and close open programs", ...opened("programs") })
        + F("message", "Message on screen", "bell", `<textarea class="field" id="pcMsg" rows="2" maxlength="500" placeholder="Dinner's ready!"></textarea><div class="list"><button class="primary full" id="pcMsgGo">Show it on the PC</button></div>`, { sub: "Pops up on the PC", ...opened("message") })
        + F("shot", "Screenshot", "screen", `<div id="pcShot">${shot ? shotHtml() : ""}</div><div class="list"><button class="primary full" id="pcShotGo">Take a screenshot</button></div>`, { sub: "See the PC's screen", ...opened("shot") })
        + F("health", "Health", "chart", `<div id="pcHealth"><p class="note" style="margin:0">Loading…</p></div>`, { subId: "pcHealthSub", sub: "CPU, memory, disks", ...opened("health") }) : "")
      + F("schedule", "Schedule", "clock", `<div id="pcSched"><p class="note" style="margin:0">${st?.online ? "Loading…" : "Turn the PC on to change its nightly shutdown."}</p></div><div id="pcWake"></div>`, { subId: "pcSchedSub", sub: "Nightly shutdown, turn on at", ...opened("schedule") });
    paintHealth(); paintApps(); paintSched(); paintWake();
  }

  async function paintEmpty(box) {
    box.innerHTML = `<div class="card glass"><b>No PC yet</b>
      <p class="note">Install the House PC helper on a Windows PC (pc-helper in the House repo: run install.ps1). Then find it here and pair: the PC asks "Allow?" once.</p>
      <div class="list"><button class="primary full" id="pcFind">Find PCs on my Wi-Fi</button></div><div id="pcFound"></div></div>`;
  }
  async function find(btn) {
    btn.disabled = true; btn.textContent = "Looking…";
    const ips = [...new Set((House.byId("wifi")?.list?.() || []).filter((d) => d.online && d.ip).map((d) => d.ip))];
    const found = (await Promise.all(ips.map(async (ip) => ({ ip, h: await hello(ip) })))).filter((x) => x.h);
    btn.disabled = false; btn.textContent = "Find PCs on my Wi-Fi";
    $("pcFound").innerHTML = found.length ? found.map((x) => `<div class="set-row"><span class="ic-sm">${svg("laptop")}</span><div class="set-text"><b>${esc(x.h.name)}</b><span>${esc(x.ip)}</span></div><button class="ghost center auto" data-pc-pair="${esc(x.ip)}">Pair</button></div>`).join("")
      : `<p class="note">No PC with the helper answered. Is it on, with the helper installed? Refresh the Devices tab first.</p>`;
  }

  /* ---- Folds ---- */
  async function loadHealth() {
    const pc = cur();
    try { health = await call(ipOf(pc), "/status?full=1", { key: pc.key, ms: 8000 }); } catch (e) { health = { error: e.message }; }
    paintHealth();
  }
  function paintHealth() {
    const box = $("pcHealth");
    if (!box || !health) return;
    if (health.error) { box.innerHTML = `<p class="note" style="margin:0">${esc(health.error)}</p>`; return; }
    const h = health;
    $("pcHealthSub").textContent = `CPU ${h.cpu}% · memory ${h.mem}%${h.disks?.[0] ? ` · ${h.disks[0].name} ${gb(h.disks[0].free)} free` : ""}`;
    box.innerHTML = `<div class="stats"><div class="stat glass"><b>${h.cpu}%</b><span>CPU</span></div><div class="stat glass"><b>${h.mem}%</b><span>Memory</span></div><div class="stat glass"><b>${h.idle == null ? "—" : h.idle < 120 ? "Now" : `${Math.round(h.idle / 60)}m`}</b><span>Last used</span></div></div>`
      + (h.disks || []).map((d) => `<div class="use-row" style="margin-top:12px"><div class="row"><b class="grow">Disk ${esc(d.name)}</b><span class="muted small">${gb(d.free)} free of ${gb(d.size)}</span></div><div class="use-bar"><i style="width:${Math.round(100 * (1 - d.free / d.size))}%"></i></div></div>`).join("")
      + `<p class="note">Signed in: ${esc(h.user)} · on for ${upFor(h.uptime)} · ${Math.round(h.memTotal / 1e9)} GB memory</p>`;
  }

  async function loadApps() {
    const pc = cur();
    try { apps = (await call(ipOf(pc), "/apps", { key: pc.key, ms: 8000 })).apps; } catch (e) { apps = { error: e.message }; }
    paintApps();
  }
  function paintApps() {
    const box = $("pcApps");
    if (!box || !apps) return;
    if (apps.error) { box.innerHTML = `<p class="note" style="margin:0">${esc(apps.error)}</p>`; return; }
    $("pcAppsSub").textContent = apps.length ? `${apps.length} open: ${apps.slice(0, 3).map((a) => a.name).join(", ")}${apps.length > 3 ? "…" : ""}` : "Nothing open";
    box.innerHTML = apps.map((a) => `<div class="set-row"><div class="set-text"><b>${esc(a.name)}</b><span>${esc(a.title)}</span></div><button class="ghost center auto" data-pc-close="${a.pid}">Close</button></div>`).join("")
      || `<p class="note" style="margin:0">No programs with a window are open.</p>`;
    box.insertAdjacentHTML("beforeend", `<div class="list"><button class="ghost center small-btn" id="pcAppsReload">Refresh the list</button></div>`);
  }
  async function closeApp(pid, btn) {
    const pc = cur(), a = (apps || []).find((x) => x.pid === pid);
    buzz();
    btn.disabled = true; btn.textContent = "Closing…";
    try {
      await call(ipOf(pc), "/close", { key: pc.key, method: "POST", body: { pid } });
      await new Promise((r) => setTimeout(r, 2500));
      await loadApps();
      if ((apps || []).some?.((x) => x.pid === pid)) {
        if (confirm(`${a?.name || "It"} is still open (it may be asking to save). Force it to close? Unsaved work is lost.`)) {
          await call(ipOf(pc), "/close", { key: pc.key, method: "POST", body: { pid, force: true } });
          setTimeout(loadApps, 1500);
        }
      } else toast(`${a?.name || "Program"} closed`);
    } catch (e) { toast(e.message, true); btn.disabled = false; btn.textContent = "Close"; }
  }

  const shotHtml = () => `<img class="pc-shot" src="${shot.image}" alt="The PC's screen"><p class="note" style="margin-top:6px">Taken ${new Date(shot.at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}. Tap to see it bigger.</p>`;
  async function takeShot(btn) {
    const pc = cur();
    btn.disabled = true; btn.textContent = "Taking it…";
    try { shot = await call(ipOf(pc), "/screenshot", { key: pc.key, ms: 35000 }); $("pcShot").innerHTML = shotHtml(); }
    catch (e) { toast(e.message, true); }
    btn.disabled = false; btn.textContent = "Take a screenshot";
  }

  // Nightly shutdown lives on the PC; "turn on at" on this phone.
  const TIMES = Array.from({ length: 21 }, (_, i) => { const m = (20 * 60 + i * 30) % 1440; return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`; });
  const hm = (t) => new Date(2000, 0, 1, +t.slice(0, 2), +t.slice(3)).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  async function loadSettings() {
    const pc = cur();
    try { pcSettings = await call(ipOf(pc), "/settings", { key: pc.key }); } catch (e) { pcSettings = { error: e.message }; }
    paintSched();
  }
  function paintSched() {
    const box = $("pcSched");
    if (!box || !pcSettings) return;
    if (pcSettings.error) { box.innerHTML = `<p class="note" style="margin:0">${esc(pcSettings.error)}</p>`; return; }
    const n = pcSettings.nightly || { on: false, time: "02:00", idleMin: 15 };
    box.innerHTML = `<div class="set-row" style="padding-top:0"><div class="set-text"><b>Shut down every night</b><span>Kept by the PC, so it works with your phone away. A 2-minute warning with Cancel comes first.</span></div><button class="tgl ${n.on ? "on" : ""}" id="pcNightTgl" aria-label="Shut down every night"><i></i></button></div>
      ${n.on ? `<div class="grid2" style="margin:10px 0 0">
        <label class="fld" style="margin-top:0">At<select class="field" id="pcNightTime">${TIMES.map((t) => `<option value="${t}" ${t === n.time ? "selected" : ""}>${hm(t)}</option>`).join("")}</select></label>
        <label class="fld" style="margin-top:0">Skip if used in the last<select class="field" id="pcNightIdle">${[0, 5, 15, 30, 60].map((m) => `<option value="${m}" ${m === (n.idleMin ?? 15) ? "selected" : ""}>${m ? `${m} min` : "Never skip"}</option>`).join("")}</select></label></div>` : ""}`;
    updateSchedSub();
  }
  async function saveNightly(changes) {
    const pc = cur(), n = { ...(pcSettings?.nightly || { on: false, time: "02:00", idleMin: 15 }), ...changes };
    try { pcSettings = await call(ipOf(pc), "/settings", { key: pc.key, method: "POST", body: { nightly: n } }); toast(n.on ? `Shuts down every night at ${hm(n.time)}` : "Nightly shutdown off"); }
    catch (e) { toast(e.message, true); }
    paintSched();
  }

  async function loadWake() {
    try { wakeCfg = await Net.getPcWake(); } catch { wakeCfg = { on: false, minutes: 420, days: [] }; }
    paintWake();
  }
  const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  function paintWake() {
    const box = $("pcWake");
    if (!box || !wakeCfg) return;
    const w = wakeCfg, t = `${String(Math.floor(w.minutes / 60)).padStart(2, "0")}:${String(w.minutes % 60).padStart(2, "0")}`;
    const days = w.days?.length ? w.days : [1, 2, 3, 4, 5, 6, 7];
    box.innerHTML = `<div class="set-row" style="margin-top:10px"><div class="set-text"><b>Turn on at a set time</b><span>Sent from this phone, so it needs to be home then.</span></div><button class="tgl ${w.on ? "on" : ""}" id="pcWakeTgl" aria-label="Turn on at a set time"><i></i></button></div>
      ${w.on ? `<label class="fld">At<input class="field" type="time" id="pcWakeTime" value="${t}"></label>
        <div class="days" id="pcWakeDays">${DAYS.map((d, i) => `<button data-wd="${i + 1}" class="${days.includes(i + 1) ? "on" : ""}">${d.slice(0, 2)}</button>`).join("")}</div>` : ""}`;
    updateSchedSub();
  }
  async function saveWake(changes, msg) {
    const pc = cur();
    const next = { ...(wakeCfg || {}), ...changes, mac: pc.mac, broadcast: ipOf(pc).split(".").slice(0, 3).join(".") + ".255", name: pc.name };
    try { wakeCfg = await Net.setPcWake(next); if (msg) toast(msg); } catch { toast("Couldn't save that", true); }
    paintWake();
  }
  function updateSchedSub() {
    const n = pcSettings?.nightly, parts = [];
    if (n?.on) parts.push(`off at ${hm(n.time)}`);
    if (wakeCfg?.on) parts.push(`on at ${hm(`${String(Math.floor(wakeCfg.minutes / 60)).padStart(2, "0")}:${String(wakeCfg.minutes % 60).padStart(2, "0")}`)}`);
    const sub = $("pcSchedSub");
    if (sub) sub.textContent = parts.length ? parts.join(" · ") : "Nightly shutdown, turn on at";
  }

  /* ---- In a device sheet: pair, or jump to the PC tab ---- */
  async function sheet(d, body) {
    const box = body.querySelector("#devPc");
    if (!box || !d.ip) return;
    const pc = pcs().find((p) => lc(p.mac) === lc(d.mac) || p.ip === d.ip);
    const h = pc ? null : await hello(d.ip);
    if (!h && !pc) return;
    box.innerHTML = `<div class="label" style="margin-top:18px">This PC</div>` + (pc
      ? `<div class="list"><button class="primary full" id="pcOpenTab">Open the PC tab</button></div>`
      : `<p class="note" style="margin-top:0">${esc(h.name)} has the House PC helper. Pair once to control it from the PC tab.</p><div class="list"><button class="primary full" id="pcPair">Pair with this PC</button></div>`);
    body.querySelector("#pcPair")?.addEventListener("click", async (e) => { if (await pair(d.ip, e.currentTarget)) { House.closeSheet(); House.showTab("pc"); } });
    body.querySelector("#pcOpenTab")?.addEventListener("click", () => { current = pc.mac; store.set("pc.current", current); House.closeSheet(); House.showTab("pc"); });
  }

  /* ---- Events ---- */
  document.addEventListener("click", async (e) => {
    if (!e.target.closest("#pcTab")) return;
    const t = e.target, pc = cur();
    let b;
    if ((b = t.closest("[data-pc-pick]"))) { buzz(6); current = b.dataset.pcPick; store.set("pc.current", current); health = apps = shot = pcSettings = null; paint(); refresh(); return; }
    if ((b = t.closest("[data-pc-pair]"))) { pair(b.dataset.pcPair, b); return; }
    if ((b = t.closest("[data-pc-do]"))) { if (b.dataset.pcDo === "wake") wake(pc); else act(pc, b.dataset.pcDo); return; }
    if ((b = t.closest("[data-pc-close]"))) { closeApp(+b.dataset.pcClose, b); return; }
    if ((b = t.closest("[data-wd]"))) {
      buzz(6);
      const d = +b.dataset.wd, days = wakeCfg.days?.length ? wakeCfg.days : [1, 2, 3, 4, 5, 6, 7];
      const next = days.includes(d) ? days.filter((x) => x !== d) : [...days, d].sort();
      if (!next.length) { toast("Pick at least one day", true); return; }
      saveWake({ days: next });
      return;
    }
    if (t.closest(".pc-shot")) { House.sheet(`<img src="${shot.image}" alt="The PC's screen" style="width:100%;border-radius:12px">`); return; }
    switch (t.closest("button")?.id) {
      case "pcRefresh": buzz(6); t.closest("button").classList.add("spin"); await refresh(); $("pcRefresh")?.classList.remove("spin"); break;
      case "pcFind": find(t.closest("button")); break;
      case "pcAppsReload": buzz(6); loadApps(); break;
      case "pcShotGo": buzz(); takeShot(t.closest("button")); break;
      case "pcMsgGo": {
        const text = $("pcMsg").value.trim();
        if (!text) { toast("Type a message", true); break; }
        buzz();
        try { await call(ipOf(pc), "/message", { key: pc.key, method: "POST", body: { text } }); $("pcMsg").value = ""; toast("Shown on the PC"); }
        catch (err) { toast(err.message, true); }
        break;
      }
      case "pcNightTgl": buzz(); saveNightly({ on: !pcSettings?.nightly?.on }); break;
      case "pcWakeTgl": buzz(); saveWake({ on: !wakeCfg?.on }, !wakeCfg?.on ? "The PC will be turned on at that time" : "Turn on at a set time: off"); break;
    }
  });
  document.addEventListener("change", (e) => {
    if (e.target.id === "pcNightTime") saveNightly({ time: e.target.value });
    if (e.target.id === "pcNightIdle") saveNightly({ idleMin: +e.target.value });
    if (e.target.id === "pcWakeTime") { const [h, m] = e.target.value.split(":").map(Number); saveWake({ minutes: h * 60 + m }, "Saved"); }
  });
  document.addEventListener("toggle", (e) => {
    const k = e.target.dataset?.fold;
    if (!e.target.open || !k?.startsWith("pc.")) return;
    if (k === "pc.schedule") loadWake();
    if (!on(cur())) return;
    if (k === "pc.health") loadHealth();
    if (k === "pc.programs") loadApps();
    if (k === "pc.schedule") loadSettings();
  }, true);

  House.pc = {
    html, sheet,
    onShow() { paint(); refresh().then(poll); loadWake(); },
  };
})();
