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
      </div>`;
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
      <div class="label">Units</div>
      <div class="card glass"><div class="seg3" id="nestUnit" style="--n:2"><button data-unit="C">°C</button><button data-unit="F">°F</button></div></div>`,
    guide: [
      ["thermo", "Thermostat", "The dial shows what it's set to and the temperature inside. − and + change it; the buttons below switch Heat, Cool, Heat·Cool or Off. Eco saves energy while you're away."],
      ["bell", "Doorbell", "Shows your doorbell once it's shared. Live view and ring alerts come later."],
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
          scope: "https://www.googleapis.com/auth/sdm.service",
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
      paint();
    },
    onShow(tab) { if (tab !== "settings") load(); else paint(); },
  });
})();
