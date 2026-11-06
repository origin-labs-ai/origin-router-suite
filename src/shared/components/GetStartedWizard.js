"use client";

// The first-run wizard.
//
// One window, seven steps, and every step can be skipped. The order matters:
// the theme first (it is the only step that changes what the user sees while
// they are still inside the wizard), then where the keys come from, then one
// provider, then a combo to route with, then how hard the router works, then
// Claude Code, and last the summary.
//
// The portable build has two extra steps and they come first: where the data
// is stored, and how the app starts. Everything else is the same.

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import ProviderIcon from "@/shared/components/ProviderIcon";
import { useTheme } from "@/shared/hooks/useTheme";
import {
  APIKEY_PROVIDERS,
  FREE_PROVIDERS,
  FREE_TIER_PROVIDERS,
  OAUTH_PROVIDERS,
} from "@/shared/constants/providers";
import {
  COMBO_STRATEGY_PRESETS,
  COMPRESSION_LEVELS,
  FALLBACK_STRATEGIES,
  ROUTER_BRAINS,
} from "@/lib/onboardingPresets";

const BASE_STEPS = [
  { id: "theme", label: "Theme", icon: "palette", hint: "How OriginRouter looks" },
  { id: "migrate", label: "Migrate", icon: "move_to_inbox", hint: "Bring your keys with you" },
  { id: "provider", label: "Provider", icon: "hub", hint: "Your first provider" },
  { id: "combo", label: "Combo", icon: "route", hint: "Route several models as one" },
  { id: "extras", label: "Tuning", icon: "tune", hint: "How hard the router works" },
  { id: "claude", label: "Claude Code", icon: "terminal", hint: "Point the CLI at the router" },
  { id: "done", label: "Finish", icon: "check_circle", hint: "Everything is ready" },
];

// The portable build asks two extra questions, in the order they matter:
// the data folder first (everything else writes into it), then how the app
// starts.
const PORTABLE_STEPS = [
  { id: "location", label: "Data", icon: "folder", hint: "Where the data is stored", portable: true },
  { id: "tray", label: "Start", icon: "desktop_windows", hint: "Tray or window", portable: true },
];

const THEME_OPTIONS = [
  { id: "light", label: "Light", icon: "light_mode", hint: "Bright, for daylight" },
  { id: "dark", label: "Dark", icon: "dark_mode", hint: "Dim, for long sessions" },
  { id: "system", label: "System", icon: "contrast", hint: "Follows your OS" },
];

const SOURCE_LOGOS = {
  "router-install": { text: "OR", color: "#2B7FFF" },
  omniroute: { text: "OM", color: "#6366f1" },
  "free-claude-code": { text: "FC", color: "#14b8a6" },
};

function SourceLogo({ sourceId, name }) {
  const logo =
    SOURCE_LOGOS[sourceId] ||
    (sourceId?.startsWith("router:")
      ? SOURCE_LOGOS["router-install"]
      : { text: (name || "?").replace(/[^a-z0-9]/gi, "").slice(0, 2).toUpperCase() || "?", color: "#6B7280" });
  return (
    <span
      className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl text-sm font-bold text-white"
      style={{ backgroundColor: logo.color }}
    >
      {logo.text}
    </span>
  );
}

function StepIcon({ icon, active }) {
  return (
    <span
      className={`material-symbols-outlined flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-base transition-colors ${
        active ? "bg-primary text-white" : "bg-bg-subtle text-text-muted"
      }`}
    >
      {icon}
    </span>
  );
}

function SectionTitle({ children, hint }) {
  return (
    <div className="mb-3 flex flex-col gap-1">
      <h3 className="text-base font-semibold text-text-main">{children}</h3>
      {hint ? <p className="text-xs leading-5 text-text-muted">{hint}</p> : null}
    </div>
  );
}

// The portable build asks two questions of its own. They get their own look
// so they are never mistaken for the steps every install has.
function PortablePanel({ children }) {
  return (
    <div className="flex h-full flex-col gap-4 rounded-xl border-2 border-dashed border-primary/40 bg-primary/5 p-4">
      <div className="flex items-center gap-2">
        <span className="material-symbols-outlined text-base text-primary">deployed_code</span>
        <span className="or-chip">portable build</span>
        <span className="text-xs text-text-muted">
          This copy runs from the folder it sits in, so it asks these two questions itself.
        </span>
      </div>
      {children}
    </div>
  );
}

function ChoiceCard({ active, onClick, title, subtitle, icon, badge, accent }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`group flex w-full flex-col gap-2 rounded-xl border p-4 text-left transition-all ${
        active
          ? "border-primary bg-primary/5 shadow-[0_0_0_1px_var(--color-primary)]"
          : "border-border bg-bg hover:border-border-strong hover:bg-bg-subtle"
      }`}
    >
      <div className="flex items-center justify-between gap-2">
        <span
          className={`material-symbols-outlined flex h-8 w-8 items-center justify-center rounded-lg text-lg ${
            active ? "text-primary" : "text-text-muted"
          }`}
        >
          {icon}
        </span>
        {badge ? <span className="or-chip">{badge}</span> : null}
      </div>
      <span className="text-sm font-semibold text-text-main">{title}</span>
      {subtitle ? (
        <span className={`text-xs leading-5 ${accent || "text-text-muted"}`}>{subtitle}</span>
      ) : null}
    </button>
  );
}

