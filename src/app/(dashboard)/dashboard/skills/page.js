"use client";

import { useState, useEffect, useCallback } from "react";
import { Card, Button, Badge } from "@/shared/components";

// /dashboard/skills — the Skills page.
//
// The page's original content was an intentional placeholder; what lives here
// now is the code-fusion skills import (the pipeline behind
// /api/skills-pipeline) plus the list of what is actually installed under
// DATA_DIR/skills. Import flow: Scan (preview the merge report — conflicts and
// skips, nothing written) → Install (copy what passed the merge).

export default function SkillsPage() {
  const [status, setStatus] = useState(null);
  const [report, setReport] = useState(null); // scan preview (no writes)
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");

  const refresh = useCallback(async () => {
    try {
      const res = await fetch("/api/skills-pipeline", { cache: "no-store" });
      const data = await res.json();
      if (!res.ok || data.error) throw new Error(data.error || "status unavailable");
      setStatus(data);
    } catch (err) {
      setError(err?.message || String(err));
    }
  }, []);

  useEffect(() => {
    refresh(); // eslint-disable-line react-hooks/set-state-in-effect -- initial load is an async fetch, not a sync setState
  }, [refresh]);

  // scan = preview only; install = the real run. Both post to the pipeline
  // route; install refreshes the status so the installed list updates.
  const act = useCallback(
    async (action, extra = {}) => {
      setBusy(action);
      setError("");
      try {
        const res = await fetch("/api/skills-pipeline", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action, ...extra }),
        });
        const data = await res.json();
        if (!res.ok || data.error) throw new Error(data.error || `${action} failed`);
        setReport(data);
        if (action !== "scan") await refresh();
      } catch (err) {
        setError(err?.message || String(err));
      } finally {
        setBusy("");
      }
    },
    [refresh],
  );

  if (!status) {
    return (
      <div className="flex flex-col gap-4 p-6">
        <Card padding="md">
          <div className="text-sm text-text-muted">{error || "Loading skills…"}</div>
        </Card>
      </div>
    );
  }

  const scan = report || status; // fresh preview or the GET-time snapshot
  const conflicts = scan.conflicts || [];
  const skipped = scan.toSkip || [];
  const lastRun = status.lastRun;

  return (
    <div className="flex flex-col gap-6 p-6 max-w-5xl mx-auto w-full">
      <div>
        <h1 className="text-xl font-semibold">Skills</h1>
        <p className="text-sm text-text-muted mt-1">
          Agent skills installed under <span className="font-mono">{status.destDir}</span>. Import merges the
          code-fusion payloads catalog — an existing skill always wins, source duplicates resolve to the first.
        </p>
      </div>

      {error ? (
        <Card padding="sm"><div className="text-sm text-red-500">{error}</div></Card>
      ) : null}

      {/* Import from code-fusion payloads */}
      <Card padding="md">
        <div className="flex items-center gap-2 mb-2">
          <span className="material-symbols-outlined text-primary">download</span>
          <span className="text-sm font-semibold">Import from code-fusion payloads</span>
        </div>
        <div className="text-xs text-text-muted mb-3 break-all">
          Source: <span className="font-mono">{status.source}</span>
          {!status.sourceExists ? <span className="text-red-500"> — not found</span> : null}
          {lastRun ? (
            <span className="block mt-1">
              Last run {new Date(lastRun.at).toLocaleString()}: {lastRun.installed} installed, {lastRun.skipped} skipped
              {lastRun.errors ? `, ${lastRun.errors} errors` : ""}.
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
          <Badge size="sm" variant="default">{scan.discovered ?? 0} discovered</Badge>
          <Badge size="sm" variant="success">{status.installed} installed</Badge>
          {skipped.length ? <Badge size="sm" variant="warning">{skipped.length} skipped</Badge> : null}
          {conflicts.length ? <Badge size="sm" variant="error">{conflicts.length} conflicts</Badge> : null}
        </div>

        {/* Merge preview — only what Scan/Install last reported. Conflicts name
            both sides (incoming vs the entry that won), per CONFLICT.md. */}
        {conflicts.length ? (
          <div className="mt-3 flex flex-col gap-1">
            {conflicts.slice(0, 12).map((c, i) => (
              <div key={`${c.incomingName}-${i}`} className="text-xs text-text-muted">
                <span className="font-mono">{c.incomingName}</span>
                {c.reason === "existing-wins" ? " → existing skill wins" : " → duplicate in source, first wins"}
                {c.existingName && c.existingName !== c.incomingName ? ` (kept: ${c.existingName})` : ""}
              </div>
            ))}
            {conflicts.length > 12 ? (
              <div className="text-xs text-text-muted">…and {conflicts.length - 12} more</div>
            ) : null}
          </div>
        ) : null}
      </Card>

      {/* Installed skills */}
      <Card padding="md">
        <div className="text-sm font-semibold mb-2">Installed skills</div>
        {!status.installedNames?.length ? (
          <div className="text-xs text-text-muted">
            Nothing installed yet — run Scan to preview, then Install.
          </div>
        ) : (
          <div className="flex flex-wrap gap-1 max-h-64 overflow-y-auto">
            {status.installedNames.map((name) => (
              <Badge key={name} size="sm" variant="default">{name}</Badge>
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}

