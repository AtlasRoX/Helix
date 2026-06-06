const state = {
  config: null,
  status: null,
  fields: new Map(),
  localStatus: new Map(),
  modelOptions: [],
  activeView: "dashboard",
  metricsHistory: { cpu: [], memory: [], maxEntries: 20 },
  logsPaused: false,
  promptHistory: JSON.parse(localStorage.getItem("play_prompt_history") || "[]"),
  notificationsEnabled: localStorage.getItem("notifications_enabled") === "true",
};

const MASKED_SECRET = "********";
const VIEW_GROUPS = [
  {
    id: "dashboard",
    label: "Dashboard",
    title: "Dashboard",
    sections: [],
    containerId: null,
  },
  {
    id: "providers",
    label: "Providers",
    title: "Providers",
    sections: ["providers", "runtime"],
    containerId: "providersSections",
  },
  {
    id: "model_config",
    label: "Model Config",
    title: "Model Config",
    sections: ["models", "thinking", "web_tools"],
    containerId: "modelConfigSections",
  },
  {
    id: "playground",
    label: "Playground",
    title: "Model Playground",
    sections: [],
    containerId: null,
  },
  {
    id: "logs",
    label: "Logs",
    title: "Server Logs",
    sections: [],
    containerId: null,
  },
  {
    id: "messaging",
    label: "Messaging",
    title: "Messaging",
    sections: ["messaging", "voice"],
    containerId: "messagingSections",
  },
  {
    id: "env",
    label: "Env File",
    title: "Environment Variables File",
    sections: [],
    containerId: null,
  },
];

const byId = (id) => document.getElementById(id);

function sourceLabel(source) {
  const labels = {
    default: "default",
    template: "template",
    repo_env: "repo .env",
    managed_env: "",
    explicit_env_file: "FCC_ENV_FILE",
    process: "process env",
  };
  return Object.prototype.hasOwnProperty.call(labels, source) ? labels[source] : source;
}

function sourceText(field) {
  const parts = [];
  const label = sourceLabel(field.source);
  if (label) {
    parts.push(label);
  }
  if (field.locked) {
    parts.push("locked");
  }
  return parts.join(" ");
}

