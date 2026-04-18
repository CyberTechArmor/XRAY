/**
 * XRay AI — Admin view registration.
 *
 * Registers the `admin_ai` view (settings, model, prompts, caps, API key,
 * per-dashboard enable, version history) and the sidebar nav entry so platform
 * admins can configure AI. Loaded from index.html before app.js fetches the
 * bundle; app.js merges it in via the __xrayExtensions array.
 */
(function() {
  'use strict';

  window.__xrayExtensions = window.__xrayExtensions || [];

  var viewHtml =
    '<div class="admin-ai-view">' +
      '<div class="sec-head"><div class="sec-title">AI Integration</div><div class="sec-desc">Platform-wide AI settings. Changes are versioned — every save creates a new immutable version with an optional note.</div></div>' +

      '<div class="card">' +
        '<div class="card-title">Anthropic API key</div>' +
        '<div class="card-desc">Stored encrypted at rest. Used for all AI calls across the platform.</div>' +
        '<div class="form-grid-1">' +
          '<div class="fg"><label>API key</label>' +
            '<input type="password" id="ai-api-key" placeholder="sk-ant-…" autocomplete="off">' +
            '<div id="ai-api-key-state" class="ai-key-state"></div>' +
          '</div>' +
        '</div>' +
        '<div class="form-actions">' +
          '<button class="btn primary" id="btn-ai-save-key">Save key</button>' +
          '<button class="btn danger" id="btn-ai-clear-key">Clear</button>' +
          '<span id="ai-key-status" style="font-size:13px;margin-left:8px"></span>' +
        '</div>' +
      '</div>' +

      '<div class="card">' +
        '<div class="card-title">Model & prompts</div>' +
        '<div class="card-desc">Pin a model snapshot (stable) or use an alias (auto-updates). Save to create a new version; you can roll back from the history below.</div>' +
        '<div class="form-grid-2">' +
          '<div class="fg"><label>Enabled (platform-wide)</label>' +
            '<label class="switch"><input type="checkbox" id="ai-enabled"><span></span></label>' +
          '</div>' +
          '<div class="fg"><label>Per-user daily message cap</label>' +
            '<input type="number" id="ai-cap" min="0" max="100000" step="1" value="100">' +
          '</div>' +
        '</div>' +
        '<div class="form-grid-1">' +
          '<div class="fg"><label>Model</label>' +
            '<select id="ai-model-picker" class="ai-model-picker"><option value="">Loading models…</option></select>' +
            '<div id="ai-model-pricing" class="ai-model-pricing"></div>' +
          '</div>' +
          '<div class="fg" id="ai-model-custom-row" style="display:none"><label>Custom model ID (pin a snapshot)</label>' +
            '<input type="text" id="ai-model" placeholder="claude-sonnet-4-6-YYYYMMDD">' +
            '<div class="ai-model-help">Paste an exact Anthropic model snapshot ID. Pricing shown above is based on the best matching entry in the catalog.</div>' +
          '</div>' +
          '<div class="fg"><label>System prompt</label>' +
            '<textarea id="ai-sys" rows="5" placeholder="Role, tone, behavior…"></textarea>' +
          '</div>' +
          '<div class="fg"><label>Guardrails</label>' +
            '<textarea id="ai-guard" rows="4" placeholder="Refusals, privacy rules, data boundaries…"></textarea>' +
          '</div>' +
          '<div class="fg"><label>Version note</label>' +
            '<input type="text" id="ai-note" placeholder="Why are you making this change?">' +
          '</div>' +
        '</div>' +
        '<div class="form-actions">' +
          '<button class="btn primary" id="btn-ai-save">Save new version</button>' +
          '<span id="ai-save-status" style="font-size:13px;margin-left:8px"></span>' +
        '</div>' +
      '</div>' +

      '<div class="card">' +
        '<div class="card-title">Per-dashboard AI</div>' +
        '<div class="card-desc">Enable the AI rail on specific dashboards. Only platform admins can change this. Users with access to an enabled dashboard get the rail on by default.</div>' +
        '<div id="ai-dash-list" class="ai-dash-list"><div class="ai-loading">Loading…</div></div>' +
      '</div>' +

      '<div class="card">' +
        '<div class="card-title">Version history</div>' +
        '<div class="card-desc">Every save creates a row. The most recent one is the active config.</div>' +
        '<div id="ai-versions" class="ai-versions"><div class="ai-loading">Loading…</div></div>' +
      '</div>' +
    '</div>';

  var viewCss =
    '.admin-ai-view .card{margin-bottom:16px;padding:18px;background:var(--bg2);border:1px solid var(--bdr);border-radius:10px}' +
    '.admin-ai-view .card-title{font-size:15px;font-weight:600;color:var(--t1);margin-bottom:4px}' +
    '.admin-ai-view .card-desc{font-size:13px;color:var(--t2);margin-bottom:12px;line-height:1.5}' +
    '.admin-ai-view .form-grid-1{display:grid;grid-template-columns:1fr;gap:14px}' +
    '.admin-ai-view .form-grid-2{display:grid;grid-template-columns:1fr 1fr;gap:14px;margin-bottom:14px}' +
    '.admin-ai-view .fg label{display:block;font-size:12px;color:var(--t2);margin-bottom:4px;font-weight:500;text-transform:uppercase;letter-spacing:.04em}' +
    '.admin-ai-view .fg input[type=text],.admin-ai-view .fg input[type=password],.admin-ai-view .fg input[type=number],.admin-ai-view .fg textarea{' +
      'width:100%;padding:9px 11px;font-size:13px;background:var(--bg3);border:1px solid var(--bdr);border-radius:6px;color:var(--t1);font-family:inherit;outline:none}' +
    '.admin-ai-view .fg textarea{font-family:var(--mono);resize:vertical;line-height:1.5}' +
    '.admin-ai-view .fg input:focus,.admin-ai-view .fg textarea:focus{border-color:var(--acc)}' +
    '.admin-ai-view .form-actions{margin-top:14px;display:flex;gap:8px;align-items:center}' +
    '.admin-ai-view .switch{position:relative;display:inline-block;width:42px;height:24px;cursor:pointer}' +
    '.admin-ai-view .switch input{opacity:0;width:0;height:0}' +
    '.admin-ai-view .switch span{position:absolute;inset:0;background:var(--bg3);border:1px solid var(--bdr);border-radius:12px;transition:.2s}' +
    '.admin-ai-view .switch span:before{content:"";position:absolute;height:16px;width:16px;left:3px;top:3px;background:var(--t2);border-radius:50%;transition:.2s}' +
    '.admin-ai-view .switch input:checked + span{background:var(--acc-dim);border-color:var(--acc)}' +
    '.admin-ai-view .switch input:checked + span:before{left:21px;background:var(--acc)}' +
    '.admin-ai-view .ai-key-state{font-size:12px;color:var(--t2);margin-top:4px}' +
    '.admin-ai-view .ai-key-state.set{color:var(--acc)}' +
    '.admin-ai-view .ai-dash-list{display:flex;flex-direction:column;gap:6px;max-height:320px;overflow-y:auto}' +
    '.admin-ai-view .ai-dash-row{display:flex;align-items:center;justify-content:space-between;padding:10px 12px;background:var(--bg3);border:1px solid var(--bdr);border-radius:6px}' +
    '.admin-ai-view .ai-dash-row .name{font-size:13px;color:var(--t1)}' +
    '.admin-ai-view .ai-dash-row .tenant{font-size:11px;color:var(--t3);margin-left:6px}' +
    '.admin-ai-view .ai-versions{display:flex;flex-direction:column;gap:6px}' +
    '.admin-ai-view .ai-version-row{padding:10px 12px;background:var(--bg3);border:1px solid var(--bdr);border-radius:6px;font-size:12px;color:var(--t2)}' +
    '.admin-ai-view .ai-version-row .v-head{display:flex;justify-content:space-between;margin-bottom:4px}' +
    '.admin-ai-view .ai-version-row .v-model{color:var(--acc);font-family:var(--mono);font-size:12px}' +
    '.admin-ai-view .ai-version-row .v-note{color:var(--t1);font-style:italic;margin-top:4px}' +
    '.admin-ai-view .ai-loading{font-size:13px;color:var(--t3);padding:8px}' +
    '.admin-ai-view .ai-restore{font-size:11px;padding:4px 8px;background:transparent;border:1px solid var(--bdr);color:var(--t2);border-radius:4px;cursor:pointer}' +
    '.admin-ai-view .ai-restore:hover{border-color:var(--acc);color:var(--acc)}' +
    '.admin-ai-view .ai-model-picker{width:100%;padding:9px 11px;font-size:13px;background:var(--bg3);border:1px solid var(--bdr);border-radius:6px;color:var(--t1);font-family:inherit;outline:none}' +
    '.admin-ai-view .ai-model-picker:focus{border-color:var(--acc)}' +
    '.admin-ai-view .ai-model-pricing{margin-top:8px;display:flex;flex-wrap:wrap;gap:6px;font-size:11px;color:var(--t3);min-height:20px}' +
    '.admin-ai-view .ai-price-chip{padding:3px 8px;background:var(--bg3);border:1px solid var(--bdr);border-radius:10px;display:inline-flex;align-items:center;gap:4px}' +
    '.admin-ai-view .ai-price-chip.tier{border-color:var(--acc);color:var(--acc);background:var(--acc-dim,rgba(62,232,181,0.08))}' +
    '.admin-ai-view .ai-price-chip b{color:var(--t1);font-weight:500}' +
    '.admin-ai-view .ai-price-desc{font-size:12px;color:var(--t2);margin-top:6px;font-style:italic;line-height:1.4}' +
    '.admin-ai-view .ai-model-help{font-size:11px;color:var(--t3);margin-top:4px;line-height:1.4}';

  var viewJs =
    'function initAdminAI(container, api, user) {' +
      'function $(s) { return container.querySelector(s); }' +
      'function setStatus(el, text, kind) { el = typeof el === "string" ? $(el) : el; if (!el) return; el.textContent = text || ""; el.style.color = kind === "error" ? "var(--danger)" : kind === "success" ? "var(--acc)" : "var(--t2)"; }' +

      'var modelsCatalog = [];' +
      'var pendingModelId = null;' +

      // Resolve catalog entry for an arbitrary model id (exact match, then prefix)
      'function findModel(id) {' +
        'if (!id) return null;' +
        'var exact = modelsCatalog.filter(function(m){return m.model_id===id;})[0];' +
        'if (exact) return exact;' +
        'var prefix = modelsCatalog.filter(function(m){return id.indexOf(m.model_id)===0;}).sort(function(a,b){return b.model_id.length-a.model_id.length;})[0];' +
        'return prefix || null;' +
      '}' +

      // Render pricing chips below the dropdown
      'function renderPricing(id) {' +
        'var m = findModel(id);' +
        'var el = $("#ai-model-pricing"); if (!el) return;' +
        'if (!m) { el.innerHTML = "<span class=\\"ai-price-chip\\">No catalog entry for <b>" + escapeHtml(id || "—") + "</b> — cost tracking disabled.</span>"; return; }' +
        'function fmt(n){ return n != null ? "$" + Number(n).toFixed(n < 1 ? 2 : 2) : "—"; }' +
        'var tierLabel = m.tier ? m.tier.charAt(0).toUpperCase() + m.tier.slice(1) : "";' +
        'var chips = "";' +
        'if (tierLabel) chips += "<span class=\\"ai-price-chip tier\\">" + escapeHtml(tierLabel) + "</span>";' +
        'chips += "<span class=\\"ai-price-chip\\">Input <b>" + fmt(m.input_per_million) + "</b>/MTok</span>";' +
        'chips += "<span class=\\"ai-price-chip\\">Output <b>" + fmt(m.output_per_million) + "</b>/MTok</span>";' +
        'if (m.cache_read_per_million) chips += "<span class=\\"ai-price-chip\\">Cache read <b>" + fmt(m.cache_read_per_million) + "</b>/MTok</span>";' +
        'if (m.cache_write_per_million) chips += "<span class=\\"ai-price-chip\\">Cache write <b>" + fmt(m.cache_write_per_million) + "</b>/MTok</span>";' +
        'if (m.context_window) chips += "<span class=\\"ai-price-chip\\">Context <b>" + (m.context_window / 1000) + "K</b></span>";' +
        'if (m.description) chips += "<div class=\\"ai-price-desc\\" style=\\"flex-basis:100%;margin-top:4px\\">" + escapeHtml(m.description) + "</div>";' +
        'el.innerHTML = chips;' +
      '}' +

      // Rebuild the dropdown from modelsCatalog, grouped by tier. Selection defaults to
      // pendingModelId if set, else to the most recently-saved current model.
      'function populatePicker() {' +
        'var sel = $("#ai-model-picker"); if (!sel) return;' +
        'var tiers = { flagship: [], standard: [], fast: [] };' +
        'modelsCatalog.forEach(function(m) {' +
          'var t = tiers[m.tier] ? m.tier : "standard";' +
          'tiers[t].push(m);' +
        '});' +
        'function fmt(n){ return "$" + Number(n).toFixed(2); }' +
        'function optLabel(m) { return m.display_name + " — in " + fmt(m.input_per_million) + " / out " + fmt(m.output_per_million); }' +
        'var html = "";' +
        '["flagship","standard","fast"].forEach(function(t) {' +
          'if (!tiers[t].length) return;' +
          'html += "<optgroup label=\\"" + escapeHtml(t.charAt(0).toUpperCase() + t.slice(1)) + "\\">";' +
          'tiers[t].forEach(function(m){ html += "<option value=\\"" + escapeHtml(m.model_id) + "\\">" + escapeHtml(optLabel(m)) + "</option>"; });' +
          'html += "</optgroup>";' +
        '});' +
        'html += "<option value=\\"__custom\\">Custom — pin a specific snapshot ID…</option>";' +
        'sel.innerHTML = html;' +

        // Apply pending selection
        'if (pendingModelId) applyModelSelection(pendingModelId);' +
      '}' +

      'function applyModelSelection(modelId) {' +
        'var sel = $("#ai-model-picker"); var custom = $("#ai-model-custom-row"); var input = $("#ai-model");' +
        'if (!sel) { pendingModelId = modelId; return; }' +
        'var hasOption = Array.prototype.some.call(sel.options, function(o){ return o.value === modelId; });' +
        'if (hasOption) {' +
          'sel.value = modelId; custom.style.display = "none"; input.value = ""; renderPricing(modelId);' +
        '} else if (modelId) {' +
          'sel.value = "__custom"; custom.style.display = ""; input.value = modelId; renderPricing(modelId);' +
        '} else {' +
          'sel.selectedIndex = 0; custom.style.display = "none"; input.value = ""; renderPricing(sel.value);' +
        '}' +
        'pendingModelId = null;' +
      '}' +

      'function loadModels() {' +
        'return api.get("/api/admin/ai/models").then(function(r) {' +
          'if (!r.ok) { modelsCatalog = []; } else { modelsCatalog = r.data || []; }' +
          'populatePicker();' +
        '}).catch(function() { modelsCatalog = []; populatePicker(); });' +
      '}' +

      'function selectedModelId() {' +
        'var sel = $("#ai-model-picker"); if (!sel) return "";' +
        'if (sel.value === "__custom") return ($("#ai-model").value || "").trim();' +
        'return sel.value;' +
      '}' +

      // Load current settings
      'function loadSettings() {' +
        'return api.get("/api/admin/ai/settings").then(function(r) {' +
          'if (!r.ok) { setStatus("#ai-save-status", (r.error && r.error.message) || "Failed to load", "error"); return; }' +
          'var s = r.data.current;' +
          '$("#ai-enabled").checked = !!s.enabled;' +
          '$("#ai-cap").value = s.per_user_daily_cap;' +
          'applyModelSelection(s.model_id || "");' +
          '$("#ai-sys").value = s.system_prompt || "";' +
          '$("#ai-guard").value = s.guardrails || "";' +
          '$("#ai-note").value = "";' +
          'var keyState = $("#ai-api-key-state");' +
          'if (r.data.api_key_configured) { keyState.textContent = "API key is set. Leave blank to keep unchanged."; keyState.classList.add("set"); }' +
          'else { keyState.textContent = "No API key configured — AI is effectively disabled."; keyState.classList.remove("set"); }' +
        '}).catch(function() { setStatus("#ai-save-status", "Network error", "error"); });' +
      '}' +

      'function loadVersions() {' +
        'api.get("/api/admin/ai/settings/versions").then(function(r) {' +
          'var el = $("#ai-versions"); if (!el) return;' +
          'if (!r.ok || !r.data || r.data.length === 0) { el.innerHTML = "<div class=\\"ai-loading\\">No versions yet.</div>"; return; }' +
          'el.innerHTML = r.data.map(function(v, i) {' +
            'var who = v.author_name || v.author_email || "unknown";' +
            'var when = new Date(v.effective_at).toLocaleString();' +
            'var tag = i === 0 ? "<span style=\\"color:var(--acc);font-weight:600\\">ACTIVE</span>" : "";' +
            'return "<div class=\\"ai-version-row\\"><div class=\\"v-head\\"><span class=\\"v-model\\">" + escapeHtml(v.model_id) + "</span><span>" + tag + " " + escapeHtml(who) + " · " + escapeHtml(when) + "</span></div>" +' +
              '"<div>cap=" + v.per_user_daily_cap + " · enabled=" + (v.enabled ? "yes" : "no") + "</div>" +' +
              '(v.note ? "<div class=\\"v-note\\">" + escapeHtml(v.note) + "</div>" : "") +' +
            '"</div>";' +
          '}).join("");' +
        '});' +
      '}' +

      'function loadDashboards() {' +
        'api.get("/api/admin/ai/dashboards").then(function(r) {' +
          'var el = $("#ai-dash-list"); if (!el) return;' +
          'if (!r.ok || !r.data) { el.innerHTML = "<div class=\\"ai-loading\\">Failed to load dashboards.</div>"; return; }' +
          'if (r.data.length === 0) { el.innerHTML = "<div class=\\"ai-loading\\">No dashboards yet.</div>"; return; }' +
          'el.innerHTML = r.data.map(function(d) {' +
            'return "<div class=\\"ai-dash-row\\" data-id=\\"" + d.dashboard_id + "\\">" +' +
              '"<div><span class=\\"name\\">" + escapeHtml(d.dashboard_name) + "</span><span class=\\"tenant\\">" + escapeHtml(d.tenant_name) + "</span></div>" +' +
              '"<label class=\\"switch\\"><input type=\\"checkbox\\" data-dash=\\"" + d.dashboard_id + "\\"" + (d.enabled ? " checked" : "") + "><span></span></label>" +' +
            '"</div>";' +
          '}).join("");' +
          'el.querySelectorAll("input[data-dash]").forEach(function(cb) {' +
            'cb.onchange = function() {' +
              'var id = this.getAttribute("data-dash");' +
              'var enabled = this.checked;' +
              'cb.disabled = true;' +
              'api.patch("/api/admin/ai/dashboards/" + id, { enabled: enabled }).then(function(r) {' +
                'cb.disabled = false;' +
                'if (!r.ok) { cb.checked = !enabled; if (window.__xrayToast) window.__xrayToast((r.error && r.error.message) || "Failed", "error"); }' +
              '}).catch(function() { cb.checked = !enabled; cb.disabled = false; });' +
            '};' +
          '});' +
        '});' +
      '}' +

      'function escapeHtml(s) { return String(s == null ? "" : s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;"); }' +

      '$("#btn-ai-save-key").onclick = function() {' +
        'var val = ($("#ai-api-key").value || "").trim();' +
        'if (!val) { setStatus("#ai-key-status", "Enter a key first", "error"); return; }' +
        'this.disabled = true;' +
        'api.patch("/api/admin/ai/settings/api-key", { api_key: val }).then(function(r) {' +
          '$("#btn-ai-save-key").disabled = false;' +
          'if (!r.ok) { setStatus("#ai-key-status", (r.error && r.error.message) || "Failed", "error"); return; }' +
          '$("#ai-api-key").value = "";' +
          'setStatus("#ai-key-status", "Saved", "success");' +
          'loadSettings();' +
        '});' +
      '};' +

      '$("#btn-ai-clear-key").onclick = function() {' +
        'if (!confirm("Clear the API key? AI will stop working until a new key is provided.")) return;' +
        'this.disabled = true;' +
        'api.patch("/api/admin/ai/settings/api-key", { api_key: null }).then(function(r) {' +
          '$("#btn-ai-clear-key").disabled = false;' +
          'if (!r.ok) { setStatus("#ai-key-status", (r.error && r.error.message) || "Failed", "error"); return; }' +
          'setStatus("#ai-key-status", "Cleared", "success");' +
          'loadSettings();' +
        '});' +
      '};' +

      '$("#btn-ai-save").onclick = function() {' +
        'var payload = {' +
          'enabled: $("#ai-enabled").checked,' +
          'per_user_daily_cap: parseInt($("#ai-cap").value, 10) || 0,' +
          'model_id: selectedModelId(),' +
          'system_prompt: $("#ai-sys").value || "",' +
          'guardrails: $("#ai-guard").value || "",' +
          'note: ($("#ai-note").value || "").trim() || null' +
        '};' +
        'if (!payload.model_id) { setStatus("#ai-save-status", "Pick a model (or paste a snapshot ID)", "error"); return; }' +
        'this.disabled = true;' +
        'api.post("/api/admin/ai/settings", payload).then(function(r) {' +
          '$("#btn-ai-save").disabled = false;' +
          'if (!r.ok) { setStatus("#ai-save-status", (r.error && r.error.message) || "Failed", "error"); return; }' +
          'setStatus("#ai-save-status", "Saved new version", "success");' +
          'loadSettings(); loadVersions();' +
        '});' +
      '};' +

      // Model picker events
      '$("#ai-model-picker").addEventListener("change", function() {' +
        'var sel = this; var custom = $("#ai-model-custom-row"); var input = $("#ai-model");' +
        'if (sel.value === "__custom") { custom.style.display = ""; renderPricing(input.value); input.focus(); }' +
        'else { custom.style.display = "none"; input.value = ""; renderPricing(sel.value); }' +
      '});' +
      '$("#ai-model").addEventListener("input", function() { renderPricing(this.value); });' +

      // Initial load: models first (picker needs to be populated), then settings fill it in
      'loadModels().then(loadSettings);' +
      'loadDashboards();' +
      'loadVersions();' +
    '}';

  window.__xrayExtensions.push({
    viewName: 'admin_ai',
    view: { html: viewHtml, css: viewCss, js: viewJs },
    nav: { section: 'platform', view: 'admin_ai', label: 'AI', icon: 'grid', permission: 'platform.admin' }
  });
})();
