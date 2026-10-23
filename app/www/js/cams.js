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
  };
  let acct = store.json("wyze.acct", null); // { access, refresh, email }
  let cams = [];
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
          <div class="shot ${c.on && c.online ? "" : "off"}">
            ${c.thumb ? `<img alt="" src="${esc(c.thumb)}" loading="lazy">` : svg("cam", 'style="width:44px;height:44px"')}
            <span class="badge"><span class="dot ${c.online ? (c.on ? "on" : "") : "bad"}"></span>${!c.online ? "Offline" : c.on ? "On" : "Off"}${c.thumbAt ? ` · ${ago(c.thumbAt)}` : ""}</span>
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
      ["clock", "Live video", "Live video isn't possible here yet; use the Wyze app for that."],
    ],
    mount() {
      document.addEventListener("click", (e) => { if (e.target.closest("[data-wy-settings]")) House.showTab("settings"); });
      $("wyRefresh").onclick = () => { buzz(6); load(true); };
      $("wyCams").addEventListener("click", (e) => { const t = e.target.closest("[data-cam]"); if (t) { const c = cams.find((x) => x.mac === t.dataset.cam); power(c, !c.on); } });
      $("wySignIn").onclick = signIn;
      $("wyOut").onclick = () => { if (!confirm("Sign out of Wyze on this phone?")) return; acct = null; cams = []; store.set("wyze.acct", null); paint(); };
      paint();
    },
    onShow(tab) { if (tab === "cams") load(); else paint(); },
    known: () => cams.filter((c) => c.ip).map((c) => ({ ip: c.ip, mac: c.mac.match(/../g)?.join(":"), name: c.name, type: "cam", hint: `Wyze ${c.model}`, online: c.online })),
  });
})();
