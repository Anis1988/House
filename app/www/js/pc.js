// Computers with the House PC helper (pc-helper/ in the repo): shut down, restart, sleep, lock,
// and turn on over the network (Wake-on-LAN). Pairing asks "Allow?" on the PC itself and gives
// this phone a key, kept here. Shown on the Wi-Fi side: a "Your PCs" fold on the Devices tab
// and a section in a computer's device sheet.

(() => {
  const PORT = 47801;
  const pcs = () => store.json("pc.list", []); // [{ mac, ip, name, key }]
  const savePcs = (l) => store.setJson("pc.list", l);
  const lc = (m) => (m || "").toLowerCase();
  let state = {}; // mac → { online, uptime }

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

  async function hello(ip) {
    try { const j = await call(ip, "/hello", { ms: 1500 }); return j.app === "house-pc" ? j : null; } catch { return null; }
  }

  async function pair(ip, btn) {
    if (btn) { btn.disabled = true; btn.textContent = "Tap Yes on the PC…"; }
    try {
      const j = await call(ip, "/pair", { method: "POST", ms: 65000 });
      savePcs([...pcs().filter((p) => lc(p.mac) !== lc(j.mac)), { mac: lc(j.mac), ip: j.ip || ip, name: j.name, key: j.key }]);
      toast(`${j.name} paired`);
      paint();
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
      toast(action === "shutdown" ? `${name} shuts down in 10 seconds` : action === "restart" ? `${name} restarts in 10 seconds` : action === "cancel" ? "Shutdown cancelled" : `${name}: ${LABELS[action].toLowerCase()}`);
      if (["shutdown", "sleep"].includes(action)) setTimeout(refresh, 15000);
    } catch (e) {
      toast(e.message === "No answer" ? `${name} isn't answering (off or asleep?)` : e.message, true);
    }
  }

  async function wake(pc) {
    buzz();
    const ip = ipOf(pc);
    try {
      await Net.wake({ mac: pc.mac, broadcast: ip.split(".").slice(0, 3).join(".") + ".255" });
      toast(`Waking ${pc.name}… give it a minute`);
      setTimeout(refresh, 30000);
    } catch { toast("Couldn't send the wake-up", true); }
  }

  async function refresh() {
    await Promise.all(pcs().map(async (pc) => {
      try { const j = await call(ipOf(pc), "/status", { key: pc.key, ms: 2000 }); state[lc(pc.mac)] = { online: true, uptime: j.uptime }; }
      catch (e) { state[lc(pc.mac)] = { online: false, unpaired: /paired/i.test(e.message) }; }
    }));
    paint();
  }

  const upFor = (s) => { const d = Math.floor(s / 86400), h = Math.floor(s % 86400 / 3600); return d ? `${d} d ${h} h` : `${h} h ${Math.floor(s % 3600 / 60)} min`; };
  const buttons = (pc, on) => on
    ? `<div class="pc-btns"><button class="ghost center" data-pc="${esc(pc.mac)}" data-pc-do="sleep">${svg("moon")}Sleep</button><button class="ghost center" data-pc="${esc(pc.mac)}" data-pc-do="lock">${svg("key")}Lock</button>
       <button class="ghost center" data-pc="${esc(pc.mac)}" data-pc-do="restart">${svg("refresh")}Restart</button><button class="ghost center danger" data-pc="${esc(pc.mac)}" data-pc-do="shutdown">${svg("power")}Shut down</button></div>
       <div class="list" style="margin-top:6px"><button class="ghost center small-btn" data-pc="${esc(pc.mac)}" data-pc-do="cancel">Cancel a shutdown or restart</button></div>`
    : `<div class="list"><button class="primary full" data-pc="${esc(pc.mac)}" data-pc-do="wake">${svg("power")} Turn on</button></div>`;

  // The "Your PCs" fold on the Devices tab (only once a PC is paired).
  function paint() {
    const box = $("pcFold");
    if (!box) return;
    const list = pcs();
    if (!list.length) { box.innerHTML = ""; return; }
    const sub = list.map((pc) => `${pc.name} ${state[lc(pc.mac)] ? (state[lc(pc.mac)].online ? "on" : "off") : ""}`.trim()).join(" · ");
    const open = box.querySelector("details")?.open;
    box.innerHTML = House.fold("wifi.pcs", list.length === 1 ? list[0].name : "Your PCs", "laptop", list.map((pc) => {
      const st = state[lc(pc.mac)];
      return `<div class="pc-row"><div class="set-row" style="padding-top:0"><span class="dot ${st?.online ? "on" : ""}"></span><div class="set-text"><b>${esc(pc.name)}</b><span>${!st ? "Checking…" : st.online ? `On · running for ${upFor(st.uptime)}` : st.unpaired ? "Pair again from its device page" : "Off or asleep"}</span></div></div>${buttons(pc, st?.online !== false)}</div>`;
    }).join(""), { sub, ...(open == null ? {} : { open }) });
  }

  // In a device sheet: if this device runs the helper, pair or control it.
  async function sheet(d, body) {
    const box = body.querySelector("#devPc");
    if (!box || !d.ip) return;
    const pc = pcs().find((p) => lc(p.mac) === lc(d.mac) || p.ip === d.ip);
    const h = await hello(d.ip);
    if (!h && !pc) return;
    box.innerHTML = `<div class="label" style="margin-top:18px">This PC</div>` + (pc
      ? buttons(pc, !!h)
      : `<p class="note" style="margin-top:0">${esc(h.name)} has the House PC helper. Pair once to shut it down, restart, sleep or lock it from here.</p><div class="list"><button class="primary full" id="pcPair">Pair with this PC</button></div>`);
    body.querySelector("#pcPair")?.addEventListener("click", async (e) => { if (await pair(d.ip, e.currentTarget)) sheet(d, body); });
  }

  document.addEventListener("click", (e) => {
    const b = e.target.closest("[data-pc-do]");
    if (!b) return;
    const pc = pcs().find((p) => lc(p.mac) === lc(b.dataset.pc));
    if (!pc) return;
    if (b.dataset.pcDo === "wake") wake(pc); else act(pc, b.dataset.pcDo);
  });

  House.pc = { paint, refresh, sheet, foldHtml: `<div id="pcFold"></div>` };
})();
