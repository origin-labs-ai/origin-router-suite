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
//   (d) the registered models table with remove;
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
function dotFor(engine) {
  if (!engine) return { dot: "bg-gray-400", label: "Unknown" };
  if (engine.ok) return { dot: "bg-green-500", label: "Online" };
  return { dot: "bg-gray-400", label: "Offline" };
}

export default function LocalModelsClient() {
  // --- page state -----------------------------------------------------------
  const [engines, setEngines] = useState({ ollama: null, lmstudio: null, llamacpp: null });
  const [registered, setRegistered] = useState([]);
  const [downloads, setDownloads] = useState([]);

  // Search state: `results` rows are source-tagged HF/Ollama entries.
  const [query, setQuery] = useState("");
  const [searching, setSearching] = useState(false);
  const [searchNotes, setSearchNotes] = useState([]);
  const [results, setResults] = useState([]);

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

  // Interval identity for the poll loop; recreated when speed changes.
  const pollRef = useRef(null);
  const pollMsRef = useRef(5000);

  // Anything queued/running? While true, poll faster so progress bars move.
  const hasActiveDownloads = downloads.some(
    (d) => d.status === "queued" || d.status === "running"
  );

  // --- data loading ---------------------------------------------------------

  // One snapshot GET feeds every section. Failures leave state untouched (the
  // previous snapshot keeps rendering) — a flaky probe must not blank the page.
  const refresh = async () => {
    try {
      const res = await fetch("/api/local-models", { cache: "no-store" });
      if (!res.ok) return;
      const data = await res.json();
      if (data.engines) setEngines(data.engines);
      if (Array.isArray(data.registered)) setRegistered(data.registered);
      if (Array.isArray(data.downloads)) setDownloads(data.downloads);
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
      setSearchNotes(Array.isArray(data.notes) ? data.notes : []);
    } catch {
      setSearchNotes(["Search request failed — try again."]);
      setResults([]);
    } finally {
      setSearching(false);
    }
  };

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

  // --- render ---------------------------------------------------------------

  const engineCards = [
    { key: "ollama", title: "Ollama", icon: "deployed_code", engine: engines.ollama, hint: "127.0.0.1:11434" },
    { key: "lmstudio", title: "LM Studio", icon: "smart_toy", engine: engines.lmstudio, hint: "127.0.0.1:1234" },
    { key: "llamacpp", title: "llama.cpp", icon: "memory", engine: engines.llamacpp, hint: "127.0.0.1:8080" },
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
        {engineCards.map(({ key, title, icon, engine, hint }) => {
          const { dot, label } = dotFor(engine);
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
            {results.map((row) => {
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
            {registered.map((model) => (
              <div key={model.id} className="flex items-center gap-3 py-2.5">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium text-text-main truncate">{model.name}</span>
                    <Badge size="sm">{String(model.path || "").split(".").pop()?.toUpperCase()}</Badge>
                  </div>
                  <p className="text-xs text-text-muted font-mono truncate mt-0.5" title={model.path}>
                    {model.path} · {formatBytes(model.sizeBytes)}
                  </p>
                </div>
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
            ))}
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
