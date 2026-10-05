#!/usr/bin/env node
// Yemot Hooks — runtime for every Claude Code hook event.
// Usage (written into settings.json by the VS Code extension):
//   node ~/.claude/yemot-hooks/hook.js <permission|question|stop|subagent|prompt|clear>
// Reads the hook JSON on stdin and the live config from ~/.claude/yemot-hooks/config.json,
// so changing a setting in VS Code takes effect on the next hook without touching settings.json.
// Never throws at Claude: every failure is written to hook.log and the hook exits 0.
"use strict";
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const https = require("https");
const { spawn } = require("child_process");

const DIR = process.env.YEMOT_HOOKS_DIR || path.join(os.homedir(), ".claude", "yemot-hooks");
const CONFIG = path.join(DIR, "config.json");
const LOG = path.join(DIR, "hook.log");
const STATE = path.join(DIR, "state");
const YEMOT_API = process.env.YEMOT_HOOKS_API || "https://www.call2all.co.il/ym/api/";
const LOG_MAX = 256 * 1024;

// ------------------------------------------------------------------ utils
function log(...parts) {
  try {
    fs.mkdirSync(DIR, { recursive: true });
    try { if (fs.statSync(LOG).size > LOG_MAX) fs.renameSync(LOG, LOG + ".1"); } catch {}
    const line = `${new Date().toISOString()} ${parts.map((p) => (typeof p === "string" ? p : JSON.stringify(p))).join(" ")}\n`;
    fs.appendFileSync(LOG, line);
  } catch {}
}
function readConfig() {
  try { return JSON.parse(fs.readFileSync(CONFIG, "utf8")); } catch { return null; }
}
function safeId(s) { return String(s || "default").replace(/[^\w.-]/g, "_").slice(0, 80); }
function stateFile(kind, session) { return path.join(STATE, `${kind}-${safeId(session)}`); }
function writeState(kind, session, value) {
  try { fs.mkdirSync(STATE, { recursive: true }); fs.writeFileSync(stateFile(kind, session), String(value)); } catch {}
}
function readState(kind, session) {
  try { return fs.readFileSync(stateFile(kind, session), "utf8"); } catch { return null; }
}
function clearState(kind, session) { try { fs.unlinkSync(stateFile(kind, session)); } catch {} }

function postJson(url, body, timeoutMs) {
  return new Promise((resolve, reject) => {
    const data = Buffer.from(JSON.stringify(body), "utf8");
    const u = new URL(url);
    const lib = u.protocol === "https:" ? https : http;
    const req = lib.request(u, {
      method: "POST",
      headers: { "Content-Type": "application/json; charset=utf-8", "Content-Length": data.length },
      timeout: timeoutMs,
    }, (res) => {
      let b = "";
      res.setEncoding("utf8");
      res.on("data", (d) => (b += d));
      res.on("end", () => {
        if (res.statusCode < 200 || res.statusCode >= 300) return reject(new Error(`HTTP ${res.statusCode} from ${u.pathname}: ${b.slice(0, 200)}`));
        try { resolve(JSON.parse(b)); } catch { reject(new Error(`non-JSON reply from ${u.pathname}: ${b.slice(0, 200)}`)); }
      });
    });
    req.on("timeout", () => req.destroy(new Error(`timeout after ${Math.round(timeoutMs / 1000)}s (${u.pathname})`)));
    req.on("error", reject);
    req.end(data);
  });
}

// "HH:MM-HH:MM" (may wrap midnight). Empty / malformed = never quiet.
function inQuietHours(spec, now = new Date()) {
  const m = /^\s*(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})\s*$/.exec(spec || "");
  if (!m) return false;
  const a = +m[1] * 60 + +m[2], b = +m[3] * 60 + +m[4], t = now.getHours() * 60 + now.getMinutes();
  if (a === b) return false;
  return a < b ? t >= a && t < b : t >= a || t < b;
}

const normPhone = (p) => { let d = String(p || "").replace(/\D/g, ""); if (d.startsWith("972")) d = "0" + d.slice(3); return d; };

