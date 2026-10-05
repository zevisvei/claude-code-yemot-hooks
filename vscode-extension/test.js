// node test.js — sync / legacy migration / runtime, against a temp HOME, a mocked vscode
// module and local mock servers for the Yemot API and the bridge (nothing leaves the machine).
"use strict";
const fs = require("fs"), os = require("os"), path = require("path"), assert = require("assert"), http = require("http");
const { spawn } = require("child_process");

const home = fs.mkdtempSync(path.join(os.tmpdir(), "yh-"));
process.env.HOME = home; process.env.USERPROFILE = home;
const S = path.join(home, ".claude", "settings.json");
fs.mkdirSync(path.dirname(S), { recursive: true });

// ---------------------------------------------------------------- mock vscode
const settings = {};
const Module = require("module"); const orig = Module._load;
let warnPick = "המר והסר";
const listeners = [];
const vscode = {
  workspace: {
    getConfiguration: () => ({ get: (k) => settings[k], update: async (k, v) => { settings[k] = v; listeners.forEach((f) => f({ affectsConfiguration: () => true })); } }),
    onDidChangeConfiguration: (f) => { listeners.push(f); return {}; },
    openTextDocument: async () => ({}),
  },
  window: {
    createStatusBarItem: () => ({ show() {} }), createOutputChannel: () => ({ appendLine() {}, clear() {}, show() {} }),
    showInformationMessage: async () => {}, showErrorMessage: async (m) => { throw new Error("UI error: " + m); },
    showWarningMessage: async () => warnPick, showQuickPick: async () => null, showInputBox: async () => "", showTextDocument: async () => {},
    withProgress: async (_o, f) => f(),
  },
  env: { clipboard: { readText: async () => "" }, openExternal: async () => {} },
  commands: { registerCommand: () => ({}), executeCommand: async () => {} },
  StatusBarAlignment: { Right: 2 }, ThemeColor: class {}, MarkdownString: class { constructor(s) { this.s = s; } },
  Uri: { parse: (u) => u, file: (f) => f }, ConfigurationTarget: { Global: 1 }, ProgressLocation: { Notification: 15 },
};
Module._load = (r, ...a) => (r === "vscode" ? vscode : orig(r, ...a));

const ext = require("./extension.js");
const T = ext._test;
const read = () => JSON.parse(fs.readFileSync(S, "utf8"));
const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));

