// 📺 TV: the LG webOS TV over the home Wi-Fi (same protocol as the LG TV Remote app).
// Tabs: Remote · Apps · Settings. Sockets live in the native Net plugin (self-signed wss).

const LG = (() => {
  // No "signed" block: with one, the TV only grants the few permissions listed inside it.
  const MANIFEST = {
    manifestVersion: 1,
    appVersion: "1.1",
    permissions: ["APP_TO_APP", "CLOSE", "CONTROL_AUDIO", "CONTROL_DISPLAY", "CONTROL_INPUT_JOYSTICK",
      "CONTROL_INPUT_MEDIA_PLAYBACK", "CONTROL_INPUT_MEDIA_RECORDING", "CONTROL_INPUT_TEXT", "CONTROL_INPUT_TV",
      "CONTROL_MOUSE_AND_KEYBOARD", "CONTROL_POWER", "CONTROL_TV_SCREEN", "LAUNCH", "LAUNCH_WEBAPP",
      "READ_APP_STATUS", "READ_COUNTRY_INFO", "READ_CURRENT_CHANNEL", "READ_INPUT_DEVICE_LIST",
      "READ_INSTALLED_APPS", "READ_LGE_SDX", "READ_LGE_TV_INPUT_EVENTS", "READ_NETWORK_STATE",
      "READ_NOTIFICATIONS", "READ_POWER_STATE", "READ_RUNNING_APPS", "READ_SETTINGS", "READ_TV_CHANNEL_LIST",
      "READ_TV_CURRENT_TIME", "READ_UPDATE_INFO", "SEARCH", "TEST_OPEN", "TEST_PROTECTED", "TEST_SECURE",
      "UPDATE_FROM_REMOTE_APP", "WRITE_NOTIFICATION_ALERT", "WRITE_NOTIFICATION_TOAST", "WRITE_SETTINGS"],
  };

  const TV = {
    manifest: MANIFEST,
    ip: store.get("lg.ip", ""),
    ready: false,
    pairing: false,
    power: "unknown", // "unknown" | "on" | "screen_off" | "off" | "unreachable"
    onChange: () => {},
    _pending: new Map(),
    _next: 0,
    _pointerOpen: false,
    _retry: null,

    async start(ip) {
      if (ip !== undefined) { this.ip = ip; store.set("lg.ip", ip); }
      clearTimeout(this._retry);
      if (!this.ip) { this.onChange(); return; }
      this.ready = false;
      this.onChange();
      try {
        await Net.open({ id: "lg", url: `wss://${this.ip}:3001` });
        Net.send({ id: "lg", data: JSON.stringify({
          id: "register", type: "register",
          payload: { forcePairing: false, pairingType: "PROMPT", "client-key": store.get("lg.key") || undefined, manifest: MANIFEST },
        }) }).catch(() => {});
        // A TV in standby accepts the socket but never answers registration: that means "off".
        clearTimeout(this._regTimer);
        this._regTimer = setTimeout(() => {
          if (this.ready || this.pairing) return;
          this.power = "off";
          this.onChange();
          Net.close({ id: "lg" }).catch(() => {});
          this._later(6000);
        }, 3500);
      } catch {
        this.power = "unreachable";
        this.onChange();
        this._later(8000);
      }
    },
    // Keep retrying only while the TV side is open.
    _later(ms) { clearTimeout(this._retry); this._retry = setTimeout(() => { if (House.current === "tv" && !document.hidden) this.start(); }, ms); },

    _onMessage(data) {
      const msg = JSON.parse(data);
      if (msg.id === "register") {
        if (msg.payload?.pairingType === "PROMPT" && msg.type === "response") { this.pairing = true; this.onChange(); }
        if (msg.type === "error") { this.pairing = false; this.onChange(); toast("The TV said no to pairing", true); }
        if (msg.type === "registered") {
          store.set("lg.key", msg.payload["client-key"]);
          clearTimeout(this._regTimer);
          this.pairing = false;
          this.ready = true;
          this.power = "on";
          this.onChange();
          this._rememberMac();
        }
        return;
      }
      const p = this._pending.get(msg.id);
      if (!p) return;
      this._pending.delete(msg.id);
      if (msg.type === "error") p.reject(new Error(msg.error));
      else p.resolve(msg.payload || {});
    },
    _onClosed(id) {
      if (id === "lg-pointer") { this._pointerOpen = false; return; }
      if (id !== "lg") return;
      this.ready = false;
      this._pointerOpen = false;
      this.onChange();
      this._later(3000);
    },
    markOff() {
      clearTimeout(this._regTimer);
      this.ready = false;
      this._pointerOpen = false;
      this.power = "off";
      Net.close({ id: "lg" }).catch(() => {});
      Net.close({ id: "lg-pointer" }).catch(() => {});
      this.onChange();
      this._later(5000);
    },

    request(uri, payload = {}) {
      if (!this.ready) return Promise.reject(new Error("The TV isn't connected"));
      return new Promise((resolve, reject) => {
        const id = `req_${this._next++}`;
        this._pending.set(id, { resolve, reject });
        Net.send({ id: "lg", data: JSON.stringify({ id, type: "request", uri, payload }) }).catch(reject);
        setTimeout(() => { if (this._pending.delete(id)) reject(new Error("The TV didn't answer")); }, 6000);
      });
    },

    // Remote buttons go through a separate pointer socket.
    async button(name) {
      if (!this._pointerOpen) {
        this._pointerOpening ??= (async () => {
          const { socketPath } = await this.request("ssap://com.webos.service.networkinput/getPointerInputSocket");
          await Net.open({ id: "lg-pointer", url: socketPath });
          this._pointerOpen = true;
        })().finally(() => { this._pointerOpening = null; });
        await this._pointerOpening;
      }
      await Net.send({ id: "lg-pointer", data: `type:button\nname:${name}\n\n` });
    },

    // Save the TV's MAC while it's on, so Wake-on-LAN can turn it on later.
    async _rememberMac() {
      try {
        const info = await this.request("ssap://com.webos.service.connectionmanager/getinfo");
        const mac = info.wiredInfo?.macAddress || info.wifiInfo?.macAddress;
        if (mac) store.set("lg.mac", mac);
      } catch {}
    },
    wake() {
      const mac = store.get("lg.mac");
      if (!mac) return Promise.reject(new Error("Connect once while the TV is on first"));
      return Net.wake({ mac, broadcast: this.ip.replace(/\.\d+$/, ".255") });
    },

    async status() {
      if (!this.ready) return null;
      const [sys, vol, app, pwr] = await Promise.allSettled([
        this.request("ssap://system/getSystemInfo"),
        this.request("ssap://audio/getVolume"),
        this.request("ssap://com.webos.applicationManager/getForegroundAppInfo"),
        this.request("ssap://com.webos.service.tvpower/power/getPowerState"),
      ]);
      const ps = pwr.value?.state || "";
      const noAnswer = [sys, vol, app, pwr].every((r) => r.status === "rejected");
      const state = /screen ?off|active standby/i.test(ps) ? "screen_off" : /suspend|power ?off|standby/i.test(ps) ? "off" : "on";
      if (noAnswer || state === "off") { this.markOff(); return null; }
      this.power = state;
      const v = vol.value || {};
      return { model: sys.value?.modelName, volume: v.volumeStatus?.volume ?? v.volume, muted: v.volumeStatus?.muteStatus ?? v.muted, appId: app.value?.appId };
    },
    async apps() {
      const { launchPoints = [] } = await this.request("ssap://com.webos.applicationManager/listLaunchPoints");
      return launchPoints.map((a) => ({ id: a.id, title: a.title, icon: a.largeIcon || a.icon, bgColor: a.bgColor }));
    },
    async inputs() {
      const { devices = [] } = await this.request("ssap://tv/getExternalInputList");
      return devices.map((d) => ({ id: d.id, label: d.label, connected: d.connected, appId: d.appId }));
    },
  };
  Net.addListener("message", (e) => { if (e.id === "lg" ) TV._onMessage(e.data); });
  Net.addListener("closed", (e) => TV._onClosed(e.id));
  return TV;
})();

