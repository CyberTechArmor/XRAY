#!/usr/bin/env python3
"""Step 11 follow-up: inject admin_policies view + nav entry into general.json."""
import json
from pathlib import Path

BUNDLE = Path('/home/user/XRAY/frontend/bundles/general.json')

ADMIN_POLICIES_HTML = """<div class='policies-view'>
  <div class='sec-title' style='margin-bottom:8px'>Legal policies</div>
  <p style='color:var(--t2);font-size:13px;margin:0 0 18px'>Versioned, append-only. Editing a published policy mints a new version and forces every signed-in user to re-accept on next page load.</p>
  <div id='pol-list' style='display:flex;flex-direction:column;gap:14px'>
    <div style='color:var(--t2);font-size:13px'>Loading…</div>
  </div>
</div>"""

ADMIN_POLICIES_CSS = """.policies-view .pol-card{background:var(--bg2);border:1px solid var(--bdr);border-radius:12px;overflow:hidden}
.policies-view .pol-head{display:flex;align-items:center;gap:14px;padding:14px 18px;cursor:pointer}
.policies-view .pol-head:hover{background:rgba(255,255,255,0.02)}
.policies-view .pol-title{flex:1;min-width:0}
.policies-view .pol-title-name{font-size:15px;font-weight:600;color:var(--t1)}
.policies-view .pol-title-meta{font-size:12px;color:var(--t2);margin-top:2px}
.policies-view .pol-flag{font-size:11px;font-weight:600;padding:2px 8px;border-radius:6px;background:rgba(245,158,11,0.15);color:#f59e0b}
.policies-view .pol-flag.req{background:rgba(62,232,181,0.12);color:var(--acc)}
.policies-view .pol-flag.opt{background:rgba(255,255,255,0.06);color:var(--t2)}
.policies-view .pol-flag-toggle{font-family:inherit;border:1px solid transparent;cursor:pointer;letter-spacing:0.06em;transition:border-color 0.15s,background-color 0.15s,color 0.15s}
.policies-view .pol-flag-toggle.req{border-color:rgba(62,232,181,0.35)}
.policies-view .pol-flag-toggle.req:hover{background:rgba(62,232,181,0.18);border-color:var(--acc)}
.policies-view .pol-flag-toggle.opt{border-color:rgba(255,255,255,0.12)}
.policies-view .pol-flag-toggle.opt:hover{background:rgba(255,255,255,0.10);color:var(--t1);border-color:rgba(255,255,255,0.25)}
.policies-view .pol-flag-toggle:disabled{cursor:wait}
.policies-view .pol-body{display:none;border-top:1px solid var(--bdr);padding:18px}
.policies-view .pol-body.open{display:block}
.policies-view .pol-versions{display:flex;flex-direction:column;gap:6px;margin-bottom:18px}
.policies-view .pol-version-row{display:flex;align-items:center;gap:12px;padding:10px 12px;background:var(--bg3);border:1px solid var(--bdr);border-radius:8px;font-size:13px}
.policies-view .pol-version-row .v{font-weight:600;color:var(--t1);min-width:48px}
.policies-view .pol-version-row .when{color:var(--t2);flex:1}
.policies-view .pol-version-row .count{color:var(--t2);font-size:12px}
.policies-view .pol-version-row a{color:var(--acc);text-decoration:none;font-size:12px}
.policies-view .pol-publish{display:grid;grid-template-columns:1fr 1fr;gap:14px}
.policies-view .pol-publish textarea{width:100%;min-height:280px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:13px;line-height:1.5;padding:12px 14px;background:var(--bg4);border:1px solid var(--bdr);border-radius:8px;color:var(--t1);resize:vertical;box-sizing:border-box}
.policies-view .pol-preview{min-height:280px;padding:16px 18px;background:var(--bg3);border:1px solid var(--bdr);border-radius:8px;font-size:14px;line-height:1.6;overflow-y:auto;max-height:520px}
.policies-view .pol-preview h1{font-size:22px;margin:18px 0 10px;color:var(--t1)}
.policies-view .pol-preview h2{font-size:18px;margin:16px 0 8px;color:var(--t1)}
.policies-view .pol-preview h3{font-size:15px;margin:14px 0 6px;color:var(--t1)}
.policies-view .pol-preview p{margin:0 0 12px;color:var(--t1)}
.policies-view .pol-preview ul,.policies-view .pol-preview ol{margin:0 0 12px;padding-left:22px}
.policies-view .pol-preview a{color:var(--acc)}
.policies-view .pol-preview code{background:rgba(255,255,255,0.06);padding:1px 5px;border-radius:3px;font-size:0.9em}
.policies-view .pol-preview hr{border:0;border-top:1px solid var(--bdr);margin:18px 0}
.policies-view .pol-publish-foot{grid-column:1/-1;display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.policies-view .pol-publish-foot label{display:flex;align-items:center;gap:6px;font-size:13px;color:var(--t2)}
.policies-view .pol-acceptors{margin-top:18px;border-top:1px solid var(--bdr);padding-top:18px}
.policies-view .pol-acceptors table{width:100%;border-collapse:collapse;font-size:13px}
.policies-view .pol-acceptors th,.policies-view .pol-acceptors td{padding:8px 10px;border-bottom:1px solid var(--bdr);text-align:left}
.policies-view .pol-acceptors th{color:var(--t3);font-weight:500;font-size:12px;text-transform:uppercase;letter-spacing:0.04em}
.policies-view .pol-status{font-size:12px;color:var(--t3);margin-left:8px}
@media(max-width:760px){.policies-view .pol-publish{grid-template-columns:1fr}}"""

