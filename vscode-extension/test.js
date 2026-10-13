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
  assert.ok(sp.ours.PermissionRequest && sp.ours.UserPromptSubmit, "ours registered");
  assert.ok(!sp.ours.PreToolUse, "a question is asked in PermissionRequest now (Claude Code shows it at the computer meanwhile)");
  const qg = sp.ours.PermissionRequest.find((g) => g.matcher === "AskUserQuestion"), pg = sp.ours.PermissionRequest.find((g) => !g.matcher);
  assert.equal(qg.hooks[0].timeout, 180, "interactive timeout = wait + 60");
  assert.equal(pg.hooks[0].timeout, 15);
  assert.ok(sp.ours.PostToolUse, "PostToolUse: answered at the computer ends the call");
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
  const calls = [], screens = []; let askDelay = 0;
  /** One second of silence as Yemot records it: WAV, PCM 16 bit, 8 kHz, mono. */
  const wav = () => { const d = Buffer.alloc(16000), h = Buffer.alloc(44); h.write("RIFF", 0); h.writeUInt32LE(36 + d.length, 4); h.write("WAVEfmt ", 8); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22); h.writeUInt32LE(8000, 24); h.writeUInt32LE(16000, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34); h.write("data", 36); h.writeUInt32LE(d.length, 40); return Buffer.concat([h, d]); };
  const srv = http.createServer((req, res) => {
    let b = ""; req.on("data", (d) => (b += d)); req.on("end", () => {
      const body = b ? JSON.parse(b) : {};
      calls.push({ url: req.url, body });
      res.setHeader("Content-Type", "application/json");
      if (req.url.includes("/GetApprovedCallerIDs")) return res.end(JSON.stringify({ responseStatus: "OK", call: { mainDid: "+97231111111", secondaryDids: ["+97232222222"], callerIds: ["+97231111111"] } }));
      if (req.url.includes("/TzintukimListManagement")) return res.end(JSON.stringify({ responseStatus: "OK", lists: [{ listName: "1", subscribers: 1, active: 1 }, { listName: "vip", subscribers: 3, active: 2 }] }));
      if (req.url.endsWith("/RunTzintuk")) return res.end(JSON.stringify({ responseStatus: "OK", callsCount: 1, biling: "0.00", errors: {} }));
      if (req.url === "/claude-hooks/K/ask-hook") return setTimeout(() => res.end(JSON.stringify({ answered: true, answer: body.config.mode === "askuser" ? "2" : "1", emit: { hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: "allow" } } } })), askDelay);
      // the phone chat (chat.js): screens, and the recordings it fetches from the IVR
      if (req.url === "/claude-hooks/K/chat/screen") { screens.push(body); return res.end(JSON.stringify({ ok: true })); }
      if (req.url === "/claude-hooks/K/chat/poll") return setTimeout(() => res.end(JSON.stringify({ events: [] })), 200);
      if (req.url.includes("/DownloadFile")) { res.setHeader("Content-Type", "application/octet-stream"); return res.end(wav()); }
      if (req.url.includes("/FileAction")) return res.end(JSON.stringify({ responseStatus: "OK" }));
      res.statusCode = 404; res.end("{}");
    });
  });
  // Claude's dictation service (WebSocket): the query and the binary frames are noted, one utterance comes back
  const sttSeen = { query: "", frames: 0 };
  srv.on("upgrade", (req, sock) => {
    sttSeen.query = req.url; sttSeen.frames = 0;
    const accept = require("crypto").createHash("sha1").update(req.headers["sec-websocket-key"] + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest("base64");
    sock.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    const frame = (op, data) => { const d = Buffer.from(data); return Buffer.concat([Buffer.from([0x80 | op, d.length < 126 ? d.length : 126]), d.length < 126 ? Buffer.alloc(0) : Buffer.from([d.length >> 8, d.length & 255]), d]); };
    let buf = Buffer.alloc(0);
    sock.on("data", (d) => {
      buf = Buffer.concat([buf, d]);
      while (buf.length >= 2) {
        let len = buf[1] & 127, off = 2;
        if (len === 126) { len = buf.readUInt16BE(2); off = 4; }
        if (buf.length < off + 4 + len) return;
        const mask = buf.subarray(off, off + 4), pl = Buffer.from(buf.subarray(off + 4, off + 4 + len)).map((x, i) => x ^ mask[i % 4]), op = buf[0] & 15;
        buf = buf.subarray(off + 4 + len);
        if (op === 2) sttSeen.frames++;
        if (op === 1 && pl.toString().includes("CloseStream")) {
          for (const m of [{ type: "TranscriptText", data: "תבדוק את הלוגים" }, { type: "TranscriptEndpoint" }]) sock.write(frame(1, JSON.stringify(m)));
          sock.write(frame(8, Buffer.from([3, 232]))); sock.end();
        }
      }
    });
    sock.on("error", () => {});
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

  // a question: asked in PermissionRequest (shown at the computer meanwhile); the digit → the option, as a real answer
  const qInput = { session_id: "q1", hook_event_name: "PermissionRequest", tool_name: "AskUserQuestion", tool_input: { questions: [{ question: "צבע?", options: [{ label: "אדום" }, { label: "כחול" }] }] } };
  writeCfg({ serverUrl: base + "/claude-hooks/K", events: { ...cfgFile.events, asksQuestion: { action: "answer", target: "" } } });
  r = await runHook("question", qInput);
  let qo = JSON.parse(r.stdout).hookSpecificOutput;
  assert.ok(qo.hookEventName === "PermissionRequest" && qo.decision.behavior === "allow" && qo.decision.updatedInput.answers["צבע?"] === "כחול", r.stdout);
  // hooks registered by an older version (PreToolUse): answered in that form
  qo = JSON.parse((await runHook("question", { ...qInput, hook_event_name: "PreToolUse" })).stdout).hookSpecificOutput;
  assert.ok(qo.hookEventName === "PreToolUse" && qo.permissionDecision === "allow" && qo.updatedInput.answers["צבע?"] === "כחול");
  // answered at the computer while the phone rings: the tool ran (PostToolUse of that tool) → the call is dropped
  askDelay = 5000;
  let t0 = Date.now(); const pend = runHook("question", { ...qInput, session_id: "q2" });
  await tick(700);
  await runHook("clear", { session_id: "q2", tool_name: "Read", agent_id: "a1" }); // a sub-agent's tool: still asking
  await tick(700);
  await runHook("clear", { session_id: "q2", tool_name: "AskUserQuestion" });
  r = await pend;
  assert.ok(r.stdout === "" && Date.now() - t0 < 4000, `dropped, nothing printed (${Date.now() - t0} ms)`);
  askDelay = 0;
  // answerDelaySeconds: answered at the computer in time → no call at all
  calls.length = 0;
  writeCfg({ serverUrl: base + "/claude-hooks/K", answerDelaySeconds: 2, events: { ...cfgFile.events, asksQuestion: { action: "answer", target: "" } } });
  const pend2 = runHook("question", { ...qInput, session_id: "q3" });
  await tick(500); await runHook("clear", { session_id: "q3", tool_name: "AskUserQuestion" });
  assert.equal((await pend2).stdout, ""); assert.ok(!calls.some((c) => c.url.endsWith("/ask-hook")), "no call");
  // a session of the phone chat asks on its own call: the hooks stay out
  writeCfg({ serverUrl: base + "/claude-hooks/K", events: { ...cfgFile.events, needsPermission: { action: "answer", target: "", tools: "" } } });
  const chatRun = await new Promise((resolve) => { const p = spawn(process.execPath, [hookJs, "permission"], { env: { ...process.env, HOME: home, YEMOT_TOKEN: "u:p", YEMOT_HOOKS_API: base + "/ym/api/", YEMOT_HOOKS_CHAT: "1" } }); let o = ""; p.stdout.on("data", (d) => (o += d)); p.on("close", () => resolve(o)); p.stdin.end(JSON.stringify({ session_id: "c1", tool_name: "Bash" })); });
  assert.equal(chatRun, "");
  assert.ok(!calls.some((c) => c.url.endsWith("/ask-hook")), "chat session: no call");

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

  // ---------------------------------------------------------- chat with Claude by phone (hooks/chat.js)
  {
    const fake = path.join(home, "fake-claude.js"), argsLog = path.join(home, "claude-args.jsonl"), proj = path.join(home, "myproj");
    fs.mkdirSync(proj);
    fs.writeFileSync(fake, `#!${process.execPath}
const fs=require("fs");const a=process.argv.slice(2);const o=(x)=>process.stdout.write(JSON.stringify(x)+"\\n");
let buf="",P="",pend=null;
const finish=(extra="")=>{o({type:"result",subtype:"success",is_error:false,result:"**בוצע**: "+P+extra,session_id:"s"});};
process.stdin.setEncoding("utf8");
process.stdin.on("data",(d)=>{buf+=d;let i;while((i=buf.indexOf("\\n"))>=0){const l=buf.slice(0,i);buf=buf.slice(i+1);const m=JSON.parse(l);
  if(m.type==="user"){P=m.message.content;fs.appendFileSync(${JSON.stringify(argsLog)},JSON.stringify({a,cwd:process.cwd(),p:P,chat:process.env.YEMOT_HOOKS_CHAT})+"\\n");
    if(P.startsWith("perm"))o({type:"control_request",request_id:"r1",request:{subtype:"can_use_tool",tool_name:"Bash",input:{command:"rm -rf build"}}});
    else if(P.startsWith("שאלה"))o({type:"control_request",request_id:"r2",request:{subtype:"can_use_tool",tool_name:"AskUserQuestion",input:{questions:[{question:"איזה צבע?",options:[{label:"אדום"},{label:"כחול"}]}]}}});
    else if(P.startsWith("slow"))setTimeout(()=>finish(),1500);
    else finish();}
  if(m.type==="control_response"){const r=m.response.response;finish(" · "+r.behavior+(r.updatedInput&&r.updatedInput.answers?" "+JSON.stringify(r.updatedInput.answers):""));}
}});
process.stdin.on("end",()=>process.exit(0));
`, { mode: 0o755 });
    const PH = "0501112222";
    fs.writeFileSync(path.join(home, ".claude", ".credentials.json"), JSON.stringify({ claudeAiOauth: { accessToken: "tok", expiresAt: Date.now() + 3600e3 } }));
    Object.assign(process.env, { YEMOT_TOKEN: "u:p", YEMOT_HOOKS_API: base + "/ym/api/", YEMOT_HOOKS_STT_URL: base.replace("http", "ws") + "/stt" });
    writeCfg({ serverUrl: base + "/claude-hooks/K", chat: { enabled: true, ivrPath: "5/6", phones: [PH], projects: [proj], claudePath: fake, hint: false } });
    const chat = require(path.join(home, ".claude", "yemot-hooks", "chat.js"));
    const ev = (e) => { chat.onEvent(chat.config(), e); return tick(60); }, last = () => screens[screens.length - 1] || {};
    const runs = () => fs.readFileSync(argsLog, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    await ev({ type: "start", call: "X", phone: "0509990000" });
    assert.ok(await waitFor(() => screens.some((x) => x.call === "X" && x.input === "hangup")), "a phone not on the list is hung up on");
    await ev({ type: "start", call: "C1", phone: "+972-50-111-2222" });
    assert.ok(await waitFor(() => last().call === "C1" && last().input === "digits" && last().say.includes("להקלדה הקש 2")), "the menu");
    // typed → Claude (in the first folder) → the answer read out, no markup, then the menu
    await ev({ type: "input", call: "C1", value: "2" }); await waitFor(() => last().input === "text");
    let k = screens.length;
    await ev({ type: "input", call: "C1", value: "מה שלומך" });
    assert.ok(await waitFor(() => screens.slice(k).some((x) => x.say.includes("קלוד ענה: בוצע : מה שלומך") && x.input === "digits"), 5000), JSON.stringify(screens.slice(k)));
    let rr = runs(); assert.ok(rr[0].cwd === proj && rr[0].a.includes("--session-id") && rr[0].a.includes("--permission-prompt-tool") && rr[0].chat === "1", JSON.stringify(rr[0]));
    // a permission: asked on the call; the next message resumes the same session
    await ev({ type: "input", call: "C1", value: "2" }); await waitFor(() => last().input === "text");
    k = screens.length;
    await ev({ type: "input", call: "C1", value: "perm נקה" });
    assert.ok(await waitFor(() => last().say?.includes("קלוד מבקש הרשאה") && last().say.includes("rm -rf build")), "asked on the call");
    await ev({ type: "input", call: "C1", value: "1" });
    assert.ok(await waitFor(() => screens.slice(k).some((x) => x.say.includes("allow")), 5000), "approved");
    rr = runs(); assert.ok(rr[1].a.includes("--resume") && rr[1].a[rr[1].a.indexOf("--resume") + 1] === rr[0].a[rr[0].a.indexOf("--session-id") + 1], "the same session goes on");
    // a question: the digit picks the option, given to Claude as its answer
    await waitFor(() => last().input === "digits");
    await ev({ type: "input", call: "C1", value: "2" }); await waitFor(() => last().input === "text");
    k = screens.length;
    await ev({ type: "input", call: "C1", value: "שאלה" });
    assert.ok(await waitFor(() => last().say?.includes("קלוד שואל") && last().say.includes("איזה צבע")), "the question read out");
    await ev({ type: "input", call: "C1", value: "2" });
    assert.ok(await waitFor(() => screens.slice(k).some((x) => x.say.includes("כחול")), 5000), "answered: " + JSON.stringify(screens.slice(k).map((x) => x.say)));
    // recorded: fetched only from the rec folder, transcribed (WAV as linear16), read back, sent
    await waitFor(() => last().input === "digits");
    await ev({ type: "input", call: "C1", value: "1" }); await waitFor(() => last().input === "record");
    await ev({ type: "input", call: "C1", value: "/1/secret.wav" });
    assert.ok(await waitFor(() => last().say?.includes("לא נקלטה")) && !calls.some((x) => x.url.includes("/DownloadFile")), "nothing outside the rec folder");
    await ev({ type: "input", call: "C1", value: "/5/6/rec/000.wav" });
    assert.ok(await waitFor(() => last().say?.includes("שמעתי: תבדוק את הלוגים")), "read back: " + JSON.stringify(last()));
    assert.ok(sttSeen.query.includes("encoding=linear16") && sttSeen.query.includes("sample_rate=8000") && sttSeen.frames > 0, sttSeen.query);
    assert.ok(calls.some((x) => x.url.includes("/FileAction")), "deleted from the IVR");
    k = screens.length;
    await ev({ type: "input", call: "C1", value: "1" });
    assert.ok(await waitFor(() => screens.slice(k).some((x) => x.say.includes("קלוד ענה: בוצע : תבדוק את הלוגים")), 5000));
    // a new conversation in a chosen folder ("כללי")
    await waitFor(() => last().input === "digits");
    await ev({ type: "input", call: "C1", value: "4" });
    assert.ok(await waitFor(() => last().say?.includes("באיזה פרויקט") && last().say.includes("myproj") && last().say.includes("שיחה כללית")));
    await ev({ type: "input", call: "C1", value: "2" }); await waitFor(() => last().say?.includes("שיחה חדשה"));
    await ev({ type: "input", call: "C1", value: "2" }); await waitFor(() => last().input === "text");
    k = screens.length;
    await ev({ type: "input", call: "C1", value: "שלום כללי" });
    assert.ok(await waitFor(() => screens.slice(k).some((x) => x.say.includes("קלוד ענה")), 5000));
    rr = runs(); assert.ok(rr[rr.length - 1].cwd.endsWith("chat-general") && rr[rr.length - 1].a.includes("--session-id"), "a new session in its folder");
    // hung up before the answer: a tzintuk, and the answer at the next call
    await waitFor(() => last().input === "digits");
    await ev({ type: "input", call: "C1", value: "2" }); await waitFor(() => last().input === "text");
    calls.length = 0;
    await ev({ type: "input", call: "C1", value: "slow אחרי הניתוק" });
    await ev({ type: "hangup", call: "C1" });
    assert.ok(await waitFor(() => calls.some((x) => x.url.endsWith("/RunTzintuk") && x.body.phones === PH), 5000), "rang");
    await ev({ type: "start", call: "C2", phone: PH });
    assert.ok(await waitFor(() => last().call === "C2" && last().say.includes("יש תשובה חדשה") && last().say.includes("אחרי הניתוק")), JSON.stringify(last()));
    // a PIN, when set
    writeCfg({ serverUrl: base + "/claude-hooks/K", chat: { enabled: true, ivrPath: "5/6", phones: [PH], pin: "4321", projects: [proj], claudePath: fake } });
    await ev({ type: "start", call: "C3", phone: PH });
    assert.ok(await waitFor(() => last().call === "C3" && last().say.includes("קוד הגישה")));
    await ev({ type: "input", call: "C3", value: "1111" }); assert.ok(await waitFor(() => last().say.includes("קוד שגוי")));
    await ev({ type: "input", call: "C3", value: "4321" }); assert.ok(await waitFor(() => last().say.includes("להקלדה הקש 2")), "opened");
  }

  srv.close();
  console.log("ALL TESTS PASSED"); process.exit(0);
})().catch((e) => { console.error("FAIL", e); process.exit(1); });