(async () => { 
  // ---------------------------------------------------------- pure helpers
  assert.equal(T.normServer("http://h:8000/claude-hooks/k/ask-hook"), "http://h:8000/claude-hooks/k");
  assert.equal(T.normServer("http://h/x/ask-hook/ask-hook/"), "http://h/x");
  assert.equal(T.normServer("http://h/x/respond"), "http://h/x");
  assert.equal(T.normIvr("ivr2:/5/5/"), "5/5");

  // ---------------------------------------------------------- legacy settings.json (the real one that broke)
  const legacyAsk = "$ProgressPreference='SilentlyContinue';$cfg='{\"mode\":\"askuser\",\"call_method\":\"tzintuk\",\"method\":\"TZL\",\"phones\":[],\"lists\":[\"1\"],\"ivr_path\":\"5/5\",\"caller_id\":null,\"calls_time_out\":30,\"wait_timeout\":120,\"input_type\":\"HebrewKeyboard\"}';$in=[Console]::In.ReadToEnd();try{$r=Invoke-RestMethod -Uri 'http://h:8000/claude-hooks/K/ask-hook/ask-hook' -Method Post}catch{}";
  const legacyRing = "$t=$env:YEMOT_TOKEN;if(-not $t){exit};$o='{\"phones\":\"tzl:\",\"tzintukLists\":[\"1\"],\"TzintukTimeOut\":9}'|ConvertFrom-Json;Invoke-RestMethod -Uri 'https://www.call2all.co.il/ym/api/RunTzintuk'";
  const other = { type: "command", command: "node other.js" };
  fs.writeFileSync(S, JSON.stringify({
    model: "x", env: { YEMOT_TOKEN: "u:p" },
    hooks: {
      Stop: [{ hooks: [other] }],
      PermissionRequest: [{ hooks: [{ type: "command", shell: "powershell", command: legacyRing, async: true }] }],
      PreToolUse: [{ matcher: "AskUserQuestion", hooks: [{ type: "command", shell: "powershell", command: legacyAsk }] }, { matcher: "AskUserQuestion", hooks: [{ type: "command", shell: "powershell", command: legacyRing }] }],
    },
  }));
  const set = T.legacySettings(T.splitHooks(read().hooks).legacy);
  assert.equal(set["needsPermission.action"], "tzintuk");
  assert.equal(set["asksQuestion.action"], "answer", "bridge wins over the duplicate ring");
  assert.equal(set.serverUrl, "http://h:8000/claude-hooks/K", "double /ask-hook stripped");
  assert.equal(set.ivrPath, "5/5"); assert.equal(set.answerVia, "tzintuk");
  assert.deepEqual(set["target.lists"], ["1"]); assert.equal(set["taskCompleted.action"], "off");

  // ---------------------------------------------------------- activate + migrate
  const extPath = __dirname;
  const cmds = {}; vscode.commands.registerCommand = (k, f) => { cmds[k.split(".")[1]] = f; return {}; };
  Object.assign(settings, { enabled: true, "target.method": "list", "target.lists": ["1"], "needsPermission.action": "off", "asksQuestion.action": "off", "taskCompleted.action": "off", "subagentCompleted.action": "off", waitTimeout: 120 });
  ext.activate({ subscriptions: [], extensionPath: extPath, globalState: { get: () => true, update: async () => {} } });
  let s = read();
  assert.equal(T.count(T.splitHooks(s.hooks).legacy), 3, "legacy untouched until migration");
  await cmds.migrateLegacy(); await tick();
  s = read();
  const sp = T.splitHooks(s.hooks);
  assert.equal(T.count(sp.legacy), 0, "legacy removed");
  assert.equal(s.model, "x"); assert.equal(s.env.YEMOT_TOKEN, "u:p");
  assert.deepEqual(sp.rest.Stop, [{ hooks: [other] }], "foreign hooks kept");
  assert.ok(sp.ours.PermissionRequest && sp.ours.PreToolUse && sp.ours.UserPromptSubmit, "ours registered");
  assert.equal(sp.ours.PreToolUse[0].matcher, "AskUserQuestion");
  assert.equal(sp.ours.PreToolUse[0].hooks[0].timeout, 180, "interactive timeout = wait + 60");
  assert.equal(sp.ours.PermissionRequest[0].hooks[0].timeout, 15);
  assert.ok(!sp.ours.Stop, "Stop off → not registered");
  const cfgFile = JSON.parse(fs.readFileSync(path.join(home, ".claude", "yemot-hooks", "config.json"), "utf8"));
  assert.equal(cfgFile.serverUrl, "http://h:8000/claude-hooks/K");
  assert.ok(fs.existsSync(path.join(home, ".claude", "yemot-hooks", "hook.js")));

  // idempotent: same config → no rewrite
  const mtime = fs.statSync(S).mtimeMs; await tick(20);
  await vscode.workspace.getConfiguration().update("quietHours", ""); await tick();
  assert.equal(fs.statSync(S).mtimeMs, mtime, "unchanged hook set does not rewrite settings.json");

  // disable → only foreign hooks remain; enable → back
  await cmds.disable(); await tick();
  assert.deepEqual(read().hooks, { Stop: [{ hooks: [other] }] });
  await cmds.enable(); await tick();
  assert.ok(T.splitHooks(read().hooks).ours.PermissionRequest);

  // ring delay adds the PostToolUse "clear" hook
  await vscode.workspace.getConfiguration().update("ringDelaySeconds", 30); await tick();
  assert.ok(T.splitHooks(read().hooks).ours.PostToolUse);
  assert.equal((fs.statSync(S).mode & 0o777).toString(8), "600");

  // ---------------------------------------------------------- runtime against mock servers
  const calls = [];
  const srv = http.createServer((req, res) => {
    let b = ""; req.on("data", (d) => (b += d)); req.on("end", () => {
      const body = b ? JSON.parse(b) : {};
      calls.push({ url: req.url, body });
      res.setHeader("Content-Type", "application/json");
      if (req.url.includes("/GetApprovedCallerIDs")) return res.end(JSON.stringify({ responseStatus: "OK", call: { mainDid: "+97231111111", secondaryDids: ["+97232222222"], callerIds: ["+97231111111"] } }));
      if (req.url.includes("/TzintukimListManagement")) return res.end(JSON.stringify({ responseStatus: "OK", lists: [{ listName: "1", subscribers: 1, active: 1 }, { listName: "vip", subscribers: 3, active: 2 }] }));
      if (req.url.endsWith("/RunTzintuk")) return res.end(JSON.stringify({ responseStatus: "OK", callsCount: 1, biling: "0.00", errors: {} }));
      if (req.url === "/claude-hooks/K/ask-hook") return res.end(JSON.stringify({ answered: true, answer: "1", emit: { hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: "allow" } } } }));
      res.statusCode = 404; res.end("{}");
    });
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  const hookJs = path.join(home, ".claude", "yemot-hooks", "hook.js");
  const writeCfg = (patch) => fs.writeFileSync(path.join(home, ".claude", "yemot-hooks", "config.json"), JSON.stringify({ ...cfgFile, enabled: true, ringDelaySeconds: 0, quietHours: "", ...patch }));
  const runHook = (kind, input) => new Promise((resolve) => {
    const env = { ...process.env, HOME: home, USERPROFILE: home, YEMOT_TOKEN: "u:p", YEMOT_HOOKS_API: base + "/ym/api/" };
    const p = spawn(process.execPath, [hookJs, kind], { env });
    let stdout = ""; p.stdout.setEncoding("utf8"); p.stdout.on("data", (d) => (stdout += d));
    p.on("close", (status) => resolve({ status, stdout }));
    p.stdin.end(JSON.stringify(input));
  });
  const waitFor = async (pred, ms = 3000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (pred()) return true; await tick(50); } return false; };

  // tzintuk on permission (detached child)
  writeCfg({ events: { ...cfgFile.events, needsPermission: { action: "tzintuk", target: "", tools: "" } } });
  let r = await runHook("permission", { session_id: "s1", tool_name: "Bash" });
  assert.equal(r.status, 0); assert.equal(r.stdout, "");
  assert.ok(await waitFor(() => calls.some((c) => c.url.endsWith("/RunTzintuk"))), "tzintuk sent");
  const ring = calls.find((c) => c.url.endsWith("/RunTzintuk")).body;
  assert.equal(ring.phones, "tzl:"); assert.deepEqual(ring.tzintukLists, ["1"]); assert.equal(ring.token, "u:p");

  // per-event caller id beats the default
  calls.length = 0;
  writeCfg({ callerId: "0300000000", events: { ...cfgFile.events, needsPermission: { action: "tzintuk", target: "", tools: "", callerId: "0799999999" } } });
  await runHook("permission", { session_id: "s1", tool_name: "Bash" });
  assert.ok(await waitFor(() => calls.length > 0));
  assert.equal(calls[0].body.callerId, "0799999999", "event caller id");
  calls.length = 0;
  writeCfg({ callerId: "0300000000", events: { ...cfgFile.events, needsPermission: { action: "tzintuk", target: "", tools: "", callerId: "" } } });
  await runHook("permission", { session_id: "s1", tool_name: "Bash" });
  assert.ok(await waitFor(() => calls.length > 0));
  assert.equal(calls[0].body.callerId, "0300000000", "default caller id");

  // pickers: configure an event from data loaded from (mock) Yemot
  process.env.YEMOT_HOOKS_API = base + "/ym/api/";
  const picks = [
    (items) => items.find((i) => i.key === "taskCompleted"),
    (items) => items.find((i) => i.a === "tzintuk"),
    (items) => items.find((i) => i.kind === "list"),
    (items) => items.filter((i) => i.label === "vip"),
    (items) => { assert.deepEqual(items.map((i) => i.value).slice(0, 3), ["", "031111111", "032222222"], "caller ids loaded + localized"); return items.find((i) => i.value === "032222222"); },
  ];
  vscode.window.showQuickPick = async (items) => picks.shift()(items);
  await cmds.configureEvent(); await tick(80);
  assert.equal(picks.length, 0, "all pickers consumed");
  assert.equal(settings["taskCompleted.action"], "tzintuk");
  assert.equal(settings["taskCompleted.target"], "list:vip");
  assert.equal(settings["taskCompleted.callerId"], "032222222");
  const synced = JSON.parse(fs.readFileSync(path.join(home, ".claude", "yemot-hooks", "config.json"), "utf8"));
  assert.equal(synced.events.taskCompleted.callerId, "032222222", "picked caller id reaches config.json");
  assert.ok(T.splitHooks(read().hooks).ours.Stop, "Stop hook registered after enabling the event");

  // tools filter
  calls.length = 0;
  writeCfg({ events: { ...cfgFile.events, needsPermission: { action: "tzintuk", target: "", tools: "Write|Edit" } } });
  await runHook("permission", { session_id: "s1", tool_name: "Bash" }); await tick(400);
  assert.equal(calls.length, 0, "tool not matching → no ring");

  // per-event target override
  writeCfg({ events: { ...cfgFile.events, needsPermission: { action: "tzintuk", target: "phones:972501234567", tools: "" } } });
  await runHook("permission", { session_id: "s1", tool_name: "Bash" });
  assert.ok(await waitFor(() => calls.length > 0));
  assert.equal(calls[0].body.phones, "0501234567");

  // quiet hours covering the whole day except one minute → skipped
  calls.length = 0;
  const now = new Date(), hm = (d) => `${d.getHours()}:${String(d.getMinutes()).padStart(2, "0")}`;
  writeCfg({ quietHours: `${hm(new Date(now - 60000))}-${hm(new Date(+now + 120000))}`, events: { ...cfgFile.events, needsPermission: { action: "tzintuk", target: "", tools: "" } } });
  await runHook("permission", { session_id: "s1", tool_name: "Bash" }); await tick(400);
  assert.equal(calls.length, 0, "quiet hours");

  // ring delay cancelled by a reply (PostToolUse "clear")
  writeCfg({ ringDelaySeconds: 1, events: { ...cfgFile.events, needsPermission: { action: "tzintuk", target: "", tools: "" } } });
  await runHook("permission", { session_id: "s2", tool_name: "Bash" });
  await runHook("clear", { session_id: "s2" });
  await tick(1600);
  assert.equal(calls.length, 0, "answered in time → no ring");
  await runHook("permission", { session_id: "s3", tool_name: "Bash" });
  assert.ok(await waitFor(() => calls.length > 0, 3500), "unanswered → ring after delay");

  // interactive permission → bridge, emit printed
  calls.length = 0;
  writeCfg({ serverUrl: base + "/claude-hooks/K", events: { ...cfgFile.events, needsPermission: { action: "answer", target: "", tools: "" } } });
  r = await runHook("permission", { session_id: "s4", tool_name: "Bash", tool_input: { command: "ls" } });
  assert.equal(JSON.parse(r.stdout).hookSpecificOutput.decision.behavior, "allow");
  const ask = calls.find((c) => c.url === "/claude-hooks/K/ask-hook");
  assert.ok(ask, "posted to <server>/ask-hook exactly once-suffixed");
  assert.equal(ask.body.config.mode, "permission"); assert.equal(ask.body.config.call_method, "tzintuk"); assert.equal(ask.body.config.ivr_path, "5/5");

  // bridge down → fallback tzintuk
  calls.length = 0;
  writeCfg({ serverUrl: base + "/nope", events: { ...cfgFile.events, needsPermission: { action: "answer", target: "", tools: "" } } });
  r = await runHook("permission", { session_id: "s5", tool_name: "Bash" });
  assert.equal(r.stdout, "");
  assert.ok(calls.some((c) => c.url.endsWith("/RunTzintuk")), "fallback ring");
  assert.ok(fs.readFileSync(path.join(home, ".claude", "yemot-hooks", "hook.log"), "utf8").includes("ERROR bridge"), "failure logged");

  // min task duration on Stop
  calls.length = 0;
  writeCfg({ minTaskDurationSeconds: 60, events: { ...cfgFile.events, taskCompleted: { action: "tzintuk", target: "" } } });
  await runHook("prompt", { session_id: "s6" });
  await runHook("stop", { session_id: "s6" }); await tick(400);
  assert.equal(calls.length, 0, "short task → no ring");

  // disabled → nothing
  writeCfg({ enabled: false, events: { ...cfgFile.events, needsPermission: { action: "tzintuk", target: "", tools: "" } } });
  await runHook("permission", { session_id: "s7", tool_name: "Bash" }); await tick(400);
  assert.equal(calls.length, 0, "disabled");

  srv.close();
  console.log("ALL TESTS PASSED"); process.exit(0);
})().catch((e) => { console.error("FAIL", e); process.exit(1); });