export default function GetStartedWizard({
  isOpen = true,
  onClose,
  onFinished,
  firstRun = false,
}) {
  const router = useRouter();
  const { theme, setTheme } = useTheme();

  const [stepIndex, setStepIndex] = useState(0);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState(null);
  const [error, setError] = useState(null);

  // Portable extras.
  const [portable, setPortable] = useState(false);
  const [dataDir, setDataDir] = useState("");
  const [dataDirInput, setDataDirInput] = useState("");
  const [tray, setTray] = useState(true);

  // Migration.
  const [sources, setSources] = useState([]);
  const [imported, setImported] = useState(null);

  // Provider.
  const [providerTab, setProviderTab] = useState("oauth");
  const [pickedProvider, setPickedProvider] = useState(null);
  const [providerKey, setProviderKey] = useState("");
  const [connected, setConnected] = useState([]);

  // Combo.
  const [comboName, setComboName] = useState("Main");
  const [comboModels, setComboModels] = useState([]);
  const [presetId, setPresetId] = useState("max");
  const [customStrategy, setCustomStrategy] = useState({
    fallbackStrategy: "smart",
    routerBrain: "merged",
    compression: "full",
  });
  const [comboCreated, setComboCreated] = useState(null);

  // Tuning.
  const [compression, setCompression] = useState("full");
  const [concurrency, setConcurrency] = useState(8);
  const [exposeAllModels, setExposeAllModels] = useState(true);
  const [originEndpoint, setOriginEndpoint] = useState(false);
  const [apiKey, setApiKey] = useState(null);

  // Claude Code.
  const [claude, setClaude] = useState(null);
  const [claudeDone, setClaudeDone] = useState(null);

  const steps = useMemo(
    () => (portable ? [...PORTABLE_STEPS, ...BASE_STEPS] : BASE_STEPS),
    [portable]
  );
  const step = steps[stepIndex] || steps[0];

  const providerList = useMemo(() => {
    const source =
      providerTab === "oauth"
        ? OAUTH_PROVIDERS
        : providerTab === "apikey"
          ? APIKEY_PROVIDERS
          : { ...FREE_PROVIDERS, ...FREE_TIER_PROVIDERS };
    return Object.values(source)
      .filter((provider) => !provider.hidden)
      .filter((provider) => (provider.serviceKinds || ["llm"]).includes("llm"))
      .slice(0, 40);
  }, [providerTab]);

  const loadState = useCallback(async () => {
    try {
      const res = await fetch("/api/onboarding", { cache: "no-store" });
      const data = await res.json();
      if (!res.ok) return;
      setPortable(data.portable === true);
      setDataDir(data.dataDir || "");
      setDataDirInput(data.dataDirPreference || data.defaultDataDir || "");
      if (typeof data.trayPreference === "boolean") setTray(data.trayPreference);
      if (Array.isArray(data.sources) && data.sources.length) setSources(data.sources);
      if (Array.isArray(data.apiKeys) && data.apiKeys.length) {
        const first = data.apiKeys.find((key) => key.isActive) || data.apiKeys[0];
        setApiKey({ key: first.key, name: first.name, created: false });
      }
    } catch {
      // The wizard still works without the extra state.
    }
  }, []);

  useEffect(() => {
    if (!isOpen) return;
    loadState();
    (async () => {
      try {
        const res = await fetch("/api/migrations/claude-setup", { cache: "no-store" });
        const data = await res.json();
        if (res.ok) setClaude(data);
      } catch {
        // Optional.
      }
    })();
  }, [isOpen, loadState]);

  const goNext = useCallback(() => {
    setNotice(null);
    setError(null);
    setStepIndex((index) => Math.min(index + 1, steps.length - 1));
  }, [steps.length]);

  const goBack = useCallback(() => {
    setNotice(null);
    setError(null);
    setStepIndex((index) => Math.max(index - 1, 0));
  }, []);

  // "Skip setup" leaves the whole wizard; "Skip this" only the current step.
  const skipEverything = useCallback(() => {
    setStepIndex(steps.length - 1);
    setNotice("Setup skipped. You can run it again any time from the dashboard.");
  }, [steps.length]);

  const skipStep = useCallback(() => {
    setNotice(null);
    setError(null);
    goNext();
  }, [goNext]);

  const runMigration = useCallback(async (sourceId) => {
    setBusy(true);
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
        return false;
      }
      setImported(data);
      setNotice(
        data.imported?.length
          ? `${data.imported.length} key${data.imported.length === 1 ? "" : "s"} imported.`
          : "Nothing to import - that is fine."
      );
      await loadState();
      return true;
    } catch (err) {
      setError(err.message);
      return false;
    } finally {
      setBusy(false);
    }
  }, [loadState]);

  const connectProvider = useCallback(async () => {
    if (!pickedProvider) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/providers", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          provider: pickedProvider.id,
          apiKey: providerKey.trim(),
          name: pickedProvider.name,
        }),
      });
      const data = await res.json();
      if (!res.ok || data?.error) {
        setError(data?.error || "The provider could not be added.");
        return;
      }
      setConnected((list) => [...list, pickedProvider.id]);
      setProviderKey("");
      setNotice(`${pickedProvider.name} is connected.`);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }, [pickedProvider, providerKey]);

  const createCombo = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/onboarding", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "combo",
          name: comboName.trim() || "Main",
          models: comboModels,
          presetId,
          strategy:
            presetId === "custom"
              ? {
                  fallbackStrategy: customStrategy.fallbackStrategy,
                  routerBrain: customStrategy.routerBrain,
                  compression: customStrategy.compression,
                }
              : null,
        }),
      });
      const data = await res.json();
      if (!res.ok || data?.error) {
        setError(data?.error || "The combo could not be created.");
        return;
      }
      setComboCreated(data.combo);
      setNotice(`Combo “${comboName}” is ready.`);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }, [comboName, comboModels, presetId, customStrategy]);

  const saveTuning = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      await fetch("/api/onboarding", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "settings",
          patch: {
            tokenSaver: {
              cavemanEnabled: compression !== "off",
              cavemanLevel: compression,
              ponytailEnabled: compression !== "off",
              ponytailLevel: compression,
              rtkEnabled: compression !== "off",
            },
            routingPolicy: { maxAgentsConcurrency: Number(concurrency) || 8 },
            exposeAllModels,
            originEndpointEnabled: originEndpoint,
          },
        }),
      });
      setNotice("Saved.");
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }, [compression, concurrency, exposeAllModels, originEndpoint]);

  const createApiKey = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/onboarding", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "apiKey", name: "OriginRouter" }),
      });
      const data = await res.json();
      if (!res.ok || data?.error) {
        setError(data?.error || "The API key could not be created.");
        return;
      }
      setApiKey({ key: data.apiKey.key, name: data.apiKey.name, created: true });
      setNotice("Your API key is ready.");
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }, []);

  const setupClaudeCode = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/migrations/claude-setup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ apiKey: apiKey?.key || "" }),
      });
      const data = await res.json();
      if (!res.ok || data?.error) {
        setError(data?.error || "Claude Code could not be set up.");
        return;
      }
      setClaudeDone(data);
      setNotice(`${data.settingsPath} is updated.`);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }, [apiKey]);

  const saveDataDir = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/onboarding", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "dataLocation", dir: dataDirInput.trim() }),
      });
      const data = await res.json();
      if (!res.ok || data?.error) {
        setError(data?.error || "The folder could not be used.");
        return;
      }
      setDataDir(data.dataDir);
      setNotice("Saved. The router uses this folder from the next start.");
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }, [dataDirInput]);

  const saveTray = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      await fetch("/api/onboarding", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "trayPreference", tray }),
      });
      setNotice("Saved.");
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }, [tray]);

  const finish = useCallback(async () => {
    // The wizard is shown once. Marking it done stops the dashboard from
    // asking for it again - even if every step was skipped.
    try {
      if (!imported) {
        await fetch("/api/migrations", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sourceId: "scratch" }),
        });
      }
    } catch {
      // The dashboard still opens.
    }
    if (onFinished) onFinished();
    else router.push("/dashboard");
  }, [imported, onFinished, router]);

  if (!isOpen) return null;

  const renderStep = () => {
    switch (step.id) {
      case "location":
        return (
          <PortablePanel>
            <SectionTitle hint="Everything the router remembers lives in one folder. Keep the default unless you want the data on another drive.">
              Where should the data go?
            </SectionTitle>
            <div className="grid gap-3 md:grid-cols-2">
              <ChoiceCard
                active={dataDirInput === (dataDir || "")}
                icon="home"
                title="Use the default"
                subtitle={dataDir || "~/.or"}
                onClick={() => setDataDirInput(dataDir || "")}
              />
              <ChoiceCard
                active={dataDirInput !== (dataDir || "")}
                icon="folder_open"
                title="Pick a folder"
                subtitle="Type the full path of an empty folder."
                onClick={() => {}}
              />
            </div>
            <label className="flex flex-col gap-1 text-xs font-medium text-text-muted">
              Data folder
              <input
                value={dataDirInput}
                onChange={(event) => setDataDirInput(event.target.value)}
                placeholder="~/.or"
                className="rounded-lg border border-border bg-bg px-3 py-2 font-mono text-sm text-text-main outline-none focus:border-primary"
              />
            </label>
            <div>
              <button type="button" className="or-action" disabled={busy} onClick={saveDataDir}>
                {busy ? "Saving…" : "Save the folder"}
              </button>
            </div>
          </PortablePanel>
        );

      case "tray":
        return (
          <PortablePanel>
            <SectionTitle hint="The portable build has no installer, so this is the one question it cannot ask for you.">
              How should OriginRouter start?
            </SectionTitle>
            <div className="grid gap-3 md:grid-cols-2">
              <ChoiceCard
                active={tray}
                icon="inventory_2"
                title="Start in the system tray"
                subtitle="Quiet in the corner, one click to open the dashboard."
                onClick={() => setTray(true)}
              />
              <ChoiceCard
                active={!tray}
                icon="terminal"
                title="Start with a window"
                subtitle="The console stays open, the dashboard is right there."
                onClick={() => setTray(false)}
              />
            </div>
            <div>
              <button type="button" className="or-action" disabled={busy} onClick={saveTray}>
                {busy ? "Saving…" : "Save"}
              </button>
            </div>
          </PortablePanel>
        );

      case "theme":
        return (
          <div className="flex h-full flex-col gap-4">
            <SectionTitle hint="Click a theme to see it right away. Change your mind as often as you like - nothing is locked in until you continue.">
              Pick your theme
            </SectionTitle>
            <div className="grid gap-3 md:grid-cols-3">
              {THEME_OPTIONS.map((option) => (
                <ChoiceCard
                  key={option.id}
                  active={theme === option.id}
                  icon={option.icon}
                  title={option.label}
                  subtitle={option.hint}
                  onClick={() => setTheme(option.id)}
                />
              ))}
            </div>
            <div className="rounded-xl border border-border bg-bg-subtle p-4">
              <div className="mb-3 text-xs font-semibold text-text-muted">Preview</div>
              <div className="flex gap-3">
                <div className="h-20 w-1/3 rounded-lg border border-border bg-bg p-2">
                  <div className="h-2 w-2/3 rounded bg-border" />
                  <div className="mt-2 h-2 w-1/2 rounded bg-border" />
                  <div className="mt-2 h-6 rounded bg-primary/20" />
                </div>
                <div className="h-20 w-1/3 rounded-lg border border-border bg-bg-subtle p-2">
                  <div className="h-2 w-1/2 rounded bg-border" />
                  <div className="mt-2 h-2 w-2/3 rounded bg-border" />
                  <div className="mt-2 h-6 rounded bg-primary/30" />
                </div>
                <div className="h-20 w-1/3 rounded-lg border border-border bg-bg p-2">
                  <div className="h-2 w-3/5 rounded bg-border" />
                  <div className="mt-2 h-8 rounded bg-primary" />
                </div>
              </div>
            </div>
          </div>
        );

      case "migrate":
        return (
          <div className="flex h-full flex-col gap-4">
            <SectionTitle hint="If another router is already installed on this machine, its keys can come with you. Otherwise, start clean.">
              Migrate from
            </SectionTitle>
            <div className="grid gap-3 md:grid-cols-2">
              {sources.map((source) => (
                <button
                  key={source.id}
                  type="button"
                  disabled={!source.available || busy}
                  onClick={() => runMigration(source.id)}
                  className="flex items-start gap-3 rounded-xl border border-border bg-bg p-4 text-left transition-colors hover:border-border-strong hover:bg-bg-subtle disabled:cursor-not-allowed disabled:opacity-60"
                >
                  <SourceLogo sourceId={source.id} name={source.label} />
                  <span className="flex min-w-0 flex-col gap-1">
                    <span className="text-sm font-semibold text-text-main">{source.label}</span>
                    <span className="text-xs leading-5 text-text-muted">{source.detail}</span>
                    {source.available ? (
                      <span className="or-chip mt-1 w-fit">{source.keyCount} keys</span>
                    ) : (
                      <span className="or-chip mt-1 w-fit">not found</span>
                    )}
                  </span>
                </button>
              ))}
              <button
                type="button"
                disabled={busy}
                onClick={() => runMigration("scratch")}
                className="flex items-start gap-3 rounded-xl border border-border bg-bg p-4 text-left transition-colors hover:border-border-strong hover:bg-bg-subtle disabled:opacity-60"
              >
                <SourceLogo sourceId="" name="New" />
                <span className="flex min-w-0 flex-col gap-1">
                  <span className="text-sm font-semibold text-text-main">Start from scratch</span>
                  <span className="text-xs leading-5 text-text-muted">
                    Nothing to bring along. Add providers, keys and combos yourself.
                  </span>
                </span>
              </button>
            </div>
          </div>
        );

      case "provider":
        return (
          <div className="flex h-full flex-col gap-4">
            <SectionTitle hint="One provider is enough to start. You can add the rest later from the providers page.">
              Set up your first provider
            </SectionTitle>
            <div className="flex flex-wrap items-center gap-2">
              {[
                { id: "oauth", label: "Sign in with" },
                { id: "apikey", label: "API key" },
                { id: "free", label: "Free tiers" },
              ].map((tab) => (
                <button
                  key={tab.id}
                  type="button"
                  onClick={() => {
                    setProviderTab(tab.id);
                    setPickedProvider(null);
                  }}
                  className={`rounded-lg px-3 py-1.5 text-xs font-medium transition-colors ${
                    providerTab === tab.id
                      ? "bg-primary text-white"
                      : "bg-bg-subtle text-text-muted hover:text-text"
                  }`}
                >
                  {tab.label}
                </button>
              ))}
              <button
                type="button"
                onClick={() => setPickedProvider(null)}
                className="ml-auto text-xs text-text-muted underline-offset-2 hover:underline"
              >
                Continue with the free providers
              </button>
            </div>

            <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
              {providerList.map((provider) => {
                const isOAuth = providerTab === "oauth";
                return (
                  <button
                    key={provider.id}
                    type="button"
                    onClick={() => setPickedProvider(provider)}
                    className={`flex items-center gap-2.5 rounded-xl border px-3 py-2.5 text-left transition-colors ${
                      pickedProvider?.id === provider.id
                        ? "border-primary bg-primary/5"
                        : "border-border bg-bg hover:border-border-strong hover:bg-bg-subtle"
                    }`}
                  >
                    <ProviderIcon
                      providerId={provider.id}
                      size={26}
                      fallbackText={provider.textIcon || provider.id.slice(0, 2).toUpperCase()}
                      fallbackColor={provider.color}
                    />
                    <span className="min-w-0 flex-1 truncate text-xs font-medium text-text-main">
                      {provider.name}
                    </span>
                    {connected.includes(provider.id) ? (
                      <span className="material-symbols-outlined text-sm text-primary">check_circle</span>
                    ) : null}
                  </button>
                );
              })}
            </div>

            {pickedProvider ? (
              <div className="rounded-xl border border-border bg-bg-subtle p-4">
                <div className="mb-3 flex items-center gap-2">
                  <ProviderIcon
                    providerId={pickedProvider.id}
                    size={24}
                    fallbackText={pickedProvider.textIcon}
                    fallbackColor={pickedProvider.color}
                  />
                  <span className="text-sm font-semibold text-text-main">{pickedProvider.name}</span>
                </div>
                {providerTab === "oauth" ? (
                  <div className="flex flex-wrap items-center gap-3">
                    <p className="text-xs leading-5 text-text-muted">
                      {pickedProvider.name} signs in through its own page. It opens in a new tab -
                      finish there and come back.
                    </p>
                    <a
                      href={`/dashboard/providers/${pickedProvider.id}`}
                      target="_blank"
                      rel="noreferrer"
                      className="or-action"
                    >
                      Open the sign-in
                    </a>
                  </div>
                ) : (
                  <div className="flex flex-col gap-2">
                    <input
                      value={providerKey}
                      onChange={(event) => setProviderKey(event.target.value)}
                      placeholder={pickedProvider.notice?.apiKeyUrl ? `Key from ${pickedProvider.notice.apiKeyUrl}` : "API key"}
                      className="rounded-lg border border-border bg-bg px-3 py-2 font-mono text-xs text-text-main outline-none focus:border-primary"
                    />
                    <div>
                      <button
                        type="button"
                        className="or-action"
                        disabled={busy || !providerKey.trim()}
                        onClick={connectProvider}
                      >
                        {busy ? "Connecting…" : "Connect"}
                      </button>
                    </div>
                  </div>
                )}
              </div>
            ) : null}
          </div>
        );

      case "combo":
        return (
          <div className="flex h-full flex-col gap-4">
            <SectionTitle hint="A combo is one model name that the router fills from several providers. It is how a single client keeps working when one provider is busy.">
              Set up a custom combo
            </SectionTitle>

            <div className="grid gap-3 md:grid-cols-2">
              <label className="flex flex-col gap-1 text-xs font-medium text-text-muted">
                Combo name
                <input
                  value={comboName}
                  onChange={(event) => setComboName(event.target.value)}
                  placeholder="Main"
                  className="rounded-lg border border-border bg-bg px-3 py-2 text-sm text-text-main outline-none focus:border-primary"
                />
              </label>
              <label className="flex flex-col gap-1 text-xs font-medium text-text-muted">
                Members
                <input
                  value={comboModels.join(", ")}
                  onChange={(event) =>
                    setComboModels(
                      event.target.value
                        .split(",")
                        .map((value) => value.trim())
                        .filter(Boolean)
                    )
                  }
                  placeholder="provider/model, provider/model"
                  className="rounded-lg border border-border bg-bg px-3 py-2 font-mono text-xs text-text-main outline-none focus:border-primary"
                />
              </label>
            </div>

            <div>
              <div className="mb-2 text-xs font-semibold text-text-muted">Routing strategy</div>
              <div className="grid gap-3 md:grid-cols-3">
                {COMBO_STRATEGY_PRESETS.map((preset) => (
                  <ChoiceCard
                    key={preset.id}
                    active={presetId === preset.id}
                    icon={preset.id === "max" ? "bolt" : preset.id === "revolt-deffusion" ? "balance" : "tune"}
                    title={preset.label}
                    subtitle={preset.description}
                    badge={preset.tagline}
                    onClick={() => setPresetId(preset.id)}
                  />
                ))}
              </div>
            </div>

            {presetId === "custom" ? (
              <div className="grid gap-3 md:grid-cols-3">
                <label className="flex flex-col gap-1 text-xs font-medium text-text-muted">
                  Strategy
                  <select
                    value={customStrategy.fallbackStrategy}
                    onChange={(event) =>
                      setCustomStrategy((prev) => ({ ...prev, fallbackStrategy: event.target.value }))
                    }
                    className="rounded-lg border border-border bg-bg px-3 py-2 text-xs text-text-main outline-none focus:border-primary"
                  >
                    {FALLBACK_STRATEGIES.map((option) => (
                      <option key={option.id} value={option.id}>
                        {option.label} - {option.hint}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="flex flex-col gap-1 text-xs font-medium text-text-muted">
                  Brain
                  <select
                    value={customStrategy.routerBrain}
                    onChange={(event) =>
                      setCustomStrategy((prev) => ({ ...prev, routerBrain: event.target.value }))
                    }
                    className="rounded-lg border border-border bg-bg px-3 py-2 text-xs text-text-main outline-none focus:border-primary"
                  >
                    {ROUTER_BRAINS.map((option) => (
                      <option key={option.id} value={option.id}>
                        {option.label} - {option.hint}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="flex flex-col gap-1 text-xs font-medium text-text-muted">
                  Compression
                  <select
                    value={customStrategy.compression}
                    onChange={(event) =>
                      setCustomStrategy((prev) => ({ ...prev, compression: event.target.value }))
                    }
                    className="rounded-lg border border-border bg-bg px-3 py-2 text-xs text-text-main outline-none focus:border-primary"
                  >
                    {COMPRESSION_LEVELS.map((option) => (
                      <option key={option.id} value={option.id}>
                        {option.label} - {option.hint}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
            ) : null}

            <div>
              <button
                type="button"
                className="or-action"
                disabled={busy || !comboName.trim()}
                onClick={createCombo}
              >
                {busy ? "Creating…" : comboCreated ? "Create another" : "Create the combo"}
              </button>
            </div>
          </div>
        );

      case "extras":
        return (
          <div className="flex h-full flex-col gap-4">
            <SectionTitle hint="How hard the router works and how much it saves on every prompt. Both can be changed later in the settings.">
              Routing and savings
            </SectionTitle>
            <div className="grid gap-3 md:grid-cols-2">
              <label className="flex flex-col gap-1 text-xs font-medium text-text-muted">
                Token compression
                <select
                  value={compression}
                  onChange={(event) => setCompression(event.target.value)}
                  className="rounded-lg border border-border bg-bg px-3 py-2 text-sm text-text-main outline-none focus:border-primary"
                >
                  {COMPRESSION_LEVELS.map((option) => (
                    <option key={option.id} value={option.id}>
                      {option.label} - {option.hint}
                    </option>
                  ))}
                </select>
              </label>
              <label className="flex flex-col gap-1 text-xs font-medium text-text-muted">
                Agents at once
                <input
                  type="number"
                  min={1}
                  max={64}
                  value={concurrency}
                  onChange={(event) => setConcurrency(Number(event.target.value))}
                  className="rounded-lg border border-border bg-bg px-3 py-2 text-sm text-text-main outline-none focus:border-primary"
                />
              </label>
            </div>

            <div className="grid gap-2 md:grid-cols-2">
              <button
                type="button"
                onClick={() => setExposeAllModels((value) => !value)}
                className="flex items-center gap-3 rounded-xl border border-border bg-bg px-4 py-3 text-left transition-colors hover:bg-bg-subtle"
              >
                <span
                  className={`material-symbols-outlined text-lg ${
                    exposeAllModels ? "text-primary" : "text-text-subtle"
                  }`}
                >
                  {exposeAllModels ? "toggle_on" : "toggle_off"}
                </span>
                <span className="flex min-w-0 flex-col">
                  <span className="text-xs font-semibold text-text-main">Expose every model</span>
                  <span className="text-[11px] leading-4 text-text-muted">
                    Clients may ask for any model, not only the ones you picked.
                  </span>
                </span>
              </button>
              <button
                type="button"
                onClick={() => setOriginEndpoint((value) => !value)}
                className="flex items-center gap-3 rounded-xl border border-border bg-bg px-4 py-3 text-left transition-colors hover:bg-bg-subtle"
              >
                <span
                  className={`material-symbols-outlined text-lg ${
                    originEndpoint ? "text-primary" : "text-text-subtle"
                  }`}
                >
                  {originEndpoint ? "toggle_on" : "toggle_off"}
                </span>
                <span className="flex min-w-0 flex-col">
                  <span className="text-xs font-semibold text-text-main">Origin endpoint</span>
                  <span className="text-[11px] leading-4 text-text-muted">
                    Answer with the provider a model came from, instead of routing it.
                  </span>
                </span>
              </button>
            </div>

            <div className="rounded-xl border border-border bg-bg-subtle p-4">
              <div className="mb-2 text-xs font-semibold text-text-main">Your API key</div>              {apiKey ? (
                <div className="flex flex-wrap items-center gap-2">
                  <code className="rounded-lg border border-border bg-bg px-3 py-2 font-mono text-xs text-text-main">
                    {apiKey.key}
                  </code>
                  <span className="or-chip">{apiKey.name}</span>
                </div>
              ) : (
                <p className="text-xs text-text-muted">
                  The router creates one for you. Claude Code and every other client use it.
                </p>
              )}
              <div className="mt-3 flex flex-wrap gap-2">
                <button type="button" className="or-action" disabled={busy} onClick={createApiKey}>
                  {busy ? "Working…" : apiKey ? "Create another" : "Create an API key"}
                </button>
                <button type="button" className="or-action" disabled={busy} onClick={saveTuning}>
                  {busy ? "Saving…" : "Save the tuning"}
                </button>
              </div>
            </div>
          </div>
        );

      case "claude":
        return (
          <div className="flex h-full flex-col gap-4">
            <SectionTitle hint="One button. The router writes the whole Claude Code configuration - endpoint, key, models and timeouts - and keeps a copy of the file it replaces.">
              Setup Claude Code
            </SectionTitle>
            {claudeDone ? (
              <div className="rounded-xl border border-primary/40 bg-primary/5 p-4">
                <div className="mb-1 flex items-center gap-2 text-sm font-semibold text-text-main">
                  <span className="material-symbols-outlined text-primary">check_circle</span>
                  Claude Code is set up
                </div>
                <p className="text-xs leading-5 text-text-muted">
                  {claudeDone.settingsPath} now points at this router. Start Claude Code and the
                  first turn runs through OriginRouter.
                </p>
              </div>
            ) : (
              <div className="rounded-xl border border-border bg-bg-subtle p-4">
                <div className="grid gap-2 text-xs text-text-muted sm:grid-cols-[7rem_1fr] sm:items-center">
                  <span className="font-semibold text-text-main">Settings</span>
                  <span className="truncate font-mono">{claude?.settingsPath || "~/.claude/settings.json"}</span>
                  <span className="font-semibold text-text-main">Endpoint</span>
                  <span className="truncate font-mono">{claude?.suggestedBaseUrl || "…"}</span>
                  <span className="font-semibold text-text-main">Key</span>
                  <span className="truncate font-mono">
                    {apiKey ? `${apiKey.name} (${apiKey.key})` : "created for you on setup"}
                  </span>
                  <span className="font-semibold text-text-main">Models</span>
                  <span className="truncate font-mono">
                    {(claude?.models || []).map((model) => model.model).filter(Boolean).join(", ") || "…"}
                  </span>
                </div>
                <div className="mt-4 flex flex-wrap items-center gap-3">
                  <button type="button" className="or-action" disabled={busy} onClick={setupClaudeCode}>
                    {busy ? "Setting up…" : "Setup Claude Code"}
                  </button>
                  {!claude?.installed ? (
                    <span className="text-xs text-text-muted">
                      Claude Code was not found on this machine - the settings are written anyway.
                    </span>
                  ) : null}
                </div>
              </div>
            )}
          </div>
        );

      case "done":
        return (
          <div className="flex h-full flex-col gap-4">
            <SectionTitle hint="Here is what the wizard set up.">You are ready</SectionTitle>
            <div className="grid gap-2 sm:grid-cols-2">
              {[
                { done: true, label: "Theme", value: theme },
                { done: Boolean(imported), label: "Migrated", value: imported?.source?.label || "skipped" },
                { done: connected.length > 0, label: "Providers", value: connected.length ? `${connected.length} connected` : "skipped" },
                { done: Boolean(comboCreated), label: "Combo", value: comboCreated?.name || "skipped" },
                { done: Boolean(apiKey), label: "API key", value: apiKey ? apiKey.name : "skipped" },
                { done: Boolean(claudeDone), label: "Claude Code", value: claudeDone ? "configured" : "skipped" },
              ].map((row) => (
                <div
                  key={row.label}
                  className="flex items-center gap-2 rounded-lg border border-border bg-bg px-3 py-2 text-xs"
                >
                  <span
                    className={`material-symbols-outlined text-sm ${
                      row.done ? "text-primary" : "text-text-subtle"
                    }`}
                  >
                    {row.done ? "check_circle" : "remove_circle_outline"}
                  </span>
                  <span className="font-medium text-text-main">{row.label}</span>
                  <span className="ml-auto truncate text-text-muted">{String(row.value)}</span>
                </div>
              ))}
            </div>
            <div className="flex flex-wrap gap-2">
              <button type="button" className="or-action" onClick={finish}>
                Open the dashboard
              </button>
            </div>
          </div>
        );

      default:
        return null;
    }
  };

  const isLast = stepIndex === steps.length - 1;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/60 backdrop-blur-[3px]" onClick={firstRun ? undefined : onClose} />

      <div
        className="relative flex h-[75vh] w-[75vw] max-h-[980px] max-w-[1500px] flex-col overflow-hidden rounded-2xl border border-border bg-surface shadow-[var(--shadow-elev)]"
        style={{ backgroundColor: "var(--color-surface, var(--color-bg))" }}
      >
        {/* Header */}
        <div className="flex items-center justify-between gap-4 border-b border-border-subtle px-6 py-4">
          <div className="flex items-center gap-3">
            <span className="material-symbols-outlined text-xl text-primary">rocket_launch</span>
            <div>
              <h2 className="text-base font-semibold text-text-main">Get Started with OriginRouter</h2>
              <p className="text-xs text-text-muted">
                Step {stepIndex + 1} of {steps.length} - {step?.hint}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-3">
            <div className="hidden h-1.5 w-40 overflow-hidden rounded-full bg-bg-subtle sm:block">
              <div
                className="h-full rounded-full bg-primary transition-all duration-300"
                style={{ width: `${((stepIndex + 1) / steps.length) * 100}%` }}
              />
            </div>
            {!firstRun ? (
              <button
                type="button"
                onClick={onClose}
                aria-label="Close"
                className="material-symbols-outlined text-lg text-text-muted transition-colors hover:text-text"
              >
                close
              </button>
            ) : null}
          </div>
        </div>

        {/* Body */}
        <div className="flex min-h-0 flex-1">
          {/* Step rail */}
          <nav className="hidden w-60 shrink-0 flex-col gap-1 border-r border-border-subtle p-4 md:flex">
            {steps.map((entry, index) => {
              const active = index === stepIndex;
              const done = index < stepIndex;
              return (
                <button
                  key={entry.id}
                  type="button"
                  onClick={() => setStepIndex(index)}
                  className={`flex items-center gap-3 rounded-xl px-3 py-2.5 text-left transition-colors ${
                    active ? "bg-bg-subtle" : "hover:bg-bg-subtle/60"
                  }`}
                >
                  <StepIcon icon={done ? "check" : entry.icon} active={active} />
                  <span className="flex min-w-0 flex-col">
                    <span
                      className={`truncate text-xs font-semibold ${
                        active ? "text-text-main" : "text-text-muted"
                      }`}
                    >
                      {entry.label}
                      {entry.portable ? (
                        <span className="or-chip ml-2 align-middle">portable</span>
                      ) : null}
                    </span>
                    <span className="truncate text-[11px] text-text-subtle">{entry.hint}</span>
                  </span>
                </button>
              );
            })}
          </nav>

          {/* Step content */}
          <div className="flex min-w-0 flex-1 flex-col overflow-y-auto p-6">
            {renderStep()}

            {notice ? (
              <div className="mt-4 rounded-lg border border-border bg-bg-subtle px-3 py-2 text-xs text-text-muted">
                {notice}
              </div>
            ) : null}
            {error ? (
              <div className="mt-4 rounded-lg border border-primary/40 bg-primary/5 px-3 py-2 text-xs text-primary">
                {error}
              </div>
            ) : null}
          </div>
        </div>

        {/* Footer */}
        <div className="flex flex-wrap items-center gap-3 border-t border-border-subtle px-6 py-4">
          <button
            type="button"
            onClick={skipStep}
            disabled={isLast}
            className="text-xs text-text-muted underline-offset-2 transition-colors hover:text-text hover:underline disabled:opacity-40"
          >
            Skip this
          </button>
          <button
            type="button"
            onClick={skipEverything}
            disabled={isLast}
            className="text-xs text-text-muted underline-offset-2 transition-colors hover:text-text hover:underline disabled:opacity-40"
          >
            Skip setup
          </button>

          <div className="ml-auto flex items-center gap-2">
            <button
              type="button"
              onClick={goBack}
              disabled={stepIndex === 0}
              className="or-action disabled:opacity-40"
            >
              Back
            </button>
            {isLast ? (
              <button type="button" className="or-action" onClick={finish}>
                Finish
              </button>
            ) : (
              <button type="button" className="or-action" onClick={goNext}>
                Next
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
