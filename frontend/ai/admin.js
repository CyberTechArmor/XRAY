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
        '<div class="card-title">Usage & cost</div>' +
        '<div class="card-desc">Tokens, computed cost, and feedback ratings. Use the range selector to change the window and the grouping tabs to break down.</div>' +
        '<div class="ai-usage-controls">' +
          '<div class="ai-usage-range">' +
            '<button class="ai-usage-chip" data-range="7">7d</button>' +
            '<button class="ai-usage-chip active" data-range="30">30d</button>' +
            '<button class="ai-usage-chip" data-range="90">90d</button>' +
            '<button class="ai-usage-chip" data-range="365">1y</button>' +
          '</div>' +
          '<div class="ai-usage-tabs">' +
            '<button class="ai-usage-tab active" data-group="day">By day</button>' +
            '<button class="ai-usage-tab" data-group="tenant">By tenant</button>' +
            '<button class="ai-usage-tab" data-group="user">By user</button>' +
            '<button class="ai-usage-tab" data-group="model">By model</button>' +
          '</div>' +
        '</div>' +
        '<div class="ai-usage-totals" id="ai-usage-totals"><div class="ai-loading">Loading…</div></div>' +
        '<div class="ai-usage-table-wrap"><table class="ai-usage-table" id="ai-usage-table"><thead></thead><tbody></tbody></table></div>' +
      '</div>' +

      '<div class="card">' +
        '<div class="card-title">Conversations</div>' +
        '<div class="card-desc">All Q&amp;A pairs across tenants for analysis. Filter by rating, search content, or click a row to expand the full question + answer + rating note.</div>' +
        '<div class="ai-convo-controls">' +
          '<div class="ai-convo-ratings">' +
            '<button class="ai-convo-chip active" data-convo-rating="">All</button>' +
            '<button class="ai-convo-chip" data-convo-rating="1">👍 Helpful</button>' +
            '<button class="ai-convo-chip" data-convo-rating="-1">👎 Not helpful</button>' +
            '<button class="ai-convo-chip" data-convo-rating="0">Unrated</button>' +
          '</div>' +
          '<input type="search" id="ai-convo-search" placeholder="Search question or answer…">' +
        '</div>' +
        '<div id="ai-convo-list" class="ai-convo-list"><div class="ai-loading">Loading…</div></div>' +
        '<div class="ai-convo-foot"><span id="ai-convo-count" class="ai-convo-count"></span><button class="btn" id="ai-convo-more" style="display:none">Load more</button></div>' +
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
    '.admin-ai-view .ai-model-help{font-size:11px;color:var(--t3);margin-top:4px;line-height:1.4}' +
    /* ── Usage card ── */
    '.admin-ai-view .ai-usage-controls{display:flex;justify-content:space-between;align-items:center;margin-bottom:14px;gap:12px;flex-wrap:wrap}' +
    '.admin-ai-view .ai-usage-range,.admin-ai-view .ai-usage-tabs{display:inline-flex;background:var(--bg3);border:1px solid var(--bdr);border-radius:6px;padding:2px}' +
    '.admin-ai-view .ai-usage-chip,.admin-ai-view .ai-usage-tab{padding:5px 10px;font-size:12px;background:transparent;border:none;color:var(--t2);border-radius:4px;cursor:pointer}' +
    '.admin-ai-view .ai-usage-chip:hover,.admin-ai-view .ai-usage-tab:hover{color:var(--t1)}' +
    '.admin-ai-view .ai-usage-chip.active,.admin-ai-view .ai-usage-tab.active{background:var(--acc);color:var(--acc-dk)}' +
    '.admin-ai-view .ai-usage-totals{display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:10px;margin-bottom:14px}' +
    '.admin-ai-view .ai-stat{padding:12px;background:var(--bg3);border:1px solid var(--bdr);border-radius:8px}' +
    '.admin-ai-view .ai-stat-label{font-size:10px;letter-spacing:.08em;text-transform:uppercase;color:var(--t3);font-weight:600;margin-bottom:4px}' +
    '.admin-ai-view .ai-stat-value{font-size:18px;color:var(--t1);font-weight:600;font-family:var(--mono,monospace)}' +
    '.admin-ai-view .ai-stat-sub{font-size:11px;color:var(--t2);margin-top:2px}' +
    '.admin-ai-view .ai-stat-value.up{color:var(--acc)}' +
    '.admin-ai-view .ai-stat-value.down{color:var(--danger)}' +
    '.admin-ai-view .ai-stat-value.accent{color:var(--acc)}' +
    '.admin-ai-view .ai-usage-table-wrap{max-height:380px;overflow:auto;border:1px solid var(--bdr);border-radius:6px}' +
    '.admin-ai-view .ai-usage-table{width:100%;border-collapse:collapse;font-size:12px}' +
    '.admin-ai-view .ai-usage-table th{background:var(--bg3);color:var(--t2);font-weight:500;text-align:left;padding:8px 10px;font-size:10px;letter-spacing:.06em;text-transform:uppercase;position:sticky;top:0;border-bottom:1px solid var(--bdr)}' +
    '.admin-ai-view .ai-usage-table td{padding:7px 10px;border-bottom:1px solid var(--bdr);color:var(--t1);font-family:var(--mono,monospace);font-size:12px}' +
    '.admin-ai-view .ai-usage-table td.num{text-align:right}' +
    '.admin-ai-view .ai-usage-table td.label{font-family:var(--font);color:var(--t1)}' +
    '.admin-ai-view .ai-usage-table td.label .sub{color:var(--t3);font-size:11px;margin-left:4px}' +
    '.admin-ai-view .ai-usage-table tr:hover td{background:var(--bg3)}' +
    '.admin-ai-view .ai-usage-table td.cost{color:var(--acc)}' +
    '.admin-ai-view .ai-usage-table td.up-count{color:var(--acc)}' +
    '.admin-ai-view .ai-usage-table td.down-count{color:var(--danger)}' +
    '.admin-ai-view .ai-usage-empty{padding:24px;text-align:center;color:var(--t3);font-size:12px}' +
    /* ── Conversations card ── */
    '.admin-ai-view .ai-convo-controls{display:flex;justify-content:space-between;align-items:center;gap:12px;margin-bottom:14px;flex-wrap:wrap}' +
    '.admin-ai-view .ai-convo-ratings{display:inline-flex;background:var(--bg3);border:1px solid var(--bdr);border-radius:6px;padding:2px}' +
    '.admin-ai-view .ai-convo-chip{padding:5px 10px;font-size:12px;background:transparent;border:none;color:var(--t2);border-radius:4px;cursor:pointer}' +
    '.admin-ai-view .ai-convo-chip:hover{color:var(--t1)}' +
    '.admin-ai-view .ai-convo-chip.active{background:var(--acc);color:var(--acc-dk)}' +
    '.admin-ai-view #ai-convo-search{min-width:240px;flex:1;max-width:360px;padding:7px 10px;font-size:13px;background:var(--bg3);border:1px solid var(--bdr);border-radius:6px;color:var(--t1);outline:none}' +
    '.admin-ai-view #ai-convo-search:focus{border-color:var(--acc)}' +
    '.admin-ai-view .ai-convo-list{display:flex;flex-direction:column;gap:4px;max-height:520px;overflow-y:auto}' +
    '.admin-ai-view .ai-convo-row{background:var(--bg3);border:1px solid var(--bdr);border-radius:6px;padding:10px 12px;cursor:pointer;transition:border-color .12s}' +
    '.admin-ai-view .ai-convo-row:hover{border-color:var(--bdr2)}' +
    '.admin-ai-view .ai-convo-row.expanded{border-color:var(--acc)}' +
    '.admin-ai-view .ai-convo-meta{display:flex;justify-content:space-between;align-items:center;font-size:11px;color:var(--t3);margin-bottom:4px;gap:8px;flex-wrap:wrap}' +
    '.admin-ai-view .ai-convo-meta .who{color:var(--t1);font-weight:500;font-size:12px}' +
    '.admin-ai-view .ai-convo-meta .who .sub{color:var(--t3);font-weight:400;margin-left:6px;font-size:11px}' +
    '.admin-ai-view .ai-convo-meta .rating{font-size:12px}' +
    '.admin-ai-view .ai-convo-meta .rating.up{color:var(--acc)}' +
    '.admin-ai-view .ai-convo-meta .rating.down{color:var(--danger)}' +
    '.admin-ai-view .ai-convo-meta .model{font-family:var(--mono,monospace);font-size:10px;color:var(--t3)}' +
    '.admin-ai-view .ai-convo-meta .cost{color:var(--acc);font-family:var(--mono,monospace);font-size:11px}' +
    '.admin-ai-view .ai-convo-q{color:var(--t1);font-size:13px;line-height:1.45}' +
    '.admin-ai-view .ai-convo-row:not(.expanded) .ai-convo-q{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}' +
    '.admin-ai-view .ai-convo-a{color:var(--t2);font-size:12px;line-height:1.45;margin-top:4px}' +
    '.admin-ai-view .ai-convo-row:not(.expanded) .ai-convo-a{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}' +
    '.admin-ai-view .ai-convo-full{margin-top:10px;padding-top:10px;border-top:1px solid var(--bdr);display:none}' +
    '.admin-ai-view .ai-convo-row.expanded .ai-convo-full{display:block}' +
    '.admin-ai-view .ai-convo-full-q,.admin-ai-view .ai-convo-full-a{white-space:pre-wrap;font-size:13px;line-height:1.55;background:var(--bg2);border:1px solid var(--bdr);border-radius:6px;padding:10px;margin-top:6px}' +
    '.admin-ai-view .ai-convo-full-q{color:var(--t1);border-left:3px solid var(--blue,#5a9ee8)}' +
    '.admin-ai-view .ai-convo-full-a{color:var(--t1);border-left:3px solid var(--acc)}' +
    '.admin-ai-view .ai-convo-rating-note{margin-top:8px;font-size:12px;font-style:italic;color:var(--t2);padding:8px;background:var(--bg2);border-radius:6px}' +
    '.admin-ai-view .ai-convo-foot{display:flex;justify-content:space-between;align-items:center;margin-top:10px;gap:10px}' +
    '.admin-ai-view .ai-convo-count{font-size:12px;color:var(--t3)}';

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

      // ── Usage card ────────────────────────────────────────────────────
      'var usageState = { groupBy: "day", rangeDays: 30 };' +
      'function fmtMoney(n) { n = Number(n || 0); if (n === 0) return "$0.00"; if (n < 0.01) return "$" + n.toFixed(4); if (n < 10) return "$" + n.toFixed(3); return "$" + n.toFixed(2); }' +
      'function fmtTokens(n) { n = Number(n || 0); if (n < 1000) return String(n); if (n < 1e6) return (n / 1000).toFixed(1) + "K"; return (n / 1e6).toFixed(2) + "M"; }' +
      'function fmtDate(s) { try { return new Date(s).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" }); } catch(e) { return s; } }' +

      'function renderTotals(t) {' +
        'var el = $("#ai-usage-totals"); if (!el) return;' +
        'if (!t || !t.message_count) {' +
          'el.innerHTML = "<div class=\\"ai-usage-empty\\" style=\\"grid-column:1/-1\\">No messages in this range.</div>"; return;' +
        '}' +
        'el.innerHTML = ' +
          '"<div class=\\"ai-stat\\"><div class=\\"ai-stat-label\\">Messages</div><div class=\\"ai-stat-value\\">" + t.message_count + "</div></div>" +' +
          '"<div class=\\"ai-stat\\"><div class=\\"ai-stat-label\\">Total cost</div><div class=\\"ai-stat-value accent\\">" + fmtMoney(t.cost_total_usd) + "</div><div class=\\"ai-stat-sub\\">in " + fmtMoney(t.cost_input_usd) + " · out " + fmtMoney(t.cost_output_usd) + "</div></div>" +' +
          '"<div class=\\"ai-stat\\"><div class=\\"ai-stat-label\\">Input tokens</div><div class=\\"ai-stat-value\\">" + fmtTokens(t.input_tokens) + "</div></div>" +' +
          '"<div class=\\"ai-stat\\"><div class=\\"ai-stat-label\\">Output tokens</div><div class=\\"ai-stat-value\\">" + fmtTokens(t.output_tokens) + "</div></div>" +' +
          '"<div class=\\"ai-stat\\"><div class=\\"ai-stat-label\\">Cache read / write</div><div class=\\"ai-stat-value\\">" + fmtTokens(t.cache_read_tokens) + " / " + fmtTokens(t.cache_write_tokens) + "</div></div>" +' +
          '"<div class=\\"ai-stat\\"><div class=\\"ai-stat-label\\">Ratings</div><div class=\\"ai-stat-value\\"><span class=\\"up\\">" + (t.thumbs_up || 0) + "👍</span> <span class=\\"down\\" style=\\"margin-left:8px\\">" + (t.thumbs_down || 0) + "👎</span></div></div>";' +
      '}' +

      'function renderRows(rows, groupBy) {' +
        'var table = $("#ai-usage-table"); if (!table) return;' +
        'var thead = table.querySelector("thead"); var tbody = table.querySelector("tbody");' +
        'if (!rows || rows.length === 0) {' +
          'thead.innerHTML = ""; tbody.innerHTML = "<tr><td class=\\"ai-usage-empty\\" colspan=\\"7\\">No data.</td></tr>"; return;' +
        '}' +
        'var cols;' +
        'if (groupBy === "day") cols = ["Day", "Model", "Msgs", "In tok", "Out tok", "Cost", "👍 / 👎"];' +
        'else if (groupBy === "tenant") cols = ["Tenant", "Msgs", "In tok", "Out tok", "Cost", "👍 / 👎"];' +
        'else if (groupBy === "user") cols = ["User", "Msgs", "In tok", "Out tok", "Cost", "👍 / 👎"];' +
        'else cols = ["Model", "Msgs", "In tok", "Out tok", "Cost", "👍 / 👎"];' +
        'thead.innerHTML = "<tr>" + cols.map(function(c, i) { return "<th class=\\"" + (i >= (groupBy==="day"?2:1) ? "num" : "") + "\\">" + escapeHtml(c) + "</th>"; }).join("") + "</tr>";' +
        'tbody.innerHTML = rows.map(function(r) {' +
          'var leftCells = "";' +
          'if (groupBy === "day") {' +
            'leftCells = "<td class=\\"label\\">" + (r.period_start ? escapeHtml(fmtDate(r.period_start)) : "—") + "</td>" +' +
              '"<td class=\\"label\\"><code style=\\"font-size:11px;color:var(--t2)\\">" + escapeHtml(r.model_id || "—") + "</code></td>";' +
          '} else if (groupBy === "tenant") {' +
            'leftCells = "<td class=\\"label\\">" + escapeHtml(r.tenant_name || "—") + "</td>";' +
          '} else if (groupBy === "user") {' +
            'leftCells = "<td class=\\"label\\">" + escapeHtml(r.user_name || r.user_email || "—") + "<span class=\\"sub\\">" + escapeHtml(r.user_email || "") + "</span></td>";' +
          '} else {' +
            'leftCells = "<td class=\\"label\\"><code style=\\"font-size:11px;color:var(--t2)\\">" + escapeHtml(r.model_id || "—") + "</code></td>";' +
          '}' +
          'return "<tr>" + leftCells +' +
            '"<td class=\\"num\\">" + r.message_count + "</td>" +' +
            '"<td class=\\"num\\">" + fmtTokens(r.input_tokens) + "</td>" +' +
            '"<td class=\\"num\\">" + fmtTokens(r.output_tokens) + "</td>" +' +
            '"<td class=\\"num cost\\">" + fmtMoney(r.cost_total_usd) + "</td>" +' +
            '"<td class=\\"num\\"><span class=\\"up-count\\">" + (r.thumbs_up || 0) + "</span> / <span class=\\"down-count\\">" + (r.thumbs_down || 0) + "</span></td>" +' +
          '"</tr>";' +
        '}).join("");' +
      '}' +

      'function loadUsage() {' +
        'var from = new Date(Date.now() - usageState.rangeDays * 86400 * 1000).toISOString();' +
        'var url = "/api/admin/ai/usage?groupBy=" + usageState.groupBy + "&from=" + encodeURIComponent(from);' +
        'return api.get(url).then(function(r) {' +
          'if (!r.ok) { renderTotals(null); renderRows([], usageState.groupBy); return; }' +
          'renderTotals(r.data.totals);' +
          'renderRows(r.data.rows, usageState.groupBy);' +
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

      // ── Conversations browser ────────────────────────────────────────
      'var convoState = { rating: "", search: "", limit: 25, offset: 0, total: 0, rows: [] };' +
      'var convoSearchTimer = null;' +

      'function renderConvoList() {' +
        'var el = $("#ai-convo-list"); if (!el) return;' +
        'if (convoState.rows.length === 0) { el.innerHTML = "<div class=\\"ai-usage-empty\\">No conversations match.</div>"; $("#ai-convo-count").textContent = "0 results"; $("#ai-convo-more").style.display = "none"; return; }' +
        'el.innerHTML = convoState.rows.map(function(r, i) {' +
          'var ratingHtml = "";' +
          'if (r.rating === 1) ratingHtml = "<span class=\\"rating up\\">👍</span>";' +
          'else if (r.rating === -1) ratingHtml = "<span class=\\"rating down\\">👎</span>";' +
          'else ratingHtml = "<span class=\\"rating\\" style=\\"color:var(--t3)\\">—</span>";' +
          'var when = new Date(r.created_at).toLocaleString();' +
          'return "<div class=\\"ai-convo-row\\" data-idx=\\"" + i + "\\">" +' +
            '"<div class=\\"ai-convo-meta\\">" +' +
              '"<span class=\\"who\\">" + escapeHtml(r.user_name || r.user_email || "?") + "<span class=\\"sub\\">" + escapeHtml(r.tenant_name || "") + " · " + escapeHtml(r.dashboard_name || "") + "</span></span>" +' +
              '"<span>" + ratingHtml + " <span class=\\"cost\\">" + fmtMoney(r.cost_total_usd) + "</span> <span class=\\"model\\">" + escapeHtml(r.model_id || "?") + "</span> <span>" + escapeHtml(when) + "</span></span>" +' +
            '"</div>" +' +
            '"<div class=\\"ai-convo-q\\"><b>Q:</b> " + escapeHtml(r.question || "(no question)") + "</div>" +' +
            '"<div class=\\"ai-convo-a\\"><b>A:</b> " + escapeHtml(stripActions(r.answer || "")) + "</div>" +' +
            '"<div class=\\"ai-convo-full\\">" +' +
              '"<div style=\\"font-size:11px;color:var(--t3);text-transform:uppercase;letter-spacing:.08em;font-weight:600\\">Question</div>" +' +
              '"<div class=\\"ai-convo-full-q\\">" + escapeHtml(r.question || "") + "</div>" +' +
              '"<div style=\\"font-size:11px;color:var(--t3);text-transform:uppercase;letter-spacing:.08em;font-weight:600;margin-top:10px\\">Answer</div>" +' +
              '"<div class=\\"ai-convo-full-a\\">" + escapeHtml(stripActions(r.answer || "")) + "</div>" +' +
              '(r.rating_note ? "<div class=\\"ai-convo-rating-note\\"><b>Rating note:</b> " + escapeHtml(r.rating_note) + "</div>" : "") +' +
              '"<div style=\\"font-size:11px;color:var(--t3);margin-top:8px\\">Msg ID <code>" + escapeHtml(r.assistant_message_id) + "</code> · " + r.input_tokens + " in / " + r.output_tokens + " out tok</div>" +' +
            '"</div>" +' +
          '"</div>";' +
        '}).join("");' +
        'el.querySelectorAll(".ai-convo-row").forEach(function(row) {' +
          'row.onclick = function() { row.classList.toggle("expanded"); };' +
        '});' +
        '$("#ai-convo-count").textContent = "Showing " + convoState.rows.length + " of " + convoState.total;' +
        '$("#ai-convo-more").style.display = convoState.rows.length < convoState.total ? "" : "none";' +
      '}' +

      'function stripActions(s) { return (s || "").replace(/```xray-actions[\\s\\S]*?```/g, "").trim(); }' +

      'function loadConversations(append) {' +
        'if (!append) { convoState.offset = 0; convoState.rows = []; $("#ai-convo-list").innerHTML = "<div class=\\"ai-loading\\">Loading…</div>"; }' +
        'var params = ["limit=" + convoState.limit, "offset=" + convoState.offset];' +
        'if (convoState.rating !== "") params.push("rating=" + encodeURIComponent(convoState.rating));' +
        'if (convoState.search) params.push("search=" + encodeURIComponent(convoState.search));' +
        'return api.get("/api/admin/ai/conversations?" + params.join("&")).then(function(r) {' +
          'if (!r.ok) { $("#ai-convo-list").innerHTML = "<div class=\\"ai-usage-empty\\">Failed to load.</div>"; return; }' +
          'var newRows = r.data || [];' +
          'convoState.total = (r.meta && r.meta.total) || newRows.length;' +
          'convoState.rows = append ? convoState.rows.concat(newRows) : newRows;' +
          'convoState.offset = convoState.rows.length;' +
          'renderConvoList();' +
        '});' +
      '}' +

      // Usage card: range + grouping toggles
      'container.querySelectorAll(".ai-usage-chip").forEach(function(b){' +
        'b.onclick = function() {' +
          'container.querySelectorAll(".ai-usage-chip").forEach(function(x){x.classList.remove("active");});' +
          'this.classList.add("active");' +
          'usageState.rangeDays = parseInt(this.getAttribute("data-range"), 10) || 30;' +
          'loadUsage();' +
        '};' +
      '});' +
      'container.querySelectorAll(".ai-usage-tab").forEach(function(b){' +
        'b.onclick = function() {' +
          'container.querySelectorAll(".ai-usage-tab").forEach(function(x){x.classList.remove("active");});' +
          'this.classList.add("active");' +
          'usageState.groupBy = this.getAttribute("data-group") || "day";' +
          'loadUsage();' +
        '};' +
      '});' +

      // Conversations: rating chips, search, load more
      'container.querySelectorAll(".ai-convo-chip").forEach(function(b){' +
        'b.onclick = function() {' +
          'container.querySelectorAll(".ai-convo-chip").forEach(function(x){x.classList.remove("active");});' +
          'this.classList.add("active");' +
          'convoState.rating = this.getAttribute("data-convo-rating") || "";' +
          'loadConversations(false);' +
        '};' +
      '});' +
      '$("#ai-convo-search").addEventListener("input", function() {' +
        'var q = this.value;' +
        'clearTimeout(convoSearchTimer);' +
        'convoSearchTimer = setTimeout(function() { convoState.search = q.trim(); loadConversations(false); }, 300);' +
      '});' +
      '$("#ai-convo-more").onclick = function() { loadConversations(true); };' +

      // Initial load: models first (picker needs to be populated), then settings fill it in
      'loadModels().then(loadSettings);' +
      'loadDashboards();' +
      'loadVersions();' +
      'loadUsage();' +
      'loadConversations(false);' +
    '}';

  window.__xrayExtensions = window.__xrayExtensions || [];
  // Guard: the same extension may already be registered by app.js's inline
  // copy. If so, skip the duplicate push.
  var alreadyRegistered = window.__xrayExtensions.some(function(e) { return e && e.viewName === 'admin_ai'; });
  if (!alreadyRegistered) {
    window.__xrayExtensions.push({
      viewName: 'admin_ai',
      view: { html: viewHtml, css: viewCss, js: viewJs },
      nav: { section: 'platform', view: 'admin_ai', label: 'AI', icon: 'grid', permission: 'platform.admin' }
    });
  }
})();
