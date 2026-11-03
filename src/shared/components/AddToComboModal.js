"use client";

// Add-to-combo, straight from a provider's model row.
//
// The owner's complaint about the combo picker: an id carries a provider alias, a
// vendor namespace and deployment suffixes, so searching for one model returns
// dozens of near-identical rows and the model he wants (AnyRouter's MiniMax M3.1
// Flash) never gets reached. The row that already names the exact model — on the
// provider page, next to Test and Copy id — is the honest place to add it, because
// there is no ambiguity left to resolve: this seat, into this combo.
//
// It asks where: an existing combo (its members are listed, so one can be added to
// it) or a brand new combo.

import { useCallback, useEffect, useMemo, useState } from "react";
import PropTypes from "prop-types";
// Imported from the files, not the barrel: this module is itself exported by the
// barrel, and a component that pulls its own barrel back in is an import cycle.
import Badge from "./Badge";
import Button from "./Button";
import Input from "./Input";
import Modal from "./Modal";
import { prettyModelName } from "@/shared/utils/modelDisplayName";

const NAME_REGEX = /^[a-zA-Z0-9_.\-]+$/;

export default function AddToComboModal({ open, seat, onClose, onAdded }) {
  // Mounted only while open, so every open starts from a clean state. Resetting state
  // from inside an effect is what this avoids.
  if (!open) return null;
  return <AddToComboDialog seat={seat} onClose={onClose} onAdded={onAdded} />;
}

function AddToComboDialog({ seat, onClose, onAdded }) {
  const [combos, setCombos] = useState([]);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [done, setDone] = useState(null);
  const [query, setQuery] = useState("");
  const [newName, setNewName] = useState("");
  const [tab, setTab] = useState("existing");

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/combos", { cache: "no-store" });
      const data = await res.json();
      setCombos(Array.isArray(data) ? data : data.combos || []);
    } catch (err) {
      setError(`Could not load combos (${err.message})`);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const list = [...combos].sort((a, b) => String(a.name).localeCompare(String(b.name)));
    if (!needle) return list;
    return list.filter((c) =>
      String(c.name).toLowerCase().includes(needle) || String(c.displayName || "").toLowerCase().includes(needle));
  }, [combos, query]);

  const seatName = prettyModelName(seat);

  const addToExisting = async (combo) => {
    const models = Array.isArray(combo.models) ? combo.models : [];
    if (models.includes(seat)) return;
    setBusy(true);
    setError("");
    try {
      const res = await fetch(`/api/combos/${combo.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...combo, models: [...models, seat] }),
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({})))?.error || `HTTP ${res.status}`);
      setDone(`Added to "${combo.name}" (${models.length + 1} models)`);
      await load();
      onAdded?.({ seat, combo: combo.name, created: false });
    } catch (err) {
      setError(err.message || "Could not add the model");
    } finally {
      setBusy(false);
    }
  };

  const createCombo = async () => {
    const name = newName.trim();
    if (!NAME_REGEX.test(name)) {
      setError("Name: letters, numbers, - _ . only");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const res = await fetch("/api/combos", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, models: [seat] }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`);
      setDone(`Created "${name}" with this model`);
      await load();
      setTab("existing");
      onAdded?.({ seat, combo: name, created: true });
    } catch (err) {
      setError(err.message || "Could not create the combo");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal isOpen onClose={onClose} title="Add model to combo" maxWidth="lg">
      <div className="flex flex-col gap-3">
        <div className="rounded-lg border border-border/60 bg-black/[0.02] px-3 py-2 dark:bg-white/[0.03]">
          <p className="text-sm font-medium">{seatName}</p>
          <p className="mt-0.5 break-all font-mono text-[11px] text-text-muted">{seat}</p>
        </div>

        <div className="flex gap-1 rounded-lg bg-black/[0.04] p-1 dark:bg-white/[0.06]">
          {[["existing", "Existing combo"], ["new", "New combo"]].map(([value, label]) => (
            <button
              key={value}
              type="button"
              onClick={() => setTab(value)}
              className={`flex-1 rounded-md px-3 py-1.5 text-xs font-medium transition-colors ${tab === value
                ? "bg-surface text-text-main shadow-sm"
                : "text-text-muted hover:text-text-main"}`}
            >
              {label}
            </button>
          ))}
        </div>

        {tab === "existing" ? (
          <>
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search combos…"
              className="text-sm"
            />
            <div className="flex max-h-[46vh] min-h-[8rem] flex-col gap-1 overflow-y-auto">
              {loading && <p className="px-1 py-2 text-xs text-text-muted">Loading combos…</p>}
              {!loading && filtered.length === 0 && (
                <p className="px-1 py-2 text-xs text-text-muted">
                  {combos.length === 0 ? "No combos yet — use “New combo”." : "No combo matches that name."}
                </p>
              )}
              {filtered.map((combo) => {
                const models = Array.isArray(combo.models) ? combo.models : [];
                const already = models.includes(seat);
                return (
                  <button
                    key={combo.id}
                    type="button"
                    disabled={already || busy}
                    onClick={() => addToExisting(combo)}
                    className="flex items-center justify-between gap-3 rounded-lg border border-border/50 px-3 py-2 text-left transition-colors hover:border-primary/50 hover:bg-primary/5 disabled:cursor-not-allowed disabled:opacity-55"
                  >
                    <span className="min-w-0">
                      <span className="block truncate text-sm font-medium">{combo.displayName || combo.name}</span>
                      <span className="block truncate text-[11px] text-text-muted">
                        {models.length} model{models.length === 1 ? "" : "s"}
                        {models.length > 0 ? ` · ${prettyModelName(models[0])}${models.length > 1 ? `, …` : ""}` : ""}
                      </span>
                    </span>
                    {already ? (
                      <Badge variant="success" size="sm">already in</Badge>
                    ) : (
                      <span className="material-symbols-outlined shrink-0 text-[18px] text-text-muted">add_circle</span>
                    )}
                  </button>
                );
              })}
            </div>
          </>
        ) : (
          <div className="flex flex-col gap-2">
            <Input
              value={newName}
              onChange={(e) => { setNewName(e.target.value); setError(""); }}
              placeholder="combo name (e.g. minimax-flash-pool)"
              className="font-mono text-sm"
            />
            <p className="text-[11px] text-text-muted">
              Letters, numbers, <code>-</code> <code>_</code> <code>.</code> — this becomes the name clients send as
              <code> model</code>.
            </p>
            <Button onClick={createCombo} disabled={busy || !newName.trim()} loading={busy} className="w-full">
              Create combo with this model
            </Button>
          </div>
        )}

        {error && <p className="text-xs text-red-500">{error}</p>}
        {done && <p className="text-xs text-green-600 dark:text-green-400">{done}</p>}
      </div>
    </Modal>
  );
}

