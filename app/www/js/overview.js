// 🏠 Home: one page with the whole house at a glance: who's home, lights, Nest, scenes,
// internet and the last doorbell ring. Each card opens its own side. Read from the native
// side (homeStatus) and the Lights side's list; nothing here is kept separately.

(() => {
  let st = null;
  let busy = false;
  let sceneList = [];
  const ago = (t) => { const m = Math.round((Date.now() - t) / 60000); return m < 1 ? "just now" : m < 60 ? `${m} min ago` : m < 1440 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} d ago`; };
  const COLORS = { amber: ["#fbbf24", "#f97316"], coral: ["#fb7185", "#e11d48"], pink: ["#f472b6", "#c026d3"], violet: ["#a78bfa", "#6d28d9"], blue: ["#60a5fa", "#2563eb"], teal: ["#2dd4bf", "#0d9488"], green: ["#4ade80", "#16a34a"], grey: ["#94a3b8", "#475569"] };
  const BUILTIN = { bright: "amber", movie: "violet", night: "coral", off: "grey" };
  const fahrenheit = (n) => n?.scale === "FAHRENHEIT";
  const deg = (n, c) => (fahrenheit(n) ? `${Math.round(c * 9 / 5 + 32)}°` : `${Math.round(c * 2) / 2}°`);
  const target = (n) => n.eco === "MANUAL_ECO" ? "Eco (away)" : n.mode === "HEAT" ? `Heat to ${deg(n, n.heat)}` : n.mode === "COOL" ? `Cool to ${deg(n, n.cool)}` : n.mode === "HEATCOOL" ? `${deg(n, n.heat)} – ${deg(n, n.cool)}` : n.mode === "OFF" ? "Off" : "";
  const visible = (id) => !House.hidden().includes(id);

  const html = `
    <div class="card glass ov-card" id="ovPeople" data-go="wifi"></div>
    <div class="grid2">
      <div class="card glass ov-card" id="ovLights" data-go="lights"></div>
      <div class="card glass ov-card" id="ovNest" data-go="nest"></div>
    </div>
    <div class="label">Scenes</div>
    <div class="ov-scenes" id="ovScenes"></div>
    <div class="grid2" style="margin-top:14px">
      <div class="card glass ov-card" id="ovNet" data-go="wifi"></div>
      <div class="card glass ov-card" id="ovDoor" data-go="nest"></div>
    </div>`;

  async function load(refresh) {
    if (busy) return;
    busy = true;
    $("ovRefresh")?.classList.add("spin");
    try { st = await Net.homeStatus({ refresh }); } catch {}
    busy = false;
    $("ovRefresh")?.classList.remove("spin");
    paint();
  }

  function paint() {
    if (!$("ovPeople")) return;
    const s = st || {};
    // Who's home
    const ps = s.people || [];
    const isIn = (p) => p.home && (p.key === "this-phone" || Date.now() - (p.seenAt || p.since) < 30 * 60e3);
    $("ovPeople").hidden = !visible("wifi");
    $("ovPeople").innerHTML = `<div class="head-card"><div class="grow"><b>${ps.length ? `${ps.filter(isIn).length ? ps.filter(isIn).map((p) => esc(p.name)).join(", ") + (ps.filter(isIn).length === 1 ? " is" : " are") + " home" : "No one's home"}` : "Who's home"}</b>
      <div class="ov-people">${ps.length ? ps.map((p) => `<span class="ov-person ${isIn(p) ? "in" : ""}"><span class="dot ${isIn(p) ? "on" : ""}"></span>${esc(p.name)}</span>`).join("") : `<span class="muted small">Mark phones as people in Wi-Fi → Devices</span>`}</div></div>
      <button class="round-btn glass" id="ovRefresh" aria-label="Refresh">${svg("refresh")}</button></div>`;
    // Lights
    const ls = House.byId("lights")?.list?.() || [];
    const on = ls.filter((l) => l.on && l.online !== false).length;
    $("ovLights").hidden = !visible("lights");
    $("ovLights").innerHTML = `<span class="ov-ic">${svg("bulb")}</span><div class="ov-big">${ls.length ? on : "—"}</div><div class="ov-sub">${ls.length ? `${on === 1 ? "light" : "lights"} on of ${ls.length}` : "Lights"}</div>
      ${ls.length ? `<button class="ghost center ov-btn" data-ov-all="${on ? "off" : "on"}">${on ? "All off" : "All on"}</button>` : ""}`;
    // Nest
    const n = s.nest;
    $("ovNest").hidden = !visible("nest");
    $("ovNest").innerHTML = !n ? `<span class="ov-ic">${svg("thermo")}</span><div class="ov-big">—</div><div class="ov-sub">Set up Nest</div>`
      : `<span class="ov-ic">${svg("thermo")}</span><div class="ov-big">${n.temp != null ? deg(n, n.temp) : "—"}</div><div class="ov-sub">${esc(target(n))}${n.hvac === "HEATING" ? " · heating" : n.hvac === "COOLING" ? " · cooling" : ""}</div>
        ${n.eco !== "MANUAL_ECO" && ["HEAT", "COOL", "HEATCOOL"].includes(n.mode) ? `<div class="ov-steps"><button class="ghost center ov-btn" data-ov-nest="-1" aria-label="Cooler">${svg("minus")}</button><button class="ghost center ov-btn" data-ov-nest="1" aria-label="Warmer">${svg("plus")}</button></div>` : ""}`;
    // Internet
    const sp = s.lastSpeed || {};
    $("ovNet").hidden = !visible("wifi");
    $("ovNet").innerHTML = `<span class="ov-ic">${svg("wifi")}</span><div class="ov-big ${s.netUp === false ? "bad" : ""}">${s.netUp == null ? (sp.down ? Math.round(sp.down) : "—") : s.netUp ? "Up" : "Down"}</div>
      <div class="ov-sub">${s.netUp == null ? (sp.down ? `Mbps down · ${ago(sp.at)}` : "Internet") : sp.down ? `Internet · ${Math.round(sp.down)} Mbps` : "Internet"}</div>`;
    // Doorbell
    const r = s.ring;
    $("ovDoor").hidden = !visible("nest");
    $("ovDoor").innerHTML = `<span class="ov-ic">${svg("bell")}</span>${r?.image ? `<img class="ov-photo" alt="Last visitor" src="${r.image}">` : ""}
      <div class="ov-big small">${r ? (r.kind === "person" ? "Person" : "Rang") : "—"}</div><div class="ov-sub">${r ? ago(r.at) : "Doorbell"}</div>`;
    paintScenes();
  }

  async function paintScenes() {
    let scenes = [];
    try { scenes = (await Lights.getScenes()).scenes || []; } catch {}
    $("ovScenes").innerHTML = scenes.map((sc) => {
      const c = COLORS[sc.color || BUILTIN[sc.id]] || ["var(--a1)", "var(--a2)"];
      return `<button class="ov-scene glass" data-ov-scene="${esc(sc.id)}"><span class="ic" style="background:linear-gradient(135deg, ${c[0]}, ${c[1]})">${svg(sc.icon || "star")}</span><b>${esc(sc.name)}</b></button>`;
    }).join("") || `<p class="note">Make scenes on the Lights side.</p>`;
    sceneList = scenes;
  }

  House.side({
    id: "home", name: "Home", icon: "home", blurb: "The whole house at a glance",
    tabs: [
      { id: "overview", label: "Home", icon: "home", html },
      { id: "settings", label: "Settings", icon: "gear" },
    ],
    settingsHtml: `<div class="card glass"><p class="note" style="margin:0">Cards for devices you hide (Settings → Devices) are left out here too.</p></div>`,
    guide: [
      ["home", "At a glance", "Who's home, how many lights are on, the temperature, your internet and the last doorbell ring. Tap a card to open that device."],
      ["star", "Scenes", "Tap a scene to run it. Edit them on the Lights side."],
      ["refresh", "Up to date", "Pull fresh numbers with the refresh button: it asks Nest again too."],
    ],
    mount() {
      document.addEventListener("click", async (e) => {
        if (House.current !== "home") return;
        const t = e.target;
        let b;
        if ((b = t.closest("#ovRefresh"))) { buzz(6); House.byId("lights")?.refresh?.(); load(true); return; }
        if ((b = t.closest("[data-ov-all]"))) {
          buzz();
          const ls = House.byId("lights")?.list?.() || [];
          try { await Lights.power({ ids: ls.map((l) => l.id), on: b.dataset.ovAll === "on" }); ls.forEach((l) => (l.on = b.dataset.ovAll === "on")); } catch { toast("Couldn't reach the lights", true); }
          paint();
          setTimeout(() => { House.byId("lights")?.refresh?.(); setTimeout(paint, 1500); }, 800);
          return;
        }
        if ((b = t.closest("[data-ov-nest]"))) {
          buzz(6);
          try { st.nest = await Net.nestQuick({ dir: +b.dataset.ovNest }); paint(); } catch (err) { toast(err.message || "Nest didn't answer", true); }
          return;
        }
        if ((b = t.closest("[data-ov-scene]"))) {
          const sc = sceneList.find((x) => x.id === b.dataset.ovScene);
          if (!sc) return;
          buzz(14);
          toast(`${sc.name}…`);
          try { const r = await Lights.runScene({ scene: sc }); toast(r.failed?.length ? `${sc.name}: ${r.failed.join(", ")} didn't answer` : sc.name, !!r.failed?.length); } catch { toast("Couldn't run the scene", true); }
          setTimeout(() => { House.byId("lights")?.refresh?.(); setTimeout(paint, 1500); }, 600);
          return;
        }
        if ((b = t.closest("[data-go]")) && !t.closest("button")) { buzz(6); House.show(b.dataset.go); }
      });
      document.addEventListener("visibilitychange", () => { if (!document.hidden && House.current === "home") load(false); });
      setInterval(() => { if (!document.hidden && House.current === "home") load(false); }, 60000);
    },
    onShow(tab) {
      if (tab === "overview") { paint(); load(false); }
    },
  });
})();
