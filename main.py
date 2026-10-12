"""Yemot <-> Claude Code interactive-input bridge.

Two ways an interactive hook builds its phone menu:

* "askuser" (dynamic) - the hook fires on PreToolUse for Claude's `AskUserQuestion`
  tool. The hook pipes its stdin (the tool call, containing the question and its
  options) to /ask-hook. The server reads those options out as the DTMF menu, so
  the options come from *Claude's own question*, not from anything typed in
  advance. An extra "אחר" (Other) option is added for free-text input, matching
  AskUserQuestion's always-available Other. The caller's choice is returned as a
  PreToolUse deny + reason, which Claude reads and acts on (a hook cannot inject a
  synthetic tool result, so deny+reason is the supported channel).
* "manual" (fixed) - options are configured ahead of time in the HTML UI. Useful
  for events that carry no options (Stop, UserPromptSubmit, ...).

* "chat" (a conversation with Claude) - its own extension, api_link = /chat/respond. This
  server only runs the call; the computer (claude-notify-hub's bot service) long-polls
  /chat/poll for what the caller did and sends what to play with /chat/screen. See the
  section at the end.

Flow: /ask-hook places an outbound bridging call (call_extension_bridging) that
drops the user into a Yemot `api` extension; Yemot then calls /respond (always
GET). We play the menu, collect a digit, and for an "open" option send a second
`read` that collects free text via the keyboard (not digits). The chosen option
maps to a pre-built "emit" (the exact JSON a Claude hook returns); for an open
option the free text is injected in place of the sentinel "__OPEN_TEXT__".

Questions are correlated by extension (ApiExtension), so several questions - each
on its own `api` extension - can be in flight at once.

Run:  uv run uvicorn main:app --host 0.0.0.0 --port 8000
Then expose the port on a public URL (any tunnel / reverse proxy) so Yemot can
reach /respond; set that public URL as the api extension's api_link (done via the
HTML config).

Env:
  YEMOT_TOKEN   Yemot API token "user:password" (required only to place outbound calls)
"""
from __future__ import annotations

import asyncio
import json
import os
import re
import time
from dataclasses import dataclass, field
from typing import Annotated, Any

from fastapi import Depends, FastAPI, Request
from fastapi.responses import PlainTextResponse
from pydantic import BaseModel
from yemot_api.api_model import ApiModel
from yemot_api.api_response import IdListMessageType, PlayConfirmType, go_to_folder, hangup, read_record, read_text
from yemot_api.api_response import join as api_response_join
from yemot_api.async_yemot_api import AsyncYemot
from yemot_api.input_types import RunTzintukMethod

YEMOT_TOKEN = os.environ.get("YEMOT_TOKEN", "")

SENTINEL = "__OPEN_TEXT__"   # replaced by the caller's free text inside an emit

_KEYBOARDS = {
    "HebrewKeyboard": PlayConfirmType.HebrewKeyboard,
    "EnglishKeyboard": PlayConfirmType.EnglishKeyboard,
    "DigitsKeyboard": PlayConfirmType.DigitsKeyboard,
    "Number": PlayConfirmType.Number,
}

app = FastAPI(title="yemot-claude-bridge")


# ---------------------------------------------------------------- state
@dataclass
class Pending:
    question: str                                # full spoken menu prompt
    options: dict[str, dict[str, Any]]           # digit -> {label, emit, open?, open_prompt?, input_type?}
    phone: str
    stage: str = "menu"                          # "menu" -> "text" -> done
    selected: str | None = None
    answer: str | None = None
    emit: dict[str, Any] | None = None
    event: asyncio.Event = field(default_factory=asyncio.Event)

    def pure_open(self) -> dict[str, Any] | None:
        if len(self.options) == 1:
            only = next(iter(self.options.values()))
            if only.get("open"):
                return only
        return None


_pending: dict[str, Pending] = {}                # extension key -> Pending


# ---------------------------------------------------------------- helpers
def _norm_phone(p: str | None) -> str:
    d = re.sub(r"\D", "", p or "")
    if d.startswith("972"):          # Yemot wants 10-digit local form with leading 0
        d = "0" + d[3:]
    return d


def _norm_ext(s: str | None) -> str:
    return (s or "").replace("ivr2:", "").strip("/")


def _sanitize_tts(text: str) -> str:
    return re.sub(r'[,\-=&|"\'.\r\n]', " ", text).strip() or "אנא בחר אפשרות"


