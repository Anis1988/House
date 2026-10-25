// 🌡️ Nest: thermostat and doorbell through Google's Smart Device Management API (Device Access).
// Cloud only: you set up your own Device Access project once, then sign in with Google.
// Requests go through Capacitor's native HTTP (no browser CORS). Keys stay on this phone.

(() => {
  const REDIRECT = "https://www.google.com";
  const SDM = "https://smartdevicemanagement.googleapis.com/v1";
  const cfg = () => store.json("nest.cfg", { project: "", clientId: "", secret: "" });
  let tok = store.json("nest.tok", null); // { access, refresh, exp }
  let devices = [];
  let busy = false;
  const fahrenheit = () => store.get("nest.unit", "C") === "F";
  const shown = (c) => (c == null ? "—" : fahrenheit() ? Math.round(c * 9 / 5 + 32) : Math.round(c * 2) / 2);
  const toC = (v) => (fahrenheit() ? (v - 32) * 5 / 9 : v);

  async function token() {
    if (!tok?.refresh) throw new Error("Sign in with Google first (Settings)");
    if (tok.access && tok.exp > Date.now() + 60000) return tok.access;
    const c = cfg();
    const r = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id: c.clientId, client_secret: c.secret, refresh_token: tok.refresh, grant_type: "refresh_token" }).toString(),
    });
    const j = await r.json();
    if (!j.access_token) throw new Error(j.error_description || "Google sign-in expired. Sign in again.");
    tok = { ...tok, access: j.access_token, exp: Date.now() + (j.expires_in || 3600) * 1000 };
    store.setJson("nest.tok", tok);
    return tok.access;
  }
  async function api(path, body) {
    const r = await fetch(`${SDM}/${path}`, {
      method: body ? "POST" : "GET",
      headers: { Authorization: `Bearer ${await token()}`, "Content-Type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error?.message || `Nest error ${r.status}`);
    return j;
  }

  const trait = (d, t) => d.traits?.[`sdm.devices.traits.${t}`] || {};
  const nameOf = (d) => trait(d, "Info").customName || d.parentRelations?.[0]?.displayName || (d.type || "").split(".").pop().toLowerCase();
  const thermostats = () => devices.filter((d) => d.type === "sdm.devices.types.THERMOSTAT");
  const doorbells = () => devices.filter((d) => /DOORBELL|CAMERA|DISPLAY/.test(d.type));

  async function load(manual) {
    if (!tok?.refresh || busy) { paint(); return; }
    busy = true;
    $("nestRefresh").classList.add("spin");
    try {
      devices = (await api(`enterprises/${cfg().project}/devices`)).devices || [];
      if (manual) toast(devices.length ? `${devices.length} Nest device${devices.length === 1 ? "" : "s"}` : "No devices shared. Sign in again and tick them.");
    } catch (e) { if (manual || !devices.length) toast(e.message, true); }
    busy = false;
    $("nestRefresh").classList.remove("spin");
    paint();
  }

  // The screen changes at once (callers update the device first); Google is told in the background,
  // and the real state is read back a few seconds after the last change.
  let reloadTimer;
  async function command(d, cmd, params, ok) {
    try {
      await api(`${d.name}:executeCommand`, { command: `sdm.devices.commands.${cmd}`, params });
      if (ok) toast(ok);
      clearTimeout(reloadTimer);
      reloadTimer = setTimeout(() => load(), 4000);
    } catch (e) { toast(e.message, true); load(); }
  }
  // + and − pressed quickly: send only the final temperature, once the taps stop.
  let setpointTimer;
  function sendSetpoint(t, mode, v) {
    clearTimeout(setpointTimer);
    setpointTimer = setTimeout(() => {
      if (mode === "HEAT") command(t, "ThermostatTemperatureSetpoint.SetHeat", { heatCelsius: v });
      else command(t, "ThermostatTemperatureSetpoint.SetCool", { coolCelsius: v });
    }, 700);
  }
  const setTrait = (d, name, values) => { d.traits[`sdm.devices.traits.${name}`] = { ...trait(d, name), ...values }; };

  /* Thermostat dial */
  function arc(frac) {
    const r = 100, c = 2 * Math.PI * r, span = 0.75;
    return `<svg viewBox="0 0 240 240"><g transform="rotate(135 120 120)">
      <circle cx="120" cy="120" r="${r}" stroke="var(--edge-hi)" stroke-width="14" fill="none" stroke-dasharray="${c * span} ${c}" stroke-linecap="round"/>
      <circle cx="120" cy="120" r="${r}" stroke="url(#ng)" stroke-width="14" fill="none" stroke-dasharray="${c * span * frac} ${c}" stroke-linecap="round"/></g>
      <defs><linearGradient id="ng" x1="0" x2="1"><stop offset="0" stop-color="var(--a3)"/><stop offset="1" stop-color="var(--a1)"/></linearGradient></defs></svg>`;
  }
  function paintThermo() {
    const box = $("nestThermo");
    const t = thermostats()[0];
    if (!tok?.refresh) { box.innerHTML = setupCard(); return; }
    if (!t) { box.innerHTML = `<div class="card glass empty"><div class="big">${svg("thermo")}</div><b>${busy ? "Loading…" : "No thermostat shared"}</b><p>When you sign in, tick your thermostat on Google's page.</p></div>`; return; }
    const mode = trait(t, "ThermostatMode").mode || "OFF";
    const modes = trait(t, "ThermostatMode").availableModes || ["HEAT", "COOL", "HEATCOOL", "OFF"];
    const eco = trait(t, "ThermostatEco").mode === "MANUAL_ECO";
    const sp = trait(t, "ThermostatTemperatureSetpoint");
    const hvac = trait(t, "ThermostatHvac").status || "OFF";
    const now = trait(t, "Temperature").ambientTemperatureCelsius;
    const hum = trait(t, "Humidity").ambientHumidityPercent;
    const target = mode === "COOL" ? sp.coolCelsius : mode === "HEAT" ? sp.heatCelsius : null;
    const frac = target ? Math.min(1, Math.max(0, (target - 9) / (32 - 9))) : 0;
    const what = eco ? "Eco" : mode === "OFF" ? "Off" : mode === "HEATCOOL" ? "Heat · Cool" : hvac === "HEATING" ? "Heating to" : hvac === "COOLING" ? "Cooling to" : mode === "HEAT" ? "Heat set to" : "Cool set to";
    const big = mode === "HEATCOOL" ? `${shown(sp.heatCelsius)}–${shown(sp.coolCelsius)}` : target != null ? shown(target) : "—";
    const label = { HEAT: "Heat", COOL: "Cool", HEATCOOL: "Heat·Cool", OFF: "Off" };
    box.innerHTML = `
      <div class="card glass">
        <div class="head-card"><div class="grow"><b>${esc(nameOf(t))}</b><div class="status-line"><span class="dot ${trait(t, "Connectivity").status === "OFFLINE" ? "bad" : "on"}"></span>${trait(t, "Connectivity").status === "OFFLINE" ? "Offline" : hvac === "OFF" ? "Idle" : hvac.toLowerCase().replace(/^\w/, (c) => c.toUpperCase())}</div></div></div>
        <div class="dial">${arc(frac)}<div class="mid"><div class="what">${what}</div><div class="set">${big}<small>°</small></div><div class="now">Inside ${shown(now)}°</div></div></div>
        <div class="steppers" ${target == null || eco ? "hidden" : ""}>
          <button class="stepper" data-step="-1" aria-label="Cooler">${svg("minus")}</button>
          <button class="stepper" data-step="1" aria-label="Warmer">${svg("plus")}</button>
        </div>
        <div class="seg3" style="--n:${modes.length}">${modes.map((m) => `<button data-mode="${m}" class="${m === mode ? "on" : ""}">${label[m] || m}</button>`).join("")}</div>
      </div>
      <button class="away-btn glass${eco ? " on" : ""}" data-away>${svg(eco ? "home" : "leaf")}<span><b>${eco ? "I'm home" : "I'm away"}</b><small>${eco ? "Away now: Eco is saving energy. Tap to go back to normal." : "Puts the thermostat in Eco while you're out."}</small></span></button>
      <div class="stats">
        <div class="stat glass"><b>${shown(now)}°</b><span>Inside</span></div>
        <div class="stat glass"><b>${hum != null ? Math.round(hum) + "%" : "—"}</b><span>Humidity</span></div>
        <button class="stat glass" data-eco><b>${eco ? "On" : "Off"}</b><span>Eco</span></button>
      </div>
      <div class="card glass" style="margin-top:12px" id="nestHist"></div>`;
    paintHistory();
    box.querySelectorAll("[data-step]").forEach((b) => (b.onclick = () => {
      buzz(6);
      const step = +b.dataset.step * (fahrenheit() ? 5 / 9 : 0.5);
      const v = Math.round((target + step) * 10) / 10;
      if (mode === "HEAT") sp.heatCelsius = v; else sp.coolCelsius = v;
      paintThermo();
      sendSetpoint(t, mode, v);
    }));
    box.querySelectorAll("[data-mode]").forEach((b) => (b.onclick = () => {
      buzz();
      const m = b.dataset.mode;
      setTrait(t, "ThermostatMode", { mode: m });
      setTrait(t, "ThermostatEco", { mode: "OFF" });
      paintThermo();
      command(t, "ThermostatMode.SetMode", { mode: m }, `Mode: ${label[m] || m}`);
    }));
    const toggleEco = (msgOn, msgOff) => {
      buzz();
      setTrait(t, "ThermostatEco", { mode: eco ? "OFF" : "MANUAL_ECO" });
      paintThermo();
      command(t, "ThermostatEco.SetMode", { mode: eco ? "OFF" : "MANUAL_ECO" }, eco ? msgOff : msgOn);
    };
    box.querySelector("[data-eco]").onclick = () => toggleEco("Eco on", "Eco off");
    box.querySelector("[data-away]").onclick = () => toggleEco("Away: Eco on", "Welcome home: Eco off");
  }
  function paintDoor() {
    const box = $("nestDoor");
    if (!tok?.refresh) { box.innerHTML = setupCard(); return; }
    const ds = doorbells();
    if (!ds.length) { box.innerHTML = `<div class="card glass empty"><div class="big">${svg("bell")}</div><b>${busy ? "Loading…" : "No doorbell shared"}</b><p>When you sign in, tick your doorbell on Google's page.</p></div>`; return; }
    box.innerHTML = ds.map((d) => {
      const live = trait(d, "CameraLiveStream").supportedProtocols || [];
      const kind = d.type.includes("DOORBELL") ? "Doorbell" : d.type.includes("DISPLAY") ? "Display" : "Camera";
      const webrtc = live.includes("WEB_RTC");
      return `<div class="card glass"><div class="head-card"><div class="ic dev" style="padding:0;width:auto">${svg(kind === "Doorbell" ? "bell" : "cam")}</div>
        <div class="grow"><b>${esc(nameOf(d))}</b><div class="status-line"><span class="dot on"></span>${kind}</div></div></div>
        ${webrtc ? `<button class="live-open" data-live="${esc(d.name)}">${svg("play")}<span><b>Watch live</b><small>Video and sound from the ${kind.toLowerCase()}</small></span></button>`
          : `<p class="note">This ${kind.toLowerCase()} only streams in a format phones can't play here (${esc(live.join(", ") || "none")}). Use the Google Home app for live view.</p>`}
        <p class="note">Ring and motion alerts need Google's cloud events (Pub/Sub), coming later.</p></div>`;
    }).join("");
  }
  /* Doorbell live view: WebRTC straight from Google (no extra servers). A stream lasts 5 minutes,
     so it's extended every 4 minutes while the sheet is open. */
  let live = null; // { pc, device, id, timer }
  async function watchLive(name) {
    const d = devices.find((x) => x.name === name);
    if (!d) return;
    buzz();
    const body = House.sheet(`<h3>${esc(nameOf(d))}</h3><div class="sub" id="liveState">Connecting…</div>
      <div class="live-box"><video id="liveVideo" autoplay playsinline muted></video><div class="live-wait" id="liveWait">Connecting to the doorbell…</div></div>
      <div class="grid2" style="margin-top:12px;margin-bottom:0"><button class="ghost center" id="liveSound">${svg("vol")} Sound on</button><button class="ghost center danger" id="liveStop">Stop</button></div>`);
    House.onSheetClose = stopLive;
    body.querySelector("#liveStop").onclick = () => House.closeSheet();
    body.querySelector("#liveSound").onclick = (e) => {
      const v = $("liveVideo");
      v.muted = !v.muted;
      e.currentTarget.innerHTML = `${svg(v.muted ? "vol" : "mute")} ${v.muted ? "Sound on" : "Sound off"}`;
    };
    try {
      const pc = new RTCPeerConnection();
      // Google wants audio, video and a data channel, in that order.
      pc.addTransceiver("audio", { direction: "recvonly" });
      pc.addTransceiver("video", { direction: "recvonly" });
      pc.createDataChannel("dataSendChannel");
      const stream = new MediaStream();
      pc.ontrack = (e) => {
        stream.addTrack(e.track);
        const v = $("liveVideo");
        if (v && v.srcObject !== stream) v.srcObject = stream;
      };
      pc.onconnectionstatechange = () => {
        const st = $("liveState");
        if (!st) return;
        if (pc.connectionState === "connected") { st.textContent = "Live"; $("liveWait").hidden = true; }
        if (pc.connectionState === "failed") { st.textContent = "Connection lost"; $("liveWait").textContent = "The stream stopped. Close and try again."; $("liveWait").hidden = false; }
      };
      live = { pc, device: d };
      await pc.setLocalDescription(await pc.createOffer());
      // No trickle: wait (briefly) for the network routes to be in the offer.
      await new Promise((res) => {
        if (pc.iceGatheringState === "complete") return res();
        const t = setTimeout(res, 2500);
        pc.onicegatheringstatechange = () => { if (pc.iceGatheringState === "complete") { clearTimeout(t); res(); } };
      });
      const r = await api(`${d.name}:executeCommand`, { command: "sdm.devices.commands.CameraLiveStream.GenerateWebRtcStream", params: { offerSdp: pc.localDescription.sdp } });
      if (live?.pc !== pc) { pc.close(); return; } // closed while waiting
      await pc.setRemoteDescription({ type: "answer", sdp: r.results.answerSdp });
      live.id = r.results.mediaSessionId;
      live.timer = setInterval(async () => {
        try {
          const x = await api(`${d.name}:executeCommand`, { command: "sdm.devices.commands.CameraLiveStream.ExtendWebRtcStream", params: { mediaSessionId: live.id } });
          live.id = x.results?.mediaSessionId || live.id;
        } catch {}
      }, 4 * 60e3);
    } catch (e) {
      const msg = /RTCPeerConnection|SessionDescription/.test(e.message || "") ? "The doorbell's video didn't start. Close and try again." : e.message || "Couldn't start the live view";
      if ($("liveWait")) { $("liveWait").textContent = msg; $("liveState").textContent = "Not connected"; }
      stopLive();
    }
  }
  function stopLive() {
    if (!live) return;
    const { pc, device, id, timer } = live;
    live = null;
    clearInterval(timer);
    pc.close();
    if (id) api(`${device.name}:executeCommand`, { command: "sdm.devices.commands.CameraLiveStream.StopWebRtcStream", params: { mediaSessionId: id } }).catch(() => {});
  }

  function setupCard() {
    return `<div class="card glass empty"><div class="big">${svg("thermo")}</div><b>Connect your Nest</b><p>Nest only works through Google's cloud. It's a one-time setup ($5 to Google).</p><button class="primary" data-goto-settings>Set up</button></div>`;
  }
  /* History: inside temperature and humidity, saved every ~15 min in the background */
  let history = [];
  let histRange = store.get("nest.range", "day");
  let watch = { settings: {} };
  function paintHistory() {
    const box = $("nestHist");
    if (!box) return;
    const span = histRange === "week" ? 7 * 864e5 : 864e5;
    const pts = history.filter((p) => p[0] >= Date.now() - span);
    const head = `<div class="row" style="justify-content:space-between"><b>History</b><div class="mini-seg" id="nestRange"><button data-range="day" class="${histRange === "day" ? "on" : ""}">Day</button><button data-range="week" class="${histRange === "week" ? "on" : ""}">Week</button></div></div>`;
    if (pts.length < 2) { box.innerHTML = head + `<p class="note">Readings are saved about every 15 minutes. The chart fills in over the next hours.</p>`; return; }
    const W = 320, H = 130, pad = 6;
    const t0 = Date.now() - span, x = (t) => pad + ((t - t0) / span) * (W - 2 * pad);
    const temps = pts.map((p) => +shown(p[1])), hums = pts.map((p) => p[2]).filter((h) => h != null);
    const tMin = Math.min(...temps) - 0.5, tMax = Math.max(...temps) + 0.5;
    const yT = (v) => H - pad - ((v - tMin) / (tMax - tMin || 1)) * (H - 2 * pad);
    const yH = (v) => H - pad - (v / 100) * (H - 2 * pad);
    const line = (vals, y) => vals.map(([t, v], i) => `${i ? "L" : "M"}${x(t).toFixed(1)},${y(v).toFixed(1)}`).join("");
    const tPath = line(pts.map((p) => [p[0], +shown(p[1])]), yT);
    const hPath = line(pts.filter((p) => p[2] != null).map((p) => [p[0], p[2]]), yH);
    const last = pts[pts.length - 1];
    const labels = histRange === "week" ? [6, 4, 2, 0].map((d) => [Date.now() - d * 864e5, new Date(Date.now() - d * 864e5).toLocaleDateString([], { weekday: "short" })])
      : [24, 18, 12, 6, 0].map((h) => [Date.now() - h * 36e5, h ? `-${h}h` : "now"]);
    box.innerHTML = head + `
      <svg viewBox="0 0 ${W} ${H + 16}" style="width:100%;height:auto;margin-top:10px" role="img" aria-label="Temperature and humidity history">
        <path d="${hPath}" fill="none" stroke="var(--a3)" stroke-width="1.6" stroke-dasharray="4 3" opacity=".8"/>
        <path d="${tPath}" fill="none" stroke="var(--a1)" stroke-width="2.4" stroke-linejoin="round"/>
        ${labels.map(([t, l]) => `<text x="${x(t).toFixed(1)}" y="${H + 13}" font-size="10" fill="var(--muted)" text-anchor="middle">${l}</text>`).join("")}
      </svg>
      <div class="row small" style="gap:16px;margin-top:6px">
        <span><span class="dot" style="background:var(--a1)"></span> Temperature ${shown(Math.min(...pts.map((p) => p[1])))}–${shown(Math.max(...pts.map((p) => p[1])))}° (now ${shown(last[1])}°)</span>
      </div>
      ${hums.length ? `<div class="row small muted"><span><span class="dot" style="background:var(--a3)"></span> Humidity ${Math.round(Math.min(...hums))}–${Math.round(Math.max(...hums))}% (now ${last[2] != null ? Math.round(last[2]) : "—"}%)</span></div>` : ""}`;
    box.querySelector("#nestRange").onclick = (e) => { const b = e.target.closest("[data-range]"); if (b) { histRange = b.dataset.range; store.set("nest.range", histRange); paintHistory(); } };
  }

  /* Alerts (run in the background, see NestWatch) */
  function paintAlerts() {
    const s = watch.settings || {};
    $("nestHumOn").classList.toggle("on", !!s.humOn);
    $("nestHumLow").value = s.humLow ?? 30;
    $("nestHumHigh").value = s.humHigh ?? 60;
    $("nestRingOn").classList.toggle("on", !!s.ring);
    $("nestMotionOn").classList.toggle("on", !!s.motion);
    $("nestSub").value = store.get("nest.sub", "");
    $("nestNotif").hidden = !(s.ring || s.motion || s.humOn) || watch.notifications;
  }
  async function saveAlerts(msg) {
    try { watch = await Net.setNestWatch({ settings: watch.settings }); if (msg) toast(msg); }
    catch { toast("Couldn't save that", true); }
    paintAlerts();
  }

  function paint() {
    paintThermo();
    paintDoor();
    const c = cfg();
    $("nestProject").value = c.project;
    $("nestClient").value = c.clientId;
    $("nestSecret").value = c.secret;
    $("nestSigned").hidden = !tok?.refresh;
    $("nestSignIn").textContent = tok?.refresh ? "Sign in again" : "Sign in with Google";
    $("nestUnit").querySelectorAll("button").forEach((b) => b.classList.toggle("on", b.dataset.unit === store.get("nest.unit", "C")));
  }

  function saveCfg() {
    const c = { project: $("nestProject").value.trim(), clientId: $("nestClient").value.trim(), secret: $("nestSecret").value.trim() };
    store.setJson("nest.cfg", c);
    return c;
  }
  async function exchange(input) {
    const c = cfg();
    let code = input.trim();
    try { code = new URL(code).searchParams.get("code") || code; } catch {}
    const r = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id: c.clientId, client_secret: c.secret, code, grant_type: "authorization_code", redirect_uri: REDIRECT }).toString(),
    });
    const j = await r.json();
    if (!j.refresh_token) throw new Error(j.error_description || j.error || "Google didn't accept that code. Sign in again.");
    tok = { access: j.access_token, refresh: j.refresh_token, exp: Date.now() + (j.expires_in || 3600) * 1000 };
    store.setJson("nest.tok", tok);
  }

  House.side({
    id: "nest", name: "Nest", icon: "thermo", blurb: "Thermostat and doorbell (Google)",
    tabs: [
      { id: "thermo", label: "Thermostat", icon: "thermo", html: `<div class="row" style="justify-content:flex-end;margin-bottom:8px"><button class="round-btn glass" id="nestRefresh" aria-label="Refresh">${svg("refresh")}</button></div><div id="nestThermo"></div>` },
      { id: "door", label: "Doorbell", icon: "bell", html: `<div id="nestDoor"></div>` },
      { id: "settings", label: "Settings", icon: "gear" },
    ],
    settingsHtml: `
      <div class="label">Nest · one-time setup</div>
      <div class="card glass">
        <ol class="steps">
          <li>Sign up for <a data-open href="https://console.nest.google.com/device-access">Device Access</a> (Google charges $5 once).</li>
          <li>In <a data-open href="https://console.cloud.google.com/apis/credentials">Google Cloud</a>: create a project, turn on <b>Smart Device Management API</b>, and make an <b>OAuth client ID</b> (Web application) with redirect <b>https://www.google.com</b>.</li>
          <li>Back in Device Access, create a project with that client ID. Copy the <b>Project ID</b>.</li>
          <li>Paste the three values below and tap Sign in with Google. Tick your thermostat and doorbell.</li>
          <li>Google then opens google.com: copy that page's whole address and paste it here.</li>
        </ol>
        <label class="fld">Device Access project ID<input class="field" id="nestProject" autocomplete="off" placeholder="abcd1234-…"></label>
        <label class="fld">OAuth client ID<input class="field" id="nestClient" autocomplete="off" placeholder="…apps.googleusercontent.com"></label>
        <label class="fld">OAuth client secret<input class="field" id="nestSecret" type="password" autocomplete="off"></label>
        <div class="list"><button class="primary full" id="nestSignIn">Sign in with Google</button></div>
        <label class="fld">Address after signing in<input class="field" id="nestCode" autocomplete="off" placeholder="https://www.google.com/?code=…"></label>
        <div class="list"><button class="ghost center" id="nestFinish">Finish sign-in</button></div>
        <div id="nestSigned" hidden><p class="note">${svg("check", 'style="width:16px;height:16px;vertical-align:-3px;color:var(--good)"')} Signed in. Your keys stay on this phone.</p><div class="list"><button class="ghost center danger" id="nestOut">Sign out</button></div></div>
      </div>
      <div class="label">Humidity alert</div>
      <div class="card glass">
        <div class="set-row"><div class="set-text"><b>Tell me when it's too dry or humid</b><span>Checked about every 15 min.</span></div><button class="tgl" id="nestHumOn" aria-label="Humidity alert"><i></i></button></div>
        <div class="row" style="margin-top:10px">
          <label class="fld grow" style="margin-top:0">Below %<input class="field" id="nestHumLow" type="number" min="10" max="60" inputmode="numeric"></label>
          <label class="fld grow" style="margin-top:0">Above %<input class="field" id="nestHumHigh" type="number" min="40" max="90" inputmode="numeric"></label>
        </div>
      </div>
      <div class="label">Doorbell alerts</div>
      <div class="card glass">
        <div class="set-row"><div class="set-text"><b>Doorbell rings</b><span>A notification when someone rings.</span></div><button class="tgl" id="nestRingOn" aria-label="Ring alerts"><i></i></button></div>
        <div class="set-row"><div class="set-text"><b>Person and motion</b><span>When the doorbell sees someone or motion.</span></div><button class="tgl" id="nestMotionOn" aria-label="Motion alerts"><i></i></button></div>
        <p class="note">Google sends doorbell events to a Pub/Sub topic in your Google Cloud project; the app reads it about every 2 minutes. One-time setup:</p>
        <ol class="steps">
          <li>In <a data-open href="https://console.cloud.google.com/apis/library/pubsub.googleapis.com">Google Cloud</a>, turn on the <b>Cloud Pub/Sub API</b>.</li>
          <li><a data-open href="https://console.cloud.google.com/cloudpubsub/topic/list">Pub/Sub → Topics</a> → <b>Create topic</b>, name it <b>nest-events</b>, keep “Add a default subscription” ticked.</li>
          <li>Open the topic → <b>Permissions</b> (Show info panel) → <b>Add principal</b> <b>sdm-publisher@googlegroups.com</b> with role <b>Pub/Sub Publisher</b>.</li>
          <li>In <a data-open href="https://console.nest.google.com/device-access">Device Access</a>, open your project → <b>Pub/Sub topic</b> → paste <b>projects/YOUR-CLOUD-PROJECT/topics/nest-events</b> and turn events on.</li>
          <li>Paste the subscription name below (Pub/Sub → Subscriptions, looks like <b>projects/…/subscriptions/nest-events-sub</b>), then tap <b>Sign in again</b> above so House may read it.</li>
        </ol>
        <label class="fld">Subscription<input class="field" id="nestSub" autocomplete="off" placeholder="projects/devicesnestdoorbell/subscriptions/nest-events-sub"></label>
        <div class="list"><button class="ghost center" id="nestSubTest">Save and test</button></div>
        <p class="note err" id="nestNotif" hidden>Notifications are off for House: turn them on in your phone's Settings → Apps → House.</p>
      </div>
      <div id="autoDoor"></div>
      <div class="label">Units</div>
      <div class="card glass"><div class="seg3" id="nestUnit" style="--n:2"><button data-unit="C">°C</button><button data-unit="F">°F</button></div></div>`,
    guide: [
      ["thermo", "Thermostat", "The dial shows what it's set to and the temperature inside. − and + change it; the buttons below switch Heat, Cool, Heat·Cool or Off. Eco saves energy while you're away."],
      ["bell", "Doorbell", "Watch live from the Doorbell tab. With doorbell events set up (Settings), rings and people at the door send a notification."],
      ["bulb", "Doorbell lights", "Settings → Doorbell lights: after dark, a ring or a person at the door turns on the lights you pick for a few minutes."],
      ["key", "Setting up", "Nest only talks to Google's cloud, so you make your own Device Access project once (Settings walks you through it, $5 to Google). Your sign-in stays on this phone."],
    ],
    mount() {
      document.addEventListener("click", (e) => { if (e.target.closest("[data-goto-settings]") && House.current === "nest") House.showTab("settings"); });
      $("nestDoor").addEventListener("click", (e) => { const b = e.target.closest("[data-live]"); if (b) watchLive(b.dataset.live); });
      $("nestRefresh").onclick = () => { buzz(6); load(true); };
      $("nestSignIn").onclick = () => {
        const c = saveCfg();
        if (!c.project || !c.clientId || !c.secret) { toast("Fill in all three first", true); return; }
        const url = `https://nestservices.google.com/partnerconnections/${encodeURIComponent(c.project)}/auth?` + new URLSearchParams({
          redirect_uri: REDIRECT, access_type: "offline", prompt: "consent", client_id: c.clientId, response_type: "code",
          scope: "https://www.googleapis.com/auth/sdm.service https://www.googleapis.com/auth/pubsub",
        });
        openLink(url);
      };
      $("nestFinish").onclick = async () => {
        saveCfg();
        const v = $("nestCode").value;
        if (!v.trim()) { toast("Paste the address from google.com first", true); return; }
        try { await exchange(v); $("nestCode").value = ""; toast("Nest connected"); await load(true); House.showTab("thermo"); }
        catch (e) { toast(e.message, true); }
      };
      $("nestOut").onclick = () => { if (!confirm("Sign out of Nest on this phone?")) return; tok = null; devices = []; store.set("nest.tok", null); paint(); };
      $("nestUnit").onclick = (e) => { const b = e.target.closest("[data-unit]"); if (b) { store.set("nest.unit", b.dataset.unit); paint(); } };
      const flip = (key, on, off) => { buzz(); watch.settings = { ...watch.settings, [key]: !watch.settings?.[key] }; saveAlerts(watch.settings[key] ? on : off); };
      $("nestHumOn").onclick = () => flip("humOn", "Humidity alert on", "Humidity alert off");
      $("nestRingOn").onclick = () => { if (!store.get("nest.sub")) { toast("Set up the subscription below first", true); return; } flip("ring", "Ring alerts on", "Ring alerts off"); };
      $("nestMotionOn").onclick = () => { if (!store.get("nest.sub")) { toast("Set up the subscription below first", true); return; } flip("motion", "Person and motion alerts on", "Person and motion alerts off"); };
      const limits = () => {
        const low = Math.max(10, Math.min(60, +$("nestHumLow").value || 30)), high = Math.max(low + 5, Math.min(90, +$("nestHumHigh").value || 60));
        watch.settings = { ...watch.settings, humLow: low, humHigh: high };
        saveAlerts(`Alert below ${low}% or above ${high}%`);
      };
      $("nestHumLow").onchange = limits;
      $("nestHumHigh").onchange = limits;
      $("nestSubTest").onclick = async () => {
        const sub = $("nestSub").value.trim();
        if (!/^projects\/[^/]+\/subscriptions\/[^/]+$/.test(sub)) { toast("It should look like projects/…/subscriptions/…", true); return; }
        store.set("nest.sub", sub);
        await new Promise((r) => setTimeout(r, 600)); // let the subscription reach the background side
        try {
          const r = await Net.nestTestEvents();
          toast(r.events ? `Works: ${r.events} event${r.events === 1 ? "" : "s"} were waiting` : "Works: no events waiting right now. Ring the doorbell to try it.");
        } catch (e) {
          toast(/permission|scope|insufficient/i.test(e.message) ? "Google says House may not read it yet: tap Sign in again above" : e.message, true);
        }
      };
      Net.getNestWatch().then((w) => { watch = w; history = w.history || []; paintAlerts(); paintHistory(); }).catch(() => {});
      paint();
    },
    onShow(tab) {
      if (tab !== "settings") load(); else { paint(); paintAlerts(); }
      if (tab === "thermo" && tok?.refresh) Net.nestTick().then((w) => { history = w.history || []; paintHistory(); }).catch(() => {});
    },
  });
})();
