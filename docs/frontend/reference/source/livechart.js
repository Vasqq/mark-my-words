
/* ================= LiveChart: 60fps canvas chart with draggable target/stop handles =================
   Canvas draws history, zones and lines every frame; the price eases toward each new tick and the
   series scrolls continuously between ticks. Handles are DOM (focusable, draggable) positioned per frame. */
function seedLive(id){const m=MK[id];const r=rng(m.seed*5+3);const n=160;const out=[];let v=m.mark0*(1-m.chg/100*.6);for(let i=0;i<n;i++){const t=i/(n-1);v+=((m.mark0*(1-m.chg/100*.6*(1-t)))-v)*.07+(r()-.5)*m.mark0*.0028;out.push(v);}out[n-1]=m.mark0;return out;}
/* time ranges: Live is the scrolling tape; 1H/1D/1W are seeded walks that end at the live mark */
const TF={live:{label:'Live',n:160,ms:600},'1H':{label:'1H',n:120,ms:30e3,k:.12,vol:.0011},'1D':{label:'1D',n:144,ms:600e3,k:1,vol:.0026},'1W':{label:'1W',n:168,ms:3600e3,k:-1.6,vol:.0062}};
function tfChange(id,tf){return tf==='live'?null:MK[id].chg*TF[tf].k;}
function genRange(id,tf){const m=MK[id],t=TF[tf];const r=rng(m.seed*13+t.n);const n=t.n;const start=m.mark0/(1+tfChange(id,tf)/100);const w=[0];for(let i=1;i<n;i++)w.push(w[i-1]+(r()-.5)*2);
  const out=[];for(let i=0;i<n;i++){const u=i/(n-1);const br=w[i]-u*w[n-1];out.push((start+(m.mark0-start)*u)*(1+br*t.vol));}out[n-1]=m.mark0;return out;}
function tfTime(tf,ago,base){if(tf==='live')return ago<1?'now':`${Math.round(ago/1000)}s ago`;const d=new Date((base||Date.now())-ago);
  if(tf==='1W')return d.toLocaleString([], {weekday:'short',hour:'numeric'});return d.toLocaleTimeString([], {hour:'numeric',minute:'2-digit'});}
