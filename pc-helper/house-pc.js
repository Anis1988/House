// House PC helper: lets the House app shut down, restart, sleep or lock this PC over the home
// network. Runs at sign-in (see install.ps1), with no window.
//
// - Answers only devices on the home network (private addresses), on port 47801.
// - Pairing: the app asks once, this PC shows "Allow House to control this PC?"; on Yes the
//   app gets a secret key, and every command after that must carry it.
// - Commands: shutdown, restart, sleep, lock, cancel (stops a pending shutdown/restart).
//
// Files (next to this script): key.txt (the secret), house-pc.log (what it did).

const http = require("http");
const os = require("os");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { execFile, spawn } = require("child_process");

const PORT = 47801;
const VERSION = 1;
const DIR = __dirname;
const KEY_FILE = path.join(DIR, "key.txt");
const LOG_FILE = path.join(DIR, "house-pc.log");

function log(msg) {
  try { fs.appendFileSync(LOG_FILE, `${new Date().toISOString()} ${msg}\n`); } catch {}
}

function key() {
  try { return fs.readFileSync(KEY_FILE, "utf8").trim(); } catch {}
  const k = crypto.randomBytes(24).toString("base64url");
  fs.writeFileSync(KEY_FILE, k);
  return k;
}

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

// Asks on screen before giving the app a key. Resolves true on Yes (no answer in 60 s = No).
function askToPair(from) {
  const script = `Add-Type -AssemblyName PresentationFramework; $r = [System.Windows.MessageBox]::Show('A phone at ${from} wants to control this PC (shut down, restart, sleep, lock) with the House app.' + [Environment]::NewLine + [Environment]::NewLine + 'Allow it?', 'House', 'YesNo', 'Question'); if ($r -eq 'Yes') { exit 0 } else { exit 1 }`;
  return new Promise((resolve) => {
    const p = spawn("powershell.exe", ["-NoProfile", "-WindowStyle", "Hidden", "-Command", script], { windowsHide: false });
    const t = setTimeout(() => { p.kill(); resolve(false); }, 60000);
    p.on("exit", (code) => { clearTimeout(t); resolve(code === 0); });
    p.on("error", () => { clearTimeout(t); resolve(false); });
  });
}

const ACTIONS = {
  shutdown: ["shutdown.exe", ["/s", "/t", "10", "/c", "Shutting down from the House app"]],
  restart: ["shutdown.exe", ["/r", "/t", "10", "/c", "Restarting from the House app"]],
  cancel: ["shutdown.exe", ["/a"]],
  lock: ["rundll32.exe", ["user32.dll,LockWorkStation"]],
  // Sleep (hibernate instead if hibernation is turned on in Windows).
  sleep: ["rundll32.exe", ["powrprof.dll,SetSuspendState", "0,1,0"]],
};

let pairing = false;
let fails = 0, failsAt = 0;

function send(res, code, body) {
  res.writeHead(code, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  res.end(JSON.stringify(body));
}

function body(req) {
  return new Promise((resolve) => {
    let b = "";
    req.on("data", (c) => { b += c; if (b.length > 4096) req.destroy(); });
    req.on("end", () => { try { resolve(JSON.parse(b || "{}")); } catch { resolve({}); } });
  });
}

const server = http.createServer(async (req, res) => {
  const from = String(req.socket.remoteAddress || "").replace(/^::ffff:/, "");
  if (!isLocal(from)) return send(res, 403, { error: "Home network only" });
  const url = new URL(req.url, "http://x");

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
    return ok ? send(res, 200, { key: key(), name: os.hostname(), ...lan() }) : send(res, 403, { error: "Not allowed on the PC" });
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
    return send(res, 200, { name: os.hostname(), uptime: Math.round(os.uptime()), user: os.userInfo().username, ...lan() });
  }
  if (req.method === "POST" && url.pathname === "/cmd") {
    const { action } = await body(req);
    const a = ACTIONS[action];
    if (!a) return send(res, 400, { error: "Unknown action" });
    log(`${action} from ${from}`);
    // Answer first: sleep and shutdown take the network down with them.
    send(res, 200, { ok: true, action });
    setTimeout(() => execFile(a[0], a[1], { windowsHide: true }, (err) => { if (err) log(`${action} failed: ${err.message}`); }), 300);
    return;
  }
  send(res, 404, { error: "Not found" });
});

server.on("error", (e) => { log(`server error: ${e.message}`); process.exit(1); });
server.listen(PORT, "0.0.0.0", () => { key(); log(`listening on ${PORT}`); });
