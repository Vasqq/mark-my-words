
/* ================= Small editors ================= */
function NumIn({value,onCommit,onPreview,prefix='$',label,dp=2,focus=true}){
  const [raw,setRaw]=useState(String(value));const ed=useRef(false);const ref=useRef();
  useEffect(()=>{if(!ed.current)setRaw((+value).toFixed(dp).replace(/\.0+$/,''));},[value]);
  useEffect(()=>{if(focus&&ref.current){ref.current.focus({preventScroll:true});ref.current.select();}},[]);
  const commit=()=>{ed.current=false;const v=parseNum(raw);if(v!=null&&v>=0)onCommit(v);};
  return html`<label className="numin"><span>${prefix}</span><input ref=${ref} inputMode="decimal" aria-label=${label} value=${raw} onFocus=${()=>{ed.current=true;}}
    onInput=${e=>{ed.current=true;setRaw(e.target.value);const v=parseNum(e.target.value);if(v!=null&&v>=0&&onPreview)onPreview(v);}} onBlur=${commit} onKeyDown=${e=>{if(e.key==='Enter'){e.preventDefault();commit();}}}/><em>type or drag</em></label>`;
}
function EditPop({anchor,onClose,label,children,width=300}){
  const ref=useRef();const [pos,setPos]=useState(null);const mob=innerWidth<640;
  useLayoutEffect(()=>{if(mob)return;const r=anchor.getBoundingClientRect();const h=ref.current.offsetHeight;let top=r.bottom+10;if(top+h>innerHeight-12)top=Math.max(12,r.top-h-10);const left=clamp(r.left,12,innerWidth-width-12);setPos({left,top,ox:clamp(r.left+r.width/2-left,20,width-20)});},[]);
  useEffect(()=>{const dn=e=>{if(ref.current&&!ref.current.contains(e.target)&&!anchor.contains(e.target))onClose();};const k=e=>{if(e.key==='Escape'){onClose();anchor.focus();}};
    document.addEventListener('pointerdown',dn,true);document.addEventListener('keydown',k);return ()=>{document.removeEventListener('pointerdown',dn,true);document.removeEventListener('keydown',k);};},[]);
  return ReactDOM.createPortal(html`<${React.Fragment}>${mob&&html`<div className="ep-bg" onClick=${onClose}></div>`}<div className=${'ep'+(mob?' sheet':'')} ref=${ref} role="dialog" aria-label=${label} style=${mob?{}:{left:(pos?pos.left:-9999)+'px',top:(pos?pos.top:0)+'px',width:width+'px','--ox':(pos?pos.ox:20)+'px'}}>${mob&&html`<button className="ep-x" onClick=${onClose}>Done</button>`}${children}</div><//>`,document.body);
}
function Sheet({title,onClose,children,labelId}){
  const ref=useRef();useEffect(()=>{const h=ref.current&&ref.current.querySelector('h2');h&&h.focus();const k=e=>{if(e.key==='Escape')onClose();};addEventListener('keydown',k);return ()=>removeEventListener('keydown',k);},[]);
  return ReactDOM.createPortal(html`<div className="sh-bg" onClick=${e=>{if(e.target===e.currentTarget)onClose();}}><div className="sh" ref=${ref} role="dialog" aria-modal="true" aria-labelledby="sh-h">
    <div className="sh-h"><h2 id="sh-h" tabIndex="-1">${title}</h2><button className="ghost" onClick=${onClose}>Close</button></div>${children}</div></div>`,document.body);
}
function Tip({children,text}){return html`<span className="tip" tabIndex="0">${children}<span className="tip-i" aria-hidden="true">?</span><span className="tip-b" role="tooltip">${text}</span></span>`;}
const perHour=x=>x<.01?'under 1¢ an hour':'about '+fmtUsd(x)+' an hour';
const GLOSS={
  collateral:'The money set aside for this trade. Each position has its own, so one can’t drain another.',
  liq:'If the price reaches this level, Perpl closes the position automatically. Adding collateral moves it further away.',
  funding:'A small fee between buyers and sellers, about every hour. Depending on the market, you either pay it or receive it.',
  lev:'How much bigger your position is than your collateral. Higher leverage needs less money but puts liquidation closer.',
};