function providerName(providerId) {
  const names = {
    nvidia_nim: "NVIDIA NIM",
    open_router: "OpenRouter",
    mistral_codestral: "Mistral Codestral",
    deepseek: "DeepSeek",
    lmstudio: "LM Studio",
    llamacpp: "llama.cpp",
    ollama: "Ollama",
    kimi: "Kimi",
    wafer: "Wafer",
    opencode: "OpenCode Zen",
    opencode_go: "OpenCode Go",
    zai: "Z.ai",
    fireworks: "Fireworks AI",
    gemini: "Google Gemini",
    groq: "Groq",
    cerebras: "Cerebras",
  };
  if (names[providerId]) return names[providerId];
  return providerId
    .split("_")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function statusClass(status) {
  if (["configured", "reachable", "running"].includes(status)) return "ok";
  if (["missing_key", "missing_url", "unknown"].includes(status)) return "warn";
  if (["offline", "error"].includes(status)) return "error";
  return "neutral";
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    headers: { "Content-Type": "application/json", ...(options.headers || {}) },
    ...options,
  });
  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText}`);
  }
  return response.json();
}

async function load() {
  showMessage("Loading admin config");
  const [config, status] = await Promise.all([
    api("/admin/api/config"),
    api("/admin/api/st" + "atus")
  ]);
  state.config = config;
  state.status = status;
  state.fields = new Map(config.fields.map((field) => [field.key, field]));
  
  renderNav();
  renderProviders(config.provider_status);
  renderSections(config.sections, config.fields);
  byId("configPath").textContent = config.paths.managed;
  
  // Populate playground dropdowns
  initPlaygroundDropdowns(status);
  // Populate custom mapping forms
  initModelOverrideBuilder(status);
  
  // Update token display & check complexity
  updateAuthTokenDisplay();
  
  await validate(false);
  await refreshLocalStatus();
  updateDirtyState();
  showMessage("");
  
  // If restart button has callback configured, show it
  if (status.status === "running") {
    byId("triggerRestartBtn").style.display = "block";
  }
}

function renderNav() {
  const nav = byId("sectionNav");
  nav.innerHTML = "";
  VIEW_GROUPS.forEach((view, index) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `nav-link${view.id === state.activeView ? " active" : ""}`;
    button.dataset.view = view.id;
    button.textContent = view.label;
    if (view.id === state.activeView) {
      button.setAttribute("aria-current", "page");
    }
    button.addEventListener("click", () => {
      setActiveView(view.id, { scroll: true });
    });
    nav.appendChild(button);
  });
  setActiveView(state.activeView, { scroll: false });
}

function setActiveView(viewId, { scroll = false } = {}) {
  const activeView =
    VIEW_GROUPS.find((view) => view.id === viewId) || VIEW_GROUPS[0];
  state.activeView = activeView.id;
  byId("pageTitle").textContent = activeView.title;

  document.querySelectorAll(".nav-link").forEach((link) => {
    const selected = link.dataset.view === activeView.id;
    link.classList.toggle("active", selected);
    if (selected) {
      link.setAttribute("aria-current", "page");
    } else {
      link.removeAttribute("aria-current");
    }
  });

  document.querySelectorAll(".admin-view").forEach((view) => {
    const selected = view.dataset.view === activeView.id;
    view.classList.toggle("active", selected);
    view.hidden = !selected;
  });

  if (activeView.id === "dashboard") {
    startMetricsPolling();
  } else {
    stopMetricsPolling();
  }

  if (activeView.id === "logs") {
    startLogsPolling();
  } else {
    stopLogsPolling();
  }
  
  if (activeView.id === "env") {
    loadRawEnv();
  }

  if (scroll) {
    window.scrollTo({ top: 0, behavior: "smooth" });
  }
}

function renderProviders(providerStatus) {
  const grid = byId("providerGrid");
  grid.innerHTML = "";
  providerStatus.forEach((provider) => {
    const card = document.createElement("article");
    card.className = "provider-card";
    card.dataset.provider = provider.provider_id;

    const title = document.createElement("div");
    title.className = "provider-title";
    title.innerHTML = `<strong>${providerName(provider.provider_id)}</strong>`;

    const pill = document.createElement("span");
    pill.className = `status-pill ${statusClass(provider.status)}`;
    pill.textContent = provider.label;
    title.appendChild(pill);

    const meta = document.createElement("div");
    meta.className = "provider-meta";
    meta.textContent =
      provider.kind === "local"
        ? provider.base_url || "No local URL configured"
        : provider.credential_env;

    const btnGroup = document.createElement("div");
    btnGroup.style.display = "flex";
    btnGroup.style.gap = "8px";
    btnGroup.style.width = "100%";

    const button = document.createElement("button");
    button.type = "button";
    button.className = "test-button";
    button.style.flex = "1";
    button.textContent = provider.kind === "local" ? "Test" : "Refresh";
    button.addEventListener("click", () => testProvider(provider.provider_id, button));

    const latencyBtn = document.createElement("button");
    latencyBtn.type = "button";
    latencyBtn.className = "secondary-button";
    latencyBtn.style.flex = "1";
    latencyBtn.textContent = "Ping";
    latencyBtn.addEventListener("click", () => benchmarkLatency(provider.provider_id, latencyBtn));

    btnGroup.append(button, latencyBtn);
    card.append(title, meta, btnGroup);
    grid.appendChild(card);
  });
}

function updateProviderCard(providerId, status, label, metaText) {
  const card = document.querySelector(`[data-provider="${providerId}"]`);
  if (!card) return;
  const pill = card.querySelector(".status-pill");
  pill.className = `status-pill ${statusClass(status)}`;
  pill.textContent = label;
  if (metaText) {
    card.querySelector(".provider-meta").textContent = metaText;
  }
}

function renderSections(sections, fields) {
  VIEW_GROUPS.forEach((view) => {
    if (view.containerId) {
      byId(view.containerId).innerHTML = "";
    }
  });

  const sectionById = new Map(sections.map((section) => [section.id, section]));
  const bySection = new Map();
  sections.forEach((section) => bySection.set(section.id, []));
  fields.forEach((field) => {
    if (!bySection.has(field.section)) bySection.set(field.section, []);
    bySection.get(field.section).push(field);
  });

  VIEW_GROUPS.forEach((view) => {
    if (!view.containerId) return;
    const container = byId(view.containerId);
    view.sections.forEach((sectionId) => {
      const section = sectionById.get(sectionId);
      const sectionFields = bySection.get(sectionId) || [];
      if (!section || sectionFields.length === 0) return;

      const sectionEl = document.createElement("section");
      sectionEl.className = "settings-section";
      sectionEl.id = `section-${section.id}`;

      // Section Header (Collapsible toggle)
      const header = document.createElement("div");
      header.className = "settings-section-header";
      header.innerHTML = `
        <div>
          <h3>${section.label}</h3>
          <p style="margin:4px 0 0 0; font-size:12px; color:var(--muted);">${section.description}</p>
        </div>
        <svg class="settings-section-chevron" viewBox="0 0 24 24"><path d="M7 10l5 5 5-5z"/></svg>
      `;
      header.addEventListener("click", () => {
        sectionEl.classList.toggle("collapsed");
      });
      sectionEl.appendChild(header);

      const content = document.createElement("div");
      content.className = "settings-section-content";

      const grid = document.createElement("div");
      grid.className = "field-grid";
      sectionFields.forEach((field) => {
        grid.appendChild(renderField(field));
      });
      content.appendChild(grid);

      if (sectionFields.some((field) => field.advanced)) {
        const toggle = document.createElement("button");
        toggle.type = "button";
        toggle.className = "ghost-button advanced-toggle";
        toggle.textContent = "Show advanced";
        toggle.addEventListener("click", () => {
          const showing = sectionEl.classList.toggle("show-advanced");
          toggle.textContent = showing ? "Hide advanced" : "Show advanced";
        });
        content.appendChild(toggle);
      }

      sectionEl.appendChild(content);
      container.appendChild(sectionEl);
    });
  });
}

function renderField(field) {
  const wrapper = document.createElement("div");
  wrapper.className = `field${field.advanced ? " advanced-field" : ""}`;
  wrapper.dataset.key = field.key;

  const label = document.createElement("label");
  label.htmlFor = `field-${field.key}`;
  const labelText = document.createElement("span");
  labelText.textContent = field.label;
  label.appendChild(labelText);

  const source = sourceText(field);
  if (source) {
    const sourceEl = document.createElement("span");
    sourceEl.className = "field-source";
    sourceEl.textContent = source;
    label.appendChild(sourceEl);
  }

  const input = inputForField(field);
  input.id = `field-${field.key}`;
  input.dataset.key = field.key;
  input.dataset.original = field.value || "";
  input.dataset.secret = field.secret ? "true" : "false";
  input.dataset.configured = field.configured ? "true" : "false";
  input.disabled = field.locked;
  
  const handleInputChange = () => {
    updateDirtyState();
    if (field.key === "ANTHROPIC_AUTH_TOKEN") {
      updateAuthTokenDisplay();
    }
  };
  input.addEventListener("input", handleInputChange);
  input.addEventListener("change", handleInputChange);

  let inputWrapper;
  if (field.secret) {
    inputWrapper = document.createElement("div");
    inputWrapper.className = "secret-input-wrapper";
    
    const eyeBtn = document.createElement("button");
    eyeBtn.type = "button";
    eyeBtn.className = "eye-toggle-btn";
    eyeBtn.innerHTML = "👁️";
    eyeBtn.title = "Toggle Visibility";
    eyeBtn.addEventListener("click", () => {
      input.type = input.type === "password" ? "text" : "password";
      eyeBtn.innerHTML = input.type === "password" ? "👁️" : "🙈";
    });
    
    inputWrapper.append(input, eyeBtn);
  }

  // Row for buttons next to input (Reset, Copy Env)
  const inputRow = document.createElement("div");
  inputRow.className = "field-input-row";
  inputRow.append(field.secret ? inputWrapper : input);

  // 3. Reset Button helper
  const resetBtn = document.createElement("button");
  resetBtn.type = "button";
  resetBtn.className = "field-action-btn";
  resetBtn.title = "Reset to default/fallback value";
  resetBtn.innerHTML = `<svg viewBox="0 0 24 24"><path d="M12.5 8c-2.65 0-5.05 1-6.9 2.6L2 7v9h9l-3.62-3.62c1.39-1.16 3.16-1.88 5.12-1.88 3.54 0 6.55 2.31 7.6 5.5l2.37-.78C21.08 11.03 17.15 8 12.5 8z"/></svg>`;
  resetBtn.addEventListener("click", () => {
    if (input.type === "checkbox") {
      input.checked = field.default.toLowerCase() === "true";
    } else {
      input.value = field.default || "";
    }
    handleInputChange();
    showMessage(`Reverted ${field.label} to default fallback`, "ok");
  });
  inputRow.appendChild(resetBtn);

  // 4. Copy Env command helper
  const copyEnvBtn = document.createElement("button");
  copyEnvBtn.type = "button";
  copyEnvBtn.className = "field-action-btn";
  copyEnvBtn.title = "Copy environment shell command";
  copyEnvBtn.innerHTML = `<svg viewBox="0 0 24 24"><path d="M16 1H4c-1.1 0-2 .9-2 2v14h2V3h12V1zm3 4H8c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h11c1.1 0 2-.9 2-2V7c0-1.1-.9-2-2-2zm0 16H8V7h11v14z"/></svg>`;
  copyEnvBtn.addEventListener("click", async () => {
    const val = readFieldValue(input);
    const cmd = `export ${field.key}="${val}"`;
    try {
      await navigator.clipboard.writeText(cmd);
      showMessage(`Copied: ${cmd}`, "ok");
    } catch (e) {
      showMessage("Copy failed: " + e.message, "error");
    }
  });
  inputRow.appendChild(copyEnvBtn);

  wrapper.append(label, inputRow);

  if (field.description) {
    const description = document.createElement("div");
    description.className = "field-description";
    description.textContent = field.description;
    wrapper.appendChild(description);
  }
  return wrapper;
}

function inputForField(field) {
  if (field.type === "boolean") {
    const input = document.createElement("input");
    input.type = "checkbox";
    input.checked = String(field.value).toLowerCase() === "true";
    input.dataset.original = input.checked ? "true" : "false";
    return input;
  }

  if (field.type === "tri_boolean") {
    const select = document.createElement("select");
    [
      ["", "Inherit"],
      ["true", "Enabled"],
      ["false", "Disabled"],
    ].forEach(([value, label]) => select.appendChild(option(value, label)));
    select.value = field.value || "";
    return select;
  }

  if (field.type === "select") {
    const select = document.createElement("select");
    field.options.forEach((value) => select.appendChild(option(value, value)));
    select.value = field.value || field.options[0] || "";
    return select;
  }

  if (field.type === "textarea") {
    const textarea = document.createElement("textarea");
    textarea.value = field.value || "";
    return textarea;
  }

  const input = document.createElement("input");
  input.type = field.type === "number" ? "number" : "text";
  if (field.type === "secret") {
    input.type = "password";
    input.placeholder = field.configured
      ? "Configured - enter a new value to replace"
      : "Not configured";
    input.value = "";
    input.autocomplete = "off";
  } else {
    input.value = field.value || "";
  }
  if (field.key.startsWith("MODEL")) {
    input.setAttribute("list", "model-options");
  }
  return input;
}

function option(value, label) {
  const optionEl = document.createElement("option");
  optionEl.value = value;
  optionEl.textContent = label;
  return optionEl;
}

function readFieldValue(input) {
  if (input.type === "checkbox") return input.checked ? "true" : "false";
  if (input.dataset.secret === "true" && input.dataset.configured === "true") {
    return input.value ? input.value : MASKED_SECRET;
  }
  return input.value;
}

function changedValues() {
  const values = {};
  document.querySelectorAll("[data-key]").forEach((input) => {
    if (input.disabled || !input.matches("input, select, textarea")) return;
    const value = readFieldValue(input);
    if (value !== input.dataset.original) {
      values[input.dataset.key] = value;
    }
  });
  return values;
}

function updateDirtyState() {
  const count = Object.keys(changedValues()).length;
  byId("dirtyState").textContent =
    count === 0 ? "No changes" : `${count} unsaved change${count === 1 ? "" : "s"}`;
  byId("applyButton").disabled = count === 0;
}

async function validate(showResult = true) {
  const result = await api("/admin/api/config/validate", {
    method: "POST",
    body: JSON.stringify({ values: changedValues() }),
  });
  if (showResult) {
    showValidationResult(result);
  }
  return result;
}

function showValidationResult(result) {
  if (result.valid) {
    showMessage("Config shape is valid", "ok");
  } else {
    showMessage(result.errors.join("; "), "error");
  }
}

async function apply() {
  const result = await api("/admin/api/config/apply", {
    method: "POST",
    body: JSON.stringify({ values: changedValues() }),
  });
  if (!result.applied) {
    showValidationResult(result);
    return;
  }
  const restart = result.restart || {};
  if (restart.required && restart.automatic) {
    showMessage("Applied. Restarting server...", "ok");
    byId("applyButton").disabled = true;
    setTimeout(() => {
      window.location.href = restart.admin_url || "/admin";
    }, 1600);
    return;
  }
  const pending = restart.required ? restart.fields || [] : result.pending_fields || [];
  await load();
  showMessage(
    pending.length
      ? `Applied. Restart gc-server to use: ${pending.join(", ")}`
      : "Applied",
    "ok",
  );
}

async function refreshLocalStatus() {
  const result = await api("/admin/api/providers/local-status");
  result.providers.forEach((provider) => {
    state.localStatus.set(provider.provider_id, provider);
    const meta = provider.status_code
      ? `${provider.base_url} returned HTTP ${provider.status_code}`
      : provider.base_url;
    updateProviderCard(provider.provider_id, provider.status, provider.label, meta);
  });
}

async function testProvider(providerId, button) {
  const original = button.textContent;
  button.disabled = true;
  button.textContent = "Testing";
  try {
    const result = await api(`/admin/api/providers/${providerId}/test`, {
      method: "POST",
      body: "{}",
    });
    if (result.ok) {
      updateProviderCard(
        providerId,
        "reachable",
        `${result.models.length} models`,
        result.models.slice(0, 3).join(", ") || "No models returned",
      );
      state.modelOptions = Array.from(
        new Set([
          ...state.modelOptions,
          ...result.models.map((model) => `${providerId}/${model}`),
        ]),
      ).sort();
      syncModelDatalist();

      if (state.status) {
        state.status.cached_models[providerId] = result.models;
        if (byId("playProvider").value === providerId) {
          byId("playProvider").dispatchEvent(new Event("change"));
        }
      }
    } else {
      updateProviderCard(providerId, "offline", result.error_type, result.error_type);
    }
  } finally {
    button.disabled = false;
    button.textContent = original;
  }
}

function syncModelDatalist() {
  let datalist = byId("model-options");
  if (!datalist) {
    datalist = document.createElement("datalist");
    datalist.id = "model-options";
    document.body.appendChild(datalist);
  }
  datalist.innerHTML = "";
  state.modelOptions.forEach((model) => datalist.appendChild(option(model, model)));
}

function showMessage(message, kind = "") {
  const area = byId("messageArea");
  area.textContent = message;
  area.className = `message-area ${kind}`.trim();
}

// ==================== 5. CANVAS METRICS CHART GRAPH ====================
function drawMetricsChart() {
  const canvas = byId("metricsCanvas");
  if (!canvas) return;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  
  const rect = canvas.getBoundingClientRect();
  canvas.width = rect.width;
  canvas.height = 200;
  
  const w = canvas.width;
  const h = canvas.height;
  const pad = 30;
  
  ctx.clearRect(0, 0, w, h);
  
  // Gridlines
  ctx.strokeStyle = "rgba(255, 255, 255, 0.05)";
  ctx.lineWidth = 1;
  for (let i = 1; i <= 4; i++) {
    const y = pad + (h - 2 * pad) * (i / 4);
    ctx.beginPath();
    ctx.moveTo(pad, y);
    ctx.lineTo(w - pad, y);
    ctx.stroke();
  }
  
  const cpu = state.metricsHistory.cpu;
  const mem = state.metricsHistory.memory;
  const max = state.metricsHistory.maxEntries;
  
  if (cpu.length < 2) {
    ctx.fillStyle = "rgba(255,255,255,0.3)";
    ctx.font = "12px sans-serif";
    ctx.textAlign = "center";
    ctx.fillText("Gathering metrics data history...", w / 2, h / 2);
    return;
  }
  
  function drawLine(data, color) {
    ctx.strokeStyle = color;
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    for (let i = 0; i < data.length; i++) {
      const x = pad + (w - 2 * pad) * (i / (max - 1));
      const y = h - pad - (h - 2 * pad) * (data[i] / 100);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();
  }
  
  drawLine(cpu, "#10b981");
  drawLine(mem, "#06b6d4");
  
  // Draw legends text
  ctx.fillStyle = "#10b981";
  ctx.fillRect(pad, 10, 10, 10);
  ctx.fillStyle = "#9592a5";
  ctx.font = "11px sans-serif";
  ctx.textAlign = "left";
  ctx.fillText(`CPU: ${cpu[cpu.length - 1]}%`, pad + 15, 19);
  
  ctx.fillStyle = "#06b6d4";
  ctx.fillRect(pad + 100, 10, 10, 10);
  ctx.fillStyle = "#9592a5";
  ctx.fillText(`Memory: ${mem[mem.length - 1]}%`, pad + 115, 19);
}

// ==================== METRICS & ANALYTICS POLLING ====================
let metricsInterval = null;

function startMetricsPolling() {
  if (metricsInterval) return;
  async function poll() {
    if (state.activeView !== "dashboard") return;
    try {
      const [metrics, analytics] = await Promise.all([
        api("/admin/api/metrics"),
        api("/admin/api/analytics")
      ]);
      
      byId("metricUptime").textContent = formatUptime(metrics.uptime_seconds);
      byId("metricCPU").textContent = `${metrics.cpu_usage_percent}%`;
      byId("metricCPUBar").style.width = `${metrics.cpu_usage_percent}%`;
      byId("metricMemory").textContent = `${metrics.memory_usage_percent}%`;
      byId("metricMemoryBar").style.width = `${metrics.memory_usage_percent}%`;
      byId("metricThreads").textContent = metrics.active_threads;
      
      byId("analyticsRequests").textContent = analytics.requests_count;
      byId("analyticsErrors").textContent = `${analytics.errors_count} error${analytics.errors_count === 1 ? "" : "s"}`;
      byId("analyticsPromptTokens").textContent = formatNumber(analytics.prompt_tokens);
      byId("analyticsCompletionTokens").textContent = formatNumber(analytics.completion_tokens);
      byId("analyticsCost").textContent = `$${analytics.simulated_cost_usd.toFixed(4)}`;
      
      // Update canvas data
      state.metricsHistory.cpu.push(metrics.cpu_usage_percent);
      state.metricsHistory.memory.push(metrics.memory_usage_percent);
      if (state.metricsHistory.cpu.length > state.metricsHistory.maxEntries) {
        state.metricsHistory.cpu.shift();
        state.metricsHistory.memory.shift();
      }
      drawMetricsChart();
    } catch (err) {
      console.error("Metrics polling failed:", err);
    }
  }
  poll();
  metricsInterval = setInterval(poll, 3000);
}

function stopMetricsPolling() {
  if (metricsInterval) {
    clearInterval(metricsInterval);
    metricsInterval = null;
  }
}

function formatUptime(seconds) {
  const d = Math.floor(seconds / (3600 * 24));
  const h = Math.floor((seconds % (3600 * 24)) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  
  const parts = [];
  if (d > 0) parts.push(`${d}d`);
  if (h > 0 || d > 0) parts.push(`${h}h`);
  if (m > 0 || h > 0 || d > 0) parts.push(`${m}m`);
  parts.push(`${s}s`);
  return parts.join(" ");
}

function formatNumber(num) {
  return num.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

// ==================== LOGS VIEW TRIGGERS ====================
let logsInterval = null;
let lastLogText = "";

function startLogsPolling() {
  if (logsInterval || state.logsPaused) return;
  async function poll() {
    if (state.activeView !== "logs" || state.logsPaused) return;
    try {
      const limit = byId("logLinesLimit").value;
      const res = await api(`/admin/api/logs?lines=${limit}`);
      const logs = res.logs || [];
      const filterText = byId("logSearch").value.toLowerCase();
      const consoleEl = byId("logConsole");
      
      // Filter logs by level settings checkboxes
      const infoOk = byId("filterLogInfo").checked;
      const warnOk = byId("filterLogWarn").checked;
      const errOk = byId("filterLogErr").checked;
      const debugOk = byId("filterLogDebug").checked;
      
      const filtered = logs.filter(line => {
        if (!line.toLowerCase().includes(filterText)) return false;
        
        const isErr = line.includes("ERROR") || line.includes("HTTP 500") || line.includes("Exception");
        const isWarn = line.includes("WARNING") || line.includes("WARN");
        const isInfo = line.includes("INFO") || line.includes("HTTP");
        const isDebug = line.includes("DEBUG");
        
        if (isErr && !errOk) return false;
        if (isWarn && !warnOk) return false;
        if (isInfo && !warnOk && !isErr && !isDebug && !infoOk) return false;
        if (isDebug && !debugOk) return false;
        return true;
      });
      
      const currentText = filtered.join("\n");
      if (currentText === lastLogText) return;
      lastLogText = currentText;
      
      consoleEl.innerHTML = "";
      filtered.forEach(line => {
        const div = document.createElement("div");
        div.className = "log-line";
        if (line.includes("ERROR") || line.includes("HTTP 500") || line.includes("Exception")) {
          div.classList.add("error");
        } else if (line.includes("WARNING") || line.includes("WARN")) {
          div.classList.add("warn");
        } else if (line.includes("INFO") || line.includes("HTTP")) {
          div.classList.add("info");
        } else if (line.includes("DEBUG")) {
          div.classList.add("debug");
        }
        div.textContent = line;
        consoleEl.appendChild(div);
      });
      
      if (byId("logAutoScroll").checked) {
        consoleEl.scrollTop = consoleEl.scrollHeight;
      }
    } catch (err) {
      console.error("Logs polling failed:", err);
    }
  }
  poll();
  logsInterval = setInterval(poll, 3000);
}

function stopLogsPolling() {
  if (logsInterval) {
    clearInterval(logsInterval);
    logsInterval = null;
  }
}

// ==================== 1. FILTER SETTINGS SEARCH BAR ====================
function initSettingsSearch() {
  document.querySelectorAll(".settings-search-input").forEach(searchEl => {
    searchEl.addEventListener("input", (e) => {
      const targetId = searchEl.dataset.target;
      const query = e.target.value.toLowerCase();
      const container = byId(targetId);
      if (!container) return;
      
      container.querySelectorAll(".field").forEach(fieldEl => {
        const labelText = fieldEl.querySelector("label span")?.textContent.toLowerCase() || "";
        const keyText = fieldEl.dataset.key?.toLowerCase() || "";
        const descText = fieldEl.querySelector(".field-description")?.textContent.toLowerCase() || "";
        
        if (labelText.includes(query) || keyText.includes(query) || descText.includes(query)) {
          fieldEl.style.display = "";
        } else {
          fieldEl.style.display = "none";
        }
      });
    });
  });
}

// ==================== 14. DIAGNOSTIC PROBE & NOTIFICATIONS ====================
async function runDiagnosticProbe() {
  const probeBtn = byId("runDiagnosticBtn");
  const tbody = byId("diagnosticTableBody");
  if (!probeBtn || !tbody) return;
  
  probeBtn.disabled = true;
  probeBtn.textContent = "Checking...";
  tbody.innerHTML = `<tr><td colspan="4" style="text-align: center; color: var(--muted);">Executing diagnostic check loop...</td></tr>`;
  
  const activeProviders = (state.status?.provider_status || []).filter(p => p.status === "configured" || p.status === "reachable");
  
  if (activeProviders.length === 0) {
    tbody.innerHTML = `<tr><td colspan="4" style="text-align: center; color: var(--error);">No configured active providers found.</td></tr>`;
    probeBtn.disabled = false;
    probeBtn.textContent = "Run Validation Probe";
    return;
  }
  
  let failures = 0;
  const results = await Promise.all(activeProviders.map(async (p) => {
    try {
      const start = performance.now();
      const res = await api(`/admin/api/providers/${p.provider_id}/latency`, { method: "POST", body: "{}" });
      const latency = Math.round(performance.now() - start);
      if (res.ok && res.latency_ms >= 0) {
        return { name: providerName(p.provider_id), url: p.base_url || p.credential_env, status: "online", latency: res.latency_ms };
      } else {
        failures++;
        return { name: providerName(p.provider_id), url: p.base_url || p.credential_env, status: "offline", latency: -1 };
      }
    } catch (e) {
      failures++;
      return { name: providerName(p.provider_id), url: p.base_url || p.credential_env, status: "offline", latency: -1 };
    }
  }));
  
  tbody.innerHTML = "";
  results.forEach(res => {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td><strong>${res.name}</strong></td>
      <td><code style="font-size:11px;">${res.url}</code></td>
      <td><span class="status-pill ${res.status === "online" ? "ok" : "error"}">${res.status === "online" ? "Online" : "Offline"}</span></td>
      <td><span style="font-family:monospace;">${res.latency >= 0 ? res.latency + " ms" : "--"}</span></td>
    `;
    tbody.appendChild(tr);
  });
  
  probeBtn.disabled = false;
  probeBtn.textContent = "Run Validation Probe";
  
  // HTML5 Native Browser Notifications
  if (state.notificationsEnabled && "Notification" in window && Notification.permission === "granted") {
    if (failures > 0) {
      new Notification("Helix Gateway Probe warning", {
        body: `${failures} provider(s) checked offline during diagnostics ping.`,
      });
    } else {
      new Notification("Helix Gateway Probe Success", {
        body: "All configured provider connections are healthy.",
      });
    }
  }
}

