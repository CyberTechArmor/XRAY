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
    var forms = ['land-login','land-signup','land-setup','land-verify'];
    for (var i=0;i<forms.length;i++) {
      var el = document.getElementById(forms[i]);
      if(el) el.style.display = forms[i] === 'land-'+name ? '' : 'none';
    }
  };

  /* ── Calculator ── */
  window.updateCalc = function(){
    var s=+document.getElementById('srcSlider').value;
    var d=+document.getElementById('dashSlider').value;
    var m=+document.getElementById('moSlider').value;
    document.getElementById('srcVal').textContent=s;
    document.getElementById('dashVal').textContent=d;
    document.getElementById('moVal').textContent=m;
    var connCost=s*500,dashCost=d*500,moCost=d<=5?500:1000;
    var total=connCost+dashCost+m*moCost;
    var maxRow=connCost+dashCost+moCost;
    var html='';
    for(var i=1;i<=m;i++){
      var rc=i===1?connCost:0,rd=i===1?dashCost:0,rowTotal=rc+rd+moCost;
      var pctC=maxRow>0?(rc/maxRow*100):0,pctD=maxRow>0?(rd/maxRow*100):0,pctM=maxRow>0?(moCost/maxRow*100):0;
      html+='<div class="bar-row"><div class="bar-label">Mo '+i+'</div><div class="bar-track">';
      if(rc) html+='<div class="bar-seg cn" style="width:'+pctC+'%">'+s+'&times;$500</div>';
      if(rd) html+='<div class="bar-seg da" style="width:'+pctD+'%">'+d+'&times;$500</div>';
      html+='<div class="bar-seg mo" style="width:'+pctM+'%">$'+moCost.toLocaleString()+'</div>';
      html+='</div><div class="bar-total">$'+rowTotal.toLocaleString()+'</div></div>';
    }
    document.getElementById('calcBars').innerHTML=html;
    document.getElementById('calcTotal').textContent='$'+total.toLocaleString();
    document.getElementById('calcNote').textContent=(d<=5?'$500/mo (1\u20135 dashboards)':'$1,000/mo (6\u201310 dashboards)')+'. Pause anytime.';
  };
  updateCalc();

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
