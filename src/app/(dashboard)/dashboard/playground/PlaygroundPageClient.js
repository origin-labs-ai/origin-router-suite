"use client";

import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/shared/components";
import { getModelsByProviderId } from "@/shared/constants/models";
import {
  ALIAS_TO_ID,
  getProviderAlias,
  isAnthropicCompatibleProvider,
  isOpenAICompatibleProvider,
} from "@/shared/constants/providers";
import { useModelCaps } from "@/shared/hooks/useModelCaps";
import { buildProviderNameMap, resolveProviderLabel } from "@/shared/utils/providerLabel";
import {
  comboDisplayLabel,
  isHiddenModelName,
  prettyModelName as formatModelName,
} from "@/shared/utils/modelDisplayName";
import { parseModelIdentity } from "@/shared/utils/modelIdentity";
import {
  DEFAULT_CONTEXT_WINDOW,
  MAX_CONTEXT_WINDOW,
  contextWindowOptions,
  defaultContextWindow,
  ensureMaxContextWindow,
} from "@/lib/contextLimits";

const EFFORT_LEVELS = [
  { value: "low", label: "Low" },
  { value: "medium", label: "Med" },
  { value: "high", label: "High" },
  { value: "xhigh", label: "Extra High" },
  { value: "max", label: "Max" },
];

const CONTEXT_FILTERS = [
  { value: "0", label: "Any context" },
  { value: "32000", label: "32K and up" },
  { value: "64000", label: "64K and up" },
  { value: "128000", label: "128K and up" },
  { value: "200000", label: "200K and up" },
  { value: "256000", label: "256K and up" },
  { value: "512000", label: "512K and up" },
  { value: "1000000", label: "1M" },
];

const MODEL_PAGE_SIZE = 80;

// Kept outside the component so the React purity lint does not treat event-time
// randomness as render-time work.
function pickRandomVariant(variants) {
  if (!Array.isArray(variants) || variants.length === 0) return null;
  return variants[Math.floor(Math.random() * variants.length)];
}

// Legacy "basic-chat.*" prefixes are kept on purpose: renaming them would drop
// the sessions people already have in localStorage.
const STORAGE_KEYS = {
  sessions: "basic-chat.sessions",
  activeSessionId: "basic-chat.activeSessionId",
  activeProviderId: "basic-chat.activeProviderId",
  activeContextWindow: "basic-chat.activeContextWindow",
  draft: "basic-chat.draft",
};

function createId() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return `chat_${Date.now()}_${Math.random().toString(16).slice(2)}`;
}

function safeParse(value, fallback) {
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function textValue(value) {
  if (typeof value === "string") return value;
  if (value == null) return "";
  if (Array.isArray(value)) return value.map(textValue).filter(Boolean).join(" ");
  if (typeof value === "object") {
    if (typeof value.message === "string") return value.message;
    if (typeof value.error === "string") return value.error;
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }
  return String(value);
}

function humanize(value = "") {
  return String(value)
    .replace(/[-_]/g, " ")
    .replace(/\b\w/g, (char) => char.toUpperCase())
    .trim() || "Unknown";
}

// Playground-facing model name: the shared humanizer turns ids such as
// `claude-fable-5-1` into "Claude Fable 5.1". The provider page keeps raw ids.
function prettyModelName(value = "") {
  return formatModelName(value) || "Unknown model";
}

// Grey-on/grey-off switch used by the reasoning controls inside the model menu.
function ToggleSwitch({ checked, onChange, label }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={() => onChange(!checked)}
      className={`relative h-5 w-9 shrink-0 rounded-full transition-colors ${checked ? "bg-[#2B7FFF]" : "bg-white/15"}`}
    >
      <span
        className={`absolute top-0.5 size-4 rounded-full bg-white shadow transition-all ${checked ? "left-[18px]" : "left-0.5"}`}
      />
    </button>
  );
}

function formatContext(tokens) {
  const n = Number(tokens);
  if (!Number.isFinite(n) || n <= 0) return "—";
  if (n >= 1_000_000) return `${Number((n / 1_000_000).toFixed(n % 1_000_000 ? 1 : 0))}M ctx`;
  if (n >= 1000) return `${Math.round(n / 1000)}K ctx`;
  return `${n} ctx`;
}

function formatRelativeTime(value) {
  if (!value) return "Now";
  const time = new Date(value).getTime();
  if (Number.isNaN(time)) return "Now";
  const diffMinutes = Math.max(1, Math.round((Date.now() - time) / 60000));
  if (diffMinutes < 60) return `${diffMinutes}m`;
  const diffHours = Math.round(diffMinutes / 60);
  if (diffHours < 24) return `${diffHours}h`;
  return `${Math.round(diffHours / 24)}d`;
}

function makeSessionTitle(text = "") {
  const normalized = textValue(text).replace(/\s+/g, " ").trim();
  if (!normalized) return "New chat";
  return normalized.length > 52 ? `${normalized.slice(0, 52).trimEnd()}…` : normalized;
}

function buildUserContent(message) {
  const text = textValue(message.content).trim();
  const attachments = Array.isArray(message.attachments) ? message.attachments : [];

  if (attachments.length === 0) return text;

  const content = [];
  if (text) content.push({ type: "text", text });

  for (const attachment of attachments) {
    if (attachment?.dataUrl) {
      content.push({ type: "image_url", image_url: { url: attachment.dataUrl } });
    }
  }

  return content.length > 0 ? content : text;
}

function readAssistantText(chunk) {
  if (!chunk || typeof chunk !== "object") return "";
  const choice = chunk.choices?.[0];
  const delta = choice?.delta || {};
  const pieces = [delta.content, choice?.message?.content, chunk.output_text, chunk.text]
    .map(textValue)
    .filter(Boolean);
  return pieces[0] || "";
}

async function fileToDataUrl(file) {
  return await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(reader.error || new Error("Failed to read file"));
    reader.readAsDataURL(file);
  });
}

function cloneSession(session) {
  return {
    ...session,
    messages: Array.isArray(session.messages) ? session.messages.map((message) => ({ ...message })) : [],
  };
}

// Rows are grouped per provider, so the group must read as the provider itself:
// the user's node name for custom providers, otherwise the built-in product name.
// The connection name is only an account label ("Account 1", "work key") and must
// never replace the provider identity in this list.
function getProviderLabel(connection, nodeNames) {
  const providerId = connection?.provider || connection?.id;
  return resolveProviderLabel(providerId, { nodeNames, connection });
}

// Routed ids are `<provider-alias>/<model>`. A model id may itself contain a
// vendor namespace (`ag/Anthropic/claude-...`); the prefix is the connection,
// never the vendor. normaliseModel keeps those layers apart for display while
// preserving the exact routed id used on the wire.
function routedModelId(provider, rawId) {
  const alias = getProviderAlias(provider) || provider;
  const value = String(rawId || "").trim();
  if (!value) return "";
  const first = value.split("/")[0]?.toLowerCase();
  if (first && (first === alias.toLowerCase() || first === String(provider).toLowerCase())) return value;
  // Live Gemini lists use resource names (`models/gemini-...`) which are not
  // part of the model id the router forwards.
  const cleaned = /^(models|publishers\/[^/]+\/models)\//.test(value)
    ? value.split("/").pop()
    : value;
  return `${alias}/${cleaned}`;
}

function normaliseModel({ rawId, providedName, providerId, providerName, connectionId, source, contextHint, caps }) {
  if (!rawId || isHiddenModelName(rawId) || isHiddenModelName(providedName)) return null;
  const requestModel = routedModelId(providerId, rawId);
  const identity = parseModelIdentity(rawId, providerId, providerName);
  const named = providedName && providedName !== rawId && !providedName.includes("/")
    ? providedName
    : identity.displayName;
  return {
    id: requestModel,
    requestModel,
    name: named || prettyModelName(identity.model) || rawId,
    providerId,
    providerName: providerName || identity.providerName,
    connectionId: connectionId || "",
    identity,
    source,
    contextHint: Number(contextHint) || 0,
    caps: caps || null,
  };
}

function normalizeStaticModel(model, connection, nodeNames) {
  if (!model?.id) return null;
  return normaliseModel({
    rawId: model.id,
    providedName: model.name,
    providerId: connection.provider,
    providerName: getProviderLabel(connection, nodeNames),
    connectionId: connection.id,
    source: "static",
    contextHint: model.contextLength || model.contextWindow,
  });
}

function normalizeLiveModel(model, connection, nodeNames) {
  const rawId = typeof model === "string" ? model : model?.id || model?.name || model?.model || "";
  if (!rawId) return null;
  const providedName = typeof model === "string" ? null : model?.name || model?.displayName || null;
  return normaliseModel({
    rawId,
    providedName,
    providerId: connection.provider,
    providerName: getProviderLabel(connection, nodeNames),
    connectionId: connection.id,
    source: "live",
    contextHint: model?.contextLength || model?.context_length || model?.contextWindow,
  });
}

function normalizeCustomModel(model, connection, nodeNames) {
  if (!model?.id) return null;
  return normaliseModel({
    rawId: model.id,
    providedName: model.name,
    providerId: connection.provider,
    providerName: getProviderLabel(connection, nodeNames),
    connectionId: connection.id,
    source: "custom",
    contextHint: model.caps?.contextWindow,
    caps: model.caps || null,
  });
}

function modelContextWindow(model, getCaps) {
  // null means "nobody declared anything", which is not the same as "200K". The
  // capability table's 200K is a runtime floor; presenting it as a limit is what
  // produced a list of models that supposedly could not serve 1M. Callers that need
  // a number for a request still fall back through defaultContextWindow().
  if (!model) return null;
  if (model.source === "combo") {
    const declared = Number(model.contextWindow);
    return Number.isFinite(declared) && declared > 0
      ? Math.min(declared, MAX_CONTEXT_WINDOW)
      : null;
  }
  const identity = model.identity || parseModelIdentity(model.requestModel || model.id, model.providerId, model.providerName);
  const capsKey = `${model.providerId}/${identity.model}`;
  const caps = getCaps(capsKey) || getCaps(model.requestModel || model.id) || getCaps(model.id);
  const value = model.contextHint
    || model.caps?.contextWindow
    || caps?.contextWindow
    || model.contextWindow;
  const tokens = Number(value);
  return Number.isFinite(tokens) && tokens > 0 ? Math.min(tokens, MAX_CONTEXT_WINDOW) : null;
}

