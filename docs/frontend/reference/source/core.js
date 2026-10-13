/* ================= Fixtures (simulated) ================= */
function rng(seed){let a=seed>>>0;return ()=>{a|=0;a=a+0x6D2B79F5|0;let t=Math.imul(a^a>>>15,1|a);t=t+Math.imul(t^t>>>7,61|t)^t;return((t^t>>>14)>>>0)/4294967296;};}
const MK={
  ETH:{id:'ETH',name:'Ethereum',tick:.01,lot:.001,dp:2,qdp:3,mark0:2478.40,chg:2.41,mmr:.025,ceiling:20,taker:.0004,fund:.000012,depthLot:820,stepBp:1.6,seed:11},
  BTC:{id:'BTC',name:'Bitcoin',tick:.1,lot:.0001,dp:1,qdp:4,mark0:61842.5,chg:-0.63,mmr:.02,ceiling:25,taker:.0004,fund:-.000008,depthLot:310,stepBp:1.1,seed:29},
};
const BOUND=.005, FUND_BLOCKS=8571, FUND_MIN=43, QUOTE_LIFE=10;
const roundTick=(p,m)=>Math.round(p/m.tick)*m.tick;
const fixP=(p,m)=>+p.toFixed(m.dp);
function spark(m){const r=rng(m.seed);const n=24;const start=m.mark0/(1+m.chg/100);const out=[];let v=start;for(let i=0;i<n;i++){const t=i/(n-1);const target=start+(m.mark0-start)*t;v=target+(r()-.5)*m.mark0*.006;out.push(i===n-1?m.mark0:v);}return out;}
const SPARK={ETH:spark(MK.ETH),BTC:spark(MK.BTC)};
// Order book: 40 levels per side, sizes in lots
function book(m,mark){const asks=[],bids=[];for(let i=0;i<40;i++){const off=mark*(m.stepBp/1e4)*(i+.6);const lots=Math.round(m.depthLot*(.5+i*.22));asks.push([fixP(roundTick(mark+off,m),m),lots]);bids.push([fixP(roundTick(mark-off,m),m),lots]);}return {asks,bids};}

/* ================= Financial core ================= */
// Smallest lot count n with d*q*(T-E(q)) >= G. Within one level gross is linear in q, so solve per level (non-monotone safe: first level that satisfies wins).
function solveSize(m,side,mark,T,G){
  const d=side==='long'?1:-1;const lv=side==='long'?book(m,mark).asks:book(m,mark).bids;
  let n0=0,C0=0;
  for(const [p,lots] of lv){
    const a=d>0?(T-p):(p-T); const q0=n0*m.lot; const b=d>0?(-C0+p*q0):(C0-p*q0);
    if(a>0){let need=(G-b)/a;let n=Math.max(n0+1,Math.ceil(need/m.lot-1e-9));if(n<=n0+lots){const q=n*m.lot;const E=(C0+p*(n-n0)*m.lot)/q;return {n,q,E,worst:p};}}
    C0+=p*lots*m.lot;n0+=lots;
  }
  return null;
}
function vwapFor(m,side,mark,n){const lv=side==='long'?book(m,mark).asks:book(m,mark).bids;let left=n,C=0,worst=0;for(const [p,lots] of lv){const t=Math.min(left,lots);C+=p*t*m.lot;left-=t;worst=p;if(!left)break;}if(left>0)return null;return {E:C/(n*m.lot),worst};}
function maxLotsForBudget(m,side,mark,L,budget){let lo=0,hi=0;const lv=side==='long'?book(m,mark).asks:book(m,mark).bids;for(const l of lv)hi+=l[1];
  const req=n=>{const v=vwapFor(m,side,mark,n);if(!v)return Infinity;const q=n*m.lot;return v.E*q/L+v.E*q*m.taker+topup(side,mark,v.E,q);};
  if(req(1)>budget)return 0;while(hi-lo>1){const mid=(lo+hi)>>1;if(req(mid)<=budget)lo=mid;else hi=mid;}return lo;}