// ==================== 17. ENVIRONMENT CODE VIEW ====================
async function loadRawEnv() {
  const codePre = byId("envPre");
  if (!codePre) return;
  
  codePre.textContent = "Loading raw environment file...";
  try {
    const res = await api("/admin/api/env/raw");
    codePre.textContent = res.content || "# Managed env file empty";
  } catch (err) {
    codePre.textContent = `# Failed to read env: ${err.message}`;
  }
}

// ==================== 18. CUSTOM MODEL ROUTE OVERRIDE FORM BUILDER ====================
function initModelOverrideBuilder(status) {
  const overrideTypeSelect = byId("builderOverrideType");
  const providerSelect = byId("builderProvider");
  const modelSelect = byId("builderModel");
  const applyBtn = byId("applyBuilderOverrideBtn");
  
  if (!overrideTypeSelect || !providerSelect || !modelSelect || !applyBtn) return;
  
  providerSelect.innerHTML = "";
  const activeProviders = (status.provider_status || []).filter(p => p.status === "configured" || p.status === "reachable");
  
  if (activeProviders.length === 0) {
    providerSelect.innerHTML = "<option value=''>No active providers</option>";
    return;
  }
  
  activeProviders.forEach(p => {
    const opt = document.createElement("option");
    opt.value = p.provider_id;
    opt.textContent = providerName(p.provider_id);
    providerSelect.appendChild(opt);
  });
  
  function updateModels() {
    modelSelect.innerHTML = "";
    const selectedProvider = providerSelect.value;
    if (!selectedProvider) return;
    const models = status.cached_models[selectedProvider] || [];
    models.forEach(model => {
      const opt = document.createElement("option");
      opt.value = model;
      opt.textContent = model;
      modelSelect.appendChild(opt);
    });
  }
  
  providerSelect.addEventListener("change", updateModels);
  updateModels();
  
  applyBtn.addEventListener("click", () => {
    const targetKey = overrideTypeSelect.value;
    const provider = providerSelect.value;
    const model = modelSelect.value;
    if (!provider || !model) {
      showMessage("Select both provider and model before setting override", "warn");
      return;
    }
    
    const input = document.querySelector(`[data-key="${targetKey}"]`);
    if (input) {
      input.value = `${provider}/${model}`;
      updateDirtyState();
      showMessage(`Assigned override ${targetKey} to '${provider}/${model}'. Click 'Apply' at bottom to save.`, "ok");
    } else {
      showMessage(`Settings field ${targetKey} input not found`, "error");
    }
  });
}

