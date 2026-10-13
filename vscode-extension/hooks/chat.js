#!/usr/bin/env node
// Yemot Hooks — chat with Claude by phone. The caller dials the chat extension, records a message (transcribed by
// Claude's dictation service) or types it on the keypad; Claude works on it in a folder of yours (`claude -p`), and
// the answer is read out. Claude's questions, permissions and plans are asked on the same call.
//
// The bridge server (main.py, /chat/*) runs the call: it plays a "screen" — text to say, then what to collect
// (digits · typed text · a recording · nothing) — and passes back what the caller entered. This process long-polls
// those events (/chat/poll) and sends the screens (/chat/screen); between them the caller hears hold music.
//
//   node ~/.claude/yemot-hooks/chat.js        (the VS Code extension starts it while yemotHooks.chat.enabled)
// One instance (state/chat.pid). Settings: config.json "chat" (written by the extension); token: YEMOT_TOKEN.
"use strict";
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const https = require("https");
const crypto = require("crypto");
const { spawn, spawnSync } = require("child_process");

const DIR = process.env.YEMOT_HOOKS_DIR || path.join(os.homedir(), ".claude", "yemot-hooks");
const CONFIG = path.join(DIR, "config.json");
const LOG = path.join(DIR, "hook.log");
const STATE = path.join(DIR, "state");
const PID = path.join(STATE, "chat.pid");
const SESSIONS = path.join(STATE, "chat-sessions.json");
const GENERAL = path.join(DIR, "chat-general"); // a conversation outside every project
const YEMOT_API = () => process.env.YEMOT_HOOKS_API || "https://www.call2all.co.il/ym/api/";
const CLAUDE_STT = () => process.env.YEMOT_HOOKS_STT_URL || "wss://api.anthropic.com/api/ws/speech_to_text/voice_stream";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ------------------------------------------------------------------ utils
function log(...parts) {
  try {
    fs.mkdirSync(DIR, { recursive: true });
    try { if (fs.statSync(LOG).size > 256 * 1024) fs.renameSync(LOG, LOG + ".1"); } catch {}
    fs.appendFileSync(LOG, `${new Date().toISOString()} chat ${parts.map((p) => (typeof p === "string" ? p : JSON.stringify(p))).join(" ")}\n`);
  } catch {}
}
const readJson = (f, d = null) => { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return d; } };
const writeJson = (f, o) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify(o), { mode: 0o600 }); };
const normPhone = (p) => { let d = String(p || "").replace(/\D/g, ""); if (d.startsWith("972")) d = "0" + d.slice(3); return d; };
const normIvr = (p) => String(p || "").trim().replace(/^ivr2:/i, "").replace(/^\/+|\/+$/g, "");
const home = () => process.env.HOME || process.env.USERPROFILE || os.homedir();

/** The chat settings (config.json "chat", written by the extension), with defaults. */
function config() {
  const c = readJson(CONFIG, {}) || {}, ch = c.chat || {};
  return {
    serverUrl: String(c.serverUrl || "").replace(/\/+$/, ""), tzintukTimeout: c.tzintukTimeout || 9, callerId: c.callerId || "",
    enabled: !!ch.enabled, ivrPath: normIvr(ch.ivrPath), phones: (ch.phones || []).map(normPhone).filter(Boolean), pin: String(ch.pin || "").trim(),
    projects: (ch.projects || []).map((p) => String(p).trim().replace(/^~(?=$|[\\/])/, home())).filter(Boolean), defaultProject: String(ch.defaultProject || ""),
    general: ch.general !== false, permissionMode: ch.permissionMode || "default", model: ch.model || "", claudePath: ch.claudePath || "",
    confirm: ch.confirm !== false, hint: ch.hint !== false, missedTzintuk: ch.missedTzintuk !== false, maxSpeak: Math.max(200, +ch.maxSpeak || 1500),
    maxMinutes: Math.max(1, +ch.maxMinutes || 30), askMinutes: Math.max(1, +ch.askMinutes || 10),
  };
}
/** YEMOT_TOKEN: the environment, else the env block of ~/.claude/settings.json (where the extension keeps it). */
function token() {
  if (process.env.YEMOT_TOKEN) return process.env.YEMOT_TOKEN;
  return readJson(path.join(home(), ".claude", "settings.json"), {})?.env?.YEMOT_TOKEN || "";
}
const connected = (c) => !!(c.enabled && c.serverUrl && c.ivrPath && token());

