/**
 * XRay AI SDK — loaded inside a dashboard view when AI is enabled for (user, dashboard).
 *
 * Dashboard authors call window.XRayAI.register({...}) once to describe their data/schema/
 * elements/tools. The SDK mounts a right-side rail (contracted by default) with chat,
 * threads, and pinned findings, and an SVG overlay for annotations.
 *
 * Contracted ↔ expanded by clicking the edge handle or the AI badge.
 *
 * Convention (for dashboard authors):
 *   window.XRayAI.register({
 *     id: 'field-operations',           // dashboard id (match server)
 *     title: 'Field Operations',
 *     schema: { columns: [...], glossary: {...}, period: '...' },
 *     getContext: () => ({ filters, visible, aggregates, top_rows }),
 *     elements: { 'leaderboard.row': '#tbl tr[data-row-id="{id}"]', ... },
 *     suggestedPrompts: ['...'],
 *     tools: {
 *        setFilter(name, value)   { ... },   // drive the dashboard
 *        getRecords({filter, columns, sort, limit}) { ... return rows },
 *     }
 *   });
 *
 * Actions the AI can emit in a trailing ```xray-actions``` code block are dispatched
 * automatically; highlight/clearAnnotations/resetView/undo are handled by the SDK itself.
 */
(function() {
  'use strict';

  // Determine the dashboard id for this script load. The server injects the
  // id as an inline <script>window.__xrayCurrentDashboardId='X'</script> right
  // before loading this file, because the bundle's dashboard render loop
  // strips data-* attributes when re-creating <script> elements — passing the
  // id through an inline global is the only way it survives.
  function readDashboardIdFromDom() {
    if (typeof window.__xrayCurrentDashboardId === 'string' && window.__xrayCurrentDashboardId) {
      return window.__xrayCurrentDashboardId;
    }
    // Legacy fallback: if anything still ships a data-dashboard-id attribute,
    // honor it. Also picks up the last match in case multiple coexist.
    if (document.currentScript && document.currentScript.getAttribute('data-dashboard-id')) {
      return document.currentScript.getAttribute('data-dashboard-id');
    }
    var all = document.querySelectorAll('script[data-xray-ai][data-dashboard-id]');
    if (!all.length) return null;
    return all[all.length - 1].getAttribute('data-dashboard-id');
  }

  var newDashboardId = readDashboardIdFromDom();
  if (!newDashboardId) {
    console.warn('[XRayAI] no data-dashboard-id on bootstrap script');
    return;
  }

  // If the SDK is already booted (user navigated to a different dashboard),
  // just hand the new id to the existing instance and exit. The second load
  // of sdk.js is a no-op for everything else.
  if (window.XRayAI && window.XRayAI._booted) {
    if (typeof window.XRayAI.setDashboard === 'function') {
      window.XRayAI.setDashboard(newDashboardId);
    }
    return;
  }

  var dashboardId = newDashboardId;

  // ── Auth helper: reuse access token from parent (host app sets it on window) ─
  function getToken() {
    if (typeof window.__xrayGetAccessToken === 'function') {
      return window.__xrayGetAccessToken() || '';
    }
    return '';
  }

  function apiFetch(path, opts) {
    opts = opts || {};
    opts.headers = Object.assign({
      'Content-Type': 'application/json',
      'Authorization': 'Bearer ' + getToken()
    }, opts.headers || {});
    return fetch(path, opts).then(function(r) {
      return r.json().catch(function() { return { ok: false, error: { message: 'Invalid JSON' } }; });
    });
  }

  // ── Registration state ─────────────────────────────────────────────────────
  var registered = null;      // { id, title, schema, getContext, elements, suggestedPrompts, tools }
  var undoStack = [];         // { do: fn, undo: fn }
  var annotations = [];       // { id, target, note, rect }
  var currentThreadId = null;
  var threads = [];
  var messages = [];
  var usage = null;           // { count, cap, remaining }

  function register(config) {
    if (!config || !config.id) {
      console.warn('[XRayAI] register() requires { id }');
      return;
    }
    if (config.id !== dashboardId) {
      console.warn('[XRayAI] register id does not match bootstrap dashboard id', config.id, dashboardId);
    }
    registered = config;
    if (mounted) refreshAll();
  }

  // ── Mount point ────────────────────────────────────────────────────────────
  var mounted = false;
  var rail, overlay, headerBtn, mobNavBtn;

  // Entry points for opening the AI rail live in the host app chrome: a
  // header button on desktop (left of MEET) and a mobile-nav button
  // (left of MEET). The rail itself starts hidden and only appears when
  // one of those is clicked. Replaces the old contracted-rail icon stack.
  function injectEntryButtons() {
    // Desktop header: .user-menu contains #btn-meet-header
    var meetBtn = document.getElementById('btn-meet-header');
    if (meetBtn && meetBtn.parentNode && !document.getElementById('xrai-header-btn')) {
      headerBtn = document.createElement('button');
      headerBtn.id = 'xrai-header-btn';
      headerBtn.className = 'xrai-header-btn';
      headerBtn.title = 'Open AI';
      headerBtn.innerHTML =
        '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l2.2 4.8L19 10l-4.8 2.2L12 17l-2.2-4.8L5 10l4.8-2.2z"/></svg>' +
        '<span>AI</span>';
      headerBtn.onclick = open;
      meetBtn.parentNode.insertBefore(headerBtn, meetBtn);
    }
    // Mobile bottom nav
    var mobMeet = document.getElementById('mob-meet');
    if (mobMeet && mobMeet.parentNode && !document.getElementById('xrai-mob-btn')) {
      mobNavBtn = document.createElement('button');
      mobNavBtn.id = 'xrai-mob-btn';
      mobNavBtn.className = 'mob-nav-btn xrai-mob-btn';
      mobNavBtn.title = 'AI';
      mobNavBtn.innerHTML =
        '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l2.2 4.8L19 10l-4.8 2.2L12 17l-2.2-4.8L5 10l4.8-2.2z"/></svg>' +
        '<span>AI</span>';
      mobNavBtn.onclick = open;
      mobMeet.parentNode.insertBefore(mobNavBtn, mobMeet);
    }
  }

  function removeEntryButtons() {
    try { if (headerBtn && headerBtn.parentNode) headerBtn.parentNode.removeChild(headerBtn); } catch (e) {}
    try { if (mobNavBtn && mobNavBtn.parentNode) mobNavBtn.parentNode.removeChild(mobNavBtn); } catch (e) {}
    headerBtn = null;
    mobNavBtn = null;
  }

  function mount() {
    if (mounted) return;
    mounted = true;

    // Rail container (created hidden — user opens it via the header/nav button)
    rail = document.createElement('div');
    rail.className = 'xrai-rail xrai-hidden';
    rail.innerHTML = expandedHtml();
    document.body.appendChild(rail);

    // SVG overlay for annotations (fixed so it tracks viewport)
    overlay = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    overlay.setAttribute('class', 'xrai-overlay');
    overlay.setAttribute('aria-hidden', 'true');
    document.body.appendChild(overlay);

    // Wire expanded-rail events now; rail stays hidden until open() is called.
    wireExpandedEvents();

    // Re-check context availability + inject the entry buttons only if AI is on
    loadContext().then(function() {
      if (!currentContext || !currentContext.available) {
        rail.style.display = 'none';
        overlay.style.display = 'none';
        return;
      }
      injectEntryButtons();
    });

    // Keep annotation positions in sync on scroll/resize
    var rr = null;
    function redraw() { clearTimeout(rr); rr = setTimeout(renderAnnotations, 16); }
    window.addEventListener('resize', redraw);
    window.addEventListener('scroll', redraw, { passive: true, capture: true });

    // The dashboard renders progressively (server fetch → HTML → scripts hydrate
    // data). Observe the active dashboard container so the NOW banner refreshes
    // once real content lands, and so later filter/data changes surface too.
    try {
      if (window.MutationObserver) {
        var mo = new MutationObserver(function() {
          if (!rail || rail.classList.contains('xrai-hidden')) return;
          clearTimeout(renderContextTimer);
          renderContextTimer = setTimeout(function() {
            try { renderContext(); } catch (e) {}
          }, 250);
        });
        mo.observe(document.body, { childList: true, subtree: true, characterData: true });
      }
    } catch (e) { /* observers are best-effort */ }
  }

  var renderContextTimer = null;

  var currentContext = null;
  function loadContext() {
    return apiFetch('/api/ai/context/' + encodeURIComponent(dashboardId))
      .then(function(r) {
        if (!r.ok) {
          currentContext = { available: false, reason: (r.error && r.error.code) || 'ERROR' };
          return;
        }
        currentContext = r.data;
        usage = r.data.usage;
        if (r.data.available) updateUsageLabel();
      });
  }

  function refreshAll() {
    loadThreads();
  }

  // ── Contracted rail markup ─────────────────────────────────────────────────
  function expandedHtml() {
    return (
      '<div class="xrai-hdr">' +
        '<button class="xrai-collapse" title="Collapse"><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.6"><polyline points="9 6 15 12 9 18"/></svg></button>' +
        '<div class="xrai-hdr-title">' +
          '<div class="xrai-hdr-name">XRay AI</div>' +
          '<div class="xrai-hdr-sub" id="xrai-sub"></div>' +
        '</div>' +
        '<button class="xrai-menu" title="More">' +
          '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.6"><circle cx="12" cy="5" r="1.5"/><circle cx="12" cy="12" r="1.5"/><circle cx="12" cy="19" r="1.5"/></svg>' +
        '</button>' +
      '</div>' +
      '<div class="xrai-body">' +
        '<section class="xrai-sec xrai-now">' +
          '<div class="xrai-sec-hd">NOW</div>' +
          '<div class="xrai-now-context" id="xrai-now-ctx">Looking at this dashboard…</div>' +
          '<div class="xrai-now-quick" id="xrai-now-quick"></div>' +
          '<div class="xrai-ann-toolbar" id="xrai-ann-toolbar" style="display:none"><button data-act="clear-ann">Clear annotations</button><button data-act="reset-view">Reset view</button><button data-act="undo">Undo</button></div>' +
        '</section>' +
        '<section class="xrai-sec xrai-threads xrai-threads-collapsed" id="xrai-threads-sec">' +
          '<div class="xrai-sec-hd">' +
            '<button class="xrai-threads-toggle" id="xrai-threads-toggle" title="Show all threads" aria-expanded="false">' +
              '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2"><polyline points="9 6 15 12 9 18"/></svg>' +
              '<span>THREADS</span>' +
              '<span class="xrai-threads-count" id="xrai-threads-count"></span>' +
            '</button>' +
            '<button class="xrai-new-thread" title="New thread">+</button>' +
          '</div>' +
          '<div class="xrai-threads-list" id="xrai-threads"></div>' +
        '</section>' +
        '<section class="xrai-sec xrai-chat" id="xrai-chat">' +
          '<div class="xrai-sec-hd">CONVERSATION</div>' +
          '<div class="xrai-messages" id="xrai-messages"></div>' +
          '<div class="xrai-composer">' +
            '<textarea id="xrai-input" rows="2" placeholder="Ask anything about this dashboard…"></textarea>' +
            '<div class="xrai-composer-row">' +
              '<span class="xrai-usage" id="xrai-usage"></span>' +
              '<button id="xrai-send" class="xrai-send">Ask</button>' +
            '</div>' +
          '</div>' +
        '</section>' +
      '</div>'
    );
  }

  // Show the rail (called when the user clicks the header / nav AI button).
  // We intentionally do NOT create a thread here — a new thread is only
  // persisted server-side when the user actually sends their first message.
  // Until then the composer shows an in-memory draft.
  function open() {
    if (!rail) return;
    rail.classList.remove('xrai-hidden');
    rail.classList.add('xrai-expanded');
    renderContext();
    loadThreads();
  }

  // Hide the rail. Entry buttons stay in place so the user can reopen it.
  function collapse() {
    if (!rail) return;
    rail.classList.remove('xrai-expanded');
    rail.classList.add('xrai-hidden');
  }

  var threadsExpanded = false;

  function wireExpandedEvents() {
    rail.querySelector('.xrai-collapse').onclick = collapse;
    rail.querySelector('.xrai-new-thread').onclick = function(e) {
      if (e && e.stopPropagation) e.stopPropagation();
      // "New thread" just resets the composer — nothing is created server-side
      // until the user actually sends. Mirrors how chat apps treat a blank tab.
      currentThreadId = null;
      messages = [];
      renderMessages();
      renderThreads();
    };
    var toggleBtn = rail.querySelector('#xrai-threads-toggle');
    if (toggleBtn) {
      toggleBtn.onclick = function() {
        threadsExpanded = !threadsExpanded;
        var sec = rail.querySelector('#xrai-threads-sec');
        if (sec) sec.classList.toggle('xrai-threads-collapsed', !threadsExpanded);
        toggleBtn.setAttribute('aria-expanded', String(threadsExpanded));
        renderThreads();
      };
    }
    rail.querySelector('#xrai-send').onclick = sendMessage;
    rail.querySelector('#xrai-input').addEventListener('keydown', function(e) {
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); sendMessage(); }
    });
    rail.addEventListener('click', function(e) {
      var el = e.target.closest('[data-act]');
      if (!el) return;
      var act = el.getAttribute('data-act');
      if (act === 'clear-ann') { clearAnnotations(); logAction('cleared annotations'); }
      else if (act === 'reset-view') { dispatchTool('resetView'); clearAnnotations(); logAction('reset view'); }
      else if (act === 'undo') { undo(); }
    });
  }

  function renderContext() {
    var sub = rail.querySelector('#xrai-sub');
    var ctxEl = rail.querySelector('#xrai-now-ctx');
    var quick = rail.querySelector('#xrai-now-quick');
    var scraped = null;
    try { scraped = scrapeDomContext(); } catch (e) { scraped = null; }
    if (registered && registered.title) sub.textContent = registered.title;
    else if (scraped && scraped.title) sub.textContent = scraped.title;
    if (registered && typeof registered.getContext === 'function') {
      try {
        var c = registered.getContext() || {};
        var bits = [];
        if (c.visible) bits.push(c.visible.count + (c.visible.of ? ' of ' + c.visible.of : '') + ' records');
        if (c.filters && c.filters.range) bits.push(c.filters.range);
        ctxEl.textContent = bits.join(' · ') || 'Dashboard context loaded.';
      } catch (e) {
        ctxEl.textContent = 'Dashboard context unavailable.';
      }
    } else if (scraped) {
      var sbits = [];
      if (scraped.kpis && scraped.kpis.length) sbits.push(scraped.kpis.length + ' metrics');
      if (scraped.tables && scraped.tables.length) {
        var rc = scraped.tables.reduce(function(a, t) { return a + (t.rowCount || 0); }, 0);
        if (rc) sbits.push(rc + ' rows');
        else sbits.push(scraped.tables.length + ' table' + (scraped.tables.length === 1 ? '' : 's'));
      }
      if (scraped.filters && scraped.filters.length) sbits.push(scraped.filters.length + ' filters');
      ctxEl.textContent = sbits.length ? ('Scanning ' + sbits.join(' · ')) : 'Reading the dashboard…';
    } else {
      ctxEl.textContent = 'Dashboard context unavailable.';
    }
    // Quick prompts — dashboard-provided, or sensible defaults so the user
    // always has a one-click starting point (even if the dashboard hasn't
    // registered yet or didn't supply any suggestedPrompts).
    quick.innerHTML = '';
    var sp = (registered && registered.suggestedPrompts) || [];
    if (!sp.length) {
      sp = [
        'What is on this dashboard?',
        'Summarize the top rows',
        'What should I pay attention to?'
      ];
    }
    sp.slice(0, 4).forEach(function(p) {
      var b = document.createElement('button');
      b.className = 'xrai-quick-btn';
      b.textContent = p;
      b.onclick = function() {
        var inp = rail.querySelector('#xrai-input');
        if (inp) inp.value = p;
        sendMessage();
      };
      quick.appendChild(b);
    });
    updateUsageLabel();
    updateAnnToolbar();
  }

  function updateUsageLabel() {
    var el = rail.querySelector && rail.querySelector('#xrai-usage');
    if (!el || !usage) return;
    el.textContent = usage.remaining + ' / ' + usage.cap + ' messages left today';
  }

  function updateAnnToolbar() {
    var tb = rail.querySelector && rail.querySelector('#xrai-ann-toolbar');
    if (!tb) return;
    tb.style.display = annotations.length > 0 || undoStack.length > 0 ? '' : 'none';
  }

  // ── Threads ────────────────────────────────────────────────────────────────
  function loadThreads() {
    if (!currentContext || !currentContext.available) return;
    return apiFetch('/api/ai/threads?dashboardId=' + encodeURIComponent(dashboardId))
      .then(function(r) {
        if (!r.ok) return;
        threads = r.data || [];
        renderThreads();
      });
  }

  function renderThreads() {
    var el = rail.querySelector && rail.querySelector('#xrai-threads');
    if (!el) return;
    var countEl = rail.querySelector('#xrai-threads-count');
    if (countEl) countEl.textContent = threads.length ? '· ' + threads.length : '';
    el.innerHTML = '';
    if (threads.length === 0) {
      // Hide the empty-state in collapsed mode — the "+" button is enough of a hint.
      if (threadsExpanded) {
        el.innerHTML = '<div class="xrai-empty">No threads yet. Ask a question to start one.</div>';
      }
      return;
    }
    // Collapsed: show the most-recent one (or the active one if pinned by the user).
    var visibleThreads = threads;
    if (!threadsExpanded) {
      var pick = threads[0];
      if (currentThreadId) {
        for (var ti = 0; ti < threads.length; ti++) {
          if (threads[ti].id === currentThreadId) { pick = threads[ti]; break; }
        }
      }
      visibleThreads = [pick];
    }
    visibleThreads.forEach(function(t) {
      var row = document.createElement('div');
      row.className = 'xrai-thread-row' + (t.id === currentThreadId ? ' active' : '');
      row.innerHTML =
        '<span class="xrai-thread-title">' + escapeHtml(t.title) + '</span>' +
        '<span class="xrai-thread-date" title="' + escapeHtml(new Date(t.created_at).toLocaleString()) + '">' +
          escapeHtml(relativeTime(t.created_at)) +
        '</span>' +
        '<button class="xrai-thread-x" title="Archive">×</button>';
      row.onclick = function(e) {
        if (e.target.classList.contains('xrai-thread-x')) {
          if (confirm('Archive this thread?')) {
            apiFetch('/api/ai/threads/' + t.id, { method: 'DELETE' }).then(loadThreads);
          }
          return;
        }
        switchToThread(t.id);
      };
      el.appendChild(row);
    });
  }

  function createThread(title) {
    return apiFetch('/api/ai/threads', {
      method: 'POST',
      body: JSON.stringify({ dashboardId: dashboardId, title: title || 'New thread' })
    }).then(function(r) {
      if (!r.ok) return null;
      currentThreadId = r.data.id;
      messages = [];
      renderMessages();
      return loadThreads();
    });
  }

  function switchToThread(id) {
    currentThreadId = id;
    renderThreads();
    return apiFetch('/api/ai/threads/' + id + '/messages').then(function(r) {
      if (!r.ok) return;
      messages = r.data || [];
      renderMessages();
    });
  }

  // ── Messages ───────────────────────────────────────────────────────────────
  function renderMessages() {
    var el = rail.querySelector && rail.querySelector('#xrai-messages');
    if (!el) return;
    el.innerHTML = '';
    messages.forEach(function(m) {
      var row = document.createElement('div');
      row.className = 'xrai-msg xrai-msg-' + m.role;
      row.setAttribute('data-msg-id', m.id || '');
      row.innerHTML = renderMessageBody(m);
      el.appendChild(row);
    });
    wireMessageToolClicks(el);
    el.scrollTop = el.scrollHeight;
  }

  function renderMessageBody(m) {
    // Strip any trailing ```xray-actions``` block from the visible text — the
    // user sees a clean answer; actions are already executed.
    var text = (m.content || '').replace(/```xray-actions[\s\S]*?```/g, '').trim();
    var body = '<div class="xrai-msg-body">' + mdEscape(text) + '</div>';
    if (m.role !== 'assistant') return body;

    // Tools row: thumbs up, thumbs down, pin. Highlight the active rating if set.
    var isUp   = m.rating ===  1;
    var isDown = m.rating === -1;
    var disabled = m.pending || !m.id || String(m.id).indexOf('tmp-') === 0;
    var d = disabled ? ' disabled' : '';
    return body +
      '<div class="xrai-msg-tools">' +
        '<button class="xrai-msg-rate' + (isUp ? ' active up' : '') + '" data-rate="1" data-msg="' + (m.id || '') + '" title="Helpful"' + d + '>' +
          '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M7 11v9H3v-9zM7 11l4-8a2 2 0 0 1 3.6 1.2L13 11h6a2 2 0 0 1 2 2.3l-1.3 6a2 2 0 0 1-2 1.7H7"/></svg>' +
        '</button>' +
        '<button class="xrai-msg-rate' + (isDown ? ' active down' : '') + '" data-rate="-1" data-msg="' + (m.id || '') + '" title="Not helpful"' + d + '>' +
          '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M17 13V4h4v9zM17 13l-4 8a2 2 0 0 1-3.6-1.2L11 13H5a2 2 0 0 1-2-2.3l1.3-6a2 2 0 0 1 2-1.7H17"/></svg>' +
        '</button>' +
      '</div>';
  }

  function wireMessageToolClicks(scope) {
    // One delegated listener per render; the old nodes are gone on each re-render
    // so there's no double-binding.
    scope.addEventListener('click', function(e) {
      var rateBtn = e.target.closest('.xrai-msg-rate');
      if (rateBtn && !rateBtn.disabled) {
        var msgId = rateBtn.getAttribute('data-msg');
        var desired = parseInt(rateBtn.getAttribute('data-rate'), 10);
        if (!msgId || (desired !== 1 && desired !== -1)) return;
        var msg = findMessage(msgId);
        if (!msg) return;
        var current = msg.rating || 0;
        if (current === desired) {
          // Click same rating again → clear it
          submitFeedback(msgId, null);
        } else {
          submitFeedback(msgId, desired);
        }
        return;
      }
    });
  }

  function findMessage(id) {
    for (var i = 0; i < messages.length; i++) if (messages[i].id === id) return messages[i];
    return null;
  }

  function submitFeedback(messageId, rating) {
    var msg = findMessage(messageId);
    if (!msg) return;
    // Optimistic: flip local state then revert on failure
    var previous = msg.rating || null;
    msg.rating = rating;
    renderMessages();
    var promise;
    if (rating === null) {
      promise = apiFetch('/api/ai/messages/' + messageId + '/feedback', { method: 'DELETE' });
    } else {
      promise = apiFetch('/api/ai/messages/' + messageId + '/feedback', {
        method: 'POST',
        body: JSON.stringify({ rating: rating })
      });
    }
    promise.then(function(r) {
      if (!r.ok) {
        msg.rating = previous;
        renderMessages();
      }
    }).catch(function() {
      msg.rating = previous;
      renderMessages();
    });
  }

  function sendMessage() {
    var inp = rail.querySelector('#xrai-input');
    var sendBtn = rail.querySelector('#xrai-send');
    if (!inp || !sendBtn) return;
    var content = (inp.value || '').trim();
    if (!content) return;
    if (!currentThreadId) {
      createThread().then(function() { inp.value = content; sendMessage(); });
      return;
    }
    inp.value = '';
    inp.disabled = true;
    sendBtn.disabled = true;

    // Optimistic render the user's message
    messages.push({ id: 'tmp-u', role: 'user', content: content });
    // Assistant placeholder we'll stream into
    var pendingAsst = { id: 'tmp-a', role: 'assistant', content: '', pending: true };
    messages.push(pendingAsst);
    renderMessages();

    var ctx = safeGetContext();

    fetchSSE('/api/ai/threads/' + currentThreadId + '/messages', {
      content: content,
      context: ctx
    }, function(evt) {
      if (evt.type === 'delta') {
        pendingAsst.content += evt.text || '';
        // re-render just the last bubble, avoid full scroll-jitter
        var el = rail.querySelector('#xrai-messages');
        if (el && el.lastChild) {
          el.lastChild.innerHTML = renderMessageBody(pendingAsst);
          el.scrollTop = el.scrollHeight;
        }
      } else if (evt.type === 'limit') {
        pendingAsst.content = '_Daily message limit reached (' + evt.cap + '). Resets at midnight UTC._';
        renderMessages();
      } else if (evt.type === 'error') {
        pendingAsst.content = '_Error: ' + (evt.message || evt.code || 'Unknown') + '_';
        renderMessages();
      } else if (evt.type === 'done') {
        pendingAsst.id = evt.messageId;
        pendingAsst.pending = false;
        // Execute any xray-actions the assistant emitted
        if (Array.isArray(evt.actions)) {
          evt.actions.forEach(executeAction);
        }
        // refresh usage
        loadContext();
        // refresh threads (title may be auto-updated server-side later)
        loadThreads();
      }
    }, function() {
      inp.disabled = false;
      sendBtn.disabled = false;
      inp.focus();
    });
  }

  function safeGetContext() {
    var out = {
      dashboardId: dashboardId,
      title: (registered && registered.title) || '',
      schema: (registered && registered.schema) || null,
      elements: (registered && registered.elements) || null,
      suggestedPrompts: (registered && registered.suggestedPrompts) || null
    };
    if (registered && typeof registered.getContext === 'function') {
      try { out.context = registered.getContext(); } catch (e) { out.context = null; }
    }
    // Always scrape the DOM. If the dashboard registered, the scrape augments
    // getContext(); if it didn't, the scrape is the only context the AI has.
    try {
      var scraped = scrapeDomContext();
      if (scraped) {
        if (!out.title && scraped.title) out.title = scraped.title;
        out.context = Object.assign({}, scraped, out.context || {});
      }
    } catch (e) { /* scraping is best-effort */ }
    return out;
  }

  // Best-effort DOM scrape so the AI has real context even when the dashboard
  // author never called XRayAI.register(). Pulls title, active filters, KPI
  // cards, and the first rows of any visible table, plus a short text digest.
  function scrapeDomContext() {
    var MAX_KPIS = 24;
    var MAX_TABLES = 4;
    var MAX_ROWS = 20;
    var MAX_TEXT = 1200;

    function visible(el) {
      if (!el || !el.getBoundingClientRect) return false;
      var r = el.getBoundingClientRect();
      if (r.width < 2 || r.height < 2) return false;
      var s = window.getComputedStyle(el);
      return s.visibility !== 'hidden' && s.display !== 'none';
    }
    function isNoise(el) {
      // Tags whose text content is code/markup, not dashboard content.
      if (!el || !el.tagName) return false;
      var t = el.tagName;
      return t === 'SCRIPT' || t === 'STYLE' || t === 'NOSCRIPT' || t === 'TEMPLATE' || t === 'SVG' || t === 'PATH';
    }
    function text(el) {
      // Gather only human-readable text — skip <script>, <style>, etc. whose
      // textContent would otherwise dump CSS/JS source into the AI context.
      if (!el) return '';
      if (!el.ownerDocument || !el.ownerDocument.createTreeWalker) {
        return String(el.textContent || '').replace(/\s+/g, ' ').trim();
      }
      var parts = [];
      var walker = el.ownerDocument.createTreeWalker(
        el,
        NodeFilter.SHOW_TEXT,
        {
          acceptNode: function(n) {
            var p = n.parentNode;
            while (p && p !== el) {
              if (isNoise(p)) return NodeFilter.FILTER_REJECT;
              p = p.parentNode;
            }
            return NodeFilter.FILTER_ACCEPT;
          }
        },
        false
      );
      var n;
      while ((n = walker.nextNode())) parts.push(n.nodeValue);
      return parts.join(' ').replace(/\s+/g, ' ').trim();
    }
    function skip(el) {
      // Don't scrape the AI rail itself, and never descend into script/style.
      if (!el) return false;
      if (isNoise(el)) return true;
      return el.closest && (el.closest('.xrai-rail') || el.closest('.xrai-overlay'));
    }

    // Pick the most-specific visible container that represents the dashboard
    // the user is looking at. Fall back to <main>/body only when no dashboard
    // viewer is active. Order matters: prefer the active dash-fullview, then
    // any dedicated render root, then an iframe (share mode).
    var root = null;
    var candidates = [
      '.dash-fullview.active .dash-render-root',
      '.dash-fullview.active',
      '#dashboard-viewer.dash-fullview.active',
      '.dash-render-root',
      '[data-xray-dashboard-root]',
      'main.dashboard-main'
    ];
    for (var ci = 0; ci < candidates.length && !root; ci++) {
      var el = document.querySelector(candidates[ci]);
      if (el && visible(el)) root = el;
    }
    // Share-page iframe: scrape its document if same-origin.
    if (!root) {
      var iframe = document.querySelector('#share-content iframe');
      if (iframe) {
        try {
          var idoc = iframe.contentDocument;
          if (idoc && idoc.body) root = idoc.body;
        } catch (e) { /* cross-origin: skip */ }
      }
    }
    if (!root) root = document.querySelector('main') || document.body;
    if (!root) return null;

    // Title: prefer a visible top-level heading, fall back to document.title.
    var title = '';
    var headings = root.querySelectorAll('h1, h2');
    for (var i = 0; i < headings.length; i++) {
      if (skip(headings[i])) continue;
      if (visible(headings[i])) { title = text(headings[i]); break; }
    }
    if (!title) title = (document.title || '').trim();

    // Filters: selects + visible labelled inputs.
    var filters = [];
    var selects = root.querySelectorAll('select');
    for (var si = 0; si < selects.length && filters.length < 20; si++) {
      var s = selects[si];
      if (skip(s) || !visible(s)) continue;
      var lbl = '';
      if (s.id) {
        var lab = document.querySelector('label[for="' + s.id + '"]');
        if (lab) lbl = text(lab);
      }
      if (!lbl && s.getAttribute('aria-label')) lbl = s.getAttribute('aria-label');
      if (!lbl && s.name) lbl = s.name;
      var opt = s.options && s.options[s.selectedIndex];
      filters.push({ label: lbl || 'filter', value: (opt && text(opt)) || s.value || '' });
    }
    var inputs = root.querySelectorAll('input[type="text"], input[type="search"], input[type="number"], input:not([type])');
    for (var ii = 0; ii < inputs.length && filters.length < 30; ii++) {
      var inEl = inputs[ii];
      if (skip(inEl) || !visible(inEl) || !inEl.value) continue;
      var ilab = '';
      if (inEl.id) {
        var ll = document.querySelector('label[for="' + inEl.id + '"]');
        if (ll) ilab = text(ll);
      }
      if (!ilab && inEl.getAttribute('aria-label')) ilab = inEl.getAttribute('aria-label');
      if (!ilab && inEl.placeholder) ilab = inEl.placeholder;
      filters.push({ label: ilab || inEl.name || 'input', value: inEl.value });
    }

    // KPI cards: look for the common "label above a big number" pattern. We
    // pick any element whose text starts with a number/currency and whose
    // siblings include a short UPPERCASE label.
    var kpis = [];
    var bigNumRe = /^[\$€£¥]?\s*[-+]?[\d][\d,.]*\s*[%kKmMbB/hr\s]*$/;
    var candidates = root.querySelectorAll('div, span, p, strong, b');
    for (var k = 0; k < candidates.length && kpis.length < MAX_KPIS; k++) {
      var el = candidates[k];
      if (skip(el) || !visible(el)) continue;
      // Only leaf-ish elements (no big children with their own text)
      if (el.children.length > 2) continue;
      var t = text(el);
      if (!t || t.length > 24) continue;
      if (!bigNumRe.test(t)) continue;
      // Find a nearby label: previous sibling, aunt/uncle, or parent's first child.
      var label = '';
      var sib = el.previousElementSibling;
      if (sib && !skip(sib)) label = text(sib);
      if (!label && el.parentElement) {
        var pc = el.parentElement.children;
        for (var pi = 0; pi < pc.length; pi++) {
          if (pc[pi] === el) continue;
          var pt = text(pc[pi]);
          if (pt && pt.length < 40 && pt !== t) { label = pt; break; }
        }
      }
      if (!label) continue;
      // De-dupe by label+value
      var key = label + '=' + t;
      if (kpis.some(function(x) { return x._k === key; })) continue;
      kpis.push({ _k: key, label: label, value: t });
    }
    kpis.forEach(function(x) { delete x._k; });

    // Tables: headers + first N rows.
    var tables = [];
    var tabEls = root.querySelectorAll('table');
    for (var ti = 0; ti < tabEls.length && tables.length < MAX_TABLES; ti++) {
      var tb = tabEls[ti];
      if (skip(tb) || !visible(tb)) continue;
      var headCells = tb.querySelectorAll('thead th, thead td');
      var headers = [];
      for (var hi = 0; hi < headCells.length; hi++) headers.push(text(headCells[hi]));
      if (!headers.length) {
        var firstRow = tb.querySelector('tr');
        if (firstRow) {
          var fc = firstRow.children;
          for (var fi = 0; fi < fc.length; fi++) headers.push(text(fc[fi]));
        }
      }
      var bodyRows = tb.querySelectorAll('tbody tr');
      if (!bodyRows.length) bodyRows = tb.querySelectorAll('tr');
      var rows = [];
      for (var ri = 0; ri < bodyRows.length && rows.length < MAX_ROWS; ri++) {
        var cells = bodyRows[ri].children;
        if (!cells || !cells.length) continue;
        var row = [];
        for (var ci = 0; ci < cells.length; ci++) row.push(text(cells[ci]));
        // Skip header-only rows we already captured
        if (rows.length === 0 && headers.length && row.join('|') === headers.join('|')) continue;
        if (row.some(function(v) { return v; })) rows.push(row);
      }
      var total = bodyRows.length;
      tables.push({ headers: headers, rows: rows, rowCount: total });
    }

    // Short free-text digest (helps the AI see chart labels, captions, etc.)
    var digest = text(root);
    if (digest.length > MAX_TEXT) digest = digest.slice(0, MAX_TEXT) + '…';

    return {
      source: 'dom-scrape',
      title: title,
      url: location.pathname + location.search,
      filters: filters,
      kpis: kpis,
      tables: tables,
      textDigest: digest
    };
  }

  // SSE POST: we need to POST a body and read an event stream back. Browsers'
  // native EventSource only supports GET, so we use fetch + reader.
  function fetchSSE(url, body, onEvent, onEnd) {
    return fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'text/event-stream',
        'Authorization': 'Bearer ' + getToken()
      },
      body: JSON.stringify(body)
    }).then(function(resp) {
      if (!resp.body) { onEnd(); return; }
      var reader = resp.body.getReader();
      var decoder = new TextDecoder();
      var buf = '';
      function pump() {
        return reader.read().then(function(res) {
          if (res.done) { onEnd(); return; }
          buf += decoder.decode(res.value, { stream: true });
          var sep;
          while ((sep = buf.indexOf('\n\n')) >= 0) {
            var frame = buf.slice(0, sep);
            buf = buf.slice(sep + 2);
            var lines = frame.split('\n');
            var data = '';
            for (var i = 0; i < lines.length; i++) {
              if (lines[i].indexOf('data:') === 0) data += lines[i].slice(5).trim();
            }
            if (!data) continue;
            try { onEvent(JSON.parse(data)); } catch (e) { /* ignore */ }
          }
          return pump();
        });
      }
      return pump();
    }).catch(function() { onEnd(); });
  }

  // ── Action dispatcher: xray-actions emitted by the assistant ───────────────
  function executeAction(a) {
    if (!a || typeof a !== 'object' || !a.action) return;
    try {
      if (a.action === 'highlight') {
        highlight(a.target, a.params || {});
      } else if (a.action === 'clearAnnotations') {
        clearAnnotations();
      } else if (a.action === 'setFilter') {
        dispatchTool('setFilter', (a.params && a.params.name) || a.target, a.params && a.params.value);
      } else if (a.action === 'resetView') {
        dispatchTool('resetView');
      } else if (a.action === 'undo') {
        undo();
      } else if (a.action === 'getRecords') {
        // future: server round-trip tool
      }
    } catch (e) {
      console.warn('[XRayAI] action failed', a, e);
    }
    updateAnnToolbar();
  }

  function dispatchTool(name /*, ...args */) {
    if (registered && registered.tools && typeof registered.tools[name] === 'function') {
      var args = Array.prototype.slice.call(arguments, 1);
      try { return registered.tools[name].apply(null, args); } catch (e) {
        console.warn('[XRayAI] tool ' + name + ' threw', e);
      }
    } else {
      console.info('[XRayAI] dashboard did not implement tool: ' + name);
    }
  }

  // ── Annotations (SVG overlay; keyed by target+params) ──────────────────────
  function resolveElement(target, params) {
    if (!registered || !registered.elements) return null;
    var tmpl = registered.elements[target];
    if (!tmpl) return null;
    var sel = tmpl.replace(/\{(\w+)\}/g, function(_, k) { return params && params[k] != null ? params[k] : ''; });
    try { return document.querySelector(sel); } catch (e) { return null; }
  }

  function highlight(target, params) {
    var el = resolveElement(target, params);
    if (!el) return;
    var rect = el.getBoundingClientRect();
    var id = 'ann_' + (Date.now() + Math.floor(Math.random() * 1000));
    annotations.push({ id: id, target: target, params: params, note: params.note || '' });
    renderAnnotations();
    undoStack.push({ do: function() { annotations.push({ id: id, target: target, params: params, note: params.note || '' }); }, undo: function() { annotations = annotations.filter(function(a){ return a.id !== id; }); renderAnnotations(); } });
  }

  function clearAnnotations() {
    annotations = [];
    renderAnnotations();
    updateAnnToolbar();
  }

  function undo() {
    var op = undoStack.pop();
    if (op) op.undo();
    updateAnnToolbar();
  }

  function renderAnnotations() {
    if (!overlay) return;
    // Clear
    while (overlay.firstChild) overlay.removeChild(overlay.firstChild);
    annotations.forEach(function(a) {
      var el = resolveElement(a.target, a.params);
      if (!el) return;
      var r = el.getBoundingClientRect();
      var pad = 4;
      var rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
      rect.setAttribute('x', (r.left - pad));
      rect.setAttribute('y', (r.top - pad));
      rect.setAttribute('width', (r.width + pad * 2));
      rect.setAttribute('height', (r.height + pad * 2));
      rect.setAttribute('rx', '8');
      rect.setAttribute('fill', 'none');
      rect.setAttribute('stroke', '#3ee8b5');
      rect.setAttribute('stroke-width', '2');
      rect.setAttribute('stroke-dasharray', '6 4');
      overlay.appendChild(rect);
      if (a.note) {
        var labelGroup = document.createElementNS('http://www.w3.org/2000/svg', 'g');
        var tx = r.left - pad;
        var ty = r.top - pad - 8;
        var fo = document.createElementNS('http://www.w3.org/2000/svg', 'foreignObject');
        fo.setAttribute('x', tx);
        fo.setAttribute('y', ty - 20);
        fo.setAttribute('width', '220');
        fo.setAttribute('height', '28');
        fo.innerHTML = '<div xmlns="http://www.w3.org/1999/xhtml" class="xrai-note-badge">' + escapeHtml(a.note) + '</div>';
        labelGroup.appendChild(fo);
        overlay.appendChild(labelGroup);
      }
    });
  }

  // ── Utilities ──────────────────────────────────────────────────────────────
  // Compact relative time: "just now", "5m", "2h", "3d", then a short date.
  function relativeTime(iso) {
    if (!iso) return '';
    var d = new Date(iso);
    if (isNaN(d)) return '';
    var diffSec = Math.max(0, Math.floor((Date.now() - d.getTime()) / 1000));
    if (diffSec < 45) return 'just now';
    if (diffSec < 60 * 60) return Math.floor(diffSec / 60) + 'm';
    if (diffSec < 60 * 60 * 24) return Math.floor(diffSec / 3600) + 'h';
    if (diffSec < 60 * 60 * 24 * 7) return Math.floor(diffSec / 86400) + 'd';
    try {
      return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
    } catch (e) {
      return d.toISOString().slice(0, 10);
    }
  }

  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  // Minimal markdown renderer: headings, bold/italic, inline + fenced code,
  // links, bullet and numbered lists, blockquotes, paragraphs. No external
  // deps; escapes HTML first so assistant output can't inject markup.
  function mdEscape(s) {
    var src = String(s == null ? '' : s);

    // Pull fenced code blocks out first so their contents aren't touched by
    // inline rules. Placeholders get swapped back at the end.
    var codeBlocks = [];
    src = src.replace(/```([a-zA-Z0-9_-]*)\n?([\s\S]*?)```/g, function(_, lang, body) {
      var idx = codeBlocks.length;
      codeBlocks.push({ lang: lang || '', body: body.replace(/\n$/, '') });
      return '\u0000CB' + idx + '\u0000';
    });

    src = escapeHtml(src);

    // Inline code — do this before other inline rules so `*literal*` stays literal.
    var inlineCodes = [];
    src = src.replace(/`([^`\n]+)`/g, function(_, c) {
      var idx = inlineCodes.length;
      inlineCodes.push(c);
      return '\u0000IC' + idx + '\u0000';
    });

    // Build block-level output line by line.
    var lines = src.split('\n');
    var out = [];
    var i = 0;
    function isBlank(l) { return !l || /^\s*$/.test(l); }
    while (i < lines.length) {
      var line = lines[i];

      // Heading
      var h = /^(#{1,6})\s+(.*)$/.exec(line);
      if (h) {
        var level = h[1].length;
        out.push('<h' + level + ' class="xrai-md-h' + level + '">' + inline(h[2]) + '</h' + level + '>');
        i++; continue;
      }

      // Blockquote (fold consecutive > lines)
      if (/^\s*>/.test(line)) {
        var bq = [];
        while (i < lines.length && /^\s*>/.test(lines[i])) {
          bq.push(lines[i].replace(/^\s*>\s?/, ''));
          i++;
        }
        out.push('<blockquote class="xrai-md-bq">' + inline(bq.join(' ')) + '</blockquote>');
        continue;
      }

      // Unordered list
      if (/^\s*[-*+]\s+/.test(line)) {
        var items = [];
        while (i < lines.length && /^\s*[-*+]\s+/.test(lines[i])) {
          items.push(lines[i].replace(/^\s*[-*+]\s+/, ''));
          i++;
        }
        out.push('<ul class="xrai-md-ul">' + items.map(function(it) {
          return '<li>' + inline(it) + '</li>';
        }).join('') + '</ul>');
        continue;
      }

      // Ordered list
      if (/^\s*\d+\.\s+/.test(line)) {
        var nitems = [];
        while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) {
          nitems.push(lines[i].replace(/^\s*\d+\.\s+/, ''));
          i++;
        }
        out.push('<ol class="xrai-md-ol">' + nitems.map(function(it) {
          return '<li>' + inline(it) + '</li>';
        }).join('') + '</ol>');
        continue;
      }

      // Blank: skip
      if (isBlank(line)) { i++; continue; }

      // Paragraph: collect consecutive non-blank non-special lines
      var para = [line];
      i++;
      while (i < lines.length && !isBlank(lines[i]) &&
             !/^(#{1,6})\s+/.test(lines[i]) &&
             !/^\s*>/.test(lines[i]) &&
             !/^\s*[-*+]\s+/.test(lines[i]) &&
             !/^\s*\d+\.\s+/.test(lines[i]) &&
             lines[i].indexOf('\u0000CB') !== 0) {
        para.push(lines[i]);
        i++;
      }
      out.push('<p class="xrai-md-p">' + inline(para.join(' ')) + '</p>');
    }

    var html = out.join('');

    // Restore inline code
    html = html.replace(/\u0000IC(\d+)\u0000/g, function(_, n) {
      return '<code class="xrai-md-code">' + escapeHtml(inlineCodes[+n]) + '</code>';
    });
    // Restore fenced code blocks
    html = html.replace(/\u0000CB(\d+)\u0000/g, function(_, n) {
      var blk = codeBlocks[+n];
      var langCls = blk.lang ? ' data-lang="' + escapeHtml(blk.lang) + '"' : '';
      return '<pre class="xrai-md-pre"' + langCls + '><code>' + escapeHtml(blk.body) + '</code></pre>';
    });

    return html;

    // Inline rules: bold (** / __), italic (* / _), links, autolink, strike.
    // Applied to pre-escaped text.
    function inline(s) {
      // Links: [text](url) — sanitize the URL to avoid javascript: scheme.
      s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, function(_, t, u) {
        if (!/^(https?:|mailto:|\/|\.?\.\/)/i.test(u)) u = '#';
        return '<a class="xrai-md-a" href="' + u + '" target="_blank" rel="noopener noreferrer">' + t + '</a>';
      });
      // Bold: **x** or __x__
      s = s.replace(/(\*\*|__)([^\s*_][\s\S]*?[^\s*_]|[^\s*_])\1/g, '<strong>$2</strong>');
      // Italic: *x* or _x_ (kept simple; avoids eating list markers because
      // list lines were already consumed above)
      s = s.replace(/(^|[^\w*])\*([^\s*][^\n*]*?)\*(?!\w)/g, '$1<em>$2</em>');
      s = s.replace(/(^|[^\w_])_([^\s_][^\n_]*?)_(?!\w)/g, '$1<em>$2</em>');
      // Strikethrough
      s = s.replace(/~~([^~\n]+)~~/g, '<del>$1</del>');
      return s;
    }
  }

  function logAction(label) {
    // Placeholder for a small ephemeral toast in the rail
    var sub = rail.querySelector('#xrai-sub');
    if (sub) {
      var old = sub.textContent;
      sub.textContent = label;
      setTimeout(function() { sub.textContent = old; }, 1200);
    }
  }

  // Remove rail + overlay from the DOM and clear all per-dashboard state so
  // the SDK can be remounted against a different dashboard without leaking
  // UI or mixing conversation history.
  function teardown() {
    try { if (rail && rail.parentNode) rail.parentNode.removeChild(rail); } catch (e) {}
    try { if (overlay && overlay.parentNode) overlay.parentNode.removeChild(overlay); } catch (e) {}
    removeEntryButtons();
    rail = null;
    overlay = null;
    mounted = false;
    registered = null;
    undoStack = [];
    annotations = [];
    currentThreadId = null;
    threads = [];
    messages = [];
    usage = null;
    currentContext = null;
  }

  // Swap to a new dashboard: tear down the existing rail and re-mount against
  // the new dashboardId. If the id hasn't changed, no-op.
  function setDashboard(id) {
    if (!id || id === dashboardId) return;
    teardown();
    dashboardId = id;
    mount();
  }

  // Full dispose: tears the rail down AND releases the booted flag so the
  // next dashboard load re-runs the IIFE body cleanly (not just a setDashboard
  // swap). Called by app.js when the user navigates away from a dashboard.
  function dispose() {
    teardown();
    try { if (window.XRayAI) window.XRayAI._booted = false; } catch (e) {}
  }

  // ── Public API ─────────────────────────────────────────────────────────────
  // Capture anything the stub queued BEFORE we overwrite window.XRayAI with
  // the real API. The stub was installed by the server-injected prefix
  // script so dashboards could safely call XRayAI.register({...}) without
  // caring whether the SDK was loaded yet.
  var pendingRegistrations = (window.XRayAI && Array.isArray(window.XRayAI._pending))
    ? window.XRayAI._pending.slice()
    : [];

  window.XRayAI = {
    _booted: true,
    register: register,
    setDashboard: setDashboard,
    dispose: dispose,
    // Direct programmatic access (for dashboards that want to drive the rail)
    open: function() { open(); },
    close: function() { collapse(); },
    highlight: highlight,
    clearAnnotations: clearAnnotations,
    resetView: function() { dispatchTool('resetView'); clearAnnotations(); },
    undo: undo,
  };

  // Replay any queued register() calls so the dashboard's intent lands even
  // if its <script> ran before the SDK loaded.
  pendingRegistrations.forEach(function(cfg) {
    try { register(cfg); } catch (e) { console.warn('[XRayAI] replay register failed', e); }
  });

  // Mount as soon as DOM is ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', mount);
  } else {
    mount();
  }
})();