(() => {
  let st = null;       // last status
  let apps = [];
  let inputs = [];
  const icons = {};

  async function act(fn, ok) {
    buzz();
    try { await fn(); if (ok) toast(ok); setTimeout(refresh, 400); }
    catch (e) { toast(e.message || "The TV didn't answer", true); }
  }
  const key = (name) => act(() => LG.button(name));
  const req = (uri, payload) => act(() => LG.request(uri, payload));

  function paint() {
    const on = LG.ready;
    const sw = $("tvPower");
    sw.classList.toggle("on", on && LG.power !== "off");
    sw.querySelector(".lbl").textContent = on ? "ON" : "OFF";
    $("tvZone").classList.toggle("disabled-zone", !on);
    $("tvAppsZone").classList.toggle("disabled-zone", !on);
    $("tvPair").hidden = !LG.pairing;
    const name = st?.model ? `LG ${st.model}` : "LG TV";
    $("tvName").textContent = name;
    let line;
    if (!LG.ip) line = "No TV set up yet";
    else if (LG.pairing) line = "Accept the prompt on the TV";
    else if (on) {
      const app = appTitle(st?.appId);
      line = [app, st?.volume != null ? `vol ${st.volume}${st.muted ? " (muted)" : ""}` : ""].filter(Boolean).join(" · ") || "On";
    } else line = LG.power === "off" ? "Off" : LG.power === "unreachable" ? "Not reachable" : "Connecting…";
    $("tvStatus").innerHTML = `<span class="dot ${on ? "on" : LG.power === "unreachable" ? "bad" : ""}"></span>${esc(line)}`;
    if (st?.volume != null) setSlider($("tvVol"), $("tvVolOut"), st.volume, "");
    $("tvMute").classList.toggle("on", !!st?.muted);
    $("tvSetup").hidden = !!LG.ip;
    $("tvIp").value = LG.ip;
    $("tvMac").textContent = store.get("lg.mac") ? "Turn-on from the app is ready" : "Connect once while the TV is on so the app can turn it on later";
    if (House.current === "tv") document.body.classList.toggle("dim", !on);
  }
  const appTitle = (id) => !id ? "" : apps.find((a) => a.id === id)?.title || inputs.find((i) => i.appId === id)?.label || id.replace(/^com\.webos\.app\./, "").replace(/^\w/, (c) => c.toUpperCase());

  async function refresh() {
    if (!LG.ready) { paint(); return; }
    try { st = await LG.status(); } catch {}
    paint();
  }

  async function loadApps() {
    if (!LG.ready) return;
    try {
      [apps, inputs] = await Promise.all([LG.apps(), LG.inputs().catch(() => [])]);
      store.setJson("lg.apps", apps.map((a) => ({ id: a.id, title: a.title })));
    } catch { return; }
    $("tvInputs").innerHTML = inputs.map((i) => `<button class="chip${i.connected ? "" : " off"}${st?.appId === i.appId ? " on" : ""}" data-input="${esc(i.id)}">${svg("input")}${esc(i.label)}</button>`).join("") || `<span class="muted small">No inputs</span>`;
    $("tvApps").innerHTML = apps.map((a) => `<button class="app-btn${st?.appId === a.id ? " now" : ""}" data-app="${esc(a.id)}"><span class="ico" style="--bgc:${esc(a.bgColor || "#262b3d")}" data-icon="${esc(a.icon || "")}"><b>${esc(a.title.slice(0, 2))}</b></span><span>${esc(a.title)}</span></button>`).join("");
    // Icons come from the TV a few at a time (it chokes on many at once).
    const todo = [...$("tvApps").querySelectorAll("[data-icon]")].filter((el) => el.dataset.icon);
    const next = async () => {
      const el = todo.shift();
      if (!el) return;
      const url = el.dataset.icon;
      try { icons[url] ??= (await Net.fetchImage({ url })).dataUrl; el.innerHTML = `<img alt="" src="${icons[url]}">`; } catch {}
      await next();
    };
    next(); next(); next();
  }

  async function find() {
    $("tvFind").disabled = true;
    $("tvFind").textContent = "Looking…";
    try {
      const { prefix } = await Net.localPrefix();
      const { hosts } = await Net.scan({ prefix, ports: [3001] });
      if (!hosts.length) { toast("No LG TV found. Is it on?", true); return; }
      toast(`Found an LG TV at ${hosts[0].ip}`);
      LG.start(hosts[0].ip);
    } catch (e) { toast(e.message || "Couldn't scan", true); }
    finally { $("tvFind").disabled = false; $("tvFind").textContent = "Find my TV"; }
  }

  const k = (name, icon, label) => `<button class="key" data-key="${name}">${svg(icon)}${label}</button>`;
  House.side({
    id: "tv", name: "LG TV", short: "TV", icon: "tv", blurb: "Remote for the LG TV",
    tabs: [
      { id: "remote", label: "Remote", icon: "remote", html: `
        <div class="card glass banner" id="tvPair" hidden>${svg("tv")}<div><b>Look at the TV</b><br><span class="muted">Choose Accept on the TV screen to let this app control it. You only do this once.</span></div></div>
        <div class="card glass" id="tvSetup" hidden>
          <h3>Set up your TV</h3>
          <p class="note" style="margin-top:0">Turn the TV on, then tap Find my TV. It must be on the same Wi-Fi as your phone.</p>
          <div class="list"><button class="primary full" id="tvFindTop">Find my TV</button></div>
        </div>
        <div class="card glass">
          <div class="head-card">
            <div class="grow"><b id="tvName">LG TV</b><div class="status-line" id="tvStatus"></div></div>
            <button class="pswitch" id="tvPower" aria-label="TV on or off"><span class="lbl">OFF</span><span class="knob">${svg("power")}</span></button>
          </div>
        </div>
        <div id="tvZone">
          <div class="card glass remote">
            <div class="dpad">
              <button class="u" data-key="UP" aria-label="Up">${svg("up")}</button>
              <button class="l" data-key="LEFT" aria-label="Left">${svg("left")}</button>
              <button class="ok" data-key="ENTER">OK</button>
              <button class="r" data-key="RIGHT" aria-label="Right">${svg("right")}</button>
              <button class="d" data-key="DOWN" aria-label="Down">${svg("down")}</button>
            </div>
            <div class="keys">
              ${k("BACK", "back", "Back")}${k("HOME", "home", "Home")}${k("MENU", "gear", "Settings")}
            </div>
            <div class="rocker">
              <div class="pair"><button data-key="VOLUMEDOWN" aria-label="Volume down">${svg("minus")}</button><span>VOL</span><button data-key="VOLUMEUP" aria-label="Volume up">${svg("plus")}</button></div>
              <div class="pair"><button data-key="CHANNELDOWN" aria-label="Channel down">${svg("down")}</button><span>CH</span><button data-key="CHANNELUP" aria-label="Channel up">${svg("up")}</button></div>
            </div>
            <div class="keys" style="margin-top:10px">
              <button class="key" id="tvMute">${svg("mute")}Mute</button>${k("PLAY", "play", "Play")}${k("PAUSE", "pause", "Pause")}
            </div>
          </div>
          <div class="card glass"><div class="slide" style="margin-top:0">${svg("vol")}<input type="range" id="tvVol" min="0" max="100"><output id="tvVolOut"></output></div></div>
        </div>` },
      { id: "apps", label: "Apps", icon: "apps", html: `
        <div id="tvAppsZone">
          <div class="label">Inputs</div>
          <div class="card glass"><div class="chips" id="tvInputs"><span class="muted small">Turn the TV on to see its inputs</span></div></div>
          <div class="label">Apps</div>
          <div class="card glass"><div class="apps" id="tvApps"><span class="muted small" style="grid-column:1/-1">Turn the TV on to see its apps</span></div></div>
        </div>` },
      { id: "settings", label: "Settings", icon: "gear" },
    ],
    settingsHtml: `
      <div class="label">LG TV</div>
      <div class="card glass">
        <button class="primary full" id="tvFind">Find my TV</button>
        <label class="fld">Or type its address<input class="field" id="tvIp" inputmode="decimal" placeholder="192.168.50.96"></label>
        <div class="list">
          <button class="ghost center" id="tvSave">Connect to this address</button>
          <button class="ghost center danger" id="tvForget">Forget this TV</button>
        </div>
        <p class="note" id="tvMac"></p>
        <p class="note">The full remote (keyboard, sleep timer, picture modes) is in the <b>LG TV Remote</b> app.</p>
      </div>`,
    guide: [
      ["tv", "First time", "Turn the TV on and tap Find my TV. The TV asks once whether to allow this app: choose Accept."],
      ["power", "On and off", "The switch turns the TV off, and back on over Wi-Fi (once the app has seen the TV on)."],
      ["remote", "Remote", "Arrows and OK move around the TV's menus. Volume and channel are under them; the bar sets the volume exactly."],
      ["apps", "Apps and inputs", "The Apps tab opens any app on the TV or switches to HDMI inputs."],
    ],
    mount() {
      LG.onChange = () => { paint(); if (LG.ready) { refresh(); if (!apps.length) loadApps(); } };
      const page = House.page("tv", "remote");
      page.addEventListener("click", (e) => { const b = e.target.closest("[data-key]"); if (b) key(b.dataset.key); });
      $("tvMute").onclick = () => req("ssap://audio/setMute", { mute: !st?.muted });
      const setVol = throttled((v) => LG.request("ssap://audio/setVolume", { volume: v }).catch(() => {}), 150);
      $("tvVol").oninput = (e) => { const v = +e.target.value; setSlider($("tvVol"), $("tvVolOut"), v, ""); setVol(v); };
      $("tvPower").onclick = async () => {
        buzz(14);
        if (LG.ready) { await LG.request("ssap://system/turnOff").catch(() => {}); LG.markOff(); toast("TV off"); return; }
        try { await LG.wake(); toast("Turning the TV on…"); setTimeout(() => LG.start(), 4000); }
        catch (e) { toast(e.message, true); }
      };
      House.page("tv", "apps").addEventListener("click", (e) => {
        const a = e.target.closest("[data-app]");
        if (a) return act(() => LG.request("ssap://system.launcher/launch", { id: a.dataset.app }), "Opening…");
        const i = e.target.closest("[data-input]");
        if (i) return act(() => LG.request("ssap://tv/switchInput", { inputId: i.dataset.input }));
      });
      $("tvFind").onclick = find;
      $("tvFindTop").onclick = find;
      $("tvSave").onclick = () => {
        const ip = $("tvIp").value.trim();
        if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) { toast("Type an address like 192.168.50.96", true); return; }
        LG.start(ip);
        toast("Connecting…");
      };
      $("tvForget").onclick = () => {
        if (!confirm("Forget this TV? You'll need to accept on the TV again.")) return;
        Net.close({ id: "lg" }).catch(() => {});
        ["lg.ip", "lg.key", "lg.mac"].forEach((k) => store.set(k, null));
        LG.ip = ""; LG.ready = false; apps = []; st = null;
        paint();
      };
      paint();
    },
    onShow(tab) {
      if (!LG.ready && LG.ip) LG.start();
      else refresh();
      if (tab === "apps" && LG.ready) loadApps();
      paint();
    },
    known: () => (LG.ip ? [{ ip: LG.ip, mac: store.get("lg.mac"), name: st?.model ? `LG ${st.model}` : "LG TV", type: "tv", hint: "LG webOS TV" }] : []),
  });
})();