// Target = where to ring/call. A per-event override string wins over the default target.
//   "list:1,2" · "phones:0501234567,0521234567" · "template:123"
function resolveTarget(cfg, override) {
  const o = String(override || "").trim();
  if (o) {
    const i = o.indexOf(":");
    const kind = i < 0 ? o : o.slice(0, i);
    const vals = (i < 0 ? "" : o.slice(i + 1)).split(/[,\s]+/).map((s) => s.trim()).filter(Boolean);
    if (kind === "list") return { method: "list", lists: vals, phones: [], templateId: "" };
    if (kind === "phones") return { method: "phones", phones: vals, lists: [], templateId: "" };
    if (kind === "template") return { method: "template", templateId: vals[0] || "", lists: [], phones: [] };
    log("WARN bad target override, using default:", o);
  }
  const t = (cfg && cfg.target) || {};
  return { method: t.method || "list", lists: t.lists || [], phones: t.phones || [], templateId: String(t.templateId || "") };
}

// RunTzintuk body for a target (token added by the caller).
// callerId: the event's own caller id wins over the default (yemotHooks.<event>.callerId)
function tzintukBody(cfg, target, callerId = cfg.callerId) {
  const body = { TzintukTimeOut: Math.min(Math.max(+cfg.tzintukTimeout || 9, 1), 16) };
  if (callerId) body.callerId = callerId;
  if (target.method === "phones") {
    body.phones = target.phones.map(normPhone).filter(Boolean).join(":");
    if (!body.phones) return null;
  } else if (target.method === "template") {
    if (!target.templateId) return null;
    body.phones = "tpl:" + target.templateId;
  } else {
    if (!target.lists.length) return null;
    body.phones = "tzl:";
    body.tzintukLists = target.lists;
  }
  return body;
}

// ------------------------------------------------------------------ actions
async function sendTzintuk(cfg, target, why, callerId) {
  const token = process.env.YEMOT_TOKEN || "";
  if (!token) { log("ERROR tzintuk skipped: YEMOT_TOKEN is not set (VS Code: Yemot Hooks: הגדר טוקן ימות)"); return; }
  const body = tzintukBody(cfg, target, callerId || cfg.callerId);
  if (!body) { log("ERROR tzintuk skipped: empty target", target); return; }
  try {
    const r = await postJson(YEMOT_API + "RunTzintuk", { token, ...body }, 20000);
    if (r.responseStatus !== "OK") log("ERROR tzintuk", why, r.message || r.responseStatus);
    else log("tzintuk", why, `calls=${r.callsCount}`, `billing=${r.biling}`, Object.keys(r.errors || {}).length ? r.errors : "");
  } catch (e) { log("ERROR tzintuk", why, e.message); }
}

// Fire a tzintuk without making Claude wait: a detached child does the HTTP call
// (and the optional "only if still unanswered after N seconds" delay).
function tzintukDetached(target, why, session, delaySec, callerId) {
  const token = Date.now() + "-" + Math.random().toString(36).slice(2, 8);
  if (delaySec > 0) writeState("wait", session, token);
  const payload = Buffer.from(JSON.stringify({ target, why, session, delaySec, token, callerId })).toString("base64");
  try {
    const child = spawn(process.execPath, [__filename, "__ring", payload], { detached: true, stdio: "ignore", env: process.env });
    child.unref();
  } catch (e) { log("ERROR spawn", e.message); }
}
async function deferredRing(payloadB64) {
  const { target, why, session, delaySec, token, callerId } = JSON.parse(Buffer.from(payloadB64, "base64").toString("utf8"));
  if (delaySec > 0) {
    await new Promise((r) => setTimeout(r, delaySec * 1000));
    if (readState("wait", session) !== token) { log("tzintuk cancelled (answered in time):", why); return; }
    clearState("wait", session);
  }
  const cfg = readConfig();
  if (!cfg || !cfg.enabled) return;
  await sendTzintuk(cfg, target, why, callerId);
}

