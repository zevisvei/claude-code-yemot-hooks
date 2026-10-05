// Yemot Hooks for Claude Code — the settings live in VS Code (yemotHooks.*).
// The extension turns them into ~/.claude/yemot-hooks/config.json and registers one
// small node runtime (hooks/hook.js, copied to ~/.claude/yemot-hooks/) in Claude Code's
// settings.json. The runtime reads config.json on every hook, so a settings change is live
// immediately; settings.json is rewritten only when the *set* of registered hooks changes.
"use strict";
const vscode = require("vscode");
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const https = require("https");
const { spawnSync } = require("child_process");
const rt = require("./hooks/hook.js");

const DIR = rt.DIR;
const HOOK_DST = path.join(DIR, "hook.js");
const LEGACY_STASH = path.join(os.homedir(), ".claude", "yemot-hooks.json");
const YEMOT_API = "https://www.call2all.co.il/ym/api/";

const isOurs = (c) => typeof c === "string" && /yemot-hooks[\\/]+hook\.js/.test(c);
const isLegacy = (c) => typeof c === "string" && !isOurs(c) && (c.includes("RunTzintuk") || c.includes("/ask-hook"));

let out;
function channel() { return (out = out || vscode.window.createOutputChannel("Yemot Hooks")); }

// ------------------------------------------------------------------ files
function cfg() { return vscode.workspace.getConfiguration("yemotHooks"); }
function settingsPath() {
  const p = cfg().get("settingsFile") || "~/.claude/settings.json";
  return p.startsWith("~") ? path.join(os.homedir(), p.slice(1)) : p;
}
function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); }
  catch (e) { if (e.code === "ENOENT") return fallback; throw new Error(`לא ניתן לקרוא את ${file}: ${e.message}`); }
}
function writeIfChanged(file, content, mode = 0o600) {
  try { if (fs.readFileSync(file, "utf8") === content) return false; } catch {}
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + ".tmp-" + process.pid;
  fs.writeFileSync(tmp, content, { mode });
  fs.renameSync(tmp, file);
  return true;
}
const writeJson = (file, obj) => writeIfChanged(file, JSON.stringify(obj, null, 2) + "\n");

// ------------------------------------------------------------------ config
// "…/claude-hooks/<key>/ask-hook" pasted by mistake → strip the endpoint (this is exactly how
// the old setup ended up calling /ask-hook/ask-hook and /ask-hook/respond).
function normServer(u) {
  let s = String(u || "").trim().replace(/\/+$/, "");
  for (;;) {
    const n = s.replace(/\/(ask-hook|respond|health)$/i, "").replace(/\/+$/, "");
    if (n === s) return s;
    s = n;
  }
}
const normIvr = (p) => String(p || "").trim().replace(/^ivr2:/i, "").replace(/^\/+|\/+$/g, "");

function buildConfig() {
  const c = cfg();
  const g = (k, d) => { const v = c.get(k); return v === undefined || v === null ? d : v; };
  const ev = (name, extra = {}) => ({ action: g(`${name}.action`, "off"), target: g(`${name}.target`, ""), ...extra });
  return {
    enabled: g("enabled", true),
    target: { method: g("target.method", "list"), lists: g("target.lists", []), phones: g("target.phones", []), templateId: String(g("target.templateId", "")) },
    callerId: g("callerId", ""),
    tzintukTimeout: g("tzintukTimeout", 9),
    quietHours: g("quietHours", ""),
    ringDelaySeconds: g("ringDelaySeconds", 0),
    minTaskDurationSeconds: g("minTaskDurationSeconds", 0),
    suppressSubagentInteractions: g("suppressSubagentInteractions", true),
    answerVia: g("answerVia", "call"),
    serverUrl: normServer(g("serverUrl", "")),
    ivrPath: normIvr(g("ivrPath", "")),
    waitTimeout: g("waitTimeout", 120),
    callTimeout: g("callTimeout", 30),
    inputType: g("inputType", "HebrewKeyboard"),
    fallbackToTzintuk: g("fallbackToTzintuk", true),
    events: {
      needsPermission: ev("needsPermission", { tools: g("needsPermission.tools", "") }),
      asksQuestion: ev("asksQuestion"),
      taskCompleted: ev("taskCompleted"),
      subagentCompleted: ev("subagentCompleted"),
    },
  };
}

