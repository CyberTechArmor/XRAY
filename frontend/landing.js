/* ── Landing page initialization ── */
(function(){
  // Skip landing page init on share pages and the public legal pages.
  if (window.location.pathname.match(/^\/share\/.+/)) return;
  if (window.location.pathname.match(/^\/legal(\/|$)/)) return;
  var landing = document.getElementById('landing-screen');
  if (!landing) return;

  /* ── Step 11: cookie consent banner ──
   * GDPR-aligned slim bottom bar surfaced on every visit until the
   * user makes a choice. Three primary actions:
   *   - Accept all       — analytics + marketing + essential
   *   - Essential only   — essential cookies only (default-deny
   *                        non-essential)
   *   - Manage           — opens an inline panel with per-category
   *                        toggles + Save
   * Persists `xray_cookie_consent` to localStorage:
   *   { version: <cookie_policy version>, choices: {...},
   *     decided_at: ISO8601 }
   * Banner is suppressed when:
   *   - cookie_banner_enabled = 'false' in platform_settings (op
   *     fronts the site with a separate CMP)
   *   - the localStorage key already records a decision for the
   *     current cookie_policy version (re-prompt only on bumps)
   * Logged-in visits also POST /api/users/me/policy-accept; logged-
   * out visits store locally only (acceptance lands on signup
   * when the new account picks up the v1 default in the same
   * session).
   */
  (function initCookieBanner() {
    var STORAGE_KEY = 'xray_cookie_consent';
    var DEFAULT_CATEGORIES = { essential: true, analytics: false, marketing: false };
    fetch('/api/legal').then(function(r) { return r.json(); }).then(function(d) {
      if (!d || !d.ok || !d.data) return;
      var settings = d.data.settings || {};
      if (settings.cookie_banner_enabled === false) return;
      var policies = Array.isArray(d.data.policies) ? d.data.policies : [];
      var cookiePolicy = policies.find(function(p) { return p.slug === 'cookie_policy'; });
      var currentVersion = cookiePolicy ? cookiePolicy.version : 1;

      // Already-decided check — re-prompt only when the policy
      // version bumps so an operator pushing v2 of cookie_policy
      // can re-collect consent.
      var existing = null;
      try { existing = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null'); } catch (e) {}
      if (existing && existing.version === currentVersion) return;

      var initialEssentialOnly = !!settings.cookie_banner_essential_only_default;
      renderBanner(currentVersion, initialEssentialOnly);
    }).catch(function() {
      // /api/legal unreachable: best-effort fallback. Show the
      // banner with version=0 so the localStorage entry is at
      // least set; a future page load with a working API picks
      // up the bump and re-prompts.
      var existing = null;
      try { existing = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null'); } catch (e) {}
      if (existing) return;
      renderBanner(0, false);
    });

    function renderBanner(version, essentialOnlyDefault) {
      if (document.getElementById('cookie-banner')) return;
      var bar = document.createElement('div');
      bar.id = 'cookie-banner';
      bar.className = 'cookie-banner';
      bar.innerHTML = ''
        + '<div class="cookie-banner-inner">'
        +   '<div class="cookie-banner-text">'
        +     'We use cookies to make XRay work and, with your consent, to understand how it\'s used. '
        +     '<a href="/legal/cookie_policy" target="_blank" rel="noopener">Cookie policy</a>'
        +   '</div>'
        +   '<div class="cookie-banner-actions">'
        +     '<button type="button" class="cookie-btn" data-action="manage">Manage</button>'
        +     '<button type="button" class="cookie-btn" data-action="essential">Essential only</button>'
        +     '<button type="button" class="cookie-btn primary" data-action="accept-all">Accept all</button>'
        +   '</div>'
        + '</div>'
        + '<div class="cookie-manage-panel" id="cookie-manage-panel" style="display:none">'
        +   '<div class="cookie-cat"><label><input type="checkbox" disabled checked> <strong>Essential</strong> — required for sign-in, security, and basic site function. Always on.</label></div>'
        +   '<div class="cookie-cat"><label><input type="checkbox" id="cookie-cat-analytics"' + (essentialOnlyDefault ? '' : ' checked') + '> <strong>Analytics</strong> — usage stats so we can find broken pages.</label></div>'
        +   '<div class="cookie-cat"><label><input type="checkbox" id="cookie-cat-marketing"' + (essentialOnlyDefault ? '' : ' checked') + '> <strong>Marketing</strong> — ads attribution and re-targeting.</label></div>'
        +   '<div class="cookie-manage-foot"><button type="button" class="cookie-btn primary" data-action="save-manage">Save preferences</button></div>'
        + '</div>';
      document.body.appendChild(bar);

      bar.addEventListener('click', function(e) {
        var t = e.target.closest('button[data-action]');
        if (!t) return;
        var action = t.getAttribute('data-action');
        if (action === 'manage') {
          var panel = document.getElementById('cookie-manage-panel');
          panel.style.display = panel.style.display === 'none' ? '' : 'none';
          return;
        }
        if (action === 'accept-all') {
          decide(version, { essential: true, analytics: true, marketing: true });
          return;
        }
        if (action === 'essential') {
          decide(version, Object.assign({}, DEFAULT_CATEGORIES));
          return;
        }
        if (action === 'save-manage') {
          decide(version, {
            essential: true,
            analytics: !!document.getElementById('cookie-cat-analytics').checked,
            marketing: !!document.getElementById('cookie-cat-marketing').checked,
          });
          return;
        }
      });
    }

    function decide(version, choices) {
      var record = { version: version, choices: choices, decided_at: new Date().toISOString() };
      try { localStorage.setItem(STORAGE_KEY, JSON.stringify(record)); } catch (e) {}
      var bar = document.getElementById('cookie-banner');
      if (bar) bar.remove();
      // Logged-in visit (rare on the landing page): a same-origin
      // POST will succeed if api._fetch's CSRF cookie + bearer
      // are in place. We don't have direct access to the access
      // token from landing.js, so we rely on app.js exposing a
      // helper if it has one. Otherwise the acceptance lands on
      // signup completion via the v1 default seed path.
      if (typeof window.__xrayRecordCookieAcceptance === 'function') {
        try { window.__xrayRecordCookieAcceptance(version, choices); } catch (e) {}
      }
    }
  })();

  /* ── Modal open/close ── */
  window.openModal = function(form) {
    var overlay = document.getElementById('loginModal');
    overlay.classList.add('active');
    showLandingForm(form || 'login');
    setTimeout(function(){ var el = document.getElementById('land-login-email'); if(el) el.focus(); }, 300);
  };
  window.closeModal = function() {
    document.getElementById('loginModal').classList.remove('active');
  };
  document.addEventListener('keydown', function(e){ if(e.key==='Escape') closeModal(); });

  /* ── Show form within modal ── */
  window.showLandingForm = function(name) {
    var forms = ['land-login','land-signup','land-setup','land-verify','land-tenant-picker','land-totp'];
    for (var i=0;i<forms.length;i++) {
      var el = document.getElementById(forms[i]);
      if(el) el.style.display = forms[i] === 'land-'+name ? '' : 'none';
    }
  };

  /* ── Business Health Assessment ── */
  var ASSESS_QUESTIONS = [
    {id:'revenue',pocket:'meta',question:'What\u2019s your approximate annual revenue?',options:[{label:'Under $1.5 million',score:0,mult:0.5},{label:'$1.5 \u2013 $2.5 million',score:0,mult:0.7},{label:'$2.5 \u2013 $4 million',score:0,mult:1.0},{label:'$4 \u2013 $6 million',score:0,mult:1.5}]},
    {id:'billing',pocket:'unbilled',question:'How confident are you that every completed job gets invoiced?',options:[{label:'Very \u2014 we catch almost everything',score:1},{label:'Mostly \u2014 but things slip occasionally',score:1.5},{label:'Not very \u2014 I\u2019ve found missed invoices more than once',score:2.5},{label:'I honestly don\u2019t know what we\u2019re missing',score:3}]},
    {id:'pricing',pocket:'pricing',question:'Have you raised prices since your costs went up?',options:[{label:'Yes \u2014 we adjust regularly and margins are healthy',score:1},{label:'We raised prices, but I\u2019m not sure it covered the increase',score:1.5},{label:'Costs are up but our prices haven\u2019t changed',score:2.5},{label:'I don\u2019t know my margins by service line',score:3}]},
    {id:'visibility',pocket:'labor',question:'Could you tell me right now which customers and service lines are profitable \u2014 not biggest, but most profitable?',options:[{label:'Yes \u2014 I have a good handle on profitability',score:1},{label:'I have a general sense but no hard numbers',score:1.5},{label:'I know revenue, but not profit after labor',score:2.5},{label:'No \u2014 I look at total revenue and hope it works out',score:3}]},
    {id:'capacity',pocket:'slots',question:'How much of your available capacity \u2014 appointment slots, billable hours, truck rolls \u2014 is actually filled in a typical week?',options:[{label:'85%+ \u2014 we\u2019re nearly full most weeks',score:1},{label:'70\u201385% \u2014 busy but with gaps',score:1.5},{label:'Under 70% \u2014 noticeable downtime',score:2.5},{label:'I don\u2019t track this',score:3}]},
    {id:'recurring',pocket:'memberships',question:'Do you have maintenance plans, memberships, or retainers \u2014 and do you know how many have lapsed?',options:[{label:'We don\u2019t offer recurring plans',score:-1},{label:'Yes, and we stay on top of renewals \u2014 retention is strong',score:1},{label:'Yes, but I\u2019m not sure how many have quietly expired',score:2.5},{label:'Yes, and I know a lot have lapsed without follow-up',score:3}]},
    {id:'marketing',pocket:'marketing',question:'When a new customer contacts you, do you know which marketing brought them in?',options:[{label:'Yes \u2014 we track source on most leads',score:1},{label:'Sometimes \u2014 we ask but don\u2019t always record it',score:1.5},{label:'Rarely \u2014 we spend money on ads and hope they work',score:2.5},{label:'Never \u2014 I can\u2019t tie any marketing to revenue',score:3}]}
  ];

  var POCKET_CONFIG = {
    unbilled:{name:'Unbilled work',description:'Completed work that never became an invoice',baseRange:[50000,150000],recoveryRate:[.4,.7],rank:1},
    pricing:{name:'Pricing erosion',description:'Margins compressing because prices haven\u2019t kept up with costs',baseRange:[50000,100000],recoveryRate:[.5,.8],rank:2},
    labor:{name:'Profitability blind spots',description:'No visibility into which customers, jobs, or services actually make money',baseRange:[40000,100000],recoveryRate:[.2,.4],rank:3},
    slots:{name:'Unfilled capacity',description:'Gaps in scheduling that aren\u2019t being tracked or filled',baseRange:[40000,80000],recoveryRate:[.25,.5],rank:4},
    memberships:{name:'Lapsed recurring revenue',description:'Memberships or contracts that expired without follow-up',baseRange:[30000,60000],recoveryRate:[.5,.7],rank:5},
    marketing:{name:'Untracked marketing spend',description:'Money going to ads and channels with no way to measure what\u2019s working',baseRange:[20000,50000],recoveryRate:[.4,.6],rank:6}
  };

  var assessState = { currentQ: 0, answers: {}, started: false };

  function fmt(n) { return '$' + Math.round(n).toLocaleString(); }

  function escHtml(s) { var d = document.createElement('div'); d.textContent = s; return d.innerHTML; }

  window.startAssessment = function() {
    assessState = { currentQ: 0, answers: {}, started: true };
    document.getElementById('assess-intro').style.display = 'none';
    document.getElementById('assess-flow').style.display = '';
    document.getElementById('assess-results').style.display = 'none';
    renderQuestion();
  };

  window.assessBack = function() {
    if (assessState.currentQ > 0) {
      assessState.currentQ--;
      renderQuestion();
    }
  };

  function selectAnswer(optIdx) {
    var q = ASSESS_QUESTIONS[assessState.currentQ];
    assessState.answers[q.id] = optIdx;
    // Visual feedback
    var opts = document.querySelectorAll('.assess-opt');
    opts.forEach(function(o, i) {
      o.classList.toggle('selected', i === optIdx);
    });
    setTimeout(function() {
      if (assessState.currentQ < ASSESS_QUESTIONS.length - 1) {
        assessState.currentQ++;
        renderQuestion();
      } else {
        showResults();
      }
    }, 250);
  }

  function renderQuestion() {
    var q = ASSESS_QUESTIONS[assessState.currentQ];
    var total = ASSESS_QUESTIONS.length;
    var num = assessState.currentQ + 1;
    var pct = Math.round((num / total) * 100);

    document.getElementById('assess-q-label').textContent = num + ' of ' + total;
    document.getElementById('assess-q-pct').textContent = pct + '%';
    document.getElementById('assess-progress-fill').style.width = pct + '%';
    var sectionEl = document.getElementById('assess-section-label');
    if (sectionEl) sectionEl.textContent = q.section || '';
    if (sectionEl && !q.section) sectionEl.style.display = 'none';
    else if (sectionEl) sectionEl.style.display = '';
    document.getElementById('assess-question').textContent = q.question;

    var optHtml = '';
    for (var i = 0; i < q.options.length; i++) {
      var sel = assessState.answers[q.id] === i ? ' selected' : '';
      optHtml += '<button class="assess-opt' + sel + '" onclick="window.__assessSelect(' + i + ')">' + escHtml(q.options[i].label) + '</button>';
    }
    document.getElementById('assess-options').innerHTML = optHtml;
    document.getElementById('assess-back').style.display = assessState.currentQ > 0 ? '' : 'none';
  }

  window.__assessSelect = selectAnswer;

  function showResults() {
    document.getElementById('assess-flow').style.display = 'none';
    var container = document.getElementById('assess-results');
    container.style.display = '';

    var answers = assessState.answers;
    // Revenue multiplier from the mult property on the revenue question options
    var revMultiplier = 1;
    var revIdx = answers['revenue'];
    if (revIdx !== undefined) revMultiplier = ASSESS_QUESTIONS[0].options[revIdx].mult || 1;

    // Calculate per-pocket results
    var pocketResults = Object.keys(POCKET_CONFIG).map(function(key) {
      var cfg = POCKET_CONFIG[key];
      var q = ASSESS_QUESTIONS.filter(function(qq) { return qq.pocket === key; })[0];
      var aIdx = q ? answers[q.id] : undefined;
      var score = aIdx !== undefined ? q.options[aIdx].score : 1;
      if (score < 0) return null; // Skip excluded pockets (e.g. no memberships)
      var severity = 0.5 + (Math.min(score, 3) / 3) * 0.5;
      var pocketLow = cfg.baseRange[0] * revMultiplier * severity;
      var pocketHigh = cfg.baseRange[1] * revMultiplier * severity;
      var recoverableLow = Math.round(pocketLow * cfg.recoveryRate[0]);
      var recoverableHigh = Math.round(pocketHigh * cfg.recoveryRate[1]);
      return {
        key: key, name: cfg.name, description: cfg.description, severity: severity,
        rank: cfg.rank || 99,
        pocketLow: Math.round(pocketLow), pocketHigh: Math.round(pocketHigh),
        recoverableLow: recoverableLow, recoverableHigh: recoverableHigh
      };
    }).filter(function(p) { return p !== null; }).sort(function(a, b) { return b.severity - a.severity || a.rank - b.rank; });

    var totalRecoverableLow = 0, totalRecoverableHigh = 0;
    pocketResults.forEach(function(p) { totalRecoverableLow += p.recoverableLow; totalRecoverableHigh += p.recoverableHigh; });
    var totalRecoverableMid = Math.round((totalRecoverableLow + totalRecoverableHigh) / 2);

    var annualCost = 17000;
    var roiLow = (totalRecoverableLow / annualCost).toFixed(1);
    var roiMid = (totalRecoverableMid / annualCost).toFixed(1);
    var roiHigh = (totalRecoverableHigh / annualCost).toFixed(1);
    var clears5x = totalRecoverableMid >= annualCost * 5;

    var topPockets = pocketResults.filter(function(p) { return p.severity >= 0.72; });
    var lowPockets = pocketResults.filter(function(p) { return p.severity < 0.72; });

    function sevClass(s) {
      if (s >= 0.85) return 'high';
      if (s >= 0.72) return 'moderate';
      return 'low';
    }
    function sevText(s) {
      if (s >= 0.85) return 'High';
      if (s >= 0.72) return 'Moderate';
      return 'Low';
    }

    var html = '';
    // Header
    html += '<div class="assess-results-header">';
    html += '<div class="assess-results-label">Your results</div>';
    html += '<h2 class="assess-results-title">Here\u2019s what your business might be leaving on the table</h2>';
    html += '<p class="assess-results-sub">Estimated recoverable value based on your answers \u2014 what you could realistically get back, not the theoretical maximum.</p>';
    html += '</div>';

    // Summary cards
    html += '<div class="assess-summary">';
    html += '<div class="assess-summary-card"><div class="asc-label">Conservative</div><div class="asc-value">' + fmt(totalRecoverableLow) + '</div><div class="asc-roi">' + roiLow + 'x return</div></div>';
    html += '<div class="assess-summary-card primary"><div class="asc-label">Likely</div><div class="asc-value">' + fmt(totalRecoverableMid) + '</div><div class="asc-roi">' + roiMid + 'x return</div></div>';
    html += '<div class="assess-summary-card"><div class="asc-label">Optimistic</div><div class="asc-value">' + fmt(totalRecoverableHigh) + '</div><div class="asc-roi">' + roiHigh + 'x return</div></div>';
    html += '</div>';

    // Threshold
    html += '<div class="assess-threshold ' + (clears5x ? 'pass' : 'fail') + '">';
    if (clears5x) {
      html += 'The likely recoverable value of ' + fmt(totalRecoverableMid) + ' is ' + roiMid + 'x what an engagement costs annually. There\u2019s enough here to justify a deeper look at your data.';
    } else {
      html += 'The likely recoverable value of ' + fmt(totalRecoverableMid) + ' is ' + roiMid + 'x the annual cost. A discovery session would confirm whether the real numbers are higher once we connect your data.';
    }
    html += '</div>';

    // Top pockets (flagged)
    if (topPockets.length > 0) {
      html += '<div class="assess-pocket-section">';
      html += '<h3 class="assess-pocket-heading">Where to look first</h3>';
      html += '<p class="assess-pocket-desc">Highest-likelihood areas based on your answers</p>';
      html += '<div class="assess-pocket-list">';
      topPockets.forEach(function(p) {
        var sc = sevClass(p.severity), st = sevText(p.severity);
        html += '<div class="assess-pocket-card">';
        html += '<div class="assess-pocket-top"><div><div class="assess-pocket-name">' + escHtml(p.name) + '</div><div class="assess-pocket-subdesc">' + escHtml(p.description) + '</div></div>';
        html += '<span class="assess-sev ' + sc + '">' + st + '</span></div>';
        html += '<div class="assess-pocket-nums"><div><span class="apn-label">Realistic recovery: </span><span class="apn-value">' + fmt(p.recoverableLow) + ' \u2013 ' + fmt(p.recoverableHigh) + '</span></div></div>';
        html += '</div>';
      });
      html += '</div></div>';
    }

    // Healthier pockets
    if (lowPockets.length > 0) {
      html += '<div class="assess-pocket-section">';
      html += '<h3 class="assess-pocket-heading">Looks healthier</h3>';
      html += '<p class="assess-pocket-desc">Still worth validating \u2014 even well-run businesses have some leakage in these areas</p>';
      html += '<div class="assess-pocket-list">';
      lowPockets.forEach(function(p) {
        var sc = sevClass(p.severity), st = sevText(p.severity);
        html += '<div class="assess-low-row"><div><span class="assess-low-name">' + escHtml(p.name) + '</span>';
        html += '<span class="assess-low-range">' + fmt(p.recoverableLow) + ' \u2013 ' + fmt(p.recoverableHigh) + '</span></div>';
        html += '<span class="assess-sev ' + sc + '">' + st + '</span></div>';
      });
      html += '</div></div>';
    }

    // Next steps
    html += '<div class="assess-next">';
    html += '<h3>What happens next</h3>';
    html += '<p>This is directional \u2014 it tells you where to look, not exactly what you\u2019ll find. A $500 discovery session connects your actual data and confirms the numbers. If the confirmed value clears 5x the annual cost, we proceed and the $500 rolls into the build. If it doesn\u2019t, you keep the finding and that\u2019s all you\u2019ve spent.</p>';
    html += '</div>';

    // CTA
    html += '<div class="assess-cta">';
    html += '<button class="btn-set assess-set-btn" onclick="openModal(\'signup\')">';
    html += '<svg viewBox="0 0 36 36" fill="none"><g transform="translate(18,18)"><circle r="3" fill="#3ee8b5" class="icon-glow"/><path d="M-2.6,-4.5L-6.2,-10.7A12.4,12.4,0,0,1,6.2,-10.7L2.6,-4.5A5.2,5.2,0,0,0,-2.6,-4.5Z" fill="#3ee8b5" class="icon-glow" opacity=".9"/><path d="M-2.6,-4.5L-6.2,-10.7A12.4,12.4,0,0,1,6.2,-10.7L2.6,-4.5A5.2,5.2,0,0,0,-2.6,-4.5Z" fill="#3ee8b5" class="icon-glow" opacity=".9" transform="rotate(120)"/><path d="M-2.6,-4.5L-6.2,-10.7A12.4,12.4,0,0,1,6.2,-10.7L2.6,-4.5A5.2,5.2,0,0,0,-2.6,-4.5Z" fill="#3ee8b5" class="icon-glow" opacity=".9" transform="rotate(240)"/></g></svg>';
    html += 'Set it right';
    html += '</button>';
    html += '<p class="assess-cta-sub">Sign in to schedule your free consultation</p>';
    html += '</div>';

    // Retake
    html += '<button class="assess-retake" onclick="retakeAssessment()">Retake assessment</button>';

    container.innerHTML = html;
  }

  window.retakeAssessment = function() {
    assessState = { currentQ: 0, answers: {}, started: false };
    document.getElementById('assess-intro').style.display = '';
    document.getElementById('assess-flow').style.display = 'none';
    document.getElementById('assess-results').style.display = 'none';
  };

  /* ── Three.js hero scene ── */
  (function(){
    var canvas=document.getElementById('heroCanvas');
    if(!canvas) return;
    if(!window.THREE){canvas.parentElement.style.background='radial-gradient(ellipse at 50% 60%,rgba(52,211,153,0.05),transparent 70%)';return}
    var par=canvas.parentElement,W=par.clientWidth,H=par.clientHeight;
    var renderer=new THREE.WebGLRenderer({canvas:canvas,antialias:true,alpha:true});
    renderer.setSize(W,H);renderer.setPixelRatio(Math.min(window.devicePixelRatio,2));
    var scene=new THREE.Scene();
    var camera=new THREE.PerspectiveCamera(38,W/H,0.1,100);
    camera.position.set(0,3.2,6);camera.lookAt(0,-0.4,0);
    scene.add(new THREE.AmbientLight(0xffffff,0.12));
    function rr(ctx,x,y,w,h,r){ctx.beginPath();ctx.moveTo(x+r,y);ctx.lineTo(x+w-r,y);ctx.quadraticCurveTo(x+w,y,x+w,y+r);ctx.lineTo(x+w,y+h-r);ctx.quadraticCurveTo(x+w,y+h,x+w-r,y+h);ctx.lineTo(x+r,y+h);ctx.quadraticCurveTo(x,y+h,x,y+h-r);ctx.lineTo(x,y+r);ctx.quadraticCurveTo(x,y,x+r,y);ctx.closePath()}
    function drawSS(c,w,h){
      var x=c.getContext('2d');x.fillStyle='#0c0e14';x.fillRect(0,0,w,h);
      var cols=9,rows=18,cw=w/cols,rh=h/rows;
      x.strokeStyle='rgba(255,255,255,0.035)';x.lineWidth=1;
      for(var i=0;i<=cols;i++){x.beginPath();x.moveTo(i*cw,0);x.lineTo(i*cw,h);x.stroke()}
      for(var i=0;i<=rows;i++){x.beginPath();x.moveTo(0,i*rh);x.lineTo(w,i*rh);x.stroke()}
      x.fillStyle='rgba(255,255,255,0.04)';x.fillRect(0,0,w,rh);
      x.fillStyle='rgba(62,232,181,0.05)';x.fillRect(0,0,cw,h);
      var hdr=['','Date','Client','Rev','Cost','Margin','Hrs','Rate','Stat'];
      var fs=Math.round(w/75);
      x.font='600 '+fs+'px sans-serif';x.fillStyle='rgba(255,255,255,0.3)';
      for(var i=0;i<hdr.length;i++) x.fillText(hdr[i],i*cw+6,rh-Math.round(rh*.25));
      var data=[['1','03/01','Apex LLC','$4,200','$2,800','$1,400','24','$175','Active'],['2','03/03','BlueCo','$3,750','$2,100','$1,650','21','$179','Active'],['3','03/05','Vantage','$2,900','$1,900','$1,000','16','$181','Review'],['4','03/06','Peak Svc','$5,100','$3,200','$1,900','29','$176','Active'],['5','03/08','Meridian','$1,800','$1,200','$600','10','$180','Active'],['6','03/10','Crest Co','$4,500','$2,750','$1,750','25','$180','Active'],['7','03/12','Nova LLC','$3,200','$2,400','$800','18','$178','Review'],['8','03/14','Summit','$6,100','$3,800','$2,300','34','$179','Active'],['9','03/15','Prism','$2,400','$1,600','$800','13','$185','Active'],['10','03/17','Zenith','$3,900','$2,500','$1,400','22','$177','Active'],['11','03/18','Axiom','$4,800','$3,100','$1,700','27','$178','Active'],['12','03/19','Forge','$2,100','$1,400','$700','12','$175','Pending'],['13','03/20','Relay','$3,600','$2,200','$1,400','20','$180','Active'],['14','03/21','Caliber','$5,400','$3,400','$2,000','30','$180','Active'],['15','03/22','Vertex','$2,800','$1,900','$900','16','$175','Review'],['16','03/23','Bolt Co','$4,100','$2,600','$1,500','23','$178','Active'],['17','03/24','Pinion','$3,300','$2,100','$1,200','19','$174','Active']];
      x.font='300 '+Math.round(w/80)+'px sans-serif';
      for(var r=0;r<data.length;r++){
        for(var ci=0;ci<data[r].length;ci++){
          x.fillStyle=ci===0?'rgba(255,255,255,0.12)':ci>=3&&ci<=5?'rgba(255,255,255,0.25)':'rgba(255,255,255,0.18)';
          x.fillText(data[r][ci],ci*cw+6,(r+1)*rh+rh-Math.round(rh*.25));
        }
        if(data[r][8]==='Review'){x.fillStyle='rgba(232,132,90,0.06)';x.fillRect(cw,(r+1)*rh,w-cw,rh)}
      }
    }
    function drawDB(c,w,h){
      var x=c.getContext('2d');x.fillStyle='#0c0e14';x.fillRect(0,0,w,h);
      var P=Math.round(w*.02),G=Math.round(w*.01);
      var cw=(w-P*2-G*3)/4,ch=Math.round(h*.09);
      var fs1=Math.round(w/90),fs2=Math.round(w/50),fs3=Math.round(w/100);
      var metrics=[{l:'Revenue',v:'$142.8k',c:'+12.3%',clr:'#3ee8b5'},{l:'Avg margin',v:'34.2%',c:'+2.1pp',clr:'#3ee8b5'},{l:'Efficiency',v:'91%',c:'+5.4%',clr:'#5a9ee8'},{l:'Active clients',v:'47',c:'+3 this mo',clr:'#5a9ee8'}];
      for(var i=0;i<metrics.length;i++){
        var m=metrics[i],mx=P+i*(cw+G),my=P;
        x.fillStyle='rgba(255,255,255,0.025)';rr(x,mx,my,cw,ch,6);x.fill();
        x.strokeStyle='rgba(255,255,255,0.035)';rr(x,mx,my,cw,ch,6);x.stroke();
        x.font='300 '+fs1+'px sans-serif';x.fillStyle='rgba(255,255,255,0.3)';x.fillText(m.l,mx+10,my+ch*.28);
        x.font='600 '+fs2+'px sans-serif';x.fillStyle='#e0e1e5';x.fillText(m.v,mx+10,my+ch*.62);
        x.font='500 '+fs3+'px sans-serif';x.fillStyle=m.clr;x.fillText(m.c,mx+10,my+ch*.85);
      }
      var r2=P+ch+G,hw=(w-P*2-G)/2,cH=Math.round(h*.28);
      x.fillStyle='rgba(255,255,255,0.02)';rr(x,P,r2,hw,cH,6);x.fill();x.strokeStyle='rgba(255,255,255,0.03)';rr(x,P,r2,hw,cH,6);x.stroke();
      x.font='500 '+fs1+'px sans-serif';x.fillStyle='rgba(255,255,255,0.25)';x.fillText('Monthly revenue',P+12,r2+cH*.1);
      var bars=[.45,.6,.52,.72,.58,.8,.65,.78,.88,.72,.82,.95];
      for(var i=0;i<bars.length;i++){
        var bw=(hw-36)/bars.length,bh=bars[i]*(cH*.68),bx=P+18+i*bw,by=r2+cH-8-bh;
        x.fillStyle=i>=10?'rgba(62,232,181,0.5)':'rgba(62,232,181,0.18)';rr(x,bx,by,bw-2,bh,2);x.fill();
      }
      var dx=P+hw+G,dcx=dx+hw*.38,dcy=r2+cH*.55,dr=Math.min(hw,cH)*.28;
      x.fillStyle='rgba(255,255,255,0.02)';rr(x,dx,r2,hw,cH,6);x.fill();x.strokeStyle='rgba(255,255,255,0.03)';rr(x,dx,r2,hw,cH,6);x.stroke();
      x.font='500 '+fs1+'px sans-serif';x.fillStyle='rgba(255,255,255,0.25)';x.fillText('Revenue by source',dx+12,r2+cH*.1);
      var segs=[{p:.42,c:'rgba(62,232,181,0.6)'},{p:.28,c:'rgba(90,158,232,0.5)'},{p:.18,c:'rgba(232,132,90,0.5)'},{p:.12,c:'rgba(160,120,232,0.4)'}];
      var sA=-Math.PI/2;
      for(var i=0;i<segs.length;i++){var eA=sA+segs[i].p*Math.PI*2;x.beginPath();x.moveTo(dcx,dcy);x.arc(dcx,dcy,dr,sA,eA);x.closePath();x.fillStyle=segs[i].c;x.fill();sA=eA}
      x.beginPath();x.arc(dcx,dcy,dr*.55,0,Math.PI*2);x.fillStyle='#0c0e14';x.fill();
      x.font='600 '+Math.round(w/58)+'px sans-serif';x.fillStyle='#e0e1e5';x.textAlign='center';x.fillText('$142k',dcx,dcy+4);x.textAlign='start';
      var labels=[{t:'Services 42%',c:'rgba(62,232,181,0.7)'},{t:'Products 28%',c:'rgba(90,158,232,0.6)'},{t:'Consulting 18%',c:'rgba(232,132,90,0.6)'},{t:'Other 12%',c:'rgba(160,120,232,0.5)'}];
      x.font='300 '+fs3+'px sans-serif';
      for(var i=0;i<labels.length;i++){x.fillStyle=labels[i].c;x.fillText(labels[i].t,dcx+dr+14,dcy-dr*.4+i*Math.round(dr*.42))}
      var r3=r2+cH+G,cH2=Math.round(h*.22);
      x.fillStyle='rgba(255,255,255,0.02)';rr(x,P,r3,hw,cH2,6);x.fill();x.strokeStyle='rgba(255,255,255,0.03)';rr(x,P,r3,hw,cH2,6);x.stroke();
      x.font='500 '+fs1+'px sans-serif';x.fillStyle='rgba(255,255,255,0.25)';x.fillText('Margin vs cost trend',P+12,r3+cH2*.12);
      var lines=[{pts:[.35,.4,.38,.45,.48,.44,.52,.55,.5,.58,.62,.6,.65,.68],c:'rgba(62,232,181,0.7)',w:2},{pts:[.55,.52,.54,.48,.46,.5,.44,.42,.45,.4,.38,.4,.36,.34],c:'rgba(232,132,90,0.5)',w:1.5}];
      for(var li=0;li<lines.length;li++){var ln=lines[li];x.beginPath();x.strokeStyle=ln.c;x.lineWidth=ln.w;for(var i=0;i<ln.pts.length;i++){var lx=P+18+i/(ln.pts.length-1)*(hw-36),ly=r3+cH2-10-ln.pts[i]*(cH2-30);i===0?x.moveTo(lx,ly):x.lineTo(lx,ly)}x.stroke()}x.lineWidth=1;
      x.fillStyle='rgba(255,255,255,0.02)';rr(x,dx,r3,hw,cH2,6);x.fill();x.strokeStyle='rgba(255,255,255,0.03)';rr(x,dx,r3,hw,cH2,6);x.stroke();
      x.font='500 '+fs1+'px sans-serif';x.fillStyle='rgba(255,255,255,0.25)';x.fillText('Daily engagement',dx+12,r3+cH2*.12);
      var ap=[.2,.35,.3,.5,.45,.6,.55,.7,.65,.8,.6,.75,.85,.9,.72,.8,.88,.95,.82,.9];
      x.beginPath();for(var i=0;i<ap.length;i++){var ax=dx+14+i/(ap.length-1)*(hw-28),ay=r3+cH2-8-ap[i]*(cH2-30);i===0?x.moveTo(ax,ay):x.lineTo(ax,ay)}
      x.lineTo(dx+hw-14,r3+cH2-8);x.lineTo(dx+14,r3+cH2-8);x.closePath();x.fillStyle='rgba(90,158,232,0.08)';x.fill();
      x.beginPath();for(var i=0;i<ap.length;i++){var ax=dx+14+i/(ap.length-1)*(hw-28),ay=r3+cH2-8-ap[i]*(cH2-30);i===0?x.moveTo(ax,ay):x.lineTo(ax,ay)}
      x.strokeStyle='rgba(90,158,232,0.5)';x.lineWidth=1.5;x.stroke();x.lineWidth=1;
      var r4=r3+cH2+G,cH3=Math.round(h*.18);
      x.fillStyle='rgba(255,255,255,0.02)';rr(x,P,r4,hw,cH3,6);x.fill();x.strokeStyle='rgba(255,255,255,0.03)';rr(x,P,r4,hw,cH3,6);x.stroke();
      x.font='500 '+fs1+'px sans-serif';x.fillStyle='rgba(255,255,255,0.25)';x.fillText('Margin vs hours',P+12,r4+cH3*.14);
      var scatter=[[.1,.3],[.2,.5],[.25,.35],[.35,.6],[.4,.45],[.5,.7],[.55,.55],[.6,.8],[.65,.6],[.7,.75],[.75,.85],[.8,.7],[.85,.9],[.9,.65],[.95,.8]];
      for(var i=0;i<scatter.length;i++){var px=P+18+scatter[i][0]*(hw-36),py=r4+cH3-8-scatter[i][1]*(cH3-28);x.beginPath();x.arc(px,py,3.5,0,Math.PI*2);x.fillStyle=scatter[i][1]>.6?'rgba(62,232,181,0.6)':'rgba(62,232,181,0.2)';x.fill()}
      x.beginPath();x.moveTo(P+18,r4+cH3-8-.25*(cH3-28));x.lineTo(P+hw-18,r4+cH3-8-.82*(cH3-28));x.strokeStyle='rgba(62,232,181,0.25)';x.setLineDash([4,4]);x.stroke();x.setLineDash([]);
      var fullTH=h-r4-P;
      x.fillStyle='rgba(255,255,255,0.02)';rr(x,dx,r4,hw,fullTH,6);x.fill();x.strokeStyle='rgba(255,255,255,0.03)';rr(x,dx,r4,hw,fullTH,6);x.stroke();
      x.font='500 '+fs1+'px sans-serif';x.fillStyle='rgba(255,255,255,0.25)';x.fillText('Top performers',dx+12,r4+fullTH*.06);
      var tRows=[{n:'Summit',r:'$6,100',m:'37.7%',s:1},{n:'Caliber',r:'$5,400',m:'37.0%',s:.88},{n:'Peak Svc',r:'$5,100',m:'37.3%',s:.84},{n:'Crest Co',r:'$4,500',m:'38.9%',s:.74},{n:'Axiom',r:'$4,800',m:'35.4%',s:.79},{n:'Apex LLC',r:'$4,200',m:'33.3%',s:.69}];
      var rowH=Math.round(fullTH*.1);x.font='300 '+fs1+'px sans-serif';
      for(var i=0;i<tRows.length;i++){var tr=tRows[i],ry=r4+Math.round(fullTH*.12)+i*rowH;if(i===0){x.fillStyle='rgba(62,232,181,0.05)';x.fillRect(dx+6,ry-2,hw-12,rowH)}x.fillStyle=i===0?'rgba(62,232,181,0.6)':'rgba(255,255,255,0.2)';x.fillText(tr.n,dx+14,ry+rowH*.6);x.fillText(tr.r,dx+hw*.33,ry+rowH*.6);x.fillText(tr.m,dx+hw*.53,ry+rowH*.6);var bx2=dx+hw*.7,bW=hw*.24;x.fillStyle='rgba(255,255,255,0.025)';rr(x,bx2,ry+2,bW,rowH-6,2);x.fill();x.fillStyle=i===0?'rgba(62,232,181,0.3)':'rgba(62,232,181,0.12)';rr(x,bx2,ry+2,bW*tr.s,rowH-6,2);x.fill()}
    }
    var TW=1024,TH=768;
    var ssC=document.createElement('canvas');ssC.width=TW;ssC.height=TH;drawSS(ssC,TW,TH);
    var dbC=document.createElement('canvas');dbC.width=TW;dbC.height=TH;drawDB(dbC,TW,TH);
    var mkC=document.createElement('canvas');mkC.width=512;mkC.height=384;
    var mkX=mkC.getContext('2d');mkX.fillStyle='#000';mkX.fillRect(0,0,512,384);
    var ssTex=new THREE.CanvasTexture(ssC),dbTex=new THREE.CanvasTexture(dbC),mkTex=new THREE.CanvasTexture(mkC);
    var mat=new THREE.ShaderMaterial({
      uniforms:{tSS:{value:ssTex},tDB:{value:dbTex},tMask:{value:mkTex},flash:{value:0}},
      vertexShader:'varying vec2 vUv;void main(){vUv=uv;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0);}',
      fragmentShader:'uniform sampler2D tSS,tDB,tMask;uniform float flash;varying vec2 vUv;void main(){vec4 ss=texture2D(tSS,vUv);vec4 db=texture2D(tDB,vUv);float m=texture2D(tMask,vUv).r;vec4 c=mix(ss,db,m);c.rgb+=flash*vec3(0.12,0.9,0.65);gl_FragColor=c;}'
    });
    var pw=8,ph=pw*TH/TW;
    var plane=new THREE.Mesh(new THREE.PlaneGeometry(pw,ph),mat);
    var grp=new THREE.Group();grp.rotation.x=-0.48;grp.position.y=-1.8;grp.add(plane);scene.add(grp);
    var scan=new THREE.Group();
    var ew=2.8,eh=1.8,et=0.035;
    var eMat=new THREE.MeshBasicMaterial({color:0x3ee8b5});
    var edgeDefs=[{s:[ew,et,et],p:[0,eh/2,0]},{s:[ew,et,et],p:[0,-eh/2,0]},{s:[et,eh+et,et],p:[-ew/2,0,0]},{s:[et,eh+et,et],p:[ew/2,0,0]}];
    for(var i=0;i<edgeDefs.length;i++){var ed=edgeDefs[i];var em=new THREE.Mesh(new THREE.BoxGeometry(ed.s[0],ed.s[1],ed.s[2]),eMat);em.position.set(ed.p[0],ed.p[1],ed.p[2]);scan.add(em)}
    var gMat=new THREE.MeshBasicMaterial({color:0x3ee8b5,transparent:true,opacity:0.03,side:THREE.DoubleSide});
    scan.add(new THREE.Mesh(new THREE.PlaneGeometry(ew,eh),gMat));
    var cMat=new THREE.MeshBasicMaterial({color:0x3ee8b5,transparent:true,opacity:0.2});
    var corners=[[-1,1],[1,1],[-1,-1],[1,-1]];
    for(var ci=0;ci<corners.length;ci++){
      var cx=corners[ci][0]*(ew/2-.15),cy=corners[ci][1]*(eh/2-.15);
      var hm=new THREE.Mesh(new THREE.PlaneGeometry(.25,.004),cMat);hm.position.set(cx,cy,.01);scan.add(hm);
      var vm=new THREE.Mesh(new THREE.PlaneGeometry(.004,.25),cMat);vm.position.set(cx,cy,.01);scan.add(vm);
    }
    scan.position.z=.2;scan.visible=false;grp.add(scan);
    var sLight=new THREE.PointLight(0x3ee8b5,.6,3.5);sLight.position.set(0,0,.4);scan.add(sLight);
    var slMat=new THREE.MeshBasicMaterial({color:0x3ee8b5,transparent:true,opacity:.2});
    var scanLine=new THREE.Mesh(new THREE.PlaneGeometry(ew-.1,.008),slMat);scanLine.position.set(0,0,.02);scan.add(scanLine);
    var gridM=new THREE.LineBasicMaterial({color:0xffffff,transparent:true,opacity:.015});
    for(var i=-20;i<=20;i++){
      scene.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(i,-3.2,-20),new THREE.Vector3(i,-3.2,5)]),gridM));
      scene.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(-20,-3.2,i),new THREE.Vector3(20,-3.2,i)]),gridM));
    }
    var kf=[{t:0,x:-3.2,y:2.2},{t:.2,x:3.2,y:2.2},{t:.25,x:3.2,y:.7},{t:.45,x:-3.2,y:.7},{t:.5,x:-3.2,y:-.8},{t:.7,x:3.2,y:-.8},{t:.75,x:3.2,y:-2.3},{t:.95,x:-3.2,y:-2.3},{t:1,x:-3.2,y:-2.3}];
    function lkf(t){if(t<=0)return{x:kf[0].x,y:kf[0].y};if(t>=1)return{x:kf[kf.length-1].x,y:kf[kf.length-1].y};for(var i=0;i<kf.length-1;i++){if(t>=kf[i].t&&t<=kf[i+1].t){var p=(t-kf[i].t)/(kf[i+1].t-kf[i].t),e=p<.5?2*p*p:(1-Math.pow(-2*p+2,2)/2);return{x:kf[i].x+(kf[i+1].x-kf[i].x)*e,y:kf[i].y+(kf[i+1].y-kf[i].y)*e}}}return{x:0,y:0}}
    var CY=16,SS=1.2,SE=9.5,ZP=10,DE=14.5,t0=null;
    function anim(now){
      requestAnimationFrame(anim);if(!t0)t0=now;var el=((now-t0)/1000)%CY;
      if(el>=SS&&el<SE){
        scan.visible=true;var sp=(el-SS)/(SE-SS),pos=lkf(sp);
        scan.position.x=pos.x;scan.position.y=pos.y;
        scanLine.position.y=Math.sin(el*6)*eh*.35;
        var uvx=(pos.x+pw/2)/pw,uvy=1-(pos.y+ph/2)/ph,mw=130,mh=80;
        mkX.fillStyle='rgba(255,255,255,0.2)';mkX.fillRect(uvx*512-mw/2,uvy*384-mh/2,mw,mh);mkTex.needsUpdate=true;
        sLight.intensity=.5+Math.sin(el*8)*.12;
      }else if(el>=ZP&&el<ZP+.6){
        scan.visible=false;var zp=(el-ZP)/.6;mat.uniforms.flash.value=Math.max(0,1-zp*3);
        if(zp<.15){mkX.fillStyle='#fff';mkX.fillRect(0,0,512,384);mkTex.needsUpdate=true}
      }else if(el>=DE){
        var fp=Math.min(1,(el-DE)/(CY-DE));
        if(fp>0){mkX.fillStyle='rgba(0,0,0,'+fp*.12+')';mkX.fillRect(0,0,512,384);mkTex.needsUpdate=true}
        if(fp>=.95){mkX.fillStyle='#000';mkX.fillRect(0,0,512,384);mkTex.needsUpdate=true}
        mat.uniforms.flash.value=0;scan.visible=false;
      }else{mat.uniforms.flash.value=Math.max(0,mat.uniforms.flash.value-.01);scan.visible=el>=SS}
      grp.position.y=-1.8+Math.sin(now/1000*.35)*.04;
      grp.rotation.y=Math.sin(now/1000*.18)*.012;
      renderer.render(scene,camera);
    }
    requestAnimationFrame(anim);
    window.addEventListener('resize',function(){
      W=par.clientWidth;H=par.clientHeight;
      camera.aspect=W/H;camera.updateProjectionMatrix();renderer.setSize(W,H);
    });
  })();
})();