// ==================== 19. SAFE APPLICATION RESTART OVERLAY TRIGGER ====================
async function triggerSafeRestart() {
  if (!confirm("Are you sure you want to restart Helix Server? Active client CLI prompts will temporarily hang.")) {
    return;
  }
  
  const overlay = byId("restartOverlay");
  overlay.classList.add("active");
  
  try {
    await api("/admin/api/restart", { method: "POST" });
  } catch (err) {}
  
  let attempts = 0;
  const interval = setInterval(async () => {
    attempts++;
    try {
      const res = await fetch("/admin/api/st" + "atus");
      if (res.ok) {
        clearInterval(interval);
        overlay.classList.remove("active");
        showMessage("Server restarted and is back online.", "ok");
        window.location.reload();
      }
    } catch (e) {
      if (attempts > 20) {
        clearInterval(interval);
        overlay.classList.remove("active");
        showMessage("Restart connection timeout. Check server console manually.", "error");
      }
    }
  }, 1200);
}

// ==================== PLAYGROUND SSE CONTROLLER UPGRADE ====================
function initPlaygroundDropdowns(status) {
  const providerSelect = byId("playProvider");
  const modelSelect = byId("playModel");
  if (!providerSelect || !modelSelect) return;
  
  const currentProvider = providerSelect.value;
  providerSelect.innerHTML = "";
  
  const activeProviders = (status.provider_status || []).filter(p => p.status === "configured" || p.status === "reachable");
  
  if (activeProviders.length === 0) {
    const opt = document.createElement("option");
    opt.value = "";
    opt.textContent = "No active providers configured";
    providerSelect.appendChild(opt);
    modelSelect.innerHTML = "<option value=''>Please configure a provider</option>";
    return;
  }
  
  activeProviders.forEach(p => {
    const opt = document.createElement("option");
    opt.value = p.provider_id;
    opt.textContent = providerName(p.provider_id);
    providerSelect.appendChild(opt);
  });
  
  if (currentProvider && activeProviders.some(p => p.provider_id === currentProvider)) {
    providerSelect.value = currentProvider;
  }
  
  function updateModels() {
    modelSelect.innerHTML = "";
    const selectedProvider = providerSelect.value;
    if (!selectedProvider) return;
    
    const models = status.cached_models[selectedProvider] || [];
    if (models.length === 0) {
      const opt = document.createElement("option");
      opt.value = "";
      opt.textContent = "No cached models. Click 'Test' under Providers first.";
      modelSelect.appendChild(opt);
    } else {
      models.forEach(model => {
        const opt = document.createElement("option");
        opt.value = model;
        opt.textContent = model;
        modelSelect.appendChild(opt);
      });
    }
  }
  
  providerSelect.addEventListener("change", updateModels);
  updateModels();
}

