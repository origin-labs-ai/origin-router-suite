"use client";

import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { Card, Button, Badge, Input, Modal, SegmentedControl, Spinner } from "@/shared/components";

// /dashboard/skills — the Skills page, redesigned around a card grid.
//
// BODY: every skill is a WIDE, SHORT card (1 col mobile, 2–3 cols desktop,
// same padding/radius/text scale as the Local Models "Registered Models"
// cards) showing the skill name, a ~280-char preview of its SKILL.md opening
// text, and a Read button that opens the shared Modal with a longer excerpt.
//
// DYNAMIC LOADING: the whole catalog arrives in ONE GET (?source=github|local,
// see the route comment for the contract) and the grid renders it
// incrementally — an IntersectionObserver on a sentinel below the grid mounts
// the next BATCH of cards whenever it scrolls into view (rootMargin preloads
// before the edge is reached). 950+ cards never mount at once. GitHub card
// previews are fetched on demand as cards mount, through a small client-side
// queue (PREVIEW_CONCURRENCY in flight) hitting /api/skills-pipeline/preview;
// the server caches each file 10 min, so a full scroll costs one raw fetch
// per actually-seen skill. Local previews ship inline in the list response —
// filesystem reads are cheap, GitHub fetches are not.
//
// SOURCE: a SegmentedControl toggles GitHub / Local; the choice persists in
// localStorage (the server-side default lives in settings skillsSource.kind).
// GitHub failures degrade to the local catalog with a yellow note (the API
// marks fallback:true) — a dead repo never blanks the page.
//
// KEPT: the import pipeline card (Scan/Install against the code-fusion
// payloads catalog, /api/skills-pipeline legacy status) sits below the grid —
// browsing is the new body, installing is still real machinery worth having.

const BATCH = 24; // cards mounted per scroll batch — small enough to stay smooth
const CARD_PREVIEW_CHARS = 280; // matches the API's card preview length
const MODAL_PREVIEW_CHARS = 2000; // the Read modal asks for a longer opening
const PREVIEW_CONCURRENCY = 4; // card-preview fetches in flight at once
const SOURCE_KEY = "originrouter.skillsCatalogSource"; // repo key convention: originrouter.<name>

function readStoredSource() {
  try {
    const stored = window.localStorage.getItem(SOURCE_KEY);
    return stored === "local" || stored === "github" ? stored : "";
  } catch {
    // Storage can be disabled (private mode) — the server default applies.
    return "";
  }
}

const KIND_LABEL = { imported: "imported", installed: "installed", discovered: "found" };

// One catalog card. Same scale vocabulary as LocalModelsClient: Card padding
// "md" (rounded-[12px], p-6), text-sm titles, text-xs meta, xs ghost/secondary
// buttons. Wide and short: name row, two clamped lines of the skill's own
// description (body preview when it has none, always "…" when cut), footer.
// Local cards show the real on-disk path instead of just the folder name —
// that is the whole point of the Local tab: where the skill lives.
function SkillCard({ skill, preview, onRead, showPath }) {
  return (
    <Card padding="md" className="flex flex-col">
      <div className="flex items-center gap-2.5 min-w-0">
        <div className="p-2 rounded-[10px] bg-bg text-text-muted shrink-0">
          <span className="material-symbols-outlined text-[20px]">extension</span>
        </div>
        <h3 className="text-sm font-semibold text-text-main truncate" title={skill.name}>
          {skill.name}
        </h3>
      </div>
      {/* Reserved height keeps every card in a row the same height while
          github previews stream in (empty string until the fetch lands). */}
      <p className="mt-3 text-xs text-text-muted line-clamp-2 min-h-[2rem] break-words" title={preview}>
        {preview}
      </p>
      <div className="mt-3 pt-3 border-t border-border-subtle flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0">
          {showPath && skill.source ? (
            <Badge size="sm" variant="default">{KIND_LABEL[skill.source] || "local"}</Badge>
          ) : null}
          <span className="text-[11px] font-mono text-text-muted truncate" title={skill.path}>
            {showPath ? skill.path : skill.dirName}
          </span>
        </div>
        <Button size="xs" variant="secondary" icon="book" onClick={() => onRead(skill)} className="shrink-0">
          Read
        </Button>
      </div>
    </Card>
  );
}

