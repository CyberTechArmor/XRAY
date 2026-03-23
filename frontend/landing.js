/* ── Landing page initialization ── */
(function(){
  // Skip landing page init on share pages
  if (window.location.pathname.match(/^\/share\/.+/)) return;
  var landing = document.getElementById('landing-screen');
  if (!landing) return;

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
    var forms = ['land-login','land-signup','land-setup','land-verify','land-tenant-picker'];
    for (var i=0;i<forms.length;i++) {
      var el = document.getElementById(forms[i]);
      if(el) el.style.display = forms[i] === 'land-'+name ? '' : 'none';
    }
  };

  /* ── Business Health Assessment ── */
  var ASSESS_QUESTIONS = [
    {id:'billing_process',pocket:'unbilled',section:'Getting paid for your work',question:'How do you make sure every completed job or visit gets invoiced?',options:[{label:'We have an automated system that flags unbilled work',score:0},{label:'Someone manually checks, but it\u2019s consistent',score:1},{label:'We try to stay on top of it, but things slip',score:2},{label:'Honestly, I\u2019m not confident everything gets billed',score:3}]},
    {id:'billing_gap',pocket:'unbilled',section:'Getting paid for your work',question:'In the last month, have you discovered work that was completed but never invoiced?',options:[{label:'No, never happens',score:0},{label:'Once or twice, small amounts',score:1},{label:'A few times, some were significant',score:2},{label:'Yes, and I suspect there\u2019s more I haven\u2019t caught',score:3}]},
    {id:'price_last_raised',pocket:'pricing',section:'Your pricing',question:'When did you last raise your prices or update your rate card?',options:[{label:'Within the last 6 months',score:0},{label:'About a year ago',score:1},{label:'18 months to 2 years ago',score:2},{label:'I can\u2019t remember \u2014 it\u2019s been a while',score:3}]},
    {id:'cost_awareness',pocket:'pricing',section:'Your pricing',question:'Have your costs (labor, materials, insurance, software) gone up since you last set prices?',options:[{label:'No, costs have been stable',score:0},{label:'Slightly, maybe 3-5%',score:1},{label:'Noticeably \u2014 payroll and materials are both up',score:2},{label:'Significantly \u2014 I feel the squeeze every month',score:3}]},
    {id:'margin_by_service',pocket:'pricing',section:'Your pricing',question:'Do you know which of your service lines is most profitable after labor costs?',options:[{label:'Yes, I track margin by service line regularly',score:0},{label:'I have a general sense but no exact numbers',score:1},{label:'I know revenue by service but not margin',score:2},{label:'Not really \u2014 I look at total revenue, not by service',score:3}]},
    {id:'labor_assignment',pocket:'labor',section:'How your team spends their time',question:'Do your highest-paid or most experienced people consistently work on your highest-margin jobs?',options:[{label:'Yes, we\u2019re intentional about matching skill to value',score:0},{label:'Usually, but scheduling sometimes overrides it',score:1},{label:'It\u2019s pretty random \u2014 whoever\u2019s available gets the job',score:2},{label:'I\u2019ve never thought about it that way',score:3}]},
    {id:'payroll_ratio',pocket:'labor',section:'How your team spends their time',question:'Do you know your total payroll as a percentage of revenue, and has it changed in the last year?',options:[{label:'Yes, I track it monthly and it\u2019s stable',score:0},{label:'I know the rough number but don\u2019t track the trend',score:1},{label:'I know total payroll but not the ratio',score:2},{label:'I\u2019d have to go look \u2014 I don\u2019t track this',score:3}]},
    {id:'customer_profitability',pocket:'customers',section:'Which customers make you money',question:'Can you name your three most profitable customers? Not biggest \u2014 most profitable after the time and effort they require.',options:[{label:'Yes, I know exactly who they are and why',score:0},{label:'I could guess based on revenue, but I haven\u2019t done the math',score:1},{label:'I know who pays the most, but some high-revenue clients are a lot of work',score:2},{label:'I honestly don\u2019t know which customers are profitable vs. just busy',score:3}]},
    {id:'customer_drain',pocket:'customers',section:'Which customers make you money',question:'Do you have any customers you suspect cost you more to serve than they\u2019re worth?',options:[{label:'No \u2014 we\u2019ve cleaned that up',score:0},{label:'Maybe one, but they\u2019re loyal so I keep them',score:1},{label:'A few come to mind \u2014 high maintenance, low margin',score:2},{label:'Yes, and I think about it often but haven\u2019t acted',score:3}]},
    {id:'utilization',pocket:'slots',section:'Capacity and scheduling',question:'On a typical week, what percentage of your available appointment slots, truck rolls, or billable hours are actually filled?',options:[{label:'85%+ \u2014 we\u2019re nearly full most weeks',score:0},{label:'70-85% \u2014 some gaps but generally busy',score:1},{label:'55-70% \u2014 noticeable downtime',score:2},{label:'I don\u2019t track this, but we have idle time',score:3}]},
    {id:'overtime_cause',pocket:'overtime',section:'Capacity and scheduling',question:'When you pay overtime, is it usually because of genuine demand or because jobs ran over or were scheduled poorly?',options:[{label:'Almost always real demand \u2014 we need the extra hours',score:0},{label:'Mostly demand, but some is avoidable',score:1},{label:'A mix \u2014 some weeks it\u2019s clearly a scheduling issue',score:2},{label:'A lot of it is preventable if we scheduled better',score:3}]},
    {id:'memberships',pocket:'memberships',section:'Recurring revenue',question:'Do you offer maintenance plans, memberships, retainers, or service contracts?',options:[{label:'No, we don\u2019t offer recurring plans',score:-1},{label:'Yes, and we actively manage renewals \u2014 retention is above 80%',score:0},{label:'Yes, but I\u2019m not sure how many have lapsed',score:2},{label:'Yes, and I know a lot have expired without follow-up',score:3}]},
    {id:'membership_followup',pocket:'memberships',section:'Recurring revenue',question:'When a membership or contract expires, what happens?',options:[{label:'We don\u2019t have memberships',score:-1},{label:'Automated renewal or immediate outreach',score:0},{label:'Someone is supposed to follow up, but it\u2019s inconsistent',score:2},{label:'Nothing \u2014 we don\u2019t have a system for that',score:3}]},
    {id:'rework_rate',pocket:'rework',section:'Callbacks and rework',question:'What percentage of jobs require a callback, redo, or return visit to fix an issue?',options:[{label:'Under 2% \u2014 very rare',score:0},{label:'3-5% \u2014 it happens but we manage it',score:1},{label:'5-10% \u2014 more than I\u2019d like',score:2},{label:'I don\u2019t track this, but callbacks happen regularly',score:3}]},
    {id:'rework_cost',pocket:'rework',section:'Callbacks and rework',question:'When a callback or rework happens, do you know what it costs you in labor?',options:[{label:'Yes, we track rework as a separate cost category',score:0},{label:'I have a rough idea',score:1},{label:'It just gets absorbed into normal payroll \u2014 I can\u2019t see it',score:2},{label:'No idea \u2014 it\u2019s invisible in our numbers',score:3}]},
    {id:'marketing_attribution',pocket:'marketing',section:'Marketing and lead tracking',question:'When a new customer calls or books, do you know which marketing channel brought them in?',options:[{label:'Yes \u2014 we track source on every lead',score:0},{label:'Sometimes \u2014 we ask \u201chow did you hear about us\u201d but don\u2019t always record it',score:1},{label:'Rarely \u2014 we run ads and get calls but can\u2019t connect the two',score:2},{label:'Never \u2014 I have no idea what\u2019s working',score:3}]},
    {id:'marketing_spend',pocket:'marketing',section:'Marketing and lead tracking',question:'How much do you spend on marketing monthly, and can you tie that spending to specific revenue?',options:[{label:'I know ROI by channel and cut what doesn\u2019t work',score:0},{label:'I know total spend but can only attribute some of it',score:1},{label:'I spend $3K-10K/month and hope it\u2019s working',score:2},{label:'I spend money on marketing because I feel like I should, but I can\u2019t prove it works',score:3}]},
    {id:'payment_terms',pocket:'latepay',section:'Getting paid on time',question:'What are your payment terms, and how long does it actually take customers to pay?',options:[{label:'Net 30, and most pay within 30 days',score:0},{label:'Net 30, but average is closer to 40-45 days',score:1},{label:'Net 30, but many pay at 50-60+ days',score:2},{label:'I don\u2019t really enforce terms \u2014 people pay when they pay',score:3}]},
    {id:'collections_process',pocket:'latepay',section:'Getting paid on time',question:'What happens when an invoice goes past due?',options:[{label:'Automated reminders at 30/60/90 days, then escalation',score:0},{label:'Someone sends a follow-up email or call, eventually',score:1},{label:'It depends on who notices \u2014 no consistent process',score:2},{label:'Honestly, some invoices just go cold and we write them off',score:3}]},
    {id:'revenue',pocket:'meta',section:'About your business',question:'What\u2019s your approximate annual revenue?',options:[{label:'Under $1.5 million',score:1},{label:'$1.5 \u2013 $2.5 million',score:2},{label:'$2.5 \u2013 $4 million',score:3},{label:'$4 \u2013 $6 million',score:4}]},
    {id:'systems',pocket:'meta',section:'About your business',question:'How many software systems do you use to run your business (accounting, scheduling, CRM, payroll, EHR, etc.)?',options:[{label:'1-2 \u2014 we keep it simple',score:1},{label:'3-4 \u2014 a few core tools',score:2},{label:'5-6 \u2014 it\u2019s a lot to manage',score:3},{label:'7+ \u2014 data is everywhere',score:4}]}
  ];

  var POCKET_CONFIG = {
    unbilled:{name:'Unbilled work',description:'Work completed but never invoiced',baseRange:[50000,150000],recoveryRate:[.4,.7]},
    pricing:{name:'Pricing erosion',description:'Prices haven\u2019t kept up with costs',baseRange:[50000,100000],recoveryRate:[.5,.8]},
    labor:{name:'Labor misallocation',description:'Best people on lowest-value work',baseRange:[40000,100000],recoveryRate:[.2,.4]},
    customers:{name:'Unprofitable customers',description:'Busy clients that don\u2019t make you money',baseRange:[40000,80000],recoveryRate:[.15,.35]},
    slots:{name:'Empty slots and idle hours',description:'Unfilled capacity nobody tracks',baseRange:[40000,80000],recoveryRate:[.25,.5]},
    memberships:{name:'Expired memberships',description:'Recurring revenue that quietly lapsed',baseRange:[30000,60000],recoveryRate:[.5,.7]},
    rework:{name:'Callbacks and rework',description:'Return visits you\u2019re eating the cost of',baseRange:[20000,50000],recoveryRate:[.3,.5]},
    marketing:{name:'Untracked marketing',description:'Ad spend you can\u2019t tie to revenue',baseRange:[20000,50000],recoveryRate:[.4,.6]},
    overtime:{name:'Scheduling overtime',description:'Overtime from bad scheduling, not demand',baseRange:[20000,40000],recoveryRate:[.5,.7]},
    latepay:{name:'Late-paying customers',description:'Cash stuck in receivables costing you money',baseRange:[15000,40000],recoveryRate:[.3,.5]}
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

    document.getElementById('assess-q-label').textContent = 'Question ' + num + ' of ' + total;
    document.getElementById('assess-q-pct').textContent = pct + '%';
    document.getElementById('assess-progress-fill').style.width = pct + '%';
    document.getElementById('assess-section-label').textContent = q.section;
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
    var revMultiplier = 1;
    var revAnswer = answers['revenue'];
    if (revAnswer === 0) revMultiplier = 0.5;
    else if (revAnswer === 1) revMultiplier = 0.7;
    else if (revAnswer === 2) revMultiplier = 1;
    else if (revAnswer === 3) revMultiplier = 1.5;

    // Calculate pocket scores
    var pocketScores = {}, pocketMaxScores = {};
    ASSESS_QUESTIONS.forEach(function(q) {
      if (q.pocket === 'meta') return;
      if (!pocketScores[q.pocket]) { pocketScores[q.pocket] = 0; pocketMaxScores[q.pocket] = 0; }
      var ansIdx = answers[q.id];
      if (ansIdx !== undefined) {
        var s = q.options[ansIdx].score;
        if (s >= 0) { pocketScores[q.pocket] += s; pocketMaxScores[q.pocket] += 3; }
      }
    });

    var pocketResults = Object.keys(pocketScores).map(function(key) {
      var score = pocketScores[key];
      var maxScore = pocketMaxScores[key] || 1;
      var severity = 0.5 + (score / maxScore) * 0.5;
      var cfg = POCKET_CONFIG[key];
      var scaledBase = [cfg.baseRange[0] * revMultiplier, cfg.baseRange[1] * revMultiplier];
      var pocketLow = scaledBase[0] * severity;
      var pocketHigh = scaledBase[1] * severity;
      var recoverableLow = pocketLow * cfg.recoveryRate[0];
      var recoverableHigh = pocketHigh * cfg.recoveryRate[1];
      return {
        key: key, name: cfg.name, description: cfg.description, severity: severity,
        score: score, maxScore: maxScore,
        pocketLow: Math.round(pocketLow), pocketHigh: Math.round(pocketHigh),
        recoverableLow: Math.round(recoverableLow), recoverableHigh: Math.round(recoverableHigh)
      };
    }).sort(function(a, b) { return b.severity - a.severity; });

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
    html += '<div class="assess-results-label">Assessment complete</div>';
    html += '<h2 class="assess-results-title">Your Business Health Results</h2>';
    html += '<p class="assess-results-sub">Based on your answers, here\u2019s where recoverable value is likely hiding in your business, and how much of it you could realistically get back.</p>';
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
      html += 'At the likely estimate of ' + fmt(totalRecoverableMid) + ', the recoverable value in your business is ' + roiMid + 'x the annual cost of working together. The 5x threshold is met \u2014 there\u2019s enough here to justify a deeper look.';
    } else {
      html += 'At the likely estimate of ' + fmt(totalRecoverableMid) + ', the recoverable value is ' + roiMid + 'x the annual cost. A discovery session would confirm whether the real numbers push past 5x \u2014 they often do once we connect the actual data.';
    }
    html += '</div>';

    // Top pockets
    if (topPockets.length > 0) {
      html += '<div class="assess-pocket-section">';
      html += '<h3 class="assess-pocket-heading">Where to look first</h3>';
      html += '<p class="assess-pocket-desc">Pockets with moderate or high likelihood based on your answers</p>';
      html += '<div class="assess-pocket-list">';
      topPockets.forEach(function(p) {
        var sc = sevClass(p.severity), st = sevText(p.severity);
        html += '<div class="assess-pocket-card">';
        html += '<div class="assess-pocket-top"><div><div class="assess-pocket-name">' + escHtml(p.name) + '</div><div class="assess-pocket-subdesc">' + escHtml(p.description) + '</div></div>';
        html += '<span class="assess-sev ' + sc + '">' + st + '</span></div>';
        html += '<div class="assess-pocket-nums"><div><span class="apn-label">Estimated pocket: </span><span class="apn-value">' + fmt(p.pocketLow) + ' \u2013 ' + fmt(p.pocketHigh) + '</span></div>';
        html += '<div><span class="apn-label">Realistic recovery: </span><span class="apn-value">' + fmt(p.recoverableLow) + ' \u2013 ' + fmt(p.recoverableHigh) + '</span></div></div>';
        html += '</div>';
      });
      html += '</div></div>';
    }

    // Low priority
    if (lowPockets.length > 0) {
      html += '<div class="assess-pocket-section">';
      html += '<h3 class="assess-pocket-heading">Looks healthier</h3>';
      html += '<p class="assess-pocket-desc">These areas look healthier based on your answers, but a discovery session may uncover more</p>';
      html += '<div class="assess-pocket-list">';
      lowPockets.forEach(function(p) {
        var sc = sevClass(p.severity), st = sevText(p.severity);
        html += '<div class="assess-low-row"><div><span class="assess-low-name">' + escHtml(p.name) + '</span>';
        html += '<span class="assess-low-range">' + (p.recoverableLow > 0 ? fmt(p.recoverableLow) + ' \u2013 ' + fmt(p.recoverableHigh) : 'Minimal') + '</span></div>';
        html += '<span class="assess-sev ' + sc + '">' + st + '</span></div>';
      });
      html += '</div></div>';
    }

    // Next steps
    html += '<div class="assess-next">';
    html += '<h3>What happens next</h3>';
    html += '<p>This assessment is directional \u2014 it tells you where to look, not exactly what you\u2019ll find. A $500 discovery session connects your actual data and confirms the numbers. If the confirmed value clears 5x the annual cost, we proceed and the $500 rolls into the build. If it doesn\u2019t, you keep the finding and the $500 is all you\u2019ve spent.</p>';
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
