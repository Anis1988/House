// 🖥️ Screen: the Samsung Odyssey smart monitor (Tizen) over the home Wi-Fi.
// Remote keys go over Samsung's WebSocket remote (wss :8002). The first time, the screen asks to Allow.

(() => {
  const S = {
    ip: store.get("ss.ip", ""),
    ready: false,
    waiting: false, // asked the screen for permission, waiting for Allow
    info: null,     // from http://ip:8001/api/v2/
  };
  const NAME = btoa("House");

  async function readInfo() {
    if (!S.ip) return null;
    try {
      const r = await Net.lanGet({ url: `http://${S.ip}:8001/api/v2/` });
      const d = JSON.parse(r.body).device || {};
      S.info = { name: (d.name || "Samsung screen").replace(/&quot;/g, '"'), model: d.modelName, power: d.PowerState || "on", mac: d.wifiMac };
      if (d.wifiMac) store.set("ss.mac", d.wifiMac);
    } catch { S.info = null; }
    return S.info;
  }

  async function connect() {
    if (!S.ip || S.ready || S.connecting) return;
    S.connecting = true;
    const token = store.get("ss.token", "");
    try {
      await Net.open({ id: "ss", url: `wss://${S.ip}:8002/api/v2/channels/samsung.remote.control?name=${NAME}${token ? `&token=${token}` : ""}` });
      // Without a saved token the screen shows Allow / Deny; the answer comes as a message.
      S.waiting = !token;
      S.waitTimer = setTimeout(() => { if (S.waiting) { S.waiting = false; paint(); } }, 30000);
    } catch {
      S.ready = false;
    }
    S.connecting = false;
    paint();
  }

  Net.addListener("message", (e) => {
    if (e.id !== "ss") return;
    let m; try { m = JSON.parse(e.data); } catch { return; }
    if (m.event === "ms.channel.connect") {
      if (m.data?.token) store.set("ss.token", m.data.token);
      S.ready = true;
      S.waiting = false;
      clearTimeout(S.waitTimer);
      paint();
    } else if (m.event === "ms.channel.unauthorized" || m.event === "ms.channel.timeOut") {
      S.ready = false;
      S.waiting = false;
      store.set("ss.token", null);
      toast(m.event === "ms.channel.timeOut" ? "No answer on the screen. Try again." : "The screen said no", true);
      paint();
    }
  });
  Net.addListener("closed", (e) => { if (e.id === "ss") { S.ready = false; paint(); } });

  async function key(k) {
    buzz();
    if (!S.ready) { await connect(); if (!S.ready) { toast(S.waiting ? "Choose Allow on the screen first" : "The screen isn't connected", true); return; } }
    try {
      await Net.send({ id: "ss", data: JSON.stringify({ method: "ms.remote.control", params: { Cmd: "Click", DataOfCmd: k, Option: "false", TypeOfRemote: "SendRemoteKey" } }) });
    } catch { S.ready = false; toast("Lost the screen. Tap again.", true); paint(); }
  }

  function paint() {
    const on = !!S.info && S.info.power === "on";
    const sw = $("ssPower");
    sw.classList.toggle("on", on);
    sw.querySelector(".lbl").textContent = on ? "ON" : "OFF";
    $("ssName").textContent = S.info?.name || "Samsung screen";
    $("ssSetup").hidden = !!S.ip;
    $("ssAllow").hidden = !S.waiting;
    const line = !S.ip ? "No screen set up yet" : S.waiting ? "Choose Allow on the screen" : !S.info ? "Not reachable (off?)" : on ? (S.ready ? "On · connected" : "On") : "Standby";
    $("ssStatus").innerHTML = `<span class="dot ${on ? "on" : !S.info ? "bad" : ""}"></span>${esc(line)}`;
    $("ssZone").classList.toggle("disabled-zone", !on);
    $("ssIp").value = S.ip;
    $("ssModel").textContent = S.info ? `${S.info.model || ""}` : "";
    if (House.current === "screen") document.body.classList.toggle("dim", !on);
  }

  async function refresh() {
    await readInfo();
    paint();
    if (S.info?.power === "on" && !S.ready && store.get("ss.token")) connect();
  }

  async function find() {
    $("ssFind").disabled = true;
    $("ssFind").textContent = "Looking…";
    try {
      const { prefix } = await Net.localPrefix();
      const { hosts } = await Net.scan({ prefix, ports: [8001] });
      for (const h of hosts) {
        try {
          const r = await Net.lanGet({ url: `http://${h.ip}:8001/api/v2/` });
          if (/Samsung|Tizen/i.test(r.body)) { setIp(h.ip); toast(`Found ${JSON.parse(r.body).device?.name?.replace(/&quot;/g, '"') || "a Samsung screen"}`); return; }
        } catch {}
      }
      toast("No Samsung screen found. Is it on?", true);
    } catch (e) { toast(e.message || "Couldn't scan", true); }
    finally { $("ssFind").disabled = false; $("ssFind").textContent = "Find my screen"; }
  }
  function setIp(ip) {
    S.ip = ip;
    store.set("ss.ip", ip);
    store.set("ss.token", null);
    S.ready = false;
    refresh().then(connect);
  }

  const k = (name, icon, label) => `<button class="key" data-key="${name}">${svg(icon)}${label}</button>`;
  House.side({
    id: "screen", name: "Samsung screen", short: "Screen", icon: "screen", blurb: "Odyssey G7 monitor remote",
    tabs: [
      { id: "remote", label: "Remote", icon: "remote", html: `
        <div class="card glass banner" id="ssAllow" hidden>${svg("screen")}<div><b>Look at the screen</b><br><span class="muted">Choose Allow to let this app control it. You only do this once.</span></div></div>
        <div class="card glass" id="ssSetup" hidden>
          <h3>Set up your screen</h3>
          <p class="note" style="margin-top:0">Turn the monitor on (smart mode), then tap Find my screen.</p>
          <div class="list"><button class="primary full" id="ssFindTop">Find my screen</button></div>
        </div>
        <div class="card glass">
          <div class="head-card">
            <div class="grow"><b id="ssName">Samsung screen</b><div class="status-line" id="ssStatus"></div></div>
            <button class="pswitch" id="ssPower" aria-label="Screen on or off"><span class="lbl">OFF</span><span class="knob">${svg("power")}</span></button>
          </div>
        </div>
        <div id="ssZone">
          <div class="card glass remote">
            <div class="dpad">
              <button class="u" data-key="KEY_UP" aria-label="Up">${svg("up")}</button>
              <button class="l" data-key="KEY_LEFT" aria-label="Left">${svg("left")}</button>
              <button class="ok" data-key="KEY_ENTER">OK</button>
              <button class="r" data-key="KEY_RIGHT" aria-label="Right">${svg("right")}</button>
              <button class="d" data-key="KEY_DOWN" aria-label="Down">${svg("down")}</button>
            </div>
            <div class="keys">${k("KEY_RETURN", "back", "Back")}${k("KEY_HOME", "home", "Home")}${k("KEY_SOURCE", "input", "Source")}</div>
            <div class="rocker">
              <div class="pair"><button data-key="KEY_VOLDOWN" aria-label="Volume down">${svg("minus")}</button><span>VOL</span><button data-key="KEY_VOLUP" aria-label="Volume up">${svg("plus")}</button></div>
              <div class="pair"><button data-key="KEY_MUTE" aria-label="Mute">${svg("mute")}</button><span>MUTE</span><button data-key="KEY_MENU" aria-label="Menu">${svg("gear")}</button></div>
            </div>
            <div class="keys" style="margin-top:10px">${k("KEY_REWIND", "left", "Rewind")}${k("KEY_PLAY", "play", "Play")}${k("KEY_PAUSE", "pause", "Pause")}</div>
          </div>
        </div>` },
      { id: "settings", label: "Settings", icon: "gear" },
    ],
    settingsHtml: `
      <div class="label">Samsung screen</div>
      <div class="card glass">
        <button class="primary full" id="ssFind">Find my screen</button>
        <label class="fld">Or type its address<input class="field" id="ssIp" inputmode="decimal" placeholder="192.168.50.184"></label>
        <div class="list">
          <button class="ghost center" id="ssSave">Connect to this address</button>
          <button class="ghost center" id="ssRepair">Ask the screen again (Allow)</button>
          <button class="ghost center danger" id="ssForget">Forget this screen</button>
        </div>
        <p class="note" id="ssModel"></p>
        <p class="note">Turning it on from the app only works if the monitor allows wake-up over the network.</p>
      </div>`,
    guide: [
      ["screen", "First time", "Turn the monitor on and tap Find my screen. The screen asks once: choose Allow."],
      ["remote", "Remote", "Arrows, OK, Back, Home, Source and volume, like its own remote."],
      ["power", "On and off", "The switch turns it to standby. Turning it on from the app works only if the monitor allows waking up over the network."],
    ],
    mount() {
      House.page("screen", "remote").addEventListener("click", (e) => { const b = e.target.closest("[data-key]"); if (b) key(b.dataset.key); });
      $("ssPower").onclick = async () => {
        buzz(14);
        if (S.info?.power === "on") { await key("KEY_POWER"); toast("Screen to standby"); setTimeout(refresh, 2500); return; }
        const mac = store.get("ss.mac");
        if (!mac) { toast("Turn it on by hand once so the app can learn it", true); return; }
        await Net.wake({ mac, broadcast: S.ip.replace(/\.\d+$/, ".255") }).catch(() => {});
        toast("Waking the screen…");
        setTimeout(refresh, 5000);
      };
      $("ssFind").onclick = find;
      $("ssFindTop").onclick = find;
      $("ssSave").onclick = () => {
        const ip = $("ssIp").value.trim();
        if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) { toast("Type an address like 192.168.50.184", true); return; }
        setIp(ip);
      };
      $("ssRepair").onclick = () => { store.set("ss.token", null); S.ready = false; Net.close({ id: "ss" }).catch(() => {}); connect(); toast("Look at the screen"); };
      $("ssForget").onclick = () => {
        if (!confirm("Forget this screen?")) return;
        Net.close({ id: "ss" }).catch(() => {});
        ["ss.ip", "ss.token", "ss.mac"].forEach((k) => store.set(k, null));
        Object.assign(S, { ip: "", ready: false, info: null, waiting: false });
        paint();
      };
      paint();
    },
    onShow() { refresh(); },
    known: () => (S.ip ? [{ ip: S.ip, mac: store.get("ss.mac"), name: S.info?.name || "Samsung screen", type: "screen", hint: "Samsung smart monitor" }] : []),
  });
})();
