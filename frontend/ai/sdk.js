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
  var pins = [];
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
  var rail, overlay, body, threadsList, messagesEl, pinsEl, composer, actionsLog;

  function mount() {
    if (mounted) return;
    mounted = true;

    // Rail container
    rail = document.createElement('div');
    rail.className = 'xrai-rail xrai-contracted';
    rail.innerHTML = contractedHtml();
    document.body.appendChild(rail);

    // SVG overlay for annotations (fixed so it tracks viewport)
    overlay = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    overlay.setAttribute('class', 'xrai-overlay');
    overlay.setAttribute('aria-hidden', 'true');
    document.body.appendChild(overlay);

    wireContractedEvents();

    // Re-check context availability + load threads lazily
    loadContext().then(function() {
      if (!currentContext || !currentContext.available) {
        // AI not available for this user/dashboard — hide rail entirely
        rail.style.display = 'none';
        overlay.style.display = 'none';
        return;
      }
      rail.style.display = '';
    });

    // Keep annotation positions in sync on scroll/resize
    var rr = null;
    function redraw() { clearTimeout(rr); rr = setTimeout(renderAnnotations, 16); }
    window.addEventListener('resize', redraw);
    window.addEventListener('scroll', redraw, { passive: true, capture: true });
  }

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
    loadPins();
  }

  // ── Contracted rail markup ─────────────────────────────────────────────────
  function contractedHtml() {
    return (
      '<button class="xrai-c-handle" title="Open AI"><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.5"><polyline points="15 6 9 12 15 18"/></svg></button>' +
      '<div class="xrai-c-stack">' +
        '<button class="xrai-c-btn xrai-c-ai" title="Open AI" data-act="open">' +
          '<span class="xrai-badge-dot"></span>' +
          '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M12 3l2.2 4.8L19 10l-4.8 2.2L12 17l-2.2-4.8L5 10l4.8-2.2z"/></svg>' +
        '</button>' +
        '<button class="xrai-c-btn" title="Quick ask" data-act="open">' +
          '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M21 12a8 8 0 1 1-3-6.2L21 3v6h-6"/></svg>' +
        '</button>' +
        '<button class="xrai-c-btn" title="Pins" data-act="open-pins">' +
          '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M12 2v6l-4 4h8l-4-4M12 22v-8"/></svg>' +
          '<span class="xrai-badge-count" data-count="pins">0</span>' +
        '</button>' +
      '</div>'
    );
  }

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
        '<section class="xrai-sec xrai-threads">' +
          '<div class="xrai-sec-hd">THREADS <button class="xrai-new-thread" title="New thread">+</button></div>' +
          '<div class="xrai-threads-list" id="xrai-threads"></div>' +
        '</section>' +
        '<section class="xrai-sec xrai-pins">' +
          '<div class="xrai-sec-hd">PINS</div>' +
          '<div class="xrai-pins-list" id="xrai-pins"></div>' +
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

  // ── Contracted events ──────────────────────────────────────────────────────
  function wireContractedEvents() {
    rail.addEventListener('click', function(e) {
      var btn = e.target.closest('[data-act]');
      if (!btn) return;
      var act = btn.getAttribute('data-act');
      if (act === 'open' || act === 'open-pins') {
        expand();
      }
    });
    var handle = rail.querySelector('.xrai-c-handle');
    if (handle) handle.onclick = expand;
  }

  function expand() {
    rail.classList.remove('xrai-contracted');
    rail.classList.add('xrai-expanded');
    rail.innerHTML = expandedHtml();
    wireExpandedEvents();
    renderContext();
    loadThreads();
    loadPins();
    if (!currentThreadId) createThreadIfNeeded();
  }

  function collapse() {
    rail.classList.remove('xrai-expanded');
    rail.classList.add('xrai-contracted');
    rail.innerHTML = contractedHtml();
    wireContractedEvents();
    updatePinBadge();
  }

  function wireExpandedEvents() {
    rail.querySelector('.xrai-collapse').onclick = collapse;
    rail.querySelector('.xrai-new-thread').onclick = function() { createThread(); };
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
    if (registered && registered.title) sub.textContent = registered.title;
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
    } else {
      ctxEl.textContent = 'Dashboard has not registered with XRayAI yet.';
    }
    // Quick prompts
    quick.innerHTML = '';
    var sp = (registered && registered.suggestedPrompts) || [];
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
    el.innerHTML = '';
    if (threads.length === 0) {
      el.innerHTML = '<div class="xrai-empty">No threads yet. Ask a question to start one.</div>';
      return;
    }
    threads.forEach(function(t) {
      var row = document.createElement('div');
      row.className = 'xrai-thread-row' + (t.id === currentThreadId ? ' active' : '');
      row.innerHTML = '<span>' + escapeHtml(t.title) + '</span>' +
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

  function createThreadIfNeeded() {
    if (threads.length > 0) return switchToThread(threads[0].id);
    return createThread();
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
        '<button class="xrai-msg-pin" data-pin="' + (m.id || '') + '" title="Pin"' + d + '>' +
          '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M12 2l2 6h6l-5 4 2 6-5-4-5 4 2-6-5-4h6z"/></svg>' +
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
      var pinBtn = e.target.closest('.xrai-msg-pin');
      if (pinBtn && !pinBtn.disabled) {
        var pinMsgId = pinBtn.getAttribute('data-pin');
        if (!pinMsgId) return;
        apiFetch('/api/ai/pins', {
          method: 'POST',
          body: JSON.stringify({ messageId: pinMsgId })
        }).then(function(r) {
          if (r.ok) loadPins();
        });
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
    if (!registered) return { dashboardId: dashboardId };
    var out = {
      dashboardId: dashboardId,
      title: registered.title || '',
      schema: registered.schema || null,
      elements: registered.elements || null,
      suggestedPrompts: registered.suggestedPrompts || null
    };
    if (typeof registered.getContext === 'function') {
      try { out.context = registered.getContext(); } catch (e) { out.context = null; }
    }
    return out;
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

  // ── Pins ───────────────────────────────────────────────────────────────────
  function loadPins() {
    if (!currentContext || !currentContext.available) return;
    return apiFetch('/api/ai/pins?dashboardId=' + encodeURIComponent(dashboardId))
      .then(function(r) {
        if (!r.ok) return;
        pins = r.data || [];
        renderPins();
        updatePinBadge();
      });
  }

  function renderPins() {
    var el = rail.querySelector && rail.querySelector('#xrai-pins');
    if (!el) return;
    el.innerHTML = '';
    if (pins.length === 0) {
      el.innerHTML = '<div class="xrai-empty">No pins yet.</div>';
      return;
    }
    pins.forEach(function(p) {
      var row = document.createElement('div');
      row.className = 'xrai-pin-row';
      row.innerHTML = '<div class="xrai-pin-text">' + escapeHtml((p.content || '').slice(0, 140)) + '</div>' +
        '<button data-unpin="' + p.pin_id + '" class="xrai-pin-x" title="Unpin">×</button>';
      el.appendChild(row);
    });
    el.onclick = function(e) {
      var un = e.target.closest('[data-unpin]');
      if (un) {
        apiFetch('/api/ai/pins/' + un.getAttribute('data-unpin'), { method: 'DELETE' }).then(loadPins);
      }
    };
  }

  function updatePinBadge() {
    var b = rail.querySelector && rail.querySelector('[data-count="pins"]');
    if (!b) return;
    b.textContent = String(pins.length);
    b.style.display = pins.length > 0 ? '' : 'none';
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
  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function mdEscape(s) {
    // Minimal: escape then convert newlines to <br>
    return escapeHtml(s).replace(/\n/g, '<br>');
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
    rail = null;
    overlay = null;
    mounted = false;
    registered = null;
    undoStack = [];
    annotations = [];
    currentThreadId = null;
    threads = [];
    messages = [];
    pins = [];
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
  window.XRayAI = {
    _booted: true,
    register: register,
    setDashboard: setDashboard,
    dispose: dispose,
    // Direct programmatic access (for dashboards that want to drive the rail)
    open: function() { if (mounted && rail && rail.classList.contains('xrai-contracted')) expand(); },
    close: function() { if (mounted && rail && rail.classList.contains('xrai-expanded')) collapse(); },
    highlight: highlight,
    clearAnnotations: clearAnnotations,
    resetView: function() { dispatchTool('resetView'); clearAnnotations(); },
    undo: undo,
  };

  // Mount as soon as DOM is ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', mount);
  } else {
    mount();
  }
})();