/* ================= Multi-position simulator (one isolated position per market) ================= */
function useBook(marks,setMarks,runTo){
  const [ledger,setLedger]=useState({wallet:0,free:0,locked:0});
  const [book,setBook]=useState({});const [hist,setHist]=useState([]);const [result,setResult]=useState(null);const [toasts,setToasts]=useState([]);const [steps,setSteps]=useState(null);
  const ref=useRef(book);ref.current=book;const mref=useRef(marks);mref.current=marks;
  const toast=(t,kind='')=>{const id=Math.random();setToasts(x=>[...x.slice(-2),{id,t,kind}]);setTimeout(()=>setToasts(x=>x.filter(y=>y.id!==id)),5600);};
  const T=ms=>new Promise(r=>setTimeout(r,reduce?60:ms));
  const settle=(mk,exit,reason,frac=1)=>{const p=ref.current[mk];if(!p)return;if(runTo.current&&runTo.current.market===mk)runTo.current=null;const m=MK[mk];const d=p.side==='long'?1:-1;
    const qx=frac>=1?p.q:Math.round(p.q*frac/m.lot)*m.lot;const f=qx/p.q;const Cx=p.C*f,Fx=p.F*f,efx=p.entryFee*f;
    const gross=d*qx*(exit-p.E);const fee=reason==='liq'?0:exit*qx*m.taker;
    const ret=reason==='liq'?Math.max(0,Cx+gross+Fx)*.8:Cx+gross-fee+Fx;
    setLedger(l=>({...l,locked:Math.max(0,l.locked-Cx),free:l.free+ret}));
    const net=reason==='liq'?ret-Cx-efx:gross-fee-efx+Fx;
    setHist(h=>[{market:mk,side:p.side,q:qx,E:p.E,exit,gross,net,reason,at:Date.now()},...h].slice(0,20));
    setBook(b=>{const n={...b};if(f>=.9999)delete n[mk];else n[mk]={...p,q:p.q-qx,C:p.C-Cx,F:p.F-Fx,entryFee:p.entryFee-efx,status:'active'};return n;});
    const label={tp:`Take profit hit on ${mk}`,sl:`Stop hit on ${mk}`,liq:`${mk} position liquidated`,manual:f>=.9999?`Closed your ${mk} position`:`Closed ${fmtQ(qx,m)} ${mk}`}[reason];
    if(f>=.9999)setResult({market:mk,side:p.side,reason,exit,net,ret,E:p.E,tp:p.tp.price,sl:p.sl.price,at:Date.now()});
    else toast(html`<b>${label}</b> ${fmtUsd(net,2,true)} after fees`,net>=0?'g':'r');};
  useEffect(()=>{for(const mk of Object.keys(ref.current)){const p=ref.current[mk];if(p.status!=='active')continue;const m=MK[mk];const M=marks[mk];const d=p.side==='long'?1:-1;
      if(p.tp.status==='registered'&&d*(M-p.tp.price)>=0){settle(mk,p.tp.price,'tp');continue;}
      if(p.sl.status==='registered'&&d*(M-p.sl.price)<=0){settle(mk,fixP(roundTick(p.sl.price*(1-d*.0006),m),m),'sl');continue;}
      const liq=liqPrice(p.side,p.E,p.q,p.C,m.mmr,p.F);if(d*(M-liq)<=0)settle(mk,liq,'liq');}},[marks]);
  // funding accrues on every open position (sped up for the simulation)
  useEffect(()=>{const id=setInterval(()=>{setBook(b=>{const n={...b};for(const mk of Object.keys(n)){const p=n[mk];const m=MK[mk];const d=p.side==='long'?1:-1;n[mk]={...p,F:p.F-d*m.fund*mref.current[mk]*p.q,fEv:(p.fEv||0)+1};}return n;});},12000);return ()=>clearInterval(id);},[]);
  const open=async(dr,q)=>{setResult(r=>r&&r.market===dr.market?null:r);const m=MK[dr.market];const ex=ref.current[dr.market];const st=[{label:'Placing your order',st:'run'},{label:'Waiting for it to fill',st:'wait'},{label:'Filled',st:'wait'},{label:'Setting take profit and stop',st:'wait'}];
    const up=(i,s,label)=>{st[i]={...st[i],st:s,label:label||st[i].label};setSteps([...st]);};setSteps([...st]);
    await T(600);up(0,'done');up(1,'run');await T(700);up(1,'done');
    const v=vwapFor(m,dr.side,mref.current[dr.market],q.n)||{E:q.E};const qq=q.n*m.lot;const C=v.E*qq/dr.lev+topup(dr.side,mref.current[dr.market],v.E,qq);const fee=v.E*qq*m.taker;
    up(2,'done',`Filled ${fmtQ(qq,m)} ${m.id} at ${fmtP(v.E,m)}`);setLedger(l=>({...l,free:l.free-C-fee,locked:l.locked+C}));
    setBook(b=>{const p=b[dr.market];const base={market:dr.market,side:dr.side,tp:{price:dr.target,status:'pending'},sl:{price:dr.stop,status:'pending'},status:'active',at:Date.now()};
      if(p&&p.side===dr.side){const nq=p.q+qq;return {...b,[dr.market]:{...p,...base,q:nq,E:(p.E*p.q+v.E*qq)/nq,C:p.C+C,entryFee:p.entryFee+fee,goal:p.goal+dr.goal,lev:dr.lev,merged:true}};}
      return {...b,[dr.market]:{...base,q:qq,E:v.E,C,entryFee:fee,F:0,goal:dr.goal,lev:dr.lev}};});
    up(3,'run');await T(800);setBook(b=>b[dr.market]?{...b,[dr.market]:{...b[dr.market],tp:{...b[dr.market].tp,status:'registered'},sl:{...b[dr.market].sl,status:'registered'}}}:b);up(3,'done','Take profit and stop set');
    await T(500);setSteps(null);toast(html`<b>${ex?`Added to your ${m.id} position`:`You’re in: ${dr.side} ${fmtQ(qq,m)} ${m.id}`}</b> Take profit and stop are set.`,'g');};
  const close=async(mk,frac)=>{setBook(b=>({...b,[mk]:{...b[mk],status:'closing'}}));await T(800);const p=ref.current[mk];if(!p)return;const m=MK[mk];
    const lots=Math.round(p.q*frac/m.lot);const v=vwapFor(m,p.side==='long'?'short':'long',mref.current[mk],Math.max(1,lots))||{E:mref.current[mk]};settle(mk,v.E,'manual',frac);};
  const margin=async(mk,amt)=>{const p=ref.current[mk];if(!p)return;const m=MK[mk];setBook(b=>({...b,[mk]:{...b[mk],status:'margin'}}));await T(650);
    setLedger(l=>({...l,free:l.free-amt,locked:l.locked+amt}));setBook(b=>({...b,[mk]:{...b[mk],C:b[mk].C+amt,status:'active'}}));
    const nl=liqPrice(p.side,p.E,p.q,p.C+amt,m.mmr,p.F);toast(html`<b>Added ${fmtUsd(Math.abs(amt))} collateral to ${mk}</b> Liquidation moved to ${fmtP(nl,m)}`);};
  const amend=async(mk,which,price)=>{setBook(b=>b[mk]?{...b,[mk]:{...b[mk],[which]:{...b[mk][which],status:'changing',next:price}}}:b);await T(950);
    setBook(b=>b[mk]?{...b,[mk]:{...b[mk],[which]:{price:b[mk][which].next,status:'registered'}}}:b);toast(html`<b>${which==='tp'?'Take profit':'Stop'} on ${mk} moved</b> to ${fmtP(price,MK[mk])}`);};
  const nudge=(mk,a)=>{const p=ref.current[mk];const m=MK[mk];
    if(a==='tp'&&p)runTo.current={market:mk,price:p.tp.price+(p.side==='long'?m.tick:-m.tick)};
    else if(a==='sl'&&p)runTo.current={market:mk,price:p.sl.price-(p.side==='long'?m.tick*4:-m.tick*4)};
    else{runTo.current=null;setMarks(x=>({...x,[mk]:fixP(roundTick(x[mk]*(1+a),m),m)}));}};
  const move=async(kind,amt)=>{await T(500);if(kind==='deposit')setLedger(l=>({...l,wallet:l.wallet-amt,free:l.free+amt}));else setLedger(l=>({...l,wallet:l.wallet+amt,free:l.free-amt}));toast(html`<b>${kind==='deposit'?'Deposited':'Withdrew'} ${fmtUsd(amt)}</b> ${kind==='deposit'?'to your trading balance':'to your wallet'}`);};
  const credit=amt=>setLedger(l=>({...l,free:l.free+amt}));const reset=()=>{setLedger({wallet:0,free:0,locked:0});setBook({});setHist([]);setResult(null);};
  return {ledger,book,hist,toasts,steps,result,clearResult:()=>setResult(null),open,close,margin,amend,nudge,move,credit,reset,toast};
}