function hookCommand(kind) {
  const node = (cfg().get("nodePath") || "node").trim();
  const n = /\s/.test(node) ? `"${node}"` : node;
  return `${n} "${HOOK_DST.replace(/\\/g, "/")}" ${kind}`;
}

/** The hooks block our settings call for: {event: [group]} */
function desiredHooks(c) {
  const h = {};
  const add = (event, matcher, kind, interactive) => {
    const hook = { type: "command", command: hookCommand(kind), timeout: interactive ? Math.ceil(+c.waitTimeout || 120) + 60 : 15 };
    if (interactive) hook.statusMessage = "📞 ממתין לתשובה בטלפון…";
    (h[event] = h[event] || []).push(matcher ? { matcher, hooks: [hook] } : { hooks: [hook] });
  };
  const e = c.events;
  if (!c.enabled) return h;
  const on = (x) => x.action && x.action !== "off";
  if (on(e.needsPermission)) add("PermissionRequest", null, "permission", e.needsPermission.action === "answer");
  if (on(e.asksQuestion)) add("PreToolUse", "AskUserQuestion", "question", e.asksQuestion.action === "answer");
  if (on(e.taskCompleted)) add("Stop", null, "stop", false);
  if (on(e.subagentCompleted)) add("SubagentStop", null, "subagent", false);
  if (Object.keys(h).length) add("UserPromptSubmit", null, "prompt", false);
  const delayed = +c.ringDelaySeconds > 0 && [e.needsPermission, e.asksQuestion].some((x) => x.action === "tzintuk");
  if (delayed) add("PostToolUse", null, "clear", false);
  return h;
}

/** Split settings.hooks into ours / legacy (old PowerShell hooks) / rest */
function splitHooks(hooks) {
  const ours = {}, legacy = {}, rest = {};
  const push = (m, ev, g) => (m[ev] = m[ev] || []).push(g);
  for (const [ev, groups] of Object.entries(hooks || {})) {
    for (const g of groups || []) {
      if (!Array.isArray(g.hooks)) { push(rest, ev, g); continue; }
      const parts = { ours: [], legacy: [], rest: [] };
      for (const h of g.hooks) parts[isOurs(h.command) ? "ours" : isLegacy(h.command) ? "legacy" : "rest"].push(h);
      if (parts.ours.length) push(ours, ev, { ...g, hooks: parts.ours });
      if (parts.legacy.length) push(legacy, ev, { ...g, hooks: parts.legacy });
      if (parts.rest.length) push(rest, ev, { ...g, hooks: parts.rest });
    }
  }
  return { ours, legacy, rest };
}
function mergeInto(base, add) {
  const outH = JSON.parse(JSON.stringify(base || {}));
  for (const [ev, groups] of Object.entries(add || {})) outH[ev] = (outH[ev] || []).concat(groups);
  return outH;
}
const count = (h) => Object.values(h || {}).reduce((n, gs) => n + gs.reduce((m, g) => m + (g.hooks || []).length, 0), 0);

/** Install the runtime + config and bring settings.json in line. Returns {changed, legacy}. */
function sync(context) {
  const c = buildConfig();
  writeIfChanged(HOOK_DST, fs.readFileSync(path.join(context.extensionPath, "hooks", "hook.js"), "utf8"), 0o755);
  writeJson(rt.CONFIG, c);
  const file = settingsPath();
  const s = readJson(file, {});
  const { legacy, rest } = splitHooks(s.hooks);
  const hooks = mergeInto(mergeInto(rest, legacy), desiredHooks(c));
  const next = { ...s };
  if (Object.keys(hooks).length) next.hooks = hooks; else delete next.hooks;
  const changed = JSON.stringify(next) !== JSON.stringify(s) && writeJson(file, next);
  return { changed, legacy: count(legacy) };
}