function topup(side,M,E,q){const d=side==='long'?1:-1;return Math.max(0,-d*(M-E)*q);}
function liqPrice(side,E,q,C,mmr,F=0){const d=side==='long'?1:-1;const MMR=E*q*mmr;return Math.max(0,E+d*(MMR-C-F)/q);}
const stopBuffer=(m,mark)=>Math.max(m.tick,mark*.01);

function compute(dr,marks,free){
  const m=MK[dr.market];const M=marks[dr.market];const d=dr.side==='long'?1:-1;const L=dr.lev;
  const out={m,M,d,errors:{},ok:false};
  const ceil=Math.min(5,m.ceiling);out.ceil=ceil;
  if(!(L>=1&&L<=ceil+1e-9)) out.errors.lev=`Leverage must be between 1.00x and ${ceil.toFixed(2)}x.`;
  // target side validity vs mark (entry checked after solve)
  if(!(dr.target>0)) out.errors.target='Enter a positive price.';
  else if(d*(dr.target-M)<=0) out.errors.target=d>0?`A long target must be above the mark (${fmtP(M,m)}).`:`A short target must be below the mark (${fmtP(M,m)}).`;
  if(!(dr.goal>=.01)) out.errors.goal='Enter a goal of at least $0.01.';
  if(out.errors.target||out.errors.goal) return out;
  const s=solveSize(m,dr.side,M,dr.target,dr.goal);
  if(!s){out.errors.goal='This goal exceeds available depth at this target.';return out;}
  const {q,E,worst}=s;out.q=q;out.n=s.n;out.E=E;
  const bound=M*(1+d*BOUND);out.bound=fixP(roundTick(bound,m),m);
  if(d*(worst-bound)>0){out.errors.goal='Filling this size would move price past the 0.5% entry bound. Lower the goal or move the target further.';}
  if(d*(dr.target-E)<=0){out.errors.target=`Target must be beyond the estimated entry (${fmtP(E,m)}).`;}
  out.notional=E*q;out.margin=out.notional/L;out.entryFee=out.notional*m.taker;out.top=topup(dr.side,M,E,q);
  out.required=out.margin+out.entryFee+out.top;out.C=out.margin+out.top;
  out.gross=d*q*(dr.target-E);out.exitFeeT=dr.target*q*m.taker;out.netT=out.gross-out.entryFee-out.exitFeeT;
  out.liq=liqPrice(dr.side,E,q,out.C,m.mmr);out.buf=stopBuffer(m,M);
  // stop admission interval
  if(d>0){out.sLo=fixP(roundTick(Math.max(0,out.liq+out.buf)+m.tick,m),m);out.sHi=fixP(roundTick(Math.min(E,M)-m.tick,m),m);}
  else{out.sLo=fixP(roundTick(Math.max(E,M)+m.tick,m),m);out.sHi=fixP(roundTick(out.liq-out.buf-m.tick,m),m);}
  if(out.sLo>out.sHi) out.errors.stop='No safe stop at this leverage. Add budget or lower leverage.';
  else if(!(dr.stop>=out.sLo&&dr.stop<=out.sHi)) out.errors.stop=d>0?`Stop must be between ${fmtP(out.sLo,m)} and ${fmtP(out.sHi,m)} (below entry, above liquidation + buffer).`:`Stop must be between ${fmtP(out.sLo,m)} and ${fmtP(out.sHi,m)} (above entry, below liquidation − buffer).`;
  out.grossS=d*q*(dr.stop-E);out.netS=out.grossS-out.entryFee-dr.stop*q*m.taker;
  if(out.required>dr.budget+1e-9) out.errors.budget=`Needs ${fmtUsd(out.required)} but your budget is ${fmtUsd(dr.budget)}. Raise the budget or lower the goal.`;
  out.shortfall=Math.max(0,out.required-free);
  // feasible goal range at this target/budget/leverage
  const nMax=maxLotsForBudget(m,dr.side,M,L,dr.budget);
  if(nMax>0){const v=vwapFor(m,dr.side,M,nMax);out.gMax=Math.max(0,d*nMax*m.lot*(dr.target-v.E));}else out.gMax=0;
  out.reqGoalSize=dr.goal;out.overshoot=out.gross-dr.goal;
  out.ok=!Object.keys(out.errors).length;
  return out;
}