AddToComboModal.propTypes = {
  open: PropTypes.bool.isRequired,
  seat: PropTypes.string.isRequired,
  onClose: PropTypes.func.isRequired,
  onAdded: PropTypes.func,
};

AddToComboDialog.propTypes = {
  seat: PropTypes.string.isRequired,
  onClose: PropTypes.func.isRequired,
  onAdded: PropTypes.func,
};

/**
 * The row button itself: an icon that opens the dialog. Self-contained on purpose,
 * so every model row (built-in, imported, custom, compatible, passthrough) can offer
 * it without its page having to carry combo state.
 */
export function AddToComboButton({ seat, label = "Add to combo", className = "" }) {
  const [open, setOpen] = useState(false);
  if (!seat) return null;
  return (
    <>
      <div className={`relative shrink-0 group/btn ${className}`}>
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); setOpen(true); }}
          className="rounded p-0.5 text-text-muted hover:bg-sidebar hover:text-primary"
          aria-label={label}
        >
          <span className="material-symbols-outlined text-sm">layers</span>
        </button>
        <span className="pointer-events-none absolute left-1/2 top-5 mt-1 -translate-x-1/2 whitespace-nowrap text-[10px] text-text-muted opacity-0 transition-opacity group-hover/btn:opacity-100">
          {label}
        </span>
      </div>
      <AddToComboModal open={open} seat={seat} onClose={() => setOpen(false)} />
    </>
  );
}

AddToComboButton.propTypes = {
  seat: PropTypes.string.isRequired,
  label: PropTypes.string,
  className: PropTypes.string,
};