async function sendPlaygroundMessage() {
  const provider = byId("playProvider").value;
  const model = byId("playModel").value;
  const prompt = byId("playPrompt").value.trim();
  const system = byId("playSystem").value.trim();
  const temperature = parseFloat(byId("playTemperature").value);
  const thinking = byId("playThinking").checked;
  const chatBox = byId("chatBox");
  
  if (!provider || !model || !prompt) return;
  
  byId("playPrompt").value = "";
  appendChatMessage("user", prompt);
  
  // 10. Cache prompt in history list
  savePromptHistory(prompt);
  
  const responseBubble = appendChatMessage("assistant", "");
  
  // Add Word Counter metadata row
  const metaRow = document.createElement("div");
  metaRow.className = "playground-response-meta";
  metaRow.innerHTML = `<span id="playCountWord">Words: 0</span> | <span id="playCountChar">Chars: 0</span> | <span id="playReadTime">Read time: 0s</span>`;
  responseBubble.parentNode.insertBefore(metaRow, responseBubble.nextSibling);
  
  try {
    const response = await fetch("/admin/api/playground/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        provider_id: provider,
        model_id: model,
        prompt: prompt,
        thinking_enabled: thinking,
        system: system || null,
        temperature: temperature
      })
    });
    
    if (!response.ok) {
      const errText = await response.text();
      responseBubble.className = "chat-message error";
      responseBubble.textContent = `Error: ${response.status} - ${errText}`;
      return;
    }
    
    const reader = response.body.getReader();
    const decoder = new TextDecoder("utf-8");
    let thinkingBlock = null;
    let textBlock = null;
    let buffer = "";
    
    let totalText = "";
    
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop();
      
      for (const line of lines) {
        if (line.startsWith("data: ")) {
          try {
            const data = JSON.parse(line.slice(6));
            if (data.type === "content_block_start") {
              const part = data.content_block;
              if (part && part.type === "thinking") {
                thinkingBlock = document.createElement("div");
                thinkingBlock.className = "chat-thinking";
                responseBubble.appendChild(thinkingBlock);
              }
            } else if (data.type === "content_block_delta") {
              const delta = data.delta;
              if (delta) {
                if (delta.type === "thinking_delta") {
                  if (!thinkingBlock) {
                    thinkingBlock = document.createElement("div");
                    thinkingBlock.className = "chat-thinking";
                    responseBubble.appendChild(thinkingBlock);
                  }
                  thinkingBlock.textContent += delta.thinking;
                } else if (delta.type === "text_delta") {
                  if (!textBlock) {
                    textBlock = document.createElement("span");
                    responseBubble.appendChild(textBlock);
                  }
                  textBlock.textContent += delta.text;
                  totalText += delta.text;
                  
                  // 11. Word counts & metadata analytics updates
                  updatePlaygroundMetadata(totalText);
                }
              }
            }
          } catch (e) {}
        } else if (line.startsWith("event: error")) {
          responseBubble.className = "chat-message error";
        }
      }
      chatBox.scrollTop = chatBox.scrollHeight;
    }
  } catch (err) {
    responseBubble.className = "chat-message error";
    responseBubble.textContent = `Request failed: ${err.message}`;
  }
}