def _inject(obj: object, text: str) -> object:
    """Deep-replace the SENTINEL substring with the caller's free text."""
    if isinstance(obj, str):
        return obj.replace(SENTINEL, text)
    if isinstance(obj, dict):
        return {k: _inject(v, text) for k, v in obj.items()}
    if isinstance(obj, list):
        return [_inject(v, text) for v in obj]
    return obj


def _find(ext: str | None, phone: str | None) -> Pending | None:
    p = _pending.get(_norm_ext(ext))
    if p is not None:
        return p
    ph = _norm_phone(phone)                       # fallback if ext format differs
    for cand in _pending.values():
        if cand.phone == ph:
            return cand
    return None


# ---------------------------------------------------------------- option building
def _askuser_emit(answer_text: str) -> dict[str, Any]:
    # A hook cannot inject a tool result; deny + reason feeds the answer to Claude.
    return {"hookSpecificOutput": {
        "hookEventName": "PreToolUse",
        "permissionDecision": "deny",
        "permissionDecisionReason": f"המשתמש ענה בטלפון: {answer_text}. המשך בהתאם לתשובה.",
    }}


def _perm_emit(behavior: str) -> dict[str, Any]:
    # PermissionRequest uses hookSpecificOutput.decision.behavior (not permissionDecision).
    return {"hookSpecificOutput": {"hookEventName": "PermissionRequest",
                                   "decision": {"behavior": behavior}}}


def _open_emit(event: str, kind: str) -> dict[str, Any]:
    # free-text answer for events with no Claude-supplied question; SENTINEL -> the text
    if kind == "stopblock":
        return {"decision": "block", "reason": SENTINEL}
    return {"hookSpecificOutput": {"hookEventName": event or "UserPromptSubmit",
                                   "additionalContext": SENTINEL}}


def _askuser_options(options: list[dict[str, Any]], input_type: str) -> dict[str, dict[str, Any]]:
    out: dict[str, dict[str, Any]] = {}
    for i, o in enumerate(options, 1):
        label = str(o.get("label", "")).strip() or f"אפשרות {i}"
        out[str(i)] = {"label": label, "emit": _askuser_emit(label)}
    other = str(len(options) + 1)
    out[other] = {"label": "אחר", "open": True, "input_type": input_type,
                  "open_prompt": "הקלד את תשובתך ואז סולמית", "emit": _askuser_emit(SENTINEL)}
    return out


def _spoken_menu(question: str, options: dict[str, dict[str, Any]]) -> str:
    parts = [question] if question else []
    parts += [f"למקש {d} {o.get('label', '')}" for d, o in options.items()]
    return "  ".join(parts)


def _parse(hook_input: object) -> dict[str, Any]:
    if isinstance(hook_input, dict):
        return hook_input
    if isinstance(hook_input, str) and hook_input.strip():
        try:
            return json.loads(hook_input)
        except json.JSONDecodeError:
            return {}
    return {}


def _summarize(data: dict[str, Any]) -> str:
    tool = str(data.get("tool_name", "")).strip()
    ti = data.get("tool_input", {}) or {}
    detail = ti.get("command") or ti.get("file_path") or ti.get("url") or ti.get("path") or ""
    if not detail and ti:
        detail = json.dumps(ti, ensure_ascii=False)[:160]
    return f"{tool} {detail}".strip() or "פעולה"


def _build(cfg: HookConfig, hook_input: object) -> tuple[str, dict[str, dict[str, Any]]]:
    data = _parse(hook_input)
    if cfg.mode == "askuser":
        questions = (data.get("tool_input", {}) or {}).get("questions") or []
        q0 = questions[0] if questions else {}
        question = str(q0.get("question") or "שאלה")
        options = _askuser_options(q0.get("options") or [], cfg.input_type)
        return _spoken_menu(question, options), options
    if cfg.mode == "open":
        prompt = cfg.question or "אנא הקלד את תשובתך ואז סולמית"
        opt = {"label": "", "open": True, "input_type": cfg.input_type,
               "open_prompt": prompt, "emit": _open_emit(cfg.event, cfg.emit_kind)}
        return prompt, {"1": opt}
    # permission (default for anything not askuser/open)
    options = {"1": {"label": "אישור", "emit": _perm_emit("allow")},
               "2": {"label": "ביטול", "emit": _perm_emit("deny")}}
    spoken = f"קלוד מבקש הרשאה {_summarize(data)}  לאישור הקש 1  לביטול הקש 2"
    return spoken, options


