// House PC helper: lets the House app control this PC over the home network. Runs at sign-in
// (see install.ps1), with no window.
//
// - Answers only devices on the home network (private addresses), on port 47801.
// - Pairing: the app asks once, this PC shows "Allow House to control this PC?"; on Yes the
//   app gets a secret key, and every request after that must carry it.
// - Power: shutdown, restart, sleep, lock, cancel. Media keys: volume, mute, play/pause, next,
//   previous. Open programs (list, close). A message on screen. A screenshot. Health (CPU,
//   memory, disks, who's signed in, idle time).
// - Nightly shutdown at a set time, run here so it works with the phone away: a 2-minute
//   warning with Cancel, skipped when someone used the PC in the last 15 minutes.
//
// Files (next to this script): key.txt (the secret), settings.json, house-pc.log.

const http = require("http");
const os = require("os");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { execFile, spawn } = require("child_process");

const PORT = 47801;
const VERSION = 2;
const DIR = __dirname;
const KEY_FILE = path.join(DIR, "key.txt");
const SETTINGS_FILE = path.join(DIR, "settings.json");
const LOG_FILE = path.join(DIR, "house-pc.log");

function log(msg) {
  try {
    if (fs.existsSync(LOG_FILE) && fs.statSync(LOG_FILE).size > 512 * 1024) fs.renameSync(LOG_FILE, LOG_FILE + ".old");
    fs.appendFileSync(LOG_FILE, `${new Date().toISOString()} ${msg}\n`);
  } catch {}
}

function key() {
  try { return fs.readFileSync(KEY_FILE, "utf8").trim(); } catch {}
  const k = crypto.randomBytes(24).toString("base64url");
  fs.writeFileSync(KEY_FILE, k);
  return k;
}

// { nightly: { on, time: "02:00", idleMin: 15 } }
function settings() {
  try { return JSON.parse(fs.readFileSync(SETTINGS_FILE, "utf8")); } catch { return { nightly: { on: false, time: "02:00", idleMin: 15 } }; }
}
function saveSettings(s) { fs.writeFileSync(SETTINGS_FILE, JSON.stringify(s, null, 1)); }

// Home network only: 10.x, 172.16–31.x, 192.168.x (and this PC itself).
function isLocal(addr) {
  const ip = String(addr || "").replace(/^::ffff:/, "");
  return /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|127\.)/.test(ip) || ip === "::1";
}

function sameKey(a, b) {
  const x = Buffer.from(String(a || "")), y = Buffer.from(String(b || ""));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

// The wired or Wi-Fi adapter on the home network, for turning the PC on (Wake-on-LAN).
function lan() {
  for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
    for (const a of addrs || []) {
      if (a.family === "IPv4" && !a.internal && isLocal(a.address) && !/vethernet|virtual|vmware|hyper-v|loopback/i.test(name)) {
        return { adapter: name, ip: a.address, mac: a.mac };
      }
    }
  }
  return {};
}

/* ---- PowerShell, for what Node can't do on Windows by itself ---- */

// Runs a script; text the phone sent is passed in environment variables, never in the script.
function ps(script, env = {}, ms = 20000) {
  return new Promise((resolve, reject) => {
    execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script],
      { windowsHide: true, timeout: ms, maxBuffer: 32 * 1024 * 1024, env: { ...process.env, ...env } },
      (err, out, errOut) => (err ? reject(new Error((errOut || err.message).trim().split("\n")[0])) : resolve(out.trim())));
  });
}
// Shown without waiting (dialogs).
function psDetached(script, env = {}) {
  const p = spawn("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-WindowStyle", "Hidden", "-Command", script],
    { detached: true, stdio: "ignore", env: { ...process.env, ...env } });
  p.unref();
  return p;
}