/* ================= Formatting ================= */
function fmtUsd(x,dp=2,sign=false){if(x==null||!isFinite(x))return '—';const a=Math.abs(x);let s;if(a>0&&a<.01&&dp>=2)s='<$0.01';else s='$'+a.toLocaleString('en-US',{minimumFractionDigits:dp,maximumFractionDigits:dp});if(x<0&&s!=='<$0.01')return '−'+s;if(sign&&x>0)return '+'+s;return s;}
const fmtShort=x=>Number.isInteger(Math.round(x*100)/100)&&Math.abs(x-Math.round(x))<1e-9?'$'+Math.round(x).toLocaleString('en-US'):fmtUsd(x);
function fmtP(p,m){if(p==null||!isFinite(p))return '—';return '$'+(+p).toLocaleString('en-US',{minimumFractionDigits:m.dp,maximumFractionDigits:m.dp});}
const fmtQ=(q,m)=>q==null||!isFinite(q)?'—':q.toFixed(m.qdp);
const fmtPct=x=>(x>0?'+':x<0?'−':'')+Math.abs(x).toFixed(1)+'%';
const ausd6=x=>x.toFixed(6)+' AUSD';
function parseNum(s){const t=String(s).replace(/[$,\s]/g,'');if(t===''||!/^\d*\.?\d*$/.test(t)||t==='.')return null;const v=parseFloat(t);return isFinite(v)?v:null;}
const clock=t=>new Date(t).toLocaleTimeString('en-US',{hour12:false});