// Largest declared window in a group. An unknown member wins over any number,
// because a seat nobody declared is not proof that it is small — labelling the
// group by its smallest member is how whole model families got shown as "200K".
function maxDeclaredWindow(variants) {
  let max = 0;
  for (const variant of variants || []) {
    const value = variant?.contextWindow;
    if (value === null || value === undefined) return null;
    if (Number(value) > max) max = Number(value);
  }
  return max || null;
}

// A context filter may only exclude models that are known to be too small.
function passesContextFilter(variant, threshold) {
  if (!threshold) return true;
  const value = variant?.contextWindow;
  if (value === null || value === undefined) return true;
  return Number(value) >= threshold;
}

function parseProviderModelsPayload(data) {
  if (Array.isArray(data?.models)) return data.models;
  if (Array.isArray(data?.data)) return data.data;
  if (Array.isArray(data?.results)) return data.results;
  if (Array.isArray(data)) return data;
  return [];
}

function dedupeModels(models) {
  const map = new Map();
  for (const model of models) {
    if (!model?.id) continue;
    if (!map.has(model.id)) map.set(model.id, model);
  }
  return Array.from(map.values());
}

function variantKey(model) {
  return `${model?.providerId || ""}|${model?.requestModel || model?.id || ""}|${model?.connectionId || ""}`;
}