ADMIN_POLICIES_JS = r"""function initAdminPolicies(container, api, user) {
  void user;
  var list = container.querySelector('#pol-list');
  if (!list) return;

  function escHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function(c) {
      return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]);
    });
  }

  // marked + DOMPurify from the same CDN the public /legal pages use.
  // Lazy-load both before any preview render so marked's HTML output
  // gets sanitized before innerHTML — marked v12 dropped its built-in
  // sanitize option, and an admin pasting `<script>` into body_md
  // would otherwise execute when they preview their own draft. Both
  // pinned versions; CDN failure falls back to plain-text rendering.
  function loadMarked(cb) {
    var needMarked = !(window.marked && typeof window.marked.parse === 'function');
    var needPurify = !(window.DOMPurify && typeof window.DOMPurify.sanitize === 'function');
    if (!needMarked && !needPurify) return cb();
    var pending = (needMarked ? 1 : 0) + (needPurify ? 1 : 0);
    function done() { if (--pending === 0) cb(); }
    function loadOnce(id, src) {
      var existing = document.getElementById(id);
      if (existing) { existing.addEventListener('load', done); existing.addEventListener('error', done); return; }
      var s = document.createElement('script');
      s.id = id; s.src = src; s.onload = done; s.onerror = done;
      document.head.appendChild(s);
    }
    if (needMarked) loadOnce('xray-marked-script', 'https://cdn.jsdelivr.net/npm/marked@12.0.2/marked.min.js');
    if (needPurify) loadOnce('xray-dompurify-script', 'https://cdn.jsdelivr.net/npm/dompurify@3.1.7/dist/purify.min.js');
  }

  function renderMd(target, md) {
    if (window.marked && typeof window.marked.parse === 'function'
        && window.DOMPurify && typeof window.DOMPurify.sanitize === 'function') {
      try {
        var raw = window.marked.parse(md || '', { breaks: false, gfm: true });
        target.innerHTML = window.DOMPurify.sanitize(raw);
        return;
      } catch (e) {}
    }
    var pre = document.createElement('pre');
    pre.style.cssText = 'white-space:pre-wrap;font-family:inherit;background:transparent;border:0;padding:0;margin:0';
    pre.textContent = md || '';
    target.innerHTML = ''; target.appendChild(pre);
  }

  function load() {
    list.innerHTML = '<div style="color:var(--t2);font-size:13px">Loading…</div>';
    api.get('/api/admin/policies').then(function(r) {
      if (!r.ok) {
        list.innerHTML = '<div style="color:#ef4444;font-size:13px">Failed to load: ' + escHtml((r.error && r.error.message) || 'unknown error') + '</div>';
        return;
      }
      var slugs = r.data || [];
      if (slugs.length === 0) {
        list.innerHTML = '<div style="color:var(--t2);font-size:13px">No policies yet. Migration 041 should have seeded six.</div>';
        return;
      }
      list.innerHTML = '';
      slugs.forEach(function(slug) { list.appendChild(renderSlugCard(slug)); });
    }).catch(function() {
      list.innerHTML = '<div style="color:#ef4444;font-size:13px">Network error loading policies.</div>';
    });
  }

  function renderSlugCard(slug) {
    var versions = slug.versions || [];
    var latest = versions[0] || { version: 0, title: '', is_required: false, is_placeholder: false, published_at: null, acceptance_count: 0 };
    var card = document.createElement('div');
    card.className = 'pol-card';
    var totalAcceptors = versions.reduce(function(a, v) { return a + (v.acceptance_count || 0); }, 0);
    var flagHtml = '';
    if (latest.is_placeholder) flagHtml += '<span class="pol-flag">PLACEHOLDER</span>';
    var reqClass = latest.is_required ? 'req' : 'opt';
    var reqLabel = latest.is_required ? 'REQUIRED' : 'OPTIONAL';
    flagHtml += '<button type="button" class="pol-flag pol-flag-toggle ' + reqClass + '" data-act="toggle-required" title="Click to ' + (latest.is_required ? 'mark optional' : 'mark required') + '">' + reqLabel + '</button>';
    card.innerHTML = ''
      + '<div class="pol-head" data-act="toggle">'
      +   '<div class="pol-title">'
      +     '<div class="pol-title-name">' + escHtml(latest.title || slug.slug) + ' <span style="color:var(--t3);font-weight:400;font-size:13px">' + escHtml(slug.slug) + '</span></div>'
      +     '<div class="pol-title-meta">v' + latest.version + ' · ' + (latest.published_at ? new Date(latest.published_at).toLocaleDateString() : 'never') + ' · ' + versions.length + ' version' + (versions.length === 1 ? '' : 's') + ' · ' + totalAcceptors + ' acceptor' + (totalAcceptors === 1 ? '' : 's') + '</div>'
      +   '</div>'
      +   '<div style="display:flex;align-items:center;gap:8px">' + flagHtml + '</div>'
      +   '<svg class="pol-chev" viewBox="0 0 24 24" width="16" height="16" stroke="currentColor" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="color:var(--t2);transition:transform 0.15s"><polyline points="6 9 12 15 18 9"/></svg>'
      + '</div>'
      + '<div class="pol-body" data-slug="' + escHtml(slug.slug) + '"></div>';

    var head = card.querySelector('.pol-head');
    var body = card.querySelector('.pol-body');
    var chev = card.querySelector('.pol-chev');
    var reqBtn = card.querySelector('[data-act="toggle-required"]');

    // Click on the REQUIRED/OPTIONAL badge toggles is_required without
    // bumping the policy version. Stops propagation so the click
    // doesn't also trigger the card-expand handler on .pol-head.
    if (reqBtn) {
      reqBtn.addEventListener('click', function(e) {
        e.stopPropagation();
        var nextRequired = !latest.is_required;
        reqBtn.disabled = true;
        reqBtn.style.opacity = '0.6';
        api.fetch
          ? null
          : null;
        // Use a manual fetch through the api wrapper so PATCH semantics
        // pass through the CSRF cookie + bearer token.
        var token = (window.__xrayGetAccessToken && window.__xrayGetAccessToken()) || '';
        var csrf = '';
        try { csrf = document.cookie.split(';').map(function(s){return s.trim();}).filter(function(s){return s.indexOf('xsrf_token=')===0;}).map(function(s){return decodeURIComponent(s.split('=')[1]||'');})[0] || ''; } catch(e) {}
        fetch('/api/admin/policies/' + encodeURIComponent(slug.slug), {
          method: 'PATCH',
          credentials: 'include',
          headers: Object.assign({ 'Content-Type': 'application/json' }, token ? { 'Authorization': 'Bearer ' + token } : {}, csrf ? { 'X-CSRF-Token': csrf } : {}),
          body: JSON.stringify({ is_required: nextRequired }),
        }).then(function(r) { return r.json(); }).then(function(d) {
          reqBtn.disabled = false;
          reqBtn.style.opacity = '';
          if (!d.ok) {
            console.warn('toggle is_required failed', d);
            return;
          }
          latest.is_required = !!d.data.is_required;
          // Mutate the slug summary as well so a card collapse + expand
          // doesn't reset the badge.
          if (slug.versions && slug.versions[0]) slug.versions[0].is_required = latest.is_required;
          reqBtn.classList.toggle('req', latest.is_required);
          reqBtn.classList.toggle('opt', !latest.is_required);
          reqBtn.textContent = latest.is_required ? 'REQUIRED' : 'OPTIONAL';
          reqBtn.title = 'Click to ' + (latest.is_required ? 'mark optional' : 'mark required');
          // Mirror into the body's Required checkbox if rendered.
          var cb = body.querySelector('[data-fld="is_required"]');
          if (cb) cb.checked = latest.is_required;
        }).catch(function() {
          reqBtn.disabled = false;
          reqBtn.style.opacity = '';
        });
      });
    }

    head.addEventListener('click', function() {
      var open = body.classList.toggle('open');
      chev.style.transform = open ? 'rotate(180deg)' : '';
      if (open && !body.getAttribute('data-rendered')) {
        renderSlugBody(body, slug);
        body.setAttribute('data-rendered', '1');
      }
    });
    return card;
  }

  function renderSlugBody(body, slug) {
    var versions = slug.versions || [];
    var latest = versions[0] || { title: '', body_md: '', is_required: false, version: 0 };

    var versionsHtml = '<div class="pol-versions">';
    versions.forEach(function(v) {
      versionsHtml += '<div class="pol-version-row">'
        + '<span class="v">v' + v.version + '</span>'
        + '<span class="when">' + escHtml(v.title) + ' · ' + (v.published_at ? new Date(v.published_at).toLocaleString() : '') + '</span>'
        + '<span class="count">' + (v.acceptance_count || 0) + ' acceptor' + (v.acceptance_count === 1 ? '' : 's') + '</span>'
        + '<a href="/legal/' + encodeURIComponent(slug.slug) + '/v/' + v.version + '" target="_blank" rel="noopener">View</a>'
        + '<a href="#" data-act="acceptors" data-slug="' + escHtml(slug.slug) + '" data-version="' + v.version + '">Acceptors</a>'
        + '</div>';
    });
    versionsHtml += '</div>';

    body.innerHTML = versionsHtml
      + '<div style="font-size:13px;font-weight:600;margin:0 0 10px;color:var(--t1)">Publish new version</div>'
      + '<p style="font-size:12px;color:var(--t2);margin:0 0 12px">Editing mints a new row at v' + ((latest.version || 0) + 1) + '. Every signed-in user will be forced to re-accept on next page load.</p>'
      + '<div class="pol-publish">'
      +   '<div>'
      +     '<div class="fg" style="margin-bottom:10px"><label style="font-size:12px;color:var(--t2);display:block;margin-bottom:4px">Title</label>'
      +       '<input type="text" data-fld="title" value="' + escHtml(latest.title || '') + '" style="width:100%;padding:10px 12px;font-size:14px;background:var(--bg4);border:1px solid var(--bdr);border-radius:8px;color:var(--t1);box-sizing:border-box"></div>'
      +     '<label style="font-size:12px;color:var(--t2);display:block;margin-bottom:4px">Body (markdown)</label>'
      +     '<textarea data-fld="body_md" placeholder="# Heading\n\nYour policy text…">' + escHtml(latest.body_md || '') + '</textarea>'
      +   '</div>'
      +   '<div>'
      +     '<div style="font-size:12px;color:var(--t2);margin-bottom:4px">Live preview</div>'
      +     '<div class="pol-preview" data-fld="preview"></div>'
      +   '</div>'
      +   '<div class="pol-publish-foot">'
      +     '<label><input type="checkbox" data-fld="is_required"' + (latest.is_required ? ' checked' : '') + '> Required (gates re-acceptance modal on bump)</label>'
      +     '<div style="flex:1"></div>'
      +     '<button class="btn primary" data-act="publish" data-slug="' + escHtml(slug.slug) + '">Publish v' + ((latest.version || 0) + 1) + '</button>'
      +     '<span class="pol-status" data-fld="status"></span>'
      +   '</div>'
      + '</div>'
      + '<div class="pol-acceptors" data-fld="acceptors-panel" style="display:none"></div>';

    var titleEl = body.querySelector('[data-fld="title"]');
    var bodyEl = body.querySelector('[data-fld="body_md"]');
    var previewEl = body.querySelector('[data-fld="preview"]');
    var reqEl = body.querySelector('[data-fld="is_required"]');
    var statusEl = body.querySelector('[data-fld="status"]');
    var publishBtn = body.querySelector('[data-act="publish"]');

    function refreshPreview() {
      loadMarked(function() { renderMd(previewEl, bodyEl.value); });
    }
    bodyEl.addEventListener('input', refreshPreview);
    refreshPreview();

    publishBtn.addEventListener('click', function() {
      var title = titleEl.value.trim();
      var body_md = bodyEl.value;
      var is_required = !!reqEl.checked;
      if (!title) { statusEl.textContent = 'Title required.'; statusEl.style.color = '#ef4444'; return; }
      if (!body_md) { statusEl.textContent = 'Body required.'; statusEl.style.color = '#ef4444'; return; }
      if (!confirm('Publish new version of "' + slug.slug + '"? Every signed-in user will be forced to re-accept on next page load.')) return;
      publishBtn.disabled = true;
      statusEl.style.color = 'var(--t2)';
      statusEl.textContent = 'Publishing…';
      api.post('/api/admin/policies/' + encodeURIComponent(slug.slug), { title: title, body_md: body_md, is_required: is_required })
        .then(function(r) {
          publishBtn.disabled = false;
          if (!r.ok) {
            statusEl.style.color = '#ef4444';
            statusEl.textContent = (r.error && r.error.message) || 'Publish failed.';
            return;
          }
          statusEl.style.color = 'var(--acc)';
          statusEl.textContent = 'Published v' + (r.data && r.data.version) + '.';
          // Reload the whole list so version counts + the slug's
          // new latest reflect immediately.
          setTimeout(load, 600);
        })
        .catch(function() {
          publishBtn.disabled = false;
          statusEl.style.color = '#ef4444';
          statusEl.textContent = 'Network error.';
        });
    });

    // Acceptors panel — lazy-loaded on click of any "Acceptors" link.
    body.addEventListener('click', function(e) {
      var t = e.target.closest('a[data-act="acceptors"]');
      if (!t) return;
      e.preventDefault();
      var slugName = t.getAttribute('data-slug');
      var version = t.getAttribute('data-version');
      var panel = body.querySelector('[data-fld="acceptors-panel"]');
      panel.style.display = '';
      panel.innerHTML = '<div style="color:var(--t2);font-size:13px">Loading acceptors for v' + escHtml(version) + '…</div>';
      api.get('/api/admin/policies/' + encodeURIComponent(slugName) + '/acceptances?version=' + encodeURIComponent(version) + '&limit=200').then(function(r) {
        if (!r.ok) {
          panel.innerHTML = '<div style="color:#ef4444;font-size:13px">Failed to load acceptors.</div>';
          return;
        }
        var rows = (r.data && r.data.data) || [];
        if (rows.length === 0) {
          panel.innerHTML = '<div style="color:var(--t2);font-size:13px">No acceptors recorded for v' + escHtml(version) + ' yet.</div>';
          return;
        }
        var html = '<div style="font-size:13px;color:var(--t1);margin:0 0 8px">Acceptors of v' + escHtml(version) + ' (' + (r.data.total || rows.length) + ')</div>';
        html += '<table><thead><tr><th>User</th><th>Email</th><th>Accepted</th></tr></thead><tbody>';
        rows.forEach(function(row) {
          html += '<tr><td>' + escHtml(row.user_name || '—') + '</td><td>' + escHtml(row.user_email || '—') + '</td><td>' + escHtml(new Date(row.accepted_at).toLocaleString()) + '</td></tr>';
        });
        html += '</tbody></table>';
        panel.innerHTML = html;
      }).catch(function() {
        panel.innerHTML = '<div style="color:#ef4444;font-size:13px">Network error loading acceptors.</div>';
      });
    });
  }

  load();
}"""