// ------------------------------------------------------------------ legacy migration
const psString = (cmd, varName) => {
  const m = new RegExp(`\\$${varName}='((?:[^']|'')*)'`).exec(cmd);
  if (!m) return null;
  try { return JSON.parse(m[1].replace(/''/g, "'")); } catch { return null; }
};
function targetFromRing(o) {
  if (!o) return null;
  if (String(o.phones || "").startsWith("tzl:")) return { method: "list", lists: o.tzintukLists || [] };
  if (String(o.phones || "").startsWith("tpl:")) return { method: "template", templateId: String(o.phones).slice(4) };
  return { method: "phones", phones: String(o.phones || "").split(":").filter(Boolean) };
}
function targetFromInter(i) {
  if (!i) return null;
  if (i.method === "TZL") return { method: "list", lists: i.lists || [] };
  if (i.method === "TPL") return { method: "template", templateId: String(i.template_id || "") };
  return { method: "phones", phones: i.phones || [] };
}
/** Settings derived from old PowerShell hooks: [{key, value}] */
function legacySettings(legacy) {
  const set = {};
  let target = null;
  const evKey = { PermissionRequest: "needsPermission", Stop: "taskCompleted", SubagentStop: "subagentCompleted" };
  for (const [ev, groups] of Object.entries(legacy || {})) {
    for (const g of groups) for (const h of g.hooks) {
      const name = ev === "PreToolUse" && g.matcher === "AskUserQuestion" ? "asksQuestion" : evKey[ev];
      if (!name) continue;
      const inter = h.command.includes("/ask-hook") ? psString(h.command, "cfg") : null;
      if (inter) {
        set[`${name}.action`] = name === "needsPermission" || name === "asksQuestion" ? "answer" : "tzintuk";
        const uri = /-Uri '([^']+)\/ask-hook'/.exec(h.command);
        if (uri) set.serverUrl = normServer(uri[1]);
        if (inter.ivr_path) set.ivrPath = normIvr(inter.ivr_path);
        if (inter.wait_timeout) set.waitTimeout = inter.wait_timeout;
        if (inter.call_method) set.answerVia = inter.call_method === "tzintuk" ? "tzintuk" : "call";
        if (inter.input_type) set.inputType = inter.input_type;
        if (inter.caller_id) set.callerId = inter.caller_id;
        target = target || targetFromInter(inter);
      } else {
        if (!set[`${name}.action`]) set[`${name}.action`] = "tzintuk";
        const ring = psString(h.command, "o") || psString(h.command, "b");
        if (ring) {
          if (ring.TzintukTimeOut) set.tzintukTimeout = ring.TzintukTimeOut;
          if (ring.callerId) set.callerId = ring.callerId;
          target = target || targetFromRing(ring);
        }
      }
    }
  }
  if (target) {
    set["target.method"] = target.method;
    if (target.lists) set["target.lists"] = target.lists;
    if (target.phones) set["target.phones"] = target.phones;
    if (target.templateId) set["target.templateId"] = target.templateId;
  }
  for (const n of ["needsPermission", "asksQuestion", "taskCompleted", "subagentCompleted"]) if (!set[`${n}.action`]) set[`${n}.action`] = "off";
  return set;
}
async function migrateLegacy(context, { ask = true } = {}) {
  const s = readJson(settingsPath(), {});
  const { legacy } = splitHooks(s.hooks);
  const stash = readJson(LEGACY_STASH, {}).hooks || {};
  const all = mergeInto(legacy, splitHooks(stash).legacy);
  const n = count(all);
  if (!n) return "לא נמצאו hooks ישנים.";
  const set = legacySettings(all);
  if (ask) {
    const lines = Object.entries(set).map(([k, v]) => `${k} = ${JSON.stringify(v)}`).join("\n");
    const pick = await vscode.window.showWarningMessage(
      `נמצאו ${n} hooks ישנים (PowerShell). להמיר אותם להגדרות התוסף ולהסיר אותם מ-settings.json?\n\n${lines}`,
      { modal: true }, "המר והסר", "הסר בלבד");
    if (!pick) return "";
    if (pick === "הסר בלבד") Object.keys(set).forEach((k) => delete set[k]);
  }
  for (const [k, v] of Object.entries(set)) await cfg().update(k, v, vscode.ConfigurationTarget.Global);
  const { rest, ours } = splitHooks(s.hooks);
  const next = { ...s, hooks: mergeInto(rest, ours) };
  if (!Object.keys(next.hooks).length) delete next.hooks;
  writeJson(settingsPath(), next);
  try { fs.unlinkSync(LEGACY_STASH); } catch {}
  sync(context);
  return `הומרו והוסרו ${n} hooks ישנים.`;
}