# ---------------------------------------------------------------- read builders
def _menu_read(p: Pending) -> str:
    digits = list(p.options.keys())
    widths = [len(d) for d in digits] or [1]
    return read_text(IdListMessageType.Text, _sanitize_tts(p.question), "sel",
                     max_digits=max(widths), min_digits=min(widths),
                     allowed_values=digits, conform=False)


def _text_read(opt: dict[str, Any]) -> str:
    prompt = _sanitize_tts(opt.get("open_prompt") or "הקלד את תשובתך ואז סולמית")
    kb = _KEYBOARDS.get(opt.get("input_type") or "HebrewKeyboard", PlayConfirmType.HebrewKeyboard)
    return read_text(IdListMessageType.Text, prompt, "txt", play_confirm_type=kb)


# ---------------------------------------------------------------- models
class HookConfig(BaseModel):
    mode: str = "askuser"                          # "askuser" | "permission" | "open"
    event: str = ""                                # hook event name (for open-mode emit)
    emit_kind: str = ""                            # open mode: "context" | "stopblock"
    question: str = ""                             # open mode: prompt read to the caller
    call_method: str = "bridging"                  # "bridging" (auto-enter ext) | "tzintuk" (ring; callback enters ext)
    method: str = "OTHER"                          # OTHER | TPL | TZL  (RunTzintuk/bridging target type)
    phones: list[str] = []                         # OTHER: direct numbers
    template_id: str | int | None = None           # TPL: template id
    lists: list[str] = []                          # TZL: tzintuk list names
    ivr_path: str
    caller_id: str | None = None
    calls_time_out: int | None = 30
    wait_timeout: int = 90
    input_type: str = "HebrewKeyboard"


class AskHookBody(BaseModel):
    config: HookConfig
    hook_input: str | dict[str, Any] | None = None


class RespondModel(ApiModel):
    sel: str | None = None                        # menu digit collected by Yemot
    txt: str | None = None                        # free text collected by Yemot


# ---------------------------------------------------------------- endpoints
@app.get("/health")
async def health() -> dict[str, Any]:
    now = time.monotonic()
    return {"ok": True, "token_set": bool(YEMOT_TOKEN), "pending": list(_pending.keys()),
            "chat": {ext: {"polled_ago": round(now - line.polled), "calls": sum(c.ext == ext for c in _chat_calls.values())}
                     for ext, line in _chat_lines.items()}}


@app.post("/ask-hook")
async def ask_hook(body: AskHookBody) -> dict[str, Any]:
    """Register the pending menu, optionally place a call, block until answered/timeout."""
    cfg = body.config
    spoken, options = _build(cfg, body.hook_input)
    if not cfg.ivr_path or not options:
        return {"answered": False, "error": "missing ivr_path or options"}

    outbound = cfg.call_method != "none"          # "none" = user dials in and navigates
    if outbound and not YEMOT_TOKEN:
        return {"answered": False, "error": "YEMOT_TOKEN not set"}

    # build the RunTzintuk/bridging target from the chosen method (only if calling out)
    method = {"TPL": RunTzintukMethod.TPL, "TZL": RunTzintukMethod.TZL}.get(cfg.method, RunTzintukMethod.OTHER)
    target: Any = None
    corr_phone = ""
    if outbound:
        if method == RunTzintukMethod.TPL:
            target = int(cfg.template_id) if cfg.template_id else None
        elif method == RunTzintukMethod.TZL:
            target = cfg.lists
        else:
            target = [_norm_phone(x) for x in cfg.phones]
            corr_phone = target[0] if target else ""
        if not target:
            return {"answered": False, "error": "missing call target (phones/template/lists)"}

    key = _norm_ext(cfg.ivr_path)
    p = Pending(question=_sanitize_tts(spoken), options=options, phone=corr_phone)
    _pending[key] = p
    try:
        if outbound:
            async with AsyncYemot(YEMOT_TOKEN) as yemot:
                if cfg.call_method == "tzintuk":
                    # ring only; recipients call back and enter the list's extension
                    await yemot.run_tzintuk(
                        method=method, phones=target,
                        caller_id=cfg.caller_id, tzintuk_time_out=min(cfg.calls_time_out or 9, 16))
                else:
                    # CallExtensionBridging: default 30s, capped at 35s
                    await yemot.call_extension_bridging(
                        method, phones=target, ivr_path=cfg.ivr_path,
                        caller_id=cfg.caller_id, calls_time_out=min(cfg.calls_time_out or 30, 35))
        await asyncio.wait_for(p.event.wait(), timeout=cfg.wait_timeout)
    except asyncio.TimeoutError:
        return {"answered": False, "error": "timeout"}
    except Exception as exc:  # noqa: BLE001 - report, never crash the hook
        return {"answered": False, "error": str(exc)}
    else:
        return {"answered": True, "answer": p.answer, "emit": p.emit}
    finally:
        _pending.pop(key, None)