/* ================= Sheets ================= */
function CollateralSheet({p,M,free,onDo,onClose}){
  const m=MK[p.market];const [amt,setAmt]=useState(Math.min(100,Math.floor(free)));const max=Math.floor(free);
  const a=clamp(amt,0,max);const nC=p.C+a;const liq0=liqPrice(p.side,p.E,p.q,p.C,m.mmr,p.F),liq1=liqPrice(p.side,p.E,p.q,nC,m.mmr,p.F);
  return html`<${Sheet} title=${`Add collateral to ${m.id}`} onClose=${onClose}>
    <${NumIn} value=${a} label="Amount" focus=${false} onPreview=${setAmt} onCommit=${v=>setAmt(Math.min(v,max))}/>
    ${max>=1?html`<${Slider} value=${clamp(Math.round(a),0,max)} min=${0} max=${max} step=${1} color="var(--mint)" label="Amount" valuetext=${fmtUsd(a)} onChange=${setAmt}/>`:html`<p className="ep-note">You have no free money to add. Add funds from your account first.</p>`}
    <div className="rows">
      <div className="r"><span className="k">Collateral</span><span className="v">${fmtUsd(p.C)} → <b>${fmtUsd(nC)}</b></span></div>
      <div className="r"><span className="k">Liquidation</span><span className="v">${fmtP(liq0,m)} → <b className="g">${fmtP(liq1,m)}</b><small>${Math.abs((liq1/M-1)*100).toFixed(0)}% away</small></span></div>
      <div className="r"><span className="k">Leverage</span><span className="v">${(p.E*p.q/p.C).toFixed(1)}x → <b>${(p.E*p.q/nC).toFixed(1)}x</b></span></div>
      <div className="r"><span className="k">Left to trade</span><span className="v">${fmtUsd(free-a)}</span></div>
    </div>
    <button className="big" aria-disabled=${a<=0||a>max} onClick=${()=>{if(a>0&&a<=max){onDo(a);onClose();}}}>Add ${fmtUsd(a)}</button>
  <//>`;
}
function CloseSheet({p,M,onDo,onClose}){
  const m=MK[p.market];const [pct,setPct]=useState(100);const d=p.side==='long'?1:-1;
  const lots=Math.round(p.q/m.lot);const n=pct===100?lots:Math.floor(lots*pct/100);const q=n*m.lot;
  const v=vwapFor(m,p.side==='long'?'short':'long',M,Math.max(1,n))||{E:M};const gross=d*q*(v.E-p.E);const fee=v.E*q*m.taker;const fr=q/p.q;
  const fees=fee+p.entryFee*fr;const net=gross-fees+p.F*fr;const back=p.C*fr+gross-fee+p.F*fr;
  return html`<${Sheet} title=${`Close ${m.id} ${p.side}`} onClose=${onClose}>
    <div className="segd" role="group" aria-label="How much to close">${[25,50,100].map(x=>html`<button key=${x} aria-pressed=${pct===x} onClick=${()=>setPct(x)}>${x}%</button>`)}</div>
    <div className="kv one"><div><small>You get back about</small><b>${fmtUsd(Math.max(0,back))}</b></div></div>
    <div className="rows">
      <div className="r"><span className="k">Profit or loss</span><span className=${'v '+(net>=0?'g':'r')}>${fmtUsd(net,2,true)}<small>after ${fmtUsd(fees)} in fees</small></span></div>
      <div className="r"><span className="k">Amount</span><span className="v">${fmtQ(q,m)} of ${fmtQ(p.q,m)} ${m.id}</span></div>
      <div className="r"><span className="k">Exit price</span><span className="v">about ${fmtP(v.E,m)}</span></div>
    </div>
    <p className="ep-note" style=${{margin:0}}>${pct===100?'Your take profit and stop will be removed.':`Your take profit and stop will cover the remaining ${fmtQ(p.q-q,m)} ${m.id}.`}</p>
    <button className="big red" aria-disabled=${!n} onClick=${()=>{if(n){onDo(pct/100);onClose();}}}>Close ${fmtQ(q,m)} ${m.id}</button>
  <//>`;
}
function AccountSheet({bk,marks,onClose,px,gate,openTap}){
  const [tab,setTab]=useState('overview');const [amt,setAmt]=useState(250);const [busy,setBusy]=useState(false);
  const pos=Object.values(bk.book);const upnl=pos.reduce((s,p)=>s+pnlNow(p,marks[p.market]).gross+p.F,0);const equity=bk.ledger.free+bk.ledger.locked+upnl;
  const max=tab==='deposit'?bk.ledger.wallet:bk.ledger.free;
  const u=px.user;const [cp,setCp]=useState(false);
  return html`<${Sheet} title="Account" onClose=${onClose}>
    <div className="who"><span className="av" aria-hidden="true">${(u.label||'?')[0].toUpperCase()}</span><span><b>${u.label}</b><button className="addr" onClick=${()=>{try{navigator.clipboard.writeText(u.addr);}catch(e){}setCp(true);setTimeout(()=>setCp(false),1200);}}><span className="mono">${short(u.addr)}</span> ${cp?'copied':'copy'}</button><small>${u.embedded?'Privy wallet':u.ext} · Monad</small></span></div>
    ${u.embedded&&html`<button className=${'taprow'+(px.tapOn()?' on':'')} onClick=${openTap}><span className="bolt">${Bolt}</span><span><b>One-tap trading</b><small>${px.tapOn()?'On · trades sign instantly':'Off · each trade asks to confirm'}</small></span><em>${px.tapOn()?'Manage':'Turn on'}</em></button>`}
    <span className="simtag">Simulation · no real funds</span>
    <div className="kv">
      <div className="wide"><small>Total value</small><b><${Odo} text=${fmtUsd(equity)}/></b></div><div><small>Free to trade</small><b><${Odo} text=${fmtUsd(bk.ledger.free)}/></b></div>
      <div><small>In positions</small><b>${fmtUsd(bk.ledger.locked)}</b></div></div>
    <div className="segd" role="group">${[['overview','History'],['withdraw','Withdraw']].map(([k,l])=>html`<button key=${k} aria-pressed=${tab===k} onClick=${()=>{setTab(k);setAmt(250);}}>${l}</button>`)}</div>
    ${tab==='overview'?html`<div className="hist">${bk.hist.length===0?html`<p className="ep-note">Closed trades will show up here with what you made or lost.</p>`:bk.hist.map((h,i)=>html`<div key=${i} className="hrow"><span><b>${h.market} ${h.side}</b><small>${({tp:'Take profit hit',sl:'Stop hit',liq:'Liquidated',manual:'Closed'})[h.reason]} · ${fmtP(h.E,MK[h.market])} → ${fmtP(h.exit,MK[h.market])}</small></span><b className=${h.net>=0?'g':'r'}>${fmtUsd(h.net,2,true)}</b></div>`)}</div>`
    :html`<${NumIn} value=${amt} label="Amount" focus=${false} onPreview=${setAmt} onCommit=${setAmt}/>
      <${Slider} value=${clamp(Math.round(amt),1,Math.max(2,Math.floor(max)))} min=${1} max=${Math.max(2,Math.floor(max))} step=${1} color="var(--lav)" label="Amount" valuetext=${fmtUsd(amt)} onChange=${setAmt}/>
      <p className="ep-note">${tab==='deposit'?'':'You can withdraw anything that isn’t in a position.'}</p>
      <button className="big" aria-disabled=${busy||amt<=0||amt>max} onClick=${async()=>{if(busy||amt<=0||amt>max)return;setBusy(true);const ok=await gate({title:`Withdraw ${fmtUsd(amt)}`,desc:'From your Perpl balance back to your wallet.',fn:'withdrawCollateral',rows:[['Amount',fmtUsd(amt)+' AUSD'],['To',short(u.addr)]]});if(ok)await bk.move(tab,amt);setBusy(false);if(ok)setTab('overview');}}>${busy?'Confirming…':(tab==='deposit'?'Deposit ':'Withdraw ')+fmtUsd(amt)}</button>`}
    <div className="acts"><button className="ghost solid" onClick=${()=>{onClose();px.fund(0);}}>Add funds</button>${u.embedded&&html`<button className="ghost" onClick=${()=>px.ask('export')}>Export wallet</button>`}<button className="ghost" onClick=${()=>{onClose();px.logout();bk.reset();}}>Log out</button></div>
  <//>`;
}