function LiveChart({market,mark,lv,pos,T:theme,onTarget,onStop,onAmend,layout,pnlAxis,tf='live'}){
  const m=MK[market];const wrap=useRef();const cv=useRef();const hT=useRef();const hS=useRef();const pT=useRef();const pS=useRef();const mk=useRef();const tip=useRef();
  const st=useRef({rng:{},hx:null,hist:{ETH:seedLive('ETH'),BTC:seedLive('BTC')},disp:mark,last:performance.now(),dom:null,drag:null,hover:null,W:800,H:500,t0:performance.now()});
  const P=useRef({});
  const {T,S,E,liq,q}=lv;const d=lv.side==='long'?1:-1;
  P.current={market,mark,T,S,E,liq,q,d,pos,onTarget,onStop,onAmend,theme,layout,m,pnlAxis,tf};
  // append each new tick
  useEffect(()=>{const s=st.current;const h=s.hist[market];h.push(mark);if(h.length>160)h.shift();s.last=performance.now();},[mark,market]);
  useEffect(()=>{st.current.disp=mark;st.current.dom=null;},[market]);useEffect(()=>{st.current.dom=null;},[tf]);
  useLayoutEffect(()=>{const ro=new ResizeObserver(([e])=>{const s=st.current;s.W=e.contentRect.width;s.H=e.contentRect.height;const dpr=Math.min(2,devicePixelRatio||1);cv.current.width=s.W*dpr;cv.current.height=s.H*dpr;cv.current.getContext('2d').setTransform(dpr,0,0,dpr,0,0);});ro.observe(wrap.current);return ()=>ro.disconnect();},[]);
  useEffect(()=>{let raf;const g=cv.current.getContext('2d');
    const frame=now=>{raf=requestAnimationFrame(frame);const s=st.current;const p=P.current;const th=p.theme;const L=p.layout(s.W,s.H);const W=s.W,H=s.H;
      s.disp+=(p.mark-s.disp)*(reduce?1:.12);
      const live=p.tf==='live';const TICK=600;let h,frac;
      if(live){h=s.hist[p.market];frac=reduce?0:Math.min(1,(now-s.last)/TICK);}else{const key=p.market+p.tf;const base=s.rng[key]||(s.rng[key]=genRange(p.market,p.tf));const k=s.disp/base[base.length-1];h=base.map(v=>v*k);frac=0;}
      const n=h.length;
      // domain
      const recent=live?h.slice(-120):h;const vals=[s.disp,p.T,p.S,p.E,...recent].filter(x=>x>0&&isFinite(x));let lo=Math.min(...vals),hi=Math.max(...vals);const pad=(hi-lo)*.1||p.mark*.02;lo-=pad;hi+=pad;
      if(!s.dom)s.dom=[lo,hi];if(!s.drag){s.dom[0]+=(lo-s.dom[0])*.1;s.dom[1]+=(hi-s.dom[1])*.1;}
      if(wrap.current){wrap.current.style.setProperty('--xr',L.xR+'px');wrap.current.style.setProperty('--nowx',L.nowX+'px');}const [y0,y1]=s.dom;const Y=v=>L.padT+(1-(v-y0)/(y1-y0))*(H-L.padT-L.padB);s.Y=Y;s.pOf=y=>y0+(1-(y-L.padT)/(H-L.padT-L.padB))*(y1-y0);s.L=L;
      g.clearRect(0,0,W,H);
      // grid + axis
      const span=y1-y0,raw=span/6,mag=Math.pow(10,Math.floor(Math.log10(raw))),stp=[1,2,2.5,5,10].map(x=>x*mag).find(x=>x>=raw);
      g.font=`500 10.5px ${th.mono}`;g.textAlign='right';
      for(let v=Math.ceil(y0/stp)*stp;v<y1;v+=stp){const y=Math.round(Y(v))+.5;g.strokeStyle=th.grid;g.lineWidth=1;g.beginPath();g.moveTo(0,y);g.lineTo(L.xR,y);g.stroke();g.fillStyle=th.axis;g.fillText('$'+v.toLocaleString('en-US',{maximumFractionDigits:0}),L.xR-6,y-5);
        if(p.pnlAxis&&p.q){const pl=p.d*p.q*(v-p.E);g.textAlign='left';g.fillStyle=pl>=0?th.gain:th.loss;g.fillText((pl>=0?'+':'−')+'$'+Math.abs(pl).toFixed(0),6,y-5);g.textAlign='right';}}
      // zones
      const xL=L.nowX,xR=L.xR;
      g.fillStyle=th.zoneGain;g.fillRect(xL,Math.min(Y(p.T),Y(p.E)),xR-xL,Math.abs(Y(p.T)-Y(p.E)));
      g.fillStyle=th.zoneLoss;g.fillRect(xL,Math.min(Y(p.S),Y(p.E)),xR-xL,Math.abs(Y(p.S)-Y(p.E)));
      if(p.liq>0){const yl=Y(p.liq);g.save();g.beginPath();if(p.d>0)g.rect(xL,yl,xR-xL,H-yl);else g.rect(xL,0,xR-xL,yl);g.clip();g.strokeStyle=th.hatch;g.lineWidth=2;for(let x=xL-H;x<xR;x+=9){g.beginPath();g.moveTo(x,H);g.lineTo(x+H,0);g.stroke();}g.restore();}
      // history (scrolls continuously between ticks)
      const dx=live?L.nowX/(n-2):L.nowX/(n-1);const pts=[];for(let i=0;i<n;i++){const x=live?(i-1-frac)*dx:i*dx;const v=i===n-1?s.disp:h[i];pts.push([x,Y(v)]);}pts[n-1][0]=L.nowX;
      const grad=g.createLinearGradient(0,L.padT,0,H);grad.addColorStop(0,th.area);grad.addColorStop(1,'rgba(0,0,0,0)');
      g.beginPath();g.moveTo(pts[0][0],pts[0][1]);for(let i=1;i<n;i++){const [a,b]=pts[i-1],[c,e]=pts[i];g.quadraticCurveTo(a,b,(a+c)/2,(b+e)/2);}g.lineTo(pts[n-1][0],pts[n-1][1]);
      g.save();g.lineTo(L.nowX,H);g.lineTo(pts[0][0],H);g.closePath();g.fillStyle=grad;g.fill();g.restore();
      g.beginPath();g.moveTo(pts[0][0],pts[0][1]);for(let i=1;i<n;i++){const [a,b]=pts[i-1],[c,e]=pts[i];g.quadraticCurveTo(a,b,(a+c)/2,(b+e)/2);}g.lineTo(pts[n-1][0],pts[n-1][1]);
      g.strokeStyle=th.line;g.lineWidth=2;g.lineJoin='round';g.stroke();
      // now line + pulse
      g.setLineDash([3,4]);g.strokeStyle=th.now;g.lineWidth=1;g.beginPath();g.moveTo(L.nowX+.5,L.padT-30);g.lineTo(L.nowX+.5,H-L.padB+24);g.stroke();g.setLineDash([]);
      const ym=Y(s.disp);const pr=(now-s.t0)/1000%2/2;g.fillStyle=th.pulse;g.globalAlpha=(1-pr)*.35;g.beginPath();g.arc(L.nowX,ym,4+pr*12,0,7);g.fill();g.globalAlpha=1;g.fillStyle=th.line;g.beginPath();g.arc(L.nowX,ym,4,0,7);g.fill();
      // time labels along the bottom of the history side
      g.font=`500 10.5px ${th.mono}`;g.fillStyle=th.axis;g.textAlign='center';const tcfg=TF[p.tf];
      {const narrow=L.nowX<420;const tick=(x,lab)=>{if(x<28||x>L.nowX-36)return;g.globalAlpha=.6;g.strokeStyle=th.grid;g.beginPath();g.moveTo(x+.5,L.padT);g.lineTo(x+.5,H-L.padB+6);g.stroke();g.globalAlpha=1;g.fillText(lab,x,H-L.padB+20);};
        if(live){// relative labels: "30s ago" is always the same distance from now, so they never move
          for(const sec of narrow?[60]:[30,60,90])tick(L.nowX-sec*1000/tcfg.ms*dx,`${sec}s ago`);}
        else{// the range series is static, so its clock labels are pinned to when the range was opened
          const key=p.market+p.tf;s.rngT=s.rngT||{};const nowT=s.rngT[key]||(s.rngT[key]=Date.now());const span=(n-1)*tcfg.ms;
          const step={'1H':narrow?30*60e3:15*60e3,'1D':narrow?12*3600e3:6*3600e3,'1W':narrow?2*864e5:864e5}[p.tf];const off=p.tf==='1H'?0:new Date().getTimezoneOffset()*60e3;
          for(let t=Math.ceil((nowT-span-off)/step)*step+off;t<nowT;t+=step){const i=n-1-(nowT-t)/tcfg.ms;const d=new Date(t);
            tick(i*dx,p.tf==='1H'?d.toLocaleTimeString([], {hour:'numeric',minute:'2-digit'}):p.tf==='1D'?d.toLocaleTimeString([], {hour:'numeric'}):d.toLocaleDateString([], {weekday:'short'}));}}}
      // high / low of the visible range
      {let hi=0,lo=0;const from=live?1:0;for(let i=from;i<n;i++){if(h[i]>h[hi]||hi<from)hi=i;if(h[i]<h[lo]||lo<from)lo=i;}
        g.font=`600 10.5px ${th.mono}`;g.fillStyle=th.axis;const lab=(i,up)=>{const [x,y]=pts[i];if(x<64||x>L.nowX-50)return;g.textAlign='center';g.fillText((up?'H ':'L ')+fmtP(h[i],p.m),x,up?y-9:y+17);g.beginPath();g.arc(x,y,2.4,0,7);g.fill();};lab(hi,true);lab(lo,false);}
      // history hover: time and price
      if(s.hx!=null&&!s.drag){const i=Math.max(live?1:0,Math.min(n-1,Math.round(live?s.hx/dx+1+frac:s.hx/dx)));const [x,y]=pts[i];const v=i===n-1?s.disp:h[i];
        g.strokeStyle=th.cross;g.lineWidth=1;g.beginPath();g.moveTo(x+.5,L.padT-6);g.lineTo(x+.5,H-L.padB+6);g.stroke();g.fillStyle=th.line;g.beginPath();g.arc(x,y,4,0,7);g.fill();
        const ch=(s.disp/v-1)*100;const txt=`${tfTime(p.tf,(n-1-i)*tcfg.ms,s.rngT&&s.rngT[p.market+p.tf])} · ${fmtP(v,p.m)} · ${ch>=0?'+':'−'}${Math.abs(ch).toFixed(2)}% since`;g.font=`600 12px ${th.font}`;const tw=g.measureText(txt).width+18;
        const tx=Math.max(6,Math.min(L.nowX-tw-6,x-tw/2)),ty=Math.max(4,y-38);g.fillStyle=th.tipBg;g.beginPath();g.roundRect?g.roundRect(tx,ty,tw,24,8):g.rect(tx,ty,tw,24);g.fill();g.fillStyle=th.tipFg;g.textAlign='left';g.fillText(txt,tx+9,ty+16);}
      // level lines
      const lvl=(v,c,w,dash,full)=>{const y=Y(v);g.strokeStyle=c;g.lineWidth=w;g.setLineDash(dash||[]);g.globalAlpha=.25;g.beginPath();g.moveTo(0,y);g.lineTo(W,y);g.stroke();g.globalAlpha=1;g.beginPath();g.moveTo(xL,y);g.lineTo(full?W:xR,y);g.stroke();g.setLineDash([]);};
      lvl(p.E,th.entry,1.2,[4,4]);if(p.liq>0)lvl(p.liq,th.loss,1,[2,4]);
      lvl(p.T,th.target,s.drag&&s.drag.k==='T'?2.6:1.8);lvl(p.S,th.stop,s.drag&&s.drag.k==='S'?2.6:1.8);
      g.font=`500 11px ${th.mono}`;g.textAlign='left';g.fillStyle=th.entry;g.fillText((p.pos?'entry ':'entry ≈ ')+fmtP(p.E,p.m),xL+12,Y(p.E)+16);
      if(p.liq>0&&Y(p.liq)<H-8&&Y(p.liq)>8){g.fillStyle=th.loss;g.fillText('liq. ≈ '+fmtP(p.liq,p.m),xL+12,Y(p.liq)+16);}
      g.fillStyle=th.axis;g.fillText('now · everything right of this line is conditional',xL+8,H-L.padB+20);
      // hover readout
      if(s.hover!=null&&!s.drag&&p.q){const v=s.pOf(s.hover);const pl=p.d*p.q*(v-p.E);g.strokeStyle=th.cross;g.lineWidth=1;g.beginPath();g.moveTo(xL,s.hover+.5);g.lineTo(xR,s.hover+.5);g.stroke();
        const txt=`${p.m.id} at ${fmtP(v,p.m)} → ${(pl>=0?'+':'−')}$${Math.abs(pl).toFixed(2)}`;g.font=`600 12px ${th.font}`;const tw=g.measureText(txt).width+18;g.fillStyle=th.tipBg;const tx=xR-tw-8,ty=s.hover-30;g.beginPath();g.roundRect?g.roundRect(tx,ty,tw,24,8):g.rect(tx,ty,tw,24);g.fill();g.fillStyle=th.tipFg;g.textAlign='left';g.fillText(txt,tx+9,ty+16);}
      // DOM handles
      const place=(el,v)=>{if(el)el.style.transform=`translate3d(0,${(Y(v)).toFixed(1)}px,0)`;};
      place(hT.current,p.T);place(hS.current,p.S);place(mk.current,s.disp);
      if(pT.current){pT.current.style.transform=`translate3d(${xL+14}px,${(Y(p.T)-24).toFixed(1)}px,0)`;}
      if(pS.current){pS.current.style.transform=`translate3d(${xL+14}px,${(Y(p.S)+(p.d>0?6:-24)).toFixed(1)}px,0)`;}
      if(mk.current)mk.current.firstChild.textContent=fmtP(s.disp,p.m);
    };raf=requestAnimationFrame(frame);return ()=>cancelAnimationFrame(raf);},[]);
  const down=k=>e=>{e.preventDefault();e.currentTarget.setPointerCapture&&e.currentTarget.setPointerCapture(e.pointerId);const p=P.current;st.current.drag={k,start:k==='T'?p.T:p.S,v:k==='T'?p.T:p.S};};
  const move=e=>{const s=st.current;const r=wrap.current.getBoundingClientRect();const y=e.clientY-r.top,x=e.clientX-r.left;const p=P.current;
    if(s.drag){const v=fixP(roundTick(Math.max(p.m.tick,s.pOf(y)),p.m),p.m);s.drag.v=v;if(p.pos)s.drag.k==='T'?p.onTarget(v,true):p.onStop(v,true);else s.drag.k==='T'?p.onTarget(v):p.onStop(v);return;}
    const L=s.L;const inY=L&&y>L.padT-10&&y<s.H-L.padB+10;s.hover=inY&&x>L.nowX&&x<L.xR?y:null;s.hx=inY&&x>0&&x<L.nowX?x:null;};
  const up=()=>{const s=st.current;const g=s.drag;s.drag=null;const p=P.current;if(g&&p.pos&&g.v!==g.start)p.onAmend(g.k==='T'?'tp':'sl',g.v,s.Y(g.v)+wrap.current.getBoundingClientRect().top);};
  const key=k=>e=>{const p=P.current;const stp=p.mark*.001*(e.shiftKey?10:1);const cur=k==='T'?p.T:p.S;let v=null;if(e.key==='ArrowUp')v=cur+stp;if(e.key==='ArrowDown')v=cur-stp;if(v!=null){e.preventDefault();v=fixP(roundTick(v,p.m),p.m);if(p.pos)p.onAmend(k==='T'?'tp':'sl',v,st.current.Y(v)+wrap.current.getBoundingClientRect().top);else k==='T'?p.onTarget(v):p.onStop(v);}};
  const pl=x=>q?fmtUsd(d*q*(x-E),2,true):'';
  return html`<div className="live" ref=${wrap} onPointerMove=${move} onPointerUp=${up} onPointerCancel=${up} onPointerLeave=${()=>{st.current.hover=null;st.current.hx=null;}}>
    <canvas ref=${cv} aria-hidden="true"></canvas>
    <div className="lv-pl t" ref=${pT}>${pl(T)}${pos?'':' at target'}</div>
    <div className="lv-pl s" ref=${pS}>${pl(S)}${pos?'':' at stop'}</div>
    <div className="lv-mark" ref=${mk}><span>${fmtP(mark,m)}</span></div>
    <button className="lv-h t" ref=${hT} onPointerDown=${down('T')} onKeyDown=${key('T')} aria-label=${`${pos?'Take profit':'Target'} ${fmtP(T,m)}. Drag, or use arrow keys.`}><span>${pos?'Take profit ':''}${fmtP(T,m).replace(/\.0+$/,'')}</span>${!pos&&html`<em>${fmtPct((T/mark-1)*100)}</em>`}<i aria-hidden="true">⋮</i></button>
    <button className="lv-h s" ref=${hS} onPointerDown=${down('S')} onKeyDown=${key('S')} aria-label=${`Stop ${fmtP(S,m)}. Drag, or use arrow keys.`}><span>Stop ${fmtP(S,m).replace(/\.0+$/,'')}</span>${!pos&&html`<em>${fmtPct((S/mark-1)*100)}</em>`}<i aria-hidden="true">⋮</i></button>
  </div>`;
}
