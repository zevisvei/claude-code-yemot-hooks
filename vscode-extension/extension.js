// Yemot Hooks for Claude Code — on/off + config for the hooks produced by
// <server>/claude-hooks/config. "Ours" = any hook command that calls RunTzintuk
// or /ask-hook (the same signature the config page uses when merging).
// Off = our handlers move from settings.json into ~/.claude/yemot-hooks.json; on = back.
"use strict";
const vscode = require("vscode");
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const https = require("https");

const SIG = (c) => typeof c === "string" && (c.includes("RunTzintuk") || c.includes("/ask-hook"));
const STASH = path.join(os.homedir(), ".claude", "yemot-hooks.json");

function cfg() { return vscode.workspace.getConfiguration("yemotHooks"); }
function settingsPath() {
  const p = cfg().get("settingsFile") || "~/.claude/settings.json";
  return p.startsWith("~") ? path.join(os.homedir(), p.slice(1)) : p;
}
function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); }
  catch (e) { if (e.code === "ENOENT") return fallback; throw new Error(`לא ניתן לקרוא את ${file}: ${e.message}`); }
}
function writeJson(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + ".tmp-" + process.pid;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + "\n", { mode: 0o600 });
  fs.renameSync(tmp, file);
}

/** Split settings.hooks into {ours, rest}; both shaped {event: [group,...]} */
function splitHooks(hooks) {
  const ours = {}, rest = {};
  for (const [ev, groups] of Object.entries(hooks || {})) {
    for (const g of groups || []) {
      if (!Array.isArray(g.hooks)) { (rest[ev] = rest[ev] || []).push(g); continue; }
      const mine = g.hooks.filter((h) => SIG(h.command));
      const other = g.hooks.filter((h) => !SIG(h.command));
      if (mine.length) (ours[ev] = ours[ev] || []).push({ ...g, hooks: mine });
      if (other.length) (rest[ev] = rest[ev] || []).push({ ...g, hooks: other });
    }
  }
  return { ours, rest };
}
function mergeInto(base, add) {
  const out = JSON.parse(JSON.stringify(base || {}));
  for (const [ev, groups] of Object.entries(add || {})) out[ev] = (out[ev] || []).concat(groups);
  return out;
}
function count(h) { return Object.values(h || {}).reduce((n, gs) => n + gs.reduce((m, g) => m + (g.hooks || []).length, 0), 0); }
function summary(h) {
  return Object.entries(h || {}).map(([ev, gs]) => `${ev}${gs.some((g) => g.matcher) ? " (" + gs.map((g) => g.matcher || "*").join(", ") + ")" : ""}: ${gs.reduce((m, g) => m + g.hooks.length, 0)}`).join("\n");
}

function state() {
  const s = readJson(settingsPath(), {});
  const { ours } = splitHooks(s.hooks);
  const stash = readJson(STASH, {});
  const active = count(ours), stashed = count(stash.hooks);
  return { s, ours, stash, active, stashed, status: active ? "on" : stashed ? "off" : "none" };
}

function setOn(on) {
  const st = state();
  const { rest, ours } = splitHooks(st.s.hooks);
  if (on) {
    if (st.active) return "כבר דולק.";
    if (!st.stashed) throw new Error("אין hooks של ימות להדלקה. ייבא קודם מדף ההגדרה.");
    st.s.hooks = mergeInto(rest, st.stash.hooks);
    writeJson(settingsPath(), st.s);
    writeJson(STASH, { savedAt: st.stash.savedAt, hooks: {} });
    return `הודלק — ${st.stashed} hooks.`;
  } else {
    if (!st.active) return "כבר כבוי.";
    st.s.hooks = rest;
    if (!Object.keys(st.s.hooks).length) delete st.s.hooks;
    writeJson(STASH, { savedAt: new Date().toISOString(), hooks: ours });
    writeJson(settingsPath(), st.s);
    return `כובה — ${st.active} hooks נשמרו בצד (${STASH}).`;
  }
}

/** Extract the bridge base URL (…/claude-hooks/<key>) from an existing ask-hook command */
function bridgeBase(st) {
  const all = JSON.stringify([st.ours, st.stash.hooks || {}]);
  const m = all.match(/(https?:\/\/[^'"\s\\]+?)\/ask-hook/);
  return m ? m[1] : null;
}
function httpGet(url, ms = 10000) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith("https") ? https : http;
    const req = lib.get(url, { timeout: ms }, (res) => {
      let b = ""; res.on("data", (d) => (b += d)); res.on("end", () => resolve({ code: res.statusCode, body: b }));
    });
    req.on("timeout", () => req.destroy(new Error("timeout"))); req.on("error", reject);
  });
}