const KEYS_PS = `$t = Add-Type -MemberDefinition '[DllImport("user32.dll")] public static extern void keybd_event(byte b, byte s, uint f, UIntPtr e);' -Name K -Namespace W -PassThru
foreach ($i in 1..[int]$env:HOUSE_TIMES) { $t::keybd_event([byte]$env:HOUSE_VK, 0, 1, [UIntPtr]::Zero); $t::keybd_event([byte]$env:HOUSE_VK, 0, 3, [UIntPtr]::Zero) }`;
const MEDIA = { volup: [0xaf, 5], voldown: [0xae, 5], mute: [0xad, 1], playpause: [0xb3, 1], next: [0xb0, 1], prev: [0xb1, 1] };

const IDLE_PS = `Add-Type @'
using System; using System.Runtime.InteropServices;
public class HouseIdle { [StructLayout(LayoutKind.Sequential)] struct L { public uint cbSize; public uint dwTime; }
[DllImport("user32.dll")] static extern bool GetLastInputInfo(ref L l);
public static uint Seconds() { L l = new L(); l.cbSize = (uint)Marshal.SizeOf(l); GetLastInputInfo(ref l); return ((uint)Environment.TickCount - l.dwTime) / 1000; } }
'@
[HouseIdle]::Seconds()`;
async function idleSeconds() {
  try { return +(await ps(IDLE_PS)) || 0; } catch { return null; }
}

const DISKS_PS = `Get-CimInstance Win32_LogicalDisk -Filter "DriveType=3" | ForEach-Object { [pscustomobject]@{ name = $_.DeviceID; size = [double]$_.Size; free = [double]$_.FreeSpace } } | ConvertTo-Json -Compress`;
const APPS_PS = `Get-Process | Where-Object { $_.MainWindowTitle -and $_.MainWindowHandle -ne 0 } | ForEach-Object { [pscustomobject]@{ pid = $_.Id; name = $_.ProcessName; title = $_.MainWindowTitle } } | ConvertTo-Json -Compress`;
const CLOSE_PS = `$p = Get-Process -Id ([int]$env:HOUSE_PID) -ErrorAction Stop; if ($p.CloseMainWindow()) { 'asked' } else { 'no-window' }`;
const MSG_PS = `Add-Type -AssemblyName System.Windows.Forms
[System.Windows.Forms.MessageBox]::Show($env:HOUSE_MSG, 'House', 'OK', 'Information', 'Button1', 'DefaultDesktopOnly') | Out-Null`;
const PAIR_PS = `Add-Type -AssemblyName System.Windows.Forms
$r = [System.Windows.Forms.MessageBox]::Show('A phone at ' + $env:HOUSE_FROM + ' wants to control this PC with the House app (power, volume, programs, screenshots).' + [Environment]::NewLine + [Environment]::NewLine + 'Allow it?', 'House', 'YesNo', 'Question', 'Button2', 'DefaultDesktopOnly')
if ($r -eq 'Yes') { exit 0 } else { exit 1 }`;
const NIGHT_PS = `Add-Type -AssemblyName System.Windows.Forms
$r = [System.Windows.Forms.MessageBox]::Show('This PC shuts down in 2 minutes (House nightly shutdown).' + [Environment]::NewLine + [Environment]::NewLine + 'Press Cancel to keep it on.', 'House', 'OKCancel', 'Warning', 'Button2', 'DefaultDesktopOnly')
if ($r -eq 'Cancel') { shutdown.exe /a }`;

// CPU use over half a second, from Node's own counters.
function cpuUse() {
  const t = () => os.cpus().reduce((a, c) => { const v = Object.values(c.times); a.total += v.reduce((x, y) => x + y, 0); a.idle += c.times.idle; return a; }, { total: 0, idle: 0 });
  const a = t();
  return new Promise((r) => setTimeout(() => { const b = t(); r(Math.round(100 * (1 - (b.idle - a.idle) / Math.max(1, b.total - a.total)))); }, 500));
}

/* ---- Pairing ---- */

function askToPair(from) {
  return new Promise((resolve) => {
    const p = spawn("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-WindowStyle", "Hidden", "-Command", PAIR_PS],
      { env: { ...process.env, HOUSE_FROM: from } });
    const t = setTimeout(() => { p.kill(); resolve(false); }, 60000);
    p.on("exit", (code) => { clearTimeout(t); resolve(code === 0); });
    p.on("error", () => { clearTimeout(t); resolve(false); });
  });
}