def _finalize(p: Pending, opt: dict[str, Any], free_text: str | None) -> PlainTextResponse:
    emit = opt.get("emit")
    p.emit = _inject(emit, free_text) if (opt.get("open") and free_text is not None) else emit
    p.answer = free_text if opt.get("open") else p.selected
    p.stage = "done"
    p.event.set()
    return PlainTextResponse(hangup())


@app.get("/respond")
async def respond(api_model: Annotated[RespondModel, Depends()]) -> PlainTextResponse:
    p = _find(api_model.api_extension, api_model.api_phone)
    if p is None or p.stage == "done":
        return PlainTextResponse(hangup())

    open_only = p.pure_open()                      # pure open question: skip the menu
    if open_only is not None:
        if api_model.txt is None:
            p.stage = "text"
            return PlainTextResponse(_text_read(open_only))
        return _finalize(p, open_only, api_model.txt)

    if p.stage == "menu":
        if api_model.sel is None:
            return PlainTextResponse(_menu_read(p))
        opt = p.options.get(api_model.sel)
        if opt is None:
            return PlainTextResponse(_menu_read(p))    # invalid pick, re-ask
        p.selected = api_model.sel
        if opt.get("open"):
            p.stage = "text"
            return PlainTextResponse(_text_read(opt))
        return _finalize(p, opt, None)

    opt = p.options.get(p.selected or "")          # p.stage == "text"
    if opt is None:
        return PlainTextResponse(hangup())
    if api_model.txt is None:
        return PlainTextResponse(_text_read(opt))
    return _finalize(p, opt, api_model.txt)


# ---------------------------------------------------------------- chat with Claude over the phone
# A conversation with Claude on its own Yemot `api` extension (api_link = .../chat/respond). This server only runs
# the call: it plays what the computer sends — a "screen": text to say, then what to collect (digits, typed text,
# a recording, or nothing) — and passes back what the caller entered. The computer (claude-notify-hub's bot
# service) long-polls /chat/poll for those events and answers with /chat/screen; it holds the conversation, the
# transcription and Claude. While no screen is ready the caller hears hold music (api_wait_answer_music_on_hold)
# and the call comes back here every _CHAT_HOLD seconds (go_to_folder to its own extension).
_CHAT_HOLD = 12          # seconds one Yemot request waits for a screen before the call loops back
_CHAT_IDLE = 45          # the computer polled within this many seconds = it is connected
_CHAT_GONE = 600         # a call not heard from for this long is forgotten
_TTS_CHUNK = 220         # Yemot reads long text better in several segments


@dataclass
class ChatCall:
    id: str
    phone: str
    ext: str
    screens: list[dict[str, Any]] = field(default_factory=list)
    param: str | None = None                     # the parameter of the read in flight
    n: int = 0
    wake: asyncio.Event = field(default_factory=asyncio.Event)
    seen: float = field(default_factory=time.monotonic)


@dataclass
class ChatLine:                                  # one chat extension, one computer polling it
    events: list[dict[str, Any]] = field(default_factory=list)
    wake: asyncio.Event = field(default_factory=asyncio.Event)
    polled: float = 0.0


_chat_calls: dict[str, ChatCall] = {}
_chat_lines: dict[str, ChatLine] = {}


def _chat_line(ext: str) -> ChatLine:
    return _chat_lines.setdefault(_norm_ext(ext), ChatLine())


def _chat_push(ext: str, event: dict[str, Any]) -> None:
    line = _chat_line(ext)
    line.events.append(event)
    line.wake.set()


def _tts(text: str) -> str:
    """Text → Yemot TTS segments ("a.t-b", to follow a "t-"), cut at sentence ends."""
    words, segs, cur = (text or "").split(), [], ""
    for w in words:
        if cur and len(cur) + 1 + len(w) > _TTS_CHUNK:
            segs.append(cur)
            cur = w
        else:
            cur = f"{cur} {w}".strip()
    if cur:
        segs.append(cur)
    return ".t-".join(_sanitize_tts(s) for s in segs)