function request(method, url, body, ms = 20000) {
  return new Promise((resolve, reject) => {
    const u = new URL(url), lib = u.protocol === "https:" ? https : http;
    const data = body === undefined ? null : Buffer.from(JSON.stringify(body), "utf8");
    const req = lib.request(u, { method, timeout: ms, headers: data ? { "Content-Type": "application/json; charset=utf-8", "Content-Length": data.length } : {} }, (res) => {
      const chunks = []; res.on("data", (d) => chunks.push(d));
      res.on("end", () => { const buf = Buffer.concat(chunks); let json = null; try { json = JSON.parse(buf.toString("utf8")); } catch {} resolve({ code: res.statusCode, buf, json, type: res.headers["content-type"] || "" }); });
    });
    req.on("timeout", () => req.destroy(new Error(`timeout (${u.pathname})`)));
    req.on("error", reject);
    req.end(data || undefined);
  });
}

// ------------------------------------------------------------------ Yemot: recordings, tzintuk
async function download(p) {
  const u = new URL(YEMOT_API() + "DownloadFile");
  u.searchParams.set("token", token()); u.searchParams.set("path", "ivr2:/" + p);
  const r = await request("GET", u.toString(), undefined, 60000);
  if (r.code !== 200 || /json/.test(r.type)) throw new Error(`הורדה מימות: ${r.json?.message || "HTTP " + r.code}`);
  return r.buf;
}
function deleteFile(p) {
  const u = new URL(YEMOT_API() + "FileAction");
  u.searchParams.set("token", token()); u.searchParams.set("action", "delete"); u.searchParams.set("what", "ivr2:/" + p);
  return request("GET", u.toString()).catch((e) => log("WARN delete recording", e.message));
}
async function tzintuk(c, phone, why) {
  try {
    const body = { token: token(), phones: normPhone(phone), TzintukTimeOut: Math.min(Math.max(+c.tzintukTimeout || 9, 1), 16), ...(c.callerId ? { callerId: c.callerId } : {}) };
    const r = await request("POST", YEMOT_API() + "RunTzintuk", body);
    log(r.json?.responseStatus === "OK" ? "tzintuk" : "ERROR tzintuk", why, r.json?.message || "");
  } catch (e) { log("ERROR tzintuk", why, e.message); }
}