let bar;
function refresh() {
  if (!bar) return;
  try {
    const st = state();
    if (st.status === "on") { bar.text = "$(bell) ימות: פעיל"; bar.backgroundColor = undefined; }
    else if (st.status === "off") { bar.text = "$(bell-slash) ימות: כבוי"; bar.backgroundColor = new vscode.ThemeColor("statusBarItem.warningBackground"); }
    else { bar.text = "$(bell-dot) ימות: לא מוגדר"; bar.backgroundColor = undefined; }
    const h = st.status === "on" ? st.ours : st.stash.hooks;
    bar.tooltip = new vscode.MarkdownString(`**Yemot Hooks** — לחיצה לתפריט\n\n${st.status === "none" ? "אין hooks. פתח את דף ההגדרה, העתק את בלוק ה-hooks וייבא מהלוח." : "```\n" + summary(h) + "\n```"}`);
  } catch (e) { bar.text = "$(error) ימות"; bar.tooltip = e.message; }
}

async function run(fn) {
  try { const msg = await fn(); if (msg) vscode.window.showInformationMessage("Yemot Hooks: " + msg + (/(הודלק|כובה|יובאו)/.test(msg) ? " (חל על שיחות Claude חדשות)" : "")); }
  catch (e) { vscode.window.showErrorMessage("Yemot Hooks: " + e.message); }
  refresh();
}

/** yemotHooks.serverUrl, asking once (saved to user/remote settings) when it is empty */
async function serverUrl() {
  let u = (cfg().get("serverUrl") || "").trim().replace(/\/$/, "");
  if (u) return u;
  u = ((await vscode.window.showInputBox({
    prompt: "כתובת השרת שמריץ את גשר ה-hooks (main.py או yemot-suite), בלי /claude-hooks",
    placeHolder: "http://my-server:8000", ignoreFocusOut: true,
    validateInput: (v) => (/^https?:\/\/\S+$/.test(v.trim()) ? null : "כתובת http(s) מלאה"),
  })) || "").trim().replace(/\/$/, "");
  if (!u) throw new Error("לא הוגדרה כתובת שרת (yemotHooks.serverUrl).");
  await cfg().update("serverUrl", u, vscode.ConfigurationTarget.Global);
  return u;
}

