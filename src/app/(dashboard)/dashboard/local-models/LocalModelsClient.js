"use client";

import { useState, useEffect, useRef } from "react";
import { Card, Button, Badge, Input, Modal } from "@/shared/components";

// Local Models dashboard.
//
// Five sections, top to bottom:
//   (a) three engine status cards (Ollama / LM Studio / llama.cpp) with live
//       dots + model counts — data comes from the same 127.0.0.1 probes the
//       backend runs on every poll;
//   (b) a search bar that queries Hugging Face + the Ollama library in one
//       call; result rows are source-tagged and carry a Download/Pull button
//       with an inline progress bar;
//   (c) an "+ Add model file" button opening a small form that registers an
//       existing .gguf/.safetensors/.bin/.ollama file IN PLACE (path only —
//       the file is never copied or moved);
//   (d) the registered models table with remove, plus a Serve/Stop button per
//       .gguf row that launches a managed llama.cpp server for that file
//       (loopback only) with a small "Chat test" exchange against it;
//   (e) the downloads list with progress + cancel.
//
// Polling: one snapshot GET every 5s keeps dots/progress honest without
// hammering the engines; a faster 1.5s tick takes over while anything is
// downloading so progress bars move. Every fetch fails soft — a dead backend
// renders empty states, never an error wall.

// Human-readable byte formatting shared by the model rows and progress bars.
function formatBytes(bytes) {
  const n = Number(bytes);
  if (!Number.isFinite(n) || n <= 0) return "—";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = n;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value >= 10 || unit === 0 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}

// Status dot → { color class, label }. Unknown means "no data yet", not "down".
// Installed-but-not-running reads amber — a real state between online and off.
function dotFor(engine, isInstalled) {
  if (!engine) return { dot: "bg-gray-400", label: "Unknown" };
  if (engine.ok) return { dot: "bg-green-500", label: "Online" };
  if (isInstalled) return { dot: "bg-amber-500", label: "Not running" };
  return { dot: "bg-gray-400", label: "Offline" };
}