export default function SkillsPage() {
  // ── catalog state ──────────────────────────────────────────────────────────
  const [source, setSource] = useState("github"); // remembered choice lands after mount (SSR-safe)
  const [skills, setSkills] = useState([]);
  const [notes, setNotes] = useState([]);
  const [sourceConfig, setSourceConfig] = useState(null); // { owner, repo, branch, path } for github
  const [installedDir, setInstalledDir] = useState(""); // local skills' real on-disk home
  const [reloadKey, setReloadKey] = useState(0); // bump after an import to refetch the local catalog
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  // ── local SKILL.md import ───────────────────────────────────────────────────
  const [importOpen, setImportOpen] = useState(false);
  const [importFileName, setImportFileName] = useState("");
  const [importText, setImportText] = useState("");
  const [importBusy, setImportBusy] = useState(false);
  const [importError, setImportError] = useState("");
  const fileInputRef = useRef(null);

  // ── incremental rendering + search ─────────────────────────────────────────
  const [query, setQuery] = useState("");
  const [visibleCount, setVisibleCount] = useState(BATCH);

  // ── github card previews (path → preview text) ─────────────────────────────
  const [previews, setPreviews] = useState({});

  // ── Read modal ─────────────────────────────────────────────────────────────
  const [readSkill, setReadSkill] = useState(null);
  const [readText, setReadText] = useState("");
  const [readLoading, setReadLoading] = useState(false);
  const [readError, setReadError] = useState("");

  // ── legacy pipeline status (import card) ───────────────────────────────────
  const [status, setStatus] = useState(null);
  const [report, setReport] = useState(null); // last scan/install merge report
  const [busy, setBusy] = useState("");
  const [actionError, setActionError] = useState("");

  // Monotonic sequence guard: only the newest request may touch state, so a
  // slow response from a previous source can never overwrite the current one
  // (LocalModelsClient solves the same problem with "keep last good snapshot";
  // here a source switch MUST win, so we drop stale responses instead).
  const catalogSeq = useRef(0);
  const readSeq = useRef(0);

  // Github card-preview queue (refs, not state: the queue is machinery, the
  // arriving texts are state). Declared before switchSource, which resets it.
  const previewQueue = useRef({ queue: [], requested: new Set(), running: 0 });

  // ── catalog loading ────────────────────────────────────────────────────────

  const switchSource = useCallback((next) => {
    if (next !== "github" && next !== "local") return;
    try {
      window.localStorage.setItem(SOURCE_KEY, next); // remember the choice
    } catch { /* storage disabled — session-only memory is fine */ }
    catalogSeq.current += 1; // invalidate any in-flight fetch immediately
    previewQueue.current = { queue: [], requested: new Set(), running: 0 };
    setSource(next);
    setPreviews({});
    setQuery("");
    setVisibleCount(BATCH);
    setLoading(true);
    setError("");
  }, []);

  useEffect(() => {
    const seq = ++catalogSeq.current;
    (async () => {
      try {
        const res = await fetch(`/api/skills-pipeline?source=${source}`, { cache: "no-store" });
        if (seq !== catalogSeq.current) return; // a newer source switch won
        const data = await res.json();
        if (!res.ok || data.error) throw new Error(data.error || "catalog unavailable");
        setSkills(Array.isArray(data.skills) ? data.skills : []);
        setNotes(Array.isArray(data.notes) ? data.notes : []);
        setSourceConfig(data.sourceConfig || null);
        setInstalledDir(data.installedDir || "");
        setVisibleCount(BATCH);
      } catch (err) {
        if (seq !== catalogSeq.current) return;
        setError(err?.message || String(err));
        setSkills([]);
        setNotes([]);
        setInstalledDir("");
      } finally {
        if (seq === catalogSeq.current) setLoading(false);
      }
    })();
  }, [source, reloadKey]);

  // Restore the remembered source once, after mount. Runs after the initial
  // catalog effect fired for the default ("github") — a stored "local" costs
  // one extra request that also warms the server's 10-minute catalog cache.
  useEffect(() => {
    const stored = readStoredSource();
    // eslint-disable-next-line react-hooks/set-state-in-effect -- one-time localStorage hydration of a remembered UI choice, not render-sync
    if (stored && stored !== "github") switchSource(stored);
  }, [switchSource]);

  // ── search filter ──────────────────────────────────────────────────────────

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return skills;
    return skills.filter((s) => `${s.name || ""} ${s.dirName || ""}`.toLowerCase().includes(q));
  }, [skills, query]);

  const visibleSkills = useMemo(() => filtered.slice(0, visibleCount), [filtered, visibleCount]);
  const hasMore = visibleCount < filtered.length;

  // ── infinite scroll (IntersectionObserver) ─────────────────────────────────

  // Ref keeps the observer callback free of stale closures over `filtered`
  // (synced in an effect — refs must not be written during render).
  const filteredRef = useRef(filtered);
  useEffect(() => {
    filteredRef.current = filtered;
  }, [filtered]);
  const sentinelRef = useRef(null);

  const loadMore = useCallback(() => {
    setVisibleCount((count) => {
      const total = filteredRef.current.length;
      return count < total ? Math.min(count + BATCH, total) : count;
    });
  }, []);

  useEffect(() => {
    const el = sentinelRef.current;
    if (!el || typeof IntersectionObserver === "undefined") return; // old engines fall back to the Load more button
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) loadMore();
      },
      // Preload the next batch ~half a viewport before the bottom shows.
      { rootMargin: "480px 0px" },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [loadMore]);

  // ── github card previews: small concurrency-limited queue ──────────────────

  const pumpPreviews = useCallback(() => {
    const state = previewQueue.current;
    const pump = () => {
      while (state.running < PREVIEW_CONCURRENCY && state.queue.length) {
        const path = state.queue.shift();
        state.running += 1;
        fetch(
          `/api/skills-pipeline/preview?source=github&path=${encodeURIComponent(path)}&limit=${CARD_PREVIEW_CHARS}`,
          { cache: "no-store" },
        )
          .then((res) => (res.ok ? res.json() : null))
          .then((data) => {
            // A missing/failed preview stays undefined — the card simply
            // shows an empty line; the Read modal is the retry surface.
            // `card` is description-first (frontmatter description, else the
            // body opening) and already carries "…" when it was cut.
            const text = data && typeof data.card === "string" && data.card ? data.card : data?.preview;
            if (typeof text === "string") {
              setPreviews((prev) => ({ ...prev, [path]: text }));
            }
          })
          .catch(() => { /* network hiccup — leave the card preview empty */ })
          .finally(() => {
            state.running -= 1;
            pump(); // a finished slot pulls the next queued path
          });
      }
    };
    pump();
  }, []);

  // Enqueue previews for every visible github card that does not have one yet.
  // Re-runs as previews land and as scrolling widens the visible slice; the
  // `requested` set makes re-runs no-ops once everything is enqueued.
  useEffect(() => {
    if (source !== "github" || loading) return;
    const state = previewQueue.current;
    let added = false;
    for (const skill of visibleSkills) {
      if (previews[skill.path] === undefined && !state.requested.has(skill.path)) {
        state.requested.add(skill.path);
        state.queue.push(skill.path);
        added = true;
      }
    }
    if (added) pumpPreviews();
  }, [source, loading, visibleSkills, previews, pumpPreviews]);

  // ── Read modal ─────────────────────────────────────────────────────────────

  const openRead = useCallback(
    (skill) => {
      readSeq.current += 1;
      const seq = readSeq.current;
      setReadSkill(skill);
      setReadText("");
      setReadError("");
      setReadLoading(true);
      // Local cards already carry a longer excerpt from the file scan — a
      // discovered skill may live outside the installed dir, so the preview
      // endpoint (which only resolves installed names) cannot read it. Only
      // GitHub cards need a round trip.
      if (source === "local") {
        setReadText(skill.modalText || skill.card || skill.preview || "");
        setReadError("");
        setReadLoading(false);
        return;
      }
      const qs = `source=github&path=${encodeURIComponent(skill.path)}`;
      (async () => {
        try {
          const res = await fetch(`/api/skills-pipeline/preview?${qs}&limit=${MODAL_PREVIEW_CHARS}`, { cache: "no-store" });
          const data = await res.json();
          if (seq !== readSeq.current) return;
          if (!res.ok || data.error) throw new Error(data.error || "preview unavailable");
          setReadText(data.preview || "");
        } catch (err) {
          if (seq !== readSeq.current) return;
          setReadError(err?.message || String(err));
        } finally {
          if (seq === readSeq.current) setReadLoading(false);
        }
      })();
    },
    [source],
  );

  // ── legacy pipeline status + import actions (kept from the old page) ───────

  const refreshStatus = useCallback(async () => {
    try {
      const res = await fetch("/api/skills-pipeline", { cache: "no-store" });
      const data = await res.json();
      if (!res.ok || data.error) throw new Error(data.error || "status unavailable");
      setStatus(data);
    } catch {
      // The import card degrades silently — the catalog grid is the page's job.
    }
  }, []);

  useEffect(() => {
    refreshStatus(); // eslint-disable-line react-hooks/set-state-in-effect -- initial load is an async fetch, not a sync setState
  }, [refreshStatus]);

  // Pick a SKILL.md from the browser. Only its TEXT crosses the boundary —
  // the server never trusts a client-supplied path.
  const pickImportFile = useCallback(async (event) => {
    const file = event?.target?.files?.[0];
    if (!file) return;
    setImportError("");
    try {
      setImportFileName(file.name);
      setImportText(await file.text());
    } catch (err) {
      setImportError(err?.message || "Could not read that file.");
    }
  }, []);

  const importSkill = useCallback(async () => {
    if (!importText.trim()) {
      setImportError("Select a SKILL.md first.");
      return;
    }
    setImportBusy(true);
    setImportError("");
    try {
      const res = await fetch("/api/skills-pipeline", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "import", fileName: importFileName, content: importText }),
      });
      const data = await res.json();
      if (!res.ok || data.error) throw new Error(data.error || "import failed");
      setImportOpen(false);
      setImportFileName("");
      setImportText("");
      if (fileInputRef.current) fileInputRef.current.value = "";
      if (source === "local") setReloadKey((key) => key + 1);
      else switchSource("local");
      await refreshStatus();
    } catch (err) {
      setImportError(err?.message || String(err));
    } finally {
      setImportBusy(false);
    }
  }, [importText, importFileName, source, switchSource, refreshStatus]);

  const act = useCallback(
    async (action) => {
      setBusy(action);
      setActionError("");
      try {
        const res = await fetch("/api/skills-pipeline", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action }),
        });
        const data = await res.json();
        if (!res.ok || data.error) throw new Error(data.error || `${action} failed`);
        setReport(data); // scan → merge preview; install → the run itself
        if (action !== "scan") await refreshStatus();
      } catch (err) {
        // Surface the failure instead of a button that looks like it did
        // nothing: a dead source, a 404 or a rate limit all land here.
        setActionError(err?.message || String(err));
      } finally {
        setBusy("");
      }
    },
    [refreshStatus],
  );

  // ── render ─────────────────────────────────────────────────────────────────

  const sourceHint = sourceConfig
    ? `${sourceConfig.owner}/${sourceConfig.repo}@${sourceConfig.branch} · ${sourceConfig.path}/`
    : status?.source || "";

  return (
    <div className="flex flex-col gap-6 p-6 max-w-5xl mx-auto w-full">
      {/* Header + source toggle */}
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold text-text-main flex items-center gap-3">
            <span className="material-symbols-outlined text-[26px]">extension</span>
            Skills
          </h1>
          <p className="text-sm text-text-muted mt-1">
            {source === "github"
              ? "Agent skills from the GitHub catalog"
              : "Skills installed or found on this machine"}
            {source === "github" && sourceHint ? (
              <>
                {" — "}
                <span className="font-mono">{sourceHint}</span>
              </>
            ) : null}
            .
          </p>
          {source === "local" && installedDir ? (
            <p className="mt-1 text-[11px] font-mono text-text-muted break-all">
              Installed at {installedDir}
            </p>
          ) : null}
        </div>
        <div className="flex items-center gap-2">
          <SegmentedControl
            size="sm"
            value={source}
            onChange={switchSource}
            options={[
              { value: "github", label: "GitHub", icon: "cloud" },
              { value: "local", label: "Local", icon: "hard_drive" },
            ]}
          />
          {source === "local" ? (
            <Button size="sm" variant="secondary" icon="add" onClick={() => setImportOpen(true)}>
              Add
            </Button>
          ) : null}
        </div>
      </div>

      {/* Search + count */}
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex-1 min-w-[220px] max-w-md">
          <Input
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setVisibleCount(BATCH); // a new filter restarts the incremental render
            }}
            placeholder="Filter skills…"
            icon="search"
          />
        </div>
        <Badge variant="default">
          {query.trim() ? `${filtered.length} of ${skills.length}` : `${skills.length} skills`}
        </Badge>
      </div>

      {/* Source notes — fallbacks and truncation warnings surface here */}
      {notes.length > 0 && (
        <div className="space-y-1">
          {notes.map((note, i) => (
            <p key={i} className="text-xs text-yellow-600 dark:text-yellow-500">{note}</p>
          ))}
        </div>
      )}

      {error ? <Card padding="sm"><div className="text-sm text-red-500">{error}</div></Card> : null}

      {/* Card grid */}
      {loading ? (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {Array.from({ length: BATCH }, (_, i) => (
            <Card key={i} padding="md">
              <div className="animate-pulse space-y-3">
                <div className="h-9 rounded-[10px] bg-surface-2" />
                <div className="h-4 rounded bg-surface-2" />
                <div className="h-4 w-2/3 rounded bg-surface-2" />
              </div>
            </Card>
          ))}
        </div>
      ) : filtered.length === 0 ? (
        // Local empty state is an invitation, not a dead end: whether nothing
        // was ever added or nothing was auto-discovered, the single central "+"
        // is the way in. A filtered-out search keeps its own message.
        skills.length === 0 && source === "local" ? (
          <Card padding="md">
            <div className="flex flex-col items-center justify-center text-center py-8 gap-3">
              <span className="material-symbols-outlined text-[32px] text-text-muted">folder_off</span>
              <p className="text-sm font-medium text-text-main">No skills added</p>
              <p className="text-xs text-text-muted max-w-sm">
                Add a SKILL.md to install it here. Skills already on this machine
                are found automatically.
              </p>
              <Button size="sm" icon="add" onClick={() => setImportOpen(true)}>
                Add skill
              </Button>
            </div>
          </Card>
        ) : (
          <Card padding="md">
            <p className="text-sm text-text-muted">
              {skills.length === 0
                ? "No skills found in this catalog yet."
                : `No skills match “${query.trim()}”.`}
            </p>
          </Card>
        )
      ) : (
        <>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {visibleSkills.map((skill) => (
              <SkillCard
                key={`${skill.dirName}:${skill.path}`}
                skill={skill}
                preview={source === "github" ? previews[skill.path] ?? "" : skill.card || skill.preview || ""}
                onRead={openRead}
                showPath={source === "local"}
              />
            ))}
          </div>

          {/* IntersectionObserver sentinel + manual fallback. The button is
              also the a11y path: keyboard users reach it via tab order. */}
          <div ref={sentinelRef} className="flex items-center justify-center py-2 min-h-[2.5rem]">
            {hasMore ? (
              <Button size="sm" variant="ghost" icon="expand_more" onClick={loadMore}>
                Load more ({visibleCount} of {filtered.length})
              </Button>
            ) : (
              <span className="text-xs text-text-muted">
                All {filtered.length} skills shown
                {skills.length !== filtered.length ? ` (filtered from ${skills.length})` : ""}
              </span>
            )}
          </div>
        </>
      )}

      {/* Import pipeline (kept) — the catalog → DATA_DIR machinery behind
          /api/skills-pipeline's legacy contract: Scan previews the merge,
          Install writes what passed. GitHub (the default) fetches each
          skill's SKILL.md; local copies the whole folder. An existing skill
          always wins. */}
      <Card padding="md">
        <div className="flex items-center gap-2 mb-2">
          <span className="material-symbols-outlined text-primary">download</span>
          <span className="text-sm font-semibold">
            {status?.sourceKind === "local" ? "Import from local folder" : "Import from GitHub catalog"}
          </span>
        </div>
        <div className="text-xs text-text-muted mb-3 break-all">
          Source: <span className="font-mono">{status?.source || "…"}</span>
          {status && !status.sourceExists ? <span className="text-red-500"> — not found</span> : null}
          {status?.lastRun ? (
            <span className="block mt-1">
              Last run {new Date(status.lastRun.at).toLocaleString()}: {status.lastRun.installed} installed,{" "}
              {status.lastRun.skipped} skipped{status.lastRun.errors ? `, ${status.lastRun.errors} errors` : ""}.
            </span>
          ) : null}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" icon="search" loading={busy === "scan"} onClick={() => act("scan")}>
            Scan
          </Button>
          <Button size="sm" icon="download" loading={busy === "install"} onClick={() => act("install")}>
            Install
          </Button>
          <Badge size="sm" variant="default">{(status ? status.discovered : 0) ?? 0} discovered</Badge>
          <Badge size="sm" variant="success">{status?.installed ?? 0} installed</Badge>
          {status?.scanError ? <Badge size="sm" variant="error">source error</Badge> : null}
        </div>
        {actionError ? (
          <p className="mt-2 text-xs text-red-500 break-words">{actionError}</p>
        ) : null}

        {/* Merge preview — only what the last Scan/Install reported. Conflicts
            name both sides (incoming vs the entry that won), per CONFLICT.md. */}
        {report?.conflicts?.length ? (
          <div className="mt-3 flex flex-col gap-1">
            {report.conflicts.slice(0, 8).map((c, i) => (
              <div key={`${c.incomingName}-${i}`} className="text-xs text-text-muted">
                <span className="font-mono">{c.incomingName}</span>
                {c.reason === "existing-wins" ? " → existing skill wins" : " → duplicate in source, first wins"}
                {c.existingName && c.existingName !== c.incomingName ? ` (kept: ${c.existingName})` : ""}
              </div>
            ))}
            {report.conflicts.length > 8 ? (
              <div className="text-xs text-text-muted">…and {report.conflicts.length - 8} more</div>
            ) : null}
          </div>
        ) : null}
      </Card>

      {/* Add modal — pick a SKILL.md from disk. Only its text is uploaded;
          the server picks a safe destination under the installed-skills dir. */}
      <Modal
        isOpen={importOpen}
        onClose={() => {
          if (importBusy) return;
          setImportOpen(false);
          setImportError("");
          setImportFileName("");
          setImportText("");
          if (fileInputRef.current) fileInputRef.current.value = "";
        }}
        title="Add a local skill"
        size="md"
      >
        <div className="flex flex-col gap-4">
          <p className="text-sm text-text-muted">
            Choose a <span className="font-mono">SKILL.md</span>. It is copied into the
            installed-skills folder and shows up here right away.
          </p>
          <input
            ref={fileInputRef}
            type="file"
            accept=".md,text/markdown,text/plain"
            onChange={pickImportFile}
            className="hidden"
          />
          <Button
            size="sm"
            variant="secondary"
            icon="upload_file"
            onClick={() => fileInputRef.current?.click()}
          >
            {importFileName || "Choose SKILL.md"}
          </Button>
          {importText ? (
            <p className="text-[11px] text-text-muted">
              {(importText.length / 1024).toFixed(1)} KB ready to import.
            </p>
          ) : null}
          {importError ? <p className="text-xs text-red-500 break-words">{importError}</p> : null}
          <div className="flex justify-end gap-2">
            <Button
              size="sm"
              variant="ghost"
              disabled={importBusy}
              onClick={() => {
                setImportOpen(false);
                setImportError("");
              }}
            >
              Cancel
            </Button>
            <Button size="sm" icon="add" loading={importBusy} disabled={!importText.trim()} onClick={importSkill}>
              Add skill
            </Button>
          </div>
        </div>
      </Modal>

      {/* Read modal — the SKILL.md opening text, rendered as plain text.
          Never the whole file, never an authored description. */}
      <Modal
        isOpen={!!readSkill}
        onClose={() => setReadSkill(null)}
        title={readSkill?.name || "Skill"}
        size="lg"
      >
        {readLoading ? (
          <div className="flex items-center gap-2 text-sm text-text-muted">
            <Spinner size="sm" />
            Loading preview…
          </div>
        ) : readError ? (
          <p className="text-sm text-red-500">{readError}</p>
        ) : (
          <>
            <p className="text-sm text-text-main leading-relaxed break-words">
              {readText || "This SKILL.md has no readable opening text."}
            </p>
            <p className="mt-4 text-[11px] text-text-muted font-mono break-all" title={readSkill?.path}>
              {readSkill?.path}
            </p>
          </>
        )}
      </Modal>
    </div>
  );
}