def _chat_render(call: ChatCall) -> str:
    s = call.screens.pop(0)
    say = s.get("say", "")
    while s.get("input", "none") == "none" and call.screens:   # several things to say: one after the other
        s = call.screens.pop(0)
        say = f"{say} {s.get('say', '')}".strip()
    inp, msg, here = s.get("input", "none"), _tts(say), go_to_folder("/" + call.ext)
    if inp in ("none", "hangup"):
        then = hangup() if inp == "hangup" else here
        return api_response_join(f"id_list_message=t-{msg}", then) if msg else then
    call.n += 1
    call.param = f"c{call.n}"
    msg = msg or _sanitize_tts("הקש")
    if inp == "record":
        # only the folder: with a file name / confirm / save-on-hangup Yemot drops the request that follows
        return read_record(IdListMessageType.Text, msg, call.param, file_dir=f"/{call.ext}/rec")
    if inp == "text":
        return read_text(IdListMessageType.Text, msg, call.param, max_digits=int(s.get("max") or 400), min_digits=1,
                         play_confirm_type=PlayConfirmType.HebrewKeyboard)
    values = str(s.get("values") or "")
    return read_text(IdListMessageType.Text, msg, call.param, max_digits=int(s.get("max") or 1),
                     min_digits=int(s.get("min") or 1), timeout=int(s.get("timeout") or 15),
                     play_confirm_type=PlayConfirmType.NO, allowed_values=list(values) if values else None, conform=False,
                     timout_empty_times=1, allow_empty=True)


def _chat_prune() -> None:
    now = time.monotonic()
    for cid in [k for k, c in _chat_calls.items() if now - c.seen > _CHAT_GONE]:
        _chat_calls.pop(cid, None)


class ChatPollBody(BaseModel):
    ext: str
    wait: int = 20


class ChatScreenBody(BaseModel):
    call: str
    say: str = ""
    input: str = "none"                          # digits | text | record | none | hangup
    max: int = 1
    min: int = 1
    values: str = ""                             # allowed digits ("" = any)
    timeout: int = 15


@app.post("/chat/poll")
async def chat_poll(body: ChatPollBody) -> dict[str, Any]:
    """The computer waits here (≤ 25 s) for what callers did: start · input (value) · hangup."""
    line = _chat_line(body.ext)
    line.polled = time.monotonic()
    if not line.events:
        line.wake.clear()
        try:
            await asyncio.wait_for(line.wake.wait(), timeout=min(max(body.wait, 0), 25))
        except asyncio.TimeoutError:
            pass
    line.polled = time.monotonic()
    events, line.events = line.events, []
    _chat_prune()
    return {"events": events}


@app.post("/chat/screen")
async def chat_screen(body: ChatScreenBody) -> dict[str, Any]:
    call = _chat_calls.get(body.call)
    if call is None:
        return {"ok": False, "error": "the call ended"}
    call.screens.append(body.model_dump())
    call.wake.set()
    return {"ok": True}


@app.get("/chat/respond")
async def chat_respond(request: Request, m: Annotated[ApiModel, Depends()]) -> PlainTextResponse:
    ext, cid = _norm_ext(m.api_extension), m.api_call_id or ""
    call = _chat_calls.get(cid)
    if m.hangup == "yes":
        if call is not None:
            _chat_calls.pop(cid, None)
            _chat_push(call.ext, {"call": cid, "phone": call.phone, "type": "hangup"})
        return PlainTextResponse("")
    if call is None:
        line = _chat_lines.get(ext)
        if line is None or time.monotonic() - line.polled > _CHAT_IDLE:
            return PlainTextResponse(api_response_join(
                f"id_list_message=t-{_tts('המחשב לא מחובר כרגע. נסה שוב מאוחר יותר')}", hangup()))
        call = _chat_calls[cid] = ChatCall(cid, _norm_phone(m.api_phone), ext)
        _chat_push(ext, {"call": cid, "phone": call.phone, "type": "start"})
    call.seen = time.monotonic()
    if call.param is not None:                   # the answer to the read in flight ("" = nothing entered)
        value = request.query_params.get(call.param)
        call.param = None
        _chat_push(ext, {"call": cid, "phone": call.phone, "type": "input", "value": value or ""})
    if not call.screens:
        call.wake.clear()
        try:
            await asyncio.wait_for(call.wake.wait(), timeout=_CHAT_HOLD)
        except asyncio.TimeoutError:
            pass
    if not call.screens:
        return PlainTextResponse(go_to_folder("/" + ext))
    return PlainTextResponse(_chat_render(call))
