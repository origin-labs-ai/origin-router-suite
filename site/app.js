(() => {
  "use strict";

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

  const state = {
    catalog: null,
    keys: new Map(),
    folderHandle: null,
    secrets: null,
  };

  const els = {
    alert: $("#alert"),
    dataPath: $("#dataPath"),
    pickFolder: $("#pickFolder"),
    folderStatus: $("#folderStatus"),
    folderName: $("[data-folder-name]"),
    providerList: $("#providerList"),
    providerSearch: $("#providerSearch"),
    catalogMeta: $("#catalogMeta"),
    catalogFooter: $("#catalogFooter"),
    emptyProviders: $("#emptyProviders"),
    selectedCount: $("#selectedCount"),
    modelCount: $("#modelCount"),
    clearKeys: $("#clearKeys"),
    summary: $("#summary"),
    writeFiles: $("#writeFiles"),
    writeHelp: $("#writeHelp"),
    curlCommands: $("#curlCommands"),
    secretPreview: $("#secretPreview"),
    copyCommands: $("#copyCommands"),
  };

  function alertBox(message, ok = false) {
    els.alert.textContent = message;
    els.alert.hidden = false;
    els.alert.classList.toggle("ok", ok);
    els.alert.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }

  function clearAlert() {
    els.alert.hidden = true;
    els.alert.textContent = "";
  }

  function cleanPath() {
    return els.dataPath.value.trim().replace(/^["']|["']$/g, "");
  }

  function randomHex(bytes) {
    const arr = new Uint8Array(bytes);
    crypto.getRandomValues(arr);
    return Array.from(arr, (b) => b.toString(16).padStart(2, "0")).join("");
  }

  function makeSecrets() {
    if (!state.secrets) {
      state.secrets = {
        JWT_SECRET: randomHex(32),
        API_KEY_SECRET: randomHex(32),
        MACHINE_ID_SALT: randomHex(16),
        INITIAL_PASSWORD: randomHex(12),
      };
    }
    return state.secrets;
  }

  function selectedProviders() {
    return state.catalog.providers.filter((p) => state.keys.has(p.alias));
  }

  function totalModels(providers) {
    return providers.reduce((n, p) => n + p.modelCount, 0);
  }

  function go(step) {
    clearAlert();
    $$("[data-step]").forEach((el) => { el.hidden = Number(el.dataset.step) !== step; });
    $$("[data-step-indicator]").forEach((el) => {
      const n = Number(el.dataset.stepIndicator);
      el.classList.toggle("active", n === step);
      el.classList.toggle("done", n < step);
    });
    if (step === 3) renderLaunch();
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function textEl(tag, className, text) {
    const el = document.createElement(tag);
    if (className) el.className = className;
    if (text !== undefined) el.textContent = text;
    return el;
  }

  function contrastColor(hex) {
    const m = /^#?([0-9a-f]{6})$/i.exec(hex || "");
    if (!m) return "#06121a";
    const n = parseInt(m[1], 16);
    const r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
    return (r * 299 + g * 587 + b * 114) / 1000 > 150 ? "#06121a" : "#f8fafc";
  }

  function renderProviders() {
    const q = els.providerSearch.value.trim().toLowerCase();
    els.providerList.replaceChildren();

    let shown = 0;
    for (const p of state.catalog.providers) {
      const haystack = `${p.name} ${p.id} ${p.alias} ${p.sampleModels.join(" ")}`.toLowerCase();
      if (q && !haystack.includes(q)) continue;
      shown += 1;

      const card = textEl("div", "provider");
      card.dataset.alias = p.alias;
      if (state.keys.has(p.alias)) card.classList.add("selected");

      const top = textEl("div", "provider-top");
      const badge = textEl("span", "provider-badge", p.textIcon || p.name.slice(0, 2).toUpperCase());
      badge.style.backgroundColor = p.color;
      badge.style.color = contrastColor(p.color);
      const names = textEl("div");
      names.appendChild(textEl("div", "provider-name", p.name));
      const modelLabel = p.modelCount ? `${p.modelCount} models` : "dynamic catalog";
      names.appendChild(textEl("div", "provider-models", `${modelLabel}${p.media.length ? " · " + p.media.join(", ") : ""}`));
      top.append(badge, names, textEl("span", "provider-check", state.keys.has(p.alias) ? "✓" : "+"));
      card.appendChild(top);

      const body = textEl("div", "provider-body");
      const label = textEl("label", "", "API key");
      label.htmlFor = `key-${p.alias}`;
      const input = document.createElement("input");
      input.type = "password";
      input.id = `key-${p.alias}`;
      input.autocomplete = "off";
      input.spellcheck = false;
      input.placeholder = "Paste your key — never leaves this browser";
      input.value = state.keys.get(p.alias)?.key || "";
      input.addEventListener("input", () => {
        if (input.value.trim()) {
          state.keys.set(p.alias, { provider: p, key: input.value.trim(), name: p.name });
        } else {
          state.keys.delete(p.alias);
        }
        updateSelection();
        card.classList.toggle("selected", state.keys.has(p.alias));
        $(".provider-check", card).textContent = state.keys.has(p.alias) ? "✓" : "+";
      });
      input.addEventListener("click", (e) => e.stopPropagation());
      body.append(label, input);

      if (p.apiKeyUrl || p.website) {
        const links = textEl("div", "provider-links");
        if (p.apiKeyUrl) {
          const a = textEl("a", "", "Get an API key ↗");
          a.href = p.apiKeyUrl;
          a.target = "_blank";
          a.rel = "noopener noreferrer";
          links.appendChild(a);
        }
        if (p.website) {
          const a = textEl("a", "", "Website ↗");
          a.href = p.website;
          a.target = "_blank";
          a.rel = "noopener noreferrer";
          links.appendChild(a);
        }
        body.appendChild(links);
      }
      if (p.sampleModels.length) body.appendChild(textEl("div", "sample", p.sampleModels.join(" · ")));
      card.appendChild(body);

      card.addEventListener("click", (e) => {
        if (e.target.closest("input, a")) return;
        const active = state.keys.has(p.alias);
        if (active) {
          state.keys.delete(p.alias);
        } else {
          const field = $("input", card);
          const key = field.value.trim();
          if (!key) {
            field.focus();
            alertBox(`Paste an API key for ${p.name} first.`);
            return;
          }
          state.keys.set(p.alias, { provider: p, key, name: p.name });
        }
        card.classList.toggle("selected", state.keys.has(p.alias));
        $(".provider-check", card).textContent = state.keys.has(p.alias) ? "✓" : "+";
        updateSelection();
      });

      els.providerList.appendChild(card);
    }

    els.emptyProviders.hidden = shown !== 0;
    updateSelection();
  }

  function updateSelection() {
    const providers = selectedProviders();
    els.selectedCount.textContent = `${providers.length} provider${providers.length === 1 ? "" : "s"} selected`;
    els.modelCount.textContent = ` · ${totalModels(providers)} models available`;
  }

  // ---- Generated artifacts -------------------------------------------------

  function locationFile() {
    return `${JSON.stringify({ dir: cleanPath() }, null, 2)}\n`;
  }

  function envFile() {
    const s = makeSecrets();
    return [
      "# Generated by the OriginRouter setup page — keep this file private.",
      "# Copy to your OriginRouter install folder as .env",
      "NODE_ENV=production",
      "PORT=20128",
      "HOSTNAME=127.0.0.1",
      `DATA_DIR=${cleanPath()}`,
      "",
      `JWT_SECRET=${s.JWT_SECRET}`,
      `API_KEY_SECRET=${s.API_KEY_SECRET}`,
      `MACHINE_ID_SALT=${s.MACHINE_ID_SALT}`,
      `INITIAL_PASSWORD=${s.INITIAL_PASSWORD}`,
      "",
    ].join("\n");
  }

  function importFile() {
    const now = new Date().toISOString();
    const connections = selectedProviders().map((item, i) => ({
      id: crypto.randomUUID(),
      provider: item.provider.alias,
      authType: "apikey",
      name: item.provider.name,
      apiKey: item.key,
      testStatus: "unknown",
      priority: i + 1,
      isActive: true,
      createdAt: now,
      updatedAt: now,
    }));
    return `${JSON.stringify({
      settings: { onboardingComplete: true },
      providerConnections: connections,
      providerNodes: [],
      proxyPools: [],
      apiKeys: [],
      combos: [],
      modelAliases: {},
      customModels: [],
      mitmAlias: {},
      pricing: {},
    }, null, 2)}\n`;
  }

  function curlCommands() {
    const lines = [
      "# Run locally after OriginRouter is running (default port 20128).",
      "# Each command adds one connection; nothing else in the DB is changed.",
      "",
    ];
    for (const item of selectedProviders()) {
      const body = JSON.stringify({
        provider: item.provider.alias,
        apiKey: item.key,
        name: item.provider.name,
      });
      lines.push(
        `curl -sS -X POST 'http://127.0.0.1:20128/api/providers' \\`,
        `  -H 'Content-Type: application/json' \\`,
        `  --data-binary @- <<'OR_JSON'`,
        body,
        `OR_JSON`,
        ""
      );
    }
    if (selectedProviders().length === 0) lines.push("# No API keys were added in step 2.");
    return lines.join("\n");
  }

  function artifacts() {
    return [
      ["data-location.json", locationFile(), "application/json"],
      ["originrouter.env", envFile(), "text/plain"],
      ["byok-import.json", importFile(), "application/json"],
    ];
  }

  function renderLaunch() {
    const providers = selectedProviders();
    els.summary.replaceChildren();
    const items = [
      ["Data folder", cleanPath() || "not set"],
      ["API keys", `${providers.length} provider${providers.length === 1 ? "" : "s"}`],
      ["Models unlocked", String(totalModels(providers))],
      ["Local secrets", "generated"],
    ];
    for (const [label, value] of items) {
      const box = textEl("div");
      box.appendChild(textEl("span", "", label));
      box.appendChild(textEl("strong", "", value));
      els.summary.appendChild(box);
    }

    els.curlCommands.textContent = curlCommands();
    const s = makeSecrets();
    els.secretPreview.textContent = Object.entries(s)
      .map(([k, v]) => `${k}=${v}`)
      .join("\n");

    els.writeFiles.disabled = !state.folderHandle;
    els.writeHelp.textContent = state.folderHandle
      ? `Ready to write into the folder you chose (${state.folderHandle.name}).`
      : "Available in Chrome or Edge after choosing a folder in step 1. You can still download the files below.";
  }

  function download(name, text, mime) {
    const url = URL.createObjectURL(new Blob([text], { type: mime }));
    const a = document.createElement("a");
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }

  // ---- Events --------------------------------------------------------------

  $$("[data-next]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const target = Number(btn.dataset.next);
      if (target === 2 && !cleanPath()) {
        alertBox("Enter the full path of the folder where OriginRouter should save data.");
        els.dataPath.focus();
        return;
      }
      go(target);
    });
  });

  els.pickFolder.addEventListener("click", async () => {
    if (!window.showDirectoryPicker) {
      alertBox("This browser cannot expose a folder picker. Type the full path above and download the setup files instead.");
      return;
    }
    try {
      const handle = await window.showDirectoryPicker({
        id: "originrouter-data",
        mode: "readwrite",
        startIn: "documents",
      });
      state.folderHandle = handle;
      els.folderName.textContent = handle.name;
      els.folderStatus.hidden = false;
      clearAlert();
      if (!cleanPath()) alertBox(`Folder “${handle.name}” selected. Type its full path above so the generated config can point to it.`);
    } catch (err) {
      if (err && err.name !== "AbortError") alertBox(`Folder picker failed: ${err.message}`);
    }
  });

  els.providerSearch.addEventListener("input", renderProviders);
  els.clearKeys.addEventListener("click", () => {
    state.keys.clear();
    $$(".provider", els.providerList).forEach((card) => {
      card.classList.remove("selected");
      $("input", card).value = "";
      $(".provider-check", card).textContent = "+";
    });
    updateSelection();
  });

  els.writeFiles.addEventListener("click", async () => {
    if (!state.folderHandle) return;
    try {
      const permission = await state.folderHandle.queryPermission({ mode: "readwrite" });
      if (permission !== "granted") {
        const asked = await state.folderHandle.requestPermission({ mode: "readwrite" });
        if (asked !== "granted") throw new Error("write permission was denied");
      }
      const db = await state.folderHandle.getDirectoryHandle("db", { create: true });
      const marker = await db.getFileHandle(".keep", { create: true });
      const mw = await marker.createWritable();
      await mw.write("OriginRouter database directory\n");
      await mw.close();
      for (const [name, text] of artifacts()) {
        const file = await state.folderHandle.getFileHandle(name, { create: true });
        const writer = await file.createWritable();
        await writer.write(text);
        await writer.close();
      }
      alertBox(`Wrote the three setup files into “${state.folderHandle.name}”. Copy originrouter.env to the app folder as .env (it already sets DATA_DIR), or copy data-location.json to ~/.or/ if you are not using an env file.`, true);
    } catch (err) {
      alertBox(`Could not write files: ${err.message}`);
    }
  });

  $$("[data-download]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const kind = btn.dataset.download;
      const file = artifacts().find(([name]) =>
        (kind === "location" && name === "data-location.json") ||
        (kind === "env" && name === "originrouter.env") ||
        (kind === "import" && name === "byok-import.json")
      );
      if (file) download(file[0], file[1], file[2]);
    });
  });

  els.copyCommands.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(els.curlCommands.textContent);
      alertBox("Commands copied. Paste them in a terminal on the machine running OriginRouter.", true);
    } catch {
      const range = document.createRange();
      range.selectNodeContents(els.curlCommands);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
      alertBox("Selected the commands — press Ctrl/Cmd+C to copy them.");
    }
  });

  // ---- Boot ----------------------------------------------------------------

  (async () => {
    try {
      const res = await fetch("./providers.json", { cache: "no-cache" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      state.catalog = await res.json();
      els.catalogMeta.textContent = `${state.catalog.total} providers · ${new Date(state.catalog.generatedAt).toISOString().slice(0, 10)}`;
      els.catalogFooter.textContent = `Provider catalog generated from ${state.catalog.source} · ${state.catalog.total} API-key providers`;
      renderProviders();
    } catch (err) {
      els.catalogMeta.textContent = "Catalog unavailable";
      els.providerList.replaceChildren(textEl("p", "empty", `Could not load the provider catalog: ${err.message}`));
      alertBox("Provider catalog failed to load. Reload the page before adding keys.");
    }
  })();
})();
