"use client";

// First-run wizard.
//
// Shown once, on the first launch after an install. It asks one question:
// is there an install on this machine whose keys should come with you, or
// would you rather set things up from scratch.

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";

const FALLBACK_SOURCES = [
  {
    id: "router-install",
    label: "An existing router install",
    detail: "Nothing found in the usual places yet.",
    keyCount: 0,
    available: false,
  },
  {
    id: "omniroute",
    label: "OmniRoute",
    detail: "Not installed on this machine.",
    keyCount: 0,
    available: false,
  },
  {
    id: "free-claude-code",
    label: "Free Claude Code",
    detail: "Not installed on this machine.",
    keyCount: 0,
    available: false,
  },
];

export default function WelcomePage() {
  const router = useRouter();
  const [sources, setSources] = useState(FALLBACK_SOURCES);
  const [busy, setBusy] = useState(null);
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/migrations")
      .then((res) => res.json())
      .then((data) => {
        if (cancelled) return;
        if (Array.isArray(data?.sources) && data.sources.length) {
          setSources(data.sources);
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  const finish = useCallback(() => {
    router.push("/dashboard");
  }, [router]);

  const choose = useCallback(
    async (sourceId) => {
      setBusy(sourceId);
      setError(null);
      try {
        const res = await fetch("/api/migrations", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sourceId }),
        });
        const data = await res.json();
        if (!res.ok || data?.error) {
          setError(data?.error || "The import did not finish.");
          return;
        }
        setResult(data);
        setTimeout(finish, 600);
      } catch (err) {
        setError(err.message);
      } finally {
        setBusy(null);
      }
    },
    [finish]
  );

  return (
    <div className="mx-auto flex w-full max-w-4xl flex-col gap-6">
      <div className="or-panel flex flex-col gap-3 px-6 py-8">
        <h1 className="text-2xl font-bold">Welcome to OriginRouter</h1>
        <p className="text-sm leading-6 text-text-muted">
          One local endpoint for every provider you already pay for. If another router is
          already installed on this machine, its keys can come with you — otherwise, set
          everything up from scratch in the dashboard.
        </p>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        {sources.map((source) => {
          const done = result?.source?.id === source.id;
          const importedCount = done ? result.imported.length : 0;
          return (
            <div key={source.id} className="or-panel flex flex-col gap-3 px-5 py-5">
              <div className="flex items-center justify-between gap-2">
                <h2 className="font-semibold">{source.label}</h2>
                {source.available ? (
                  <span className="or-chip">{source.keyCount} key{source.keyCount === 1 ? "" : "s"}</span>
                ) : (
                  <span className="or-chip">not found</span>
                )}
              </div>
              <p className="text-xs text-text-muted">{source.detail}</p>
              <button
                type="button"
                className="or-action mt-auto"
                disabled={!source.available || busy !== null}
                onClick={() => choose(source.id)}
              >
                {busy === source.id ? "Importing…" : done ? "Imported" : "Import keys"}
              </button>
            </div>
          );
        })}

        <div className="or-panel flex flex-col gap-3 px-5 py-5">
          <div className="flex items-center justify-between gap-2">
            <h2 className="font-semibold">Start from scratch</h2>
            <span className="or-chip">empty</span>
          </div>
          <p className="text-xs text-text-muted">
            Nothing to bring along. Add providers, keys and combos in the dashboard.
          </p>
          <button
            type="button"
            className="or-action mt-auto"
            disabled={busy !== null}
            onClick={() => choose("scratch")}
          >
            {busy === "scratch" ? "Setting up…" : "Set up from scratch"}
          </button>
        </div>
      </div>

      {result?.imported?.length > 0 ? (
        <div className="or-panel px-5 py-4 text-sm text-text-muted">
          Imported {result.imported.length} key{result.imported.length === 1 ? "" : "s"} from{" "}
          {result.source?.label}. Taking you to the dashboard…
        </div>
      ) : null}

      {error ? <div className="or-panel px-5 py-4 text-sm text-primary">{error}</div> : null}
    </div>
  );
}