function updatePlaygroundMetadata(text) {
  const wordSpan = byId("playCountWord");
  const charSpan = byId("playCountChar");
  const readSpan = byId("playReadTime");
  if (!wordSpan || !charSpan || !readSpan) return;
  
  const words = text.trim() ? text.trim().split(/\s+/).length : 0;
  const chars = text.length;
  // standard typing/reading estimation: 200 words per minute
  const readTimeSec = Math.max(1, Math.round((words / 200) * 60));
  
  wordSpan.textContent = `Words: ${words}`;
  charSpan.textContent = `Chars: ${chars}`;
  readSpan.textContent = `Read time: ${readTimeSec}s`;
}

function savePromptHistory(prompt) {
  state.promptHistory = state.promptHistory.filter(p => p !== prompt);
  state.promptHistory.unshift(prompt);
  if (state.promptHistory.length > 10) {
    state.promptHistory.pop();
  }
  localStorage.setItem("play_prompt_history", JSON.stringify(state.promptHistory));
  renderPromptHistory();
}

function renderPromptHistory() {
  const container = byId("promptHistoryList");
  if (!container) return;
  
  if (state.promptHistory.length === 0) {
    container.innerHTML = `<span style="font-size:11px; color:var(--muted); font-style:italic;">No prompt history yet.</span>`;
    return;
  }
  
  container.innerHTML = "";
  state.promptHistory.forEach(prompt => {
    const div = document.createElement("div");
    div.className = "history-item";
    div.textContent = prompt;
    div.addEventListener("click", () => {
      byId("playPrompt").value = prompt;
    });
    container.appendChild(div);
  });
}