// ------------------------------------------------------------------ network
function request(method, url, body, ms = 15000) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const lib = u.protocol === "https:" ? https : http;
    const data = body === undefined ? null : Buffer.from(JSON.stringify(body), "utf8");
    const req = lib.request(u, { method, timeout: ms, headers: data ? { "Content-Type": "application/json; charset=utf-8", "Content-Length": data.length } : {} }, (res) => {
      let b = ""; res.setEncoding("utf8"); res.on("data", (d) => (b += d));
      res.on("end", () => { let json = null; try { json = JSON.parse(b); } catch {} resolve({ code: res.statusCode, body: b, json }); });
    });
    req.on("timeout", () => req.destroy(new Error("timeout"))); req.on("error", reject);
    req.end(data || undefined);
  });
}
function token() {
  try { const t = readJson(settingsPath(), {}).env?.YEMOT_TOKEN; if (t) return t; } catch {}
  return process.env.YEMOT_TOKEN || "";
}
async function yemot(ep, params = {}) {
  const t = token();
  if (!t) throw new Error("לא הוגדר טוקן ימות (Yemot Hooks: הגדר טוקן ימות).");
  const u = new URL(YEMOT_API + ep);
  u.searchParams.set("token", t);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  const r = await request("GET", u.toString());
  if (!r.json) throw new Error(`${ep}: תשובה לא צפויה (HTTP ${r.code})`);
  if (r.json.responseStatus !== "OK") throw new Error(`${ep}: ${r.json.message || r.json.responseStatus}`);
  return r.json;
}

// ------------------------------------------------------------------ status bar
let bar;
const ACTION_HE = { off: "כבוי", tzintuk: "צינתוק", answer: "מענה בטלפון" };
function refresh() {
  if (!bar) return;
  try {
    const c = buildConfig();
    const { ours, legacy } = splitHooks(readJson(settingsPath(), {}).hooks);
    const anyOn = Object.values(c.events).some((e) => e.action !== "off");
    if (!c.enabled || !anyOn) { bar.text = "$(bell-slash) ימות: כבוי"; bar.backgroundColor = new vscode.ThemeColor("statusBarItem.warningBackground"); }
    else if (!token()) { bar.text = "$(warning) ימות: חסר טוקן"; bar.backgroundColor = new vscode.ThemeColor("statusBarItem.errorBackground"); }
    else { bar.text = "$(bell) ימות"; bar.backgroundColor = undefined; }
    const rows = [
      ["בקשת הרשאה", c.events.needsPermission.action], ["שאלה", c.events.asksQuestion.action],
      ["סיום משימה", c.events.taskCompleted.action], ["סוכן-משנה", c.events.subagentCompleted.action],
    ].map(([n, a]) => `| ${n} | ${ACTION_HE[a] || a} |`).join("\n");
    const t = c.target.method === "list" ? `רשימות ${c.target.lists.join(", ")}` : c.target.method === "phones" ? c.target.phones.join(", ") : `תבנית ${c.target.templateId}`;
    bar.tooltip = new vscode.MarkdownString(
      `**Yemot Hooks** — ${c.enabled ? "פעיל" : "כבוי"} · לחיצה לתפריט\n\n| אירוע | פעולה |\n|---|---|\n${rows}\n\nיעד: ${t}` +
      (c.quietHours ? `\n\nשעות שקט: ${c.quietHours}` : "") +
      `\n\nרשומים ב-settings.json: ${count(ours)}` + (count(legacy) ? `\n\n⚠️ ${count(legacy)} hooks ישנים (PowerShell) — הרץ "המר hooks ישנים"` : ""));
  } catch (e) { bar.text = "$(error) ימות"; bar.tooltip = e.message; }
}