// ------------------------------------------------------------------ transcription (Claude's dictation service)
// The service the mic button of Claude Code uses, signed in with the Claude Code login on this computer. A Yemot
// recording is WAV (PCM 16 bit, 8 kHz mono): its samples go as they are (linear16). Needs Node 22 (WebSocket).
function claudeLogin() {
  let o; try { o = JSON.parse(fs.readFileSync(path.join(process.env.CLAUDE_CONFIG_DIR || path.join(home(), ".claude"), ".credentials.json"), "utf8")).claudeAiOauth; } catch {}
  return { token: o?.accessToken, expired: !!(o?.expiresAt && o.expiresAt < Date.now() + 60e3) };
}
/** An expired login renews itself on any run of Claude Code: a tiny one. */
function renewLogin(c) {
  return new Promise((resolve) => {
    const p = spawn(claudeBin(c), ["-p", "ok", "--model", "haiku", "--max-turns", "1", "--no-session-persistence"], { cwd: os.tmpdir(), env: { ...process.env, YEMOT_HOOKS_CHAT: "1" }, stdio: "ignore" });
    const t = setTimeout(() => p.kill("SIGKILL"), 90000);
    p.on("error", () => {}); p.on("close", () => { clearTimeout(t); resolve(); });
  });
}
function wavPcm(buf) {
  let p = 12, fmt = null, data = null;
  while (p + 8 <= buf.length) {
    const id = buf.toString("latin1", p, p + 4), n = buf.readUInt32LE(p + 4);
    if (id === "fmt ") fmt = buf.subarray(p + 8, p + 8 + n); else if (id === "data") data = buf.subarray(p + 8, Math.min(buf.length, p + 8 + n));
    p += 8 + n + (n & 1);
  }
  if (buf.toString("latin1", 0, 4) !== "RIFF" || !fmt || !data || fmt.readUInt16LE(0) !== 1 || fmt.readUInt16LE(14) !== 16) throw new Error("ההקלטה אינה WAV של 16 ביט");
  const packets = [];
  for (let i = 0; i < data.length; i += 3200) packets.push(data.subarray(i, i + 3200));
  return { packets, channels: fmt.readUInt16LE(2), rate: fmt.readUInt32LE(4) };
}
async function transcribe(c, buf) {
  if (typeof WebSocket !== "function") throw new Error("התמלול דורש Node 22 ומעלה");
  if (claudeLogin().expired) await renewLogin(c);
  const { token: auth, expired } = claudeLogin();
  if (!auth || expired) throw new Error("אין התחברות תקפה של Claude Code במחשב (claude /login)");
  const { packets, channels, rate } = wavPcm(buf);
  const q = new URLSearchParams({ encoding: "linear16", sample_rate: String(rate), channels: String(channels), endpointing_ms: "300", utterance_end_ms: "1000", language: "he", use_conversation_engine: "true" });
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${CLAUDE_STT()}?${q}`, { headers: { Authorization: `Bearer ${auth}`, "x-app": "cli" } });
    const done = []; let last = "", error = "";
    const t = setTimeout(() => { try { ws.close(); } catch {} reject(new Error("תמלול: timeout")); }, 120000);
    ws.onopen = () => { ws.send(JSON.stringify({ type: "KeepAlive" })); for (const p of packets) ws.send(p); ws.send(JSON.stringify({ type: "CloseStream" })); };
    ws.onmessage = (e) => {
      let m; try { m = JSON.parse(String(e.data)); } catch { return; }
      if ((m.type === "TranscriptText" || m.type === "TranscriptInterim") && m.data) last = m.data;
      else if (m.type === "TranscriptEndpoint" && last) { done.push(last); last = ""; }
      else if (m.type === "TranscriptError" || m.type === "error") error = m.description || m.message || "שגיאת תמלול";
    };
    ws.onerror = (e) => { if (!error) error = e.message || "החיבור לשירות התמלול נכשל"; };
    ws.onclose = () => { clearTimeout(t); if (last) done.push(last); if (!done.length && error) return reject(new Error(`תמלול: ${error}`)); resolve(done.join(" ").trim()); };
  });
}

// ------------------------------------------------------------------ text → speech
const ENT = { amp: "&", lt: "<", gt: ">", quot: '"', "#39": "'", nbsp: " " };
/** Markdown → words to read out: no code, no links, no symbols. */
function speech(text) {
  return String(text || "")
    .replace(/```[\s\S]*?(```|$)/g, " (קוד) ").replace(/<[^>]+>/g, "").replace(/&(amp|lt|gt|quot|#39|nbsp);/g, (_, e) => ENT[e])
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1").replace(/https?:\/\/\S+/g, "קישור")
    .replace(/`([^`]*)`/g, "$1").replace(/^\s*#+\s*/gm, "").replace(/^\s*[-*•]\s+/gm, "").replace(/\|/g, " ")
    .replace(/[*_~>#=]+/g, " ").replace(/[^\p{L}\p{N}\s.,:;?!%/()\-'"]/gu, " ")
    .replace(/[ \t]+/g, " ").replace(/\s*\n\s*/g, ". ").replace(/(\.\s*){2,}/g, ". ").trim();
}
const clipSpeech = (s, n) => (s.length <= n ? s : s.slice(0, s.lastIndexOf(" ", n) > n * 0.7 ? s.lastIndexOf(" ", n) : n) + ". התשובה ארוכה, וזה החלק הראשון שלה");

// ------------------------------------------------------------------ the bridge
async function bridge(c, ep, body, ms = 20000) {
  const r = await request("POST", `${c.serverUrl}/chat/${ep}`, body, ms);
  if (r.code !== 200 || !r.json) throw new Error(`שרת הגישור (${ep}): HTTP ${r.code}${r.code === 404 ? " — אין בו צ'אט טלפוני (עדכן את main.py)" : ""}`);
  return r.json;
}
/** A screen for the call, after the ones before it (they play in order). */
function show(call, s) {
  call.chain = call.chain.then(() => (call.gone ? null : bridge(config(), "screen", { call: call.id, ...s })))
    .then((r) => { if (r && r.ok === false) call.gone = true; })
    .catch((e) => log("ERROR screen", e.message));
  return call.chain;
}
const say = (call, text) => show(call, { say: text, input: "none" });
const digits = (call, text, values, { max = 1, min = 1, timeout = 15 } = {}) => show(call, { say: text, input: "digits", values, max, min, timeout });

// ------------------------------------------------------------------ projects and sessions
/** The folders a caller may work in: the list (names = folder names) and "כללי" (an empty folder of its own). */
function projects(c) {
  const ps = c.projects.filter((p) => { try { return fs.statSync(p).isDirectory(); } catch { return false; } }).map((p) => ({ name: path.basename(path.resolve(p)), path: path.resolve(p) }));
  if (c.general) { fs.mkdirSync(GENERAL, { recursive: true }); ps.push({ name: "כללי", path: GENERAL, general: true }); }
  const def = ps.find((p) => p.name === c.defaultProject);
  return def ? [def, ...ps.filter((p) => p !== def)] : ps;
}
const sessions = () => readJson(SESSIONS, { phones: {} });
const current = (phone) => sessions().phones[phone] || null;
function claudeBin(c) {
  if (c.claudePath && fs.existsSync(c.claudePath)) return c.claudePath;
  const w = spawnSync(process.platform === "win32" ? "where" : "which", ["claude"], { encoding: "utf8" });
  return (w.stdout || "").split(/\r?\n/)[0].trim() || "claude";
}
const HINT = "[הודעה מהטלפון. התשובה תוקרא בקול: כתוב אותה בקצרה, במשפטים פשוטים, בלי קוד, טבלאות וקישורים.]";
const running = new Map(); // phone → the claude process of its turn

/** One turn of the caller's conversation: `claude -p` in its folder, resumed by session id. Claude's requests to use
 *  a tool (--permission-prompt-tool stdio) are asked on the call: questions, plans, permissions. → the answer text. */
function turn(c, phone, text, project) {
  const S = sessions();
  let x = S.phones[phone];
  if (project || !x) {
    const p = project || projects(c)[0];
    if (!p) return Promise.resolve("אין תיקייה לעבוד בה. הגדר פרויקטים לצ'אט הטלפוני.");
    x = S.phones[phone] = { sid: crypto.randomUUID(), cwd: p.path, project: p.general ? "כללי" : p.name, title: text.slice(0, 60), started: false };
  }
  const resume = x.started;
  x.started = true; x.at = Date.now(); writeJson(SESSIONS, S);
  const args = ["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", "--permission-mode", c.permissionMode, "--permission-prompt-tool", "stdio", resume ? "--resume" : "--session-id", x.sid];
  if (c.model) args.push("--model", c.model);
  log("turn", phone, x.project, resume ? "resume" : "new");
  return new Promise((resolve) => {
    let result = null, buf = "", stderr = "";
    const child = spawn(claudeBin(c), args, { cwd: x.cwd, env: { ...process.env, YEMOT_HOOKS_CHAT: "1" }, stdio: ["pipe", "pipe", "pipe"] });
    running.set(phone, child);
    const write = (m) => { try { child.stdin.write(JSON.stringify(m) + "\n"); } catch {} };
    const respond = (id, response) => write({ type: "control_response", response: { subtype: "success", request_id: id, response } });
    const killer = setTimeout(() => { log("turn timeout", phone); child.kill("SIGKILL"); }, c.maxMinutes * 60e3);
    child.stdin.on("error", () => {});
    child.on("error", (e) => { stderr += e.message; });
    child.stderr.setEncoding("utf8"); child.stderr.on("data", (d) => { stderr = (stderr + d).slice(-1500); });
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (d) => {
      buf += d; let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        let e; try { e = JSON.parse(line); } catch { continue; }
        if (e.type === "control_request" && e.request?.subtype === "can_use_tool") toolRequest(c, phone, e, respond, () => child.exitCode === null);
        else if (e.type === "control_request") write({ type: "control_response", response: { subtype: "error", request_id: e.request_id, error: `unsupported: ${e.request?.subtype}` } });
        else if (e.type === "result") { result = e; try { child.stdin.end(); } catch {} }
      }
    });
    child.on("close", () => {
      clearTimeout(killer); running.delete(phone);
      for (const [id, a] of asks) if (a.phone === phone) { asks.delete(id); a.done(null); }
      if (result) return resolve(result.is_error ? `הסתיים עם שגיאה. ${result.result || ""}` : String(result.result || "").trim() || "קלוד סיים, בלי טקסט");
      log("ERROR turn ended without a result", stderr.slice(-300));
      resolve("הריצה נכשלה.");
    });
    write({ type: "user", message: { role: "user", content: text + (c.hint ? `\n\n${HINT}` : "") }, parent_tool_use_id: null, session_id: x.sid });
  });
}
/** Claude asks to use a tool: a question, a plan, or a permission — asked on the call. */
async function toolRequest(c, phone, e, respond, alive) {
  const q = e.request, input = q.input || {};
  const deny = (message) => respond(e.request_id, { behavior: "deny", message });
  if (q.tool_name === "AskUserQuestion") {
    const qs = (input.questions || []).slice(0, 4);
    const a = await ask(phone, { kind: "question", questions: qs.map((x) => ({ question: String(x.question || ""), options: (x.options || []).map((o) => String(o.label || "")) })) }, alive, c);
    return a ? respond(e.request_id, { behavior: "allow", updatedInput: { ...input, answers: a.answers } }) : deny("The user did not answer the question.");
  }
  if (q.tool_name === "ExitPlanMode") {
    const a = await ask(phone, { kind: "plan", text: String(input.plan || "") }, alive, c);
    if (!a || a.v === "no") return deny(a?.change ? `The user wants changes to the plan: ${a.change}` : "The user rejected this. Stop and wait for the user's instructions.");
    return respond(e.request_id, { behavior: "allow", updatedInput: input, ...(a.v === "auto" ? { updatedPermissions: [{ type: "setMode", mode: "acceptEdits", destination: "session" }] } : {}) });
  }
  const detail = String(input.command || input.file_path || input.url || input.description || "").slice(0, 200);
  const a = await ask(phone, { kind: "permission", text: `${q.display_name || q.tool_name} ${detail}`.trim() }, alive, c);
  return a === "allow" ? respond(e.request_id, { behavior: "allow", updatedInput: input }) : deny("Not approved by the user on the phone.");
}

// ------------------------------------------------------------------ calls
const calls = new Map(); // call id → {id, phone, stage, chain, …}
const ofPhone = (phone) => [...calls.values()].find((x) => x.phone === String(phone) && !x.gone);
const UNHEARD = (phone) => path.join(STATE, `chat-unheard-${normPhone(phone)}.json`);
const LAST = (phone) => path.join(STATE, `chat-last-${normPhone(phone)}.json`);

async function onEvent(c, e) {
  if (e.type === "start") return start(c, e);
  const call = calls.get(e.call);
  if (!call) return;
  if (e.type === "hangup") { call.gone = true; calls.delete(call.id); log("hangup", call.phone); return; }
  if (e.type === "input") return input(call, String(e.value ?? "").trim()).catch((err) => { log("ERROR", err.message); return menu(call, "אירעה שגיאה. "); });
}
async function start(c, e) {
  const phone = normPhone(e.phone);
  const call = { id: e.call, phone, stage: "", chain: Promise.resolve(), tries: 0 };
  calls.set(call.id, call);
  if (!c.phones.includes(phone)) {
    log("refused: phone not on the list —", phone || "(hidden)");
    return show(call, { say: "המספר שלך לא מורשה לשיחה עם קלוד", input: "hangup" });
  }
  log("call from", phone);
  if (c.pin) { call.stage = "pin"; return digits(call, "הקש את קוד הגישה ובסיומו סולמית", "", { max: 12, min: 1, timeout: 20 }); }
  return welcome(call);
}
function welcome(call) {
  const u = readJson(UNHEARD(call.phone));
  if (u) { fs.rmSync(UNHEARD(call.phone), { force: true }); return menu(call, `יש תשובה חדשה מקלוד. ${u.text}. `); }
  return menu(call, "שלום. ");
}
function menu(call, prefix = "") {
  prefix = (call.queued || "") + prefix; call.queued = "";
  if ([...asks.values()].some((a) => a.phone === call.phone)) { // Claude waits for an answer: that first, then the menu
    call.stage = "busy"; call.back = true;
    if (prefix) say(call, prefix);
    setImmediate(tick);
    return call.chain;
  }
  call.stage = "menu"; call.next = null; call.back = false;
  const cur = current(call.phone);
  const where = (cur ? `השיחה הנוכחית: ${cur.title || "בלי שם"}, בפרויקט ${cur.project}. ` : "") + (running.has(call.phone) ? "קלוד עדיין עובד על ההודעה הקודמת. " : "");
  return digits(call, `${prefix}${where}להקלטת הודעה לקלוד הקש 1. להקלדה הקש 2. ${cur ? "לשמיעת התשובה האחרונה הקש 3. " : ""}לשיחה חדשה הקש 4. לסיום הקש 9.`, cur ? "12349" : "1249");
}
const record = (call, text = "הקלט את ההודעה אחרי הצליל, ובסיום הקש סולמית") => { call.stage = "record"; return show(call, { say: text, input: "record" }); };
const typing = (call) => { call.stage = "text"; return show(call, { say: "הקלד את ההודעה ובסיומה סולמית", input: "text", max: 400 }); };
const how = (call) => { call.stage = "how"; return digits(call, `שיחה חדשה ב${call.next.general ? "שיחה כללית" : `פרויקט ${call.next.name}`}. להקלטת ההודעה הקש 1. להקלדה הקש 2.`, "12*"); };

async function input(call, v) {
  const c = config();
  if (call.ask) return answerAsk(call, v);
  switch (call.stage) {
    case "pin":
      if (v && v === c.pin) return welcome(call);
      if (++call.tries >= 3) return show(call, { say: "קוד שגוי", input: "hangup" });
      return digits(call, "קוד שגוי. הקש שוב ובסיומו סולמית", "", { max: 12, min: 1, timeout: 20 });
    case "menu":
      if (!v) { if (++call.tries >= 3) return show(call, { say: "להתראות", input: "hangup" }); return menu(call); }
      call.tries = 0;
      if (v === "1") return record(call);
      if (v === "2") return typing(call);
      if (v === "3") { const l = readJson(LAST(call.phone)); return menu(call, l ? `${l.text}. ` : "אין עדיין תשובה. "); }
      if (v === "4") {
        const ps = projects(c).slice(0, 9);
        if (!ps.length) return menu(call, "אין פרויקטים. ");
        if (ps.length === 1) { call.next = ps[0]; return how(call); }
        call.stage = "project"; call.list = ps;
        return digits(call, "באיזה פרויקט? " + ps.map((p, i) => `ל${p.general ? "שיחה כללית" : `פרויקט ${p.name}`} הקש ${i + 1}.`).join(" ") + " לחזרה הקש כוכבית.", ps.map((_, i) => i + 1).join("") + "*");
      }
      return show(call, { say: "להתראות", input: "hangup" });
    case "project": {
      const p = call.list[+v - 1];
      if (!p) return menu(call);
      call.next = p;
      return how(call);
    }
    case "how":
      if (v === "1") return record(call);
      if (v === "2") return typing(call);
      return menu(call);
    case "record": return recorded(call, v);
    case "text": return v ? send(call, v) : menu(call, "לא הוקלד טקסט. ");
    case "confirm":
      if (v === "1") return send(call, call.heard);
      if (v === "2") return record(call, "הקלט שוב אחרי הצליל, ובסיום הקש סולמית");
      return menu(call, "ההודעה בוטלה. ");
    default: return menu(call);
  }
}
/** A recording's path as Yemot sent it → its text. Only from the extension's rec folder (it is downloaded and then
 *  deleted: a request must not point at any other file of the IVR). "" = nothing usable. */
async function heard(c, value) {
  const rel = String(value).replace(/^ivr2:/, "").replace(/^\/+/, "");
  if (path.posix.dirname(rel) !== `${c.ivrPath}/rec` || !/^[\w-]+\.wav$/.test(path.posix.basename(rel))) return null;
  const buf = await download(rel);
  deleteFile(rel);
  return transcribe(c, buf);
}
async function recorded(call, value) {
  const c = config();
  let text;
  try { text = await heard(c, value); }
  catch (e) { log("ERROR transcription", e.message); return menu(call, "התמלול נכשל. "); }
  if (text === null) { if (++call.tries >= 2) return menu(call, "ההקלטה לא נקלטה. "); return record(call, "ההקלטה לא נקלטה. הקלט שוב אחרי הצליל, ובסיום הקש סולמית"); }
  call.tries = 0;
  log("transcribed", text.length, "chars");
  if (!text) return record(call, "לא שמעתי דיבור. הקלט שוב אחרי הצליל, ובסיום הקש סולמית");
  if (!c.confirm) return send(call, text);
  call.stage = "confirm"; call.heard = text;
  return digits(call, `שמעתי: ${text}. לשליחה הקש 1. להקלטה מחדש הקש 2. לביטול הקש 3.`, "123");
}
async function send(call, text) {
  const c = config(), project = call.next;
  call.stage = "busy"; call.next = null;
  if (running.has(call.phone)) return say(call, "קלוד עדיין עובד על ההודעה הקודמת");
  await say(call, "ההודעה נשלחה לקלוד. ממתין לתשובה");
  deliver(c, call.phone, await turn(c, call.phone, text, project));
}
/** The answer: read out on the call (then the menu); after a hangup — a tzintuk, and read out at the next call. */
async function deliver(c, phone, text) {
  const said = clipSpeech(speech(text) || "קלוד סיים, בלי טקסט", c.maxSpeak);
  writeJson(LAST(phone), { text: said, at: Date.now() });
  const call = ofPhone(phone);
  if (call) {
    fs.rmSync(UNHEARD(phone), { force: true });
    if (call.stage === "busy" && !call.ask) return menu(call, `קלוד ענה: ${said}. `);
    call.queued = `קלוד ענה: ${said}. `;
    return;
  }
  writeJson(UNHEARD(phone), { text: said, at: Date.now() });
  log("answer after the hangup —", phone);
  if (c.missedTzintuk) await tzintuk(c, phone, "chat answer");
}

// ------------------------------------------------------------------ Claude asks the caller
// An ask: {id, phone, spec, done(answer)}. spec.kind: permission {text} · question {questions: [{question, options}]} ·
// plan {text}. Answers: permission "allow" / "deny" · question {answers} · plan {v: yes|auto|no, change?}; null = none.
const asks = new Map();
function ask(phone, spec, alive, c) {
  return new Promise((done) => {
    const id = crypto.randomBytes(4).toString("hex"), a = { id, phone, spec, alive, done, at: Date.now() };
    asks.set(id, a);
    setTimeout(() => { if (asks.get(id) === a) { asks.delete(id); done(null); } }, c.askMinutes * 60e3).unref?.();
    tick();
  });
}
/** One caller who waits (no read in flight: the bridge holds the call) is asked the next one. */
function tick() {
  for (const [id, a] of asks) if (a.alive && !a.alive()) { asks.delete(id); a.done(null); const c = ofPhone(a.phone); if (c?.ask === a) c.ask = null; }
  for (const a of asks.values()) {
    const c = ofPhone(a.phone);
    if (!c || c.ask || c.stage !== "busy") continue;
    if ([...asks.values()].some((b) => b.phone === a.phone && b.at < a.at)) continue; // the older one first
    c.ask = a; a.step = 0; a.answers = {};
    present(c);
  }
}
function present(call) {
  const a = call.ask, s = a.spec;
  if (s.kind === "permission") return digits(call, `קלוד מבקש הרשאה. ${speech(s.text)}. לאישור הקש 1. לדחייה הקש 2.`, "12", { timeout: 30 });
  if (s.kind === "plan") return digits(call, `קלוד מציע תוכנית. ${clipSpeech(speech(s.text), 1200)}. לאישור הקש 1. לאישור ועריכות בלי לשאול הקש 2. לדחייה הקש 3. לבקשת שינוי הקש 4.`, "1234", { timeout: 30 });
  const q = s.questions[a.step], n = Math.min(q.options.length, 7);
  return digits(call, `קלוד שואל. ${speech(q.question)}. ` + q.options.slice(0, n).map((o, i) => `ל${speech(o)} הקש ${i + 1}.`).join(" ") + " לתשובה אחרת בהקלטה הקש 8. בהקלדה הקש 9.", Array.from({ length: n }, (_, i) => i + 1).join("") + "89", { timeout: 30 });
}
async function answerAsk(call, v) {
  const a = call.ask, s = a.spec;
  if (!asks.has(a.id)) { call.ask = null; return call.back && !running.has(call.phone) ? menu(call) : say(call, "השאלה כבר לא פעילה"); }
  if (a.free) { // the free answer (recorded / typed)
    let text = v;
    if (a.free === "record") text = (await heard(config(), v).catch(() => "")) || "";
    a.free = "";
    if (!text) return present(call);
    if (s.kind === "plan") return finishAsk(call, { v: "no", change: text });
    a.answers[s.questions[a.step].question] = text;
    return nextQuestion(call);
  }
  if (!v) return present(call);
  if (s.kind === "permission") return finishAsk(call, v === "1" ? "allow" : "deny");
  if (s.kind === "plan") {
    if (v === "4") { a.free = "record"; return show(call, { say: "הקלט מה לשנות בתוכנית אחרי הצליל, ובסיום הקש סולמית", input: "record" }); }
    return finishAsk(call, { v: v === "1" ? "yes" : v === "2" ? "auto" : "no" });
  }
  if (v === "8") { a.free = "record"; return show(call, { say: "הקלט את התשובה אחרי הצליל, ובסיום הקש סולמית", input: "record" }); }
  if (v === "9") { a.free = "text"; return show(call, { say: "הקלד את התשובה ובסיומה סולמית", input: "text", max: 400 }); }
  const q = s.questions[a.step], o = q.options[+v - 1];
  if (!o) return present(call);
  a.answers[q.question] = o;
  return nextQuestion(call);
}
function nextQuestion(call) {
  const a = call.ask;
  if (++a.step < a.spec.questions.length) return present(call);
  return finishAsk(call, { answers: a.answers });
}
function finishAsk(call, answer) {
  const a = call.ask;
  call.ask = null; asks.delete(a.id);
  a.done(answer);
  log("answered on the phone:", a.spec.kind);
  setTimeout(tick, 200);
  if (call.back && !running.has(call.phone)) return menu(call, "תודה. ");
  return say(call, "תודה. ממשיך");
}

// ------------------------------------------------------------------ one instance, the loop
function alive(pid) { try { process.kill(pid, 0); return true; } catch { return false; } }
function takeLock() {
  const cur = readJson(PID);
  // the same version runs already: it stays. An older one (the extension was updated) leaves its loop when it sees this
  // file taken; its turns still running finish and are read out
  if (cur && cur.pid !== process.pid && alive(cur.pid) && cur.mtime === fs.statSync(__filename).mtimeMs) return false;
  writeJson(PID, { pid: process.pid, mtime: fs.statSync(__filename).mtimeMs, started: Date.now() });
  return true;
}
async function main() {
  if (!takeLock()) { log("already running — this one exits"); return; }
  const mine = fs.statSync(__filename).mtimeMs;
  const timer = setInterval(() => { try { tick(); } catch (e) { log("ERROR asks", e.message); } }, 1000);
  log("started");
  let quiet = 0;
  for (;;) {
    const c = config();
    // switched off, the file replaced by a new version, or another instance took over: this one ends
    if (!c.enabled || readJson(PID)?.pid !== process.pid || fs.statSync(__filename).mtimeMs !== mine) break;
    if (!connected(c)) { await sleep(5000); continue; }
    let events;
    try { events = (await bridge(c, "poll", { ext: c.ivrPath, wait: 20 }, 35000)).events || []; quiet = 0; }
    catch (e) { if (quiet++ % 20 === 0) log("ERROR bridge", e.message); await sleep(5000); continue; }
    for (const e of events) onEvent(c, e).catch((err) => log("ERROR", err.message));
  }
  clearInterval(timer);
  for (const ch of running.values()) ch.kill("SIGINT");
  if (readJson(PID)?.pid === process.pid) fs.rmSync(PID, { force: true });
  log("stopped");
}

module.exports = { speech, wavPcm, onEvent, tick, calls, config, PID };
if (require.main === module) main().catch((e) => { log("ERROR", (e && e.stack) || String(e)); process.exitCode = 1; });