/* ================= Small components ================= */
const DIG='0123456789'.split('');
function Odo({text}){const ch=[...text];return html`<span className="odo" aria-label=${text} role="text">${ch.map((c,i)=>{const k=ch.length-i;return /\d/.test(c)?html`<span className="odo-c" key=${'d'+k} aria-hidden="true"><span className="odo-s" style=${{transform:`translateY(${-(+c)*1.08}em)`}}>${DIG.map(d=>html`<span key=${d}>${d}</span>`)}</span></span>`:html`<span className="odo-x" key=${'x'+k+c} aria-hidden="true">${c}</span>`;})}</span>`;}
const Chev=()=>html`<svg className="chev" viewBox="0 0 10 6" aria-hidden="true"><path d="M1 1l4 4 4-4" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
const ErrI=()=>html`<svg viewBox="0 0 14 14" aria-hidden="true"><circle cx="7" cy="7" r="6.2" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="M7 3.8v3.7M7 9.6v.1" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>`;
function Err({children}){return children?html`<div className="err" role="status"><${ErrI}/><span>${children}</span></div>`:null;}
function Spark({data,up,sel}){const mn=Math.min(...data),mx=Math.max(...data);const pts=data.map((v,i)=>`${(i/(data.length-1)*56).toFixed(1)},${(20-(v-mn)/(mx-mn||1)*18).toFixed(1)}`).join(' ');return html`<svg className="spk" viewBox="0 0 56 22" aria-hidden="true"><polyline points=${pts} fill="none" stroke=${sel?(up?'#7fe0b2':'#ffab98'):(up?'#1f9d63':'#d4513a')} stroke-width="1.6" stroke-linejoin="round" stroke-linecap="round"/></svg>`;}

function Slider({value,min,max,step,onChange,onCommit,color,badge,label,valuetext,disabled,marks=[]}){
  const ref=useRef();const st=useRef({start:null,drag:false});const [drag,setDrag]=useState(false);
  const span=max-min||1;const pct=clamp((value-min)/span,0,1)*100;
  const fromX=x=>{const r=ref.current.getBoundingClientRect();let v=min+clamp((x-r.left)/r.width,0,1)*span;v=Math.round((v-min)/step)*step+min;return clamp(+v.toFixed(6),min,max);};
  const down=e=>{if(disabled||!e.isPrimary)return;e.preventDefault();ref.current.focus({preventScroll:true});st.current={start:value,drag:true};setDrag(true);ref.current.setPointerCapture&&ref.current.setPointerCapture(e.pointerId);onChange(fromX(e.clientX));};
  const move=e=>{if(st.current.drag&&e.isPrimary)onChange(fromX(e.clientX));};
  const up=e=>{if(!st.current.drag)return;st.current.drag=false;setDrag(false);onCommit&&onCommit();};
  const cancel=()=>{if(!st.current.drag)return;st.current.drag=false;setDrag(false);onChange(st.current.start);};
  const key=e=>{const k={ArrowRight:step,ArrowUp:step,ArrowLeft:-step,ArrowDown:-step,PageUp:step*10,PageDown:-step*10}[e.key];
    if(k!=null){e.preventDefault();onChange(clamp(+(value+k).toFixed(6),min,max));}else if(e.key==='Home'){e.preventDefault();onChange(min);}else if(e.key==='End'){e.preventDefault();onChange(max);}};
  return html`<div className=${'sl'+(drag?' drag':'')} ref=${ref} role="slider" tabIndex=${disabled?-1:0} aria-label=${label} aria-valuemin=${min} aria-valuemax=${max} aria-valuenow=${value} aria-valuetext=${valuetext} aria-disabled=${!!disabled}
    style=${{'--c':color}} onPointerDown=${down} onPointerMove=${move} onPointerUp=${up} onPointerCancel=${cancel} onKeyDown=${key} onKeyUp=${e=>{if(/Arrow|Page|Home|End/.test(e.key))onCommit&&onCommit();}}>
    <div className="sl-track"><div className="sl-fill" style=${{width:`calc(${pct}% + ${12-pct*.24}px)`}}></div>${marks.map((mk,i)=>html`<span key=${i} className="sl-mark" style=${{left:clamp((mk-min)/span,0,1)*100+'%'}}></span>`)}</div>
    <div className="sl-thumb" style=${{left:`calc(${pct}% + ${12-pct*.24}px)`}}>${badge&&html`<span className="sl-badge">${badge}</span>`}</div>
  </div>`;
}


/* ================= Shared hooks: simulated marks + simulator ================= */
function useMarks(){
  const [marks,setMarks]=useState({ETH:MK.ETH.mark0,BTC:MK.BTC.mark0});const runTo=useRef(null);
  useEffect(()=>{const r=rng(7);const id=setInterval(()=>{setMarks(mk=>{const out={...mk};for(const k of ['ETH','BTC']){const m=MK[k];let next=mk[k]*(1+(r()-.5)*.0006);
      if(runTo.current&&runTo.current.market===k){const g=runTo.current.price;next=mk[k]+(g-mk[k])*.35;if(Math.abs(g-next)<Math.max(m.tick*3,g*.0005))next=g;}
      out[k]=fixP(roundTick(next,m),m);}return out;});},reduce?1200:600);return ()=>clearInterval(id);},[]);
  return [marks,setMarks,runTo];
}
function useSim(marks,setMarks,runTo){
  const [ledger,setLedger]=useState({wallet:2000,free:1250,locked:0});
  const [pos,setPos]=useState(null);const [closed,setClosed]=useState(null);const [steps,setSteps]=useState(null);
  const posRef=useRef(null);posRef.current=pos;
  const settle=(exit,reason)=>{const p=posRef.current;if(!p)return;runTo.current=null;const m=MK[p.market];const d=p.side==='long'?1:-1;
    const gross=reason==='liquidated'?-p.C:d*p.q*(exit-p.E);const fee=reason==='liquidated'?0:exit*p.q*m.taker;
    const ret=reason==='liquidated'?0:p.C+gross-fee;
    setLedger(l=>({...l,locked:Math.max(0,l.locked-p.C),free:l.free+ret}));
    setClosed({...p,exit,gross,fees:p.entryFee+fee,net:reason==='liquidated'?-p.C-p.entryFee:gross-p.entryFee-fee,reason,
      label:{tp:'Take profit filled',sl:'Stop loss filled',liquidated:'Liquidated',manual:'Closed'}[reason]});
    setPos(null);};
  useEffect(()=>{const p=posRef.current;if(!p||p.status!=='active')return;const m=MK[p.market];const M=marks[p.market];const d=p.side==='long'?1:-1;
    if(p.tp.status==='registered'&&d*(M-p.tp.price)>=0){settle(p.tp.price,'tp');return;}
    if(p.sl.status==='registered'&&d*(M-p.sl.price)<=0){settle(fixP(roundTick(p.sl.price*(1-d*.0006),m),m),'sl');return;}
    const liq=liqPrice(p.side,p.E,p.q,p.C,m.mmr);if(d*(M-liq)<=0)settle(liq,'liquidated');},[marks]);
  const T=ms=>new Promise(r=>setTimeout(r,reduce?60:ms));
  const open=async(dr,q)=>{const m=MK[dr.market];const st=[{label:'Submitting bounded entry order',st:'run'},{label:'Acknowledged · awaiting fill',st:'wait'},{label:'Fill',st:'wait'},{label:'Take profit and stop loss',st:'wait'}];
    const up=(i,s,label)=>{st[i]={...st[i],st:s,label:label||st[i].label};setSteps([...st]);};setSteps([...st]);
    await T(650);up(0,'done');up(1,'run');await T(800);up(1,'done');
    const v=vwapFor(m,dr.side,marks[dr.market],q.n)||{E:q.E};const qq=q.n*m.lot;const C=v.E*qq/dr.lev+topup(dr.side,marks[dr.market],v.E,qq);const fee=v.E*qq*m.taker;
    up(2,'done',`Filled ${fmtQ(qq,m)} ${m.id} at ${fmtP(v.E,m)}`);setLedger(l=>({...l,free:l.free-C-fee,locked:l.locked+C}));
    setPos({market:dr.market,side:dr.side,q:qq,E:v.E,C,entryFee:fee,goal:dr.goal,target:dr.target,tp:{price:dr.target,status:'pending'},sl:{price:dr.stop,status:'pending'},status:'active',at:Date.now()});
    up(3,'run');await T(900);setPos(p=>p&&({...p,tp:{...p.tp,status:'registered'},sl:{...p.sl,status:'registered'}}));up(3,'done','TP and SL registered');await T(700);setSteps(null);};
  const close=async()=>{const p=posRef.current;if(!p)return;setPos(x=>({...x,status:'closing'}));await T(900);const m=MK[p.market];
    const v=vwapFor(m,p.side==='long'?'short':'long',marks[p.market],Math.round(p.q/m.lot))||{E:marks[p.market]};settle(v.E,'manual');};
  const amend=async(which,price)=>{setPos(p=>p&&({...p,[which]:{...p[which],status:'changing',next:price}}));await T(1000);setPos(p=>p&&({...p,[which]:{price:p[which].next,status:'registered'}}));};
  const nudge=a=>{const p=posRef.current;if(!p)return;const m=MK[p.market];
    if(a==='tp')runTo.current={market:p.market,price:p.tp.price+(p.side==='long'?m.tick:-m.tick)};
    else if(a==='sl')runTo.current={market:p.market,price:p.sl.price-(p.side==='long'?m.tick*4:-m.tick*4)};
    else{runTo.current=null;setMarks(mk=>({...mk,[p.market]:fixP(roundTick(mk[p.market]*(1+a),m),m)}));}};
  return {ledger,pos,closed,setClosed,steps,open,close,amend,nudge};
}
const pnlNow=(p,M)=>{const m=MK[p.market];const d=p.side==='long'?1:-1;const gross=d*p.q*(M-p.E);return {gross,net:gross-p.entryFee-M*p.q*m.taker};};
