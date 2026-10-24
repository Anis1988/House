// 📷 Cameras: Wyze cameras through Wyze's (unofficial) app API. Cloud only.
// You type your Wyze email, password and API key into the app yourself; they stay on this phone.
// Shows each camera's latest snapshot, online state, and turns cameras on/off.

(() => {
  const AUTH = "https://auth-prod.api.wyze.com/api/user/login";
  const APP = "https://api.wyzecam.com/app";
  const APP_VER = "2.50.6.9";
  // Per-endpoint keys the Wyze app sends (from the open-source Wyze clients).
  const SC_SV = {
    default: { sc: "9f275790cab94a72bd206c8876429f3c", sv: "e1fe392906d54888a9b99b88de4162d7" },
    run_action: { sc: "01dd431d098546f9baf5233724fa2ee2", sv: "2c0edc06d4c5465b8c55af207144f0d9" },
    events: { sc: "9f275790cab94a72bd206c8876429f3c", sv: "782ced6909a44d92a1f70d582bbe88be" },
  };
  let acct = store.json("wyze.acct", null); // { access, refresh, email }
  let cams = [];
  let events = [];     // recent motion/sound events, newest first
  let loadingEvents = false;
  let busy = false;
  let mfa = null; // pending two-step sign-in
  const phoneId = store.get("wyze.phone") || (() => { const id = crypto.randomUUID?.() || String(Math.random()).slice(2); store.set("wyze.phone", id); return id; })();

  const base = (kind = "default") => ({
    ...SC_SV[kind], ts: Date.now(), phone_id: phoneId, access_token: acct?.access || "",
    app_name: "com.hualai.WyzeCam", app_version: APP_VER, app_ver: `com.hualai.WyzeCam___${APP_VER}`, phone_system_type: 1,
  });
  async function post(url, body, kind) {
    const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json", "User-Agent": `wyze_android_${APP_VER}` }, body: JSON.stringify({ ...base(kind), ...body }) });
    return r.json();
  }
  async function call(path, body = {}, kind) {
    let j = await post(`${APP}${path}`, body, kind);
    // 2001 = access token expired: refresh once and retry.
    if (String(j.code) === "2001" && acct?.refresh) {
      const r = await post(`${APP}/user/refresh_token`, { refresh_token: acct.refresh });
      if (r.data?.access_token) { acct = { ...acct, access: r.data.access_token, refresh: r.data.refresh_token || acct.refresh }; store.setJson("wyze.acct", acct); j = await post(`${APP}${path}`, body, kind); }
    }
    if (String(j.code) !== "1") throw new Error(String(j.code) === "2001" ? "Wyze sign-in expired. Sign in again." : j.msg || `Wyze error ${j.code}`);
    return j.data;
  }

  async function signIn() {
    const email = $("wyEmail").value.trim(), pw = $("wyPass").value, keyId = $("wyKeyId").value.trim(), apiKey = $("wyApiKey").value.trim();
    if (!email || !pw || !keyId || !apiKey) { toast("Fill in all four first", true); return; }
    store.setJson("wyze.keys", { keyId, apiKey, email });
    const { hash } = await Net.md5({ text: pw, times: 3 });
    const headers = { "Content-Type": "application/json", keyid: keyId, apikey: apiKey, "User-Agent": `wyze_android_${APP_VER}` };
    const body = { email, password: hash };
    if (mfa) Object.assign(body, mfa.extra, { verification_code: $("wyCode").value.trim() });
    $("wySignIn").disabled = true;
    try {
      const r = await fetch(AUTH, { method: "POST", headers, body: JSON.stringify(body) });
      const j = await r.json();
      if (j.access_token) {
        acct = { access: j.access_token, refresh: j.refresh_token, email };
        store.setJson("wyze.acct", acct);
        mfa = null;
        $("wyPass").value = "";
        $("wyCode").value = "";
        toast("Wyze connected");
        await load(true);
        House.showTab("cams");
      } else if (j.mfa_options?.includes("TotpVerificationCode")) {
        mfa = { extra: { mfa_type: "TotpVerificationCode", verification_id: j.mfa_details?.totp_apps?.[0]?.app_id } };
        toast("Type the 6-digit code from your authenticator app");
      } else if (j.mfa_options?.includes("PrimaryPhone")) {
        // Ask Wyze to text a code, then the same login with it.
        await fetch(`https://auth-prod.api.wyze.com/user/login/sendSmsCode?mfaPhoneType=Primary&sessionId=${encodeURIComponent(j.sms_session_id)}&userId=${encodeURIComponent(j.user_id)}`, { method: "POST", headers });
        mfa = { extra: { mfa_type: "PrimaryPhone", verification_id: j.sms_session_id } };
        toast("Wyze texted you a code. Type it below.");
      } else {
        toast(j.description || j.msg || "Wyze didn't accept that. Check the email, password and keys.", true);
      }
    } catch { toast("Couldn't reach Wyze", true); }
    $("wySignIn").disabled = false;
    paint();
  }

  async function load(manual) {
    if (!acct || busy) { paint(); return; }
    busy = true;
    $("wyRefresh")?.classList.add("spin");
    try {
      const data = await call("/v2/home_page/get_object_list");
      cams = (data.device_list || []).filter((d) => d.product_type === "Camera").map((d) => ({
        mac: d.mac, model: d.product_model, name: d.nickname, ip: d.device_params?.ip,
        online: d.conn_state === 1, on: d.device_params?.power_switch !== 0,
        thumb: d.device_params?.camera_thumbnails?.thumbnails_url || "", thumbAt: d.device_params?.camera_thumbnails?.thumbnails_ts,
      }));
      store.setJson("wyze.cams", cams.map((c) => ({ mac: c.mac, model: c.model, name: c.name })));
      if (manual) toast(`${cams.length} camera${cams.length === 1 ? "" : "s"}`);
    } catch (e) { toast(e.message, true); }
    busy = false;
    $("wyRefresh")?.classList.remove("spin");
    paint();
  }

  async function power(cam, on) {
    buzz(14);
    cam.on = on;
    paint();
    try {
      await call("/v2/auto/run_action", { provider_key: cam.model, instance_id: cam.mac, action_key: on ? "power_on" : "power_off", action_params: {}, custom_string: "" }, "run_action");
      toast(`${cam.name} ${on ? "on" : "off"}`);
    } catch (e) { cam.on = !on; paint(); toast(e.message, true); }
  }

  /* Recent events (motion, sound, person…) with their snapshot, from the last two days */
  const TAGS = { 101: "Person", 102: "Vehicle", 103: "Pet", 104: "Package", 105: "Baby crying", 106: "Dog barking", 107: "Cat meowing" };
  const KIND = { 1: "Motion", 2: "Sound", 4: "Smoke alarm", 5: "CO alarm", 13: "Motion", 10: "Doorbell" };
  async function loadEvents(manual) {
    if (!acct || loadingEvents) { paintEvents(); return; }
    if (!cams.length) await load();
    loadingEvents = true;
    $("wyEvRefresh").classList.add("spin");
    paintEvents();
    try {
      const data = await call("/v2/device/get_event_list", {
        device_mac_list: cams.map((c) => c.mac), event_value_list: [], event_tag_list: [], event_type: "",
        begin_time: Date.now() - 2 * 864e5, end_time: Date.now(), count: 40, order_by: 2,
      }, "events");
      events = (data.event_list || []).map((e) => ({
        id: e.event_id, mac: e.device_mac, at: +e.event_ts,
        what: (e.tag_list || []).map((t) => TAGS[t]).filter(Boolean)[0] || KIND[+e.event_value] || "Event",
        img: (e.file_list || []).find((f) => +f.type === 1)?.url || "",
        video: (e.file_list || []).find((f) => +f.type === 2)?.url || "",
      })).sort((a, b) => b.at - a.at);
      if (manual) toast(events.length ? `${events.length} events in the last two days` : "No events in the last two days");
    } catch (e) { toast(e.message, true); }
    loadingEvents = false;
    $("wyEvRefresh").classList.remove("spin");
    paintEvents();
  }
  function paintEvents() {
    const box = $("wyEvents");
    if (!acct) { box.innerHTML = `<div class="card glass"><p class="note" style="margin:0">Sign in to Wyze in Settings to see events.</p></div>`; return; }
    if (!events.length) { box.innerHTML = `<div class="card glass"><p class="note" style="margin:0">${loadingEvents ? "Loading events…" : "No events in the last two days."}</p></div>`; return; }
    const name = (mac) => cams.find((c) => c.mac === mac)?.name || mac;
    box.innerHTML = events.map((e, i) => `
      <button class="event glass" data-ev="${i}">
        <span class="th">${e.img ? `<img alt="" loading="lazy" src="${esc(e.img)}">` : svg("cam")}</span>
        <span class="t"><b>${esc(e.what)} · ${esc(name(e.mac))}${e.video ? " ▶" : ""}</b><span>${new Date(e.at).toLocaleString([], { weekday: "short", hour: "numeric", minute: "2-digit" })} · ${ago(e.at)}</span></span>
      </button>`).join("");
  }

  /* One camera, full screen: its latest picture, Refresh, and Live view (beta). */
  function openCam(mac) {
    const c = cams.find((x) => x.mac === mac);
    if (!c) return;
    buzz(6);
    const body = House.sheet(`<h3>${esc(c.name)}</h3><div class="sub" id="camSub">${!c.online ? "Offline" : c.on ? "Latest picture" : "Camera is off"}${c.thumbAt ? ` · ${ago(c.thumbAt)}` : ""}</div>
      <div class="live-box" id="camBox">${c.thumb ? `<img id="camImg" alt="" src="${esc(c.thumb)}">` : `<div class="live-wait">No picture yet</div>`}</div>
      <div class="grid2" style="margin-top:12px;margin-bottom:0">
        <button class="ghost center" id="camRefresh">${svg("refresh")} Refresh</button>
        <button class="primary" id="camLive" ${c.online && c.on ? "" : "disabled"}>${svg("play", 'style="width:18px;height:18px;vertical-align:-4px"')} Live (beta)</button>
      </div>
      <p class="note" id="camNote">Refresh shows the newest picture Wyze has. Live uses the same stream as the Wyze Web Portal.</p>`);
    House.onSheetClose = stopCamLive;
    body.querySelector("#camRefresh").onclick = async () => {
      buzz();
      stopCamLive();
      await load();
      const n = cams.find((x) => x.mac === mac);
      if (!n || !$("camBox")) return;
      $("camBox").innerHTML = n.thumb ? `<img id="camImg" alt="" src="${esc(n.thumb)}${n.thumb.includes("?") ? "&" : "?"}t=${Date.now()}">` : `<div class="live-wait">No picture yet</div>`;
      $("camSub").textContent = `Latest picture${n.thumbAt ? ` · ${ago(n.thumbAt)}` : ""}`;
    };
    body.querySelector("#camLive").onclick = () => startCamLive(c);
  }

  /*
   * Live view (beta): Wyze streams through Amazon Kinesis Video WebRTC. Wyze's API hands out a
   * signed signalling address for a camera (what the Wyze Web Portal uses); the phone then talks
   * WebRTC with the camera directly. Not documented by Wyze, so it may stop working.
   */
  let camLive = null; // { pc, ws }
  async function startCamLive(c) {
    buzz();
    stopCamLive();
    $("camBox").innerHTML = `<video id="camVideo" autoplay playsinline muted></video><div class="live-wait" id="camWait">Connecting to the camera…</div>`;
    $("camSub").textContent = "Connecting…";
    $("camLive").outerHTML = `<button class="ghost center" id="camSound">${svg("vol")} Sound on</button>`;
    $("camSound").onclick = (e) => {
      const v = $("camVideo");
      if (!v) return;
      v.muted = !v.muted;
      e.currentTarget.innerHTML = `${svg(v.muted ? "vol" : "mute")} ${v.muted ? "Sound on" : "Sound off"}`;
    };
    const fail = (msg) => {
      if ($("camWait")) { $("camWait").textContent = msg; $("camWait").hidden = false; }
      if ($("camSub")) $("camSub").textContent = "Not connected";
      stopCamLive();
    };
    try {
      const get = () => fetch(`https://webrtc.api.wyze.com/signaling/device/${encodeURIComponent(c.mac)}?use_trickle=true`, {
        // Same headers as the Wyze iOS app (what docker-wyze-bridge sends for this endpoint).
        headers: { authorization: `Bearer ${acct.access}`, "content-type": "application/json", "User-Agent": "Wyze/3.1.6.1 (iPhone; iOS 17.1.1; Scale/3.00)", appversion: "3.1.6.1", env: "prod" },
      }).then((r) => r.json());
      let j = await get();
      if (String(j.code) === "2001" && acct.refresh) { await call("/v2/home_page/get_object_list"); j = await get(); } // refreshes the token
      const res = (j.data || j).results || {};
      if (!res.signalingUrl) {
        const code = j.code ?? j.errorCode ?? j.status ?? "";
        const why = j.msg || j.description || j.error || "";
        return fail(`Wyze didn't start a live stream for this camera${code !== "" ? ` (Wyze said: ${code}${why ? " " + why : ""})` : ""}. Check it plays in the Wyze Web Portal.`);
      }
      const servers = (res.servers || []).map((x) => ({ urls: x.urls || x.url, username: x.username, credential: x.credential }));
      const pc = new RTCPeerConnection({ iceServers: servers });
      const ws = new WebSocket(decodeURIComponent(res.signalingUrl));
      camLive = { pc, ws };
      pc.addTransceiver("video", { direction: "recvonly" });
      pc.addTransceiver("audio", { direction: "recvonly" });
      const stream = new MediaStream();
      pc.ontrack = (e) => { stream.addTrack(e.track); const v = $("camVideo"); if (v && v.srcObject !== stream) v.srcObject = stream; };
      pc.onconnectionstatechange = () => {
        if (pc.connectionState === "connected") { if ($("camWait")) $("camWait").hidden = true; if ($("camSub")) $("camSub").textContent = "Live"; }
        if (pc.connectionState === "failed") fail("The stream stopped. Close and try again.");
      };
      const b64 = (o) => btoa(JSON.stringify(o));
      const send = (action, payload) => ws.send(JSON.stringify({ action, messagePayload: b64(payload), recipientClientId: phoneId }));
      pc.onicecandidate = (e) => { if (e.candidate && ws.readyState === 1) send("ICE_CANDIDATE", e.candidate.toJSON()); };
      ws.onmessage = async (m) => {
        let msg; try { msg = JSON.parse(m.data); } catch { return; }
        if (!msg.messagePayload) return;
        const payload = JSON.parse(atob(msg.messagePayload));
        if (msg.messageType === "SDP_ANSWER") await pc.setRemoteDescription(payload);
        else if (msg.messageType === "ICE_CANDIDATE") await pc.addIceCandidate(payload).catch(() => {});
      };
      ws.onerror = () => fail("Couldn't reach Wyze's live stream.");
      ws.onopen = async () => {
        await pc.setLocalDescription(await pc.createOffer());
        send("SDP_OFFER", { type: "offer", sdp: pc.localDescription.sdp });
      };
      setTimeout(() => { if (camLive?.pc === pc && pc.connectionState !== "connected") fail("No video from the camera. Check it plays in the Wyze Web Portal (it may need Cam Plus)."); }, 25000);
    } catch (e) { fail(e.message || "Couldn't start the live view"); }
  }
  function stopCamLive() {
    if (!camLive) return;
    try { camLive.ws.close(); } catch {}
    try { camLive.pc.close(); } catch {}
    camLive = null;
  }

  const ago = (ts) => { if (!ts) return ""; const m = Math.round((Date.now() - ts) / 60000); return m < 1 ? "just now" : m < 60 ? `${m} min ago` : m < 1440 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} d ago`; };
  function paint() {
    const box = $("wyCams");
    if (!acct) {
      box.innerHTML = `<div class="card glass empty"><div class="big">${svg("cam")}</div><b>Connect your Wyze account</b><p>Wyze cameras only work through Wyze's cloud. You sign in once in Settings.</p><button class="primary" data-wy-settings>Set up</button></div>`;
    } else if (!cams.length) {
      box.innerHTML = `<div class="card glass empty"><div class="big">${svg("cam")}</div><b>${busy ? "Loading cameras…" : "No cameras found"}</b><p>${busy ? "" : "Tap refresh to try again."}</p></div>`;
    } else {
      box.innerHTML = cams.map((c) => `
        <div class="cam glass">
          <div class="shot ${c.on && c.online ? "" : "off"}" data-open-cam="${esc(c.mac)}" role="button" aria-label="Open ${esc(c.name)}">
            ${c.thumb ? `<img alt="" src="${esc(c.thumb)}" loading="lazy">` : svg("cam", 'style="width:44px;height:44px"')}
            <span class="badge"><span class="dot ${c.online ? (c.on ? "on" : "") : "bad"}"></span>${!c.online ? "Offline" : c.on ? "On" : "Off"}${c.thumbAt ? ` · ${ago(c.thumbAt)}` : ""}</span>
            ${c.online && c.on ? `<span class="live-chip">${svg("play")} Live</span>` : ""}
          </div>
          <div class="bar"><div class="grow"><b>${esc(c.name)}</b><span class="muted small">${esc(c.model)}${c.ip ? ` · ${esc(c.ip)}` : ""}</span></div>
            <button class="tgl${c.on ? " on" : ""}" data-cam="${esc(c.mac)}" aria-label="${esc(c.name)} on or off" ${c.online ? "" : "disabled"}><i></i></button></div>
        </div>`).join("");
    }
    const k = store.json("wyze.keys", {});
    if (!$("wyEmail").value) $("wyEmail").value = k.email || "";
    if (!$("wyKeyId").value) $("wyKeyId").value = k.keyId || "";
    if (!$("wyApiKey").value) $("wyApiKey").value = k.apiKey || "";
    $("wyCodeRow").hidden = !mfa;
    $("wySignedIn").hidden = !acct;
    $("wySignedText").textContent = acct ? `Signed in as ${acct.email}` : "";
  }

  House.side({
    id: "cams", name: "Wyze cameras", short: "Cameras", icon: "cam", blurb: "Snapshots and on/off (Wyze)",
    tabs: [
      { id: "cams", label: "Cameras", icon: "cam", html: `<div class="row" style="justify-content:flex-end;margin-bottom:8px"><button class="round-btn glass" id="wyRefresh" aria-label="Refresh">${svg("refresh")}</button></div><div class="cams" id="wyCams"></div>` },
      { id: "events", label: "Events", icon: "bell", html: `<div class="row" style="justify-content:space-between;margin-bottom:8px"><div class="label" style="margin:0 0 0 4px">Last two days</div><button class="round-btn glass" id="wyEvRefresh" aria-label="Refresh">${svg("refresh")}</button></div><div class="events" id="wyEvents"></div>` },
      { id: "settings", label: "Settings", icon: "gear" },
    ],
    settingsHtml: `
      <div class="label">Wyze account</div>
      <div class="card glass">
        <ol class="steps">
          <li>Make an API key at the <a data-open href="https://developer-api-console.wyze.com/">Wyze developer console</a> (sign in with your Wyze account). You get a <b>Key ID</b> and an <b>API key</b>.</li>
          <li>Type them below with your Wyze email and password.</li>
        </ol>
        <p class="note"><b>Sign in to Wyze with Google?</b> Your account has no Wyze password yet. In the Wyze app, tap <b>Forgot password</b> on the sign-in screen and enter your Google email to set one; Google sign-in keeps working. If that doesn't work, make a second Wyze account with a password and share your cameras to it (camera → Settings → Device sharing).</p>
        <label class="fld">Wyze email<input class="field" id="wyEmail" type="email" autocomplete="username"></label>
        <label class="fld">Wyze password<input class="field" id="wyPass" type="password" autocomplete="current-password"></label>
        <label class="fld">Key ID<input class="field" id="wyKeyId" autocomplete="off"></label>
        <label class="fld">API key<input class="field" id="wyApiKey" type="password" autocomplete="off"></label>
        <label class="fld" id="wyCodeRow" hidden>Verification code<input class="field" id="wyCode" inputmode="numeric" autocomplete="one-time-code"></label>
        <div class="list"><button class="primary full" id="wySignIn">Sign in to Wyze</button></div>
        <div id="wySignedIn" hidden><p class="note" id="wySignedText"></p><div class="list"><button class="ghost center danger" id="wyOut">Sign out</button></div></div>
        <p class="note">Your password is only used to sign in, then forgotten. The sign-in stays on this phone.</p>
      </div>`,
    guide: [
      ["cam", "Cameras", "Each camera shows its latest snapshot, whether it's online, and a switch to turn it on or off (privacy mode)."],
      ["key", "Setting up", "Wyze needs your account and a free API key from Wyze's developer console. Settings shows where to get it."],
      ["bell", "Events", "The Events tab lists motion, sound and person alerts from the last two days with their snapshot. Tap one to see it bigger."],
      ["clock", "Live video", "Live video isn't possible here yet; use the Wyze app for that."],
    ],
    mount() {
      document.addEventListener("click", (e) => { if (e.target.closest("[data-wy-settings]")) House.showTab("settings"); });
      $("wyRefresh").onclick = () => { buzz(6); load(true); };
      $("wyEvRefresh").onclick = () => { buzz(6); loadEvents(true); };
      $("wyEvents").addEventListener("click", (e) => {
        const b = e.target.closest("[data-ev]");
        if (!b) return;
        const ev = events[+b.dataset.ev];
        const cam = cams.find((c) => c.mac === ev.mac);
        House.sheet(`<h3>${esc(ev.what)}</h3><div class="sub">${esc(cam?.name || ev.mac)} · ${new Date(ev.at).toLocaleString()}</div>${ev.video ? `<video class="shot-full" controls autoplay playsinline ${ev.img ? `poster="${esc(ev.img)}"` : ""} src="${esc(ev.video)}"></video>` : ev.img ? `<img class="shot-full" alt="" src="${esc(ev.img)}"><p class="note">Wyze didn't keep a video clip for this event (clips need Cam Plus or a recording).</p>` : `<p class="note">No picture or clip for this event.</p>`}`);
      });
      $("wyCams").addEventListener("click", (e) => {
        const t = e.target.closest("[data-cam]");
        if (t) { const c = cams.find((x) => x.mac === t.dataset.cam); power(c, !c.on); return; }
        const o = e.target.closest("[data-open-cam]");
        if (o) openCam(o.dataset.openCam);
      });
      $("wySignIn").onclick = signIn;
      $("wyOut").onclick = () => { if (!confirm("Sign out of Wyze on this phone?")) return; acct = null; cams = []; store.set("wyze.acct", null); paint(); };
      paint();
    },
    onShow(tab) { if (tab === "cams") load(); else if (tab === "events") loadEvents(); else paint(); },
    known: () => cams.filter((c) => c.ip).map((c) => ({ ip: c.ip, mac: c.mac.match(/../g)?.join(":"), name: c.name, type: "cam", hint: `Wyze ${c.model}`, online: c.online })),
  });
})();
