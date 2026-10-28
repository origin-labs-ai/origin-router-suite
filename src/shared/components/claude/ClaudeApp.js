"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { comboDisplayLabel } from "@/shared/utils/modelDisplayName";
import { ORIGIN_CHAT_ENDPOINT, isClaudeCombo, thinkingPayload } from "@/lib/claudeOriginConfig";

// Native Claude by Origin surface. Every chat lives in ~/.claude/origin through
// /api/origin/*, and every completion goes to the local OriginRouter.
const EFFORT = [
  { value: "low", label: "Low" },
  { value: "medium", label: "Med" },
  { value: "high", label: "High" },
  { value: "xhigh", label: "Extra High" },
  { value: "max", label: "Max" },
];

const FONTS = [
  { value: "sans", label: "Sans" },
  { value: "serif", label: "Serif" },
  { value: "mono", label: "Mono" },
];

function readChunk(chunk) {
  const choice = chunk?.choices?.[0];
  const delta = choice?.delta?.content ?? choice?.message?.content ?? chunk?.output_text ?? chunk?.text;
  if (typeof delta === "string") return delta;
  if (Array.isArray(delta)) return delta.map((part) => part?.text || "").join("");
  return "";
}

export default function ClaudeApp() {
  const [sessions, setSessions] = useState([]);
  const [activeId, setActiveId] = useState("");
  const [messages, setMessages] = useState([]);
  const [models, setModels] = useState([]);
  const [model, setModel] = useState("");
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [effort, setEffort] = useState("high");
  const [thinking, setThinking] = useState(false);
  const [font, setFont] = useState("sans");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);

  const composerRef = useRef(null);
  const abortRef = useRef(null);
  const bottomRef = useRef(null);

  const activeSession = useMemo(
    () => sessions.find((session) => session.id === activeId) || null,
    [sessions, activeId],
  );

  /* ---------- bootstrap ---------- */
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const [sessionsRes, settingsRes, combosRes] = await Promise.all([
          fetch("/api/origin/sessions", { cache: "no-store" }),
          fetch("/api/origin/settings", { cache: "no-store" }),
          fetch("/api/combos", { cache: "no-store" }),
        ]);

        const sessionsData = sessionsRes.ok ? await sessionsRes.json() : { sessions: [] };
        const settingsData = settingsRes.ok ? await settingsRes.json() : { settings: {} };
        const combosData = combosRes.ok ? await combosRes.json() : { combos: [] };

        const claudeModels = (combosData.combos || [])
          .filter((combo) => isClaudeCombo(combo.name))
          .map((combo) => ({ id: combo.name, label: comboDisplayLabel(combo) }));

        if (!alive) return;
        setSessions(sessionsData.sessions || []);
        setModels(claudeModels);
        setModel(settingsData.settings?.model || claudeModels[0]?.id || "");
        setEffort(settingsData.settings?.effort || "high");
        setThinking(settingsData.settings?.thinking === true);
        setFont(settingsData.settings?.font || "sans");
        if (sessionsData.sessions?.[0]?.id) setActiveId(sessionsData.sessions[0].id);
      } catch (loadError) {
        if (alive) setError(loadError?.message || "Failed to load");
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => { alive = false; };
  }, []);

  /* ---------- load messages for the active session ---------- */
  useEffect(() => {
    if (!activeId) {
      setMessages([]);
      return;
    }
    let alive = true;
    (async () => {
      const response = await fetch(`/api/origin/sessions/${activeId}`, { cache: "no-store" });
      if (!response.ok) return;
      const data = await response.json();
      if (alive) setMessages(data.messages || []);
    })();
    return () => { alive = false; };
  }, [activeId]);

  /* ---------- composer auto-grow ---------- */
  useEffect(() => {
    const element = composerRef.current;
    if (!element) return;
    element.style.height = "auto";
    element.style.height = `${Math.min(element.scrollHeight, 220)}px`;
  }, [draft]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: "end" });
  }, [messages.length]);

  const persistSettings = useCallback((patch) => {
    fetch("/api/origin/settings", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    }).catch(() => {});
  }, []);

  const createSession = async () => {
    const response = await fetch("/api/origin/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "New chat", model }),
    });
    if (!response.ok) return null;
    const session = await response.json();
    setSessions((prev) => [session, ...prev]);
    setActiveId(session.id);
    setMessages([]);
    return session;
  };

  const renameSession = async (session) => {
    const title = window.prompt("Rename chat", session.title);
    if (!title || !title.trim()) return;
    const response = await fetch(`/api/origin/sessions/${session.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: title.trim() }),
    });
    if (!response.ok) return;
    const updated = await response.json();
    setSessions((prev) => prev.map((item) => (item.id === updated.id ? updated : item)));
  };

  const removeSession = async (session) => {
    if (!window.confirm(`Delete "${session.title}"?`)) return;
    const response = await fetch(`/api/origin/sessions/${session.id}`, { method: "DELETE" });
    if (!response.ok) return;
    setSessions((prev) => prev.filter((item) => item.id !== session.id));
    if (activeId === session.id) {
      setActiveId("");
      setMessages([]);
    }
  };

  const send = async () => {
    const text = draft.trim();
    if (!text || busy || !model) return;

    let sessionId = activeId;
    if (!sessionId) {
      const session = await createSession();
      if (!session) return;
      sessionId = session.id;
    }

    const userMessage = { id: `local-${Date.now()}`, role: "user", content: text };
    setMessages((prev) => [...prev, userMessage]);
    setDraft("");
    setBusy(true);
    setError("");

    const savedUser = await fetch(`/api/origin/sessions/${sessionId}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ role: "user", content: text }),
    }).then((response) => (response.ok ? response.json() : null)).catch(() => null);

    if (savedUser) {
      setMessages((prev) => prev.map((message) => (message.id === userMessage.id ? savedUser : message)));
    }

    const history = [...messages, { role: "user", content: text }]
      .filter((message) => message.role === "user" || message.role === "assistant")
      .map((message) => ({ role: message.role, content: message.content }));

    const assistantId = `local-a-${Date.now()}`;
    setMessages((prev) => [...prev, { id: assistantId, role: "assistant", content: "" }]);

    abortRef.current?.abort();
    abortRef.current = new AbortController();

    try {
      const response = await fetch(ORIGIN_CHAT_ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
        body: JSON.stringify({
          model,
          messages: history,
          stream: true,
          ...thinkingPayload({ thinking, effort }),
        }),
        signal: abortRef.current.signal,
      });

      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(data?.error?.message || data?.error || `Request failed (${response.status})`);
      }

      const reader = response.body?.getReader();
      let assistantText = "";

      if (reader) {
        const decoder = new TextDecoder();
        let buffer = "";
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split(/\r?\n/);
          buffer = lines.pop() || "";
          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed.startsWith("data:")) continue;
            const payload = trimmed.slice(5).trim();
            if (!payload || payload === "[DONE]") continue;
            try {
              const piece = readChunk(JSON.parse(payload));
              if (!piece) continue;
              assistantText += piece;
              setMessages((prev) => prev.map((message) => (
                message.id === assistantId ? { ...message, content: assistantText } : message
              )));
            } catch {
              // ignore malformed chunks
            }
          }
        }
      }

      const savedAssistant = await fetch(`/api/origin/sessions/${sessionId}/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ role: "assistant", content: assistantText || "(empty response)" }),
      }).then((result) => (result.ok ? result.json() : null)).catch(() => null);

      if (savedAssistant) {
        setMessages((prev) => prev.map((message) => (message.id === assistantId ? savedAssistant : message)));
      }

      // First turn becomes the chat title.
      if (messages.length === 0) {
        const title = text.slice(0, 60);
        const renamed = await fetch(`/api/origin/sessions/${sessionId}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ title }),
        }).then((result) => (result.ok ? result.json() : null)).catch(() => null);
        if (renamed) {
          setSessions((prev) => prev.map((item) => (item.id === renamed.id ? renamed : item)));
        }
      }
    } catch (sendError) {
      if (sendError.name !== "AbortError") {
        setError(sendError.message || "Request failed");
        setMessages((prev) => prev.filter((message) => message.id !== assistantId));
      }
    } finally {
      setBusy(false);
      abortRef.current = null;
    }
  };

  const stop = () => abortRef.current?.abort();

  const fontFamily = font === "serif"
    ? "var(--font-serif)"
    : font === "mono"
      ? "var(--font-mono)"
      : "var(--font-sans)";

  return (
    <div className="flex h-[100dvh] w-full overflow-hidden bg-[#212121] text-white" style={{ fontFamily }}>
      {/* Sidebar */}
      <aside className="hidden w-64 shrink-0 flex-col gap-2 border-r border-white/10 bg-[#171717] p-3 md:flex">
        <div className="flex items-center gap-2 px-1 pb-1">
          <img src="/brand/origin-mark-256.png" alt="" className="size-7 rounded-md ring-1 ring-white/10" />
          <span className="text-sm font-semibold">
            Claude <span className="font-normal text-white/40">by Origin</span>
          </span>
        </div>

        <button
          type="button"
          onClick={createSession}
          className="flex items-center justify-center gap-1.5 rounded-xl border border-white/10 bg-white/5 py-2 text-xs font-medium text-white/80 transition hover:bg-white/10"
        >
          <span className="material-symbols-outlined text-[16px]">add</span>
          New chat
        </button>

        <div className="min-h-0 flex-1 space-y-1 overflow-y-auto custom-scrollbar">
          {sessions.map((session) => (
            <div
              key={session.id}
              className={`group flex items-center gap-1 rounded-lg px-2 py-1.5 transition ${
                session.id === activeId ? "bg-white/10" : "hover:bg-white/5"
              }`}
            >
              <button
                type="button"
                onClick={() => setActiveId(session.id)}
                className="min-w-0 flex-1 truncate text-left text-xs text-white/75"
                title={session.title}
              >
                {session.title}
              </button>
              <button type="button" onClick={() => renameSession(session)} className="text-white/30 opacity-0 transition group-hover:opacity-100" title="Rename">
                <span className="material-symbols-outlined text-[14px]">edit</span>
              </button>
              <button type="button" onClick={() => removeSession(session)} className="text-white/30 opacity-0 transition group-hover:opacity-100" title="Delete">
                <span className="material-symbols-outlined text-[14px]">delete</span>
              </button>
            </div>
          ))}
          {!loading && sessions.length === 0 ? (
            <p className="px-2 py-4 text-center text-[11px] text-white/30">No chats yet</p>
          ) : null}
        </div>

        <button
          type="button"
          onClick={() => setSettingsOpen((value) => !value)}
          className="flex items-center justify-center gap-1.5 rounded-xl border border-white/10 py-2 text-[11px] text-white/55 transition hover:bg-white/5 hover:text-white"
        >
          <span className="material-symbols-outlined text-[14px]">tune</span>
          Settings
        </button>
        <a
          href="/playground"
          className="flex items-center justify-center gap-1.5 rounded-xl border border-white/10 py-2 text-[11px] text-white/40 transition hover:bg-white/5 hover:text-white"
        >
          <span className="material-symbols-outlined text-[14px]">open_in_new</span>
          Browser playground
        </a>
      </aside>

      {/* Main column */}
      <div className="relative flex min-w-0 flex-1 flex-col">
        <header className="flex shrink-0 items-center justify-between gap-3 border-b border-white/5 px-4 py-3">
          <div className="flex items-center gap-2">
            <select
              value={model}
              onChange={(event) => {
                setModel(event.target.value);
                persistSettings({ model: event.target.value });
              }}
              className="rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-xs text-white outline-none"
            >
              {models.length === 0 ? <option value="">No claude-* combos</option> : null}
              {models.map((item) => (
                <option key={item.id} value={item.id} className="text-black">{item.label}</option>
              ))}
            </select>
            <span className="rounded-full border border-white/10 px-2 py-1 text-[10px] text-white/45">OriginRouter</span>
          </div>
          <span className="text-[11px] text-white/35">{activeSession?.title || "New chat"}</span>
        </header>

        {settingsOpen ? (
          <div className="absolute right-4 top-16 z-20 w-72 space-y-3 rounded-2xl border border-white/10 bg-[#1f1f1f] p-3 shadow-2xl">
            <div>
              <p className="mb-1 text-[10px] uppercase tracking-wider text-white/40">Effort</p>
              <div className="flex flex-wrap gap-1">
                {EFFORT.map((level) => (
                  <button
                    key={level.value}
                    type="button"
                    onClick={() => { setEffort(level.value); persistSettings({ effort: level.value }); }}
                    className={`rounded-full px-2 py-1 text-[10px] font-semibold transition ${
                      effort === level.value ? "bg-white/90 text-black" : "bg-white/5 text-white/50 hover:bg-white/10"
                    }`}
                  >
                    {level.label}
                  </button>
                ))}
              </div>
            </div>
            <div>
              <p className="mb-1 text-[10px] uppercase tracking-wider text-white/40">Thinking</p>
              <button
                type="button"
                onClick={() => { const next = !thinking; setThinking(next); persistSettings({ thinking: next }); }}
                className={`rounded-full px-2 py-1 text-[10px] font-semibold ${thinking ? "bg-blue-500/25 text-blue-200" : "bg-white/5 text-white/50"}`}
              >
                {thinking ? "On" : "Off"}
              </button>
            </div>
            <div>
              <p className="mb-1 text-[10px] uppercase tracking-wider text-white/40">Font</p>
              <div className="flex gap-1">
                {FONTS.map((item) => (
                  <button
                    key={item.value}
                    type="button"
                    onClick={() => { setFont(item.value); persistSettings({ font: item.value }); }}
                    className={`rounded-full px-2 py-1 text-[10px] font-semibold transition ${
                      font === item.value ? "bg-white/90 text-black" : "bg-white/5 text-white/50 hover:bg-white/10"
                    }`}
                  >
                    {item.label}
                  </button>
                ))}
              </div>
            </div>
          </div>
        ) : null}

        <div className="flex-1 overflow-y-auto px-4 py-6 custom-scrollbar">
          <div className="mx-auto flex w-full max-w-3xl flex-col gap-5">
            {messages.length === 0 ? (
              <div className="flex min-h-[45vh] flex-col items-center justify-center text-center">
                <img src="/brand/origin-mark-256.png" alt="" className="mb-4 size-12 rounded-xl ring-1 ring-white/10" />
                <h1 className="text-xl font-semibold">Claude by Origin</h1>
                <p className="mt-1 max-w-sm text-xs leading-5 text-white/40">
                  Local chats in <code>~/.claude/origin</code>. Every answer is routed through OriginRouter.
                </p>
              </div>
            ) : null}

            {messages.map((message) => (
              <div key={message.id} className={`flex ${message.role === "user" ? "justify-end" : "justify-start"}`}>
                <div className={`max-w-[min(88%,42rem)] whitespace-pre-wrap break-words rounded-3xl px-4 py-3 text-[14px] leading-7 ${
                  message.role === "user" ? "bg-[#173E76] text-white" : "text-white/90"
                }`}>
                  {message.content || (message.role === "assistant" && busy ? "▋" : "")}
                </div>
              </div>
            ))}
            <div ref={bottomRef} />
          </div>
        </div>

        {error ? (
          <div className="mx-4 mb-2 rounded-xl border border-rose-500/25 bg-rose-500/10 px-3 py-2 text-[11px] text-rose-200">
            {error}
          </div>
        ) : null}

        <div className="shrink-0 px-4 pb-4">
          <div className="mx-auto w-full max-w-3xl rounded-[22px] border border-white/10 bg-[#2a2a2a] px-3 py-2 transition-colors focus-within:border-white/25">
            <textarea
              ref={composerRef}
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault();
                  send();
                }
              }}
              rows={1}
              placeholder="Message Claude by Origin"
              style={{ transition: "height 140ms ease" }}
              className="w-full resize-none bg-transparent px-2 py-1 text-[15px] leading-6 text-white outline-none placeholder:text-white/35 custom-scrollbar"
            />
            <div className="mt-2 flex items-center justify-between">
              <div className="flex items-center gap-1.5">
                <div className="flex items-center rounded-full border border-white/10 bg-white/[0.04] p-0.5">
                  {EFFORT.map((level) => (
                    <button
                      key={level.value}
                      type="button"
                      onClick={() => { setEffort(level.value); persistSettings({ effort: level.value }); }}
                      className={`rounded-full px-2 py-1 text-[10px] font-semibold transition ${
                        effort === level.value ? "bg-white/90 text-black" : "text-white/50 hover:bg-white/10 hover:text-white"
                      }`}
                    >
                      {level.label}
                    </button>
                  ))}
                </div>
                <button
                  type="button"
                  onClick={() => { const next = !thinking; setThinking(next); persistSettings({ thinking: next }); }}
                  className={`rounded-full border p-1.5 transition ${
                    thinking ? "border-blue-400/50 bg-blue-500/20 text-blue-200" : "border-white/10 bg-white/[0.04] text-white/50"
                  }`}
                  title="Thinking"
                >
                  <span className="material-symbols-outlined text-[15px]">psychology</span>
                </button>
              </div>
              {busy ? (
                <button type="button" onClick={stop} className="rounded-full bg-white/90 px-3 py-1.5 text-[11px] font-semibold text-black">
                  Stop
                </button>
              ) : (
                <button
                  type="button"
                  onClick={send}
                  disabled={!draft.trim() || !model}
                  className="rounded-full bg-white/90 px-3 py-1.5 text-[11px] font-semibold text-black transition disabled:opacity-30"
                >
                  Send
                </button>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