/* ---- Power ---- */

const POWER = {
  shutdown: ["shutdown.exe", ["/s", "/t", "10", "/c", "Shutting down from the House app"]],
  restart: ["shutdown.exe", ["/r", "/t", "10", "/c", "Restarting from the House app"]],
  cancel: ["shutdown.exe", ["/a"]],
  lock: ["rundll32.exe", ["user32.dll,LockWorkStation"]],
  // Sleep (hibernate instead if hibernation is turned on in Windows).
  sleep: ["rundll32.exe", ["powrprof.dll,SetSuspendState", "0,1,0"]],
};

/* ---- Nightly shutdown (checked every 30 s) ---- */

let nightDone = "";
async function nightly() {
  const n = settings().nightly || {};
  if (!n.on) return;
  const now = new Date();
  const hhmm = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
  const today = now.toDateString();
  if (hhmm !== n.time || nightDone === today) return;
  nightDone = today;
  const idle = await idleSeconds();
  if (idle != null && idle < (n.idleMin ?? 15) * 60) { log(`nightly shutdown skipped: used ${Math.round(idle / 60)} min ago`); return; }
  log("nightly shutdown: 2-minute warning");
  execFile("shutdown.exe", ["/s", "/t", "120", "/c", "House nightly shutdown in 2 minutes. Cancel it from the House app."], { windowsHide: true });
  psDetached(NIGHT_PS);
}
setInterval(() => nightly().catch((e) => log(`nightly: ${e.message}`)), 30000);

/* ---- Server ---- */

let pairing = false;
let fails = 0, failsAt = 0;