// ------------------------------------------------------------------ commands
async function run(fn) {
  try { const msg = await fn(); if (msg) vscode.window.showInformationMessage("Yemot Hooks: " + msg); }
  catch (e) { vscode.window.showErrorMessage("Yemot Hooks: " + e.message); }
  refresh();
}
async function ensure(key, prompt, placeHolder, validate) {
  let v = String(cfg().get(key) || "").trim();
  if (v) return v;
  v = ((await vscode.window.showInputBox({ prompt, placeHolder, ignoreFocusOut: true, validateInput: validate })) || "").trim();
  if (!v) throw new Error(`לא הוגדר ${key}.`);
  await cfg().update(key, v, vscode.ConfigurationTarget.Global);
  return v;
}

function makeCommands(context) {
  const cmds = {
    toggle: () => run(async () => { const on = !cfg().get("enabled"); await cfg().update("enabled", on, vscode.ConfigurationTarget.Global); return on ? "הודלק." : "כובה."; }),
    enable: () => run(async () => { await cfg().update("enabled", true, vscode.ConfigurationTarget.Global); return "הודלק."; }),
    disable: () => run(async () => { await cfg().update("enabled", false, vscode.ConfigurationTarget.Global); return "כובה."; }),
    openSettings: () => vscode.commands.executeCommand("workbench.action.openSettings", "@ext:zevisvei.yemot-hooks"),

    testTzintuk: () => run(async () => {
      const c = buildConfig();
      const body = rt.tzintukBody(c, rt.resolveTarget(c, ""));
      if (!body) throw new Error("היעד ריק — הגדר רשימה / טלפון / תבנית.");
      const t = token(); if (!t) throw new Error("לא הוגדר טוקן ימות.");
      const r = await request("POST", YEMOT_API + "RunTzintuk", { token: t, ...body });
      const j = r.json || {};
      if (j.responseStatus !== "OK") throw new Error(j.message || `HTTP ${r.code}`);
      const errs = Object.keys(j.errors || {}).length ? ` · שגיאות: ${JSON.stringify(j.errors)}` : "";
      return `צינתוק נשלח — ${j.callsCount} נמענים, חיוב ${j.biling}${errs}`;
    }),

    testCall: () => run(async () => {
      const c = buildConfig();
      if (!c.serverUrl) await ensure("serverUrl", "כתובת שרת הגישור", "http://my-server:8000", (v) => (/^https?:\/\/\S+$/.test(v.trim()) ? null : "כתובת http(s) מלאה"));
      if (!c.ivrPath) await ensure("ivrPath", "שלוחת ה-API בימות", "5/5");
      const c2 = buildConfig();
      const fake = JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "AskUserQuestion", tool_input: { questions: [{ question: "בדיקה מהתוסף. מה לבחור?", options: [{ label: "תקין" }, { label: "לא תקין" }] }] } });
      return vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Yemot Hooks: ${c2.answerVia === "tzintuk" ? "צינתוק נשלח — חזור לשלוחה" : "מתקשר"} ${c2.ivrPath}, ממתין לתשובה…` }, async () => {
        const emit = await rt.askBridge(c2, { action: "answer", target: "" }, "askuser", fake);
        if (emit && emit.__failed) throw new Error("השיחה נכשלה: " + emit.__failed);
        if (!emit) return "לא התקבלה תשובה בזמן.";
        return "התקבלה תשובה: " + (emit.hookSpecificOutput?.permissionDecisionReason || JSON.stringify(emit));
      });
    }),

    setupApiExtension: () => run(async () => {
      const server = normServer(await ensure("serverUrl", "כתובת שרת הגישור (ציבורית — ימות פונה אליה)", "http://my-server:8000", (v) => (/^https?:\/\/\S+$/.test(v.trim()) ? null : "כתובת http(s) מלאה")));
      const ivr = normIvr(await ensure("ivrPath", "נתיב שלוחת ה-API בימות", "5/5"));
      const want = server + "/respond";
      let current = "";
      try { current = (await yemot("GetTextFile", { what: `ivr2:/${ivr}/ext.ini` })).contents || ""; } catch {}
      const link = /^api_link=(.*)$/m.exec(current)?.[1]?.trim();
      const type = /^type=(.*)$/m.exec(current)?.[1]?.trim();
      if (type === "api" && link === want) return `השלוחה ${ivr} כבר מוגדרת נכון.`;
      const ok = await vscode.window.showWarningMessage(
        `לעדכן את שלוחה ${ivr} בימות?\n\ntype: ${type || "(אין)"} → api\napi_link: ${link || "(אין)"} → ${want}`, { modal: true }, "עדכן בימות");
      if (!ok) return "";
      await yemot("UpdateExtension", { path: `ivr2:/${ivr}`, type: "api", api_link: want, api_hangup_send: "no" });
      return `השלוחה ${ivr} עודכנה (api_link = ${want}).`;
    }),

    diagnose: () => run(async () => {
      const ch = channel(); ch.clear(); ch.show(true);
      const c = buildConfig();
      let bad = 0;
      const line = (ok, text) => { if (ok === false) bad++; ch.appendLine(`${ok === true ? "✓" : ok === false ? "✗" : "•"} ${text}`); };
      ch.appendLine(`Yemot Hooks — בדיקת תקינות · ${new Date().toLocaleString("he-IL")}\n`);

      const nodeBin = (cfg().get("nodePath") || "node").trim();
      const nv = spawnSync(nodeBin, ["-v"], { encoding: "utf8" });
      line(nv.status === 0, `node: ${nv.status === 0 ? nv.stdout.trim() : `"${nodeBin}" לא נמצא — הגדר yemotHooks.nodePath`}`);
      line(fs.existsSync(HOOK_DST), `סקריפט ה-hooks: ${HOOK_DST}`);

      const { ours, legacy } = splitHooks(readJson(settingsPath(), {}).hooks);
      const want = count(desiredHooks(c));
      line(count(ours) === want, `רשומים ב-settings.json: ${count(ours)} (צפוי ${want})`);
      if (count(legacy)) line(false, `${count(legacy)} hooks ישנים (PowerShell) עדיין רשומים — יצלצלו פעמיים. הרץ "המר hooks ישנים".`);

      const t = token();
      line(!!t, `טוקן ימות: ${t ? "מוגדר" : "חסר (הגדר טוקן ימות)"}`);
      if (t) {
        try { const s = await yemot("GetSession"); line(true, `מערכת ${s.username} · ${s.units} יחידות`); } catch (e) { line(false, `טוקן ימות: ${e.message}`); }
        if (c.target.method === "list") {
          try {
            const { lists = [] } = await yemot("TzintukimListManagement", { action: "getlists" });
            for (const name of c.target.lists) {
              const l = lists.find((x) => String(x.listName) === String(name));
              line(!!l && l.active > 0, `רשימת צינתוק "${name}": ${l ? `${l.subscribers} נרשמו, ${l.active} פעילים` : "לא קיימת (נוצרת רק אחרי הרשמה טלפונית)"}`);
            }
          } catch (e) { line(false, `רשימות צינתוק: ${e.message}`); }
        }
      }

      const usesAnswer = Object.values(c.events).some((e) => e.action === "answer");
      if (usesAnswer || c.serverUrl) {
        if (!c.serverUrl) line(false, "serverUrl ריק — נדרש למענה בטלפון");
        else {
          if (normServer(cfg().get("serverUrl")) !== String(cfg().get("serverUrl") || "").trim().replace(/\/+$/, ""))
            line(null, `serverUrl הכיל נקודת קצה בסוף — משתמשים ב-${c.serverUrl}`);
          try {
            const r = await request("GET", c.serverUrl + "/health", undefined, 8000);
            line(r.code === 200, `שרת הגישור: ${r.code === 200 ? `זמין · טוקן בשרת: ${r.json?.token_set ? "מוגדר" : "חסר!"}` : `HTTP ${r.code}`}`);
          } catch (e) { line(false, `שרת הגישור לא זמין: ${e.message}`); }
        }
        if (!c.ivrPath) line(false, "ivrPath ריק — נדרש למענה בטלפון");
        else if (t && c.serverUrl) {
          try {
            const ini = (await yemot("GetTextFile", { what: `ivr2:/${c.ivrPath}/ext.ini` })).contents || "";
            const link = /^api_link=(.*)$/m.exec(ini)?.[1]?.trim();
            const type = /^type=(.*)$/m.exec(ini)?.[1]?.trim();
            line(type === "api", `שלוחה ${c.ivrPath}: type=${type || "(אין)"}`);
            line(link === c.serverUrl + "/respond", `api_link: ${link || "(אין)"}${link === c.serverUrl + "/respond" ? "" : ` — צפוי ${c.serverUrl}/respond. הרץ "הגדר את שלוחת ה-API בימות".`}`);
          } catch (e) { line(false, `שלוחה ${c.ivrPath}: ${e.message}`); }
        }
      }

      try {
        const errs = fs.readFileSync(rt.LOG, "utf8").split("\n").filter((l) => l.includes("ERROR")).slice(-5);
        if (errs.length) { ch.appendLine("\nשגיאות אחרונות ביומן:"); errs.forEach((l) => ch.appendLine("  " + l)); }
      } catch {}
      return bad ? `נמצאו ${bad} בעיות — פירוט בחלון הפלט.` : "הכל תקין.";
    }),

    setToken: () => run(async () => {
      const t = await vscode.window.showInputBox({ prompt: "טוקן ימות (מספר:סיסמה או מפתח API) — נשמר ב-env של Claude Code", password: true, ignoreFocusOut: true });
      if (t === undefined) return "";
      const s = readJson(settingsPath(), {});
      s.env = s.env || {};
      if (t.trim()) s.env.YEMOT_TOKEN = t.trim(); else delete s.env.YEMOT_TOKEN;
      if (!Object.keys(s.env).length) delete s.env;
      writeJson(settingsPath(), s);
      return t.trim() ? "הטוקן נשמר (חל על שיחות Claude חדשות)." : "הטוקן נמחק.";
    }),
    showLog: () => run(async () => {
      if (!fs.existsSync(rt.LOG)) return "היומן ריק.";
      await vscode.window.showTextDocument(vscode.Uri.file(rt.LOG), { preview: true });
    }),
    showHooks: () => run(async () => {
      const { ours, legacy } = splitHooks(readJson(settingsPath(), {}).hooks);
      const doc = await vscode.workspace.openTextDocument({ language: "json", content: JSON.stringify({ config: buildConfig(), hooks: ours, legacy }, null, 2) });
      await vscode.window.showTextDocument(doc, { preview: true });
    }),
    openSettingsJson: () => run(async () => { await vscode.window.showTextDocument(vscode.Uri.file(settingsPath())); }),
    migrateLegacy: () => run(() => migrateLegacy(context)),
    openConfig: () => run(async () => {
      const url = (cfg().get("configUrl") || "").trim() || (await ensure("serverUrl", "כתובת שרת הגישור", "http://my-server:8000")) + "/claude-hooks/config";
      await vscode.env.openExternal(vscode.Uri.parse(url));
    }),

    menu: async () => {
      const c = buildConfig();
      const items = [
        c.enabled ? { label: "$(bell-slash) כבה", id: "disable" } : { label: "$(bell) הדלק", id: "enable" },
        { label: "$(settings-gear) הגדרות", id: "openSettings", detail: "פעולה לכל אירוע, יעד, שעות שקט, מענה טלפוני" },
        { label: "$(pulse) בדיקת תקינות", id: "diagnose", detail: "טוקן, רשימות, שרת, api_link של השלוחה" },
        { label: "$(megaphone) שלח צינתוק בדיקה", id: "testTzintuk" },
        { label: "$(call-outgoing) שיחת בדיקה", id: "testCall", detail: "שאלה בטלפון דרך שרת הגישור" },
        { label: "$(server) הגדר את שלוחת ה-API בימות", id: "setupApiExtension" },
        { label: "$(key) הגדר טוקן ימות", id: "setToken" },
        { label: "$(output) הצג יומן", id: "showLog" },
        { label: "$(list-tree) הצג hooks", id: "showHooks" },
        { label: "$(json) פתח settings.json", id: "openSettingsJson" },
      ];
      if (count(splitHooks(readJson(settingsPath(), {}).hooks).legacy)) items.splice(1, 0, { label: "$(warning) המר hooks ישנים", id: "migrateLegacy" });
      const p = await vscode.window.showQuickPick(items, { title: "Yemot Hooks — " + (c.enabled ? "פעיל" : "כבוי") });
      if (p) cmds[p.id]();
    },
  };
  return cmds;
}

// ------------------------------------------------------------------ lifecycle
function activate(context) {
  const cmds = makeCommands(context);
  for (const [k, fn] of Object.entries(cmds)) context.subscriptions.push(vscode.commands.registerCommand("yemotHooks." + k, fn));
  bar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 90);
  bar.command = "yemotHooks.menu"; bar.show(); context.subscriptions.push(bar);

  const doSync = () => {
    try {
      const r = sync(context);
      if (r.changed) channel().appendLine(`${new Date().toLocaleTimeString()} settings.json עודכן (חל על שיחות Claude חדשות)`);
      return r;
    } catch (e) { vscode.window.showErrorMessage("Yemot Hooks: " + e.message); return { legacy: 0 }; }
    finally { refresh(); }
  };
  const first = doSync();
  if (first.legacy && !context.globalState.get("legacyPromptDismissed")) {
    vscode.window.showWarningMessage(`Yemot Hooks: נמצאו ${first.legacy} hooks ישנים (PowerShell). להמיר אותם להגדרות התוסף?`, "המר", "לא עכשיו", "אל תשאל שוב")
      .then((p) => { if (p === "המר") cmds.migrateLegacy(); else if (p === "אל תשאל שוב") context.globalState.update("legacyPromptDismissed", true); });
  }
  context.subscriptions.push(vscode.workspace.onDidChangeConfiguration((e) => e.affectsConfiguration("yemotHooks") && doSync()));
  try {
    const f = settingsPath();
    fs.watchFile(f, { interval: 3000 }, refresh);
    context.subscriptions.push({ dispose: () => fs.unwatchFile(f, refresh) });
  } catch {}
}
function deactivate() {}
module.exports = { activate, deactivate, _test: { splitHooks, mergeInto, count, desiredHooks, legacySettings, normServer, normIvr, isOurs, isLegacy } };