export default function LocalModelsClient() {
  // --- page state -----------------------------------------------------------
  const [engines, setEngines] = useState({ ollama: null, lmstudio: null, llamacpp: null });
  const [installed, setInstalled] = useState({ ollama: false, lmstudio: false, llamacpp: false });
  const [registered, setRegistered] = useState([]);
  const [downloads, setDownloads] = useState([]);
  // Managed llama.cpp servers (one per served GGUF): id, status, port, modelPath.
  const [llamaServers, setLlamaServers] = useState([]);

  // Search state: `results` rows are source-tagged HF/Ollama entries.
  const [query, setQuery] = useState("");
  const [searching, setSearching] = useState(false);
  const [searchNotes, setSearchNotes] = useState([]);
  const [results, setResults] = useState([]);
  // Dynamic loading: results render in batches and the sentinel below grows
  // the batch as the reader reaches the end of the visible list.
  const [visibleResults, setVisibleResults] = useState(20);
  const loadMoreRef = useRef(null);

  // "+ Add model file" form (kept inside a Modal).
  const [showAddModal, setShowAddModal] = useState(false);
  const [addPath, setAddPath] = useState("");
  const [addName, setAddName] = useState("");
  const [addError, setAddError] = useState("");
  const [adding, setAdding] = useState(false);

  // Per-row busy flags keyed by model id (download buttons) so one slow start
  // does not spin every button on the page.
  const [startingDownload, setStartingDownload] = useState({});
  const [removing, setRemoving] = useState({});

  // Serve/Stop row state: busy flags + last error per model id, and a stopping
  // flag per server id. The authoritative server states come from the poll.
  const [serving, setServing] = useState({});
  const [serveErrors, setServeErrors] = useState({});
  const [stoppingServer, setStoppingServer] = useState({});

  // "Chat test" quick action for a running server: one small input, one
  // request/response exchange at a time, transcript kept per server id.
  const [chatOpenId, setChatOpenId] = useState(null);
  const [chatDraft, setChatDraft] = useState("");
  const [chatBusy, setChatBusy] = useState(false);
  const [chatLog, setChatLog] = useState({}); // serverId → [{ role, text }]

  // Interval identity for the poll loop; recreated when speed changes.
  const pollRef = useRef(null);
  const pollMsRef = useRef(5000);

  // Anything queued/running? While true, poll faster so progress bars move —
  // including llama-server spins-up/shut-downs, so the Serve badge flips
  // quickly from "starting" to "running".
  const hasActiveDownloads = downloads.some(
    (d) => d.status === "queued" || d.status === "running"
  ) || llamaServers.some((s) => s.status === "starting" || s.status === "stopping");

  // --- data loading ---------------------------------------------------------

  // One snapshot GET feeds every section. Failures leave state untouched (the
  // previous snapshot keeps rendering) — a flaky probe must not blank the page.
  const refresh = async () => {
    try {
      const res = await fetch("/api/local-models", { cache: "no-store" });
      if (!res.ok) return;
      const data = await res.json();
      if (data.engines) setEngines(data.engines);
      if (data.installed) setInstalled(data.installed);
      if (Array.isArray(data.registered)) setRegistered(data.registered);
      if (Array.isArray(data.downloads)) setDownloads(data.downloads);
      if (Array.isArray(data.llamaServers)) setLlamaServers(data.llamaServers);
    } catch {
      // Backend briefly unreachable — keep the last good snapshot on screen.
    }
  };

  // Poll loop: re-arms at the current speed whenever the speed changes
  // (idle 5s vs active-downloads 1.5s). Cleanup on unmount is unconditional.
  useEffect(() => {
    const wantedMs = hasActiveDownloads ? 1500 : 5000;
    if (pollMsRef.current === wantedMs && pollRef.current) return;
    pollMsRef.current = wantedMs;
    if (pollRef.current) clearInterval(pollRef.current);
    pollRef.current = setInterval(refresh, wantedMs);
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
      pollRef.current = null;
    };
  }, [hasActiveDownloads]);

  // Initial snapshot (repo pattern, cf. dashboard/fusion/page.js).
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- initial load is an async fetch, not a sync setState
    refresh();
  }, []);

  // --- actions (all POST { action, ... } to the same endpoint) ---------------

  // Search both catalogs. Results merge server-side; notes explain any
  // fail-open fallback (e.g. "showing curated list").
  const runSearch = async (e) => {
    e?.preventDefault?.();
    const q = query.trim();
    if (!q) return;
    setSearching(true);
    try {
      const res = await fetch("/api/local-models", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "search", query: q }),
      });
      const data = await res.json();
      setResults(Array.isArray(data.results) ? data.results : []);
      setVisibleResults(20);
      setSearchNotes(Array.isArray(data.notes) ? data.notes : []);
    } catch {
      setSearchNotes(["Search request failed — try again."]);
      setResults([]);
    } finally {
      setSearching(false);
    }
  };

  // The sentinel grows the visible batch as it scrolls into view. Re-armed on
  // every results change so a fresh search starts from the first batch.
  useEffect(() => {
    const node = loadMoreRef.current;
    if (!node) return undefined;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setVisibleResults((count) => count + 20);
        }
      },
      { rootMargin: "240px" },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [results, visibleResults]);

  // Start a pull (ollama) or download (huggingface) for a search row. The
  // button keeps its own spinner via `startingDownload[rowId]`.
  const startForRow = async (row) => {
    const key = `${row.source}:${row.id}`;
    setStartingDownload((prev) => ({ ...prev, [key]: true }));
    try {
      await fetch("/api/local-models", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "download", source: row.source, id: row.id }),
      });
      await refresh();
    } catch {
      // The download list poll will show the failed job when the start
      // actually happened; network-level failure surfaces on the next poll.
    } finally {
      setStartingDownload((prev) => ({ ...prev, [key]: false }));
    }
  };

  const cancelJob = async (id) => {
    try {
      await fetch("/api/local-models", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "cancel", id }),
      });
      await refresh();
    } catch {
      // Poll will reconcile the real state shortly.
    }
  };

  const removeModel = async (id) => {
    setRemoving((prev) => ({ ...prev, [id]: true }));
    try {
      await fetch("/api/local-models", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "remove", id }),
      });
      setRegistered((prev) => prev.filter((m) => m.id !== id));
    } catch {
      // Keep the row; the next poll re-syncs from the server anyway.
    } finally {
      setRemoving((prev) => ({ ...prev, [id]: false }));
    }
  };

  // Register an existing file from the modal form.
  const submitAdd = async (e) => {
    e?.preventDefault?.();
    setAddError("");
    if (!addPath.trim()) {
      setAddError("File path is required.");
      return;
    }
    setAdding(true);
    try {
      const res = await fetch("/api/local-models", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "register", path: addPath.trim(), name: addName.trim() || undefined }),
      });
      const data = await res.json();
      if (!res.ok) {
        setAddError(data?.error || "Could not register the file.");
        return;
      }
      if (data && data.id) setRegistered((prev) => [...prev, data]);
      setShowAddModal(false);
      setAddPath("");
      setAddName("");
    } catch {
      setAddError("Registration request failed — try again.");
    } finally {
      setAdding(false);
    }
  };

  // ── managed llama.cpp serving ───────────────────────────────────────────────

  // Newest server record still attached to a registered model's file. Paths
  // are compared case-insensitively — Windows drive-letter casing differs
  // between the registry row and the launcher's path.resolve.
  const serverForModel = (model) => {
    const want = String(model.path || "").toLowerCase();
    return llamaServers.find(
      (s) => String(s.modelPath || "").toLowerCase() === want
        && (s.status === "starting" || s.status === "running" || s.status === "stopping")
    ) || null;
  };

  // Serve button: launch llama.cpp for this GGUF. The route returns 202 as
  // soon as the process is spawned ("starting"); the poll flips the row to
  // "running" once /health answers.
  const serveModel = async (model) => {
    setServing((prev) => ({ ...prev, [model.id]: true }));
    setServeErrors((prev) => ({ ...prev, [model.id]: "" }));
    try {
      const res = await fetch("/api/local-models", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "serve", modelPath: model.path, name: model.name }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setServeErrors((prev) => ({ ...prev, [model.id]: data?.error || "Could not start llama-server." }));
      }
      await refresh();
    } catch {
      setServeErrors((prev) => ({ ...prev, [model.id]: "Serve request failed — try again." }));
    } finally {
      setServing((prev) => ({ ...prev, [model.id]: false }));
    }
  };

  const stopServer = async (serverId) => {
    setStoppingServer((prev) => ({ ...prev, [serverId]: true }));
    try {
      await fetch("/api/local-models", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "serve-stop", id: serverId }),
      });
      await refresh();
    } catch {
      // The poll reconciles the state on the next tick.
    } finally {
      setStoppingServer((prev) => ({ ...prev, [serverId]: false }));
    }
  };

  // Chat test: send one message through our gateway (action "serve-chat",
  // which proxies a single non-streaming completion to the loopback server)
  // and append both sides of the exchange to the per-server transcript.
  const sendChat = async (server) => {
    const text = chatDraft.trim();
    if (!text || chatBusy) return;
    setChatBusy(true);
    setChatLog((prev) => ({ ...prev, [server.id]: [...(prev[server.id] || []), { role: "user", text }] }));
    setChatDraft("");
    try {
      const res = await fetch("/api/local-models", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "serve-chat", id: server.id, message: text }),
      });
      const data = await res.json();
      setChatLog((prev) => ({
        ...prev,
        [server.id]: [
          ...(prev[server.id] || []),
          data?.ok ? { role: "assistant", text: data.reply }
            : { role: "error", text: data?.error || "Chat request failed." },
        ],
      }));
    } catch {
      setChatLog((prev) => ({
        ...prev,
        [server.id]: [...(prev[server.id] || []), { role: "error", text: "Chat request failed — try again." }],
      }));
    } finally {
      setChatBusy(false);
    }
  };

  // --- render ---------------------------------------------------------------

  const engineCards = [
    { key: "ollama", title: "Ollama", icon: "deployed_code", engine: engines.ollama, installed: installed.ollama, hint: "127.0.0.1:11434" },
    { key: "lmstudio", title: "LM Studio", icon: "smart_toy", engine: engines.lmstudio, installed: installed.lmstudio, hint: "127.0.0.1:1234" },
    { key: "llamacpp", title: "llama.cpp", icon: "memory", engine: engines.llamacpp, installed: installed.llamacpp, hint: "127.0.0.1:8080" },
  ];

  return (
    <div className="space-y-6 max-w-5xl">
      {/* Header */}
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold text-text-main flex items-center gap-3">
            <span className="material-symbols-outlined text-[26px]">hard_drive</span>
            Local Models
          </h1>
          <p className="text-sm text-text-muted mt-1">
            Pull models from Ollama &amp; Hugging Face, or register weight files already on this machine.
          </p>
        </div>
        <Button icon="add" onClick={() => { setAddError(""); setShowAddModal(true); }}>
          Add model file
        </Button>
      </div>

      {/* (a) Engine status cards */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        {engineCards.map(({ key, title, icon, engine, installed: isInstalled, hint }) => {
          const { dot, label } = dotFor(engine, isInstalled);
          const modelCount = engine?.ok ? engine.models.length : 0;
          return (
            <Card key={key} padding="md">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2.5">
                  <div className="p-2 rounded-[10px] bg-bg text-text-muted">
                    <span className="material-symbols-outlined text-[20px]">{icon}</span>
                  </div>
                  <div>
                    <h3 className="text-text-main font-semibold text-sm">{title}</h3>
                    <p className="text-[11px] text-text-muted font-mono">{hint}</p>
                  </div>
                </div>
                <span className={dot} title={engine?.error || label} />
              </div>
              <div className="mt-4 flex items-center justify-between">
                <Badge variant={engine?.ok ? "success" : "default"} dot>
                  {label}
                </Badge>
                <span className="text-xs text-text-muted">
                  {engine?.ok ? `${modelCount} model${modelCount === 1 ? "" : "s"}` : engine?.error || "Not detected"}
                </span>
              </div>
            </Card>
          );
        })}
      </div>

      {/* (b) Search + results */}
      <Card padding="md">
        <form onSubmit={runSearch} className="flex gap-2">
          <div className="flex-1">
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search Hugging Face &amp; Ollama library — e.g. qwen2.5-coder"
              icon="search"
              className="[&>div]:w-full"
            />
          </div>
          <Button type="submit" loading={searching} disabled={!query.trim()}>
            Search
          </Button>
        </form>

        {searchNotes.length > 0 && (
          <div className="mt-3 space-y-1">
            {searchNotes.map((note, i) => (
              <p key={i} className="text-xs text-yellow-600 dark:text-yellow-500">{note}</p>
            ))}
          </div>
        )}

        {results.length > 0 && (
          <div className="mt-4 divide-y divide-border-subtle">
            {results.slice(0, visibleResults).map((row) => {
              const key = `${row.source}:${row.id}`;
              const busy = !!startingDownload[key];
              return (
                <div key={key} className="flex items-center gap-3 py-2.5">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <Badge size="sm" variant={row.source === "ollama" ? "primary" : "info"}>
                        {row.source === "ollama" ? "Ollama" : "Hugging Face"}
                      </Badge>
                      <span className="text-sm font-medium text-text-main truncate">{row.id}</span>
                    </div>
                    <p className="text-xs text-text-muted truncate mt-0.5">
                      {row.description
                        || `${row.author || "unknown"} · ${row.downloads ?? 0} downloads · ${row.likes ?? 0} likes`}
                    </p>
                  </div>
                  <Button
                    size="sm"
                    variant="secondary"
                    icon={row.source === "ollama" ? "cloud_download" : "download"}
                    loading={busy}
                    onClick={() => startForRow(row)}
                  >
                    {row.source === "ollama" ? "Pull" : "Download"}
                  </Button>
                </div>
              );
            })}
          </div>
        )}

        {results.length > visibleResults && (
          <div ref={loadMoreRef} className="py-3 text-center text-xs text-text-muted">
            Loading more results…
          </div>
        )}

        {!results.length && !searching && (
          <p className="mt-4 text-xs text-text-muted">
            Results appear here. Ollama rows pull with the installed CLI; Hugging Face rows stream a GGUF file into your data folder.
          </p>
        )}
      </Card>

      {/* (e) Downloads — above the table so in-flight work stays visible */}
      {downloads.length > 0 && (
        <Card title="Downloads" subtitle="Pulled models and streamed GGUF files" icon="downloading" padding="md">
          <div className="divide-y divide-border-subtle">
            {downloads.map((job) => {
              const pct = job.bytesTotal
                ? Math.min(100, Math.round((job.bytesDone / job.bytesTotal) * 100))
                : job.status === "done" ? 100 : null;
              return (
                <div key={job.id} className="py-2.5">
                  <div className="flex items-center gap-3">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-medium text-text-main truncate">{job.model}</span>
                        <Badge size="sm" variant={
                          job.status === "done" ? "success"
                            : job.status === "failed" ? "error"
                              : job.status === "cancelled" ? "warning"
                                : "info"
                        }>
                          {job.status}
                        </Badge>
                      </div>
                      <p className="text-xs text-text-muted mt-0.5">
                        {job.error
                          || (job.bytesTotal ? `${formatBytes(job.bytesDone)} / ${formatBytes(job.bytesTotal)}` : formatBytes(job.bytesDone))}
                      </p>
                    </div>
                    {(job.status === "queued" || job.status === "running") && (
                      <Button size="xs" variant="ghost" icon="close" onClick={() => cancelJob(job.id)}>
                        Cancel
                      </Button>
                    )}
                  </div>
                  {pct !== null && (
                    <div className="mt-1.5 h-1.5 w-full rounded-full bg-surface-2 overflow-hidden">
                      <div
                        className={
                          job.status === "failed" || job.status === "cancelled"
                            ? "h-full bg-red-500/70"
                            : job.status === "done"
                              ? "h-full bg-green-500"
                              : "h-full bg-brand-500 transition-all"
                        }
                        style={{ width: `${pct}%` }}
                      />
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </Card>
      )}

      {/* (d) Registered models */}
      <Card
        title="Registered models"
        subtitle="Files registered in place — nothing is copied or moved"
        icon="inventory_2"
        padding="md"
      >
        {registered.length === 0 ? (
          <p className="text-sm text-text-muted">
            No local files registered yet. Use “Add model file” to point at an existing .gguf, .safetensors, .bin or .ollama file.
          </p>
        ) : (
          <div className="divide-y divide-border-subtle">
            {registered.map((model) => {
              const server = serverForModel(model);
              const isGguf = String(model.path || "").toLowerCase().endsWith(".gguf");
              const chatOpen = server && chatOpenId === server.id && server.status === "running";
              return (
                <div key={model.id} className="py-2.5">
                  <div className="flex items-center gap-3">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-medium text-text-main truncate">{model.name}</span>
                        <Badge size="sm">{String(model.path || "").split(".").pop()?.toUpperCase()}</Badge>
                        {server && (
                          <Badge
                            size="sm"
                            variant={server.status === "running" ? "success" : server.status === "failed" ? "error" : "info"}
                            dot
                          >
                            {server.status === "running" ? `serving :${server.port}` : server.status}
                          </Badge>
                        )}
                      </div>
                      <p className="text-xs text-text-muted font-mono truncate mt-0.5" title={model.path}>
                        {model.path} · {formatBytes(model.sizeBytes)}
                      </p>
                    </div>
                    {server ? (
                      <>
                        <Button
                          size="xs"
                          variant="secondary"
                          icon="forum"
                          disabled={server.status !== "running"}
                          onClick={() => setChatOpenId(chatOpen ? null : server.id)}
                        >
                          Chat test
                        </Button>
                        <Button
                          size="xs"
                          variant="ghost"
                          icon="stop"
                          loading={!!stoppingServer[server.id]}
                          onClick={() => stopServer(server.id)}
                        >
                          Stop
                        </Button>
                      </>
                    ) : (
                      <Button
                        size="xs"
                        variant="secondary"
                        icon="play_arrow"
                        loading={!!serving[model.id]}
                        disabled={!isGguf}
                        title={isGguf ? "Serve this GGUF with llama.cpp on 127.0.0.1" : "llama.cpp serves .gguf files only"}
                        onClick={() => serveModel(model)}
                      >
                        Serve
                      </Button>
                    )}
                    <Button
                      size="xs"
                      variant="ghost"
                      icon="delete"
                      loading={!!removing[model.id]}
                      onClick={() => removeModel(model.id)}
                    >
                      Remove
                    </Button>
                  </div>
                  {serveErrors[model.id] && (
                    <p className="mt-1 text-xs text-red-500">{serveErrors[model.id]}</p>
                  )}
                  {chatOpen && server && (
                    <div className="mt-2 rounded-[10px] border border-border-subtle bg-bg p-3">
                      {(chatLog[server.id] || []).length > 0 && (
                        <div className="mb-2 space-y-1.5 max-h-48 overflow-y-auto">
                          {(chatLog[server.id] || []).map((entry, i) => (
                            <p
                              key={i}
                              className={
                                entry.role === "user"
                                  ? "text-xs text-text-main"
                                  : entry.role === "error"
                                    ? "text-xs text-red-500"
                                    : "text-xs text-text-muted whitespace-pre-wrap"
                              }
                            >
                              <span className="font-semibold">{entry.role === "user" ? "You: " : "Model: "}</span>
                              {entry.text}
                            </p>
                          ))}
                        </div>
                      )}
                      <form
                        className="flex gap-2"
                        onSubmit={(e) => { e.preventDefault(); sendChat(server); }}
                      >
                        <div className="flex-1">
                          <Input
                            value={chatDraft}
                            onChange={(e) => setChatDraft(e.target.value)}
                            placeholder={`Send one test message to ${server.modelName}…`}
                            className="[&>div]:w-full"
                          />
                        </div>
                        <Button type="submit" size="sm" icon="send" loading={chatBusy} disabled={!chatDraft.trim()}>
                          Send
                        </Button>
                      </form>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </Card>

      {/* (c) "+ Add model file" modal */}
      <Modal
        isOpen={showAddModal}
        onClose={() => setShowAddModal(false)}
        title="Add model file"
        size="md"
      >
        <form onSubmit={submitAdd} className="space-y-4">
          <p className="text-sm text-text-muted">
            Register a model file that already exists on this machine. The file stays where it is — only its path is recorded.
          </p>
          <Input
            label="File path"
            required
            value={addPath}
            onChange={(e) => setAddPath(e.target.value)}
            placeholder="C:\Users\you\.ollama\models\qwen2.5-7b-q4_k_m.gguf"
            icon="folder"
          />
          <Input
            label="Display name (optional)"
            value={addName}
            onChange={(e) => setAddName(e.target.value)}
            placeholder="Qwen 2.5 7B Q4"
            icon="label"
          />
          {addError && <p className="text-sm text-red-500">{addError}</p>}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="secondary" onClick={() => setShowAddModal(false)}>
              Cancel
            </Button>
            <Button type="submit" loading={adding}>Register file</Button>
          </div>
        </form>
      </Modal>
    </div>
  );
}