function send(res, code, body) {
  res.writeHead(code, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  res.end(JSON.stringify(body));
}

function body(req) {
  return new Promise((resolve) => {
    let b = "";
    req.on("data", (c) => { b += c; if (b.length > 16384) req.destroy(); });
    req.on("end", () => { try { resolve(JSON.parse(b || "{}")); } catch { resolve({}); } });
  });
}

async function apps() {
  const out = await ps(APPS_PS);
  const list = out ? JSON.parse(out) : [];
  return (Array.isArray(list) ? list : [list]).filter((a) => !/^(TextInputHost|ApplicationFrameHost|SystemSettings)$/i.test(a.name));
}

const server = http.createServer(async (req, res) => {
  const from = String(req.socket.remoteAddress || "").replace(/^::ffff:/, "");
  if (!isLocal(from)) return send(res, 403, { error: "Home network only" });
  const url = new URL(req.url, "http://x");
  try {
    // Anyone at home may see that the helper is here (no key needed).
    if (req.method === "GET" && url.pathname === "/hello") {
      return send(res, 200, { app: "house-pc", version: VERSION, name: os.hostname(), ...lan() });
    }

    if (req.method === "POST" && url.pathname === "/pair") {
      if (pairing) return send(res, 429, { error: "Already asking on the PC" });
      pairing = true;
      log(`pair asked by ${from}`);
      const ok = await askToPair(from);
      pairing = false;
      log(`pair ${ok ? "allowed" : "refused"} for ${from}`);
      return ok ? send(res, 200, { key: key(), name: os.hostname(), version: VERSION, ...lan() }) : send(res, 403, { error: "Not allowed on the PC" });
    }

    // Everything else needs the key. Too many wrong keys: wait a minute.
    if (fails >= 5 && Date.now() - failsAt < 60000) return send(res, 429, { error: "Too many tries, wait a minute" });
    if (!sameKey(req.headers["x-house-key"], key())) {
      fails = Date.now() - failsAt > 60000 ? 1 : fails + 1;
      failsAt = Date.now();
      return send(res, 401, { error: "Not paired with this PC" });
    }
    fails = 0;

    if (req.method === "GET" && url.pathname === "/status") {
      const full = url.searchParams.get("full") === "1";
      const base = { name: os.hostname(), version: VERSION, uptime: Math.round(os.uptime()), user: os.userInfo().username, ...lan() };
      if (!full) return send(res, 200, base);
      const [cpu, disks, idle] = await Promise.all([cpuUse(), ps(DISKS_PS).catch(() => "[]"), idleSeconds()]);
      const d = disks ? JSON.parse(disks) : [];
      return send(res, 200, { ...base, cpu, mem: Math.round(100 * (1 - os.freemem() / os.totalmem())), memTotal: os.totalmem(), disks: Array.isArray(d) ? d : [d], idle });
    }

    if (req.method === "POST" && url.pathname === "/cmd") {
      const { action } = await body(req);
      if (POWER[action]) {
        log(`${action} from ${from}`);
        // Answer first: sleep and shutdown take the network down with them.
        send(res, 200, { ok: true, action });
        setTimeout(() => execFile(POWER[action][0], POWER[action][1], { windowsHide: true }, (err) => { if (err && action !== "cancel") log(`${action} failed: ${err.message}`); }), 300);
        return;
      }
      if (MEDIA[action]) {
        await ps(KEYS_PS, { HOUSE_VK: String(MEDIA[action][0]), HOUSE_TIMES: String(MEDIA[action][1]) });
        return send(res, 200, { ok: true, action });
      }
      return send(res, 400, { error: "Unknown action" });
    }

    if (req.method === "GET" && url.pathname === "/apps") return send(res, 200, { apps: await apps() });

    if (req.method === "POST" && url.pathname === "/close") {
      const { pid, force } = await body(req);
      // Only programs with a window (the list the app shows), never system processes.
      const app = (await apps()).find((a) => a.pid === +pid);
      if (!app) return send(res, 404, { error: "That program isn't open any more" });
      log(`close ${app.name} (${force ? "force" : "ask"}) from ${from}`);
      if (force) process.kill(app.pid);
      else await ps(CLOSE_PS, { HOUSE_PID: String(app.pid) });
      return send(res, 200, { ok: true });
    }

    if (req.method === "POST" && url.pathname === "/message") {
      const { text } = await body(req);
      const t = String(text || "").slice(0, 500).trim();
      if (!t) return send(res, 400, { error: "Type a message" });
      log(`message from ${from}`);
      psDetached(MSG_PS, { HOUSE_MSG: t });
      return send(res, 200, { ok: true });
    }

    if (req.method === "GET" && url.pathname === "/screenshot") {
      log(`screenshot from ${from}`);
      const exe = path.join(DIR, "house-shot.exe");
      if (!fs.existsSync(exe)) return send(res, 501, { error: "Screenshots aren't set up on this PC (run install.ps1 again)" });
      try {
        const b64 = await new Promise((resolve, reject) => execFile(exe, [], { windowsHide: true, timeout: 30000, maxBuffer: 32 * 1024 * 1024 },
          (err, out, errOut) => (err ? reject(new Error((errOut || err.message).trim())) : resolve(out.trim()))));
        return send(res, 200, { image: "data:image/jpeg;base64," + b64, at: Date.now() });
      } catch (e) {
        log(`screenshot failed: ${e.message}`);
        return send(res, 409, { error: "Couldn't take it (the PC may be locked)" });
      }
    }

    if (url.pathname === "/settings") {
      if (req.method === "POST") {
        const b = await body(req), s = settings();
        if (b.nightly) {
          const time = /^\d{2}:\d{2}$/.test(b.nightly.time || "") ? b.nightly.time : s.nightly?.time || "02:00";
          s.nightly = { on: !!b.nightly.on, time, idleMin: Math.max(0, Math.min(120, +b.nightly.idleMin || 15)) };
          nightDone = "";
        }
        saveSettings(s);
        log(`settings from ${from}: ${JSON.stringify(s)}`);
      }
      return send(res, 200, settings());
    }

    send(res, 404, { error: "Not found" });
  } catch (e) {
    log(`${url.pathname} failed: ${e.message}`);
    send(res, 500, { error: e.message });
  }
});

server.on("error", (e) => { log(`server error: ${e.message}`); process.exit(1); });
server.listen(PORT, "0.0.0.0", () => { key(); log(`listening on ${PORT} (v${VERSION})`); });