/* ================= App ================= */
const Sun=html`<svg viewBox="0 0 20 20" width="16" height="16" aria-hidden="true"><circle cx="10" cy="10" r="3.6" fill="currentColor"/><g stroke="currentColor" stroke-width="1.6" stroke-linecap="round">${[0,45,90,135,180,225,270,315].map(a=>html`<line key=${a} x1=${10+Math.cos(a*Math.PI/180)*6.2} y1=${10+Math.sin(a*Math.PI/180)*6.2} x2=${10+Math.cos(a*Math.PI/180)*8.2} y2=${10+Math.sin(a*Math.PI/180)*8.2}/>`)}</g></svg>`;
const Moon=html`<svg viewBox="0 0 20 20" width="16" height="16" aria-hidden="true"><path d="M15.5 12.6A6.5 6.5 0 0 1 7.4 4.5a6.5 6.5 0 1 0 8.1 8.1z" fill="currentColor"/></svg>`;
function App(){
  const [marks,setMarks,runTo]=useMarks();const bk=useBook(marks,setMarks,runTo);const px=usePrivy();const [tapOffer,setTapOffer]=useState(false);const [tapBanner,setTapBanner]=useState(false);const signs=useRef(0);const offered=useRef(false);
  // lazy auth (Polymarket-style): browse freely; log in, fund and sign only at the moment of an onchain action
  const gate=async(req,need=0)=>{if(!px.uref.current){if(!await px.login())return false;}
    if(need>0){const lack=need-bk.ledger.free;if(lack>0.005){const got=await px.fund(lack);if(!got)return false;}}
    const r=await px.sign(req);if(r==='tap')bk.toast(html`<b>${Bolt} Signed instantly</b> one-tap trading`);
    if(r===true){signs.current++;const u=px.uref.current;if(signs.current>=2&&!offered.current&&u&&u.embedded&&!px.tapOn()){offered.current=true;setTimeout(()=>setTapBanner(true),1600);}}
    return !!r;};
  const [mode,setMode]=useState(()=>{try{return localStorage.getItem('perpl-mode')||'day';}catch(e){return 'day';}});
  useEffect(()=>{document.documentElement.setAttribute('data-mode',mode);try{localStorage.setItem('perpl-mode',mode);}catch(e){}},[mode]);
  const TH=mode==='night'?NIGHT:DAY;
  const [draft,setDraft]=useState({market:'ETH',side:'long',goal:500,target:3100,budget:800,stop:2404.05,lev:3,rev:1});
  const set=pa=>setDraft(dr=>({...dr,...pa,rev:dr.rev+1}));
  const [sel,setSel]=useState('new');const [demo,setDemo]=useState(()=>innerWidth>640);const [tf,setTf]=useState('live');
  const [open,setOpen]=useState(null);const [anchor,setAnchor]=useState(null);const [frozen,setFrozen]=useState(null);
  const [review,setReview]=useState(null);const [qAt,setQAt]=useState(0);const [ack,setAck]=useState(false);const [now,setNow]=useState(Date.now());
  const [amend,setAmend]=useState(null);const [busyOpen,setBusyOpen]=useState(false);const [dragV,setDragV]=useState(null);const [sheet,setSheet]=useState(null);const [stage,setStage]=useState({});
  const drawerH=useRef();const headEl=useRef();const sentRef=useRef();
  const [vw,setVw]=useState(innerWidth);useEffect(()=>{const h=()=>setVw(innerWidth);addEventListener('resize',h);return ()=>removeEventListener('resize',h);},[]);
  useEffect(()=>{const id=setInterval(()=>setNow(Date.now()),250);return ()=>clearInterval(id);},[]);
  useEffect(()=>{setAck(false);},[draft.rev]);
  useEffect(()=>{const r=bk.result;if(!r)return;const rm=MK[r.market];const M2=marks[r.market];
    setDraft(dr=>dr.market!==r.market?dr:{...dr,side:r.side,target:fixP(roundTick(M2*(r.tp/r.E),rm),rm),stop:fixP(roundTick(M2*(r.sl/r.E),rm),rm),rev:dr.rev+1});},[bk.result&&bk.result.at]);
  useEffect(()=>{if(review&&drawerH.current)drawerH.current.focus();},[!!review]);
  // follow positions: if the selected one closes, fall back to another or to a new trade
  useEffect(()=>{if(sel!=='new'&&!bk.book[sel]){const k=Object.keys(bk.book)[0];setSel(k||'new');}},[bk.book,sel]);
  const pos=sel!=='new'?bk.book[sel]:null;
  const ex=bk.book[draft.market];const conflict=!pos&&ex&&ex.side!==draft.side;const adding=!pos&&ex&&ex.side===draft.side;
  const free=bk.ledger.free;const authed=!!px.user;
  const calc=useMemo(()=>compute({...draft,budget:authed?free:1e9},marks,authed?free:1e9),[draft,marks,free,authed]);
  const m=MK[draft.market];const M=marks[draft.market];const d=draft.side==='long'?1:-1;
  const tog=(k,e)=>{if(open===k){setOpen(null);return;}setAnchor(e.currentTarget);setFrozen({M,E:calc.E||M,sLo:calc.sLo,sHi:calc.sHi});if(pos)setStage({tp:pos.tp.price,sl:pos.sl.price});setOpen(k);};
  const flip=()=>{const tp=draft.target/M-1,sp=draft.stop/M-1;set({side:d>0?'short':'long',target:fixP(roundTick(M*(1-tp),m),m),stop:fixP(roundTick(M*(1-sp),m),m)});};
  const pick=id=>{setOpen(null);if(id===draft.market)return;const nm=MK[id],nM=marks[id];set({market:id,target:fixP(roundTick(nM*(draft.target/M),nm),nm),stop:fixP(roundTick(nM*(draft.stop/M),nm),nm)});};
  // plain-language versions of the calculator's errors
  const E=calc.errors;const needsFunds=!E.target&&!E.goal&&!E.stop&&!E.lev&&(E.budget||calc.shortfall>0);
  const err=conflict?`You’re already ${ex.side} ${m.id}. Close it before going ${draft.side}.`
    :E.target?(d>0?`Pick a target above today’s price (${fmtP(M,m)}).`:`Pick a target below today’s price (${fmtP(M,m)}).`)
    :E.goal?(draft.goal<.01?'Enter a goal of at least $0.01.':'That goal is too big for this target. Lower the goal or move the target further.')
    :E.stop?(calc.sLo>calc.sHi?'There’s no safe stop at this leverage. Lower the leverage.':`Set the stop between ${fmtP(calc.sLo,m)} and ${fmtP(calc.sHi,m)}.`)
    :E.lev?E.lev
    :needsFunds?`This needs ${fmtUsd(calc.required)} to open. Lower the goal or add funds.`:null;
  const fix=conflict?{t:`Show my ${m.id} position`,f:()=>setSel(draft.market)}:E.target?{t:`Switch to ${d>0?'falls':'rises'}`,f:flip}:E.stop&&calc.sLo<=calc.sHi?{t:'Fix the stop',f:()=>set({stop:fixP(roundTick(clamp(draft.stop,calc.sLo,calc.sHi),m),m)})}:needsFunds?{t:'Add funds',f:()=>px.fund(calc.required-free)}:null;
  const canReview=calc.ok&&!conflict&&(!authed||calc.shortfall<=0);
  const startReview=()=>{if(!canReview)return;setOpen(null);setReview({...calc,draft:{...draft}});setQAt(Date.now());setAck(false);};
  const age=busyOpen?0:(now-qAt)/1000;const stale=review&&!busyOpen&&age>=QUOTE_LIFE;useEffect(()=>{if(stale)setAck(false);},[stale]);
  const market=pos?pos.market:draft.market;const pm=MK[market];const pM=marks[market];const live=pos?pnlNow(pos,pM):null;
  const pliq=pos?liqPrice(pos.side,pos.E,pos.q,pos.C,pm.mmr,pos.F):null;
  const lv=pos?{side:pos.side,T:dragV&&dragV.k==='T'?dragV.v:(pos.tp.status==='changing'?pos.tp.next:pos.tp.price),S:dragV&&dragV.k==='S'?dragV.v:(pos.sl.status==='changing'?pos.sl.next:pos.sl.price),E:pos.E,liq:pliq,q:pos.q}
    :{side:draft.side,T:draft.target,S:draft.stop,E:calc.E||M,liq:calc.liq,q:calc.q||0};
  const F=frozen||{M,E:calc.E||M,sLo:calc.sLo,sHi:calc.sHi};
  const tDom=d>0?{lo:+(((Math.max(F.E,F.M)+m.tick)/F.M-1)*100).toFixed(1),hi:100}:{lo:-90,hi:+(((Math.min(F.E,F.M)-m.tick)/F.M-1)*100).toFixed(1)};
  const tPct=+((draft.target/F.M-1)*100).toFixed(1);
  const sOK=F.sLo!=null&&F.sLo<=F.sHi;const sDom=sOK?{lo:+((F.sLo/F.M-1)*100).toFixed(1),hi:+((F.sHi/F.M-1)*100).toFixed(1)}:null;
  const tk=(k,cls,label,content,extra)=>html`<button className=${'tk '+cls+(open===k?' on':'')+(extra||'')} aria-expanded=${open===k} aria-haspopup="dialog" onClick=${e=>tog(k,e)} aria-label=${label}>${content}<svg className="chev" viewBox="0 0 10 6" aria-hidden="true"><path d="M1 1l4 4 4-4" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg></button>`;
  const headH=useRef(200);useLayoutEffect(()=>{if(headEl.current)headH.current=headEl.current.getBoundingClientRect().bottom;});
  const positions=Object.values(bk.book);const totalNet=positions.reduce((s,p)=>{const x=pnlNow(p,marks[p.market]);return s+x.net+p.F;},0);
  const amendReq=(p,which,v)=>({title:`Move ${which==='tp'?'take profit':'stop'} on ${p.market}`,fn:'amendOrder',tap:true,rows:[[which==='tp'?'Take profit':'Stop',`${fmtP(p[which].price,MK[p.market])} → ${fmtP(v,MK[p.market])}`],['Position',`${fmtQ(p.q,MK[p.market])} ${p.market} ${p.side}`]]});
  // one-line sentence on wide screens: shrink the type until it fits (only re-measured when the words change)
  const fitKey=(pos?['p',pos.market,pos.side,pos.q,pos.goal,pos.tp.price,pos.sl.price]:['c',draft.goal,draft.market,draft.side,draft.target,draft.stop]).join('|');
  useLayoutEffect(()=>{const el=sentRef.current;if(!el)return;if(vw<1360){el.style.fontSize='';return;}const rg=document.createRange();rg.selectNodeContents(el);const fits=()=>rg.getBoundingClientRect().width<=el.clientWidth*.96;
    el.style.fontSize='40px';if(fits())return;let lo=22,hi=40;while(hi-lo>.5){const mid=(lo+hi)/2;el.style.fontSize=mid+'px';if(fits())lo=mid;else hi=mid;}el.style.fontSize=lo+'px';},[fitKey,vw]);
  // staged order edits for an open position (sentence route)
  const posPop=(which)=>{const p=pos;const cur=p[which].price;const v=stage[which]??cur;const dd=p.side==='long'?1:-1;const lo=which==='tp'?(dd>0?0:-60):(dd>0?-40:0),hi=which==='tp'?(dd>0?100:0):(dd>0?0:40);
    const val=clamp(+((v/pM-1)*100).toFixed(1),lo,hi);const immediate=which==='tp'?dd*(v-pM)<=0:dd*(v-pM)>=0;const liqBad=which==='sl'&&dd*(v-(pliq+dd*stopBuffer(pm,pM)))<0;
    return html`<${EditPop} anchor=${anchor} onClose=${()=>{setOpen(null);setStage({});}} label=${which==='tp'?'Change take profit':'Change stop'}><h4>${which==='tp'?'Take profit':'Stop'} · current ${fmtP(cur,pm)}</h4>
      <${NumIn} value=${v} label="Trigger price" dp=${pm.dp} onPreview=${x=>setStage(s=>({...s,[which]:x}))} onCommit=${x=>setStage(s=>({...s,[which]:fixP(roundTick(x,pm),pm)}))}/>
      <${Slider} value=${val} min=${lo} max=${hi} step=${.1} color=${which==='tp'?'var(--mint)':'var(--coral)'} label="Distance from today’s price" valuetext=${fmtPct(val)} badge=${fmtPct(val)} onChange=${x=>setStage(s=>({...s,[which]:fixP(roundTick(pM*(1+x/100),pm),pm)}))}/>
      <div className="ep-foot"><span><b>${fmtQ(p.q,pm)} ${pm.id}</b>position size</span><span><b className=${dd*(v-p.E)>=0?'g':'r'}>${fmtUsd(dd*p.q*(v-p.E),2,true)}</b>${dd*(v-p.E)>=0?'you’d make':'you’d lose'}</span><span><b>${fmtP(pliq,pm)}</b>liquidation</span></div>
      ${immediate&&html`<p className="ep-note" style=${{color:'var(--warn)'}}>${pm.id} is already past this price, so it would close right away.</p>`}
      ${liqBad&&html`<p className="ep-note" style=${{color:'var(--loss)'}}>Too close to liquidation. Keep the stop at least ${fmtUsd(stopBuffer(pm,pM))} away, or add collateral.</p>`}
      <button className="big" style=${{marginTop:'10px'}} aria-disabled=${v===cur||liqBad} onClick=${async()=>{if(v!==cur&&!liqBad){setOpen(null);setStage({});if(await gate(amendReq(p,which,v)))bk.amend(p.market,which,v);}}}>Save change</button><//>`;};
  return html`<div className="app">
    <header className="top"><span className="brand">perpl<b>.</b></span>
      <span className="topr"><button className="modebtn" onClick=${()=>setMode(mode==='day'?'night':'day')} aria-label=${mode==='day'?'Switch to night':'Switch to day'}>${mode==='day'?Moon:Sun}</button>
        ${authed?html`<button className="bal" onClick=${()=>setSheet({k:'account'})} aria-label="Account">${px.tapOn()&&html`<span className="zap" title="One-tap trading on">${Bolt}</span>`}<${Odo} text=${fmtUsd(bk.ledger.free)}/><small>AUSD</small><span className="av" aria-hidden="true">${(px.user.label||'?')[0].toUpperCase()}</span></button>`
          :html`<button className="login" onClick=${()=>px.login()}>Log in</button>`}</span></header>

    <div className="head" data-testid="sentence-area" ref=${headEl}>
      ${pos?html`<p className="sentence" ref=${sentRef} aria-live="polite">You’re ${html`<span className="tk coral static">${pos.side}</span>`} ${fmtQ(pos.q,pm)} <span className="tk lav static">${pm.id}</span>, ${live.gross>=0?'up':'down'} <span className=${'tk static '+(live.gross>=0?'mint':'coral')}><${Odo} text=${fmtUsd(Math.abs(live.gross))}/></span> on a <span className="tk gold static">${fmtShort(pos.goal)}</span> goal.
          Take profit at ${tk('tp','mint','Take profit '+fmtP(lv.T,pm),html`${fmtP(lv.T,pm).replace(/\.0+$/,'')}${pos.tp.status==='changing'?html`<em className="pc">saving…</em>`:''}`)}<span className="tail">, stop at </span>${tk('sl','stop','Stop '+fmtP(lv.S,pm),html`${fmtP(lv.S,pm).replace(/\.0+$/,'')}${pos.sl.status==='changing'?html`<em className="pc">saving…</em>`:''}`)}.</p>
          <p className="sub">${pos.status==='closing'?'Closing…':pos.status==='margin'?'Updating collateral…':pos.merged?'Trades on the same market combine into one position. ':''}Tap a price or drag its line to change it. <button className="back" onClick=${()=>{setSel('new');setOpen(null);}}>Back to new trade</button></p>`
      :html`<p className="sentence" ref=${sentRef}>I want to make ${tk('goal','gold','Profit goal '+fmtShort(draft.goal),html`<${Odo} text=${fmtShort(draft.goal)}/>`,calc.errors.goal?' bad':'')} if ${tk('market','lav','Market '+m.name,m.id)}
          <button className="tk coral" onClick=${flip} aria-label=${'Direction '+(d>0?'long, change to short':'short, change to long')}><svg className="ar" viewBox="0 0 12 12" aria-hidden="true">${d>0?html`<path d="M2 9.5L9.5 2M4 2h5.5v5.5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>`:html`<path d="M2 2.5L9.5 10M4 10h5.5V4.5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>`}</svg>${d>0?'rises':'falls'} to</button>
          ${tk('target','mint','Target '+fmtP(draft.target,m),html`${fmtP(draft.target,m).replace(/\.0+$/,'')}<em className="pc">${fmtPct((draft.target/M-1)*100)}</em>`,calc.errors.target?' bad':'')}<span className="tail">, stop at </span>${tk('stop','stop','Stop '+fmtP(draft.stop,m),fmtP(draft.stop,m).replace(/\.0+$/,''),calc.errors.stop?' bad':'')}.</p>
        ${err?html`<div className="msg" role="status"><span>${err}</span>${fix&&html`<button onClick=${fix.f}>${fix.t}</button>`}</div>`
          :adding?html`<p className="sub add">You already hold ${fmtQ(ex.q,m)} ${m.id} ${ex.side}. This adds to it.</p>`
          :html`<p className="sub">Tap any word to change it. Amounts are before fees.</p>`}`}
    </div>

    ${html`<div className="rail" data-testid="positions-row" role="tablist" aria-label="Your positions">
      ${positions.map(p=>{const x=pnlNow(p,marks[p.market]);const mm=MK[p.market];const L=p.side==='long'?p.sl.price:p.tp.price,R=p.side==='long'?p.tp.price:p.sl.price;const at=clamp((marks[p.market]-L)/(R-L),0,1);
        return html`<button key=${p.market} role="tab" aria-selected=${sel===p.market} className="pchip" onClick=${()=>{setSel(sel===p.market?'new':p.market);setOpen(null);setReview(null);}}>
          <span className="pc-t"><b>${mm.id}</b><span className=${'side '+p.side}>${p.side==='long'?'↗ long':'↘ short'}</span></span>
          <span className=${'pc-v '+(x.gross>=0?'g':'r')}><${Odo} text=${fmtUsd(x.gross,2,true)}/></span>
          <span className="pc-bar" aria-hidden="true"><i style=${{left:at*100+'%'}}></i></span>
          ${p.sl.status!=='registered'&&p.status==='active'&&html`<span className="pc-warn">protecting…</span>`}</button>`;})}
      
      ${bk.result&&!bk.book[bk.result.market]&&(()=>{const r=bk.result;const rm=MK[r.market];
        const title={tp:'Take profit hit',sl:'Stop hit',liq:'Liquidated',manual:'Position closed'}[r.reason];
        const sub=r.reason==='liq'?`${fmtUsd(r.ret)} returned to you`:`${r.market} ${r.side} closed at ${fmtP(r.exit,rm).replace(/\.0+$/,'')} · after fees`;
        return html`<div className=${'pchip result '+(r.net>=0?'win':'loss')} role="status">
          <span className="rs-t"><b>${title}</b><span>${sub}</span></span>
          <span className=${'rs-v '+(r.net>=0?'g':'r')}>${fmtUsd(r.net,2,true)}</span>
          <span className="rs-a"><button onClick=${()=>setSheet({k:'account'})}>History</button><button aria-label="Dismiss" onClick=${bk.clearResult}>×</button></span></div>`;})()}
      ${positions.length===0&&!bk.result&&(authed?html`<span className="rail-empty">No active positions. Your positions will sit here.</span>`
        :html`<button className="rail-empty login-hint" onClick=${()=>px.login()}>Log in to view your active positions</button>`)}
      ${positions.length>0&&html`<span className="rail-sum">${positions.length} open · <b className=${totalNet>=0?'g':'r'}>${fmtUsd(totalNet,2,true)}</b></span>`}
    </div>`}

    <div className="chartbox" data-testid="chart"><div className="ctools">
        <div className="tfs" role="group" aria-label="Chart range">${Object.keys(TF).map(k=>html`<button key=${k} aria-pressed=${tf===k} onClick=${()=>setTf(k)}>${k==='live'?html`<i className="dot"></i>Live`:TF[k].label}</button>`)}</div>
        ${tf!=='live'&&html`<span className=${'tfchg '+(tfChange(market,tf)>=0?'g':'r')}>${pm.id} ${fmtPct(tfChange(market,tf))} <small>${tf==='1H'?'past hour':tf==='1D'?'24h':'7 days'}</small></span>`}
        ${pos&&html`<div className=${'simdock'+(demo?' open':'')} aria-label="Demo: move the price"><button className="dtog" aria-expanded=${demo} onClick=${()=>setDemo(!demo)}>Demo<span>: move price</span></button><span className="dbtns"><button onClick=${()=>bk.nudge(market,-.01)}>−1%</button><button onClick=${()=>bk.nudge(market,.01)}>+1%</button><button onClick=${()=>bk.nudge(market,'tp')}>Hit take profit</button><button onClick=${()=>bk.nudge(market,'sl')}>Hit stop</button></span></div>`}</div><${LiveChart} tf=${tf} market=${market} mark=${pM} lv=${lv} pos=${pos} T=${TH} layout=${(W,H)=>LAYOUT(W,H)} pnlAxis=${true}
      onTarget=${(v,drag)=>drag?setDragV({k:'T',v}):set({target:v})} onStop=${(v,drag)=>drag?setDragV({k:'S',v}):set({stop:v})} onAmend=${(k,v,y)=>{setDragV(null);setAmend({k,v,y,mk:market});}}/></div>

    ${!pos&&open==='goal'&&anchor&&html`<${EditPop} anchor=${anchor} onClose=${()=>setOpen(null)} label="Profit goal"><h4>How much do you want to make?</h4>
      <${NumIn} value=${draft.goal} label="Profit goal" onPreview=${v=>set({goal:Math.round(v*100)/100})} onCommit=${v=>set({goal:Math.max(1,Math.round(v*100)/100)})}/>
      <${Slider} value=${clamp(Math.round(draft.goal),1,Math.max(2,Math.floor(calc.gMax||1)))} min=${1} max=${Math.max(2,Math.floor(calc.gMax||1))} step=${1} color="var(--gold)" label="Profit goal" valuetext=${fmtShort(draft.goal)} onChange=${v=>set({goal:v})}/>
      <div className="ep-foot"><span><b>$1</b>min</span><span><b>${calc.required!=null?fmtUsd(calc.required):'—'}</b>collateral</span><span>${authed?html`<b>${fmtShort(Math.floor(calc.gMax||0))}</b>most with your funds`:''}</span></div><//>`}
    ${!pos&&open==='market'&&anchor&&html`<${EditPop} anchor=${anchor} onClose=${()=>setOpen(null)} label="Market"><h4>Choose a market</h4>
      ${['ETH','BTC'].map(id=>html`<button key=${id} className="mrow" role="option" aria-selected=${draft.market===id} onClick=${()=>pick(id)}><b>${id}</b><span>${fmtP(marks[id],MK[id])}${bk.book[id]?html` · <em>you’re ${bk.book[id].side}</em>`:''}</span><span className=${MK[id].chg>=0?'g':'r'}>${fmtPct(MK[id].chg)}</span></button>`)}<//>`}
    ${!pos&&open==='target'&&anchor&&html`<${EditPop} anchor=${anchor} onClose=${()=>{setOpen(null);setFrozen(null);}} label="Target price"><h4>${m.id} is ${fmtP(F.M,m)} now</h4>
      <${NumIn} value=${draft.target} label="Target price" dp=${m.dp} onPreview=${v=>set({target:v})} onCommit=${v=>set({target:fixP(roundTick(v,m),m)})}/>
      <${Slider} value=${clamp(tPct,tDom.lo,Math.max(tDom.hi,tPct))} min=${tDom.lo} max=${Math.max(tDom.hi,tPct)} step=${.1} color="var(--mint)" label="Distance from today’s price" valuetext=${fmtPct(tPct)} badge=${fmtPct(tPct)} onChange=${v=>set({target:fixP(roundTick(F.M*(1+v/100),m),m)})}/>
      <div className="ep-foot"><span><b>${fmtPct(tDom.lo)}</b>lowest</span><span><b className="g">${calc.q?fmtUsd(calc.netT,2,true):'—'}</b>you’d make, after fees</span><span><b>${fmtPct(Math.max(tDom.hi,tPct))}</b>highest</span></div>
      <//>`}
    ${!pos&&open==='stop'&&anchor&&html`<${EditPop} anchor=${anchor} onClose=${()=>{setOpen(null);setFrozen(null);}} label="Stop price"><h4>Stop loss</h4>
      <${NumIn} value=${draft.stop} label="Stop price" dp=${m.dp} onPreview=${v=>set({stop:v})} onCommit=${v=>set({stop:fixP(roundTick(v,m),m)})}/>
      ${sOK?html`<${Slider} value=${clamp(+((draft.stop/F.M-1)*100).toFixed(1),sDom.lo,sDom.hi)} min=${sDom.lo} max=${sDom.hi} step=${.1} color="var(--coral)" label="Distance from today’s price" valuetext=${fmtPct((draft.stop/F.M-1)*100)} badge=${fmtPct((draft.stop/F.M-1)*100)} onChange=${v=>set({stop:fixP(roundTick(F.M*(1+v/100),m),m)})}/>`:html`<p className="ep-note">There’s no safe stop at this leverage. Lower the leverage.</p>`}
      <div className="ep-foot"><span><b>${sOK?fmtP(F.sLo,m):'—'}</b>${d>0?'lowest safe stop':'closest'}</span><span><b className="r">${calc.netS!=null?fmtUsd(calc.netS):'—'}</b>you’d lose</span><span><b>${sOK?fmtP(F.sHi,m):'—'}</b>${d>0?'closest':'highest safe stop'}</span></div>
      <p className="ep-note">Closes at market when ${m.id} hits this price. The fill can be a little ${d>0?'lower':'higher'}.</p><//>`}
    ${pos&&(open==='tp'||open==='sl')&&anchor&&posPop(open)}

    <div className="bar" data-testid="bottom-bar" role="toolbar" aria-label=${pos?'Position controls':'Trade summary'}>
      ${pos?html`
        <div className="seg"><small>Position</small><b>${fmtQ(pos.q,pm)} ${pm.id}</b><small>${pos.side==='long'?'bought':'sold'} at ${fmtP(pos.E,pm)}</small></div><span className="vsep"></span>
        <button className="seg act" onClick=${()=>setSheet({k:'margin'})} aria-label="Add collateral"><small><${Tip} text=${GLOSS.collateral}>Collateral<//></small><b>${fmtUsd(pos.C)} <span className="mini">±</span></b><small>${(pos.E*pos.q/pos.C).toFixed(1)}x leverage</small></button><span className="vsep"></span>
        <div className="seg"><small><${Tip} text=${GLOSS.liq}>Liquidation<//></small><b>${fmtP(pliq,pm)}</b><small>${Math.abs((pliq/pM-1)*100).toFixed(0)}% away</small></div><span className="vsep hide-m"></span>
        <div className="seg hide-m"><small><${Tip} text=${GLOSS.funding}>Funding<//></small><b className=${pos.F>=0?'g':'r'}>${fmtUsd(pos.F,2,true)}</b><small>${pm.fund>0===(pos.side==='long')?'you pay':'you get'} ${perHour(Math.abs(pm.fund)*pM*pos.q)}</small></div><span className="vsep hide-m"></span>
        <div className="seg hide-m"><small>If you close now</small><b className=${live.net+pos.F>=0?'g':'r'}><${Odo} text=${fmtUsd(live.net+pos.F,2,true)}/></b><small>after fees</small></div>
        <button className="cta red" onClick=${()=>setSheet({k:'close'})} aria-disabled=${pos.status!=='active'}>Close</button>`
      :html`
        <div className="seg"><small>${d>0?'Long':'Short'}</small><b>${calc.q?fmtQ(calc.q,m)+' '+m.id:'—'}</b></div><span className="vsep"></span>
        <div className="seg"><small><${Tip} text=${GLOSS.collateral}>Collateral<//></small><b><${Odo} text=${calc.required!=null?fmtUsd(calc.required):'—'}/></b></div><span className="vsep"></span>
        <div className="seg"><small><${Tip} text=${GLOSS.lev}>Leverage<//></small><span className="step"><button aria-label="Lower leverage" onClick=${()=>set({lev:Math.max(1,+(draft.lev-.5).toFixed(2))})}>−</button><b style=${{minWidth:'44px',textAlign:'center'}}>${draft.lev.toFixed(1)}x</b><button aria-label="Raise leverage" onClick=${()=>set({lev:Math.min(5,+(draft.lev+.5).toFixed(2))})}>+</button></span></div><span className="vsep hide-m"></span>
        <div className="seg hide-m"><small><${Tip} text=${GLOSS.liq}>Liquidation<//></small><b>${calc.liq?fmtP(calc.liq,m):'—'}</b></div><span className="vsep hide-m"></span>
        <div className="seg hide-m"><small>If stopped</small><b className="r">${calc.netS!=null?fmtUsd(calc.netS):'—'}</b></div>
        <button className="cta" aria-disabled=${!canReview} onClick=${startReview}>${adding?'Review add':'Review'}</button>`}
    </div>

    ${amend&&pos&&html`<div className="confirm" style=${{top:clamp(amend.y,80,innerHeight-80)+'px'}} role="dialog" aria-label="Confirm order change">
      Move ${amend.k==='tp'?'take profit':'stop'} to <b>${fmtP(amend.v,pm)}</b>?<button className="ghost solid" onClick=${async()=>{const a=amend;setAmend(null);if(await gate(amendReq(pos,a.k,a.v)))bk.amend(a.mk,a.k,a.v);}}>Save</button><button className="ghost" onClick=${()=>setAmend(null)}>Cancel</button></div>`}

    ${review&&html`<aside className="drawer" role="dialog" aria-modal="true" aria-labelledby="rv-h" onKeyDown=${e=>{if(e.key==='Escape'&&!bk.steps)setReview(null);}}>
      <div className="dh"><h2 id="rv-h" tabIndex="-1" ref=${drawerH}>${adding?'Add to your position':'Your trade plan'}</h2>
        ${stale?html`<button className="ghost" onClick=${startReview}>Prices moved · Refresh</button>`:html`<span className="fresh"><svg viewBox="0 0 20 20"><circle className="t" cx="10" cy="10" r="8"/><circle className="p" cx="10" cy="10" r="8" strokeDasharray="50.27" strokeDashoffset=${50.27*(age/QUOTE_LIFE)}/></svg>${Math.max(0,Math.ceil(QUOTE_LIFE-age))}s</span>`}</div>
      <p className="re">Make <span className="c-gold">${fmtShort(review.draft.goal)}</span> if <span className="c-lav">${m.id}</span> ${d>0?'rises':'falls'} to <span className="c-mint">${fmtP(review.draft.target,m)}</span>, stop at <span className="c-coral">${fmtP(review.draft.stop,m)}</span>.</p>
      ${adding&&html`<p className="ep-note" style=${{margin:0}}>Perpl combines this with your ${fmtQ(ex.q,m)} ${m.id} ${ex.side}. The new take profit and stop apply to the whole position.</p>`}
      <div className="rows">
        <div className="r"><span className="k">${d>0?'You buy':'You sell'}</span><span className="v">${fmtQ(review.q,m)} ${m.id}<small>at about ${fmtP(review.E,m)}</small></span></div>
        <div className="r"><span className="k">Collateral</span><span className="v">${fmtUsd(review.required)}<small>${review.draft.lev.toFixed(1)}x leverage</small></span></div>
        <div className="r"><span className="k">If ${m.id} hits ${fmtP(review.draft.target,m).replace(/\.0+$/,'')}</span><span className="v g">${fmtUsd(review.netT,2,true)}<small>after fees</small></span></div>
        <div className="r"><span className="k">If stopped</span><span className="v r">${fmtUsd(review.netS)}<small>can be a bit worse in fast markets</small></span></div>
        <div className="r"><span className="k">Liquidation</span><span className="v">${fmtP(review.liq,m)}<small>${Math.abs((review.liq/review.M-1)*100).toFixed(0)}% ${d>0?'below':'above'} today’s price</small></span></div>
      </div>
      <details className="more"><summary>Details</summary><div className="rows">
        <div className="r"><span className="k">Position size</span><span className="v">${fmtUsd(review.notional)}</span></div>
        <div className="r"><span className="k">Worst entry price</span><span className="v">${fmtP(review.bound,m)}<small>the order won’t fill beyond this</small></span></div>
        <div className="r"><span className="k">Fee to open</span><span className="v">${fmtUsd(review.entryFee)}</span></div>
        <div className="r"><span className="k">Funding</span><span className="v">${m.fund>0===(d>0)?'you pay':'you get'} ${perHour(Math.abs(m.fund)*review.M*review.q)}</span></div>
      </div></details>
      ${bk.steps?html`<div className="steps" role="status">${bk.steps.map((s,i)=>html`<div key=${i} className=${'st '+s.st}><i>${s.st==='done'?'✓':''}</i>${s.label}</div>`)}</div>`:html`
        <label className="ack"><input type="checkbox" checked=${ack} onChange=${e=>setAck(e.target.checked)}/><span className="box"><svg viewBox="0 0 12 10"><path d="M1 5l3.5 3.5L11 1" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg></span><span>I understand I could lose up to my collateral.</span></label>
        <button className="big" aria-disabled=${!ack||stale||busyOpen} onClick=${async()=>{if(!ack||stale||busyOpen)return;const rv=review;const mk=rv.draft.market;setBusyOpen(true);
          const ok=await gate({title:`${adding?'Add to':'Open'} ${mk} ${rv.draft.side}`,desc:`Make ${fmtShort(rv.draft.goal)} if ${mk} ${rv.draft.side==='long'?'rises':'falls'} to ${fmtP(rv.draft.target,MK[mk])}.`,fn:'execOrder + TP/SL',tap:true,amt:rv.required,
            rows:[['Size',`${fmtQ(rv.q,MK[mk])} ${mk}`],['Collateral',fmtUsd(rv.required)],['Take profit · stop',`${fmtP(rv.draft.target,MK[mk])} · ${fmtP(rv.draft.stop,MK[mk])}`]]},rv.required+rv.entryFee);
          setBusyOpen(false);setQAt(Date.now());if(!ok)return;await bk.open(rv.draft,rv);setReview(null);setSel(mk);}}>${!authed?'Log in and open':adding?'Add to position':'Open position'}</button>
        ${!authed&&html`<p className="ep-note" style=${{margin:0,textAlign:'center'}}>Log in with email, Google or a wallet. New accounts get a Monad wallet automatically.</p>`}
        <button className="ghost" onClick=${()=>setReview(null)}>Back to the chart</button>`}
    </aside>`}

    ${sheet&&sheet.k==='margin'&&pos&&html`<${CollateralSheet} p=${pos} M=${pM} free=${bk.ledger.free} onDo=${async a=>{const p=pos;if(await gate({title:`${a>=0?'Add':'Remove'} ${fmtUsd(Math.abs(a))} collateral`,desc:`${p.market} ${p.side}`,fn:a>=0?'increasePositionCollateral':'decreasePositionCollateral',tap:true,amt:Math.max(0,a),rows:[['Collateral',`${fmtUsd(p.C)} → ${fmtUsd(p.C+a)}`]]}))bk.margin(p.market,a);}} onClose=${()=>setSheet(null)}/>`}
    ${sheet&&sheet.k==='close'&&pos&&html`<${CloseSheet} p=${pos} M=${pM} onDo=${async f=>{const p=pos;if(await gate({title:`Close ${f>=1?'':Math.round(f*100)+'% of '}${p.market} ${p.side}`,desc:'Closes at the current market price.',fn:'execOrder (reduce-only)',tap:true,rows:[['Quantity',`${fmtQ(f>=1?p.q:p.q*f,MK[p.market])} ${p.market}`]]}))bk.close(p.market,f);}} onClose=${()=>setSheet(null)}/>`}
    ${sheet&&sheet.k==='account'&&authed&&html`<${AccountSheet} bk=${bk} marks=${marks} px=${px} gate=${gate} openTap=${()=>setSheet(null)||setTapOffer(true)} onClose=${()=>setSheet(null)}/>`}
    ${tapOffer&&html`<${OneTapSheet} px=${px} toast=${bk.toast} onClose=${()=>setTapOffer(false)}/>`}
    ${tapBanner&&!tapOffer&&!sheet&&!review&&!px.modal&&!px.tapOn()&&html`<div className="tapban" role="status"><span className="bolt">${Bolt}</span><span>Trade without the pop-up for 24 hours?<small>Only on Perpl, up to $1,000 per trade.</small></span><button className="ghost solid" onClick=${()=>{setTapBanner(false);setTapOffer(true);}}>Turn on</button><button className="x" aria-label="Not now" onClick=${()=>setTapBanner(false)}>×</button></div>`}
    <${PrivyLayer} px=${px} onCredit=${bk.credit}/>
    <div className="toasts" aria-live="polite" hidden=${!!(sheet||review||px.modal||tapOffer||tapBanner)}>${bk.toasts.map(t=>html`<div key=${t.id} className=${'toast '+t.kind}>${t.t}</div>`)}</div>
  </div>`;
}