const cmds = {
  toggle: () => run(() => setOn(state().status !== "on")),
  enable: () => run(() => setOn(true)),
  disable: () => run(() => setOn(false)),
  openConfig: () => run(async () => {
    // yemot-suite serves the page at <server>/claude-hooks/config; with the standalone main.py
    // set yemotHooks.configUrl to wherever yemot_hooks_config.html is hosted (e.g. GitHub Pages).
    const url = (cfg().get("configUrl") || "").trim() || (await serverUrl()) + "/claude-hooks/config";
    await vscode.env.openExternal(vscode.Uri.parse(url));
    const pick = await vscode.window.showInformationMessage(
      "בדף ההגדרה: בנה את ה-hooks ולחץ \"העתק בלוק hooks\". ואז ייבא לכאן.", "ייבא מהלוח עכשיו");
    if (pick) return cmds.importClipboard();
  }),
  importClipboard: () => run(async () => {
    const txt = (await vscode.env.clipboard.readText()).trim();
    if (!txt) throw new Error("הלוח ריק. בדף ההגדרה לחץ \"העתק בלוק hooks\".");
    let obj; try { obj = JSON.parse(txt); } catch { throw new Error("בלוח אין JSON תקין של hooks."); }
    const incoming = obj.hooks && typeof obj.hooks === "object" ? obj.hooks : obj;
    const { ours: inc } = splitHooks(incoming);
    const n = count(inc);
    if (!n) throw new Error("לא נמצאו בלוח hooks של ימות (RunTzintuk / ask-hook).");
    const st = state();
    const ok = await vscode.window.showWarningMessage(
      `לייבא ${n} hooks?\n${summary(inc)}\n\nה-hooks הקודמים של ימות יוחלפו. hooks אחרים לא ייפגעו.`, { modal: true }, "ייבא והדלק");
    if (!ok) return "";
    const { rest } = splitHooks(st.s.hooks);
    st.s.hooks = mergeInto(rest, inc);
    writeJson(settingsPath(), st.s);
    writeJson(STASH, { savedAt: new Date().toISOString(), hooks: {} });
    const needsToken = JSON.stringify(inc).includes("YEMOT_TOKEN") && !(st.s.env && st.s.env.YEMOT_TOKEN) && !process.env.YEMOT_TOKEN;
    if (needsToken) setTimeout(() => vscode.window.showWarningMessage("ה-hooks קוראים את הטוקן מ-$env:YEMOT_TOKEN, והוא לא מוגדר.", "הגדר טוקן").then((p) => p && cmds.setToken()), 300);
    return `יובאו והודלקו ${n} hooks.`;
  }),
  health: () => run(async () => {
    const st = state(); const base = bridgeBase(st);
    const url = base ? base + "/health" : null;
    if (!url) { const server = await serverUrl(); const r = await httpGet(server + "/claude-hooks/config"); return `השרת ${r.code === 200 ? "זמין" : "החזיר " + r.code} (אין hook מענה מוגדר, ולכן לא נבדק המפתח).`; }
    const r = await httpGet(url);
    if (r.code !== 200) throw new Error(`השרת החזיר ${r.code}`);
    const j = JSON.parse(r.body);
    return `השרת תקין · טוקן ימות בשרת: ${j.token_set ? "מוגדר" : "חסר!"} · שאלות ממתינות: ${(j.pending || []).length}`;
  }),
  setToken: () => run(async () => {
    const t = await vscode.window.showInputBox({ prompt: "טוקן ימות (user:password או מפתח API) — נשמר ב-env של Claude Code", password: true, ignoreFocusOut: true });
    if (t === undefined) return "";
    const s = readJson(settingsPath(), {});
    s.env = s.env || {};
    if (t.trim()) s.env.YEMOT_TOKEN = t.trim(); else delete s.env.YEMOT_TOKEN;
    if (!Object.keys(s.env).length) delete s.env;
    writeJson(settingsPath(), s);
    return t.trim() ? "הטוקן נשמר (env.YEMOT_TOKEN ב-settings.json, הרשאה 600)." : "הטוקן נמחק.";
  }),
  show: () => run(async () => {
    const st = state(); const h = st.status === "on" ? st.ours : st.stash.hooks;
    const doc = await vscode.workspace.openTextDocument({ language: "json", content: JSON.stringify({ status: st.status, hooks: h || {} }, null, 2) });
    await vscode.window.showTextDocument(doc, { preview: true });
  }),
  openSettings: () => run(async () => { await vscode.window.showTextDocument(vscode.Uri.file(settingsPath())); }),
  menu: async () => {
    let st; try { st = state(); } catch (e) { return vscode.window.showErrorMessage(e.message); }
    const items = [
      st.status === "on" ? { label: "$(bell-slash) כבה", id: "disable", detail: `${st.active} hooks פעילים` }
        : st.status === "off" ? { label: "$(bell) הדלק", id: "enable", detail: `${st.stashed} hooks שמורים` } : null,
      { label: "$(globe) פתח את דף ההגדרה", id: "openConfig", detail: "בניית hooks: צינתוק / מענה בגישור / מענה בצינתוק" },
      { label: "$(clippy) ייבא hooks מהלוח", id: "importClipboard", detail: "אחרי \"העתק בלוק hooks\" בדף ההגדרה" },
      { label: "$(pulse) בדיקת שרת", id: "health" },
      { label: "$(key) הגדר טוקן ימות", id: "setToken", detail: "ל-hooks של צינתוק ($env:YEMOT_TOKEN)" },
      { label: "$(list-tree) הצג hooks", id: "show" },
      { label: "$(json) פתח settings.json", id: "openSettings" },
    ].filter(Boolean);
    const p = await vscode.window.showQuickPick(items, { title: "Yemot Hooks — " + (st.status === "on" ? "פעיל" : st.status === "off" ? "כבוי" : "לא מוגדר") });
    if (p) cmds[p.id]();
  },
};

function activate(context) {
  for (const [k, fn] of Object.entries(cmds)) context.subscriptions.push(vscode.commands.registerCommand("yemotHooks." + k, fn));
  bar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 90);
  bar.command = "yemotHooks.menu"; bar.show(); context.subscriptions.push(bar);
  refresh();
  const watch = (f) => { try { fs.watchFile(f, { interval: 2000 }, refresh); context.subscriptions.push({ dispose: () => fs.unwatchFile(f) }); } catch {} };
  watch(settingsPath()); watch(STASH);
  context.subscriptions.push(vscode.workspace.onDidChangeConfiguration((e) => e.affectsConfiguration("yemotHooks") && refresh()));
}
function deactivate() {}
module.exports = { activate, deactivate, _test: { splitHooks, mergeInto, count, SIG } };
