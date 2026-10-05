// node test.js — exercises on/off/import logic against a temp HOME with a mocked vscode module
const fs = require("fs"), os = require("os"), path = require("path"), assert = require("assert");
const home = fs.mkdtempSync(path.join(os.tmpdir(), "yh-")); process.env.HOME = home;
const Module = require("module"); const orig = Module._load;
let clip = "", confirm = "ייבא והדלק";
const vscode = {
  workspace: { getConfiguration: () => ({ get: (k) => ({ serverUrl: "http://x", settingsFile: "~/.claude/settings.json" })[k] }), onDidChangeConfiguration: () => ({}) , openTextDocument: async()=>({}) },
  window: { createStatusBarItem: () => ({ show() {} }), showInformationMessage: async () => {}, showErrorMessage: async (m) => { throw new Error("UI error: " + m); }, showWarningMessage: async () => confirm, showQuickPick: async () => null, showInputBox: async () => "u:p", showTextDocument: async()=>{} },
  env: { clipboard: { readText: async () => clip }, openExternal: async () => {} },
  commands: { registerCommand: () => ({}) }, StatusBarAlignment: { Right: 2 }, ThemeColor: class {}, MarkdownString: class { constructor(s) { this.s = s; } }, Uri: { parse: (u) => u, file: (f) => f },
};
Module._load = (r, ...a) => (r === "vscode" ? vscode : orig(r, ...a));
const ext = require("./extension.js");
const cmds = {}; vscode.commands.registerCommand = (k, f) => { cmds[k.split(".")[1]] = f; return {}; };
ext.activate({ subscriptions: [] });
const S = path.join(home, ".claude", "settings.json");
fs.mkdirSync(path.dirname(S), { recursive: true });
const other = { type: "command", command: "echo other" };
fs.writeFileSync(S, JSON.stringify({ model: "x", hooks: { Stop: [{ hooks: [other] }] } }));
const ring = { type: "command", shell: "powershell", command: "Invoke-RestMethod RunTzintuk ..." };
const ask = { type: "command", shell: "powershell", command: "Invoke-RestMethod 'http://h/claude-hooks/k/ask-hook'", timeout: 140 };
const read = () => JSON.parse(fs.readFileSync(S, "utf8"));
const tick = () => new Promise((r) => setTimeout(r, 50));
(async () => {
  clip = JSON.stringify({ hooks: { Stop: [{ hooks: [ring] }], PreToolUse: [{ matcher: "AskUserQuestion", hooks: [ask] }] } });
  await cmds.importClipboard(); await tick();
  let s = read();
  assert.equal(s.model, "x"); assert.equal(s.hooks.Stop.length, 2); assert.equal(s.hooks.PreToolUse[0].matcher, "AskUserQuestion");
  await cmds.disable(); await tick(); s = read();
  assert.deepEqual(s.hooks, { Stop: [{ hooks: [other] }] }, "off keeps only foreign hooks");
  await cmds.enable(); await tick(); s = read();
  assert.equal(JSON.stringify(s).includes("RunTzintuk"), true); assert.equal(s.hooks.Stop.length, 2);
  await cmds.enable(); await tick(); assert.equal(read().hooks.Stop.length, 2, "double enable no dup");
  clip = JSON.stringify({ hooks: { Stop: [{ hooks: [ring] }] } }); await cmds.importClipboard(); await tick(); s = read();
  assert.equal(s.hooks.PreToolUse, undefined, "re-import replaces ours"); assert.equal(s.hooks.Stop.length, 2);
  await cmds.toggle(); await tick(); assert.equal(JSON.stringify(read()).includes("RunTzintuk"), false);
  await cmds.toggle(); await tick(); assert.equal(JSON.stringify(read()).includes("RunTzintuk"), true);
  await cmds.setToken(); await tick(); assert.equal(read().env.YEMOT_TOKEN, "u:p");
  assert.equal((fs.statSync(S).mode & 0o777).toString(8), "600");
  console.log("ALL TESTS PASSED"); process.exit(0);
})().catch((e) => { console.error("FAIL", e); process.exit(1); });
