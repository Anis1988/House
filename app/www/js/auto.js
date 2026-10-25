// Automation settings kept natively (HomeAuto), shown on the sides they belong to:
// Doorbell lights (Nest → Settings), Movie mode (TV → Settings) and the Quick Settings tile
// scene (Lights → Settings). Filled into placeholders those sides' settings leave for them.

(() => {
  let auto = { settings: {}, dark: false };
  const bulbs = () => (House.byId("lights")?.list?.() || []).slice().sort((a, b) => `${a.group} ${a.label}`.localeCompare(`${b.group} ${b.label}`, undefined, { numeric: true }));
  const has = { nest: () => !!store.json("nest.tok", null)?.refresh, tv: () => !!(store.get("lg.ip") && store.get("lg.key")) };

  async function save(changes, msg) {
    const s = JSON.parse(JSON.stringify(auto.settings));
    for (const [k, v] of Object.entries(changes)) s[k] = v === null ? undefined : (typeof v === "object" && !Array.isArray(v) ? { ...(s[k] || {}), ...v } : v);
    try { auto = await Net.setAuto({ settings: s }); if (msg) toast(msg); }
    catch { toast("Couldn't save that", true); }
    paint();
  }

  const chips = (attr, sel) => bulbs().map((l) => `<button ${attr}="${esc(l.id)}" class="${sel.includes(l.id) ? "on" : ""}">${esc(l.label)}</button>`).join("")
    || `<p class="note" style="margin:0">Open the Lights side once so the app knows your lights.</p>`;
  const tgl = (id, on, label) => `<button class="tgl ${on ? "on" : ""}" id="${id}" aria-label="${label}"><i></i></button>`;

  function paintDoor() {
    const box = $("autoDoor");
    if (!box) return;
    const d = auto.settings.door || {};
    const sub = !!store.get("nest.sub");
    box.innerHTML = `
      <div class="label">Doorbell lights</div>
      <div class="card glass">
        <div class="set-row"><div class="set-text"><b>Lights on when someone's at the door</b><span>The lights below turn on for a few minutes, then off again. Lights already on stay on.</span></div>${tgl("adOn", d.on, "Doorbell lights")}</div>
        ${d.on ? `
        <div class="chips" id="adLights" style="margin-top:10px">${chips("data-adl", d.lights || [])}</div>
        <label class="fld">For<select class="field" id="adMin">${[2, 5, 10, 15, 30].map((m) => `<option value="${m}" ${(d.minutes || 5) === m ? "selected" : ""}>${m} min</option>`).join("")}</select></label>
        <div class="set-row" style="margin-top:8px"><div class="set-text"><b>When it rings</b></div>${tgl("adRing", d.ring !== false, "When it rings")}</div>
        <div class="set-row"><div class="set-text"><b>When it sees a person</b></div>${tgl("adPerson", d.person !== false, "When it sees a person")}</div>
        <div class="set-row"><div class="set-text"><b>Only after dark</b><span>${auto.dark ? "It's dark now." : "It's light out now."} Uses your city from Lights → Settings.</span></div>${tgl("adDark", d.dark !== false, "Only after dark")}</div>` : ""}
        <p class="note ${sub ? "" : "err"}">${sub ? "Uses the doorbell events below (read about every 2 minutes), so the lights can take up to 2 minutes." : "Needs the doorbell events set up below (Pub/Sub subscription)."}</p>
      </div>`;
  }

  function paintMovie() {
    const box = $("autoMovie");
    if (!box) return;
    const m = auto.settings.movie || {};
    const def = bulbs().filter((l) => /living/i.test(l.group || "")).map((l) => l.id);
    const sel = m.lights || def;
    box.innerHTML = `
      <div class="label">Movie mode</div>
      <div class="card glass">
        <div class="set-row"><div class="set-text"><b>Dim the lights when the TV turns on</b><span>When the TV turns off, they go back to how they were.</span></div>${tgl("amOn", m.on, "Movie mode")}</div>
        ${m.on ? `
        <div class="chips" id="amLights" style="margin-top:10px">${chips("data-aml", sel)}</div>
        <label class="fld">Dim to<select class="field" id="amBri">${[5, 10, 20, 30, 50].map((b) => `<option value="${b}" ${(m.bri || 20) === b ? "selected" : ""}>${b}%</option>`).join("")}</select></label>
        <div class="set-row" style="margin-top:8px"><div class="set-text"><b>Only after dark</b></div>${tgl("amDark", m.dark !== false, "Only after dark")}</div>
        <div class="list"><button class="ghost center" id="amTest">Is the TV on?</button></div>` : ""}
        <p class="note">${has.tv() ? "Checks the TV about every 2 minutes while you're home, so it can take a moment. Only lights that are on are dimmed." : "Set up the TV above first."}</p>
      </div>`;
  }

  async function paintQs() {
    const box = $("autoQs");
    if (!box) return;
    let scenes = [];
    try { scenes = (await Lights.getScenes()).scenes || []; } catch {}
    const cur = auto.settings.qsScene || scenes[0]?.id || "";
    box.innerHTML = `
      <div class="label">Quick access</div>
      <div class="card glass">
        <label class="fld" style="margin-top:0">Scene for the Quick Settings tile<select class="field" id="aqScene">${scenes.map((s) => `<option value="${esc(s.id)}" ${s.id === cur ? "selected" : ""}>${esc(s.name)}</option>`).join("")}</select></label>
        <p class="note">Swipe down twice from the top of the screen → the pencil (edit) → drag <b>Lights</b>, the scene and <b>Nest away</b> into your tiles. Long-press the House icon for your first four scenes.</p>
      </div>`;
  }

  function paint() { paintDoor(); paintMovie(); paintQs(); }

  function toggleIn(list, id) { return list.includes(id) ? list.filter((x) => x !== id) : [...list, id]; }

  function mount() {
    document.addEventListener("click", (e) => {
      const t = e.target;
      let b;
      const d = auto.settings.door || {}, m = auto.settings.movie || {};
      if ((b = t.closest("[data-adl]"))) { buzz(6); save({ door: { lights: toggleIn(d.lights || [], b.dataset.adl) } }); return; }
      if ((b = t.closest("[data-aml]"))) {
        buzz(6);
        const def = bulbs().filter((l) => /living/i.test(l.group || "")).map((l) => l.id);
        save({ movie: { lights: toggleIn(m.lights || def, b.dataset.aml) } });
        return;
      }
      switch (t.closest("button")?.id) {
        case "adOn": {
          buzz();
          const on = !d.on;
          const lights = d.lights?.length ? d.lights : bulbs().filter((l) => /hall|entr|porch|front/i.test(`${l.group} ${l.label}`)).map((l) => l.id);
          save({ door: { on, lights } }, on ? (lights.length ? "Doorbell lights on" : "Doorbell lights on: pick the lights") : "Doorbell lights off");
          break;
        }
        case "adRing": buzz(); save({ door: { ring: d.ring === false } }); break;
        case "adPerson": buzz(); save({ door: { person: d.person === false } }); break;
        case "adDark": buzz(); save({ door: { dark: d.dark === false } }); break;
        case "amOn": {
          buzz();
          const on = !m.on;
          const lights = m.lights || bulbs().filter((l) => /living/i.test(l.group || "")).map((l) => l.id);
          save({ movie: { on, lights } }, on ? "Movie mode on" : "Movie mode off");
          break;
        }
        case "amDark": buzz(); save({ movie: { dark: m.dark === false } }); break;
        case "amTest": {
          const btn = t.closest("button");
          btn.disabled = true; btn.textContent = "Asking the TV…";
          Net.tvState().then((r) => toast(r.on ? "The TV is on" : "The TV is off (or not answering)")).catch(() => toast("Couldn't ask the TV", true))
            .finally(() => { btn.disabled = false; btn.textContent = "Is the TV on?"; });
          break;
        }
      }
    });
    document.addEventListener("change", (e) => {
      if (e.target.id === "adMin") save({ door: { minutes: +e.target.value } }, "Saved");
      if (e.target.id === "amBri") save({ movie: { bri: +e.target.value } }, "Saved");
      if (e.target.id === "aqScene") save({ qsScene: e.target.value }, "Tile scene saved");
    });
    // Repaint when a Settings page opens (the light list may have arrived since).
    const show = House.showTab.bind(House);
    House.showTab = (tab) => { show(tab); if (tab === "settings") paint(); };
    Net.getAuto().then((a) => { auto = a; paint(); }).catch(() => {});
  }

  House.auto = { mount };
})();