def main():
    b = json.loads(BUNDLE.read_text())
    # Add the new view
    b['views']['admin_policies'] = {
        'html': ADMIN_POLICIES_HTML,
        'css': ADMIN_POLICIES_CSS,
        'js': ADMIN_POLICIES_JS,
    }
    # Add nav entry under platform section, alongside admin_roles
    nav = b.get('nav', [])
    # insert just after admin_roles for grouping
    new_item = {
        'section': 'platform',
        'view': 'admin_policies',
        'label': 'Policies',
        'icon': 'shield',
        'permission': 'platform.admin',
    }
    # avoid duplicate if re-run
    nav = [n for n in nav if n.get('view') != 'admin_policies']
    insert_at = len(nav)
    for i, n in enumerate(nav):
        if n.get('view') == 'admin_roles':
            insert_at = i + 1
            break
    nav.insert(insert_at, new_item)
    b['nav'] = nav
    # Bump bundle version so the SPA cache busts
    b['version'] = '2026-04-26-step11-policies-ux2'

    BUNDLE.write_text(json.dumps(b, ensure_ascii=False))
    print('OK admin_policies view + nav entry injected')
    print('  view html:', len(ADMIN_POLICIES_HTML), 'css:', len(ADMIN_POLICIES_CSS), 'js:', len(ADMIN_POLICIES_JS))
    print('  bundle version:', b['version'])


if __name__ == '__main__':
    main()