export default function PlaygroundPageClient({ variant = "full" }) {
  const isClaude = variant === "claude";
  // Claude by Origin keeps its own chat store so the two playgrounds never mix.
  const storageKeys = isClaude
    ? {
      sessions: "claude-origin.sessions",
      activeSessionId: "claude-origin.activeSessionId",
      activeProviderId: "claude-origin.activeProviderId",
      activeContextWindow: "claude-origin.activeContextWindow",
      draft: "claude-origin.draft",
    }
    : STORAGE_KEYS;
  const { getCaps } = useModelCaps();
  const [providerGroups, setProviderGroups] = useState([]);
  const [loadingData, setLoadingData] = useState(true);
  const [loadError, setLoadError] = useState("");
  // Persisted state starts empty on purpose: reading localStorage during the
  // first render makes the server HTML and the client disagree (disabled
  // buttons, message lists). The hydrate effect below fills it in after mount.
  const [sessions, setSessions] = useState([]);
  const [activeSessionId, setActiveSessionId] = useState("");
  const [activeProviderId, setActiveProviderId] = useState("");
  const [activeModelId, setActiveModelId] = useState("");
  const [draft, setDraft] = useState("");
  const [attachments, setAttachments] = useState([]);
  const [isSending, setIsSending] = useState(false);
  const [streamingMessageId, setStreamingMessageId] = useState("");
  const [streamingText, setStreamingText] = useState("");
  const [isHydrated, setIsHydrated] = useState(false);
  const [modelMenuOpen, setModelMenuOpen] = useState(false);
  const [modelSearch, setModelSearch] = useState("");
  const [contextFilter, setContextFilter] = useState("0");
  // Manual picker: Models -> Providers (Random / Select yourself) -> Context.
  const [pickerStep, setPickerStep] = useState("models");
  const [pickerModelKey, setPickerModelKey] = useState("");
  const [pickerVariantKey, setPickerVariantKey] = useState("");
  const [pickerContext, setPickerContext] = useState(DEFAULT_CONTEXT_WINDOW);
  const [visibleModelCount, setVisibleModelCount] = useState(MODEL_PAGE_SIZE);
  const [selectionContextWindow, setSelectionContextWindow] = useState(0);
  const [historyOpen, setHistoryOpen] = useState(false);
  // Inline rename / edit state: id of the row being edited plus its draft text.
  const [renamingSessionId, setRenamingSessionId] = useState("");
  const [renameDraft, setRenameDraft] = useState("");
  const [editingMessageId, setEditingMessageId] = useState("");
  const [editDraft, setEditDraft] = useState("");
  const [copiedMessageId, setCopiedMessageId] = useState("");
  const [desktopHint, setDesktopHint] = useState("");
  // Reasoning controls — sent only when the brain toggle is on, so providers
  // that reject the fields keep working untouched.
  const [effort, setEffort] = useState("high");
  const [thinking, setThinking] = useState(false);
  const [extendedThinking, setExtendedThinking] = useState(false);
  const composerRef = useRef(null);
  const fileInputRef = useRef(null);
  const abortRef = useRef(null);
  const initializedRef = useRef(false);
  const modelMenuRef = useRef(null);
  const historyMenuRef = useRef(null);

  useEffect(() => {
    // Runs before the persist effect (declared later), and that one bails while
    // isHydrated is false, so the saved values cannot be overwritten by empties.
    setIsHydrated(true);
    try {
      const savedSessions = safeParse(globalThis.localStorage.getItem(storageKeys.sessions), []);
      if (Array.isArray(savedSessions)) {
        setSessions(savedSessions.map((session) => ({
          ...session,
          messages: Array.isArray(session.messages) ? session.messages : [],
        })));
      }
      const savedSessionId = globalThis.localStorage.getItem(storageKeys.activeSessionId);
      if (savedSessionId) setActiveSessionId(savedSessionId);
      const savedProviderId = globalThis.localStorage.getItem(storageKeys.activeProviderId);
      if (savedProviderId) setActiveProviderId(savedProviderId);
      const savedContext = Number(globalThis.localStorage.getItem(storageKeys.activeContextWindow));
      if (Number.isFinite(savedContext) && savedContext > 0) setSelectionContextWindow(savedContext);
      const savedDraft = globalThis.localStorage.getItem(storageKeys.draft);
      if (savedDraft) setDraft(savedDraft);
    } catch {
      // Private mode / storage disabled — start clean.
    }
  }, []);

  useEffect(() => {
    let cancelled = false;

    async function loadData() {
      setLoadingData(true);
      setLoadError("");

      try {
        const [providersRes, combosRes, nodesRes, customModelsRes] = await Promise.all([
          fetch("/api/providers", { cache: "no-store" }),
          fetch("/api/combos", { cache: "no-store" }).catch(() => null),
          fetch("/api/provider-nodes", { cache: "no-store" }).catch(() => null),
          fetch("/api/models/custom", { cache: "no-store" }).catch(() => null),
        ]);
        const providersData = await providersRes.json().catch(() => ({}));
        const customModelsData = customModelsRes?.ok
          ? await customModelsRes.json().catch(() => ({}))
          : {};
        const nodesData = nodesRes?.ok ? await nodesRes.json().catch(() => ({})) : {};
        // Custom compatible providers only carry their user-given name here.
        const nodeNames = buildProviderNameMap(nodesData.nodes);
        const connections = Array.isArray(providersData.connections)
          ? providersData.connections.filter((connection) => connection?.isActive !== false)
          : [];

        // Combos are first-class playable targets: the combo id is exactly what
        // the API accepts, so the playground can exercise routing/fallback too.
        const combosData = combosRes?.ok ? await combosRes.json().catch(() => ({})) : {};
        const comboModels = (Array.isArray(combosData.combos) ? combosData.combos : [])
          .filter((combo) => !combo.kind || combo.kind === "llm")
          .map((combo) => ({
            id: combo.name,
            requestModel: combo.name,
            // Playground shows the friendly label; the wire id stays combo.name.
            name: comboDisplayLabel(combo),
            providerId: "combos",
            providerName: "Combos",
            source: "combo",
            contextWindow: Number(combo.maxContextWindow) > 0 ? Number(combo.maxContextWindow) : null,
            modelCount: Array.isArray(combo.models) ? combo.models.length : 0,
          }));

        if (connections.length === 0 && comboModels.length === 0) {
          if (!cancelled) {
            setProviderGroups([]);
            setLoadError("No providers connected yet.");
          }
          return;
        }

        // Claude by Origin only ever offers the Claude combos, and never fans out
        // over every provider — that is the whole point of the dedicated window.
        if (isClaude) {
          const claudeCombos = comboModels
            .filter((model) => model.id.startsWith("claude-"))
            .sort((a, b) => a.name.localeCompare(b.name));
          if (!cancelled) {
            setProviderGroups(claudeCombos.length > 0
              ? [{
                providerId: "combos",
                providerName: "Claude",
                providerType: "combo",
                connections: [],
                models: claudeCombos,
              }]
              : []);
            setLoadError(claudeCombos.length === 0 ? "No claude-* combos found. Create one in Combo & Vision Adapter." : "");
            setLoadingData(false);
          }
          return;
        }

        const providerMap = new Map();

        for (const connection of connections) {
          const providerId = connection.provider || connection.id;
          const providerName = getProviderLabel(connection, nodeNames);
          const providerType = isOpenAICompatibleProvider(providerId)
            ? "openai-compatible"
            : isAnthropicCompatibleProvider(providerId)
              ? "anthropic-compatible"
              : providerId;

          if (!providerMap.has(providerId)) {
            providerMap.set(providerId, {
              providerId,
              providerName,
              providerType,
              connections: [],
              models: [],
            });
          }

          const group = providerMap.get(providerId);
          group.providerName = group.providerName || providerName;
          group.providerType = group.providerType || providerType;
          group.connections.push(connection);

          const staticModels = getModelsByProviderId(providerId)
            .map((model) => normalizeStaticModel(model, connection, nodeNames))
            .filter(Boolean);
          group.models.push(...staticModels);
        }

        // Custom/imported models live in their own KV store, not in the static
        // registry. They are the bulk of a real install (this one has 1,284),
        // so omitting them made the playground look like it only had ~260.
        for (const custom of Array.isArray(customModelsData.models) ? customModelsData.models : []) {
          if (!custom?.id || (custom.kind || custom.type || "llm") !== "llm") continue;
          const providerId = ALIAS_TO_ID[custom.providerAlias] || custom.providerAlias;
          const group = providerMap.get(providerId);
          if (!group) continue;
          const connection = group.connections[0];
          const model = normalizeCustomModel(custom, connection, nodeNames);
          if (model) group.models.push(model);
        }

        const liveResults = await Promise.all(
          connections.map(async (connection) => {
            try {
              // A dead compatible endpoint must not hold the whole picker
              // hostage: one hung request used to keep providerGroups empty,
              // so the page showed "Select model" with no models at all.
              const response = await fetch(`/api/providers/${connection.id}/models`, {
                cache: "no-store",
                signal: AbortSignal.timeout(12000),
              });
              const data = await response.json().catch(() => ({}));
              if (!response.ok) return { connection, models: [] };
              const models = parseProviderModelsPayload(data)
                .map((model) => normalizeLiveModel(model, connection, nodeNames))
                .filter(Boolean);
              return { connection, models };
            } catch {
              return { connection, models: [] };
            }
          })
        );

        for (const result of liveResults) {
          const providerId = result.connection.provider || result.connection.id;
          const group = providerMap.get(providerId);
          if (!group) continue;
          group.models.push(...result.models);
        }

        const normalized = Array.from(providerMap.values())
          .map((group) => ({
            ...group,
            models: dedupeModels(group.models).sort((a, b) => a.name.localeCompare(b.name)),
          }))
          .filter((group) => group.models.length > 0)
          .sort((a, b) => a.providerName.localeCompare(b.providerName));

        // Pin the combo group on top — routing setups are what people test here.
        if (comboModels.length > 0) {
          normalized.unshift({
            providerId: "combos",
            providerName: "Combos",
            providerType: "combo",
            connections: [],
            models: comboModels.sort((a, b) => a.name.localeCompare(b.name)),
          });
        }

        if (!cancelled) {
          setProviderGroups(normalized);
          if (normalized.length === 0) {
            setLoadError("Providers connected but no models available.");
          }
        }
      } catch (error) {
        if (!cancelled) {
          setLoadError(textValue(error?.message) || "Failed to load providers/models.");
          setProviderGroups([]);
        }
      } finally {
        if (!cancelled) setLoadingData(false);
      }
    }

    loadData();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const handleClickOutside = (event) => {
      if (modelMenuRef.current && !modelMenuRef.current.contains(event.target)) {
        setModelMenuOpen(false);
      }
      if (historyMenuRef.current && !historyMenuRef.current.contains(event.target)) {
        setHistoryOpen(false);
      }
    };

    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  // One entry per exact model. Each entry carries every provider connection
  // that serves it, so the picker can offer Random or "select yourself" without
  // duplicating the same model once per provider (which is what the old
  // provider-grouped list did).
  const modelGroups = useMemo(() => {
    const map = new Map();
    for (const group of providerGroups) {
      for (const model of group.models) {
        const isCombo = group.providerId === "combos";
        const identity = model.identity
          || parseModelIdentity(model.requestModel || model.id, group.providerId, group.providerName);
        // Combos are routing targets, not vendor models; keep them out of the
        // exact-model namespace so a combo named after a model cannot merge.
        const key = isCombo ? `combo:${model.id}` : identity.groupKey;
        let entry = map.get(key);
        if (!entry) {
          entry = {
            key,
            name: isCombo ? model.name : identity.categoryName || identity.displayName || model.name,
            vendor: isCombo ? "" : identity.vendor,
            modelId: isCombo ? model.id : identity.model,
            variants: [],
            seen: new Set(),
            providerMap: new Map(),
            isCombo,
          };
          map.set(key, entry);
        } else if (!entry.vendor && identity.vendor) {
          // The first route may lack a vendor namespace; a later one can still
          // provide the category vendor for the subtitle.
          entry.vendor = identity.vendor;
        }

        // Same request id can be listed by the static catalog and a live
        // endpoint; show it once per connection.
        const variantKey = `${group.providerId}|${model.requestModel || model.id}|${model.connectionId || ""}`;
        if (entry.seen.has(variantKey)) continue;
        entry.seen.add(variantKey);

        const contextWindow = modelContextWindow(model, getCaps);
        const variant = {
          ...model,
          // The picker groups by exact model id; the button and session should
          // keep that id's label even when a provider ships a longer alias.
          name: entry.name,
          providerModelName: model.name,
          modelKey: key,
          providerId: group.providerId,
          providerName: group.providerName,
          contextWindow,
        };
        entry.variants.push(variant);

        let provider = entry.providerMap.get(group.providerId);
        if (!provider) {
          provider = {
            providerId: group.providerId,
            providerName: group.providerName,
            variants: [],
          };
          entry.providerMap.set(group.providerId, provider);
        }
        provider.variants.push(variant);
      }
    }

    return Array.from(map.values()).map((entry) => {
      const providers = Array.from(entry.providerMap.values()).map((provider) => ({
        ...provider,
        contextWindow: maxDeclaredWindow(provider.variants),
      }));
      const contextWindow = maxDeclaredWindow(entry.variants);
      return {
        key: entry.key,
        name: entry.name,
        vendor: entry.vendor,
        modelId: entry.modelId,
        isCombo: entry.isCombo,
        variants: entry.variants,
        providers,
        providerNames: providers.map((provider) => provider.providerName),
        contextWindow,
      };
    }).sort((a, b) => {
      // Combos are the first section; exact models follow alphabetically.
      if (a.isCombo !== b.isCombo) return a.isCombo ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
  }, [providerGroups, getCaps]);

  // Search + context are applied to categories, never to a capped slice. The
  // selected window also prunes the provider list, but only on declared numbers: a
  // model nobody ever sized stays available, because "unknown" is not "too small".
  const matchingModelGroups = useMemo(() => {
    const query = modelSearch.trim().toLowerCase();
    const threshold = Number(contextFilter) || 0;
    return modelGroups
      .map((group) => {
        if (!threshold) return group;
        const variants = group.variants.filter((variant) => passesContextFilter(variant, threshold));
        if (variants.length === 0) return null;
        const providers = group.providers
          .map((provider) => {
            const supported = provider.variants.filter((variant) => passesContextFilter(variant, threshold));
            if (supported.length === 0) return null;
            return {
              ...provider,
              variants: supported,
              contextWindow: maxDeclaredWindow(supported),
            };
          })
          .filter(Boolean);
        return {
          ...group,
          variants,
          providers,
          providerNames: providers.map((provider) => provider.providerName),
          contextWindow: maxDeclaredWindow(variants),
        };
      })
      .filter(Boolean)
      .filter((group) => {
        if (!query) return true;
        return `${group.name} ${group.vendor} ${group.modelId} ${group.providerNames.join(" ")}`
          .toLowerCase()
          .includes(query);
      });
  }, [modelGroups, modelSearch, contextFilter]);

  const visibleModelGroups = useMemo(
    () => matchingModelGroups.slice(0, visibleModelCount),
    [matchingModelGroups, visibleModelCount],
  );

  const totalMatchingModels = matchingModelGroups.length;
  const totalMatchingRoutes = useMemo(
    () => matchingModelGroups.reduce((total, group) => total + group.variants.length, 0),
    [matchingModelGroups],
  );

  useEffect(() => {
    // Auto-grow composer: height follows content up to a cap, animated in CSS.
    const element = composerRef.current;
    if (!element) return;
    element.style.height = "auto";
    element.style.height = `${Math.min(element.scrollHeight, 220)}px`;
  }, [draft]);

  const modelIndex = useMemo(() => {
    const map = new Map();
    for (const group of modelGroups) {
      for (const model of group.variants) {
        map.set(model.requestModel || model.id, model);
        // Sessions created before the provider-prefix cleanup stored
        // `antigravity/claude-...` instead of `ag/claude-...`.
        const legacyKey = `${model.providerId}/${model.identity?.model || model.id}`;
        if (!map.has(legacyKey)) map.set(legacyKey, model);
      }
    }
    return map;
  }, [modelGroups]);

  const activeProviderGroup = useMemo(() => {
    return providerGroups.find((group) => group.providerId === activeProviderId) || providerGroups[0] || null;
  }, [providerGroups, activeProviderId]);

  const activeModel = useMemo(() => {
    if (activeModelId && modelIndex.has(activeModelId)) return modelIndex.get(activeModelId);
    if (activeSessionId) {
      const session = sessions.find((item) => item.id === activeSessionId);
      if (session?.modelId && modelIndex.has(session.modelId)) return modelIndex.get(session.modelId);
    }
    return modelGroups[0]?.variants?.[0] || activeProviderGroup?.models?.[0] || null;
  }, [activeModelId, modelIndex, modelGroups, activeProviderGroup, sessions, activeSessionId]);

  const currentSession = useMemo(() => sessions.find((session) => session.id === activeSessionId) || null, [sessions, activeSessionId]);
  const currentMessages = currentSession?.messages || [];
  const sessionItems = useMemo(() => [...sessions].sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()), [sessions]);
  const canSend = !isSending && !!activeModel && (draft.trim().length > 0 || attachments.length > 0);

  useEffect(() => {
    if (!isHydrated) return;
    try {
      globalThis.localStorage.setItem(storageKeys.sessions, JSON.stringify(sessions));
      globalThis.localStorage.setItem(storageKeys.activeSessionId, activeSessionId);
      globalThis.localStorage.setItem(storageKeys.activeProviderId, activeProviderId);
      if (selectionContextWindow > 0) {
        globalThis.localStorage.setItem(storageKeys.activeContextWindow, String(selectionContextWindow));
      }
      globalThis.localStorage.setItem(storageKeys.draft, draft);
    } catch {
      // Ignore storage errors.
    }
  }, [isHydrated, sessions, activeSessionId, activeProviderId, selectionContextWindow, draft]);

  useEffect(() => {
    if (!isHydrated || loadingData || initializedRef.current) return;
    if (providerGroups.length === 0) return;

    const savedProvider = providerGroups.find((group) => group.providerId === activeProviderId) || providerGroups[0];
    const savedModel = activeModelId && modelIndex.has(activeModelId)
      ? modelIndex.get(activeModelId)
      : savedProvider.models[0];

    if (sessions.length > 0) {
      const session = sessions.find((item) => item.id === activeSessionId) || sessions[0];
      const sessionModel = session?.modelId && modelIndex.has(session.modelId)
        ? modelIndex.get(session.modelId)
        : savedModel;
      initializedRef.current = true;
      setActiveSessionId(session.id);
      setActiveProviderId(sessionModel?.providerId || savedProvider.providerId);
      setActiveModelId(sessionModel?.id || savedModel.id);
      setSelectionContextWindow(
        Number(session.contextWindow) > 0
          ? ensureMaxContextWindow(session.contextWindow)
          : defaultContextWindow(sessionModel ? modelContextWindow(sessionModel, getCaps) : DEFAULT_CONTEXT_WINDOW),
      );
      return;
    }

    const session = {
      id: createId(),
      title: "New chat",
      providerId: savedProvider.providerId,
      providerName: savedProvider.providerName,
      modelId: savedModel.id,
      modelName: savedModel.name,
      contextWindow: defaultContextWindow(modelContextWindow(savedModel, getCaps)),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      messages: [],
    };

    // Last-resort guard: a fresh session must never replace stored history. If
    // state is empty but storage is not, adopt the stored sessions instead of
    // overwriting them with this blank one.
    try {
      const stored = safeParse(globalThis.localStorage.getItem(storageKeys.sessions), []);
      if (Array.isArray(stored) && stored.length > 0) {
        const restored = stored.map((item) => ({
          ...item,
          messages: Array.isArray(item.messages) ? item.messages : [],
        }));
        initializedRef.current = true;
        setSessions(restored);
        const restoredActive = restored.find((item) => item.id === activeSessionId) || restored[0];
        setActiveSessionId(restoredActive.id);
        setActiveProviderId(restoredActive.providerId || savedProvider.providerId);
        setActiveModelId(restoredActive.modelId || savedModel.id);
        if (Number(restoredActive.contextWindow) > 0) {
          setSelectionContextWindow(ensureMaxContextWindow(restoredActive.contextWindow));
        }
        return;
      }
    } catch {
      // Storage unavailable — fall through to the blank session.
    }

    initializedRef.current = true;
    setSessions([session]);
    setActiveSessionId(session.id);
    setActiveProviderId(savedProvider.providerId);
    setActiveModelId(savedModel.id);
    setSelectionContextWindow(session.contextWindow);
  }, [isHydrated, loadingData, providerGroups, modelIndex, sessions, activeSessionId, activeProviderId, activeModelId, getCaps]);

  const updateSession = (sessionId, updater) => {
    setSessions((prev) => prev.map((session) => (session.id === sessionId ? updater(cloneSession(session)) : session)));
  };

  const ensureSessionForModel = (model, contextWindow = 0) => {
    if (!model) return null;
    return {
      id: createId(),
      title: "New chat",
      providerId: model.providerId,
      providerName: model.providerName,
      modelId: model.requestModel || model.id,
      modelName: model.name,
      contextWindow: ensureMaxContextWindow(
        contextWindow || defaultContextWindow(modelContextWindow(model, getCaps)),
      ),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      messages: [],
    };
  };

  const handleNewChat = () => {
    // No model picked yet: still create an empty session so the sidebar entry
    // appears, the model gets attached on the first send.
    const session = activeModel
      ? ensureSessionForModel(activeModel, selectionContextWindow)
      : {
        id: createId(),
        title: "New chat",
        providerId: "",
        providerName: "",
        modelId: "",
        modelName: "",
        contextWindow: 0,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        messages: [],
      };
    if (!session) return;
    setSessions((prev) => [session, ...prev]);
    setActiveSessionId(session.id);
    setActiveProviderId(session.providerId);
    setActiveModelId(session.modelId);
    setDraft("");
    setAttachments([]);
    setStreamingMessageId("");
    setStreamingText("");
  };

  const handleSelectSession = (sessionId) => {
    const session = sessions.find((item) => item.id === sessionId);
    if (!session) return;
    setActiveSessionId(sessionId);
    setActiveProviderId(session.providerId || activeProviderId);
    setActiveModelId(session.modelId || activeModelId);
    if (Number(session.contextWindow) > 0) {
      setSelectionContextWindow(ensureMaxContextWindow(session.contextWindow));
    }
    setHistoryOpen(false);
  };

  const handleDeleteSession = (sessionId) => {
    if (!window.confirm("Delete this chat?")) return;
    const nextSessions = sessions.filter((session) => session.id !== sessionId);
    setSessions(nextSessions);
    if (activeSessionId === sessionId) {
      const fallback = nextSessions[0] || null;
      if (fallback) {
        setActiveSessionId(fallback.id);
        setActiveProviderId(fallback.providerId);
        setActiveModelId(fallback.modelId);
        if (Number(fallback.contextWindow) > 0) {
          setSelectionContextWindow(ensureMaxContextWindow(fallback.contextWindow));
        }
      } else {
        setActiveSessionId("");
        setActiveProviderId("");
        setActiveModelId("");
        setSelectionContextWindow(0);
      }
    }
  };

  // "Clear" next to History removes every stored chat, not just the open one.
  const handleClearAllChats = () => {
    if (sessions.length === 0) return;
    if (!window.confirm(`Delete all ${sessions.length} chats? This cannot be undone.`)) return;
    setSessions([]);
    setActiveSessionId("");
    setActiveProviderId("");
    setActiveModelId("");
    setDraft("");
    setAttachments([]);
    setStreamingMessageId("");
    setStreamingText("");
    setHistoryOpen(false);
    try {
      globalThis.localStorage.removeItem(storageKeys.sessions);
      globalThis.localStorage.removeItem(storageKeys.activeSessionId);
      globalThis.localStorage.removeItem(storageKeys.activeProviderId);
      globalThis.localStorage.removeItem(storageKeys.activeContextWindow);
      globalThis.localStorage.removeItem(storageKeys.draft);
    } catch {
      // Storage may be disabled.
    }
  };

  const handleStartRename = (session) => {
    setRenamingSessionId(session.id);
    setRenameDraft(session.title || "");
  };

  const handleCommitRename = () => {
    const title = renameDraft.trim();
    if (!renamingSessionId) return;
    setRenamingSessionId("");
    if (!title) return;
    updateSession(renamingSessionId, (session) => ({
      ...session,
      title,
      updatedAt: new Date().toISOString(),
    }));
  };

  const handleStartEditMessage = (message) => {
    setEditingMessageId(message.id);
    setEditDraft(textValue(message.content));
  };

  // Editing a prompt rewrites history from that point: the old answer and every
  // later turn are dropped, then the edited text is replayed so the model
  // answers the new version. Editing message 1 of 5 leaves 1 + a fresh answer.
  const handleCommitEditMessage = async () => {
    if (!editingMessageId || !activeSessionId) return;
    const nextText = editDraft.trim();
    const messageId = editingMessageId;
    setEditingMessageId("");
    if (!nextText) return;

    const session = sessions.find((item) => item.id === activeSessionId);
    if (!session) return;
    const index = session.messages.findIndex((message) => message.id === messageId);
    if (index === -1) return;

    const editedMessage = {
      ...session.messages[index],
      content: nextText,
      editedAt: new Date().toISOString(),
      status: "done",
    };
    const kept = [...session.messages.slice(0, index), editedMessage];
    await sendMessage({ baseMessages: kept, titleSeed: nextText });
  };

  // Re-answer the last prompt: drop this answer and anything after it, replay.
  const handleRegenerate = async (message) => {
    if (!activeSessionId || isSending) return;
    const session = sessions.find((item) => item.id === activeSessionId);
    if (!session) return;
    const index = session.messages.findIndex((item) => item.id === message.id);
    if (index === -1) return;
    const kept = session.messages.slice(0, index);
    const lastUser = [...kept].reverse().find((item) => item.role === "user");
    if (!lastUser) return;
    await sendMessage({ baseMessages: kept, titleSeed: textValue(lastUser.content) });
  };

  const handleCopyMessage = async (message) => {
    const copyText = textValue(message.content);
    if (!copyText) return;
    try {
      await navigator.clipboard.writeText(copyText);
      setCopiedMessageId(message.id);
      setTimeout(() => setCopiedMessageId(""), 1500);
    } catch {
      // Clipboard blocked — nothing to do.
    }
  };

  // A prompt and its answer are one unit: deleting the user turn also drops the
  // replies that follow it (up to the next user turn), so no orphaned answer is
  // left behind. Deleting an assistant turn only removes that message.
  const handleDeleteMessage = (messageId) => {
    if (!activeSessionId) return;
    updateSession(activeSessionId, (session) => {
      const index = session.messages.findIndex((message) => message.id === messageId);
      if (index === -1) return session;
      const target = session.messages[index];
      let nextMessages;
      if (target.role === "user") {
        let end = index + 1;
        while (end < session.messages.length && session.messages[end].role !== "user") end += 1;
        nextMessages = [...session.messages.slice(0, index), ...session.messages.slice(end)];
      } else {
        nextMessages = session.messages.filter((message) => message.id !== messageId);
      }
      return { ...session, messages: nextMessages, updatedAt: new Date().toISOString() };
    });
  };

  const applyModelSelection = (model, contextWindow) => {
    if (!model) return;
    const window = ensureMaxContextWindow(
      contextWindow || defaultContextWindow(modelContextWindow(model, getCaps)),
    );
    const modelId = model.requestModel || model.id;

    const current = sessions.find((session) => session.id === activeSessionId);
    if (current && current.messages.length > 0) {
      const session = ensureSessionForModel(model, window);
      if (!session) return;
      setSessions((prev) => [session, ...prev]);
      setActiveSessionId(session.id);
    } else if (current) {
      setSessions((prev) => prev.map((item) => (item.id === current.id ? {
        ...item,
        providerId: model.providerId,
        providerName: model.providerName,
        modelId,
        modelName: model.name,
        contextWindow: window,
        updatedAt: new Date().toISOString(),
      } : item)));
      setActiveSessionId(current.id);
    } else {
      const session = ensureSessionForModel(model, window);
      if (!session) return;
      setSessions((prev) => [session, ...prev]);
      setActiveSessionId(session.id);
    }

    setActiveProviderId(model.providerId);
    setActiveModelId(modelId);
    setSelectionContextWindow(window);
    setModelMenuOpen(false);
    setPickerStep("models");
    setPickerModelKey("");
    setPickerVariantKey("");
  };

  const openPicker = () => {
    setPickerStep("models");
    setPickerModelKey("");
    setPickerVariantKey("");
    setVisibleModelCount(MODEL_PAGE_SIZE);
    setModelMenuOpen((value) => !value);
  };

  const handlePickModelGroup = (group) => {
    if (!group) return;
    setPickerModelKey(group.key);
    setPickerVariantKey("");
    if (group.variants.length === 1) {
      const only = group.variants[0];
      setPickerVariantKey(variantKey(only));
      setPickerContext(defaultContextWindow(modelContextWindow(only, getCaps)));
      setPickerStep("context");
      return;
    }
    setPickerStep("providers");
  };

  const handleRandomProvider = (group = null) => {
    const target = group || modelGroups.find((item) => item.key === pickerModelKey);
    if (!target || target.variants.length === 0) return;
    const picked = pickRandomVariant(target.variants);
    setPickerModelKey(target.key);
    setPickerVariantKey(variantKey(picked));
    setPickerContext(defaultContextWindow(modelContextWindow(picked, getCaps)));
    setPickerStep("context");
  };

  const handlePickVariant = (variant) => {
    if (!variant) return;
    setPickerVariantKey(variantKey(variant));
    setPickerContext(defaultContextWindow(modelContextWindow(variant, getCaps)));
    setPickerStep("context");
  };

  const handleAttachFiles = async (event) => {
    const files = Array.from(event.target.files || []);
    if (files.length === 0) return;

    const images = files.filter((file) => file.type.startsWith("image/"));
    if (images.length === 0) {
      event.target.value = "";
      return;
    }

    const converted = await Promise.all(images.map(async (file) => ({
      id: createId(),
      name: file.name,
      type: file.type,
      size: file.size,
      dataUrl: await fileToDataUrl(file),
    })));

    setAttachments((prev) => [...prev, ...converted]);
    event.target.value = "";
  };

  const removeAttachment = (attachmentId) => {
    setAttachments((prev) => prev.filter((attachment) => attachment.id !== attachmentId));
  };

  const handleStop = () => {
    abortRef.current?.abort();
  };

  const finalizeSessionTitle = (sessionId, titleSeed) => {
    const title = makeSessionTitle(titleSeed);
    updateSession(sessionId, (session) => ({
      ...session,
      title: session.title === "New chat" ? title : session.title,
      updatedAt: new Date().toISOString(),
    }));
  };

  // Sends the current draft, or — when `baseMessages` is passed — replays an
  // existing transcript (edit / regenerate). Replays never touch the composer.
  const sendMessage = async ({ baseMessages = null, titleSeed = null } = {}) => {
    const model = activeModel || activeProviderGroup?.models?.[0] || null;
    if (!model) return;

    const isReplay = Array.isArray(baseMessages);
    const userText = isReplay ? textValue(titleSeed || "").trim() : draft.trim();
    if (!isReplay && !userText && attachments.length === 0) return;

    let sessionId = activeSessionId;
    let session = sessions.find((item) => item.id === sessionId);
    if (!session && !isReplay) {
      session = ensureSessionForModel(model);
      if (!session) return;
      sessionId = session.id;
      setSessions((prev) => [session, ...prev]);
      setActiveSessionId(sessionId);
    }
    if (!session) return;

    const userMessage = isReplay ? null : {
      id: createId(),
      role: "user",
      content: userText,
      attachments: attachments.map((attachment) => ({
        id: attachment.id,
        name: attachment.name,
        type: attachment.type,
        dataUrl: attachment.dataUrl,
      })),
      createdAt: new Date().toISOString(),
    };

    const assistantMessageId = createId();
    const assistantMessage = {
      id: assistantMessageId,
      role: "assistant",
      content: "",
      createdAt: new Date().toISOString(),
      status: "streaming",
    };

    const nextMessages = [
      ...(isReplay ? baseMessages : (session.messages || [])),
      ...(userMessage ? [userMessage] : []),
      assistantMessage,
    ];
    setSessions((prev) => prev.map((item) => (item.id === sessionId ? {
      ...item,
      providerId: model.providerId,
      providerName: model.providerName,
      modelId: model.requestModel || model.id,
      modelName: model.name,
      contextWindow: selectionContextWindow || item.contextWindow || 0,
      messages: nextMessages,
      updatedAt: new Date().toISOString(),
      title: item.title === "New chat" && userText ? makeSessionTitle(userText) : item.title,
    } : item)));
    if (!isReplay) {
      setDraft("");
      setAttachments([]);
    }
    setIsSending(true);
    setStreamingMessageId(assistantMessageId);
    setStreamingText("");
    abortRef.current?.abort();
    abortRef.current = new AbortController();

    const requestMessages = nextMessages
      .filter((message) => !(message.role === "assistant" && message.id === assistantMessageId))
      .map((message) => ({
        role: message.role,
        content: message.role === "user" ? buildUserContent(message) : message.content,
      }));

    try {
      const response = await fetch("/api/dashboard/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "text/event-stream",
        },
        body: JSON.stringify({
          model: model.requestModel || model.id,
          messages: requestMessages,
          stream: true,
          // Reasoning is opt-in: only sent when the brain toggle is on.
          ...(thinking ? {
            reasoning_effort: effort,
            thinking: {
              type: "enabled",
              budget_tokens: extendedThinking ? 16000 : 4000,
            },
          } : {}),
        }),
        signal: abortRef.current.signal,
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(textValue(errorData.error || errorData.message || `Request failed (${response.status})`));
      }

      const reader = response.body?.getReader();
      if (!reader) {
        const data = await response.json().catch(() => ({}));
        const fallbackText = textValue(data?.choices?.[0]?.message?.content || data?.output_text || data?.error || data?.message || "");
        updateSession(sessionId, (currentSession) => ({
          ...currentSession,
          messages: currentSession.messages.map((message) => (message.id === assistantMessageId ? { ...message, content: fallbackText, status: "done" } : message)),
          updatedAt: new Date().toISOString(),
        }));
        return;
      }

      const decoder = new TextDecoder();
      let buffer = "";
      let assistantText = "";

      while (true) {
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
            const chunk = JSON.parse(payload);
            const text = readAssistantText(chunk);
            if (!text) continue;

            assistantText += text;
            setStreamingText(assistantText);
            updateSession(sessionId, (currentSession) => ({
              ...currentSession,
              messages: currentSession.messages.map((message) => (message.id === assistantMessageId ? { ...message, content: assistantText, status: "streaming" } : message)),
              updatedAt: new Date().toISOString(),
            }));
          } catch {
            // Ignore malformed chunks.
          }
        }
      }

      updateSession(sessionId, (currentSession) => ({
        ...currentSession,
        messages: currentSession.messages.map((message) => (message.id === assistantMessageId ? { ...message, content: assistantText || message.content, status: "done" } : message)),
        updatedAt: new Date().toISOString(),
      }));
      finalizeSessionTitle(sessionId, userText);
    } catch (error) {
      if (error.name !== "AbortError") {
        const errorText = textValue(error?.message || error);
        updateSession(sessionId, (currentSession) => ({
          ...currentSession,
          messages: currentSession.messages.map((message) => (message.id === assistantMessageId ? { ...message, content: message.content || `Error: ${errorText}`, status: "error" } : message)),
          updatedAt: new Date().toISOString(),
        }));
        setLoadError(errorText || "Failed to send message.");
      }
    } finally {
      setIsSending(false);
      setStreamingMessageId("");
      setStreamingText("");
      abortRef.current = null;
    }
  };

  const handleKeyDown = (event) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      if (canSend) sendMessage();
    }
  };

  const handleOpenDesktop = () => {
    // Custom protocol registered by the Electron build; if nothing handles it the
    // browser just stays put, so we surface a download hint after a moment.
    setDesktopHint("Opening Claude by Origin…");
    window.location.href = "claude-origin://open";
    setTimeout(() => {
      setDesktopHint("Desktop app not installed — grab it from the releases page.");
    }, 1600);
  };

  const modelLabel = activeModel ? `${activeModel.name}` : "Select model";
  // Unknown window: no upper bound to clamp against (Infinity), not a silent 200K.
  const declaredMaxWindow = activeModel ? modelContextWindow(activeModel, getCaps) : null;
  const activeMaxContextWindow = declaredMaxWindow || Number.POSITIVE_INFINITY;
  const activeContextWindow = selectionContextWindow > 0
    ? Math.min(selectionContextWindow, activeMaxContextWindow)
    : defaultContextWindow(declaredMaxWindow);
  const modelSubLabel = activeModel
    ? `${activeModel.providerName} · ${formatContext(activeContextWindow)}`
    : "Choose an exact model";

  const pickerModel = pickerModelKey
    ? (Number(contextFilter)
      ? matchingModelGroups.find((group) => group.key === pickerModelKey)
      : modelGroups.find((group) => group.key === pickerModelKey)) || null
    : null;
  const pickerVariant = pickerModel && pickerVariantKey
    ? pickerModel.variants.find((variant) => variantKey(variant) === pickerVariantKey) || null
    : null;
  const pickerMaxWindow = pickerVariant
    ? modelContextWindow(pickerVariant, getCaps)
    : pickerModel
      ? pickerModel.contextWindow
      : null;
  const pickerOptions = contextWindowOptions(pickerMaxWindow);
  const pickerDefaultWindow = defaultContextWindow(pickerMaxWindow);
  const pickerSelectedWindow = pickerOptions.includes(pickerContext)
    ? pickerContext
    : pickerDefaultWindow;

  const pickerBack = () => {
    if (pickerStep === "context") {
      setPickerStep(pickerModel && pickerModel.variants.length > 1 ? "providers" : "models");
      return;
    }
    setPickerStep("models");
    setPickerVariantKey("");
  };

  return (
    <div className="flex h-full min-h-0 w-full">
      {isClaude ? (
        <aside className="hidden w-64 shrink-0 flex-col gap-2 border-r border-white/10 bg-[#171717] p-3 md:flex">
          <div className="flex items-center gap-2 px-1 pb-1">
            <img src="/brand/origin-mark-256.png" alt="" className="size-7 rounded-md ring-1 ring-white/10" />
            <span className="text-sm font-semibold text-white">
              Claude <span className="font-normal text-white/40">by Origin</span>
            </span>
          </div>
          <button
            type="button"
            onClick={handleNewChat}
            className="mb-1 flex items-center justify-center gap-1.5 rounded-xl border border-white/10 bg-white/5 py-2 text-xs font-medium text-white/80 transition hover:bg-white/10"
          >
            <span className="material-symbols-outlined text-[16px]">add</span>
            New chat
          </button>
          <div className="min-h-0 flex-1 space-y-1 overflow-y-auto custom-scrollbar">
            {sessionItems.map((session) => (
              <button
                key={session.id}
                type="button"
                onClick={() => handleSelectSession(session.id)}
                className={`w-full truncate rounded-lg px-2 py-1.5 text-left text-xs transition ${
                  session.id === activeSessionId
                    ? "bg-white/10 text-white"
                    : "text-white/55 hover:bg-white/5 hover:text-white/85"
                }`}
                title={session.title}
              >
                {session.title}
              </button>
            ))}
            {sessionItems.length === 0 ? (
              <p className="px-2 py-4 text-center text-[11px] text-white/30">No chats yet</p>
            ) : null}
          </div>
          <button
            type="button"
            onClick={handleOpenDesktop}
            className="mt-1 flex items-center justify-center gap-1.5 rounded-xl border border-white/10 bg-white/[0.04] py-2 text-[11px] font-medium text-white/70 transition hover:bg-white/10 hover:text-white"
            title="Open the Claude by Origin desktop app"
          >
            <span className="material-symbols-outlined text-[14px]">desktop_windows</span>
            Open Claude by Origin
          </button>
          {desktopHint ? (
            <p className="px-1 text-center text-[10px] leading-4 text-white/40">{desktopHint}</p>
          ) : null}
          <a
            href="/dashboard/playground"
            className="mt-1 flex items-center justify-center gap-1.5 rounded-xl border border-white/10 py-2 text-[11px] text-white/50 transition hover:bg-white/5 hover:text-white"
          >
            <span className="material-symbols-outlined text-[14px]">dashboard</span>
            Full playground
          </a>
        </aside>
      ) : null}
      <div className="relative flex-1 flex flex-col h-full min-h-0 min-w-0 bg-[#212121] text-white overflow-hidden">
        <div className="relative mx-auto flex flex-1 h-full min-h-0 w-full max-w-4xl flex-col">
        <div className="flex shrink-0 items-center justify-between gap-3 px-4 py-3 lg:px-6">
          <div ref={modelMenuRef} className="relative">
            <button
              type="button"
              onClick={openPicker}
              data-testid="model-picker-trigger"
              className="flex max-w-full items-center gap-2 rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-left transition hover:bg-white/8"
            >
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <span className="truncate text-xs font-semibold text-white">{modelLabel}</span>
                  <span className="material-symbols-outlined shrink-0 text-[18px] text-white/70">expand_more</span>
                </div>
                <p className="mt-0.5 truncate text-[10px] text-white/45">{modelSubLabel}</p>
              </div>
            </button>

            {modelMenuOpen ? (
              <div data-testid="model-picker-menu" className="absolute left-0 top-[calc(100%+8px)] z-30 w-[min(560px,calc(100vw-2rem))] overflow-hidden rounded-xl border border-white/10 bg-[#262626] shadow-2xl shadow-black/50">
                <div className="border-b border-white/10 px-3 py-2.5">
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex min-w-0 items-center gap-2">
                      {pickerStep !== "models" ? (
                        <button
                          type="button"
                          onClick={pickerBack}
                          className="rounded-lg border border-white/10 p-1 text-white/60 transition hover:bg-white/10 hover:text-white"
                          title="Back"
                        >
                          <span className="material-symbols-outlined text-[16px]">arrow_back</span>
                        </button>
                      ) : null}
                      <div className="min-w-0">
                        <p className="text-xs uppercase tracking-[0.22em] text-white/45">
                          {pickerStep === "models" ? "Exact models" : pickerStep === "providers" ? "Choose provider" : "Context window"}
                        </p>
                        <p className="truncate text-[11px] text-white/45">
                          {pickerStep === "models"
                            ? `Total ${totalMatchingRoutes.toLocaleString()} models · ${totalMatchingModels.toLocaleString()} categories`
                            : pickerModel?.name || ""}
                        </p>
                      </div>
                    </div>
                    {pickerStep === "models" ? (
                      <span className="shrink-0 text-[10px] text-white/35">{totalMatchingModels.toLocaleString()} shown</span>
                    ) : null}
                  </div>

                  {pickerStep === "models" ? (
                    <>
                      <div className="relative mt-2">
                        <span className="material-symbols-outlined absolute left-3 top-1/2 -translate-y-1/2 text-[16px] text-white/40">search</span>
                        <input
                          data-testid="model-search"
                          value={modelSearch}
                          onChange={(event) => {
                            setModelSearch(event.target.value);
                            setVisibleModelCount(MODEL_PAGE_SIZE);
                          }}
                          placeholder="Search exact models, vendors or providers…"
                          className="w-full rounded-xl border border-white/10 bg-black/30 py-2 pl-9 pr-8 text-sm text-white placeholder-white/35 outline-none transition focus:border-[#2B7FFF]/40"
                        />
                        {modelSearch ? (
                          <button
                            type="button"
                            onClick={() => {
                              setModelSearch("");
                              setVisibleModelCount(MODEL_PAGE_SIZE);
                            }}
                            className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-1 text-white/50 hover:text-white"
                            title="Clear search"
                          >
                            <span className="material-symbols-outlined text-[16px]">close</span>
                          </button>
                        ) : null}
                      </div>
                      <div className="mt-2 flex items-center justify-between gap-2">
                        <span className="text-[11px] text-white/45">Context window</span>
                        <select
                          data-testid="context-filter"
                          value={contextFilter}
                          onChange={(event) => {
                            setContextFilter(event.target.value);
                            setVisibleModelCount(MODEL_PAGE_SIZE);
                          }}
                          className="rounded-lg border border-white/10 bg-black/30 px-2 py-1 text-[11px] text-white outline-none focus:border-[#2B7FFF]/40"
                          aria-label="Context window filter"
                        >
                          {CONTEXT_FILTERS.map((option) => (
                            <option key={option.value} value={option.value} className="text-black">
                              {option.label}
                            </option>
                          ))}
                        </select>
                      </div>
                    </>
                  ) : null}
                </div>
                <div className="max-h-[60vh] overflow-y-auto p-2 custom-scrollbar">
                  {pickerStep === "models" ? (
                    matchingModelGroups.length === 0 ? (
                      <p className="px-3 py-6 text-center text-sm text-white/50">
                        {loadingData
                          ? "Loading models…"
                          : modelSearch
                            ? <>No models match &ldquo;{modelSearch}&rdquo;.</>
                            : "No models available yet."}
                      </p>
                    ) : (
                      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                        {visibleModelGroups.map((group, index) => {
                          const previous = visibleModelGroups[index - 1];
                          const showComboHeader = group.isCombo && !previous?.isCombo;
                          const showModelHeader = !group.isCombo && (!previous || previous.isCombo);
                          const isActive = !!activeModel
                            && group.variants.some((variant) => (variant.requestModel || variant.id) === (activeModel.requestModel || activeModel.id));
                          const providerSummary = group.providerNames.join(", ");
                          const vendorDiffers = group.vendor
                            && !group.providerNames.some((name) => name.toLowerCase().includes(group.vendor.toLowerCase()));
                          return (
                            <Fragment key={group.key}>
                              {showComboHeader ? (
                                <div className="col-span-full flex items-center gap-2 px-1 pt-1 pb-0.5 text-[10px] uppercase tracking-[0.2em] text-white/35">
                                  <span className="material-symbols-outlined text-[14px] text-[#5a9eff]">layers</span>
                                  Combos
                                </div>
                              ) : null}
                              {showModelHeader ? (
                                <div className="col-span-full flex items-center gap-2 px-1 pt-1 pb-0.5 text-[10px] uppercase tracking-[0.2em] text-white/35">
                                  <span className="h-px flex-1 bg-white/10" />
                                  Model categories
                                  <span className="h-px flex-1 bg-white/10" />
                                </div>
                              ) : null}
                              <button
                                type="button"
                                data-testid="model-group"
                                data-model={group.name}
                                data-vendor={group.vendor}
                                data-provider-count={group.providers.length}
                                data-context={group.contextWindow}
                                onClick={() => handlePickModelGroup(group)}
                                className={`min-h-[58px] w-full rounded-xl border px-3 py-2.5 text-left transition ${isActive ? "border-[#2B7FFF]/40 bg-[#2B7FFF]/15" : "border-white/10 bg-white/5 hover:bg-white/8"}`}
                              >
                                <div className="flex items-start justify-between gap-3">
                                  <div className="min-w-0">
                                    <p className="truncate text-[13px] font-medium text-white">
                                      {group.isCombo ? (
                                        <span className="material-symbols-outlined mr-1 align-[-3px] text-[15px] text-[#5a9eff]">layers</span>
                                      ) : null}
                                      {group.name}
                                    </p>
                                    <p className="truncate text-[11px] text-white/45">
                                      {vendorDiffers ? `${group.vendor} · ` : ""}{providerSummary}
                                    </p>
                                  </div>
                                  <div className="shrink-0 text-right">
                                    <p className="text-[10px] font-medium text-white/60">{formatContext(group.contextWindow)}</p>
                                    <p className="text-[10px] text-white/35">
                                      {group.providers.length} provider{group.providers.length === 1 ? "" : "s"}
                                    </p>
                                  </div>
                                </div>
                              </button>
                            </Fragment>
                          );
                        })}
                        {matchingModelGroups.length > visibleModelGroups.length ? (
                          <button
                            type="button"
                            onClick={() => setVisibleModelCount((count) => count + MODEL_PAGE_SIZE)}
                            className="col-span-full mt-1 w-full rounded-lg border border-white/10 py-1.5 text-[11px] text-white/55 transition hover:bg-white/5 hover:text-white"
                          >
                            Show {Math.min(MODEL_PAGE_SIZE, matchingModelGroups.length - visibleModelGroups.length)} more · {matchingModelGroups.length - visibleModelGroups.length} left
                          </button>
                        ) : null}
                      </div>
                    )
                  ) : pickerStep === "providers" && pickerModel ? (
                    <div>
                      <div className="mb-2 rounded-xl border border-white/10 bg-black/20 p-3">
                        <p className="truncate text-sm font-semibold text-white">{pickerModel.name}</p>
                        <p className="mt-0.5 truncate text-[11px] text-white/45">
                          {pickerModel.vendor ? `${pickerModel.vendor} · ` : ""}{pickerModel.variants.length} route{pickerModel.variants.length === 1 ? "" : "s"} · up to {formatContext(pickerModel.contextWindow)}
                        </p>
                      </div>

                      <button
                        type="button"
                        data-testid="random-provider"
                        onClick={() => handleRandomProvider(pickerModel)}
                        className="mb-3 flex w-full items-center gap-3 rounded-xl border border-[#2B7FFF]/40 bg-[#2B7FFF]/15 px-3 py-2.5 text-left transition hover:bg-[#2B7FFF]/25"
                      >
                        <span className="material-symbols-outlined text-[18px] text-[#5a9eff]">shuffle</span>
                        <div className="min-w-0">
                          <p className="text-sm font-medium text-white">Random provider</p>
                          <p className="text-[11px] text-white/45">Picks any connected provider and account for this model</p>
                        </div>
                      </button>

                      <p className="px-1 pb-1 text-[10px] uppercase tracking-[0.18em] text-white/35">Select yourself</p>
                      {pickerModel.providers.map((provider) => (
                        <button
                          key={provider.providerId}
                          type="button"
                          data-testid="provider-option"
                          data-provider={provider.providerName}
                          onClick={() => handlePickVariant(provider.variants[0])}
                          className="mb-1.5 flex w-full items-center justify-between gap-3 rounded-xl border border-white/10 bg-white/5 px-3 py-2.5 text-left transition hover:bg-white/8"
                        >
                          <div className="min-w-0">
                            <p className="truncate text-sm font-medium text-white">{provider.providerName}</p>
                            <p className="text-[11px] text-white/45">
                              {provider.variants.length} route{provider.variants.length === 1 ? "" : "s"} · {formatContext(provider.contextWindow)}
                            </p>
                          </div>
                          <span className="material-symbols-outlined shrink-0 text-[18px] text-white/35">chevron_right</span>
                        </button>
                      ))}
                    </div>
                  ) : pickerStep === "context" && pickerVariant ? (
                    <div>
                      <div className="mb-2 rounded-xl border border-white/10 bg-black/20 p-3">
                        <p className="truncate text-sm font-semibold text-white">{pickerModel?.name || pickerVariant.name}</p>
                        <p className="mt-0.5 truncate text-[11px] text-white/45">
                          {pickerVariant.providerName} · max {formatContext(pickerMaxWindow)}
                        </p>
                      </div>

                      <p className="px-1 pb-1 text-[10px] uppercase tracking-[0.18em] text-white/35">Context window</p>
                      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                        {pickerOptions.map((value) => (
                          <button
                            key={value}
                            type="button"
                            data-testid="context-option"
                            data-value={value}
                            onClick={() => setPickerContext(value)}
                            className={`rounded-xl border px-2 py-2 text-center text-xs transition ${pickerSelectedWindow === value ? "border-[#2B7FFF]/60 bg-[#2B7FFF]/20 text-white" : "border-white/10 bg-white/5 text-white/70 hover:bg-white/10"}`}
                          >
                            {formatContext(value)}
                            {value === pickerDefaultWindow ? (
                              <span className="mt-0.5 block text-[9px] font-normal text-white/40">default</span>
                            ) : null}
                          </button>
                        ))}
                      </div>
                      <p className="mt-2 px-1 text-[10px] leading-4 text-white/40">
                        Default {formatContext(pickerDefaultWindow)}. Skip keeps the default.
                      </p>

                      <div className="mt-3 flex flex-wrap items-center justify-end gap-2">
                        <button
                          type="button"
                          data-testid="skip-context"
                          onClick={() => applyModelSelection(pickerVariant, pickerDefaultWindow)}
                          className="rounded-lg border border-white/10 px-3 py-1.5 text-[11px] text-white/55 transition hover:bg-white/5 hover:text-white"
                        >
                          Skip · keep {formatContext(pickerDefaultWindow)}
                        </button>
                        <button
                          type="button"
                          data-testid="apply-context"
                          onClick={() => applyModelSelection(pickerVariant, pickerSelectedWindow)}
                          className="rounded-lg bg-[#2B7FFF] px-3 py-1.5 text-[11px] font-semibold text-white transition hover:bg-[#1f6fe8]"
                        >
                          Use {formatContext(pickerSelectedWindow)}
                        </button>
                      </div>
                    </div>
                  ) : null}
                </div>
                <div className="border-t border-white/10 px-4 py-3">
                  <p className="text-xs uppercase tracking-[0.22em] text-white/45">Reasoning</p>
                  <div className="mt-2 space-y-2">
                    <div className="flex items-center justify-between gap-3">
                      <div className="min-w-0">
                        <p className="text-sm text-white">Thinking</p>
                        <p className="text-[11px] text-white/40">Send the effort level and a 4K thinking budget</p>
                      </div>
                      <ToggleSwitch
                        checked={thinking}
                        label="Thinking"
                        onChange={(next) => {
                          setThinking(next);
                          if (!next) setExtendedThinking(false);
                        }}
                      />
                    </div>
                    <div className="flex items-center justify-between gap-3">
                      <div className="min-w-0">
                        <p className="text-sm text-white">Extended thinking</p>
                        <p className="text-[11px] text-white/40">Raise the thinking budget to 16K</p>
                      </div>
                      <ToggleSwitch
                        checked={extendedThinking}
                        label="Extended thinking"
                        onChange={(next) => {
                          setExtendedThinking(next);
                          if (next) setThinking(true);
                        }}
                      />
                    </div>
                  </div>
                </div>
              </div>
            ) : null}
          </div>

          {/* Header actions */}
          <div className="flex items-center gap-2">
            <a
              href={isClaude ? "/dashboard/playground" : "/playground"}
              target="_blank"
              rel="noreferrer"
              className="flex size-9 items-center justify-center rounded-xl border border-white/10 bg-white/5 text-white/70 transition hover:bg-white/10 hover:text-white"
              title="Open playground in a new window"
            >
              <span className="material-symbols-outlined text-[18px]">open_in_new</span>
            </a>
            <button
              type="button"
              onClick={() => setHistoryOpen((value) => !value)}
              className="rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-xs text-white/80 transition hover:bg-white/8"
            >
              History
            </button>
            <Button variant="ghost" size="sm" icon="delete" onClick={handleClearAllChats} disabled={sessions.length === 0}>
              Clear all
            </Button>
          </div>
        </div>

        {historyOpen ? (
          <div ref={historyMenuRef} className="absolute right-4 top-[64px] z-20 w-[min(360px,calc(100vw-2rem))] rounded-xl border border-white/10 bg-[#262626] p-2 shadow-2xl shadow-black/50 lg:right-6">
            <div className="px-3 py-2">
              <p className="text-xs uppercase tracking-[0.22em] text-white/45">Recent chats</p>
            </div>
            <div className="max-h-[48vh] space-y-2 overflow-y-auto p-1 custom-scrollbar">
              {sessionItems.length === 0 ? (
                <div className="rounded-[16px] border border-dashed border-white/10 bg-white/5 p-4 text-sm text-white/55">
                  No conversations yet.
                </div>
              ) : sessionItems.map((session) => {
                const isActive = session.id === activeSessionId;
                const isRenaming = renamingSessionId === session.id;
                const latestMessage = [...(session.messages || [])].reverse().find((message) => message.role === "user") || session.messages?.[0];
                return (
                  <div
                    key={session.id}
                    className={`group w-full rounded-xl border px-3 py-2 transition ${isActive ? "border-[#2B7FFF]/40 bg-[#2B7FFF]/15" : "border-white/10 bg-white/5 hover:bg-white/8"}`}
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div
                        role="button"
                        tabIndex={0}
                        onClick={() => handleSelectSession(session.id)}
                        onKeyDown={(event) => {
                          if (event.key === "Enter") handleSelectSession(session.id);
                        }}
                        className="min-w-0 flex-1 cursor-pointer text-left"
                      >
                        {isRenaming ? (
                          <input
                            autoFocus
                            value={renameDraft}
                            onChange={(event) => setRenameDraft(event.target.value)}
                            onClick={(event) => event.stopPropagation()}
                            onKeyDown={(event) => {
                              // The row underneath also listens for Enter; without
                              // this the whole History panel closes on save.
                              event.stopPropagation();
                              if (event.key === "Enter") handleCommitRename();
                              if (event.key === "Escape") setRenamingSessionId("");
                            }}
                            onBlur={handleCommitRename}
                            maxLength={120}
                            className="w-full rounded-lg border border-white/20 bg-black/30 px-2 py-1 text-sm text-white outline-none focus:border-[#2B7FFF]/60"
                          />
                        ) : (
                          <p className="truncate text-sm font-medium text-white">{session.title}</p>
                        )}
                        <p className="mt-1 truncate text-xs text-white/50">{textValue(latestMessage?.content) || "Empty chat"}</p>
                      </div>
                      <div className="flex shrink-0 items-start gap-1">
                        <span className="text-[10px] text-white/40">{formatRelativeTime(session.updatedAt)}</span>
                        <button
                          type="button"
                          onMouseDown={(event) => event.preventDefault()}
                          onClick={() => (isRenaming ? handleCommitRename() : handleStartRename(session))}
                          className="rounded p-1 text-white/40 opacity-0 transition hover:bg-white/10 hover:text-white group-hover:opacity-100"
                          title={isRenaming ? "Save name" : "Rename chat"}
                        >
                          <span className="material-symbols-outlined text-[15px]">{isRenaming ? "check" : "edit"}</span>
                        </button>
                        <button
                          type="button"
                          onMouseDown={(event) => event.preventDefault()}
                          onClick={() => handleDeleteSession(session.id)}
                          className="rounded p-1 text-white/40 opacity-0 transition hover:bg-rose-500/15 hover:text-rose-300 group-hover:opacity-100"
                          title="Delete chat"
                        >
                          <span className="material-symbols-outlined text-[15px]">delete</span>
                        </button>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        ) : null}

        {loadError ? (
          <div className="mt-4 rounded-[18px] border border-rose-500/20 bg-rose-500/10 px-4 py-3 text-rose-100">
            <div className="flex items-start gap-3">
              <span className="material-symbols-outlined text-[20px]">error</span>
              <p className="text-sm leading-6">{loadError}</p>
            </div>
          </div>
        ) : null}

        <div className="flex flex-1 flex-col min-h-0">
          <div className="flex-1 overflow-y-auto py-4 custom-scrollbar">
            {currentMessages.length === 0 ? (
              <div className="flex min-h-[50vh] items-center justify-center px-4 text-center">
                <div className="max-w-xl space-y-4">
                  <div className="mx-auto flex size-16 items-center justify-center rounded-[20px] border border-white/10 bg-white/5 text-white/80">
                    <span className="material-symbols-outlined text-[30px]">chat</span>
                  </div>
                  <div className="space-y-2">
                    <h2 className="text-2xl font-semibold text-white">Start a conversation</h2>
                    <p className="text-sm leading-6 text-white/60">
                      Simple chat interface to interact with any AI model from connected providers. Select a model and start chatting!
                    </p>
                  </div>
                </div>
              </div>
            ) : null}

            <div className="mx-auto flex w-full max-w-3xl flex-col gap-4 px-4">
              {currentMessages.map((message) => {
                const isUser = message.role === "user";
                const isAssistant = message.role === "assistant";
                const isStreaming = isAssistant && message.id === streamingMessageId && message.status === "streaming";
                const content = textValue(message.content) || (isAssistant ? streamingText : "");
                const isEditing = editingMessageId === message.id;

                return (
                  <div key={message.id} className={`group flex w-full ${isUser ? "justify-end" : "justify-start"} mb-6`}>
                    <div className="flex max-w-[min(88%,42rem)] flex-col items-stretch">
                      <div className={`${isUser ? "rounded-xl bg-[#173E76] px-4 py-2.5 text-white" : "text-white/90"}`}>
                        {message.editedAt && isUser ? (
                          <span className="mb-1 block text-[10px] font-medium text-white/40">edited</span>
                        ) : null}

                        {message.attachments?.length ? (
                          <div className="mb-3 grid grid-cols-2 gap-2 sm:grid-cols-3 mt-2">
                            {message.attachments.map((attachment) => (
                              <a key={attachment.id} href={attachment.dataUrl} target="_blank" rel="noreferrer" className="overflow-hidden rounded-[18px] border border-white/10 bg-black/20">
                                <img src={attachment.dataUrl} alt={attachment.name} className="h-28 w-full object-cover" loading="lazy" decoding="async" />
                              </a>
                            ))}
                          </div>
                        ) : null}

                        {isEditing ? (
                          <div className="space-y-2">
                            <textarea
                              autoFocus
                              value={editDraft}
                              onChange={(event) => setEditDraft(event.target.value)}
                              onKeyDown={(event) => {
                                if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) handleCommitEditMessage();
                                if (event.key === "Escape") setEditingMessageId("");
                              }}
                              rows={Math.min(12, Math.max(2, editDraft.split("\n").length + 1))}
                              className="w-full resize-none rounded-xl border border-white/20 bg-black/30 px-3 py-2 text-[15px] leading-7 text-white outline-none focus:border-[#2B7FFF]/60"
                            />
                            <div className="flex items-center justify-end gap-2">
                              <button
                                type="button"
                                onClick={() => setEditingMessageId("")}
                                className="rounded-lg px-3 py-1.5 text-xs text-white/60 transition hover:bg-white/10 hover:text-white"
                              >
                                Cancel
                              </button>
                              <button
                                type="button"
                                onClick={handleCommitEditMessage}
                                className="rounded-lg bg-white/90 px-3 py-1.5 text-xs font-semibold text-black transition hover:bg-white"
                              >
                                Save
                              </button>
                            </div>
                          </div>
                        ) : (
                          <div className="whitespace-pre-wrap break-words text-[15px] leading-7">
                            {content}
                            {isAssistant && isStreaming && !streamingText ? <span className="inline-block animate-pulse">▋</span> : null}
                          </div>
                        )}
                      </div>

                      {/* Per-message actions: always shown on touch, hover on desktop */}
                      {!isStreaming && !isEditing ? (
                        <div className={`mt-1 flex items-center gap-1 opacity-100 transition sm:opacity-0 sm:group-hover:opacity-100 sm:focus-within:opacity-100 ${isUser ? "justify-end" : "justify-start"}`}>
                          {isUser ? (
                            <button
                              type="button"
                              onClick={() => handleStartEditMessage(message)}
                              className="rounded-lg p-1.5 text-white/40 transition hover:bg-white/10 hover:text-white"
                              title="Edit message (rewrites the chat from here)"
                            >
                              <span className="material-symbols-outlined text-[15px]">edit</span>
                            </button>
                          ) : (
                            <button
                              type="button"
                              onClick={() => handleRegenerate(message)}
                              disabled={isSending}
                              className="rounded-lg p-1.5 text-white/40 transition hover:bg-white/10 hover:text-white disabled:cursor-not-allowed disabled:opacity-30"
                              title="Regenerate answer"
                            >
                              <span className="material-symbols-outlined text-[15px]">refresh</span>
                            </button>
                          )}
                          <button
                            type="button"
                            onClick={() => handleCopyMessage(message)}
                            className="rounded-lg p-1.5 text-white/40 transition hover:bg-white/10 hover:text-white"
                            title={copiedMessageId === message.id ? "Copied" : "Copy message"}
                          >
                            <span className="material-symbols-outlined text-[15px]">
                              {copiedMessageId === message.id ? "check" : "content_copy"}
                            </span>
                          </button>
                          <button
                            type="button"
                            onClick={() => handleDeleteMessage(message.id)}
                            className="rounded-lg p-1.5 text-white/40 transition hover:bg-rose-500/15 hover:text-rose-300"
                            title={isUser ? "Delete message (removes its reply too)" : "Delete message"}
                          >
                            <span className="material-symbols-outlined text-[15px]">delete</span>
                          </button>
                        </div>
                      ) : null}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          <div className="shrink-0 pt-2">
            {attachments.length > 0 ? (
              <div className="mx-auto mb-3 flex w-full max-w-3xl flex-wrap gap-2 px-4">
                {attachments.map((attachment) => (
                  <div key={attachment.id} className="flex items-center gap-2 rounded-full border border-white/10 bg-white/5 px-3 py-2">
                    <span className="text-xs text-white/80 max-w-[12rem] truncate">{attachment.name}</span>
                    <button type="button" onClick={() => removeAttachment(attachment.id)} className="text-white/55 hover:text-white" aria-label="Remove attachment">
                      <span className="material-symbols-outlined text-[18px]">close</span>
                    </button>
                  </div>
                ))}
              </div>
            ) : null}

            <div className="mx-auto w-full max-w-3xl px-4 pb-2">
              <div className="rounded-[22px] border border-white/10 bg-[#2a2a2a] px-3 py-2 shadow-[0_2px_20px_rgba(0,0,0,0.25)] transition-colors focus-within:border-white/25">
                <textarea
                  ref={composerRef}
                  value={draft}
                  onChange={(event) => setDraft(event.target.value)}
                  onKeyDown={handleKeyDown}
                  placeholder="Message OriginRouter"
                  rows={1}
                  style={{ transition: "height 140ms ease" }}
                  className="w-full resize-none bg-transparent px-2 py-1 text-[15px] leading-6 text-white outline-none placeholder:text-white/35 custom-scrollbar overflow-y-auto"
                />

                <div className="mt-2 flex items-center justify-between gap-3">
                  <div className="flex min-w-0 items-center gap-1.5">
                    <button type="button" onClick={() => fileInputRef.current?.click()} disabled={!activeModel || loadingData} className="p-2 text-white/50 hover:text-white transition rounded-full hover:bg-white/5">
                      <span className="material-symbols-outlined text-[20px]">attach_file</span>
                    </button>
                    <input ref={fileInputRef} type="file" accept="image/*" multiple className="hidden" onChange={handleAttachFiles} />

                    {/* Effort stays in the composer; thinking toggles live in the model selector */}
                    <div className="flex items-center rounded-full border border-white/10 bg-white/[0.04] p-0.5">
                      {EFFORT_LEVELS.map((level) => (
                        <button
                          key={level.value}
                          type="button"
                          onClick={() => setEffort(level.value)}
                          className={`rounded-full px-2 py-1 text-[10px] font-semibold transition ${
                            effort === level.value
                              ? "bg-white/90 text-black"
                              : "text-white/50 hover:bg-white/10 hover:text-white"
                          }`}
                          title={`Reasoning effort: ${level.label}`}
                        >
                          {level.label}
                        </button>
                      ))}
                    </div>
                  </div>

                  <div className="flex items-center gap-2">
                    {isSending ? (
                      <button type="button" onClick={handleStop} className="p-2 text-white bg-white/10 hover:bg-white/20 transition rounded-full h-8 w-8 flex items-center justify-center">
                        <span className="material-symbols-outlined text-[16px]">stop</span>
                      </button>
                    ) : null}
                    <button onClick={sendMessage} disabled={!canSend} className={`h-8 w-8 rounded-full flex items-center justify-center transition ${canSend ? 'bg-white text-black hover:opacity-90' : 'bg-white/10 text-white/30 cursor-not-allowed'}`}>
                      <span className="material-symbols-outlined text-[16px]">arrow_upward</span>
                    </button>
                  </div>
                </div>
              </div>
            </div>
          </div>

          <p className="mx-auto mt-2 max-w-3xl px-4 pb-4 text-center text-[11px] text-white/30">
            Model list is filtered from connected providers.
          </p>
        </div>
      </div>
      </div>
    </div>
  );
}