// Interactive: the bridge server calls the phone and blocks until a key is pressed.
async function askBridge(cfg, ev, mode, raw) {
  const server = String(cfg.serverUrl || "").replace(/\/+$/, "");
  if (!server) { log("ERROR interactive skipped: serverUrl is empty"); return { __failed: "no serverUrl" }; }
  if (!cfg.ivrPath) { log("ERROR interactive skipped: ivrPath is empty"); return { __failed: "no ivrPath" }; }
  const target = resolveTarget(cfg, ev.target);
  const method = { phones: "OTHER", template: "TPL", list: "TZL" }[target.method] || "TZL";
  const wait = Math.min(Math.max(+cfg.waitTimeout || 120, 20), 600);
  const viaTzintuk = cfg.answerVia === "tzintuk";
  const config = {
    mode,
    call_method: viaTzintuk ? "tzintuk" : "bridging",
    method, phones: target.phones.map(normPhone).filter(Boolean), template_id: target.templateId || null, lists: target.lists,
    ivr_path: cfg.ivrPath, caller_id: ev.callerId || cfg.callerId || null,
    calls_time_out: viaTzintuk ? (+cfg.tzintukTimeout || 9) : (+cfg.callTimeout || 30),
    wait_timeout: wait, input_type: cfg.inputType || "HebrewKeyboard",
  };
  log("ask", mode, config.call_method, "->", server + "/ask-hook", "ivr", cfg.ivrPath);
  try {
    const r = await postJson(server + "/ask-hook", { config, hook_input: raw }, (wait + 30) * 1000);
    if (r.answered) { log("answered", mode, JSON.stringify(r.answer)); return r.emit || null; }
    if (r.error === "timeout") { log("no answer (timeout)", mode); return null; }
    log("ERROR bridge:", r.error, mode);
    return { __failed: r.error || "unknown" };
  } catch (e) {
    log("ERROR bridge", mode, e.message);
    return { __failed: e.message };
  }
}

// ------------------------------------------------------------------ events
const EVENT_KEY = { permission: "needsPermission", question: "asksQuestion", stop: "taskCompleted", subagent: "subagentCompleted" };
const WHY = { permission: "permission", question: "question", stop: "task completed", subagent: "subagent completed" };

async function handle(which, raw, out) {
  let input = {};
  try { input = JSON.parse(raw || "{}"); } catch {}
  const session = input.session_id || "default";

  // bookkeeping: a reply in VS Code cancels a pending delayed ring; prompt start feeds the duration threshold
  if (which === "prompt" || which === "clear") {
    clearState("wait", session);
    if (which === "prompt") writeState("start", session, Date.now());
    return;
  }

  const cfg = readConfig();
  if (!cfg || !cfg.enabled) return;
  const evKey = EVENT_KEY[which];
  if (!evKey) { log("WARN unknown hook kind", which); return; }
  const ev = (cfg.events && cfg.events[evKey]) || {};
  const action = ev.action || "off";
  if (which === "stop") clearState("wait", session);
  if (action === "off") return;

  if (cfg.suppressSubagentInteractions !== false && input.agent_id && (which === "permission" || which === "question")) return;
  if (inQuietHours(cfg.quietHours)) { log("quiet hours — skipped", which); return; }
  if (which === "permission") {
    if (input.tool_name === "AskUserQuestion") return; // the question hook handles it
    if (ev.tools) {
      let re = null;
      try { re = new RegExp(`^(?:${ev.tools})$`); } catch { log("WARN bad tools regex", ev.tools); }
      if (re && !re.test(input.tool_name || "")) return;
    }
  }
  if (which === "stop") {
    const start = +readState("start", session) || 0;
    const min = +cfg.minTaskDurationSeconds || 0;
    if (min > 0 && start && Date.now() - start < min * 1000) return;
  }

  const why = which === "permission" ? `${WHY.permission} ${input.tool_name || ""}`.trim() : WHY[which];
  const target = resolveTarget(cfg, ev.target);

  if (action === "tzintuk" || which === "stop" || which === "subagent") {
    const delay = which === "permission" || which === "question" ? Math.max(+cfg.ringDelaySeconds || 0, 0) : 0;
    tzintukDetached(target, why, session, delay, ev.callerId);
    return;
  }

  // answer: the phone call decides (question / permission only)
  const emit = await askBridge(cfg, ev, which === "question" ? "askuser" : "permission", raw);

  if (emit && emit.__failed) {
    if (cfg.fallbackToTzintuk !== false) { log("fallback -> tzintuk", why); await sendTzintuk(cfg, target, why + " (fallback)", ev.callerId); }
    return;
  }
  if (emit) out(JSON.stringify(emit));
}

async function main() {
  const which = process.argv[2];
  if (which === "__ring") return deferredRing(process.argv[3]);
  let raw = "";
  process.stdin.setEncoding("utf8");
  for await (const c of process.stdin) raw += c;
  await handle(which, raw, (s) => process.stdout.write(s));
}

module.exports = { inQuietHours, resolveTarget, normPhone, tzintukBody, askBridge, handle, DIR, LOG, CONFIG };
if (require.main === module) {
  main().catch((e) => log("ERROR", (e && e.stack) || String(e))).finally(() => { process.exitCode = 0; });
}
