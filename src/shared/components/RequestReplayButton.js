"use client";

import { useState, useCallback } from "react";
import Button from "./Button";
import Modal from "./Modal";
import Badge from "./Badge";
import { cn } from "@/shared/utils/cn";

// Replay a request the log kept: show what would be sent again, send it, and
// show what came back. The dialog is driven by two API calls — GET asks for
// the stored request without sending it, POST sends it.
export default function RequestReplayButton({
  id,
  variant = "outline",
  size = "sm",
  label = "Replay",
  className,
}) {
  const [isOpen, setIsOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [sending, setSending] = useState(false);
  const [preview, setPreview] = useState(null);
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);

  const openPreview = useCallback(async () => {
    setIsOpen(true);
    setLoading(true);
    setPreview(null);
    setResult(null);
    setError(null);
    try {
      const res = await fetch(`/api/request-replay?id=${encodeURIComponent(id)}`);
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data.error || "Could not load the stored request");
        return;
      }
      setPreview(data);
    } catch (err) {
      setError(err?.message || "Could not load the stored request");
    } finally {
      setLoading(false);
    }
  }, [id]);

  const sendAgain = useCallback(async () => {
    setSending(true);
    setError(null);
    try {
      const res = await fetch("/api/request-replay", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id }),
      });
      const data = await res.json().catch(() => ({}));
      if (!data.status && !data.preview && data.error) {
        setError(data.error);
        return;
      }
      setResult(data);
    } catch (err) {
      setError(err?.message || "The replay failed");
    } finally {
      setSending(false);
    }
  }, [id]);

  const close = useCallback(() => {
    setIsOpen(false);
    setLoading(false);
    setSending(false);
  }, []);

  const canSend = preview?.replayable === true;

  return (
    <>
      <Button
        variant={variant}
        size={size}
        icon="replay"
        onClick={openPreview}
        className={className}
      >
        {label}
      </Button>

      <Modal
        isOpen={isOpen}
        onClose={close}
        title="Replay request"
        size="xl"
        footer={
          <>
            <Button variant="ghost" size="sm" onClick={close}>
              Close
            </Button>
            <Button
              variant="primary"
              size="sm"
              icon="replay"
              onClick={sendAgain}
              loading={sending}
              disabled={!canSend}
            >
              Send again
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-4">
          {loading && (
            <p className="text-sm text-text-muted">Loading the stored request…</p>
          )}

          {error && (
            <div className="rounded-lg border border-red-500/30 bg-red-500/10 p-3 text-sm text-red-600 dark:text-red-400">
              {error}
            </div>
          )}

          {preview && !loading && (
            <>
              <div className="grid min-w-0 grid-cols-1 gap-3 text-sm sm:grid-cols-2">
                <div className="min-w-0">
                  <span className="text-text-muted">Method:</span>{" "}
                  <span className="font-mono text-text-main">{preview.method}</span>
                </div>
                <div className="min-w-0">
                  <span className="text-text-muted">Endpoint:</span>{" "}
                  <span className="break-all font-mono text-text-main">{preview.endpoint}</span>
                </div>
                <div className="min-w-0">
                  <span className="text-text-muted">Model:</span>{" "}
                  <span className="break-all font-mono text-text-main">
                    {preview.model || "—"}
                  </span>
                </div>
                <div className="min-w-0">
                  <span className="text-text-muted">Messages:</span>{" "}
                  <span className="font-mono text-text-main">{preview.messageCount ?? 0}</span>
                </div>
              </div>

              {!canSend && (
                <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-sm text-amber-700 dark:text-amber-400">
                  {preview.reason || "This request cannot be replayed"}
                </div>
              )}

              {preview.description && (
                <p className="text-sm text-text-muted">{preview.description}</p>
              )}

              {preview.body && (
                <div className="flex flex-col gap-1">
                  <span className="text-xs font-semibold uppercase tracking-wide text-text-muted">
                    Request body
                  </span>
                  <pre className="max-h-[240px] max-w-full overflow-auto rounded-lg border border-black/5 bg-black/5 p-3 font-mono text-xs text-text-main dark:border-white/5 dark:bg-white/5 sm:p-4">
                    {JSON.stringify(preview.body, null, 2)}
                  </pre>
                </div>
              )}
            </>
          )}

          {result && (
            <div className="flex flex-col gap-2 rounded-lg border border-black/5 dark:border-white/5 p-3">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-sm font-semibold text-text-main">Result</span>
                <Badge
                  size="sm"
                  variant={result.status >= 200 && result.status < 300 ? "success" : "error"}
                >
                  {result.status ?? "no response"}
                </Badge>
                {typeof result.durationMs === "number" && (
                  <span className="text-xs text-text-muted">{result.durationMs}ms</span>
                )}
              </div>
              {result.error && (
                <p className="text-sm text-red-600 dark:text-red-400">{result.error}</p>
              )}
              <pre
                className={cn(
                  "max-h-[240px] max-w-full overflow-auto rounded-lg border border-black/5 bg-black/5 p-3 font-mono text-xs text-text-main",
                  "dark:border-white/5 dark:bg-white/5 sm:p-4"
                )}
              >
                {result.preview || "(empty response)"}
              </pre>
              {result.truncated && (
                <span className="text-xs text-text-muted">Preview truncated</span>
              )}
            </div>
          )}
        </div>
      </Modal>
    </>
  );
}