function initPlaygroundControls() {
  byId("playSendBtn").addEventListener("click", sendPlaygroundMessage);
  byId("playPrompt").addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendPlaygroundMessage();
    }
  });
  
  // Update temperature value text on slider drag
  byId("playTemperature").addEventListener("input", (e) => {
    byId("playTempVal").textContent = parseFloat(e.target.value).toFixed(1);
  });
  
  byId("clearChatBtn").addEventListener("click", () => {
    byId("chatBox").innerHTML = `
      <div class="chat-message assistant">
        Hello! I'm the Helix Model Playground. Select a provider and model on the left, then enter a prompt below to test your connection in real-time.
      </div>
    `;
  });
  
  renderPromptHistory();
}

// ==================== NEW LATENCY BENCHMARK ====================
async function benchmarkLatency(providerId, button) {
  const original = button.textContent;
  button.disabled = true;
  button.textContent = "Ping...";
  
  const card = document.querySelector(`[data-provider="${providerId}"]`);
  let badge = card.querySelector(".latency-badge");
  if (!badge) {
    badge = document.createElement("span");
    badge.className = "latency-badge loading";
    card.querySelector(".provider-title").appendChild(badge);
  }
  badge.textContent = "Ping...";
  badge.className = "latency-badge loading";
  
  try {
    const res = await api(`/admin/api/providers/${providerId}/latency`, {
      method: "POST",
      body: "{}"
    });
    if (res.ok && res.latency_ms >= 0) {
      badge.textContent = `${res.latency_ms} ms`;
      if (res.latency_ms < 200) {
        badge.className = "latency-badge fast";
      } else {
        badge.className = "latency-badge slow";
      }
    } else {
      badge.textContent = "Fail";
      badge.className = "latency-badge fail";
    }
  } catch (err) {
    badge.textContent = "Fail";
    badge.className = "latency-badge fail";
  } finally {
    button.disabled = false;
    button.textContent = original;
  }
}

// ==================== PRESET ROUTING SELECTOR ====================
const PRESETS = {
  "nim-free": {
    "MODEL": "nvidia_nim/z-ai/glm4.7",
    "NVIDIA_NIM_BASE_URL": "https://integrate.api.nvidia.com/v1",
    "MODEL_OPUS": "",
    "MODEL_SONNET": "",
    "MODEL_HAIKU": ""
  },
  "groq-fast": {
    "MODEL": "groq/llama-3.3-70b-versatile",
    "MODEL_OPUS": "",
    "MODEL_SONNET": "groq/llama-3.3-70b-specdec",
    "MODEL_HAIKU": "groq/llama-3.1-8b-instant"
  },
  "gemini-flash": {
    "MODEL": "gemini/gemini-1.5-flash",
    "MODEL_OPUS": "",
    "MODEL_SONNET": "gemini/gemini-1.5-pro",
    "MODEL_HAIKU": "gemini/gemini-1.5-flash"
  },
  "ollama-local": {
    "MODEL": "ollama/llama3.2",
    "OLLAMA_BASE_URL": "http://localhost:11434",
    "MODEL_OPUS": "",
    "MODEL_SONNET": "",
    "MODEL_HAIKU": ""
  }
};

function initPresets() {
  document.querySelectorAll("[data-preset]").forEach(btn => {
    btn.addEventListener("click", () => {
      const presetId = btn.dataset.preset;
      const values = PRESETS[presetId];
      if (!values) return;
      
      let count = 0;
      for (const [key, value] of Object.entries(values)) {
        const input = document.querySelector(`[data-key="${key}"]`);
        if (input && !input.disabled) {
          if (input.type === "checkbox") {
            input.checked = String(value).toLowerCase() === "true";
          } else {
            input.value = value;
          }
          count++;
        }
      }
      updateDirtyState();
      showMessage(`Applied preset '${btn.textContent}'. Click 'Apply' at the bottom to save.`, "ok");
    });
  });
}

// ==================== BACKUP EXPORT & IMPORT ====================
function initBackup() {
  const exportBtn = byId("exportConfigBtn");
  const importBtn = byId("importConfigBtn");
  const importInput = byId("importConfigFile");

  exportBtn.addEventListener("click", () => {
    if (!state.config) return;
    const values = {};
    document.querySelectorAll("[data-key]").forEach((input) => {
      if (input.disabled || !input.matches("input, select, textarea")) return;
      values[input.dataset.key] = readFieldValue(input);
    });

    const dataStr = "data:text/json;charset=utf-8," + encodeURIComponent(JSON.stringify(values, null, 2));
    const downloadAnchor = document.createElement("a");
    downloadAnchor.setAttribute("href", dataStr);
    downloadAnchor.setAttribute("download", "freecc_config_backup.json");
    document.body.appendChild(downloadAnchor);
    downloadAnchor.click();
    downloadAnchor.remove();
    showMessage("Configuration backup JSON downloaded", "ok");
  });

  importBtn.addEventListener("click", () => {
    importInput.click();
  });

  importInput.addEventListener("change", (event) => {
    const file = event.target.files[0];
    if (!file) return;
    
    const reader = new FileReader();
    reader.onload = async (e) => {
      try {
        const importedValues = JSON.parse(e.target.result);
        let count = 0;
        for (const [key, value] of Object.entries(importedValues)) {
          const input = document.querySelector(`[data-key="${key}"]`);
          if (input && !input.disabled) {
            if (input.type === "checkbox") {
              input.checked = String(value).toLowerCase() === "true";
            } else {
              input.value = value === MASKED_SECRET ? "" : value;
            }
            count++;
          }
        }
        updateDirtyState();
        updateAuthTokenDisplay();
        showMessage(`Loaded ${count} configuration settings. Click 'Apply' at bottom to save.`, "ok");
      } catch (err) {
        showMessage("Failed to parse config file: " + err.message, "error");
      }
      importInput.value = "";
    };
    reader.readAsText(file);
  });
}

// ==================== 20. API AUTHENTICATION TOKEN SECURITY EVALUATOR ====================
let authTokenIsMasked = true;

function evaluateTokenComplexity(token) {
  const badge = byId("complexityBadge");
  if (!badge) return;
  
  if (!token) {
    badge.textContent = "Public (Unsecured)";
    badge.className = "complexity-badge weak";
    return;
  }
  
  if (token.length < 8) {
    badge.textContent = "Weak Complexity";
    badge.className = "complexity-badge weak";
  } else if (token.length < 16 || !/[A-Z]/.test(token) || !/[0-9]/.test(token)) {
    badge.textContent = "Moderate Complexity";
    badge.className = "complexity-badge moderate";
  } else {
    badge.textContent = "Strong Complexity";
    badge.className = "complexity-badge strong";
  }
}

function updateAuthTokenDisplay() {
  const display = byId("authTokenDisplay");
  const toggleBtn = byId("toggleAuthTokenBtn");
  if (!display || !toggleBtn) return;
  
  const token = getActualAuthToken();
  evaluateTokenComplexity(token);
  
  if (!token) {
    display.textContent = "No auth token configured (Public Mode)";
    display.classList.remove("masked");
    return;
  }
  
  if (authTokenIsMasked) {
    display.textContent = "••••••••••••••••";
    display.classList.add("masked");
    toggleBtn.textContent = "Show";
  } else {
    display.textContent = token;
    display.classList.remove("masked");
    toggleBtn.textContent = "Hide";
  }
}

