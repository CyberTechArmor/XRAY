(function() {
  'use strict';

  // ── State ──
  var accessToken = null;
  var currentUser = null;
  var bundle = null;
  var currentView = null;
  var pendingEmail = null;
  var pendingFlow = null; // 'login' | 'signup'
  window.__pendingFlow = null;

  // Exposed for extensions (AI SDK, etc.) that need to make authenticated calls
  window.__xrayGetAccessToken = function() { return accessToken; };
  window.__xrayGetUser = function() { return currentUser; };

  // Step 10: decode the access token (no signature check — server is the
  // source of truth) so the SPA can branch on the impersonation `imp` claim
  // without an extra round-trip. Returns { admin_id, admin_email } or null.
  function getImpClaim() {
    if (!accessToken) return null;
    try {
      var parts = accessToken.split('.');
      if (parts.length < 2) return null;
      var payload = JSON.parse(atob(parts[1].replace(/-/g, '+').replace(/_/g, '/')));
      return (payload && payload.imp && typeof payload.imp.admin_id === 'string') ? payload.imp : null;
    } catch (e) { return null; }
  }

  // Renders / removes the persistent red banner that warns the operator
  // they're acting on behalf of another user. Idempotent — safe to call
  // after every token swap.
  function renderImpersonationBanner() {
    var imp = getImpClaim();
    var existing = document.getElementById('impersonation-banner');
    if (!imp) { if (existing) existing.remove(); return; }
    var targetEmail = (currentUser && currentUser.email) || 'this user';
    if (existing) {
      existing.querySelector('.imp-text').textContent =
        'You are signed in as ' + targetEmail + ' on behalf of ' + imp.admin_email + '.';
      return;
    }
    var bar = document.createElement('div');
    bar.id = 'impersonation-banner';
    bar.className = 'impersonation-banner';
    bar.innerHTML =
      '<span class="imp-text">You are signed in as ' + targetEmail +
      ' on behalf of ' + imp.admin_email + '.</span>' +
      '<button id="imp-stop-btn" class="btn sm">Stop impersonating</button>';
    document.body.insertBefore(bar, document.body.firstChild);
    document.getElementById('imp-stop-btn').onclick = function() {
      api.post('/api/admin/impersonate/stop').then(function(r) {
        if (!r.ok) {
          if (window.__xrayAlert) window.__xrayAlert((r.error && r.error.message) || 'Failed to stop impersonation');
          return;
        }
        accessToken = r.data.accessToken;
        // Full reload so the entire app re-fetches /me + bundles + perms
        // under the restored admin identity. Cleaner than rebuilding the
        // sidebar + WebSocket + replay session inline.
        window.location.reload();
      });
    };
  }

  // Called from the admin Tenants → Impersonate button. Swaps the access
  // token in-place and reloads so every mounted view re-fetches under the
  // new identity. Refresh + CSRF cookies have already been issued by the
  // server in the impersonate response.
  window.__xrayApplyImpersonationTokens = function(newAccessToken) {
    accessToken = newAccessToken;
    window.location.reload();
  };

  // ─── AI admin view registration (inlined from frontend/ai/admin.js) ────────
  // Inlined into app.js so that platforms that miss the /ai/ subdirectory in
  // their deploy pipeline still get the admin AI view. The standalone file
  // remains available for optional out-of-app extension loading.
  (function() {
    'use strict';
  
    window.__xrayExtensions = window.__xrayExtensions || [];
  
    // Integration snippets exposed to the viewJs via window globals (avoids
    // escaping hell inside the string-concatenated view body). Populated
    // lazily so they're only computed once per session.
    window.__xrayAiSnippets = window.__xrayAiSnippets || {
      minimal: [
        '<script>',
        '(function () {',
        '  // XRay AI — minimal dashboard integration.',
        '  // Drop this into your dashboard HTML. The platform has already',
        '  // injected the SDK if this dashboard has AI enabled.',
        '  if (!window.XRayAI) return;',
        '',
        '  window.XRayAI.register({',
        '    id:    "YOUR-DASHBOARD-ID",        // must match the platform dashboard id',
        '    title: "Your dashboard title",',
        '',
        '    // What the AI always sees — describe your data once.',
        '    schema: {',
        '      columns: [',
        '        { key: "name",  type: "dimension", label: "Name" },',
        '        { key: "value", type: "metric",    label: "Value", unit: "USD" }',
        '      ],',
        '      glossary: { "Value": "Revenue per row" },',
        '      period:   "YTD",',
        '      grain:    "one row per customer"',
        '    },',
        '',
        '    // Per-turn snapshot. Keep under ~2K tokens.',
        '    getContext: function () {',
        '      var rows = window.__rows || [];',
        '      return {',
        '        filters:    { from: "2026-01-01", to: "2026-12-31" },',
        '        visible:    { count: rows.length },',
        '        aggregates: { total: rows.reduce(function (a, r) { return a + (r.value || 0); }, 0) },',
        '        top_rows:   rows.slice(0, 10)',
        '      };',
        '    }',
        '  });',
        '})();',
        '</' + 'script>'
      ].join('\n'),

      full: [
        '<script>',
        '(function () {',
        '  if (!window.XRayAI) return;',
        '',
        '  // Your dashboard already has these — wire them in.',
        '  function applyFilter(name, value) { /* update your DOM + data */ }',
        '  function visibleRows() { return window.__rows || []; }',
        '',
        '  window.XRayAI.register({',
        '    id:    "field-operations",          // match the platform dashboard id',
        '    title: "Field Operations",',
        '',
        '    // Always-in-prompt (keep under ~5K tokens).',
        '    schema: {',
        '      columns: [',
        '        { key: "technician", type: "dimension", label: "Technician" },',
        '        { key: "hours",      type: "metric",    label: "Hours",   unit: "hr" },',
        '        { key: "revenue",    type: "metric",    label: "Revenue", unit: "USD" },',
        '        { key: "margin",     type: "metric",    label: "Margin",  unit: "USD/hr",',
        '          formula: "rev_per_hr - pay_rate" }',
        '      ],',
        '      glossary: { "Margin": "Rev/Hr - Pay Rate", "Lost": "Revenue from cancelled jobs" },',
        '      period:   "YTD",',
        '      grain:    "per-technician, rolled up from job records"',
        '    },',
        '',
        '    // Per-turn snapshot. Keep under ~2K tokens.',
        '    getContext: function () {',
        '      var rows = visibleRows();',
        '      return {',
        '        filters:    { dateFrom: "2026-01-01", dateTo: "2026-04-18", range: "YTD" },',
        '        visible:    { count: rows.length, of: window.__totalRows || rows.length },',
        '        aggregates: {',
        '          total_hours: rows.reduce(function (a, r) { return a + (r.hours || 0); }, 0),',
        '          revenue:     rows.reduce(function (a, r) { return a + (r.revenue || 0); }, 0)',
        '        },',
        '        top_rows: rows.slice(0, 10)',
        '      };',
        '    },',
        '',
        '    // Semantic element names the AI references by name, not CSS.',
        '    // {placeholders} get substituted from params in highlight()/setFilter().',
        '    elements: {',
        '      "revenue_card":     "#kpi-revenue",',
        '      "leaderboard":      "#tech-table",',
        '      "leaderboard.row":  "#tech-table tr[data-row-id=\\"{id}\\"]",',
        '      "leaderboard.cell": "#tech-table tr[data-row-id=\\"{id}\\"] td[data-col=\\"{col}\\"]"',
        '    },',
        '',
        '    // Shown in the rail\'s NOW zone as one-click prompts.',
        '    suggestedPrompts: [',
        '      "Explain the margin spread across techs",',
        '      "Who is declining vs last month?",',
        '      "Which cancellations look recoverable?"',
        '    ],',
        '',
        '    // Tools the AI can invoke. highlight/clearAnnotations/resetView/undo',
        '    // are handled by the platform (via the elements map above).',
        '    // setFilter + getRecords are yours — implement to match your data.',
        '    tools: {',
        '      setFilter: function (name, value) { applyFilter(name, value); },',
        '      getRecords: function (opts) {',
        '        var rows = visibleRows();',
        '        if (opts && opts.limit) rows = rows.slice(0, opts.limit);',
        '        return rows;',
        '      }',
        '    }',
        '  });',
        '})();',
        '</' + 'script>'
      ].join('\n'),

      actions: [
        '// The AI emits actions as a fenced JSON block at the END of its',
        '// answer. The platform parses it and dispatches to your dashboard.',
        '// You do NOT implement the highlight / clearAnnotations / resetView',
        '// / undo tools — the SDK handles those using your `elements` map.',
        '',
        'Example assistant reply:',
        '',
        '    The two biggest margin outliers are Torey Ballard and Jason Iglesias.',
        '',
        '    ```xray-actions',
        '    [',
        '      { "action": "highlight", "target": "leaderboard.row",',
        '        "params": { "id": "3", "note": "Top margin +$268/hr" } },',
        '      { "action": "highlight", "target": "leaderboard.row",',
        '        "params": { "id": "5", "note": "Top revenue $72k" } }',
        '    ]',
        '    ```',
        '',
        '',
        'Valid action types:',
        '  • highlight         → target = semantic element name, params substituted',
        '  • clearAnnotations  → removes all rail-drawn annotations',
        '  • setFilter         → params: { name, value }; dispatched to your tools.setFilter',
        '  • resetView         → clears annotations and calls your tools.resetView if defined',
        '  • undo              → steps back through the platform\'s undo stack'
      ].join('\n')
    };

    var viewHtml =
      '<div class="admin-ai-view">' +
        '<div class="sec-head"><div class="sec-title">AI Integration</div><div class="sec-desc">Platform-wide AI settings. Changes are versioned — every save creates a new immutable version with an optional note.</div></div>' +

        '<div id="ai-health-banner" class="ai-health-banner ai-health-loading">' +
          '<div class="ai-health-title">Checking AI backend…</div>' +
          '<div class="ai-health-detail">Running /api/admin/ai/_health</div>' +
        '</div>' +

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
          '<div class="card-title">Dashboard integration convention</div>' +
          '<div class="card-desc">Each dashboard opts in to the AI rail by calling <code>window.XRayAI.register({...})</code> once in its HTML. The platform handles the UI, streaming chat, annotations, and tool dispatch. The snippets below are always available here — copy whichever fits your dashboard and adapt the schema / elements / tools to match your data.</div>' +
          '<div class="ai-snippet-tabs">' +
            '<button class="ai-snippet-tab active" data-snippet="minimal">Minimal</button>' +
            '<button class="ai-snippet-tab" data-snippet="full">Full</button>' +
            '<button class="ai-snippet-tab" data-snippet="actions">Action types</button>' +
          '</div>' +
          '<div class="ai-snippet-block"><button class="ai-snippet-copy" data-copy-target="ai-snippet-body">Copy</button><pre id="ai-snippet-body" class="ai-snippet-pre"></pre></div>' +
          '<div class="ai-snippet-notes" id="ai-snippet-notes"></div>' +
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
      /* ── Health banner ── */
      '.admin-ai-view .ai-health-banner{margin-bottom:16px;padding:12px 16px;border-radius:8px;border:1px solid var(--bdr);background:var(--bg2);font-size:13px}' +
      '.admin-ai-view .ai-health-banner.ai-health-loading{border-color:var(--bdr);color:var(--t2)}' +
      '.admin-ai-view .ai-health-banner.ai-health-ok{border-color:var(--acc);background:rgba(62,232,181,0.04);color:var(--t1)}' +
      '.admin-ai-view .ai-health-banner.ai-health-warn{border-color:#e8845a;background:rgba(232,132,90,0.08);color:var(--t1)}' +
      '.admin-ai-view .ai-health-banner.ai-health-bad{border-color:var(--danger);background:rgba(239,68,68,0.08);color:var(--t1)}' +
      '.admin-ai-view .ai-health-title{font-weight:600;font-size:14px;margin-bottom:4px;display:flex;align-items:center;gap:8px}' +
      '.admin-ai-view .ai-health-title .tag{font-size:10px;padding:2px 6px;background:var(--bg3);border:1px solid var(--bdr);border-radius:4px;font-family:var(--mono,monospace);color:var(--t3);letter-spacing:.04em}' +
      '.admin-ai-view .ai-health-detail{font-size:12px;color:var(--t2);line-height:1.5;font-family:var(--mono,monospace)}' +
      '.admin-ai-view .ai-health-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:6px;margin-top:8px}' +
      '.admin-ai-view .ai-health-chip{padding:4px 8px;background:var(--bg3);border:1px solid var(--bdr);border-radius:4px;font-size:11px;font-family:var(--mono,monospace);display:flex;justify-content:space-between;align-items:center;gap:6px}' +
      '.admin-ai-view .ai-health-chip.yes{border-color:var(--acc);color:var(--acc)}' +
      '.admin-ai-view .ai-health-chip.no{border-color:var(--danger);color:var(--danger)}' +
      '.admin-ai-view .ai-health-actions{margin-top:8px}' +
      '.admin-ai-view .ai-health-actions button{font-size:11px;padding:5px 10px;background:var(--bg3);border:1px solid var(--bdr);color:var(--t2);border-radius:4px;cursor:pointer;margin-right:6px}' +
      '.admin-ai-view .ai-health-actions button:hover{color:var(--t1);border-color:var(--bdr2)}' +
      /* ── Integration snippet ── */
      '.admin-ai-view .ai-snippet-tabs{display:inline-flex;background:var(--bg3);border:1px solid var(--bdr);border-radius:6px;padding:2px;margin-bottom:10px}' +
      '.admin-ai-view .ai-snippet-tab{padding:5px 10px;font-size:12px;background:transparent;border:none;color:var(--t2);border-radius:4px;cursor:pointer}' +
      '.admin-ai-view .ai-snippet-tab:hover{color:var(--t1)}' +
      '.admin-ai-view .ai-snippet-tab.active{background:var(--acc);color:var(--acc-dk)}' +
      '.admin-ai-view .ai-snippet-block{position:relative}' +
      '.admin-ai-view .ai-snippet-pre{background:#0b0c10;border:1px solid var(--bdr);border-radius:8px;padding:14px;color:var(--t1);font-family:var(--mono,monospace);font-size:12px;line-height:1.55;overflow-x:auto;white-space:pre;margin:0;max-height:520px;overflow-y:auto}' +
      '.admin-ai-view .ai-snippet-copy{position:absolute;top:8px;right:8px;font-size:11px;padding:5px 10px;background:var(--bg3);border:1px solid var(--bdr);color:var(--t2);border-radius:4px;cursor:pointer;z-index:1}' +
      '.admin-ai-view .ai-snippet-copy:hover{color:var(--acc);border-color:var(--acc)}' +
      '.admin-ai-view .ai-snippet-notes{margin-top:10px;font-size:12px;color:var(--t2);line-height:1.55}' +
      '.admin-ai-view .ai-snippet-notes code{font-family:var(--mono,monospace);background:var(--bg3);padding:1px 6px;border-radius:4px;font-size:11px;color:var(--acc)}' +
      '.admin-ai-view .card-desc code{font-family:var(--mono,monospace);background:var(--bg3);padding:1px 6px;border-radius:4px;font-size:11px;color:var(--acc)}' +
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
        // Format an error response richly: includes HTTP status + error code +
        // message so the admin sees a real signal instead of a bare "Failed".
        // Also dumps full response to the console for DevTools inspection.
        'function aiErr(r, fallback) { try { console.error("[XRayAI admin] bad response:", r); } catch(e) {} if (!r) return fallback || "Network error"; if (r.error) { var parts=[]; if (r.error.code) parts.push(r.error.code); if (r.error.message) parts.push(r.error.message); if (parts.length) return parts.join(": "); } if (r.status) return "HTTP " + r.status; if (r.ok === false) return (fallback || "Request failed") + " (server returned no error JSON \u2014 check Network tab)"; return fallback || "Request failed"; }' +
        // ── Health banner: runs /_health on init, displays status clearly ─────
        'function renderHealth(r) {' +
          'var el = $("#ai-health-banner"); if (!el) return;' +
          'el.classList.remove("ai-health-loading","ai-health-ok","ai-health-warn","ai-health-bad");' +
          'if (!r || !r.ok) {' +
            'el.classList.add("ai-health-bad");' +
            'el.innerHTML = "<div class=\\"ai-health-title\\">Backend unreachable <span class=\\"tag\\">/api/admin/ai/_health</span></div>" +' +
              '"<div class=\\"ai-health-detail\\">" + escapeHtml(aiErr(r, "No response. Check that the server container is running the latest build.")) + "</div>";' +
            'return;' +
          '}' +
          'var d = r.data || {};' +
          'var missingTables = [];' +
          'if (d.tables) { Object.keys(d.tables).forEach(function(k){ if (!d.tables[k]) missingTables.push(k); }); }' +
          'var problems = [];' +
          'if (missingTables.length) problems.push(missingTables.length + " missing tables (run update.sh migrations): " + missingTables.join(", "));' +
          'if (!d.api_key_configured) problems.push("No Anthropic API key set yet");' +
          'if (!d.model_catalog_count) problems.push("Model catalog empty (migration 015 may not have run)");' +
          'if (d.errors && d.errors.length) { d.errors.forEach(function(e){ problems.push("Server probe: " + e); }); }' +
          'el.classList.add(problems.length === 0 ? "ai-health-ok" : (missingTables.length ? "ai-health-bad" : "ai-health-warn"));' +
          'var chips = "";' +
          'chips += "<span class=\\"ai-health-chip " + (d.api_key_configured ? "yes" : "no") + "\\">API key <span>" + (d.api_key_configured ? "✓ set" : "not set") + "</span></span>";' +
          'chips += "<span class=\\"ai-health-chip " + (d.model_catalog_count ? "yes" : "no") + "\\">Model catalog <span>" + d.model_catalog_count + " entries</span></span>";' +
          'chips += "<span class=\\"ai-health-chip " + (d.settings_versions_count ? "yes" : "no") + "\\">Settings versions <span>" + d.settings_versions_count + "</span></span>";' +
          'chips += "<span class=\\"ai-health-chip\\">Current model <span>" + escapeHtml(d.current_model_id || "(none)") + "</span></span>";' +
          'if (missingTables.length) chips += "<span class=\\"ai-health-chip no\\">Missing tables <span>" + missingTables.length + "</span></span>";' +
          'el.innerHTML = "<div class=\\"ai-health-title\\">AI backend status " +' +
            '(problems.length === 0 ? "<span style=\\"color:var(--acc)\\">✓ healthy</span>" : "<span style=\\"color:var(--danger)\\">" + problems.length + " issue(s)</span>") +' +
            '" <span class=\\"tag\\">" + escapeHtml(d.version || "?") + "</span></div>" +' +
            '(problems.length ? "<div class=\\"ai-health-detail\\">" + problems.map(escapeHtml).join("<br>") + "</div>" : "") +' +
            '"<div class=\\"ai-health-grid\\">" + chips + "</div>" +' +
            '"<div class=\\"ai-health-actions\\"><button id=\\"ai-health-refresh\\">Re-check</button></div>";' +
          'var rb = $("#ai-health-refresh"); if (rb) rb.onclick = function() { loadHealth(); };' +
        '}' +
        'function loadHealth() {' +
          'var el = $("#ai-health-banner"); if (el) { el.className = "ai-health-banner ai-health-loading"; el.innerHTML = "<div class=\\"ai-health-title\\">Checking AI backend…</div><div class=\\"ai-health-detail\\">Running /api/admin/ai/_health</div>"; }' +
          'return api.get("/api/admin/ai/_health").then(renderHealth).catch(function(){ renderHealth(null); });' +
        '}' +
  
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
            'if (!r.ok) { setStatus("#ai-save-status", aiErr(r, "Failed to load"), "error"); return; }' +
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
            'if (!r.ok || !r.data) { el.innerHTML = "<div class=\\"ai-loading\\" style=\\"color:var(--danger)\\">Failed to load dashboards: " + escapeHtml(aiErr(r, "unknown")) + "</div>"; return; }' +
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
  
        // Refresh every panel that depends on the API key (model picker pulls live
        // from Anthropic, usage/conversations/dashboards are scoped the same way).
        'function refreshAllPanels() {' +
          'loadHealth();' +
          'loadModels().then(loadSettings);' +
          'loadDashboards();' +
          'loadVersions();' +
          'loadUsage();' +
          'loadConversations(false);' +
        '}' +

        '$("#btn-ai-save-key").onclick = function() {' +
          'var val = ($("#ai-api-key").value || "").trim();' +
          'if (!val) { setStatus("#ai-key-status", "Enter a key first", "error"); return; }' +
          'this.disabled = true;' +
          'api.patch("/api/admin/ai/settings/api-key", { api_key: val }).then(function(r) {' +
            '$("#btn-ai-save-key").disabled = false;' +
            'if (!r.ok) { setStatus("#ai-key-status", aiErr(r, "Failed"), "error"); return; }' +
            '$("#ai-api-key").value = "";' +
            'setStatus("#ai-key-status", "Saved \u2014 refreshing", "success");' +
            'refreshAllPanels();' +
          '});' +
        '};' +

        '$("#btn-ai-clear-key").onclick = async function() {' +
          'if (!(await window.__xrayConfirm("Clear the API key? AI will stop working until a new key is provided.", { danger: true, okLabel: "Clear" }))) return;' +
          'this.disabled = true;' +
          'api.patch("/api/admin/ai/settings/api-key", { api_key: null }).then(function(r) {' +
            '$("#btn-ai-clear-key").disabled = false;' +
            'if (!r.ok) { setStatus("#ai-key-status", aiErr(r, "Failed"), "error"); return; }' +
            'setStatus("#ai-key-status", "Cleared \u2014 refreshing", "success");' +
            'refreshAllPanels();' +
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
            'if (!r.ok) { setStatus("#ai-save-status", aiErr(r, "Failed"), "error"); return; }' +
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
            'if (!r.ok) { $("#ai-convo-list").innerHTML = "<div class=\\"ai-usage-empty\\" style=\\"color:var(--danger)\\">Failed to load: " + escapeHtml(aiErr(r, "unknown")) + "</div>"; return; }' +
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
  
        // Integration snippets — tabs + copy. Snippets live on window globals
        // (populated by the outer app.js IIFE) to dodge escape hell.
        'function showSnippet(name) {' +
          'var snippets = window.__xrayAiSnippets || {};' +
          'var body = $("#ai-snippet-body"); if (!body) return;' +
          'body.textContent = snippets[name] || "(snippet missing)";' +
          'container.querySelectorAll(".ai-snippet-tab").forEach(function(t){ t.classList.toggle("active", t.getAttribute("data-snippet") === name); });' +
          'var notes = $("#ai-snippet-notes"); if (!notes) return;' +
          'if (name === "minimal") notes.innerHTML = "Paste into any dashboard HTML. Replace <code>YOUR-DASHBOARD-ID</code> with the dashboard\'s platform id (visible in the Per-dashboard AI list above). Expose <code>window.__rows</code> from your dashboard so <code>getContext</code> can read it — or swap it for whatever variable holds your data.";' +
          'else if (name === "full") notes.innerHTML = "Production-grade setup with <code>elements</code>, <code>suggestedPrompts</code>, and custom tools. The AI can drive your filters via <code>setFilter</code> and pull more rows on demand via <code>getRecords</code>.";' +
          'else if (name === "actions") notes.innerHTML = "This is informational — the AI writes these blocks itself. You only need to make sure your <code>elements</code> map (above) points to real selectors so the highlight circles land on the right rows.";' +
        '}' +
        'container.querySelectorAll(".ai-snippet-tab").forEach(function(b) {' +
          'b.onclick = function() { showSnippet(this.getAttribute("data-snippet")); };' +
        '});' +
        'container.querySelectorAll(".ai-snippet-copy").forEach(function(b) {' +
          'b.onclick = function() {' +
            'var target = $("#" + this.getAttribute("data-copy-target"));' +
            'if (!target) return;' +
            'navigator.clipboard.writeText(target.textContent || "").then(function() {' +
              'var orig = b.textContent; b.textContent = "Copied"; setTimeout(function(){ b.textContent = orig; }, 1400);' +
            '}).catch(function() { b.textContent = "Copy failed"; });' +
          '};' +
        '});' +
        'showSnippet("minimal");' +

        // Initial load: models first (picker needs to be populated), then settings fill it in
        'loadHealth();' +
        'loadModels().then(loadSettings);' +
        'loadDashboards();' +
        'loadVersions();' +
        'loadUsage();' +
        'loadConversations(false);' +
      '}';

    // Guard against double-registration if /ai/admin.js also loaded.
    var already = window.__xrayExtensions.some(function(e){ return e && e.viewName === 'admin_ai'; });
    if (!already) {
      window.__xrayExtensions.push({
        viewName: 'admin_ai',
        view: { html: viewHtml, css: viewCss, js: viewJs },
        nav: { section: 'platform', view: 'admin_ai', label: 'AI', icon: 'grid', permission: 'platform.admin' }
      });
    }
  })();


  // ── Session Replay (rrweb) ──
  var _replaySessionId = null;
  var _replaySegmentId = null;
  var _replayStopFn = null;
  var _replayEventBuffer = [];
  var _replayFlushTimer = null;
  var _replayLastEventTime = 0;
  var _replayInactivityTimer = null;
  var _rrwebLoaded = false;
  var REPLAY_FLUSH_INTERVAL = 500; // flush events every 500ms for near-real-time shadow viewing
  var REPLAY_INACTIVITY_TIMEOUT = 60 * 60 * 1000; // 1 hour

  function loadRrweb(cb) {
    if (_rrwebLoaded && window.rrweb) { cb(); return; }
    var script = document.createElement('script');
    script.src = 'https://cdn.jsdelivr.net/npm/rrweb@2.0.0-alpha.13/dist/rrweb.min.js';
    script.onload = function() { _rrwebLoaded = true; cb(); };
    script.onerror = function() { console.warn('[XRay Replay] Failed to load rrweb from CDN'); };
    document.head.appendChild(script);
  }

  function startReplaySession() {
    if (!currentUser || currentUser.is_platform_admin) return;
    if (!currentUser.replay_enabled) return; // tenant has replay disabled
    if (_replaySessionId) return; // already recording
    console.log('[XRay Replay] Starting session for', currentUser.email);

    loadRrweb(function() {
      if (!window.rrweb || !window.rrweb.record) { console.warn('[XRay Replay] rrweb not available after load'); return; }
      console.log('[XRay Replay] rrweb loaded, creating session...');

      // Create session on server
      var body = {
        userAgent: navigator.userAgent,
        viewportWidth: window.innerWidth,
        viewportHeight: window.innerHeight
      };
      api.post('/api/v1/replay/sessions', body).then(function(r) {
        if (!r.ok || !r.data) { console.warn('[XRay Replay] Failed to create session:', r.error || r); return; }
        console.log('[XRay Replay] Session created:', r.data.id || r.data.sessionId);
        _replaySessionId = r.data.id || r.data.sessionId;

        // Create initial segment — WAIT for it before starting recording
        var segType = detectSegmentType();
        var segBody = { segmentType: segType.type };
        if (segType.dashboardId) segBody.dashboardId = segType.dashboardId;
        api.post('/api/v1/replay/sessions/' + _replaySessionId + '/segments', segBody).then(function(sr) {
          if (sr.ok && sr.data) {
            _replaySegmentId = sr.data.id || sr.data.segmentId;
            _replayPrimarySegmentId = _replaySegmentId; // primary segment stores all events
            console.log('[XRay Replay] Segment created:', _replaySegmentId);
          }

          // Start rrweb recording AFTER segment ID is ready
          _replayStopFn = window.rrweb.record({
            emit: onRrwebEvent,
            recordCanvas: false,
            recordCrossOriginIframes: false,
            collectFonts: false,
            sampling: {
              mousemove: true,
              mouseInteraction: true,
              scroll: 150,
              input: 'last'
            }
          });

          // Start periodic flush
          _replayFlushTimer = setInterval(flushReplayEvents, REPLAY_FLUSH_INTERVAL);

          // Start inactivity timer
          resetInactivityTimer();
        }).catch(function() {});
      }).catch(function() {});
    });
  }

  function stopReplaySession() {
    if (_replayStopFn) { _replayStopFn(); _replayStopFn = null; }
    if (_replayFlushTimer) { clearInterval(_replayFlushTimer); _replayFlushTimer = null; }
    if (_replayInactivityTimer) { clearTimeout(_replayInactivityTimer); _replayInactivityTimer = null; }

    // Flush remaining events
    flushReplayEvents();

    // Close current segment
    if (_replaySegmentId && _replaySessionId) {
      api.post('/api/v1/replay/sessions/' + _replaySessionId + '/segments/' + _replaySegmentId + '/close').catch(function() {});
    }

    // Finalize session
    if (_replaySessionId) {
      api.post('/api/v1/replay/sessions/' + _replaySessionId + '/finalize').catch(function() {});
    }

    _replaySessionId = null;
    _replaySegmentId = null;
    _replayPrimarySegmentId = null;
    _replayEventBuffer = [];
  }

  function onRrwebEvent(event) {
    _replayEventBuffer.push(event);
    _replayLastEventTime = Date.now();
    resetInactivityTimer();
  }

  function flushReplayEvents() {
    if (_replayEventBuffer.length === 0) return;
    var flushSegId = _replayPrimarySegmentId || _replaySegmentId;
    if (!_replaySessionId || !flushSegId) return;

    var events = _replayEventBuffer;
    _replayEventBuffer = [];

    // HTTP POST for reliable storage
    api.post('/api/v1/replay/sessions/' + _replaySessionId + '/events', {
      segmentId: flushSegId,
      events: events
    }).then(function(r) {
      if (!r.ok) console.error('[XRay Replay] Event store failed:', r);
    }).catch(function(err) {
      console.error('[XRay Replay] Event store error, re-buffering', err);
      _replayEventBuffer = events.concat(_replayEventBuffer);
    });

    // WS for shadow fan-out only
    if (window.__xrayWs && window.__xrayWs.readyState === WebSocket.OPEN) {
      try {
        window.__xrayWs.send(JSON.stringify({
          type: 'replay:events',
          data: { sessionId: _replaySessionId, segmentId: flushSegId, events: events }
        }));
      } catch(e) {}
    }
  }

  function detectSegmentType() {
    // Check dashboard viewer FIRST - it overlays the dashboard_list view
    var viewer = document.querySelector('.dash-fullview.active');
    if (viewer) {
      var dashId = viewer.dataset && viewer.dataset.dashboardId;
      if (dashId) return { type: 'dashboard', dashboardId: dashId };
    }
    // Otherwise it's a platform view
    return { type: 'platform', dashboardId: null };
  }

  // The primary segment ID used for all event storage — set once at session start
  var _replayPrimarySegmentId = null;

  function createReplaySegment(segType, dashboardId) {
    if (!_replaySessionId) return;
    var oldSegmentId = _replaySegmentId;
    // Flush events before switching
    if (oldSegmentId) {
      flushReplayEvents();
    }
    // Create new segment for metadata tracking, but keep storing events under primary segment
    var body = { segmentType: segType };
    if (dashboardId) body.dashboardId = dashboardId;
    api.post('/api/v1/replay/sessions/' + _replaySessionId + '/segments', body).then(function(r) {
      if (r.ok && r.data) {
        _replaySegmentId = r.data.id || r.data.segmentId;
        // First segment becomes the primary — all events stored here
        if (!_replayPrimarySegmentId) {
          _replayPrimarySegmentId = _replaySegmentId;
        }
        // Close the old segment
        if (oldSegmentId) {
          api.post('/api/v1/replay/sessions/' + _replaySessionId + '/segments/' + oldSegmentId + '/close').catch(function() {});
        }
      }
    }).catch(function() {});
  }

  function onReplaySegmentChange() {
    if (!_replaySessionId) return;
    var seg = detectSegmentType();
    createReplaySegment(seg.type, seg.dashboardId);
  }

  function resetInactivityTimer() {
    if (_replayInactivityTimer) clearTimeout(_replayInactivityTimer);
    _replayInactivityTimer = setTimeout(function() {
      // 1 hour of inactivity — end session, start new one if user becomes active
      stopReplaySession();
    }, REPLAY_INACTIVITY_TIMEOUT);
  }

  // ── Icons (simple SVG paths) ──
  var icons = {
    grid: '<rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/>',
    plus: '<line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>',
    users: '<path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>',
    'credit-card': '<rect x="1" y="4" width="22" height="16" rx="2" ry="2"/><line x1="1" y1="10" x2="23" y2="10"/>',
    'file-text': '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/>',
    settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>',
    home: '<path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/>',
    shield: '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>',
    mail: '<path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"/><polyline points="22,6 12,13 2,6"/>',
    package: '<line x1="16.5" y1="9.4" x2="7.5" y2="4.21"/><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/><polyline points="3.27 6.96 12 12.01 20.73 6.96"/><line x1="12" y1="22.08" x2="12" y2="12"/>',
    key: '<path d="M21 2l-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.778 7.778 5.5 5.5 0 0 1 7.777-7.777zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3m-3.5 3.5L19 4"/>',
    link: '<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>',
    video: '<polygon points="23 7 16 12 23 17 23 7"/><rect x="1" y="5" width="15" height="14" rx="2" ry="2"/>',
    inbox: '<path d="M22 12h-6l-2 3h-4l-2-3H2"/><path d="M5.45 5.11L2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/>',
    database: '<ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3"/><path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5"/>'
  };

  function iconSvg(name) {
    var paths = icons[name] || icons.grid;
    return '<svg viewBox="0 0 24 24">' + paths + '</svg>';
  }

  // ── API helper ──
  var _refreshPromise = null; // mutex: only one refresh at a time
  var _lastRefreshTime = 0;   // debounce: skip refresh if one just completed
  // Step 10: read the xsrf_token cookie and mirror it into the
  // X-CSRF-Token header on every state-changing request. Server
  // verifies cookie===header AND that the cookie HMAC validates
  // against platform_settings.csrf_signing_secret. GET/HEAD bypass
  // the check server-side, so the header is harmless on safe
  // methods and we set it unconditionally to keep the wrapper
  // simple.
  function readCsrfCookie() {
    try {
      var match = document.cookie.split(';').map(function(s) { return s.trim(); })
        .find(function(s) { return s.indexOf('xsrf_token=') === 0; });
      return match ? decodeURIComponent(match.slice('xsrf_token='.length)) : '';
    } catch (e) { return ''; }
  }

  var api = {
    _fetch: function(method, url, body) {
      var tokenAtCall = accessToken; // capture token at call time
      var opts = {
        method: method,
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include'
      };
      if (accessToken) opts.headers['Authorization'] = 'Bearer ' + accessToken;
      var csrf = readCsrfCookie();
      if (csrf) opts.headers['X-CSRF-Token'] = csrf;
      if (body) opts.body = JSON.stringify(body);
      return fetch(url, opts).then(function(r) {
        if (r.status === 401 && tokenAtCall) {
          // If token already changed (another concurrent call refreshed), just retry
          if (accessToken && accessToken !== tokenAtCall) {
            opts.headers['Authorization'] = 'Bearer ' + accessToken;
            var csrfRetry = readCsrfCookie();
            if (csrfRetry) opts.headers['X-CSRF-Token'] = csrfRetry;
            return fetch(url, opts).then(function(r2) { return r2.json().catch(function() { return { ok: false }; }); });
          }
          return api.refresh().then(function(ok) {
            if (!ok) {
              // Don't logout if token was updated by another path while we waited
              if (accessToken && accessToken !== tokenAtCall) {
                opts.headers['Authorization'] = 'Bearer ' + accessToken;
                return fetch(url, opts).then(function(r2) { return r2.json().catch(function() { return { ok: false }; }); });
              }
              logout(); return { ok: false, error: { message: 'Session expired' } };
            }
            opts.headers['Authorization'] = 'Bearer ' + accessToken;
            var csrfRetry = readCsrfCookie();
            if (csrfRetry) opts.headers['X-CSRF-Token'] = csrfRetry;
            return fetch(url, opts).then(function(r2) { return r2.json().catch(function() { return { ok: false }; }); });
          });
        }
        return r.json().catch(function() { return { ok: r.ok }; });
      });
    },
    get: function(url) { return api._fetch('GET', url); },
    post: function(url, body) { return api._fetch('POST', url, body); },
    patch: function(url, body) { return api._fetch('PATCH', url, body); },
    put: function(url, body) { return api._fetch('PUT', url, body); },
    delete: function(url, body) { return api._fetch('DELETE', url, body); },
    refresh: function() {
      // Mutex: if a refresh is already in flight, return the same promise
      if (_refreshPromise) return _refreshPromise;
      // Debounce: if a refresh just completed < 5s ago, skip (token is fresh)
      if (Date.now() - _lastRefreshTime < 5000 && accessToken) {
        return Promise.resolve(true);
      }
      _refreshPromise = fetch('/api/auth/refresh', { method: 'POST', credentials: 'include' })
        .then(function(r) { return r.json(); })
        .then(function(d) {
          _refreshPromise = null;
          if (d.ok && d.data && d.data.accessToken) {
            accessToken = d.data.accessToken;
            _lastRefreshTime = Date.now();
            if (typeof reconnectWebSocket === 'function') reconnectWebSocket();
            return true;
          }
          return false;
        })
        .catch(function() { _refreshPromise = null; return false; });
      return _refreshPromise;
    }
  };

  // ── Toast ──
  function toast(msg, type) {
    type = type || 'info';
    var el = document.createElement('div');
    el.className = 'toast ' + type;
    el.textContent = msg;
    document.getElementById('toast-container').appendChild(el);
    setTimeout(function() { el.remove(); }, 4000);
  }
  window.__xrayToast = toast;

  // ── Billing-event fanout ──
  // The WS `billing:updated` path can have multiple interested views
  // at the same time (dashboard_list paywall + billing page + admin
  // tenants). A single `window.__xrayBillingChanged = fn` would let
  // whichever view registered last clobber the rest. Views call
  // __xrayOnBilling(fn) on mount and we fan out to all of them.
  window.__xrayBillingSubscribers = window.__xrayBillingSubscribers || [];
  window.__xrayOnBilling = function(fn) {
    if (typeof fn !== 'function') return function() {};
    window.__xrayBillingSubscribers.push(fn);
    return function unsubscribe() {
      var i = window.__xrayBillingSubscribers.indexOf(fn);
      if (i >= 0) window.__xrayBillingSubscribers.splice(i, 1);
    };
  };

  // ── Alert / Confirm modals ──
  // In-app replacements for browser alert() / confirm(). Both return
  // Promises so existing `if (!confirm(...)) return;` call sites
  // convert to `if (!(await __xrayConfirm(...))) return;` cleanly.
  // Styling reuses the app's .modal-overlay/.modal rules (app.css:65+).
  function __xrayOpenDialog(opts) {
    opts = opts || {};
    var overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.style.zIndex = '10500'; // above other modals so it's always interactive
    var modal = document.createElement('div');
    modal.className = 'modal';
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-modal', 'true');
    var escHtml = function(s) {
      return String(s == null ? '' : s)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    };
    var titleHtml = opts.title ? '<div class="modal-head"><div class="modal-title">' + escHtml(opts.title) + '</div></div>' : '';
    var msgHtml = '<div class="modal-body" style="white-space:pre-wrap;line-height:1.5">' + escHtml(opts.message || '') + '</div>';
    var okClass = 'btn primary' + (opts.danger ? ' danger' : '');
    var okLabel = escHtml(opts.okLabel || 'OK');
    var cancelBtn = opts.showCancel
      ? '<button type="button" class="btn" data-x-cancel>' + escHtml(opts.cancelLabel || 'Cancel') + '</button>'
      : '';
    var footHtml = '<div class="modal-foot">' + cancelBtn + '<button type="button" class="' + okClass + '" data-x-ok>' + okLabel + '</button></div>';
    modal.innerHTML = titleHtml + msgHtml + footHtml;
    overlay.appendChild(modal);
    document.body.appendChild(overlay);

    return new Promise(function(resolve) {
      var resolved = false;
      function close(value) {
        if (resolved) return;
        resolved = true;
        document.removeEventListener('keydown', onKey);
        try { overlay.remove(); } catch (e) {}
        resolve(value);
      }
      function onKey(e) {
        if (e.key === 'Escape') { e.preventDefault(); close(opts.showCancel ? false : undefined); }
        else if (e.key === 'Enter') { e.preventDefault(); close(opts.showCancel ? true : undefined); }
      }
      document.addEventListener('keydown', onKey);
      var okBtn = modal.querySelector('[data-x-ok]');
      var cancelEl = modal.querySelector('[data-x-cancel]');
      if (okBtn) okBtn.onclick = function() { close(opts.showCancel ? true : undefined); };
      if (cancelEl) cancelEl.onclick = function() { close(false); };
      // Click on the overlay background acts as Cancel on confirm, dismiss on alert.
      overlay.addEventListener('click', function(e) {
        if (e.target === overlay) close(opts.showCancel ? false : undefined);
      });
      // Give the OK button focus so Enter works immediately.
      try { if (okBtn) okBtn.focus(); } catch (e) {}
    });
  }
  window.__xrayAlert = function(message, opts) {
    opts = opts || {};
    return __xrayOpenDialog({
      message: message,
      title: opts.title,
      okLabel: opts.okLabel,
      showCancel: false,
    });
  };
  window.__xrayConfirm = function(message, opts) {
    opts = opts || {};
    return __xrayOpenDialog({
      message: message,
      title: opts.title,
      okLabel: opts.okLabel,
      cancelLabel: opts.cancelLabel,
      danger: !!opts.danger,
      showCancel: true,
    });
  };

  // ── Connect modal (OAuth / API Key integration connect flow) ──
  // Shared across views. Opened when a tenant user clicks a dashboard
  // whose integration is 'not_connected' or 'needs_reconnect'. Shows one
  // or two cards based on which auth methods the integration supports;
  // unsupported methods are dimmed rather than hidden so the tenant can
  // see what's available in principle.
  var __xrayIntegrationCache = null;    // last /api/connections/my-integrations result
  var __xrayIntegrationCacheAt = 0;
  function __xrayFetchIntegrations(force) {
    if (!force && __xrayIntegrationCache && Date.now() - __xrayIntegrationCacheAt < 30000) {
      return Promise.resolve(__xrayIntegrationCache);
    }
    return api.get('/api/connections/my-integrations').then(function(r) {
      if (r.ok && Array.isArray(r.data)) {
        __xrayIntegrationCache = r.data;
        __xrayIntegrationCacheAt = Date.now();
        return r.data;
      }
      return [];
    });
  }
  window.__xrayGetIntegrations = __xrayFetchIntegrations;

  // Pure helper: maps a /my-integrations response + the current select
  // value into an ordered option list for the dashboard builder's
  // Integration dropdown. Always leads with 'Custom (no auth)'. Preserves
  // an existing value that no longer has a matching catalog row so saves
  // don't silently wipe the slug (render path already degrades gracefully
  // for unknown slugs).
  // NOTE: Mirrored in server/src/lib/builder-integrations.test.ts —
  // keep that spec in sync if this logic changes.
  window.__xrayBuildIntegrationOptions = function(integrations, currentValue) {
    var out = [{ value: '', label: 'Custom (no auth)' }];
    if (Array.isArray(integrations)) {
      for (var i = 0; i < integrations.length; i++) {
        var it = integrations[i];
        if (!it || !it.slug) continue;
        out.push({ value: it.slug, label: it.display_name || it.slug });
      }
    }
    if (currentValue && !out.some(function(o) { return o.value === currentValue; })) {
      out.push({ value: currentValue, label: currentValue + ' (not in catalog)', preserved: true });
    }
    return out;
  };

  // Pill status string for a given integration slug, keyed off the
  // cache. Returns one of: 'connected', 'needs_reconnect',
  // 'not_connected', 'unknown'. Views use this to render pills.
  window.__xrayIntegrationStatus = function(slug, integrations) {
    if (!slug) return null;
    var list = integrations || __xrayIntegrationCache || [];
    var it = list.find(function(x) { return x.slug === slug; });
    if (!it) return 'unknown';
    if (!it.has_connection) return 'not_connected';
    if (it.connection_status === 'error') return 'needs_reconnect';
    if (it.connection_status === 'active') return 'connected';
    return 'not_connected';
  };

  window.__xrayOpenConnectModal = function(slug, onConnected) {
    __xrayFetchIntegrations(true).then(function(list) {
      var it = list.find(function(x) { return x.slug === slug; });
      if (!it) {
        toast('Integration "' + slug + '" is not in the catalog.', 'error');
        return;
      }
      var overlay = document.createElement('div');
      overlay.className = 'modal-overlay';
      overlay.style.display = 'flex';
      overlay.innerHTML =
        '<div class="modal" style="max-width:620px">'
        + '<div class="modal-head"><div class="modal-title">Connect ' + (it.display_name || slug) + '</div>'
        + '<button class="modal-close" data-close>&times;</button></div>'
        + '<div class="modal-body">'
        + '<div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">'
        + renderConnectCard('oauth', it)
        + renderConnectCard('api_key', it)
        + '</div>'
        + '<div id="connect-api-key-form" style="display:none;margin-top:16px">'
        + '<label style="display:block;font-size:13px;color:var(--t2);margin-bottom:6px">API key</label>'
        + '<input type="password" id="connect-api-key-input" style="width:100%;padding:8px" placeholder="Paste your API key">'
        + (it.api_key_instructions ? '<div style="font-size:12px;color:var(--t3);margin-top:6px">' + escHtml(it.api_key_instructions) + '</div>' : '')
        + '<div id="connect-api-key-err" style="color:var(--error,#b31812);font-size:13px;margin-top:8px;display:none"></div>'
        + '<div style="margin-top:10px;display:flex;gap:8px;justify-content:flex-end">'
        + '<button class="btn" data-cancel-apikey>Cancel</button>'
        + '<button class="btn primary" data-save-apikey>Save API key</button>'
        + '</div>'
        + '</div>'
        + '</div></div>';
      document.body.appendChild(overlay);

      function close() { overlay.remove(); }
      overlay.querySelector('[data-close]').onclick = close;

      var oauthBtn = overlay.querySelector('[data-connect-oauth]');
      if (oauthBtn) oauthBtn.onclick = function() {
        api.get('/api/connections/oauth/' + encodeURIComponent(slug) + '/authorize').then(function(r) {
          if (!r.ok || !r.data || !r.data.authorize_url) {
            toast((r.error && r.error.message) || 'Could not start OAuth flow', 'error');
            return;
          }
          // Full-page redirect — provider X-Frame-Options defeats iframes
          // and popup blockers are unreliable. Server redirects back to
          // /app with ?connected=<slug> on success.
          window.location.href = r.data.authorize_url;
        });
      };
      var apiBtn = overlay.querySelector('[data-connect-apikey]');
      var apiForm = overlay.querySelector('#connect-api-key-form');
      if (apiBtn) apiBtn.onclick = function() {
        apiForm.style.display = '';
        // Put the cursor in the input so the user can paste without a
        // second click. Defer one tick so the browser has painted the
        // now-visible form before .focus() runs.
        var input = overlay.querySelector('#connect-api-key-input');
        if (input) setTimeout(function() { try { input.focus(); } catch (e) {} }, 0);
      };
      var cancelApi = overlay.querySelector('[data-cancel-apikey]');
      if (cancelApi) cancelApi.onclick = function() { apiForm.style.display = 'none'; };
      var saveApi = overlay.querySelector('[data-save-apikey]');
      if (saveApi) saveApi.onclick = function() {
        var v = overlay.querySelector('#connect-api-key-input').value.trim();
        var err = overlay.querySelector('#connect-api-key-err');
        err.style.display = 'none';
        if (!v) { err.textContent = 'API key required'; err.style.display = ''; return; }
        api.post('/api/connections/api-key/' + encodeURIComponent(slug), { apiKey: v }).then(function(r) {
          if (!r.ok) {
            err.textContent = (r.error && r.error.message) || 'Save failed';
            err.style.display = '';
            return;
          }
          __xrayIntegrationCacheAt = 0; // force refresh on next read
          toast('Connected to ' + (it.display_name || slug), 'success');
          close();
          if (typeof onConnected === 'function') onConnected();
        });
      };
    });
  };

  function renderConnectCard(method, integration) {
    var supported = method === 'oauth' ? integration.supports_oauth : integration.supports_api_key;
    var label = method === 'oauth' ? 'OAuth' : 'API Key';
    var desc = method === 'oauth'
      ? 'Sign in through the provider. Tokens refresh automatically.'
      : 'Paste an API key you created in the provider dashboard.';
    var dimmed = !supported ? 'opacity:.45;pointer-events:none' : 'cursor:pointer';
    var notAvail = method === 'oauth'
      ? 'OAuth not available for this integration yet.'
      : 'This provider does not offer API keys.';
    return ''
      + '<div class="connect-card" style="border:1px solid var(--border,#444);border-radius:8px;padding:16px;' + dimmed + '"'
      + (supported ? ' data-connect-' + (method === 'oauth' ? 'oauth' : 'apikey') : '') + '>'
      + '<div style="font-weight:600;margin-bottom:6px">' + label + (method === 'oauth' && integration.supports_oauth ? ' <span style="font-size:11px;color:var(--t3)">recommended</span>' : '') + '</div>'
      + '<div style="font-size:13px;color:var(--t2);margin-bottom:10px">' + (supported ? desc : notAvail) + '</div>'
      + (supported ? '<div class="btn primary" style="text-align:center">' + (method === 'oauth' ? 'Connect' : 'Paste key') + '</div>' : '')
      + '</div>';
  }

  function escHtml(s) {
    if (!s) return '';
    var d = document.createElement('div');
    d.textContent = s;
    return d.innerHTML;
  }

  // ── Auth UI ──
  function showAuthErr(formId, msg) {
    var el = document.getElementById(formId);
    if (!el) return;
    el.textContent = msg;
    el.style.display = msg ? '' : 'none';
  }

  // Login
  document.getElementById('btn-login').onclick = function() {
    var email = document.getElementById('land-login-email').value.trim();
    if (!email) { showAuthErr('login-err', 'Email is required.'); return; }
    showAuthErr('login-err', '');
    this.disabled = true;
    var btn = this;
    api.post('/api/auth/magic-link', { email: email }).then(function(d) {
      if (!d.ok) { showAuthErr('login-err', (d.error && d.error.message) || 'Failed to send code.'); return; }
      pendingEmail = email;
      pendingFlow = 'login';
      window.__pendingFlow = 'login';
      document.getElementById('verify-sub').textContent = 'We sent a 6-digit code to ' + email;
      showLandingForm('verify');
    }).catch(function() { showAuthErr('login-err', 'Network error.'); })
      .finally(function() { btn.disabled = false; });
  };

  document.getElementById('land-login-email').onkeydown = function(e) {
    if (e.key === 'Enter') document.getElementById('btn-login').click();
  };

  // Passkey login
  document.getElementById('btn-passkey-login').onclick = function() {
    if (!window.PublicKeyCredential) {
      showAuthErr('login-err', 'Passkeys are not supported in this browser.');
      return;
    }
    var btn = this;
    btn.disabled = true;
    showAuthErr('login-err', '');

    function b64urlToBytes(b64) {
      var s = b64.replace(/-/g, '+').replace(/_/g, '/');
      while (s.length % 4) s += '=';
      var bin = atob(s);
      var arr = new Uint8Array(bin.length);
      for (var i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
      return arr;
    }
    function bytesToB64url(buf) {
      var arr = new Uint8Array(buf);
      var s = '';
      for (var i = 0; i < arr.length; i++) s += String.fromCharCode(arr[i]);
      return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
    }

    api.post('/api/auth/passkey/begin', {}).then(function(r) {
      if (!r.ok) {
        btn.disabled = false;
        showAuthErr('login-err', (r.error && r.error.message) || 'Failed to start passkey auth.');
        return;
      }
      var opts = r.data;
      var getOpts = {
        publicKey: {
          challenge: b64urlToBytes(opts.challenge),
          timeout: opts.timeout || 60000,
          rpId: opts.rpId,
          userVerification: opts.userVerification || 'preferred'
        }
      };
      if (opts.allowCredentials && opts.allowCredentials.length > 0) {
        getOpts.publicKey.allowCredentials = opts.allowCredentials.map(function(c) {
          return { id: b64urlToBytes(c.id), type: c.type || 'public-key', transports: c.transports };
        });
      }
      return navigator.credentials.get(getOpts);
    }).then(function(credential) {
      if (!credential) { btn.disabled = false; return; }
      var response = credential.response;
      var body = {
        id: credential.id,
        rawId: bytesToB64url(credential.rawId),
        type: credential.type,
        response: {
          authenticatorData: bytesToB64url(response.authenticatorData),
          clientDataJSON: bytesToB64url(response.clientDataJSON),
          signature: bytesToB64url(response.signature)
        }
      };
      if (response.userHandle) body.response.userHandle = bytesToB64url(response.userHandle);
      return api.post('/api/auth/passkey/complete', body);
    }).then(function(r) {
      btn.disabled = false;
      if (!r) return;
      if (r.ok && r.data && r.data.mfa_required) {
        showMfaStep(r.data.mfa_required, r.data.mfa_token);
        return;
      }
      if (r.ok && r.data && r.data.accessToken) {
        accessToken = r.data.accessToken;
        enterApp();
      } else {
        showAuthErr('login-err', (r.error && r.error.message) || 'Passkey verification failed.');
      }
    }).catch(function(err) {
      btn.disabled = false;
      if (err.name === 'NotAllowedError') {
        showAuthErr('login-err', 'Authentication cancelled.');
      } else {
        showAuthErr('login-err', 'Passkey error: ' + (err.message || 'Unknown'));
      }
    });
  };

  // Signup
  document.getElementById('btn-signup').onclick = function() {
    var name = document.getElementById('signup-name').value.trim();
    var email = document.getElementById('signup-email').value.trim();
    var org = document.getElementById('signup-org').value.trim();
    if (!name || !email || !org) { showAuthErr('signup-err', 'All fields are required.'); return; }
    showAuthErr('signup-err', '');
    this.disabled = true;
    var btn = this;
    api.post('/api/auth/signup', { name: name, email: email, tenantName: org }).then(function(d) {
      if (!d.ok) {
        var code = d.error && d.error.code;
        var msg = (d.error && d.error.message) || 'Signup failed.';
        if (code === 'SLUG_TAKEN' || code === 'TENANT_EXISTS' || code === 'INVALID_TENANT_NAME') {
          var orgEl = document.getElementById('signup-org');
          if (orgEl) { orgEl.focus(); orgEl.select(); }
        } else if (code === 'EMAIL_EXISTS') {
          var emEl = document.getElementById('signup-email');
          if (emEl) { emEl.focus(); emEl.select(); }
        }
        showAuthErr('signup-err', msg);
        return;
      }
      pendingEmail = email;
      pendingFlow = 'signup';
      window.__pendingFlow = 'signup';
      document.getElementById('verify-sub').textContent = 'We sent a 6-digit code to ' + email;
      showLandingForm('verify');
    }).catch(function() { showAuthErr('signup-err', 'Network error.'); })
      .finally(function() { btn.disabled = false; });
  };

  // Signup Enter key
  ['signup-name', 'signup-email', 'signup-org'].forEach(function(id) {
    var el = document.getElementById(id);
    if (el) el.onkeydown = function(e) {
      if (e.key === 'Enter') document.getElementById('btn-signup').click();
    };
  });

  // First-boot setup
  document.getElementById('btn-setup').onclick = function() {
    var name = document.getElementById('setup-name').value.trim();
    var email = document.getElementById('setup-email').value.trim();
    var org = document.getElementById('setup-org').value.trim();
    if (!name) { showAuthErr('setup-err', 'Full name is required.'); document.getElementById('setup-name').focus(); return; }
    if (!email) { showAuthErr('setup-err', 'Admin email is required.'); document.getElementById('setup-email').focus(); return; }
    if (!org) { showAuthErr('setup-err', 'Organization name is required.'); document.getElementById('setup-org').focus(); return; }
    showAuthErr('setup-err', '');
    this.disabled = true;
    var btn = this;
    api.post('/api/auth/setup', { name: name, email: email, tenantName: org }).then(function(d) {
      if (!d.ok) {
        var code = d.error && d.error.code;
        var msg = (d.error && d.error.message) || 'Setup failed.';
        if (code === 'SLUG_TAKEN' || code === 'TENANT_EXISTS' || code === 'INVALID_TENANT_NAME') {
          document.getElementById('setup-org').focus();
        }
        showAuthErr('setup-err', msg);
        return;
      }
      accessToken = d.data.accessToken;
      enterApp();
    }).catch(function() { showAuthErr('setup-err', 'Network error.'); })
      .finally(function() { btn.disabled = false; });
  };

  // Setup Enter key
  ['setup-name', 'setup-email', 'setup-org'].forEach(function(id) {
    var el = document.getElementById(id);
    if (el) el.onkeydown = function(e) {
      if (e.key === 'Enter') document.getElementById('btn-setup').click();
    };
  });

  // Verify
  document.getElementById('btn-verify').onclick = function() {
    var code = document.getElementById('verify-code').value.trim();
    if (!code) { showAuthErr('verify-err', 'Enter the 6-digit code.'); return; }
    showAuthErr('verify-err', '');
    this.disabled = true;
    var btn = this;
    api.post('/api/auth/verify', { email: pendingEmail, code: code }).then(function(d) {
      if (!d.ok) {
        var errCode = d.error && d.error.code;
        var msg = (d.error && d.error.message) || 'Invalid code.';
        var details = (d.error && d.error.details) || {};
        showVerifyError(errCode, msg, details);
        return;
      }
      // Step 9 MFA gate.
      if (d.data && d.data.mfa_required) {
        showMfaStep(d.data.mfa_required, d.data.mfa_token);
        return;
      }
      // Surface the per-day "N attempts left" banner (≤10) on the success path.
      if (typeof d.data.attempts_remaining === 'number') {
        showAttemptsRemainingBanner(d.data.attempts_remaining);
      }
      // Multi-tenant: show tenant picker
      if (d.data.tenants && d.data.tenants.length > 1) {
        showTenantPicker(d.data.tenants, d.data.email);
        return;
      }
      accessToken = d.data.accessToken;
      enterApp();
    }).catch(function() { showAuthErr('verify-err', 'Network error.'); })
      .finally(function() { btn.disabled = false; });
  };

  // Show verify-form error with an embedded "Resend code" CTA when the
  // failure is due to an expired/used magic link. Clicking resends via
  // the same endpoint that initiated the flow (signup vs. login) so the
  // user can recover without retyping anything.
  //
  // Step 9: details.attempts_remaining (per-link, from migration 033's
  // max_attempts column) is appended to the message so the user sees
  // "N attempts left" alongside the "Resend code" CTA.
  function showVerifyError(code, msg, details) {
    var errEl = document.getElementById('verify-err');
    if (!errEl) { showAuthErr('verify-err', msg); return; }
    var retryable = code === 'MAGIC_LINK_EXPIRED' || code === 'MAGIC_LINK_USED' || code === 'MAX_ATTEMPTS';
    errEl.innerHTML = '';
    var msgSpan = document.createElement('span');
    var fullMsg = msg;
    if (details && typeof details.attempts_remaining === 'number') {
      fullMsg += ' (' + details.attempts_remaining + ' attempt' +
        (details.attempts_remaining === 1 ? '' : 's') + ' left)';
    }
    msgSpan.textContent = fullMsg;
    errEl.appendChild(msgSpan);
    if (retryable && pendingEmail) {
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.textContent = 'Resend code';
      btn.style.cssText = 'margin-left:8px;background:none;border:none;color:inherit;text-decoration:underline;cursor:pointer;padding:0;font:inherit';
      btn.onclick = function() {
        btn.disabled = true;
        btn.textContent = 'Sending…';
        var endpoint = pendingFlow === 'signup' ? '/api/auth/signup' : '/api/auth/magic-link';
        var body = pendingFlow === 'signup'
          ? { email: pendingEmail, name: document.getElementById('signup-name').value.trim(), tenantName: document.getElementById('signup-org').value.trim() }
          : { email: pendingEmail };
        api.post(endpoint, body).then(function(r) {
          if (r && r.ok) {
            errEl.textContent = 'A new code has been sent to ' + pendingEmail + '.';
          } else {
            btn.disabled = false;
            btn.textContent = 'Resend code';
            errEl.textContent = (r && r.error && r.error.message) || 'Could not resend the code.';
          }
        }).catch(function() {
          btn.disabled = false;
          btn.textContent = 'Resend code';
          errEl.textContent = 'Network error — try again.';
        });
      };
      errEl.appendChild(btn);
    }
    errEl.style.display = '';
  }

  document.getElementById('verify-code').onkeydown = function(e) {
    if (e.key === 'Enter') document.getElementById('btn-verify').click();
  };

  // Tenant picker for multi-tenant users
  function showTenantPicker(tenants, email) {
    showLandingForm('tenant-picker');
    var list = document.getElementById('tenant-picker-list');
    var html = '';
    tenants.forEach(function(t) {
      var roleLabel = t.role === 'owner' ? 'Owner' : t.role === 'admin' ? 'Admin' : t.role === 'platform_admin' ? 'Platform Admin' : 'Member';
      html += '<button class="tenant-picker-btn" data-tid="' + t.id + '">';
      html += '<span class="tp-name">' + (t.name || 'Unnamed').replace(/</g, '&lt;') + '</span>';
      html += '<span class="tp-role">' + roleLabel + '</span>';
      html += '</button>';
    });
    list.innerHTML = html;
    list.querySelectorAll('.tenant-picker-btn').forEach(function(btn) {
      btn.onclick = function() {
        var tid = this.getAttribute('data-tid');
        showAuthErr('tenant-picker-err', '');
        list.querySelectorAll('.tenant-picker-btn').forEach(function(b) { b.disabled = true; });
        api.post('/api/auth/select-tenant', { email: email, tenantId: tid }).then(function(d) {
          list.querySelectorAll('.tenant-picker-btn').forEach(function(b) { b.disabled = false; });
          if (!d.ok) { showAuthErr('tenant-picker-err', (d.error && d.error.message) || 'Failed to select organization.'); return; }
          if (d.data && d.data.mfa_required) {
            showMfaStep(d.data.mfa_required, d.data.mfa_token);
            return;
          }
          accessToken = d.data.accessToken;
          enterApp();
        }).catch(function() {
          list.querySelectorAll('.tenant-picker-btn').forEach(function(b) { b.disabled = false; });
          showAuthErr('tenant-picker-err', 'Network error.');
        });
      };
    });
  }

  // ── Step-9 helpers: MFA second-factor + per-day attempts banner ──
  //
  // showMfaStep(kind, mfaToken):
  //   kind 'verify' — user has a confirmed TOTP. Prompt for code (or
  //   backup code), POST /api/auth/totp/verify, finalize session.
  //   kind 'enroll' — admin path, MFA required and not yet enrolled.
  //   Call /totp/enroll for QR + secret, prompt for first code, POST
  //   /totp/confirm. The confirm response carries the full session
  //   token (server-side createSession) plus the 8 backup codes.
  function showMfaStep(kind, mfaToken) {
    showLandingForm('totp');
    var titleEl = document.getElementById('totp-step-title');
    var subEl = document.getElementById('totp-step-sub');
    var enrollWrap = document.getElementById('totp-enroll-wrap');
    var codeEl = document.getElementById('totp-step-code');
    var backupWrap = document.getElementById('totp-step-backup-wrap');
    var btnVerify = document.getElementById('btn-totp-step');
    var errEl = document.getElementById('totp-err');
    if (errEl) { errEl.textContent = ''; errEl.style.display = 'none'; }
    backupWrap.style.display = 'none';
    codeEl.value = '';

    if (kind === 'verify') {
      titleEl.textContent = 'Two-factor authentication';
      subEl.textContent = 'Enter the 6-digit code from your authenticator (or a backup code).';
      enrollWrap.style.display = 'none';
      btnVerify.textContent = 'Verify';
      btnVerify.onclick = function() {
        var code = codeEl.value.trim();
        if (!code) { showTotpErr('Enter the code.'); return; }
        showTotpErr('');
        btnVerify.disabled = true;
        api.post('/api/auth/totp/verify', { mfa_token: mfaToken, code: code })
          .then(function(d) {
            btnVerify.disabled = false;
            if (!d.ok) { showTotpErr((d.error && d.error.message) || 'Incorrect code.'); return; }
            accessToken = d.data.accessToken;
            enterApp();
          }).catch(function() { btnVerify.disabled = false; showTotpErr('Network error.'); });
      };
      codeEl.focus();
      return;
    }

    // kind === 'enroll'
    titleEl.textContent = 'Set up two-factor authentication';
    subEl.textContent = 'Your administrator requires TOTP for platform admins. Scan the QR with an authenticator app, then enter the 6-digit code.';
    enrollWrap.style.display = '';
    btnVerify.textContent = 'Confirm enrollment';
    btnVerify.disabled = true;
    api.post('/api/auth/totp/enroll', { mfa_token: mfaToken }).then(function(r) {
      if (!r.ok || !r.data) { showTotpErr((r.error && r.error.message) || 'Failed to start enrollment.'); return; }
      document.getElementById('totp-step-qr').src = r.data.qr_data_url;
      document.getElementById('totp-step-secret').textContent = r.data.secret;
      btnVerify.disabled = false;
      codeEl.focus();
    });
    btnVerify.onclick = function() {
      var code = codeEl.value.trim();
      if (!/^\d{6}$/.test(code)) { showTotpErr('Enter the 6-digit code from the app.'); return; }
      showTotpErr('');
      btnVerify.disabled = true;
      api.post('/api/auth/totp/confirm', { mfa_token: mfaToken, code: code })
        .then(function(d) {
          btnVerify.disabled = false;
          if (!d.ok || !d.data || !d.data.confirmed) {
            showTotpErr((d.error && d.error.message) || 'Incorrect code.');
            return;
          }
          var codes = d.data.backup_codes || [];
          var grid = document.getElementById('totp-step-backup-codes');
          grid.innerHTML = codes.map(function(c) {
            return '<div style="padding:6px 8px;background:rgba(255,255,255,.08);border-radius:3px">' + c + '</div>';
          }).join('');
          backupWrap.style.display = '';
          enrollWrap.style.display = 'none';
          btnVerify.style.display = 'none';
          var doneBtn = document.getElementById('btn-totp-step-backup-done');
          var confirmCb = document.getElementById('totp-step-backup-confirm');
          confirmCb.checked = false;
          doneBtn.disabled = true;
          confirmCb.onchange = function() { doneBtn.disabled = !confirmCb.checked; };
          doneBtn.onclick = function() {
            if (d.data.accessToken) {
              accessToken = d.data.accessToken;
              enterApp();
            }
          };
        }).catch(function() { btnVerify.disabled = false; showTotpErr('Network error.'); });
    };
  }
  function showTotpErr(msg) {
    var el = document.getElementById('totp-err');
    if (!el) return;
    el.textContent = msg || '';
    el.style.display = msg ? '' : 'none';
  }
  function showAttemptsRemainingBanner(remaining) {
    // Per-day per-email counter banner. Triggers ≤10. Distinct from
    // the per-link counter — this one is "you have N tries today
    // before you're locked out" rather than "this code accepts N
    // more guesses." Render as a top-of-modal warning bar so the
    // user sees it during the next code request.
    var modal = document.querySelector('.land-modal-body') || document.getElementById('loginModal');
    if (!modal) return;
    var existing = modal.querySelector('#attempts-remaining-banner');
    if (existing) existing.remove();
    var bar = document.createElement('div');
    bar.id = 'attempts-remaining-banner';
    bar.style.cssText = 'background:rgba(255,180,0,.15);border:1px solid rgba(255,180,0,.4);color:#ffd47a;padding:8px 12px;border-radius:4px;margin-bottom:12px;font-size:13px';
    bar.textContent = remaining === 0
      ? 'No more sign-in attempts allowed today. Try again tomorrow.'
      : remaining + ' sign-in attempt' + (remaining === 1 ? '' : 's') + ' remaining today.';
    modal.insertBefore(bar, modal.firstChild);
  }

  // ── OAuth callback return handler ──
  // Callback route redirects back to the app with either ?connected=<slug>
  // or ?oauth_error=<code>. Toast the outcome and strip the query params
  // so a browser reload doesn't repeat the toast.
  function checkOauthReturnParams() {
    var params = new URLSearchParams(window.location.search);
    var connected = params.get('connected');
    var err = params.get('oauth_error');
    if (!connected && !err) return;
    // Clean up URL regardless of outcome.
    params.delete('connected');
    params.delete('oauth_error');
    params.delete('oauth_desc');
    var qs = params.toString();
    window.history.replaceState({}, '', window.location.pathname + (qs ? '?' + qs : '') + window.location.hash);
    if (connected) {
      toast('Connected to ' + connected, 'success');
    } else if (err) {
      var desc = params.get('oauth_desc') || err;
      toast('OAuth connect failed: ' + desc, 'error');
    }
  }

  // ── Check magic link token in URL ──
  function checkUrlToken() {
    var params = new URLSearchParams(window.location.search);
    var token = params.get('token');
    if (!token) return false;
    window.history.replaceState({}, '', window.location.pathname + window.location.hash);
    document.getElementById('landing-screen').style.display = 'none';
    api.post('/api/auth/verify-token', { token: token }).then(function(d) {
      if (d.ok && d.data) {
        if (d.data.mfa_required) {
          document.getElementById('landing-screen').style.display = '';
          openModal('totp');
          showMfaStep(d.data.mfa_required, d.data.mfa_token);
          return;
        }
        if (d.data.tenants && d.data.tenants.length > 1) {
          document.getElementById('landing-screen').style.display = '';
          openModal('tenant-picker');
          showTenantPicker(d.data.tenants, d.data.email);
          return;
        }
        if (d.data.accessToken) {
          accessToken = d.data.accessToken;
          enterApp();
          return;
        }
      }
      // Verify failed — surface the specific error on the login form
      // and open the modal so the user can request a fresh link instead
      // of staring at a blank page.
      document.getElementById('landing-screen').style.display = '';
      openModal('login');
      var code = d && d.error && d.error.code;
      var msg = (d && d.error && d.error.message) || 'This link is no longer valid.';
      showMagicLinkExpiredOnLogin(code, msg);
    }).catch(function() {
      document.getElementById('landing-screen').style.display = '';
      openModal('login');
      showMagicLinkExpiredOnLogin('NETWORK', 'Network error — could not verify the link.');
    });
    return true;
  }

  // Render the login form's error area with a re-request CTA when a
  // magic-link verify fails with a known code. The button re-submits
  // the email through /api/auth/magic-link so the user never has to
  // retype anything.
  function showMagicLinkExpiredOnLogin(code, msg) {
    var errEl = document.getElementById('login-err');
    if (!errEl) return;
    var retryable = code === 'MAGIC_LINK_EXPIRED' || code === 'MAGIC_LINK_USED' || code === 'INVALID_TOKEN';
    errEl.innerHTML = '';
    var msgSpan = document.createElement('span');
    msgSpan.textContent = msg;
    errEl.appendChild(msgSpan);
    if (retryable) {
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.textContent = 'Send a new link';
      btn.style.cssText = 'margin-left:8px;background:none;border:none;color:inherit;text-decoration:underline;cursor:pointer;padding:0;font:inherit';
      btn.onclick = function() {
        var email = (document.getElementById('land-login-email') || { value: '' }).value.trim();
        if (!email) {
          errEl.textContent = 'Enter your email above, then click Send a new link.';
          var emailEl = document.getElementById('land-login-email');
          if (emailEl) emailEl.focus();
          return;
        }
        btn.disabled = true;
        btn.textContent = 'Sending…';
        api.post('/api/auth/magic-link', { email: email }).then(function(r) {
          if (r && r.ok) {
            errEl.textContent = 'A new link has been sent to ' + email + '.';
          } else {
            btn.disabled = false;
            btn.textContent = 'Send a new link';
            errEl.textContent = (r && r.error && r.error.message) || 'Could not send a new link.';
          }
        }).catch(function() {
          btn.disabled = false;
          btn.textContent = 'Send a new link';
          errEl.textContent = 'Network error — try again.';
        });
      };
      errEl.appendChild(btn);
    }
    errEl.style.display = '';
  }

  // ── Enter app ──
  function enterApp() {
    document.getElementById('landing-screen').style.display = 'none';
    closeModal();
    document.getElementById('app-shell').style.display = 'block';

    api.get('/api/users/me').then(function(d) {
      if (!d.ok) { logout(); return; }
      currentUser = d.data;
      document.getElementById('user-name').textContent = currentUser.name || currentUser.email;
      renderImpersonationBanner();
      buildSidebar();
      buildMobileNav();
      loadBundle();
      // Step 11: gate every entry on the policy re-acceptance check.
      // If any required slug's latest version is newer than what
      // the user has accepted, a blocking modal appears before they
      // can interact with the app.
      checkPolicyStatus();
      // Prompt for passkey setup on first login (no passkeys registered yet)
      promptPasskeySetup();
      // Load tenant switcher for multi-tenant users
      loadTenantSwitcher();
      // Start proactive token refresh to prevent silent logout
      startTokenRefresh();
      // Start WebSocket for real-time updates (all users)
      if (!currentUser.is_platform_admin) { connectWebSocket(); subscribeToPush(); }
      // Platform admins also need WebSocket for live session shadow viewing
      if (currentUser.is_platform_admin) { connectWebSocket(); }
      // Start session replay recording (non-platform-admins only)
      startReplaySession();
      // Also try to start recording when user returns to the tab (covers page refresh edge cases)
      document.addEventListener('visibilitychange', function() {
        if (!document.hidden && currentUser && !_replaySessionId) startReplaySession();
      });
      // Check if we were opened from a push notification with a meet-join hash
      checkMeetJoinHash();
      // Also listen for hash changes (when SW navigates an existing client to a meet-join hash)
      window.addEventListener('hashchange', function() { checkMeetJoinHash(); });
    });
  }

  function promptPasskeySetup() {
    if (!window.PublicKeyCredential) return;
    // Check if user already has passkeys
    api.get('/api/users/me/passkeys').then(function(r) {
      if (!r.ok) return;
      var passkeys = r.data || [];
      if (passkeys.length > 0) return; // already has passkeys
      // Check if user already dismissed the prompt
      try { if (localStorage.getItem('xray_passkey_dismissed')) return; } catch(e) {}
      showPasskeyPrompt();
    }).catch(function() {});
  }

  // ── Step 11: re-acceptance modal ──
  // Polls /api/users/me/policy-status; if any required slug is
  // pending (current_version > accepted_version, or accepted=null),
  // shows a blocking modal before the user can interact. The
  // single round-trip POSTs all checked slugs then reads the
  // updated pending list from the response so missed acceptances
  // re-render without a fresh GET.
  function checkPolicyStatus() {
    api.get('/api/users/me/policy-status').then(function(r) {
      if (!r.ok || !r.data || !Array.isArray(r.data.pending) || r.data.pending.length === 0) return;
      showPolicyAcceptModal(r.data.pending);
    }).catch(function() {});
  }

  // Step 11: bridge so landing.js's cookie banner can record the
  // server-side acceptance row for a logged-in visitor. landing.js
  // doesn't have direct access to api._fetch / accessToken, so we
  // expose a thin helper here. No-op when no access token is in
  // memory (logged-out landing visit).
  window.__xrayRecordCookieAcceptance = function(version, choices) {
    if (!accessToken || !version) return;
    api.post('/api/users/me/policy-accept', { slug: 'cookie_policy', version: version }).catch(function() {});
    void choices; // categories live in localStorage; server only tracks the policy version
  };

  function showPolicyAcceptModal(pending) {
    if (document.getElementById('policy-accept-overlay')) return;
    var overlay = document.createElement('div');
    overlay.id = 'policy-accept-overlay';
    overlay.className = 'modal-overlay';
    overlay.style.zIndex = '9500';
    var rowsHtml = pending.map(function(p) {
      var label = p.title || p.slug;
      var detail = p.accepted_version
        ? ('Updated to v' + p.current_version + ' (you accepted v' + p.accepted_version + ')')
        : ('v' + p.current_version + ' — first acceptance');
      // Custom checkbox: visually-hidden native input + .xc-box visual.
      // Sibling-selector CSS (.xc-input:checked + .xc-box) handles the
      // tick. escHtml() handles `&"<>` properly — the previous
      // .replace(/[<>]/g,'') only escaped two of the four characters
      // and would let `"` break out of attribute context.
      return '<label class="policy-accept-row">'
        + '<input type="checkbox" class="policy-accept-cb xc-input" data-slug="' + encodeURIComponent(p.slug) + '" data-version="' + p.current_version + '">'
        + '<span class="xc-box" aria-hidden="true">'
        +   '<svg viewBox="0 0 16 16" width="11" height="11" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 8 7 12 13 4"/></svg>'
        + '</span>'
        + '<span class="policy-accept-row-body">'
        +   '<span class="policy-accept-row-title">' + escHtml(label) + '</span>'
        +   '<span class="policy-accept-row-meta">' + escHtml(detail) + '</span>'
        +   '<a href="/legal/' + encodeURIComponent(p.slug) + '" target="_blank" rel="noopener" class="policy-accept-row-link">Read the document &rarr;</a>'
        + '</span>'
        + '</label>';
    }).join('');
    overlay.innerHTML = '<div class="modal" style="width:560px">'
      + '<div class="modal-head"><div class="modal-title">Updated policies</div></div>'
      + '<div class="modal-body">'
      + '<p style="font-size:14px;color:var(--t2);margin:0 0 16px">We\'ve updated the policies below. Please review and accept each before continuing.</p>'
      + rowsHtml
      + '<p id="policy-accept-err" style="display:none;color:#ef4444;font-size:13px;margin:12px 0 0"></p>'
      + '</div>'
      + '<div class="modal-foot"><button class="btn primary" id="policy-accept-btn" disabled>I accept</button></div>'
      + '</div>';
    document.body.appendChild(overlay);

    var cbs = overlay.querySelectorAll('.policy-accept-cb');
    var btn = overlay.querySelector('#policy-accept-btn');
    function refreshBtn() {
      var allChecked = true;
      cbs.forEach(function(cb) { if (!cb.checked) allChecked = false; });
      btn.disabled = !allChecked;
    }
    cbs.forEach(function(cb) { cb.addEventListener('change', refreshBtn); });

    btn.onclick = function() {
      btn.disabled = true;
      btn.textContent = 'Saving…';
      var errEl = overlay.querySelector('#policy-accept-err');
      errEl.style.display = 'none';
      var jobs = Array.prototype.map.call(cbs, function(cb) {
        return api.post('/api/users/me/policy-accept', {
          slug: decodeURIComponent(cb.getAttribute('data-slug')),
          version: parseInt(cb.getAttribute('data-version'), 10),
        });
      });
      Promise.all(jobs).then(function(results) {
        var lastOk = results[results.length - 1];
        var stillPending = (lastOk && lastOk.ok && lastOk.data && Array.isArray(lastOk.data.pending)) ? lastOk.data.pending : [];
        // The POST returns the updated `pending` list. If anything
        // is left (race against a concurrent admin publish), keep
        // the modal open with the new list rather than letting the
        // user past a still-stale set.
        var failed = results.some(function(r) { return !r || !r.ok; });
        if (failed || stillPending.length > 0) {
          overlay.remove();
          if (stillPending.length > 0) {
            showPolicyAcceptModal(stillPending);
          } else {
            errEl.textContent = 'Failed to save your acceptance. Please try again.';
            errEl.style.display = '';
            btn.disabled = false;
            btn.textContent = 'I accept';
          }
          return;
        }
        overlay.remove();
      }).catch(function() {
        errEl.textContent = 'Network error. Please try again.';
        errEl.style.display = '';
        btn.disabled = false;
        btn.textContent = 'I accept';
      });
    };
  }

  function showPasskeyPrompt() {
    var overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.style.zIndex = '8500';
    overlay.innerHTML = '<div class="modal" style="width:400px">'
      + '<div class="modal-head"><div class="modal-title">Set up passkey?</div></div>'
      + '<div class="modal-body"><p style="font-size:14px;color:var(--t2);margin-bottom:16px">Passkeys let you sign in quickly and securely with your fingerprint, face, or device PIN. Would you like to set one up now?</p></div>'
      + '<div class="modal-foot"><button class="btn" id="passkey-later">Later</button><button class="btn primary" id="passkey-setup-now">Set up now</button></div>'
      + '</div>';
    document.body.appendChild(overlay);

    overlay.querySelector('#passkey-later').onclick = function() {
      try { localStorage.setItem('xray_passkey_dismissed', '1'); } catch(e) {}
      overlay.remove();
    };
    overlay.querySelector('#passkey-setup-now').onclick = function() {
      overlay.remove();
      window.location.hash = 'account';
    };
    overlay.onclick = function(e) {
      if (e.target === overlay) {
        try { localStorage.setItem('xray_passkey_dismissed', '1'); } catch(e) {}
        overlay.remove();
      }
    };
  }

  // ── Logout ──
  function logout() {
    stopReplaySession();
    stopTokenRefresh();
    if (typeof closeWebSocket === 'function') closeWebSocket();
    // Unsubscribe push notifications so the next user on this device doesn't get them
    try {
      if ('serviceWorker' in navigator) {
        navigator.serviceWorker.ready.then(function(reg) {
          reg.pushManager.getSubscription().then(function(sub) {
            if (sub) {
              // Remove from server
              api.post('/api/meet/push/unsubscribe', { endpoint: sub.endpoint }).catch(function() {});
              sub.unsubscribe().catch(function() {});
            }
          });
        });
      }
    } catch(e) {}
    if (accessToken) api.post('/api/auth/logout').catch(function() {});
    accessToken = null;
    currentUser = null;
    currentView = null;
    document.getElementById('landing-screen').style.display = '';
    document.getElementById('app-shell').style.display = 'none';
    closeModal();
  }
  document.getElementById('btn-logout').onclick = logout;

  // Finalize replay session on tab close
  window.addEventListener('beforeunload', function() {
    if (_replaySessionId && accessToken) {
      // Use beacon endpoint: includes token + last events in body (no auth header needed)
      var beaconBody = { token: accessToken };
      if (_replayEventBuffer.length > 0 && _replaySegmentId) {
        beaconBody.segmentId = _replaySegmentId;
        beaconBody.events = _replayEventBuffer;
        _replayEventBuffer = [];
      }
      try {
        navigator.sendBeacon('/api/v1/replay/sessions/' + _replaySessionId + '/beacon',
          new Blob([JSON.stringify(beaconBody)], { type: 'application/json' }));
      } catch(e) {
        // Fallback to sync XHR
        try {
          var xhr = new XMLHttpRequest();
          xhr.open('POST', '/api/v1/replay/sessions/' + _replaySessionId + '/finalize', false);
          xhr.setRequestHeader('Content-Type', 'application/json');
          xhr.setRequestHeader('Authorization', 'Bearer ' + accessToken);
          xhr.send('{}');
        } catch(e2) {}
      }
    }
  });
  document.getElementById('header-logo').onclick = function() { if (accessToken) navigateTo('dashboard_list'); };
  window.logout = logout;
  window.getAccessToken = function() { return accessToken; };
  window.onReplaySegmentChange = onReplaySegmentChange;

  // ── Proactive token refresh ──
  // Access tokens expire in 15min. Refresh every 12min to avoid silent expiry.
  var _refreshInterval = null;
  var _refreshFailures = 0;
  function startTokenRefresh() {
    stopTokenRefresh();
    _refreshFailures = 0;
    _refreshInterval = setInterval(function() {
      if (!accessToken) return;
      api.refresh().then(function(ok) {
        if (ok) { _refreshFailures = 0; return; }
        _refreshFailures++;
        // Only logout after 3 consecutive failures (avoids transient errors)
        if (_refreshFailures >= 3 && accessToken) { logout(); }
      });
    }, 12 * 60 * 1000); // 12 minutes
  }
  function stopTokenRefresh() {
    if (_refreshInterval) { clearInterval(_refreshInterval); _refreshInterval = null; }
  }
  // Refresh when user returns to tab (may have been away > 15min)
  document.addEventListener('visibilitychange', function() {
    if (!document.hidden && accessToken) {
      api.refresh().then(function(ok) {
        if (ok) { _refreshFailures = 0; return; }
        // Retry once after 2 seconds before giving up
        setTimeout(function() {
          if (!accessToken) return;
          api.refresh().then(function(ok2) {
            if (ok2) { _refreshFailures = 0; return; }
            if (accessToken) logout();
          });
        }, 2000);
      });
    }
  });

  // ── Tenant Switcher ──
  function loadTenantSwitcher() {
    var switcher = document.getElementById('tenant-switcher');
    if (!switcher) return;
    api.get('/api/users/me/tenants').then(function(d) {
      if (!d.ok || !d.data || d.data.length <= 1) {
        switcher.style.display = 'none';
        return;
      }
      var tenants = d.data;
      var currentTid = currentUser.tenant_id;
      var currentTenant = tenants.filter(function(t) { return t.id === currentTid; })[0];
      if (!currentTenant) { switcher.style.display = 'none'; return; }

      switcher.style.display = '';
      document.getElementById('tenant-switcher-name').textContent = currentTenant.name;

      var dropdown = document.getElementById('tenant-switcher-dropdown');
      var html = '';
      tenants.forEach(function(t) {
        var isCurrent = t.id === currentTid;
        var roleLabel = t.role === 'owner' ? 'Owner' : t.role === 'admin' ? 'Admin' : t.role === 'platform_admin' ? 'Platform Admin' : 'Member';
        html += '<button class="ts-option' + (isCurrent ? ' current' : '') + '" data-tid="' + t.id + '">';
        html += '<span class="ts-opt-name">' + (t.name || '').replace(/</g, '&lt;') + '</span>';
        html += '<span class="ts-opt-role">' + roleLabel + (isCurrent ? ' (current)' : '') + '</span>';
        html += '</button>';
      });
      dropdown.innerHTML = html;

      document.getElementById('tenant-switcher-btn').onclick = function(e) {
        e.stopPropagation();
        var open = dropdown.style.display !== 'none';
        dropdown.style.display = open ? 'none' : '';
      };

      dropdown.querySelectorAll('.ts-option').forEach(function(btn) {
        btn.onclick = function() {
          var tid = this.getAttribute('data-tid');
          if (tid === currentTid) { dropdown.style.display = 'none'; return; }
          dropdown.style.display = 'none';
          toast('Switching organization...', 'info');
          api.post('/api/users/me/switch-tenant', { tenantId: tid }).then(function(d) {
            if (!d.ok) { toast((d.error && d.error.message) || 'Failed to switch', 'error'); return; }
            accessToken = d.data.accessToken;
            currentView = null;
            document.getElementById('view-container').innerHTML = '';
            enterApp();
          }).catch(function() { toast('Network error', 'error'); });
        };
      });

      // Close dropdown when clicking elsewhere
      document.addEventListener('click', function() { dropdown.style.display = 'none'; });

      // Mobile tenant switcher
      var mobSwitcher = document.getElementById('mob-tenant-switcher');
      if (mobSwitcher) {
        mobSwitcher.style.display = '';
        document.getElementById('mob-tenant-switcher-name').textContent = currentTenant.name;
        var mobDropdown = document.getElementById('mob-tenant-switcher-dropdown');
        mobDropdown.innerHTML = html;
        document.getElementById('mob-tenant-switcher-btn').onclick = function(e) {
          e.stopPropagation();
          var open = mobDropdown.style.display !== 'none';
          mobDropdown.style.display = open ? 'none' : '';
        };
        mobDropdown.querySelectorAll('.ts-option').forEach(function(btn) {
          btn.onclick = function() {
            var tid = this.getAttribute('data-tid');
            if (tid === currentTid) { mobDropdown.style.display = 'none'; return; }
            mobDropdown.style.display = 'none';
            if (window._closeMobileMenu) window._closeMobileMenu();
            toast('Switching organization...', 'info');
            api.post('/api/users/me/switch-tenant', { tenantId: tid }).then(function(d) {
              if (!d.ok) { toast((d.error && d.error.message) || 'Failed to switch', 'error'); return; }
              accessToken = d.data.accessToken;
              currentView = null;
              document.getElementById('view-container').innerHTML = '';
              enterApp();
            }).catch(function() { toast('Network error', 'error'); });
          };
        });
      }
    }).catch(function() { switcher.style.display = 'none'; });
  }

  // ── Build sidebar ──
  function buildSidebar() {
    if (!bundle || !bundle.nav) return;
    var sidebar = document.getElementById('sidebar');
    sidebar.innerHTML = '';
    var sections = {};
    var userPerms = [];
    if (currentUser && currentUser.permissions) userPerms = currentUser.permissions;
    var isAdmin = currentUser && currentUser.is_platform_admin;

    // Add collapse toggle at top
    var toggleWrap = document.createElement('div');
    toggleWrap.className = 'sidebar-toggle';
    var toggleBtn = document.createElement('button');
    toggleBtn.title = 'Toggle sidebar';
    toggleBtn.innerHTML = '<svg viewBox="0 0 24 24" width="18" height="18" stroke="currentColor" fill="none" stroke-width="1.5"><line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="18" x2="21" y2="18"/></svg>';
    toggleBtn.onclick = function() {
      sidebar.classList.toggle('collapsed');
      try { localStorage.setItem('xray_sidebar', sidebar.classList.contains('collapsed') ? '1' : '0'); } catch(e) {}
    };
    toggleWrap.appendChild(toggleBtn);
    sidebar.appendChild(toggleWrap);

    // Restore collapse state
    try {
      if (localStorage.getItem('xray_sidebar') === '1') sidebar.classList.add('collapsed');
    } catch(e) {}

    bundle.nav.forEach(function(item) {
      if (!isAdmin && item.permission && userPerms.indexOf(item.permission) === -1) return;
      // Hide billing nav for members without billing permission
      if (item.view === 'billing' && !isAdmin && currentUser && !currentUser.is_owner && !currentUser.has_billing) return;
      // Hide team nav for members without admin permission
      if (item.view === 'team' && !isAdmin && currentUser && !currentUser.is_owner && !currentUser.has_admin) return;
      // Hide connections nav for members without admin permission
      if (item.view === 'connections' && !isAdmin && currentUser && !currentUser.is_owner && !currentUser.has_admin) return;
      // Hide session replay nav if tenant doesn't have replay visible, or user lacks replay permission
      if (item.view === 'session_replay' && currentUser && (!currentUser.replay_visible || (!isAdmin && !currentUser.is_owner && !currentUser.has_replay))) return;
      var sec = item.section || 'main';
      if (!sections[sec]) sections[sec] = [];
      sections[sec].push(item);
    });

    var sectionLabels = {
      main: '', manage: 'Manage', account: 'Account', platform: 'Platform', config: 'Configuration', system: 'System'
    };
    var order = ['main', 'manage', 'account', 'platform', 'config', 'system'];

    order.forEach(function(sec) {
      if (!sections[sec] || sections[sec].length === 0) return;
      if (sectionLabels[sec]) {
        var label = document.createElement('div');
        label.className = 'nav-section';
        label.textContent = sectionLabels[sec];
        sidebar.appendChild(label);
      }
      sections[sec].forEach(function(item) {
        var el = document.createElement('div');
        el.className = 'nav-item';
        el.setAttribute('data-view', item.view);
        var badgeHtml = item.view === 'inbox' ? '<span class="nav-badge" id="inbox-badge" style="display:none"></span>' : '';
        el.innerHTML = iconSvg(item.icon || 'grid') + '<span>' + item.label + '</span>' + badgeHtml;
        el.onclick = function() { navigateTo(item.view); };
        sidebar.appendChild(el);
      });
    });

    // Show MEET header button if configured
    initMeetHeader();
    // Start inbox unread polling
    pollInboxUnread();
  }

  // ── Inbox unread count ──
  var _inboxPollTimer = null;
  function pollInboxUnread() {
    if (_inboxPollTimer) clearInterval(_inboxPollTimer);
    fetchInboxUnread();
    _inboxPollTimer = setInterval(fetchInboxUnread, 60000); // poll every 60s
  }
  function fetchInboxUnread() {
    if (!accessToken) return;
    api.get('/api/inbox/unread').then(function(r) {
      if (!r.ok) return;
      var count = r.data && r.data.count ? r.data.count : 0;
      updateInboxBadge(count);
    }).catch(function() {});
  }
  function updateInboxBadge(count) {
    var badge = document.getElementById('inbox-badge');
    if (!badge) return;
    if (count > 0) {
      badge.textContent = count > 99 ? '99+' : String(count);
      badge.style.display = '';
    } else {
      badge.style.display = 'none';
    }
    // Also update mobile drawer badge
    var mobBadge = document.getElementById('mob-inbox-badge');
    if (mobBadge) {
      if (count > 0) {
        mobBadge.textContent = count > 99 ? '99+' : String(count);
        mobBadge.style.display = '';
      } else {
        mobBadge.style.display = 'none';
      }
    }
  }
  window.__xrayRefreshInbox = function() { fetchInboxUnread(); };

  // ── Mobile nav ──
  function buildMobileNav() {
    if (!bundle || !bundle.nav) return;
    var drawerNav = document.getElementById('mob-drawer-nav');
    var overlay = document.getElementById('mobile-menu-overlay');
    var drawer = document.getElementById('mobile-menu-drawer');
    if (!drawerNav) return;

    // Populate drawer with full nav
    drawerNav.innerHTML = '';
    var sections = {};
    var userPerms = (currentUser && currentUser.permissions) || [];
    var isAdmin = currentUser && currentUser.is_platform_admin;
    bundle.nav.forEach(function(item) {
      if (!isAdmin && item.permission && userPerms.indexOf(item.permission) === -1) return;
      // Hide billing nav for members without billing permission
      if (item.view === 'billing' && !isAdmin && currentUser && !currentUser.is_owner && !currentUser.has_billing) return;
      // Hide team nav for members without admin permission
      if (item.view === 'team' && !isAdmin && currentUser && !currentUser.is_owner && !currentUser.has_admin) return;
      // Hide connections nav for members without admin permission
      if (item.view === 'connections' && !isAdmin && currentUser && !currentUser.is_owner && !currentUser.has_admin) return;
      // Hide session replay nav if tenant doesn't have replay visible, or user lacks replay permission
      if (item.view === 'session_replay' && currentUser && (!currentUser.replay_visible || (!isAdmin && !currentUser.is_owner && !currentUser.has_replay))) return;
      var sec = item.section || 'main';
      if (!sections[sec]) sections[sec] = [];
      sections[sec].push(item);
    });
    var sectionLabels = { main: '', manage: 'Manage', account: 'Account', platform: 'Platform', config: 'Configuration' };
    var order = ['main', 'manage', 'account', 'platform', 'config', 'system'];
    order.forEach(function(sec) {
      if (!sections[sec] || !sections[sec].length) return;
      if (sectionLabels[sec]) {
        var lbl = document.createElement('div');
        lbl.className = 'nav-section';
        lbl.textContent = sectionLabels[sec];
        drawerNav.appendChild(lbl);
      }
      sections[sec].forEach(function(item) {
        var el = document.createElement('div');
        el.className = 'nav-item';
        el.setAttribute('data-view', item.view);
        var mobBadgeHtml = item.view === 'inbox' ? '<span class="nav-badge" id="mob-inbox-badge" style="display:none"></span>' : '';
        el.innerHTML = iconSvg(item.icon || 'grid') + '<span>' + item.label + '</span>' + mobBadgeHtml;
        el.onclick = function() { closeMobileMenu(); navigateTo(item.view); };
        drawerNav.appendChild(el);
      });
    });

    // User name in drawer
    var mobName = document.getElementById('mob-user-name');
    if (mobName && currentUser) mobName.textContent = currentUser.name || currentUser.email;
    var mobLogout = document.getElementById('mob-logout');
    if (mobLogout) mobLogout.onclick = function() { closeMobileMenu(); logout(); };

    // Mobile nav buttons
    var mobDash = document.getElementById('mob-dashboards');
    if (mobDash) mobDash.onclick = function() { closeMobileMenu(); navigateTo('dashboard_list'); };

    var mobMeet = document.getElementById('mob-meet');
    if (mobMeet) mobMeet.onclick = function() {
      if (meetState.inCall) {
        // Toggle between minimized and fullscreen
        if (meetState.viewMode === 'minimized' || meetState.viewMode === null) {
          setMeetViewMode('fullscreen');
        } else {
          setMeetViewMode('minimized');
        }
      } else {
        handleMeetButtonClick();
      }
    };

    var mobEnd = document.getElementById('mob-meet-end');
    if (mobEnd) mobEnd.onclick = function() {
      endMeetCall();
    };

    var mobMenu = document.getElementById('mob-menu');
    if (mobMenu) mobMenu.onclick = function() {
      overlay.classList.add('open');
      drawer.classList.add('open');
    };

    // Close drawer
    var closeBtn = document.getElementById('mob-drawer-close');
    if (closeBtn) closeBtn.onclick = closeMobileMenu;
    if (overlay) overlay.onclick = closeMobileMenu;

    function closeMobileMenu() {
      overlay.classList.remove('open');
      drawer.classList.remove('open');
    }
    window._closeMobileMenu = closeMobileMenu;
  }

  // Update mobile drawer active state on navigation
  function updateMobileActive(viewName) {
    var items = document.querySelectorAll('#mob-drawer-nav .nav-item');
    items.forEach(function(el) {
      el.classList.toggle('active', el.getAttribute('data-view') === viewName);
    });
  }

  // ── Load bundle ──
  function loadBundle() {
    if (bundle) { onBundleReady(); return; }
    fetch('/bundles/general.json?v=' + Date.now()).then(function(r) { return r.json(); })
      .then(function(d) {
        bundle = d;
        // Merge in built-in extensions (e.g., AI admin view) before building chrome
        if (window.__xrayExtensions && window.__xrayExtensions.length) {
          window.__xrayExtensions.forEach(function(ext) {
            try {
              if (ext.view && ext.viewName) bundle.views[ext.viewName] = ext.view;
              if (ext.nav && Array.isArray(bundle.nav)) {
                // Only add if user has required permission (checked later in buildSidebar too)
                bundle.nav.push(ext.nav);
              }
            } catch (e) { console.warn('extension merge failed', e); }
          });
        }
        buildSidebar(); buildMobileNav(); onBundleReady();
      })
      .catch(function() { toast('Failed to load UI bundle', 'error'); });
  }

  function onBundleReady() {
    var hash = window.location.hash.replace('#', '').split('?')[0];
    // Skip meet-join hashes — they're handled by checkMeetJoinHash(), not the view router
    if (hash.indexOf('meet-join/') === 0) return;
    navigateTo(hash || 'dashboard_list');
  }

  // ── Navigate to view ──
  function navigateTo(viewName) {
    if (!bundle) return;
    currentView = viewName;
    // Preserve existing query params in hash if navigating to same view
    if (window.location.hash.split('?')[0].replace('#', '') !== viewName) {
      window.location.hash = viewName;
    }

    // Clean up any floating overlays/modals from previous views
    document.querySelectorAll('.modal-overlay').forEach(function(m) {
      if (m.id !== 'loginModal') m.remove();
    });
    // Clear full-viewport dashboard viewer state BEFORE checking segment type
    var hdrTitle = document.getElementById('header-center-title');
    if (hdrTitle) { hdrTitle.style.display = 'none'; hdrTitle.textContent = ''; }
    var sidebar = document.getElementById('sidebar');
    if (sidebar) { sidebar.style.display = ''; if (sidebar.dataset.dashCollapsed) { sidebar.classList.remove('collapsed'); delete sidebar.dataset.dashCollapsed; } }
    // Also explicitly remove active class from dashboard viewer
    var dashViewer = document.querySelector('.dash-fullview.active');
    if (dashViewer) { dashViewer.classList.remove('active'); dashViewer.innerHTML = ''; delete dashViewer.dataset.dashboardId; }
    // Tear down the AI rail if the user is leaving a dashboard (rail is mounted
    // on document.body by /ai/sdk.js and would otherwise linger on other pages).
    try { if (window.XRayAI && typeof window.XRayAI.dispose === 'function') window.XRayAI.dispose(); } catch (e) {}

    // Notify replay of segment change (AFTER dashboard viewer is cleared)
    onReplaySegmentChange();

    // Clear inbox badge immediately when navigating to inbox
    if (viewName === 'inbox') {
      updateInboxBadge(0);
    }

    var items = document.querySelectorAll('#sidebar .nav-item');
    items.forEach(function(el) {
      el.classList.toggle('active', el.getAttribute('data-view') === viewName);
    });
    updateMobileActive(viewName);

    var container = document.getElementById('view-container');
    var viewDef = bundle.views[viewName];
    if (!viewDef) {
      container.innerHTML = '<div class="loading-view">View "' + viewName + '" is not available in this bundle.</div>';
      return;
    }

    container.innerHTML = viewDef.html;

    var oldStyle = document.getElementById('view-style');
    if (oldStyle) oldStyle.remove();
    if (viewDef.css) {
      var style = document.createElement('style');
      style.id = 'view-style';
      style.textContent = viewDef.css;
      document.head.appendChild(style);
    }

    if (viewDef.js) {
      try {
        var fn = new Function('container', 'api', 'user', viewDef.js + '\n' + getInitCall(viewName));
        fn(container, api, currentUser);
      } catch (e) {
        console.error('View JS error:', e);
      }
    }
  }

  function getInitCall(viewName) {
    var fnMap = {
      account: 'if(typeof initAccount==="function")initAccount(container,api,user);',
      billing: 'if(typeof initBilling==="function")initBilling(container,api,user);',
      team: 'if(typeof initTeam==="function")initTeam(container,api,user);',
      dashboard_list: 'if(typeof initDashboardList==="function")initDashboardList(container,api,user);',
      connections: 'if(typeof initConnections==="function")initConnections(container,api,user);',
      audit: 'if(typeof initAudit==="function")initAudit(container,api,user);',
      admin_tenants: 'if(typeof initAdminTenants==="function")initAdminTenants(container,api,user);',
      admin_dashboards: 'if(typeof initAdminDashboards==="function")initAdminDashboards(container,api,user);',
      admin_connections: 'if(typeof initAdminConnections==="function")initAdminConnections(container,api,user);',
      admin_integrations: 'if(typeof initAdminIntegrations==="function")initAdminIntegrations(container,api,user);',
      admin_roles: 'if(typeof initAdminRoles==="function")initAdminRoles(container,api,user);',
      admin_email: 'if(typeof initAdminEmail==="function")initAdminEmail(container,api,user);',
      admin_bundles: 'if(typeof initAdminBundles==="function")initAdminBundles(container,api,user);',
      admin_stripe: 'if(typeof initAdminStripe==="function")initAdminStripe(container,api,user);',
      admin_builder: 'if(typeof initBuilder==="function")initBuilder(container,api,user);',
      admin_settings: 'if(typeof initSettings==="function")initSettings(container,api,user);',
      admin_apikeys: 'if(typeof initApiKeys==="function")initApiKeys(container,api,user);',
      admin_meet: 'if(typeof initAdminMeet==="function")initAdminMeet(container,api,user);',
      admin_webhooks: 'if(typeof initWebhooks==="function")initWebhooks(container,api,user);',
      admin_audit: 'if(typeof initAdminAudit==="function")initAdminAudit(container,api,user);',
      admin_backups: 'if(typeof initAdminBackups==="function")initAdminBackups(container,api,user);',
      admin_portability: 'if(typeof initAdminPortability==="function")initAdminPortability(container,api,user);',
      inbox: 'if(typeof initInbox==="function")initInbox(container,api,user);',
      files: 'if(typeof initFiles==="function")initFiles(container,api,user);',
      session_replay: 'if(typeof initSessionReplay==="function")initSessionReplay(container,api,user);',
      admin_replay: 'if(typeof initAdminReplay==="function")initAdminReplay(container,api,user);',
      admin_replay_config: 'if(typeof initReplayConfig==="function")initReplayConfig(container,api,user);',
      admin_ai: 'if(typeof initAdminAI==="function")initAdminAI(container,api,user);',
      admin_policies: 'if(typeof initAdminPolicies==="function")initAdminPolicies(container,api,user);'
    };
    return fnMap[viewName] || '';
  }

  // ── Hash routing ──
  window.onhashchange = function() {
    if (!accessToken) return;
    var hash = window.location.hash.replace('#', '').split('?')[0];
    if (hash && hash.indexOf('meet-join/') === 0) return; // handled by checkMeetJoinHash
    if (hash && hash !== currentView) navigateTo(hash);
  };

  // Mobile back button: close modals/drawers/sidebars before navigating back
  window.addEventListener('popstate', function(e) {
    // Close mobile menu drawer if open
    var drawer = document.getElementById('mobile-menu-drawer');
    if (drawer && drawer.classList.contains('open')) {
      if (window._closeMobileMenu) window._closeMobileMenu();
      e.preventDefault();
      return;
    }
    // Close any modal overlay
    var modals = document.querySelectorAll('.modal-overlay[style*="flex"], .modal-overlay.active');
    for (var i = 0; i < modals.length; i++) {
      if (modals[i].style.display === 'flex' || modals[i].classList.contains('active')) {
        modals[i].style.display = 'none';
        modals[i].classList.remove('active');
        return;
      }
    }
    // Close login modal if open
    var loginModal = document.getElementById('loginModal');
    if (loginModal && loginModal.classList.contains('active')) {
      if (window.closeModal) window.closeModal();
      return;
    }
    // Close meet panel
    var meetPanel = document.getElementById('meet-panel');
    if (meetPanel && meetPanel.style.display !== 'none') {
      meetPanel.style.display = 'none';
      return;
    }
    // Close mobile inbox thread view
    var inboxLayout = document.querySelector('.inbox-layout.mob-thread-open');
    if (inboxLayout) {
      inboxLayout.classList.remove('mob-thread-open');
      return;
    }
  });

  // ── Init ──
  function init() {
    checkOauthReturnParams();
    if (checkUrlToken()) return;
    api.refresh().then(function(ok) {
      if (ok) {
        enterApp();
        return;
      }
      fetch('/api/auth/setup').then(function(r) { return r.json(); }).then(function(d) {
        if (d.ok && d.data && d.data.setupRequired) {
          openModal('setup');
        }
      }).catch(function() {});
    });
  }

  // ── Meet system ──
  var meetState = {
    serverUrl: '',
    configured: false,
    roomCode: '',
    inCall: false,
    panelOpen: false,
    panelView: 'initial', // initial | new | join
    viewMode: null, // null | fullscreen | pip | minimized
    members: [],
    selectedMembers: [],
    inviteEmails: []
  };

  function generateRoomCode() {
    var chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
    var code = '';
    for (var i = 0; i < 6; i++) code += chars.charAt(Math.floor(Math.random() * chars.length));
    return code;
  }

  function getMeetJoinUrl(room) {
    return meetState.serverUrl + '/?room=' + encodeURIComponent(room);
  }

  function initMeetHeader() {
    var meetBtn = document.getElementById('btn-meet-header');
    if (!meetBtn) return;
    api.get('/api/meet/config').then(function(r) {
      if (!r.ok || !r.data || !r.data.configured) return;
      meetState.serverUrl = r.data.serverUrl.replace(/\/+$/, '');
      meetState.configured = true;
      meetBtn.style.display = '';
      meetBtn.onclick = handleMeetButtonClick;
      // Preload members
      api.get('/api/meet/members').then(function(mr) {
        if (mr.ok && mr.data) meetState.members = mr.data;
      }).catch(function() {});
      setupMeetPanel();
      setupMeetViewport();
      // Platform admin: WebSocket for incoming support calls
      if (currentUser && currentUser.is_platform_admin) {
        startSupportCallWebSocket();
      }
      // Restore active call after page refresh (within 8 hours)
      try {
        var saved = JSON.parse(sessionStorage.getItem('xray_meet_active') || 'null');
        if (saved && saved.roomCode && (Date.now() - saved.ts) < 8 * 60 * 60 * 1000) {
          launchMeetCall(saved.roomCode);
        }
      } catch(e) {}
    }).catch(function() {});
  }

  function handleMeetButtonClick() {
    if (meetState.inCall) {
      // End the call
      endMeetCall();
      return;
    }
    if (meetState.panelOpen) {
      closeMeetPanel();
    } else {
      openMeetPanel();
    }
  }

  function openMeetPanel() {
    var panel = document.getElementById('meet-panel');
    if (!panel) return;
    var btn = document.getElementById('btn-meet-header');
    if (btn) {
      // Desktop: position below the header button
      var rect = btn.getBoundingClientRect();
      panel.style.top = (rect.bottom + 8) + 'px';
      panel.style.right = '20px';
    }
    // On mobile the CSS override positions it at bottom:80px via !important
    panel.style.display = '';
    meetState.panelOpen = true;
    showMeetPanelView('initial');
  }

  function closeMeetPanel() {
    var panel = document.getElementById('meet-panel');
    if (panel) panel.style.display = 'none';
    meetState.panelOpen = false;
  }

  function showMeetPanelView(view) {
    meetState.panelView = view;
    var initial = document.getElementById('meet-panel-initial');
    var newP = document.getElementById('meet-panel-new');
    var joinP = document.getElementById('meet-panel-join');
    if (initial) initial.style.display = view === 'initial' ? '' : 'none';
    if (newP) newP.style.display = view === 'new' ? '' : 'none';
    if (joinP) joinP.style.display = view === 'join' ? '' : 'none';
    if (view === 'new') {
      meetState.roomCode = generateRoomCode();
      meetState.selectedMembers = [];
      meetState.inviteEmails = [];
      _meetMemberLimit = 10;
      var codeEl = document.getElementById('meet-room-code');
      if (codeEl) codeEl.textContent = meetState.roomCode;
      renderMemberList();
      renderEmailTags();
      var allBtn = document.getElementById('meet-select-all');
      if (allBtn) allBtn.classList.remove('active');
    }
  }

  var _meetMemberLimit = 10;

  function renderMemberList(filter) {
    var list = document.getElementById('meet-member-list');
    if (!list) return;
    list.innerHTML = '';
    var search = (filter || '').toLowerCase();
    var filtered = meetState.members.filter(function(m) {
      if (currentUser && m.id === currentUser.id) return false; // exclude self
      if (!search) return true;
      return (m.name && m.name.toLowerCase().indexOf(search) >= 0) || m.email.toLowerCase().indexOf(search) >= 0;
    });
    if (filtered.length === 0) {
      list.innerHTML = '<div style="padding:12px;font-size:13px;color:var(--t3);text-align:center">No members found</div>';
      return;
    }
    var showing = filtered.slice(0, _meetMemberLimit);
    showing.forEach(function(m) {
      var item = document.createElement('div');
      item.className = 'meet-member-item';
      if (meetState.selectedMembers.indexOf(m.id) >= 0) item.classList.add('selected');
      item.innerHTML = '<span class="meet-check">\u2713</span><span class="meet-member-name">' +
        escapeHtml(m.name || m.email) + '</span><span class="meet-member-email">' + escapeHtml(m.email) + '</span>';
      item.onclick = function() {
        var idx = meetState.selectedMembers.indexOf(m.id);
        if (idx >= 0) { meetState.selectedMembers.splice(idx, 1); }
        else { meetState.selectedMembers.push(m.id); }
        item.classList.toggle('selected');
        updateAllBtn();
      };
      list.appendChild(item);
    });
    // Load more button
    if (filtered.length > _meetMemberLimit) {
      var loadMore = document.createElement('div');
      loadMore.style.cssText = 'padding:8px;text-align:center;font-size:12px;color:var(--acc);cursor:pointer';
      loadMore.textContent = 'Load more (' + (filtered.length - _meetMemberLimit) + ' remaining)';
      loadMore.onclick = function() {
        _meetMemberLimit += 10;
        renderMemberList(filter);
      };
      list.appendChild(loadMore);
    }
  }

  function escapeHtml(s) {
    var d = document.createElement('div');
    d.textContent = s;
    return d.innerHTML;
  }

  function updateAllBtn() {
    var allBtn = document.getElementById('meet-select-all');
    if (!allBtn) return;
    var selectableCount = meetState.members.filter(function(m) {
      return !currentUser || m.id !== currentUser.id;
    }).length;
    allBtn.classList.toggle('active', meetState.selectedMembers.length >= selectableCount && selectableCount > 0);
  }

  function renderEmailTags() {
    var container = document.getElementById('meet-email-tags');
    if (!container) return;
    container.innerHTML = '';
    meetState.inviteEmails.forEach(function(email, i) {
      var tag = document.createElement('span');
      tag.className = 'meet-email-tag';
      tag.innerHTML = escapeHtml(email) + '<button title="Remove">&times;</button>';
      tag.querySelector('button').onclick = function() {
        meetState.inviteEmails.splice(i, 1);
        renderEmailTags();
      };
      container.appendChild(tag);
    });
  }

  function setupMeetPanel() {
    // Initial view buttons
    var optNew = document.getElementById('meet-opt-new');
    if (optNew) optNew.onclick = function() { showMeetPanelView('new'); };
    var optJoin = document.getElementById('meet-opt-join');
    if (optJoin) optJoin.onclick = function() { showMeetPanelView('join'); };

    // Share button
    var shareBtn = document.getElementById('meet-share-btn');
    if (shareBtn) shareBtn.onclick = function() {
      var url = getMeetJoinUrl(meetState.roomCode);
      if (navigator.share) {
        navigator.share({ title: 'Join XRay Meeting', url: url }).catch(function() {});
      } else {
        navigator.clipboard.writeText(url).then(function() {
          toast('Meeting link copied!', 'success');
        }).catch(function() {
          prompt('Copy the meeting link:', url);
        });
      }
    };

    // Select all button
    var allBtn = document.getElementById('meet-select-all');
    if (allBtn) allBtn.onclick = function() {
      var selectable = meetState.members.filter(function(m) {
        return !currentUser || m.id !== currentUser.id;
      });
      if (meetState.selectedMembers.length >= selectable.length) {
        meetState.selectedMembers = [];
      } else {
        meetState.selectedMembers = selectable.map(function(m) { return m.id; });
      }
      renderMemberList(document.getElementById('meet-member-search') ? document.getElementById('meet-member-search').value : '');
      updateAllBtn();
    };

    // Search
    var searchInput = document.getElementById('meet-member-search');
    if (searchInput) searchInput.oninput = function() { renderMemberList(this.value); };

    // Add email
    var addEmailBtn = document.getElementById('meet-add-email');
    var emailInput = document.getElementById('meet-email-input');
    function addEmail() {
      if (!emailInput) return;
      var email = emailInput.value.trim();
      if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        toast('Enter a valid email', 'error'); return;
      }
      if (meetState.inviteEmails.indexOf(email) >= 0) {
        toast('Email already added', 'info'); return;
      }
      meetState.inviteEmails.push(email);
      emailInput.value = '';
      renderEmailTags();
    }
    if (addEmailBtn) addEmailBtn.onclick = addEmail;
    if (emailInput) emailInput.onkeydown = function(e) { if (e.key === 'Enter') addEmail(); };

    // Start meeting
    var startBtn = document.getElementById('meet-btn-start-new');
    if (startBtn) startBtn.onclick = function() {
      startBtn.disabled = true;
      startBtn.textContent = 'Starting...';
      api.post('/api/meet/rooms', { roomId: meetState.roomCode, displayName: 'XRay Meeting' }).then(function(r) {
        startBtn.disabled = false;
        startBtn.textContent = 'Start Meeting';
        if (!r.ok) {
          toast('Failed to create meeting: ' + (r.error ? r.error.message : 'Unknown error'), 'error');
          return;
        }
        // Gather emails to invite
        var emails = meetState.inviteEmails.slice();
        meetState.selectedMembers.forEach(function(id) {
          var m = meetState.members.find(function(mm) { return mm.id === id; });
          if (m && emails.indexOf(m.email) < 0) emails.push(m.email);
        });
        // Send invites if any
        if (emails.length > 0) {
          var joinUrl = getMeetJoinUrl(meetState.roomCode);
          api.post('/api/meet/invite', {
            joinUrl: joinUrl, roomName: meetState.roomCode, emails: emails
          }).then(function(ir) {
            if (ir.ok) {
              var sent = ir.data.results.filter(function(r) { return r.sent; }).length;
              if (sent > 0) toast('Invite sent to ' + sent + ' participant' + (sent > 1 ? 's' : ''), 'success');
            }
          }).catch(function() {});
        }
        closeMeetPanel();
        launchMeetCall(meetState.roomCode);
      }).catch(function() {
        startBtn.disabled = false;
        startBtn.textContent = 'Start Meeting';
        toast('Network error', 'error');
      });
    };

    // Join meeting
    var joinBtn = document.getElementById('meet-btn-join-room');
    if (joinBtn) joinBtn.onclick = function() {
      var codeInput = document.getElementById('meet-join-code');
      var code = codeInput ? codeInput.value.trim() : '';
      if (!code) { toast('Enter a room code', 'error'); return; }
      closeMeetPanel();
      meetState.roomCode = code;
      launchMeetCall(code);
    };
    var joinCodeInput = document.getElementById('meet-join-code');
    if (joinCodeInput) joinCodeInput.onkeydown = function(e) { if (e.key === 'Enter' && joinBtn) joinBtn.click(); };

    // XRay Support button (owners only)
    var supportBtn = document.getElementById('meet-opt-support');
    if (supportBtn) {
      if (!currentUser || (!currentUser.is_owner && !currentUser.is_platform_admin)) {
        supportBtn.style.display = 'none';
      } else {
        supportBtn.onclick = function() {
      supportBtn.disabled = true;
      supportBtn.textContent = 'Connecting...';
      api.post('/api/meet/support-call', {}).then(function(r) {
        supportBtn.disabled = false;
        supportBtn.innerHTML = '<svg viewBox="0 0 24 24" width="20" height="20" stroke="currentColor" fill="none" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z"/></svg>XRay Support';
        if (!r.ok) {
          toast('Failed to connect: ' + (r.error ? r.error.message : 'Unknown error'), 'error');
          return;
        }
        closeMeetPanel();
        launchMeetCall(r.data.roomCode);
        toast('Support call started. Waiting for XRay team...', 'info');
      }).catch(function() {
        supportBtn.disabled = false;
        supportBtn.innerHTML = '<svg viewBox="0 0 24 24" width="20" height="20" stroke="currentColor" fill="none" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z"/></svg>XRay Support';
        toast('Network error', 'error');
      });
    };
      } // end else (owner check)
    } // end if (supportBtn)

    // Close panel when clicking outside
    document.addEventListener('mousedown', function(e) {
      if (!meetState.panelOpen) return;
      var panel = document.getElementById('meet-panel');
      var btn = document.getElementById('btn-meet-header');
      if (panel && !panel.contains(e.target) && btn && !btn.contains(e.target)) {
        closeMeetPanel();
      }
    });
  }

  function showMeetFallback(iframeWrap, url) {
    iframeWrap.innerHTML = '<div style="display:flex;flex-direction:column;align-items:center;justify-content:center;height:100%;gap:16px;color:var(--t2);text-align:center;padding:20px">'
      + '<p style="font-size:15px">The MEET server blocked embedding in this page.<br>This usually means the MEET server needs to allow framing from this domain.</p>'
      + '<a href="' + url + '" target="_blank" rel="noopener" class="btn primary" style="font-size:15px;padding:12px 28px;text-decoration:none">Open meeting in new tab</a>'
      + '<p style="font-size:12px;color:var(--t3)">To fix embedding: configure your MEET server to set<br><code>X-Frame-Options: ALLOWALL</code> or remove the header entirely.</p>'
      + '</div>';
  }

  function launchMeetCall(room) {
    meetState.inCall = true;
    meetState.roomCode = room;
    // Persist active call so it survives page refresh
    try { sessionStorage.setItem('xray_meet_active', JSON.stringify({ roomCode: room, ts: Date.now() })); } catch(e) {}
    var params = new URLSearchParams({ room: room });
    if (currentUser && currentUser.name) params.set('name', currentUser.name);
    params.set('autojoin', 'true');
    params.set('hideEndCall', 'true');
    var url = meetState.serverUrl + '/?' + params.toString();

    var viewport = document.getElementById('meet-viewport');
    var iframeWrap = document.getElementById('meet-viewport-iframe');
    if (!viewport || !iframeWrap) return;
    iframeWrap.innerHTML = '<iframe src="' + url + '" allow="camera; microphone; display-capture; autoplay" referrerpolicy="no-referrer-when-downgrade" allowfullscreen></iframe>';

    // Detect iframe load failure (X-Frame-Options blocking) and offer fallback
    var meetIframeEl = iframeWrap.querySelector('iframe');
    if (meetIframeEl) {
      meetIframeEl.addEventListener('load', function() {
        try {
          // If we CAN access contentDocument, the iframe is same-origin (about:blank = blocked)
          var doc = meetIframeEl.contentDocument;
          if (doc && (!doc.body || doc.body.children.length === 0 || doc.body.innerHTML.length < 50)) {
            showMeetFallback(iframeWrap, url);
          }
        } catch (e) {
          // Cross-origin SecurityError = MEET page loaded successfully (different origin)
        }
      });
      meetIframeEl.onerror = function() { showMeetFallback(iframeWrap, url); };
    }

    // Listen for end-call events from the iframe
    var meetIframe = iframeWrap.querySelector('iframe');
    if (meetIframe) {
      // Watch for iframe navigation (user clicks leave/end in the meeting UI)
      try {
        var checkInterval = setInterval(function() {
          if (!meetState.inCall) { clearInterval(checkInterval); return; }
          try {
            // If iframe navigated away from meeting or shows a "left" page
            var iframeSrc = meetIframe.contentWindow.location.href;
            if (iframeSrc && iframeSrc.indexOf('room=') === -1 && iframeSrc !== 'about:blank') {
              clearInterval(checkInterval);
              endMeetCall();
            }
          } catch(e) {
            // Cross-origin - can't check, that's ok
          }
        }, 2000);
        // Also listen for postMessage from meeting iframe
        window.addEventListener('message', function meetMsgHandler(e) {
          if (!meetState.inCall) { window.removeEventListener('message', meetMsgHandler); return; }
          var d = e.data;
          if (typeof d === 'string') {
            try { d = JSON.parse(d); } catch(ex) {}
          }
          if (d && (d.type === 'meeting-ended' || d.type === 'call-ended' || d.type === 'hangup' || d.event === 'meetingEnded' || d.event === 'participantLeft' && d.local)) {
            window.removeEventListener('message', meetMsgHandler);
            endMeetCall();
          }
        });
      } catch(e) {}
    }

    setMeetViewMode('fullscreen');
    updateMeetHeaderState();
    updateMobileMeetState();
  }

  function setMeetViewMode(mode) {
    meetState.viewMode = mode;
    var viewport = document.getElementById('meet-viewport');
    var roomIndicator = document.getElementById('meet-room-indicator');
    var minControls = document.getElementById('meet-minimized-controls');

    if (!viewport) return;

    if (mode === 'minimized') {
      viewport.style.display = 'none';
      viewport.className = 'meet-viewport';
      // Show minimized controls in header
      if (minControls) minControls.style.display = '';
      if (roomIndicator) { roomIndicator.style.display = ''; roomIndicator.textContent = meetState.roomCode; }
    } else if (mode === 'fullscreen' || mode === 'pip') {
      viewport.style.display = 'flex';
      viewport.className = 'meet-viewport mode-' + mode;
      // Reset any drag positioning for fullscreen
      if (mode === 'fullscreen') {
        viewport.style.left = ''; viewport.style.top = '';
        viewport.style.right = ''; viewport.style.bottom = '';
      }
      if (minControls) minControls.style.display = 'none';
      if (roomIndicator) { roomIndicator.style.display = ''; roomIndicator.textContent = meetState.roomCode; }
      var titleEl = viewport.querySelector('.meet-viewport-title');
      if (titleEl) titleEl.textContent = 'MEET \u2014 ' + meetState.roomCode;
    } else {
      viewport.style.display = 'none';
      viewport.className = 'meet-viewport';
      if (minControls) minControls.style.display = 'none';
      if (roomIndicator) roomIndicator.style.display = 'none';
    }
  }

  function endMeetCall() {
    meetState.inCall = false;
    meetState.roomCode = '';
    try { sessionStorage.removeItem('xray_meet_active'); } catch(e) {}
    var viewport = document.getElementById('meet-viewport');
    var iframeWrap = document.getElementById('meet-viewport-iframe');
    if (iframeWrap) iframeWrap.innerHTML = '';
    setMeetViewMode(null);
    updateMeetHeaderState();
    updateMobileMeetState();
  }

  // ── Platform admin: WebSocket for support calls ──
  var knownSupportCalls = {};
  var dismissedSupportCalls = (function() {
    try { return JSON.parse(localStorage.getItem('xray_dismissed_calls') || '{}'); } catch(e) { return {}; }
  })();
  function persistDismissedCalls() {
    // Clean entries older than 10 minutes to prevent unbounded growth
    var now = Date.now(), cleaned = {};
    Object.keys(dismissedSupportCalls).forEach(function(k) {
      if (now - dismissedSupportCalls[k] < 600000) cleaned[k] = dismissedSupportCalls[k];
    });
    dismissedSupportCalls = cleaned;
    try { localStorage.setItem('xray_dismissed_calls', JSON.stringify(dismissedSupportCalls)); } catch(e) {}
  }
  function dismissSupportCall(callId) {
    dismissedSupportCalls[callId] = Date.now();
    persistDismissedCalls();
  }
  var supportCallConfig = { ring_duration: 60, sound_enabled: true, vibration_enabled: true };
  var _ws = null;
  var _wsReconnectTimer = null;
  var _wsReconnectDelay = 1000;
  var _wsMaxDelay = 30000;
  var _wsIntentionalClose = false;

  // ── Push notification subscription ──
  function pushSubscribeWithKey() {
    // Actually subscribe to push after permission is granted
    api.get('/api/meet/push/vapid-key').then(function(r) {
      if (!r.ok || !r.data || !r.data.vapidPublicKey) return;
      var vapidKey = r.data.vapidPublicKey;
      navigator.serviceWorker.ready.then(function(reg) {
        reg.pushManager.getSubscription().then(function(sub) {
          if (sub) {
            // Already subscribed, ensure server knows
            api.post('/api/meet/push/subscribe', sub.toJSON()).catch(function() {});
            return;
          }
          // Convert VAPID key to Uint8Array
          var padding = '='.repeat((4 - vapidKey.length % 4) % 4);
          var base64 = (vapidKey + padding).replace(/-/g, '+').replace(/_/g, '/');
          var raw = atob(base64);
          var arr = new Uint8Array(raw.length);
          for (var i = 0; i < raw.length; i++) arr[i] = raw.charCodeAt(i);
          reg.pushManager.subscribe({
            userVisibleOnly: true,
            applicationServerKey: arr
          }).then(function(newSub) {
            api.post('/api/meet/push/subscribe', newSub.toJSON()).catch(function() {});
          }).catch(function(err) {
            console.warn('Push subscribe failed:', err);
          });
        });
      });
    }).catch(function() {});
  }

  function subscribeToPush() {
    if (!('serviceWorker' in navigator) || !('PushManager' in window)) return;
    if (!('Notification' in window)) return;
    if (Notification.permission === 'granted') {
      pushSubscribeWithKey();
    } else if (Notification.permission === 'default') {
      // On iOS (and best practice everywhere), permission must be requested
      // from a user gesture. Show an in-app prompt banner instead of auto-requesting.
      showPushPermissionBanner();
    }
  }

  function showPushPermissionBanner() {
    // Don't show if already dismissed this session
    try { if (sessionStorage.getItem('xray_push_dismissed')) return; } catch(e) {}
    // Don't show if one is already visible
    if (document.getElementById('push-perm-banner')) return;
    var banner = document.createElement('div');
    banner.id = 'push-perm-banner';
    banner.style.cssText = 'position:fixed;bottom:24px;left:50%;transform:translateX(-50%);z-index:9999;background:#1a1d24;border:1px solid #3ee8b5;border-radius:12px;padding:16px 20px;display:flex;align-items:center;gap:12px;box-shadow:0 8px 32px rgba(0,0,0,.5);max-width:420px;width:calc(100% - 32px);';
    banner.innerHTML =
      '<div style="flex:1;"><div style="color:#fff;font-weight:500;font-size:14px;margin-bottom:4px;">Enable Notifications</div>' +
      '<div style="color:#94a3b8;font-size:13px;">Get alerts for support calls and messages even when the app is closed.</div></div>' +
      '<div style="display:flex;gap:8px;flex-shrink:0;">' +
      '<button id="push-perm-allow" style="background:#3ee8b5;color:#08090c;border:none;border-radius:8px;padding:8px 16px;font-weight:600;font-size:13px;cursor:pointer;">Enable</button>' +
      '<button id="push-perm-dismiss" style="background:transparent;color:#94a3b8;border:1px solid #333;border-radius:8px;padding:8px 12px;font-size:13px;cursor:pointer;">Later</button>' +
      '</div>';
    document.body.appendChild(banner);
    document.getElementById('push-perm-allow').onclick = function() {
      // This click IS a user gesture — safe for iOS permission request
      Notification.requestPermission().then(function(perm) {
        if (perm === 'granted') pushSubscribeWithKey();
      });
      banner.remove();
    };
    document.getElementById('push-perm-dismiss').onclick = function() {
      try { sessionStorage.setItem('xray_push_dismissed', '1'); } catch(e) {}
      banner.remove();
    };
  }

  // Handle messages from Service Worker (e.g. join call from push notification)
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.addEventListener('message', function(evt) {
      if (evt.data && evt.data.type === 'meet-call-join') {
        var callId = evt.data.callId;
        var roomCode = evt.data.roomCode;
        var joinUrl = evt.data.joinUrl;
        // Answer the support call via API
        if (callId) {
          api.post('/api/meet/support-calls/' + callId + '/answer', {}).catch(function() {});
          dismissSupportCall(callId);
          var el = document.getElementById('sca-' + callId);
          if (el) { stopRinging(); el.remove(); }
        }
        // Join the meeting — wait for meetState to be configured if needed
        if (roomCode && meetState && meetState.configured) {
          closeMeetPanel();
          launchMeetCall(roomCode);
        } else if (roomCode && meetState && !meetState.configured) {
          // meetState not ready yet — poll briefly for it to configure
          var attempts = 0;
          var waitForMeet = setInterval(function() {
            attempts++;
            if (meetState.configured) {
              clearInterval(waitForMeet);
              closeMeetPanel();
              launchMeetCall(roomCode);
            } else if (attempts > 20) {
              clearInterval(waitForMeet);
              // Fallback: open external meet URL
              if (joinUrl) window.location.href = joinUrl;
            }
          }, 250);
        } else if (joinUrl) {
          window.location.href = joinUrl;
        }
      }
    });
  }

  // Handle hash-based meet join (from push notification opening the app)
  function checkMeetJoinHash() {
    var hash = window.location.hash;
    if (hash.indexOf('#meet-join/') !== 0) return;
    var rest = hash.substring('#meet-join/'.length);
    var parts = rest.split('?');
    var roomCode = parts[0];
    var params = new URLSearchParams(parts[1] || '');
    var callId = params.get('callId');
    var joinUrl = params.get('joinUrl');
    // Clear the hash so it doesn't re-trigger
    history.replaceState(null, '', window.location.pathname + window.location.search);
    if (!roomCode && !joinUrl) return;
    // Answer the call and dismiss in-app alert
    if (callId) {
      api.post('/api/meet/support-calls/' + callId + '/answer', {}).catch(function() {});
      dismissSupportCall(callId);
      var el = document.getElementById('sca-' + callId);
      if (el) { stopRinging(); el.remove(); }
    }
    // Wait for meet to be configured, then join
    var attempts = 0;
    var waitForMeet = setInterval(function() {
      attempts++;
      if (meetState && meetState.configured && roomCode) {
        clearInterval(waitForMeet);
        closeMeetPanel();
        launchMeetCall(roomCode);
      } else if (attempts > 40) {
        clearInterval(waitForMeet);
        if (joinUrl) window.location.href = decodeURIComponent(joinUrl);
      }
    }, 250);
  }

  function startSupportCallWebSocket() {
    // Load support config
    api.get('/api/meet/support-config').then(function(r) {
      if (r.ok && r.data) supportCallConfig = r.data;
    }).catch(function() {});
    // Load any existing pending calls first
    api.get('/api/meet/support-calls').then(function(r) {
      if (!r.ok || !r.data) return;
      r.data.forEach(function(call) {
        if (knownSupportCalls[call.id]) return;
        if (dismissedSupportCalls[call.id]) return; // already dismissed by this user
        knownSupportCalls[call.id] = true;
        showSupportCallAlert(call);
      });
    }).catch(function() {});
    // Subscribe to push notifications for background alerts
    subscribeToPush();
    connectWebSocket();
  }

  function connectWebSocket() {
    if (_ws && (_ws.readyState === WebSocket.OPEN || _ws.readyState === WebSocket.CONNECTING)) return;
    if (!accessToken) return;
    var proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    var wsUrl = proto + '//' + location.host + '/ws?token=' + encodeURIComponent(accessToken);
    try { _ws = new WebSocket(wsUrl); } catch(e) { scheduleWsReconnect(); return; }
    window.__xrayWs = _ws;

    _ws.onopen = function() {
      _wsReconnectDelay = 1000;
    };

    _ws.onmessage = function(evt) {
      try {
        var msg = JSON.parse(evt.data);
        if (msg.type === 'support-call:new' && msg.data) {
          var call = msg.data;
          if (knownSupportCalls[call.id] || dismissedSupportCalls[call.id]) return;
          knownSupportCalls[call.id] = true;
          showSupportCallAlert(call);
          // System notification is handled by the service worker via push — no need to duplicate here
        } else if (msg.type === 'support-call:answered' && msg.data) {
          dismissSupportCall(msg.data.id);
          var el = document.getElementById('sca-' + msg.data.id);
          if (el) { stopRinging(); el.remove(); }
        } else if (msg.type === 'inbox:new-message' && msg.data) {
          // Update unread badge immediately
          if (typeof msg.data.unreadCount === 'number') {
            updateInboxBadge(msg.data.unreadCount);
          } else {
            fetchInboxUnread();
          }
          // Show toast notification (in-app only, not a system notification)
          if (window.__xrayToast) {
            window.__xrayToast(msg.data.senderName ? msg.data.senderName + ': ' + (msg.data.preview || 'New message') : 'New message in inbox', 'info');
          }
          // System notification is handled by service worker push — no duplicate here
          // If inbox view is currently open, refresh it
          if (window.__xrayRefreshInboxView) window.__xrayRefreshInboxView();
        } else if (msg.type === 'dashboard:access-granted' || msg.type === 'dashboard:access-revoked' || msg.type === 'dashboard:share-changed' || msg.type === 'integration:connected' || msg.type === 'integration:disconnected') {
          // Dashboard list–affecting events. Forward to the bundle's
          // dashboard_list handler if it's registered. The bundle also
          // tries to addEventListener directly, but that races with
          // __xrayWs being open at view-mount time and doesn't survive
          // token-refresh WS reconnects — this forward is the reliable
          // path.
          if (window.__xrayDashWsHandler) {
            window.__xrayDashWsHandler(evt);
          }
        } else if (msg.type === 'team:member-joined' && msg.data) {
          if (window.__xrayToast) window.__xrayToast((msg.data.name || msg.data.email || 'Someone') + ' joined the team', 'info');
          if (window.__xrayRefreshTeamView) window.__xrayRefreshTeamView();
        } else if (msg.type === 'billing:updated' && msg.data) {
          // Billing gate changed — reload dashboard view to update access
          if (msg.data.gateChanged || msg.data.togglesChanged) {
            // Admin changed product config — re-check billing silently
          } else if (msg.data.hasVision) {
            if (window.__xrayToast) window.__xrayToast('Subscription activated! Dashboard access granted.', 'success');
          } else if (msg.data.hasVision === false) {
            if (window.__xrayToast) window.__xrayToast('Subscription ended. Dashboard access has been revoked.', 'error');
          }
          // Refresh dashboard list view to re-check billing from server
          if (window.__xrayRefreshDashboardList) window.__xrayRefreshDashboardList();
          // Fan out to every billing subscriber registered with
          // __xrayOnBilling(). Fallback to the legacy single-handler
          // hook so any older bundle still wires up.
          if (Array.isArray(window.__xrayBillingSubscribers)) {
            window.__xrayBillingSubscribers.slice().forEach(function(fn) {
              try { fn(msg.data); } catch (e) {}
            });
          }
          if (window.__xrayBillingChanged) window.__xrayBillingChanged(msg.data);
        } else if (msg.type === 'tenant:replay-changed' && msg.data) {
          // Replay toggle changed by platform admin — update sidebar in real-time
          if (msg.data.replay_visible !== undefined) currentUser.replay_visible = msg.data.replay_visible;
          if (msg.data.replay_enabled !== undefined) currentUser.replay_enabled = msg.data.replay_enabled;
          buildSidebar();
          buildMobileNav();
        } else if (msg.type === 'user:permissions-changed' && msg.data) {
          // Permissions were updated by an admin — update currentUser and rebuild sidebar
          if (msg.data.has_admin !== undefined) currentUser.has_admin = msg.data.has_admin;
          if (msg.data.has_billing !== undefined) currentUser.has_billing = msg.data.has_billing;
          if (msg.data.role_name) currentUser.role_name = msg.data.role_name;
          buildSidebar();
          buildMobileNav();
          if (window.__xrayToast) window.__xrayToast('Your permissions have been updated', 'info');
        } else if (msg.type === 'team:member-joined' && msg.data) {
          if (window.__xrayToast) window.__xrayToast((msg.data.name || 'A new member') + ' has joined the team', 'success');
          if (window.__xrayRefreshTeamView) window.__xrayRefreshTeamView();
        } else if (msg.type === 'team:invitation-changed') {
          // Invitation created/revoked — refresh invitations list
          if (window.__xrayRefreshTeamView) window.__xrayRefreshTeamView();
        } else if (msg.type === 'replay:events' && msg.data && msg.data.events) {
          // Shadow view: forward events to the shadow player handler
          if (window.__xrayShadowHandler) window.__xrayShadowHandler(msg.data.events);
        }
      } catch(e) {}
    };

    _ws.onclose = function(evt) {
      _ws = null;
      window.__xrayWs = null;
      if (!_wsIntentionalClose) scheduleWsReconnect();
    };

    _ws.onerror = function() {
      // onclose will fire after this
    };
  }

  function scheduleWsReconnect() {
    if (_wsReconnectTimer) return;
    _wsReconnectTimer = setTimeout(function() {
      _wsReconnectTimer = null;
      connectWebSocket();
    }, _wsReconnectDelay);
    _wsReconnectDelay = Math.min(_wsReconnectDelay * 2, _wsMaxDelay);
  }

  function reconnectWebSocket() {
    // Called after token refresh to reconnect with new token
    if (_ws) { _wsIntentionalClose = true; _ws.close(); _ws = null; _wsIntentionalClose = false; }
    _wsReconnectDelay = 1000;
    connectWebSocket();
  }

  function closeWebSocket() {
    _wsIntentionalClose = true;
    if (_wsReconnectTimer) { clearTimeout(_wsReconnectTimer); _wsReconnectTimer = null; }
    if (_ws) { _ws.close(); _ws = null; }
    _wsIntentionalClose = false;
  }
  // Sound presets for MEET call alerts
  var RING_SOUNDS = {
    classic: function(ctx, t) {
      function beep(f, s, d) { var o=ctx.createOscillator(),g=ctx.createGain();o.connect(g);g.connect(ctx.destination);o.frequency.value=f;o.type='sine';g.gain.setValueAtTime(0.15,t+s);g.gain.exponentialRampToValueAtTime(0.001,t+s+d);o.start(t+s);o.stop(t+s+d); }
      beep(880,0,0.2); beep(1100,0.25,0.2); beep(880,0.5,0.2);
    },
    urgent: function(ctx, t) {
      function beep(f, s, d) { var o=ctx.createOscillator(),g=ctx.createGain();o.connect(g);g.connect(ctx.destination);o.frequency.value=f;o.type='square';g.gain.setValueAtTime(0.1,t+s);g.gain.exponentialRampToValueAtTime(0.001,t+s+d);o.start(t+s);o.stop(t+s+d); }
      beep(1200,0,0.15); beep(900,0.2,0.15); beep(1200,0.4,0.15); beep(900,0.6,0.15);
    },
    gentle: function(ctx, t) {
      function beep(f, s, d) { var o=ctx.createOscillator(),g=ctx.createGain();o.connect(g);g.connect(ctx.destination);o.frequency.value=f;o.type='sine';g.gain.setValueAtTime(0.08,t+s);g.gain.exponentialRampToValueAtTime(0.001,t+s+d);o.start(t+s);o.stop(t+s+d); }
      beep(523,0,0.4); beep(659,0.5,0.4); beep(784,1.0,0.5);
    },
    chime: function(ctx, t) {
      function beep(f, s, d) { var o=ctx.createOscillator(),g=ctx.createGain();o.connect(g);g.connect(ctx.destination);o.frequency.value=f;o.type='triangle';g.gain.setValueAtTime(0.12,t+s);g.gain.exponentialRampToValueAtTime(0.001,t+s+d);o.start(t+s);o.stop(t+s+d); }
      beep(1047,0,0.3); beep(1319,0.15,0.3); beep(1568,0.3,0.4);
    }
  };

  var _ringInterval = null;
  var _ringCtx = null;
  var _vibrationInterval = null;

  function stopRinging() {
    if (_ringInterval) { clearInterval(_ringInterval); _ringInterval = null; }
    if (_ringCtx) { try { _ringCtx.close(); } catch(e) {} _ringCtx = null; }
    if (_vibrationInterval) { clearInterval(_vibrationInterval); _vibrationInterval = null; }
    if (navigator.vibrate) try { navigator.vibrate(0); } catch(e) {}
  }

  function startRinging() {
    stopRinging();
    var soundName = supportCallConfig.sound || 'classic';
    var soundFn = RING_SOUNDS[soundName] || RING_SOUNDS.classic;
    // Play sound if enabled
    if (supportCallConfig.sound_enabled !== false) {
      try {
        _ringCtx = new (window.AudioContext || window.webkitAudioContext)();
        soundFn(_ringCtx, _ringCtx.currentTime);
        // Repeat every 3 seconds
        _ringInterval = setInterval(function() {
          if (_ringCtx) {
            try { soundFn(_ringCtx, _ringCtx.currentTime); } catch(e) { stopRinging(); }
          }
        }, 3000);
      } catch(e) {}
    }
    // Vibrate if enabled - repeat pattern
    if (supportCallConfig.vibration_enabled !== false && navigator.vibrate) {
      try { navigator.vibrate([200, 100, 200, 100, 400]); } catch(e) {}
      _vibrationInterval = setInterval(function() {
        if (navigator.vibrate) try { navigator.vibrate([200, 100, 200, 100, 400]); } catch(e) {}
      }, 3000);
    }
  }

  function showSupportCallAlert(call) {
    var existing = document.getElementById('sca-' + call.id);
    if (existing) existing.remove();
    var alert = document.createElement('div');
    alert.id = 'sca-' + call.id;
    alert.className = 'support-call-alert';
    alert.innerHTML = '<div class="sca-title"><svg viewBox="0 0 24 24" width="18" height="18" stroke="#3b82f6" fill="none" stroke-width="2"><path d="M22 16.92v3a2 2 0 01-2.18 2 19.79 19.79 0 01-8.63-3.07 19.5 19.5 0 01-6-6 19.79 19.79 0 01-3.07-8.67A2 2 0 014.11 2h3a2 2 0 012 1.72c.127.96.361 1.903.7 2.81a2 2 0 01-.45 2.11L8.09 9.91a16 16 0 006 6l1.27-1.27a2 2 0 012.11-.45c.907.339 1.85.573 2.81.7A2 2 0 0122 16.92z"/></svg>Incoming Support Call</div>' +
      '<div class="sca-info"><strong>' + escapeHtml(call.caller_name || call.caller_email || 'User') + '</strong> from <strong>' + escapeHtml(call.tenant_name || 'Unknown') + '</strong></div>' +
      '<div class="sca-actions"><button class="sca-join">Join Call</button><button class="sca-dismiss">Dismiss</button></div>';
    document.body.appendChild(alert);
    alert.querySelector('.sca-join').onclick = function() { stopRinging(); joinSupportCall(call); alert.remove(); };
    alert.querySelector('.sca-dismiss').onclick = function() { stopRinging(); dismissSupportCall(call.id); alert.remove(); };
    // Auto-dismiss after configurable ring duration
    var ringMs = (supportCallConfig.ring_duration || 60) * 1000;
    setTimeout(function() { if (document.getElementById('sca-' + call.id)) { stopRinging(); dismissSupportCall(call.id); alert.remove(); } }, ringMs);
    // Start persistent ringing (sound + vibration)
    startRinging();
  }
  function joinSupportCall(call) {
    // Stop all ringing
    stopRinging();
    api.post('/api/meet/support-calls/' + call.id + '/answer', {}).catch(function() {});
    if (!meetState.configured) {
      window.open(call.join_url, '_blank');
      return;
    }
    closeMeetPanel();
    launchMeetCall(call.room_code);
  }

  function updateMeetHeaderState() {
    var btn = document.getElementById('btn-meet-header');
    if (!btn) return;
    btn.classList.toggle('in-call', meetState.inCall);
  }

  function updateMobileMeetState() {
    var mobMeet = document.getElementById('mob-meet');
    var mobEnd = document.getElementById('mob-meet-end');
    if (mobMeet) {
      mobMeet.classList.toggle('mob-meet-active', meetState.inCall);
    }
    if (mobEnd) {
      mobEnd.style.display = meetState.inCall ? '' : 'none';
    }
  }

  function setupMeetViewport() {
    // Viewport controls
    var vpMin = document.getElementById('meet-vp-minimize');
    var vpPip = document.getElementById('meet-vp-pip');
    var vpFs = document.getElementById('meet-vp-fullscreen');
    var vpClose = document.getElementById('meet-vp-close');
    if (vpMin) vpMin.onclick = function() { setMeetViewMode('minimized'); };
    if (vpPip) vpPip.onclick = function() { setMeetViewMode('pip'); };
    if (vpFs) vpFs.onclick = function() { setMeetViewMode('fullscreen'); };
    if (vpClose) vpClose.onclick = function() { endMeetCall(); };

    // Minimized header controls
    var minMin = document.getElementById('meet-min-minimize');
    var minPip = document.getElementById('meet-min-pip');
    var minFs = document.getElementById('meet-min-fullscreen');
    var minClose = document.getElementById('meet-min-close');
    if (minMin) minMin.onclick = function() { setMeetViewMode('minimized'); };
    if (minPip) minPip.onclick = function() { setMeetViewMode('pip'); };
    if (minFs) minFs.onclick = function() { setMeetViewMode('fullscreen'); };
    if (minClose) minClose.onclick = function() { endMeetCall(); };

    // Room indicator click to copy
    var roomIndicator = document.getElementById('meet-room-indicator');
    if (roomIndicator) roomIndicator.onclick = function() {
      var url = getMeetJoinUrl(meetState.roomCode);
      navigator.clipboard.writeText(url).then(function() {
        toast('Meeting link copied!', 'success');
      }).catch(function() {});
    };

    // Drag for PIP mode
    var viewport = document.getElementById('meet-viewport');
    if (viewport) {
      var bar = viewport.querySelector('.meet-viewport-bar');
      var dragging = false, startX, startY, origLeft, origTop;
      if (bar) {
        bar.addEventListener('mousedown', function(e) {
          if (e.target.closest('.meet-bar-btn')) return;
          if (meetState.viewMode !== 'pip') return;
          dragging = true;
          startX = e.clientX; startY = e.clientY;
          var rect = viewport.getBoundingClientRect();
          origLeft = rect.left; origTop = rect.top;
          e.preventDefault();
        });
        document.addEventListener('mousemove', function(e) {
          if (!dragging) return;
          viewport.style.left = (origLeft + e.clientX - startX) + 'px';
          viewport.style.top = (origTop + e.clientY - startY) + 'px';
          viewport.style.right = 'auto'; viewport.style.bottom = 'auto';
        });
        document.addEventListener('mouseup', function() { dragging = false; });
      }
    }
  }

  window.__xrayRefreshMeetWidget = function() { initMeetHeader(); };

  // ── Share page handler ──
  // When NGINX serves index.html for /share/:token, detect it and render share UI instead
  function handleSharePage() {
    var pathname = window.location.pathname;
    if (!pathname.match(/^\/share\/.+/)) return false;

    var token = pathname.split('/').pop();
    if (!token) return false;

    // Hide landing page entirely
    var landing = document.getElementById('landing-screen');
    if (landing) landing.style.display = 'none';

    // Build share page UI
    document.body.insertAdjacentHTML('afterbegin',
      '<div id="share-page" style="position:fixed;inset:0;display:flex;flex-direction:column;background:var(--bg,#08090c);color:var(--t1,#f0f1f4);overflow:hidden">' +
        '<div style="height:48px;flex-shrink:0;background:var(--bg2,#0f1117);border-bottom:1px solid rgba(255,255,255,0.06);display:flex;align-items:center;padding:0 20px;gap:12px">' +
          '<a href="/" style="text-decoration:none;display:flex;align-items:center;gap:4px">' +
            '<span style="width:28px;height:28px;display:flex;align-items:center;justify-content:center">' +
              '<svg viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg" style="width:22px;height:22px">' +
                '<path d="M50 8 L62 28 A28 28 0 0 1 78 50 L98 50 A48 48 0 0 0 50 2 Z" fill="#3ee8b5"/>' +
                '<path d="M78 50 A28 28 0 0 1 62 72 L50 92 A48 48 0 0 0 98 50 Z" fill="#3ee8b5"/>' +
                '<path d="M62 72 A28 28 0 0 1 38 72 L50 50 Z" fill="#3ee8b5"/>' +
                '<path d="M38 72 L28 92 A48 48 0 0 1 2 50 L22 50 A28 28 0 0 0 38 72 Z" fill="#3ee8b5"/>' +
                '<path d="M22 50 A28 28 0 0 1 38 28 L50 8 A48 48 0 0 0 2 50 Z" fill="#3ee8b5"/>' +
                '<circle cx="50" cy="50" r="12" fill="#3ee8b5"/>' +
              '</svg>' +
            '</span>' +
            '<span style="font-size:18px;font-weight:700;letter-spacing:-0.02em"><span style="color:#fff">X</span><span style="color:#3ee8b5">Ray</span></span>' +
          '</a>' +
        '</div>' +
        '<div id="share-content" style="width:100%;flex:1;min-height:0;overflow:hidden">' +
          '<div style="display:flex;align-items:center;justify-content:center;height:100%;color:var(--t2,#8e91a0);gap:10px;font-size:14px">' +
            '<div class="spinner"></div> Loading dashboard...' +
          '</div>' +
        '</div>' +
      '</div>'
    );

    // Check sessionStorage cache (30 min TTL)
    var cacheKey = 'xray_share_' + token;
    var cached = null;
    try {
      var raw = sessionStorage.getItem(cacheKey);
      if (raw) {
        var parsed = JSON.parse(raw);
        if (parsed.ts && (Date.now() - parsed.ts) < 30 * 60 * 1000) {
          cached = parsed.data;
        } else {
          sessionStorage.removeItem(cacheKey);
        }
      }
    } catch(e) {}

    if (cached) {
      renderShareDashboard(cached);
    } else {
      fetchShareDashboard(token, cacheKey);
    }
    return true;
  }

  function fetchShareDashboard(token, cacheKey) {
    fetch('/api/share/' + encodeURIComponent(token))
      .then(function(r) { return r.json(); })
      .then(function(d) {
        if (!d.ok) {
          showShareError((d.error && d.error.message) || 'This dashboard is no longer available.');
          return;
        }
        try {
          sessionStorage.setItem(cacheKey, JSON.stringify({ ts: Date.now(), data: d.data }));
        } catch(e) {}
        renderShareDashboard(d.data);
      })
      .catch(function() {
        showShareError('Failed to load dashboard. Please try again later.');
      });
  }

  function renderShareDashboard(data) {
    document.title = (data.name || 'Dashboard') + ' \u2014 XRay';
    var content = document.getElementById('share-content');
    if (!content) return;
    var iframe = document.createElement('iframe');
    iframe.sandbox = 'allow-scripts allow-forms allow-popups allow-same-origin';
    iframe.style.cssText = 'width:100%;height:100%;border:none;background:#08090c';
    content.innerHTML = '';
    content.appendChild(iframe);
    var doc = iframe.contentDocument || iframe.contentWindow.document;
    doc.open();
    doc.write('<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{margin:0;font-family:system-ui,-apple-system,sans-serif;background:#08090c;color:#f0f1f4}' + (data.css || '') + '</style></head><body>' + (data.html || '') + '<scr' + 'ipt>' + (data.js || '') + '</scr' + 'ipt></body></html>');
    doc.close();
  }

  function showShareError(msg) {
    var content = document.getElementById('share-content');
    if (!content) return;
    content.innerHTML = '<div style="display:flex;flex-direction:column;align-items:center;justify-content:center;height:100%;color:var(--t2,#8e91a0);gap:12px;font-size:15px">' +
      '<svg viewBox="0 0 24 24" width="48" height="48" stroke="currentColor" fill="none" stroke-width="1" style="opacity:.3"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>' +
      '<p>' + msg + '</p></div>';
  }

  // ── Document Viewer ──
  window.__xrayOpenViewer = function(fileUrl, fileName, mimeType) {
    // Remove existing viewer if any
    var existing = document.getElementById('xray-doc-viewer');
    if (existing) existing.remove();

    var ext = (fileName || '').split('.').pop().toLowerCase();
    mimeType = mimeType || '';

    // Determine content type
    var isImage = /^(jpg|jpeg|png|gif|svg|webp|bmp|ico)$/.test(ext) || mimeType.startsWith('image/');
    var isPdf = ext === 'pdf' || mimeType === 'application/pdf';
    var isCsv = ext === 'csv' || mimeType === 'text/csv';
    var isVideo = /^(mp4|webm|ogg|mov)$/.test(ext) || mimeType.startsWith('video/');
    var isAudio = /^(mp3|wav|ogg|flac|aac|m4a)$/.test(ext) || mimeType.startsWith('audio/');
    var isOffice = /^(doc|docx|ppt|pptx|xls|xlsx)$/.test(ext);
    var isText = /^(txt|log|json|xml|html|css|js|ts|py|rb|go|rs|java|c|cpp|h|sh|md|yaml|yml|toml|ini|cfg|conf|sql|env)$/.test(ext) || mimeType.startsWith('text/');

    // Build overlay
    var overlay = document.createElement('div');
    overlay.id = 'xray-doc-viewer';
    overlay.style.cssText = 'position:fixed;inset:0;z-index:9000;background:rgba(0,0,0,0.92);display:flex;flex-direction:column;';

    // Top bar
    var bar = document.createElement('div');
    bar.style.cssText = 'display:flex;align-items:center;gap:12px;padding:12px 20px;background:rgba(15,17,23,0.95);border-bottom:1px solid rgba(255,255,255,0.06);flex-shrink:0;';
    var nameEl = document.createElement('span');
    nameEl.textContent = fileName || fileUrl;
    nameEl.style.cssText = 'flex:1;font-size:14px;font-weight:500;color:#f0f1f4;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family:var(--font);';
    var btnStyle = 'padding:6px 14px;font-size:13px;border-radius:6px;border:1px solid rgba(255,255,255,0.12);background:rgba(255,255,255,0.06);color:#f0f1f4;cursor:pointer;font-family:var(--font);white-space:nowrap;';
    var openBtn = document.createElement('button');
    openBtn.textContent = 'Open in new tab';
    openBtn.style.cssText = btnStyle;
    openBtn.onmouseover = function() { openBtn.style.background = 'rgba(255,255,255,0.12)'; };
    openBtn.onmouseout = function() { openBtn.style.background = 'rgba(255,255,255,0.06)'; };
    openBtn.onclick = function() { window.open(tokenUrl, '_blank'); };
    var dlBtn = document.createElement('button');
    dlBtn.textContent = 'Download';
    dlBtn.style.cssText = btnStyle;
    dlBtn.onmouseover = function() { dlBtn.style.background = 'rgba(255,255,255,0.12)'; };
    dlBtn.onmouseout = function() { dlBtn.style.background = 'rgba(255,255,255,0.06)'; };
    dlBtn.onclick = function() {
      var a = document.createElement('a');
      a.href = tokenUrl;
      a.download = fileName || 'file';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
    };
    var closeBtn = document.createElement('button');
    closeBtn.innerHTML = '&times;';
    closeBtn.style.cssText = 'width:32px;height:32px;border-radius:6px;border:none;background:transparent;color:#8e91a0;font-size:24px;cursor:pointer;display:flex;align-items:center;justify-content:center;line-height:1;';
    closeBtn.onmouseover = function() { closeBtn.style.background = 'rgba(255,255,255,0.08)'; closeBtn.style.color = '#f0f1f4'; };
    closeBtn.onmouseout = function() { closeBtn.style.background = 'transparent'; closeBtn.style.color = '#8e91a0'; };
    closeBtn.onclick = function() { overlay.remove(); document.removeEventListener('keydown', escHandler); };
    bar.appendChild(nameEl);
    bar.appendChild(openBtn);
    bar.appendChild(dlBtn);
    bar.appendChild(closeBtn);
    overlay.appendChild(bar);

    // Content area
    var content = document.createElement('div');
    content.style.cssText = 'flex:1;overflow:auto;display:flex;align-items:center;justify-content:center;padding:20px;';
    content.innerHTML = '<div style="color:#8e91a0;font-size:14px;">Loading...</div>';
    overlay.appendChild(content);
    document.body.appendChild(overlay);

    // Escape key handler
    function escHandler(e) {
      if (e.key === 'Escape') {
        overlay.remove();
        document.removeEventListener('keydown', escHandler);
      }
    }
    document.addEventListener('keydown', escHandler);

    // Get a short-lived token for browser-direct access, then render content
    var fileId = fileUrl.replace(/.*\/uploads\//, '').replace('/download', '');
    var tokenUrl = fileUrl;
    var authHeaders = accessToken ? { 'Authorization': 'Bearer ' + accessToken } : {};
    api.post('/api/uploads/' + fileId + '/token', {}).then(function(r) {
      if (r.ok && r.data && r.data.token) {
        tokenUrl = fileUrl + '?token=' + r.data.token;
      }
    }).catch(function(){}).then(function() {
      // Use tokenUrl for elements that set src (browser fetches without JS headers)
      // Use authHeaders for JS fetch calls (CSV, text)
      content.innerHTML = '';
      if (isImage) {
        var img = document.createElement('img');
        img.src = tokenUrl;
        img.alt = fileName || '';
        img.style.cssText = 'max-width:100%;max-height:100%;object-fit:contain;border-radius:4px;';
        content.appendChild(img);
      } else if (isPdf) {
        var iframe = document.createElement('iframe');
        iframe.src = tokenUrl;
        iframe.style.cssText = 'width:100%;height:100%;border:none;border-radius:4px;background:#fff;';
        content.style.padding = '0';
        content.appendChild(iframe);
      } else if (isCsv) {
        content.innerHTML = '<div style="color:#8e91a0;font-size:14px;">Loading CSV...</div>';
        fetch(fileUrl, { headers: authHeaders, credentials: 'include' }).then(function(r) { return r.text(); }).then(function(text) {
          var lines = text.trim().split('\n');
          var html = '<div style="overflow:auto;width:100%;height:100%;"><table style="border-collapse:collapse;font-size:13px;font-family:var(--mono);width:100%;">';
          for (var i = 0; i < lines.length; i++) {
            var cells = lines[i].split(',');
            var tag = i === 0 ? 'th' : 'td';
            html += '<tr>';
            for (var j = 0; j < cells.length; j++) {
              var cellStyle = i === 0
                ? 'padding:8px 12px;text-align:left;border-bottom:2px solid rgba(62,232,181,0.3);color:#3ee8b5;font-weight:600;white-space:nowrap;background:rgba(15,17,23,0.8);position:sticky;top:0;'
                : 'padding:6px 12px;border-bottom:1px solid rgba(255,255,255,0.06);color:#f0f1f4;white-space:nowrap;';
              html += '<' + tag + ' style="' + cellStyle + '">' + cells[j].replace(/^"|"$/g, '') + '</' + tag + '>';
            }
            html += '</tr>';
          }
          html += '</table></div>';
          content.innerHTML = html;
        }).catch(function() {
          content.innerHTML = '<div style="color:#ef4444;font-size:14px;">Failed to load CSV file.</div>';
        });
      } else if (isVideo) {
        var video = document.createElement('video');
        video.src = tokenUrl;
        video.controls = true;
        video.autoplay = false;
        video.style.cssText = 'max-width:100%;max-height:100%;border-radius:4px;';
        content.appendChild(video);
      } else if (isAudio) {
        var audio = document.createElement('audio');
        audio.src = tokenUrl;
        audio.controls = true;
        audio.style.cssText = 'min-width:300px;';
        content.appendChild(audio);
      } else if (isOffice) {
        // Office Online and Google Docs viewers require a publicly accessible URL.
        // Since our files are behind auth, fetch the file as a blob and display it.
        var officeExts = { doc: true, docx: true, ppt: true, pptx: true, xls: true, xlsx: true };
        content.innerHTML = '<div style="color:#8e91a0;font-size:14px;">Loading document...</div>';
        content.style.padding = '0';
        fetch(fileUrl, { headers: authHeaders, credentials: 'include' }).then(function(r) {
          if (!r.ok) throw new Error('Failed to fetch');
          return r.blob();
        }).then(function(blob) {
          var blobUrl = URL.createObjectURL(blob);
          // Try Google Docs viewer with a public URL first, fall back to download
          var officeIframe = document.createElement('iframe');
          officeIframe.src = 'https://view.officeapps.live.com/op/embed.aspx?src=' + encodeURIComponent(tokenUrl);
          officeIframe.style.cssText = 'width:100%;height:100%;border:none;border-radius:4px;background:#fff;';
          officeIframe.setAttribute('allowfullscreen', 'true');
          // Detect load failure after timeout and show fallback
          var loadFailed = false;
          var fallbackTimer = setTimeout(function() {
            loadFailed = true;
            content.innerHTML = '';
            var fallbackMsg = document.createElement('div');
            fallbackMsg.style.cssText = 'display:flex;flex-direction:column;align-items:center;justify-content:center;height:100%;gap:16px;padding:40px;';
            fallbackMsg.innerHTML = '<svg viewBox="0 0 24 24" width="48" height="48" stroke="#8e91a0" fill="none" stroke-width="1" style="opacity:.4"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>' +
              '<p style="color:#f0f1f4;font-size:15px;text-align:center">This document type cannot be previewed inline.</p>' +
              '<p style="color:#8e91a0;font-size:13px">Use "Open in new tab" or "Download" to view it.</p>';
            content.appendChild(fallbackMsg);
          }, 8000);
          officeIframe.onload = function() {
            if (!loadFailed) clearTimeout(fallbackTimer);
          };
          content.innerHTML = '';
          content.appendChild(officeIframe);
        }).catch(function() {
          content.innerHTML = '<div style="display:flex;flex-direction:column;align-items:center;justify-content:center;height:100%;gap:16px;padding:40px;">' +
            '<p style="color:#f0f1f4;font-size:15px">Could not load document preview.</p>' +
            '<p style="color:#8e91a0;font-size:13px">Use "Open in new tab" or "Download" to view it.</p></div>';
        });
      } else if (isText) {
        content.innerHTML = '<div style="color:#8e91a0;font-size:14px;">Loading...</div>';
        fetch(fileUrl, { headers: authHeaders, credentials: 'include' }).then(function(r) { return r.text(); }).then(function(text) {
          var pre = document.createElement('pre');
          pre.textContent = text;
          pre.style.cssText = 'width:100%;max-height:100%;overflow:auto;padding:20px;background:rgba(15,17,23,0.8);border:1px solid rgba(255,255,255,0.06);border-radius:8px;font-size:13px;font-family:var(--mono);color:#f0f1f4;line-height:1.6;white-space:pre-wrap;word-break:break-word;margin:0;';
          content.innerHTML = '';
          content.appendChild(pre);
        }).catch(function() {
          content.innerHTML = '<div style="color:#ef4444;font-size:14px;">Failed to load file.</div>';
        });
      } else {
        var dl = document.createElement('a');
        dl.href = tokenUrl;
        dl.download = fileName || '';
        dl.style.cssText = 'display:inline-flex;align-items:center;gap:8px;padding:14px 28px;background:rgba(62,232,181,0.1);border:1px solid rgba(62,232,181,0.3);border-radius:10px;color:#3ee8b5;font-size:15px;font-weight:500;text-decoration:none;font-family:var(--font);';
        dl.innerHTML = '<svg viewBox="0 0 24 24" width="20" height="20" stroke="currentColor" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>Download ' + (fileName || 'file');
        content.appendChild(dl);
      }
    });
  };

  // ── Invite page handler ──
  function handleInvitePage() {
    var pathname = window.location.pathname;
    if (!pathname.match(/^\/invite\/.+/)) return false;

    var token = pathname.split('/').pop();
    if (!token) return false;

    // Hide landing page
    var landing = document.getElementById('landing-screen');
    if (landing) landing.style.display = 'none';

    // Create invite accept UI
    var container = document.createElement('div');
    container.style.cssText = 'min-height:100vh;display:flex;align-items:center;justify-content:center;background:var(--bg1,#0a0a0a);font-family:-apple-system,BlinkMacSystemFont,sans-serif;';
    container.innerHTML = '<div style="background:var(--bg2,#141414);border:1px solid var(--border,#222);border-radius:12px;padding:40px;max-width:400px;width:100%;text-align:center;">'
      + '<div style="margin-bottom:20px"><svg viewBox="0 0 24 24" width="48" height="48" stroke="var(--acc,#10b981)" fill="none" stroke-width="1.5"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg></div>'
      + '<h2 id="invite-title" style="color:var(--t1,#fff);font-size:20px;margin:0 0 8px">Accept Invitation</h2>'
      + '<p id="invite-desc" style="color:var(--t2,#888);font-size:14px;margin:0 0 24px">Loading invitation details...</p>'
      + '<div id="invite-form" style="display:none">'
      + '<div style="text-align:left;margin-bottom:12px"><label style="color:var(--t2,#888);font-size:13px;display:block;margin-bottom:4px">Email</label>'
      + '<input id="invite-email" type="email" readonly style="width:100%;padding:10px 12px;border:1px solid var(--border,#222);border-radius:6px;background:var(--bg3,#1a1a1a);color:var(--t2,#888);font-size:14px;box-sizing:border-box;" /></div>'
      + '<div style="text-align:left;margin-bottom:20px"><label style="color:var(--t2,#888);font-size:13px;display:block;margin-bottom:4px">Your Name</label>'
      + '<input id="invite-name" type="text" placeholder="Enter your name" autofocus style="width:100%;padding:10px 12px;border:1px solid var(--border,#222);border-radius:6px;background:var(--bg3,#1a1a1a);color:var(--t1,#fff);font-size:14px;box-sizing:border-box;" /></div>'
      + '<button id="invite-accept-btn" class="btn primary" style="width:100%;padding:12px;font-size:15px;border-radius:8px;">Join Team</button>'
      + '<p id="invite-err" style="color:#ef4444;font-size:13px;margin:12px 0 0;display:none"></p>'
      + '</div>'
      + '<div id="invite-invalid" style="display:none"><p style="color:#ef4444;font-size:14px">This invitation is no longer valid. It may have expired or already been used.</p>'
      + '<a href="/" style="color:var(--acc,#10b981);font-size:14px;text-decoration:none">Go to XRay</a></div>'
      + '</div>';
    document.body.appendChild(container);

    // Fetch invitation info
    fetch('/api/invitations/info/' + token)
      .then(function(r) { return r.json(); })
      .then(function(r) {
        if (!r.ok || !r.data || !r.data.valid) {
          document.getElementById('invite-desc').style.display = 'none';
          document.getElementById('invite-invalid').style.display = '';
          return;
        }
        var info = r.data;
        document.getElementById('invite-desc').textContent = 'You\'ve been invited to join ' + info.tenant_name;
        document.getElementById('invite-email').value = info.email;
        document.getElementById('invite-form').style.display = '';
        document.getElementById('invite-name').focus();

        // Accept handler
        document.getElementById('invite-accept-btn').onclick = function() {
          var name = document.getElementById('invite-name').value.trim();
          if (!name) {
            document.getElementById('invite-err').textContent = 'Please enter your name';
            document.getElementById('invite-err').style.display = '';
            return;
          }
          var btn = this;
          btn.disabled = true;
          btn.textContent = 'Joining...';
          document.getElementById('invite-err').style.display = 'none';

          fetch('/api/invitations/accept', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'include',
            body: JSON.stringify({ token: token, name: name })
          })
          .then(function(r) { return r.json(); })
          .then(function(r) {
            btn.disabled = false;
            btn.textContent = 'Join Team';
            if (!r.ok) {
              document.getElementById('invite-err').textContent = (r.error && r.error.message) || 'Failed to accept invitation';
              document.getElementById('invite-err').style.display = '';
              return;
            }
            // Auto-login: set token and redirect to app
            if (r.data && r.data.accessToken) {
              accessToken = r.data.accessToken;
              // Clean URL and enter app
              window.history.replaceState({}, '', '/');
              container.remove();
              enterApp();
            } else {
              // Fallback: redirect to login
              window.location.href = '/';
            }
          })
          .catch(function() {
            btn.disabled = false;
            btn.textContent = 'Join Team';
            document.getElementById('invite-err').textContent = 'Network error. Please try again.';
            document.getElementById('invite-err').style.display = '';
          });
        };

        // Enter key handler
        document.getElementById('invite-name').onkeydown = function(e) {
          if (e.key === 'Enter') document.getElementById('invite-accept-btn').click();
        };
      })
      .catch(function() {
        document.getElementById('invite-desc').style.display = 'none';
        document.getElementById('invite-invalid').style.display = '';
      });

    return true;
  }

  // ── Step 11: public legal page handler (/legal/<slug>) ──
  // Renders policy_documents content for logged-out + logged-in
  // visitors. Lazy-loads `marked` from a CDN; falls back to plain
  // <pre> rendering if the CDN is unreachable so the page always
  // shows the policy text.
  function handleLegalPage() {
    var pathname = window.location.pathname;
    var m = pathname.match(/^\/legal\/?([a-zA-Z0-9_\-]+)?\/?(?:v\/(\d+))?\/?$/);
    if (!m) return false;
    var slug = m[1] || '';
    var version = m[2] ? parseInt(m[2], 10) : null;

    var landing = document.getElementById('landing-screen');
    if (landing) landing.style.display = 'none';

    var container = document.createElement('div');
    container.id = 'legal-page';
    container.style.cssText = 'min-height:100vh;background:var(--bg,#08090c);color:var(--t1,#f0f1f4);font-family:-apple-system,BlinkMacSystemFont,sans-serif;display:flex;flex-direction:column;';
    var header = '<div style="height:56px;flex-shrink:0;background:var(--bg2,#0f1117);border-bottom:1px solid rgba(255,255,255,0.06);display:flex;align-items:center;padding:0 24px;gap:12px">'
      + '<a href="/" style="text-decoration:none;display:flex;align-items:center;gap:8px;color:#fff;font-size:16px;font-weight:700;letter-spacing:-0.02em">'
      + '<svg viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg" style="width:24px;height:24px"><path d="M50 8 L62 28 A28 28 0 0 1 78 50 L98 50 A48 48 0 0 0 50 2 Z" fill="#3ee8b5"/><path d="M78 50 A28 28 0 0 1 62 72 L50 92 A48 48 0 0 0 98 50 Z" fill="#3ee8b5"/><path d="M62 72 A28 28 0 0 1 38 72 L50 50 Z" fill="#3ee8b5"/><path d="M38 72 L28 92 A48 48 0 0 1 2 50 L22 50 A28 28 0 0 0 38 72 Z" fill="#3ee8b5"/><path d="M22 50 A28 28 0 0 1 38 28 L50 8 A48 48 0 0 0 2 50 Z" fill="#3ee8b5"/><circle cx="50" cy="50" r="12" fill="#3ee8b5"/></svg>'
      + '<span><span style="color:#fff">X</span><span style="color:#3ee8b5">Ray</span></span></a>'
      + '<div style="flex:1"></div>'
      + '<a href="/legal" style="color:var(--t2,#8e91a0);font-size:13px;text-decoration:none">All policies</a>'
      + '</div>';
    container.innerHTML = header
      + '<div id="legal-content" style="max-width:760px;width:100%;margin:0 auto;padding:48px 24px 96px;flex:1;line-height:1.65;font-size:15px"><div style="color:var(--t2,#8e91a0)">Loading…</div></div>';
    document.body.insertBefore(container, document.body.firstChild);

    var content = document.getElementById('legal-content');

    function escapeHtml(s) {
      return String(s).replace(/[&<>"']/g, function(c) {
        return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]);
      });
    }

    function renderMarkdown(md, doc, isHistorical) {
      var fragment = '';
      if (doc && doc.is_placeholder) {
        fragment += '<div style="background:rgba(245,158,11,0.12);border:1px solid rgba(245,158,11,0.4);border-radius:8px;padding:14px 18px;margin-bottom:24px;color:#f59e0b;font-size:14px"><strong>Placeholder</strong> — this document has not yet been finalised. The operator must publish a real version before opening signups.</div>';
      }
      if (isHistorical) {
        fragment += '<div style="background:rgba(99,102,241,0.10);border:1px solid rgba(99,102,241,0.30);border-radius:8px;padding:12px 16px;margin-bottom:20px;color:#a5b4fc;font-size:13px">You are viewing an archived version (v' + escapeHtml(String(doc.version)) + '). <a href="/legal/' + encodeURIComponent(doc.slug) + '" style="color:#c7d2fe">View latest</a>.</div>';
      }
      var heading = doc ? '<h1 style="font-size:32px;font-weight:700;margin:0 0 8px;color:#fff;letter-spacing:-0.02em">' + escapeHtml(doc.title) + '</h1>'
                          + '<div style="color:var(--t2,#8e91a0);font-size:13px;margin-bottom:32px">Version ' + escapeHtml(String(doc.version)) + ' · published ' + escapeHtml(new Date(doc.published_at).toLocaleDateString()) + '</div>' : '';
      function plainFallback() {
        return '<pre style="white-space:pre-wrap;font-family:inherit;background:transparent;border:0;padding:0;margin:0">' + escapeHtml(md) + '</pre>';
      }
      function applyMarkdown(html) {
        content.innerHTML = fragment + heading + '<div class="legal-md">' + html + '</div>';
        // Style images / links / tables in the rendered markdown
        var styleTag = document.createElement('style');
        styleTag.textContent = '.legal-md h1{font-size:26px;margin:36px 0 12px;color:#fff}.legal-md h2{font-size:20px;margin:32px 0 10px;color:#fff}.legal-md h3{font-size:16px;margin:24px 0 8px;color:#fff}.legal-md p{margin:0 0 14px;color:var(--t1,#f0f1f4)}.legal-md ul,.legal-md ol{margin:0 0 14px;padding-left:24px}.legal-md li{margin:0 0 6px}.legal-md a{color:#3ee8b5}.legal-md code{background:rgba(255,255,255,0.06);padding:2px 6px;border-radius:4px;font-size:0.92em}.legal-md pre{background:var(--bg2,#0f1117);border:1px solid rgba(255,255,255,0.08);border-radius:6px;padding:12px 14px;overflow-x:auto}.legal-md hr{border:0;border-top:1px solid rgba(255,255,255,0.08);margin:24px 0}';
        if (!document.getElementById('legal-md-style')) {
          styleTag.id = 'legal-md-style';
          document.head.appendChild(styleTag);
        }
      }
      if (window.marked && typeof window.marked.parse === 'function') {
        try {
          // Sanitize the rendered HTML before innerHTML. marked v12+
          // dropped its built-in sanitize option, so a malicious admin
          // (or a compromised admin session) publishing
          // `<script>alert(1)</script>` in body_md would otherwise
          // execute on every visitor's browser. DOMPurify v3 is
          // loaded by loadMarkedAnd() alongside marked itself; if it
          // failed to load (CDN blocked), we fall back to plain text
          // rendering rather than risk an unsanitized innerHTML.
          var raw = window.marked.parse(md, { breaks: false, gfm: true });
          var safe = (window.DOMPurify && typeof window.DOMPurify.sanitize === 'function')
            ? window.DOMPurify.sanitize(raw)
            : null;
          if (safe !== null) {
            applyMarkdown(safe);
          } else {
            applyMarkdown(plainFallback());
          }
        } catch (e) {
          applyMarkdown(plainFallback());
        }
      } else {
        // Fallback: render the markdown source as preformatted text
        applyMarkdown(plainFallback());
      }
    }

    function loadMarkedAnd(callback) {
      // Lazy-load BOTH marked and DOMPurify before invoking the
      // callback. The legal page is the only XSS-sensitive surface
      // here — bundling the sanitizer with the parser keeps the
      // fence at one place. Both are pinned to specific versions,
      // both fall back to plain-text rendering on CDN failure.
      var needMarked = !(window.marked && typeof window.marked.parse === 'function');
      var needPurify = !(window.DOMPurify && typeof window.DOMPurify.sanitize === 'function');
      if (!needMarked && !needPurify) return callback();

      var pending = (needMarked ? 1 : 0) + (needPurify ? 1 : 0);
      function done() { if (--pending === 0) callback(); }

      function loadOnce(id, src) {
        var existing = document.getElementById(id);
        if (existing) {
          existing.addEventListener('load', done);
          existing.addEventListener('error', done);
          return;
        }
        var s = document.createElement('script');
        s.id = id;
        s.src = src;
        s.onload = done;
        s.onerror = done;
        document.head.appendChild(s);
      }

      if (needMarked) loadOnce('xray-marked-script', 'https://cdn.jsdelivr.net/npm/marked@12.0.2/marked.min.js');
      if (needPurify) loadOnce('xray-dompurify-script', 'https://cdn.jsdelivr.net/npm/dompurify@3.1.7/dist/purify.min.js');
    }

    function fetchAndRender(url, opts) {
      fetch(url).then(function(r) { return r.json(); }).then(function(d) {
        if (!d.ok) {
          var msg = (d.error && d.error.message) || 'This policy is not available.';
          content.innerHTML = '<div style="color:#ef4444;font-size:15px;text-align:center;padding:60px 0">' + escapeHtml(msg) + ' <a href="/legal" style="color:#3ee8b5">Back to all policies</a></div>';
          return;
        }
        if (Array.isArray(d.data && d.data.policies)) {
          renderIndex(d.data.policies);
          return;
        }
        document.title = (d.data.title || 'Legal') + ' — XRay';
        loadMarkedAnd(function() {
          renderMarkdown(d.data.body_md || '', d.data, !!opts && !!opts.historical);
        });
      }).catch(function() {
        content.innerHTML = '<div style="color:#ef4444;font-size:15px;text-align:center;padding:60px 0">Failed to load policy. <a href="/legal" style="color:#3ee8b5">Try again</a></div>';
      });
    }

    function renderIndex(policies) {
      document.title = 'Legal — XRay';
      var html = '<h1 style="font-size:32px;font-weight:700;margin:0 0 24px;color:#fff;letter-spacing:-0.02em">Legal</h1>';
      html += '<p style="color:var(--t2,#8e91a0);margin:0 0 32px">Versioned, published policies governing your use of XRay.</p>';
      html += '<div style="display:flex;flex-direction:column;gap:8px">';
      (policies || []).forEach(function(p) {
        html += '<a href="/legal/' + encodeURIComponent(p.slug) + '" style="display:flex;align-items:center;justify-content:space-between;padding:16px 18px;background:var(--bg2,#0f1117);border:1px solid rgba(255,255,255,0.08);border-radius:10px;text-decoration:none;color:inherit;transition:border-color 0.15s">'
          + '<div><div style="font-size:15px;font-weight:600;color:#fff">' + escapeHtml(p.title) + (p.is_placeholder ? ' <span style="font-size:11px;color:#f59e0b;font-weight:500;margin-left:6px">PLACEHOLDER</span>' : '') + '</div>'
          + '<div style="font-size:12px;color:var(--t2,#8e91a0);margin-top:4px">v' + escapeHtml(String(p.version)) + ' · ' + escapeHtml(new Date(p.published_at).toLocaleDateString()) + '</div></div>'
          + '<svg viewBox="0 0 24 24" width="16" height="16" stroke="currentColor" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg>'
          + '</a>';
      });
      html += '</div>';
      content.innerHTML = html;
    }

    if (!slug) {
      fetchAndRender('/api/legal');
    } else if (version) {
      fetchAndRender('/api/legal/' + encodeURIComponent(slug) + '/v/' + encodeURIComponent(String(version)), { historical: true });
    } else {
      fetchAndRender('/api/legal/' + encodeURIComponent(slug));
    }

    return true;
  }

  // Check if we're on a special page before running normal app init
  if (!handleSharePage() && !handleInvitePage() && !handleLegalPage()) {
    init();
  }
})();