function getActualAuthToken() {
  const input = document.querySelector(`[data-key="ANTHROPIC_AUTH_TOKEN"]`);
  if (input) {
    return input.value || input.dataset.original || "";
  }
  return "";
}

function initAuthTokenManager() {
  const toggleBtn = byId("toggleAuthTokenBtn");
  const copyBtn = byId("copyAuthTokenBtn");
  const genBtn = byId("generateAuthTokenBtn");
  
  toggleBtn.addEventListener("click", () => {
    authTokenIsMasked = !authTokenIsMasked;
    updateAuthTokenDisplay();
  });
  
  copyBtn.addEventListener("click", async () => {
    const token = getActualAuthToken();
    if (!token) {
      showMessage("No authorization token to copy", "warn");
      return;
    }
    try {
      await navigator.clipboard.writeText(token);
      const prev = copyBtn.textContent;
      copyBtn.textContent = "Copied!";
      setTimeout(() => copyBtn.textContent = prev, 1500);
    } catch (err) {
      showMessage("Clipboard copy failed: " + err.message, "error");
    }
  });
  
  genBtn.addEventListener("click", () => {
    const chars = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
    let randomStr = "fc_";
    for (let i = 0; i < 24; i++) {
      randomStr += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    
    const input = document.querySelector(`[data-key="ANTHROPIC_AUTH_TOKEN"]`);
    if (input) {
      input.value = randomStr;
      updateDirtyState();
      authTokenIsMasked = false;
      updateAuthTokenDisplay();
      showMessage("Generated secure API Token. Click 'Apply' at bottom to persist.", "ok");
    } else {
      showMessage("Auth token settings input not found", "error");
    }
  });
}

// ==================== 15. HTML5 BROWSER WEB NOTIFICATIONS TOGGLE ====================
function initNotificationsToggle() {
  const checkbox = byId("webNotificationsToggle");
  if (!checkbox) return;
  
  checkbox.checked = state.notificationsEnabled;
  checkbox.addEventListener("change", (e) => {
    const checked = e.target.checked;
    if (checked && "Notification" in window && Notification.permission !== "granted") {
      Notification.requestPermission().then(permission => {
        if (permission === "granted") {
          state.notificationsEnabled = true;
          localStorage.setItem("notifications_enabled", "true");
          new Notification("Notifications enabled for Helix diagnostics");
        } else {
          e.target.checked = false;
          state.notificationsEnabled = false;
          localStorage.setItem("notifications_enabled", "false");
        }
      });
    } else {
      state.notificationsEnabled = checked;
      localStorage.setItem("notifications_enabled", checked ? "true" : "false");
    }
  });
}

function initLogsControls() {
  const triggerPoll = () => {
    lastLogText = "";
    if (logsInterval) {
      stopLogsPolling();
      startLogsPolling();
    }
  };

  byId("logSearch").addEventListener("input", triggerPoll);
  byId("logLinesLimit").addEventListener("change", triggerPoll);

  byId("clearLogsBtn").addEventListener("click", () => {
    byId("logConsole").innerHTML = "";
    lastLogText = "";
  });
}

// ==================== LOGS STREAM WRAPPERS AND DOWNLOADS ====================
function initLogsAdvancedControls() {
  // 6. Log Filter Checkbox updates
  const levels = ["filterLogInfo", "filterLogWarn", "filterLogErr", "filterLogDebug"];
  levels.forEach(id => {
    byId(id).addEventListener("change", () => {
      lastLogText = "";
      startLogsPolling();
    });
  });
  
  // 7. Download entire log file API route trigger
  byId("downloadLogsBtn").addEventListener("click", () => {
    const downloadAnchor = document.createElement("a");
    downloadAnchor.href = "/admin/api/logs/download";
    downloadAnchor.download = "server.log";
    document.body.appendChild(downloadAnchor);
    downloadAnchor.click();
    downloadAnchor.remove();
  });
  
  // 8. Log polling Pause/Resume toggle
  const pauseBtn = byId("pauseLogsBtn");
  pauseBtn.addEventListener("click", () => {
    state.logsPaused = !state.logsPaused;
    if (state.logsPaused) {
      pauseBtn.textContent = "Resume Stream";
      stopLogsPolling();
    } else {
      pauseBtn.textContent = "Pause Stream";
      lastLogText = "";
      startLogsPolling();
    }
  });
  
  // 9. Word Wrap Toggle in log console styles
  const wrapCheckbox = byId("logWordWrap");
  const consoleEl = byId("logConsole");
  wrapCheckbox.addEventListener("change", (e) => {
    if (e.target.checked) {
      consoleEl.style.whiteSpace = "pre-wrap";
    } else {
      consoleEl.style.whiteSpace = "pre";
    }
  });
}

// ==================== DARK/LIGHT THEME CONTROLLER ====================
function initTheme() {
  const toggleBtn = byId("themeToggleBtn");
  const sunIcon = byId("themeToggleSun");
  const moonIcon = byId("themeToggleMoon");
  const textEl = byId("themeToggleText");

  function setTheme(theme) {
    if (theme === "light") {
      document.body.classList.add("light-mode");
      sunIcon.style.display = "block";
      moonIcon.style.display = "none";
      textEl.textContent = "Dark Mode";
      localStorage.setItem("theme", "light");
    } else {
      document.body.classList.remove("light-mode");
      sunIcon.style.display = "none";
      moonIcon.style.display = "block";
      textEl.textContent = "Light Mode";
      localStorage.setItem("theme", "dark");
    }
  }

  const savedTheme = localStorage.getItem("theme") || "dark";
  setTheme(savedTheme);

  toggleBtn.addEventListener("click", () => {
    const isLight = document.body.classList.contains("light-mode");
    setTheme(isLight ? "dark" : "light");
  });
}

// ==================== INITIALIZATION ====================
function initOnce() {
  initTheme();
  initBackup();
  initLogsControls();
  initLogsAdvancedControls();
  initPlaygroundControls();
  initPresets();
  initAuthTokenManager();
  initSettingsSearch();
  initNotificationsToggle();
  
  byId("validateButton").addEventListener("click", () => validate(true));
  byId("applyButton").addEventListener("click", apply);
  
  // 14. Network validation probe triggers
  byId("runDiagnosticBtn").addEventListener("click", runDiagnosticProbe);
  // 19. Restart trigger button binds
  byId("triggerRestartBtn").addEventListener("click", triggerSafeRestart);
}

initOnce();
load().catch((error) => {
  showMessage(error.message, "error");
});
