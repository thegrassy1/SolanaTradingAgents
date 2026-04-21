/** Self-contained trading dashboard (inline CSS/JS + Chart.js CDN). */

const SOL_M = 'So11111111111111111111111111111111111111112';
const USDC_M = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

export function getDashboardHtml(): string {
  const css = `
:root{
  --bg:#0a0e13;
  --bg-2:#0f141b;
  --card:#141a23;
  --card-2:#1a222d;
  --bd:#222c39;
  --bd-2:#2d3a4b;
  --txt:#e6edf3;
  --txt-2:#a8b3c1;
  --muted:#6e7a8a;
  --ok:#22c55e;
  --ok-bg:rgba(34,197,94,.12);
  --bad:#ef4444;
  --bad-bg:rgba(239,68,68,.12);
  --acc:#3b82f6;
  --acc-bg:rgba(59,130,246,.12);
  --live:#f59e0b;
  --live-bg:rgba(245,158,11,.14);
  --purple:#a855f7;
  --shadow:0 1px 2px rgba(0,0,0,.2),0 8px 24px rgba(0,0,0,.25);
  --radius:12px;
  --radius-sm:8px;
  --mono:ui-monospace,SFMono-Regular,"SF Mono",Menlo,Consolas,"Liberation Mono",monospace;
}
*{box-sizing:border-box}
html,body{height:100%}
body{
  margin:0;
  font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;
  background:
    radial-gradient(1200px 600px at 80% -10%,rgba(59,130,246,.08),transparent 60%),
    radial-gradient(900px 500px at -10% 10%,rgba(168,85,247,.06),transparent 60%),
    var(--bg);
  color:var(--txt);
  font-size:14px;
  line-height:1.5;
  -webkit-font-smoothing:antialiased;
  padding:16px;
  padding-bottom:120px;
}

/* Topbar */
.topbar{
  display:flex;flex-wrap:wrap;align-items:center;gap:10px 14px;
  padding:12px 16px;margin-bottom:16px;
  background:linear-gradient(180deg,var(--card) 0%,var(--card-2) 100%);
  border:1px solid var(--bd);border-radius:var(--radius);
  box-shadow:var(--shadow);
  position:sticky;top:8px;z-index:30;
  backdrop-filter:blur(6px);
}
.brand{display:flex;align-items:center;gap:10px;font-weight:700;font-size:15px;letter-spacing:.01em}
.brand .logo{
  width:28px;height:28px;border-radius:8px;
  background:linear-gradient(135deg,#3b82f6 0%,#a855f7 100%);
  display:inline-flex;align-items:center;justify-content:center;
  color:#fff;font-weight:800;font-size:13px;
  box-shadow:0 4px 12px rgba(59,130,246,.35);
}
.spacer{flex:1 1 auto}

.badge{
  font-size:11px;font-weight:700;letter-spacing:.08em;
  padding:6px 10px;border-radius:999px;border:1px solid var(--bd);
  display:inline-flex;align-items:center;gap:6px;text-transform:uppercase;
}
.badge-paper{color:#60a5fa;border-color:rgba(96,165,250,.35);background:var(--acc-bg)}
.badge-live{color:var(--live);border-color:rgba(245,158,11,.4);background:var(--live-bg)}
.badge-status{color:var(--txt-2);background:var(--card-2)}
.dot{width:8px;height:8px;border-radius:50%;display:inline-block}
.dot-on{background:var(--ok);box-shadow:0 0 0 3px rgba(34,197,94,.18)}
.dot-off{background:var(--bad);box-shadow:0 0 0 3px rgba(239,68,68,.15)}
.dot.pulse{animation:pulse 1.8s ease-in-out infinite}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:.55}}

.meta{font-size:12px;color:var(--muted)}
.meta.mono{font-family:var(--mono)}

.select,.input,.btn{
  min-height:36px;padding:0 12px;border-radius:var(--radius-sm);
  border:1px solid var(--bd);background:var(--bg-2);color:var(--txt);
  font-size:13px;font-weight:500;cursor:pointer;
  transition:border-color .15s ease,background .15s ease,transform .05s ease;
}
.select:hover,.btn:hover{border-color:var(--bd-2);background:var(--card-2)}
.select:focus,.input:focus,.btn:focus{outline:none;border-color:var(--acc);box-shadow:0 0 0 3px rgba(59,130,246,.2)}
.btn:active{transform:translateY(1px)}
.btn.primary{background:linear-gradient(180deg,#3b82f6,#2563eb);border-color:#2563eb;color:#fff}
.btn.primary:hover{background:linear-gradient(180deg,#4f90f9,#2b6fe6);border-color:#2563eb}
.btn.danger{color:#fca5a5;border-color:rgba(239,68,68,.35)}
.btn.danger:hover{background:rgba(239,68,68,.1);color:#fecaca}
.btn.ghost{background:transparent}

/* Layout */
.grid{display:grid;gap:16px}
.hero{grid-template-columns:repeat(3,minmax(0,1fr))}
.split{grid-template-columns:1fr 1fr}
.wide{grid-template-columns:2fr 1fr}
@media(max-width:1100px){
  .wide{grid-template-columns:1fr}
  .hero{grid-template-columns:1fr 1fr}
}
@media(max-width:760px){
  .hero,.split{grid-template-columns:1fr}
  body{padding:12px;padding-bottom:120px}
}

/* Cards */
.card{
  background:linear-gradient(180deg,var(--card) 0%,var(--card-2) 100%);
  border:1px solid var(--bd);border-radius:var(--radius);
  padding:18px;box-shadow:var(--shadow);
  position:relative;overflow:hidden;
}
.card.accent-price::before{
  content:"";position:absolute;inset:0 0 auto 0;height:2px;
  background:linear-gradient(90deg,#3b82f6,#a855f7);opacity:.7;
}
.card.accent-port::before{
  content:"";position:absolute;inset:0 0 auto 0;height:2px;
  background:linear-gradient(90deg,#22c55e,#3b82f6);opacity:.7;
}
.card.accent-risk::before{
  content:"";position:absolute;inset:0 0 auto 0;height:2px;
  background:linear-gradient(90deg,#f59e0b,#ef4444);opacity:.7;
}
.card h2{
  margin:0 0 14px;font-size:11px;font-weight:700;letter-spacing:.12em;
  color:var(--muted);text-transform:uppercase;
  display:flex;align-items:center;gap:8px;
}
.card h2 .count{
  margin-left:auto;background:var(--card-2);color:var(--txt-2);
  padding:2px 8px;border-radius:999px;font-size:10px;letter-spacing:.05em;
  border:1px solid var(--bd);
}

.val-xl{
  font-family:var(--mono);font-size:2.1rem;font-weight:600;
  letter-spacing:-.02em;line-height:1.1;
}
.val-xl .unit{font-size:1rem;color:var(--muted);margin-right:4px;font-weight:500}
.val-lg{font-family:var(--mono);font-size:1.4rem;font-weight:600;letter-spacing:-.01em}
.val-md{font-family:var(--mono);font-size:1rem;font-weight:500}
.trend{
  display:inline-flex;align-items:center;gap:4px;
  padding:3px 8px;border-radius:999px;font-size:12px;font-weight:600;
  font-family:var(--mono);margin-top:6px;
}
.trend.pos{color:var(--ok);background:var(--ok-bg)}
.trend.neg{color:var(--bad);background:var(--bad-bg)}
.trend.neu{color:var(--txt-2);background:var(--card-2)}

.kpis{
  display:grid;grid-template-columns:repeat(3,minmax(0,1fr));
  gap:10px;margin-top:14px;
}
.kpi{
  background:var(--bg-2);border:1px solid var(--bd);border-radius:var(--radius-sm);
  padding:10px 12px;min-width:0;
}
.kpi .k{font-size:10px;color:var(--muted);text-transform:uppercase;letter-spacing:.08em;font-weight:600}
.kpi .v{font-family:var(--mono);font-size:14px;margin-top:4px;font-weight:500}
.pos{color:var(--ok)}.neg{color:var(--bad)}.neu{color:var(--txt)}

.balances{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:12px}
.bal{
  background:var(--bg-2);border:1px solid var(--bd);border-radius:var(--radius-sm);
  padding:10px 12px;
}
.bal .sym{font-size:11px;color:var(--muted);font-weight:700;letter-spacing:.05em;text-transform:uppercase}
.bal .amt{font-family:var(--mono);font-size:14px;margin-top:2px;font-weight:500}
.bal .usd{font-family:var(--mono);font-size:11px;color:var(--muted);margin-top:2px}

.progress{
  height:6px;background:var(--bg-2);border-radius:999px;overflow:hidden;margin-top:10px;
  border:1px solid var(--bd);
}
.progress > div{
  height:100%;border-radius:999px;
  background:linear-gradient(90deg,#22c55e,#f59e0b 70%,#ef4444);
  transition:width .3s ease;
}

/* Chart */
.chart-wrap{height:280px;position:relative;margin-top:4px}
@media(max-width:760px){.chart-wrap{height:220px}}

/* Positions */
.pos-list{margin:0;padding:0;list-style:none;display:grid;gap:10px;max-height:460px;overflow-y:auto}
.pos-item{
  border:1px solid var(--bd);border-radius:var(--radius-sm);
  padding:12px;background:var(--bg-2);
  display:grid;gap:8px;position:relative;
  border-left:3px solid var(--bd-2);
}
.pos-item.win{border-left-color:var(--ok)}
.pos-item.lose{border-left-color:var(--bad)}
.pos-head{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.pos-sym{font-weight:700;font-size:14px}
.pos-pnl{
  margin-left:auto;font-family:var(--mono);font-weight:600;font-size:14px;
  padding:3px 8px;border-radius:6px;
}
.pos-pnl.pos{background:var(--ok-bg)}
.pos-pnl.neg{background:var(--bad-bg)}
.pos-details{display:grid;grid-template-columns:repeat(3,1fr);gap:6px;font-size:12px}
.pos-details .lbl{color:var(--muted);font-size:10px;text-transform:uppercase;letter-spacing:.06em;font-weight:600}
.pos-details .v{font-family:var(--mono);margin-top:2px}
.pos-actions{display:flex;gap:8px}
.pos-item .btn{min-height:32px;font-size:12px;padding:0 10px}

.empty{
  padding:24px 12px;text-align:center;color:var(--muted);
  border:1px dashed var(--bd);border-radius:var(--radius-sm);
  font-size:13px;
}

/* Trades */
.trades{max-height:460px;overflow-y:auto}
.trade{
  display:grid;grid-template-columns:auto 1fr auto;gap:12px;align-items:center;
  padding:10px 0;border-bottom:1px solid var(--bd);
}
.trade:last-child{border-bottom:0}
.trade-time{font-family:var(--mono);color:var(--muted);font-size:11px;white-space:nowrap}
.trade-body{min-width:0;font-size:13px}
.trade-dir{
  display:inline-block;font-size:10px;font-weight:800;letter-spacing:.08em;
  padding:2px 7px;border-radius:4px;margin-right:6px;
}
.trade-dir.buy{background:var(--ok-bg);color:var(--ok)}
.trade-dir.sell{background:var(--bad-bg);color:var(--bad)}
.trade-flow{font-family:var(--mono);font-size:12px}
.trade-reason{font-size:11px;color:var(--muted);margin-top:2px}
.trade-pnl-wrap{display:flex;flex-direction:column;align-items:flex-end;gap:2px}
.trade-pnl{
  font-family:var(--mono);font-size:13px;font-weight:600;
  padding:3px 8px;border-radius:6px;text-align:right;white-space:nowrap;
}
.trade-pnl.pos{background:var(--ok-bg);color:var(--ok)}
.trade-pnl.neg{background:var(--bad-bg);color:var(--bad)}
.trade-pnl.neu{color:var(--muted)}
.trade-sub{font-family:var(--mono);font-size:10px;color:var(--muted);white-space:nowrap}
.trade-sub.pos{color:#4ade80aa}
.trade-sub.neg{color:#f87171aa}
.tag{
  display:inline-block;font-size:9px;font-weight:800;letter-spacing:.1em;
  padding:1px 5px;border-radius:3px;margin-right:4px;text-transform:uppercase;
  background:var(--card-2);color:var(--muted);border:1px solid var(--bd);
}
.tag.net{background:var(--acc-bg);color:#60a5fa;border-color:rgba(96,165,250,.35)}
.tag.gross{background:var(--card-2);color:var(--muted)}

/* Controls drawer */
.fab{
  position:fixed;right:16px;bottom:16px;z-index:40;
  display:inline-flex;align-items:center;gap:8px;
  padding:12px 18px;border-radius:999px;
  background:linear-gradient(135deg,#3b82f6 0%,#2563eb 100%);
  color:#fff;font-weight:700;font-size:14px;border:none;cursor:pointer;
  box-shadow:0 8px 24px rgba(59,130,246,.4),0 2px 6px rgba(0,0,0,.3);
  transition:transform .15s ease,box-shadow .15s ease;
}
.fab:hover{transform:translateY(-1px);box-shadow:0 12px 28px rgba(59,130,246,.5),0 2px 6px rgba(0,0,0,.3)}
.fab svg{width:18px;height:18px}

.drawer-back{
  position:fixed;inset:0;background:rgba(0,0,0,.5);
  opacity:0;pointer-events:none;transition:opacity .2s ease;z-index:45;
  backdrop-filter:blur(3px);
}
.drawer-back.open{opacity:1;pointer-events:auto}

.drawer{
  position:fixed;left:0;right:0;bottom:0;z-index:50;
  background:var(--card);border-top:1px solid var(--bd);
  border-radius:16px 16px 0 0;
  padding:20px;max-height:80vh;overflow-y:auto;
  transform:translateY(100%);transition:transform .25s ease;
  box-shadow:0 -12px 40px rgba(0,0,0,.5);
}
.drawer.open{transform:translateY(0)}
.drawer-head{display:flex;align-items:center;gap:10px;margin-bottom:16px}
.drawer-head h3{margin:0;font-size:16px;font-weight:700}
.drawer-close{
  margin-left:auto;background:var(--card-2);border:1px solid var(--bd);color:var(--txt);
  width:32px;height:32px;border-radius:8px;cursor:pointer;font-size:18px;line-height:1;
}

.form-grid{display:grid;gap:12px;grid-template-columns:1fr 1fr 1fr}
@media(max-width:760px){.form-grid{grid-template-columns:1fr}}
.field label{
  display:block;font-size:11px;color:var(--muted);text-transform:uppercase;
  letter-spacing:.08em;font-weight:600;margin-bottom:6px;
}
.field-row{display:flex;gap:6px}
.field-row .input{flex:1 1 auto;min-width:0}

.actions-row{display:flex;flex-wrap:wrap;gap:8px;margin-top:16px;padding-top:16px;border-top:1px solid var(--bd)}
.warn{
  font-size:12px;color:var(--live);margin-top:10px;
  background:var(--live-bg);border:1px solid rgba(245,158,11,.3);
  padding:8px 10px;border-radius:var(--radius-sm);
}
.warn:empty{display:none}

/* Scrollbar */
::-webkit-scrollbar{width:8px;height:8px}
::-webkit-scrollbar-track{background:transparent}
::-webkit-scrollbar-thumb{background:var(--bd-2);border-radius:999px}
::-webkit-scrollbar-thumb:hover{background:#3a4a5e}
`;

  const js = `
(function(){
var SOL='${SOL_M}',USDC='${USDC_M}';
var refreshMs=10000,timer=null,priceChart=null;

function fmtUsd(n){if(n==null||!isFinite(n))return'\u2014';return '$'+Number(n).toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2})}
function fmtNum(n,d){if(n==null||!isFinite(n))return'\u2014';return Number(n).toLocaleString(undefined,{minimumFractionDigits:d||2,maximumFractionDigits:d||2})}
function fmtSol(n){if(n==null||!isFinite(n))return'\u2014';return Number(n).toLocaleString(undefined,{minimumFractionDigits:4,maximumFractionDigits:4})}
function fmtPct(n){if(n==null||!isFinite(n))return'\u2014';return n.toFixed(2)+'%'}
function sign(n){return n>=0?'+':''}
function clsPnL(n){if(n==null||!isFinite(n))return'neu';return n>=0?'pos':'neg'}
function arrow(n){if(n==null||!isFinite(n))return'';return n>=0?'\u25B2':'\u25BC'}
async function jget(url){try{var r=await fetch(url);if(!r.ok)throw new Error('HTTP'+r.status);return await r.json()}catch(e){return null}}
function setText(id,t){var el=document.getElementById(id);if(el)el.textContent=t==null?'\u2014':String(t)}
function setHtml(id,t){var el=document.getElementById(id);if(el)el.innerHTML=t}
function setCls(id,c){var el=document.getElementById(id);if(el)el.className=c}
function shortMint(m){if(!m)return'';return m.slice(0,4)+'\u2026'+m.slice(-4)}
function tokenLabel(m){if(m===SOL)return'SOL';if(m===USDC)return'USDC';return shortMint(m)}
function rawToHuman(mint,raw){var b=BigInt(raw||'0');if(mint===SOL)return Number(b)/1e9;if(mint===USDC)return Number(b)/1e6;return Number(b)}
function tradeDir(t){if(t.inputMint===SOL&&t.outputMint===USDC)return'SELL';if(t.inputMint===USDC&&t.outputMint===SOL)return'BUY';return t.inputMint===SOL?'SELL':'BUY'}
function fmtTok(m,v){if(m===SOL)return fmtSol(v)+' SOL';if(m===USDC)return '$'+fmtNum(v,2);return fmtNum(v,4)}
function normTrade(t){return{timestamp:t.timestamp,inputMint:t.input_mint||t.inputMint,outputMint:t.output_mint||t.outputMint,inputAmount:t.input_amount||t.inputAmount,outputAmount:t.output_amount||t.outputAmount,exitReason:t.exit_reason||t.exitReason,realizedPnl:t.realized_pnl!=null?t.realized_pnl:t.realizedPnl,realizedPnlGross:t.realized_pnl_gross!=null?t.realized_pnl_gross:t.realizedPnlGross,realizedPnlNet:t.realized_pnl_net!=null?t.realized_pnl_net:t.realizedPnlNet,feesQuote:t.fees_quote!=null?t.fees_quote:t.feesQuote,status:t.status}}
function fmtTime(iso){try{var d=new Date(iso);return d.toLocaleTimeString(undefined,{hour:'2-digit',minute:'2-digit',second:'2-digit'})}catch(x){return'\u2014'}}
async function postJson(url,body){var r=await fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});return r.json()}

function rollingAvg(prices,n){
  return prices.map(function(_,i){
    if(i<n-1)return null;
    var s=0;for(var j=i-n+1;j<=i;j++)s+=prices[j];
    return s/n;
  });
}
function renderChart(points){
  var canvas=document.getElementById('priceChart');
  if(!canvas||typeof Chart==='undefined')return;
  var prices=points.map(function(p){return p.price});
  var smaData=rollingAvg(prices,20);
  var labels=points.map(function(p){
    var d=new Date(p.t);
    return d.toLocaleTimeString(undefined,{hour:'2-digit',minute:'2-digit'});
  });
  var ctx=canvas.getContext('2d');
  var grad=ctx.createLinearGradient(0,0,0,canvas.clientHeight);
  grad.addColorStop(0,'rgba(59,130,246,0.35)');
  grad.addColorStop(1,'rgba(59,130,246,0)');
  if(priceChart){
    priceChart.data.labels=labels;
    priceChart.data.datasets[0].data=prices;
    priceChart.data.datasets[0].backgroundColor=grad;
    priceChart.data.datasets[1].data=smaData;
    priceChart.update('none');return;
  }
  priceChart=new Chart(ctx,{
    type:'line',
    data:{labels:labels,datasets:[
      {label:'SOL/USDC',data:prices,borderColor:'#3b82f6',backgroundColor:grad,fill:true,tension:0.3,pointRadius:0,borderWidth:2.2},
      {label:'SMA 20',data:smaData,borderColor:'rgba(168,85,247,0.8)',borderDash:[5,3],borderWidth:1.5,pointRadius:0,fill:false,spanGaps:false}
    ]},
    options:{
      responsive:true,maintainAspectRatio:false,
      interaction:{mode:'index',intersect:false},
      plugins:{
        legend:{display:true,position:'bottom',labels:{color:'#a8b3c1',boxWidth:10,boxHeight:10,font:{size:11}}},
        tooltip:{
          backgroundColor:'#141a23',borderColor:'#2d3a4b',borderWidth:1,
          titleColor:'#e6edf3',bodyColor:'#a8b3c1',padding:10,
          callbacks:{
            title:function(items){return items[0]?items[0].label:''},
            label:function(c){return c.dataset.label+': $'+Number(c.parsed.y).toFixed(2)}
          }
        }
      },
      scales:{
        x:{display:true,ticks:{color:'#6e7a8a',maxTicksLimit:8,maxRotation:0,font:{size:10}},grid:{color:'rgba(45,58,75,0.3)'}},
        y:{ticks:{color:'#6e7a8a',maxTicksLimit:5,font:{size:11},callback:function(v){return '$'+Number(v).toFixed(2)}},grid:{color:'rgba(45,58,75,0.4)'}}
      }
    }
  });
}

async function refresh(){
  var st=await jget('/status'),pos=await jget('/positions'),risk=await jget('/risk'),hist=await jget('/history?limit=12'),series=await jget('/prices/recent?limit=200');
  document.getElementById('updated').textContent='Updated '+new Date().toLocaleTimeString();

  if(st){
    var isLive=st.mode==='live';
    setText('modeBadge',isLive?'LIVE':'PAPER');
    setCls('modeBadge','badge '+(isLive?'badge-live':'badge-paper'));
    setCls('runDot','dot '+(st.running?'dot-on pulse':'dot-off'));
    setText('runTxt',st.running?'Running':'Stopped');

    var lp=st.latestPrice,ch=st.priceChange;
    setText('priceMain',lp!=null?fmtUsd(lp):'\u2014');
    if(ch!=null){
      var el=document.getElementById('priceChg');
      el.textContent=arrow(ch)+' '+sign(ch)+fmtPct(ch);
      el.className='trend '+clsPnL(ch);
    } else setHtml('priceChg','<span class="trend neu">\u2014</span>');

    var sma=st.sma,vol=st.volatility;
    var dev=(lp!=null&&sma!=null)?((lp-sma)/sma)*100:null;
    setHtml('kpiPrice',
      '<div class="kpi"><div class="k">SMA 20</div><div class="v">'+(sma!=null?fmtUsd(sma):'\u2014')+'</div></div>'+
      '<div class="kpi"><div class="k">Dev vs SMA</div><div class="v '+clsPnL(dev)+'">'+(dev!=null?sign(dev)+fmtPct(dev):'\u2014')+'</div></div>'+
      '<div class="kpi"><div class="k">Volatility</div><div class="v">'+(vol!=null?fmtPct(vol*100):'\u2014')+'</div></div>'
    );

    var pnl=st.paperPortfolio&&st.paperPortfolio.pnl;
    if(pnl){
      setText('portVal',fmtUsd(pnl.currentValue));
      var pEl=document.getElementById('portPnl');
      pEl.textContent=arrow(pnl.pnl)+' '+sign(pnl.pnl)+fmtUsd(pnl.pnl)+' ('+sign(pnl.pnlPercent)+fmtPct(pnl.pnlPercent)+')';
      pEl.className='trend '+clsPnL(pnl.pnl);
      setHtml('kpiPort',
        '<div class="kpi"><div class="k">Initial</div><div class="v">'+fmtUsd(pnl.initialValue)+'</div></div>'+
        '<div class="kpi"><div class="k">P&amp;L</div><div class="v '+clsPnL(pnl.pnl)+'">'+sign(pnl.pnl)+fmtUsd(pnl.pnl)+'</div></div>'+
        '<div class="kpi"><div class="k">Return</div><div class="v '+clsPnL(pnl.pnlPercent)+'">'+sign(pnl.pnlPercent)+fmtPct(pnl.pnlPercent)+'</div></div>'
      );
    } else {
      setText('portVal','\u2014');setHtml('portPnl','<span class="trend neu">\u2014</span>');setHtml('kpiPort','');
    }

    var balHtml='';
    if(st.paperPortfolio&&st.paperPortfolio.balances){
      var px=lp||0;
      for(var mint in st.paperPortfolio.balances){
        var h=st.paperPortfolio.balances[mint].human;
        var usd=mint===SOL?h*px:(mint===USDC?h:0);
        balHtml+='<div class="bal"><div class="sym">'+tokenLabel(mint)+'</div><div class="amt">'+(mint===SOL?fmtSol(h)+' SOL':'$'+fmtNum(h,2))+'</div><div class="usd">\u2248 '+fmtUsd(usd)+'</div></div>';
      }
    }
    setHtml('balances',balHtml||'<div class="empty">No balances</div>');
  }

  if(series&&series.points&&series.points.length){
    renderChart(series.points);
  } else if(priceChart){
    priceChart.data.labels=[];priceChart.data.datasets[0].data=[];priceChart.data.datasets[1].data=[];priceChart.update();
  }

  var list=document.getElementById('posList');var posCount=(pos&&pos.positions&&pos.positions.length)||0;
  setText('posCount',posCount?posCount+' open':'none');
  if(posCount){
    var cur=st&&st.latestPrice;
    list.innerHTML='';
    pos.positions.forEach(function(p){
      var li=document.createElement('li');
      var gross=p.unrealizedPnlGross!=null?p.unrealizedPnlGross:p.unrealizedPnlQuote;
      var net=p.unrealizedPnlNet!=null?p.unrealizedPnlNet:gross;
      var pnlCls=clsPnL(net);
      li.className='pos-item '+(net>0?'win':net<0?'lose':'');
      var sizeHuman=rawToHuman(p.mint,p.amount||p.sizeRaw||p.size||'0');
      var spent=p.entryQuoteAmount!=null?('spent '+fmtUsd(p.entryQuoteAmount)):'';
      li.innerHTML=
        '<div class="pos-head"><span class="pos-sym">'+tokenLabel(p.mint)+'</span>'+
        '<span class="meta mono">entry '+fmtUsd(p.entryPrice)+' \u2192 '+(cur!=null?fmtUsd(cur):'\u2014')+(spent?' \u00b7 '+spent:'')+'</span>'+
        '<span class="pos-pnl '+pnlCls+'"><span class="tag net">NET</span>'+arrow(net)+' '+sign(net)+fmtUsd(net)+'</span></div>'+
        (p.unrealizedPnlNet!=null&&Math.abs(gross-net)>0.0001?
          '<div class="meta mono" style="margin-top:-2px"><span class="tag gross">GROSS</span>'+sign(gross)+fmtUsd(gross)+' \u00b7 est. exit fees '+fmtUsd(Math.max(0,gross-net))+'</div>'
          :'')+
        '<div class="pos-details">'+
          '<div><div class="lbl">Stop loss</div><div class="v neg">'+fmtUsd(p.stopLossPrice)+'</div></div>'+
          '<div><div class="lbl">Take profit</div><div class="v pos">'+fmtUsd(p.takeProfitPrice)+'</div></div>'+
          '<div><div class="lbl">Size</div><div class="v">'+fmtSol(sizeHuman)+' SOL</div></div>'+
        '</div>'+
        '<div class="pos-actions"><button type="button" class="btn danger" data-id="'+p.id+'">Close position</button></div>';
      list.appendChild(li);
    });
    list.querySelectorAll('button[data-id]').forEach(function(btn){
      btn.onclick=function(){
        var id=btn.getAttribute('data-id');
        if(!id||!confirm('Close this position?'))return;
        postJson('/positions/close',{positionId:id,reason:'dashboard'}).then(function(){refresh()});
      };
    });
  } else {
    list.innerHTML='<div class="empty">No open positions</div>';
  }

  if(risk){
    var drGross=risk.dailyRealizedPnL||0;
    var drNet=risk.dailyRealizedPnLNet!=null?risk.dailyRealizedPnLNet:drGross;
    var fees=risk.paperFees||{};
    setHtml('kpiRisk',
      '<div class="kpi"><div class="k">Daily P&amp;L (net)</div><div class="v '+clsPnL(drNet)+'">'+sign(drNet)+fmtUsd(drNet)+'</div>'+
        (Math.abs(drGross-drNet)>0.0001?'<div class="meta mono" style="font-size:10px;margin-top:2px"><span class="tag gross">GROSS</span>'+sign(drGross)+fmtUsd(drGross)+'</div>':'')+
      '</div>'+
      '<div class="kpi"><div class="k">Cooldown</div><div class="v">'+(st&&st.cooldownRemaining>0?st.cooldownRemaining+'s':'None')+'</div></div>'+
      '<div class="kpi"><div class="k">Open</div><div class="v">'+(st?st.openPositionsCount:0)+' / '+risk.maxOpenPositions+'</div></div>'
    );
    setHtml('riskDetail',
      '<div class="kpi"><div class="k">Stop loss</div><div class="v">'+(Number(risk.stopLossPercent)*100).toFixed(2)+'%</div></div>'+
      '<div class="kpi"><div class="k">Take profit</div><div class="v">'+(Number(risk.takeProfitPercent)*100).toFixed(2)+'%</div></div>'+
      '<div class="kpi"><div class="k">Risk / trade</div><div class="v">'+(Number(risk.riskPerTradePercent)*100).toFixed(2)+'%</div></div>'
    );
    var feeLabel='';
    if(fees&&fees.takerFeeBps!=null){
      var feeSolLam=(fees.networkFeeLamports||0)+(fees.priorityFeeLamports||0);
      feeLabel='Paper fees: '+fees.takerFeeBps+' bps taker + '+feeSolLam.toLocaleString()+' lamports/tx SOL';
    }
    setText('feeConfig',feeLabel||'\u2014');

    var start=risk.dailyStartingValueQuote||0;var dr=drNet;var lim=Number(risk.maxDailyLossPercent)||0;
    var w=document.getElementById('riskWarn');w.textContent='';
    var bar=document.getElementById('riskBar');
    if(start>0&&lim>0){
      var lossRatio=dr<0?-dr/start:0;
      var pct=Math.min(100,(lossRatio/lim)*100);
      bar.style.width=pct.toFixed(1)+'%';
      setText('riskLimit','Max daily loss '+fmtPct(lim*100)+' \u00b7 using '+fmtPct(pct)+' of budget (net)');
      if(lossRatio>=lim*0.8) w.textContent='Daily loss at '+fmtPct(lossRatio*100)+' of start NAV (max '+fmtPct(lim*100)+')';
    } else {
      bar.style.width='0%';setText('riskLimit','Max daily loss '+fmtPct(lim*100));
    }
  }

  var th=document.getElementById('trades');
  if(hist&&hist.length){
    th.innerHTML='';
    hist.slice().reverse().forEach(function(tr){
      var t=normTrade(tr);
      var dir=tradeDir(t);
      var inH=rawToHuman(t.inputMint,t.inputAmount),outH=rawToHuman(t.outputMint,t.outputAmount);
      var gross=(t.realizedPnlGross!=null)?t.realizedPnlGross:t.realizedPnl;
      var net=(t.realizedPnlNet!=null)?t.realizedPnlNet:null;
      var hasClose=(gross!=null&&isFinite(gross))||(net!=null&&isFinite(net));
      var pnlHtml;
      if(hasClose){
        var primary=(net!=null&&isFinite(net))?net:gross;
        var primaryTag=(net!=null&&isFinite(net))?'<span class="tag net">NET</span>':'<span class="tag gross">GROSS</span>';
        var sub='';
        if(net!=null&&isFinite(net)&&gross!=null&&isFinite(gross)&&Math.abs(gross-net)>0.0001){
          sub='<div class="trade-sub">gross '+sign(gross)+fmtUsd(gross)+(t.feesQuote!=null?' \u00b7 fees '+fmtUsd(t.feesQuote):'')+'</div>';
        } else if(t.feesQuote!=null&&t.feesQuote>0){
          sub='<div class="trade-sub">fees '+fmtUsd(t.feesQuote)+'</div>';
        }
        pnlHtml='<div class="trade-pnl-wrap"><div class="trade-pnl '+clsPnL(primary)+'">'+primaryTag+sign(primary)+fmtUsd(primary)+'</div>'+sub+'</div>';
      } else if(t.feesQuote!=null&&t.feesQuote>0){
        pnlHtml='<div class="trade-pnl-wrap"><div class="trade-pnl neu">\u2014</div><div class="trade-sub">fees '+fmtUsd(t.feesQuote)+'</div></div>';
      } else {
        pnlHtml='<div class="trade-pnl neu">\u2014</div>';
      }
      var div=document.createElement('div');
      div.className='trade';
      div.innerHTML=
        '<div class="trade-time">'+fmtTime(t.timestamp)+'</div>'+
        '<div class="trade-body"><span class="trade-dir '+(dir==='BUY'?'buy':'sell')+'">'+dir+'</span>'+
          '<span class="trade-flow">'+fmtTok(t.inputMint,inH)+' \u2192 '+fmtTok(t.outputMint,outH)+'</span>'+
          (t.exitReason?'<div class="trade-reason">'+t.exitReason+'</div>':'')+'</div>'+
        pnlHtml;
      th.appendChild(div);
    });
  } else {
    th.innerHTML='<div class="empty">No trades yet</div>';
  }
}

function armTimer(){if(timer){clearInterval(timer);timer=null}if(refreshMs>0)timer=setInterval(refresh,refreshMs)}

function openDrawer(){document.getElementById('drawer').classList.add('open');document.getElementById('drawerBack').classList.add('open')}
function closeDrawer(){document.getElementById('drawer').classList.remove('open');document.getElementById('drawerBack').classList.remove('open')}

function wire(){
  document.getElementById('btnTh').onclick=function(){var v=document.getElementById('inTh').value;if(v)postJson('/config',{key:'threshold',value:v}).then(function(){document.getElementById('inTh').value='';refresh()})};
  document.getElementById('btnSl').onclick=function(){var v=document.getElementById('inSl').value;if(v)postJson('/config',{key:'stop_loss',value:v}).then(function(){document.getElementById('inSl').value='';refresh()})};
  document.getElementById('btnTp').onclick=function(){var v=document.getElementById('inTp').value;if(v)postJson('/config',{key:'take_profit',value:v}).then(function(){document.getElementById('inTp').value='';refresh()})};
  document.getElementById('btnCloseAll').onclick=function(){if(!confirm('Close ALL open positions?'))return;postJson('/positions/close',{all:true,reason:'dashboard'}).then(function(){refresh()})};
  document.getElementById('btnReset').onclick=function(){if(!confirm('Reset paper portfolio? This cannot be undone.'))return;fetch('/reset',{method:'POST'}).then(function(){refresh()})};
  document.getElementById('selRefresh').onchange=function(){var v=this.value;if(v==='off')refreshMs=0;else refreshMs=parseInt(v,10);armTimer();refresh()};
  document.getElementById('btnRefresh').onclick=refresh;
  document.getElementById('fab').onclick=openDrawer;
  document.getElementById('drawerClose').onclick=closeDrawer;
  document.getElementById('drawerBack').onclick=closeDrawer;
  document.addEventListener('keydown',function(e){if(e.key==='Escape')closeDrawer()});
}

function boot(){wire();refresh();armTimer()}
if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',boot);else boot();
})();`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Solana Trader</title>
<style>${css}</style>
</head>
<body>

<header class="topbar">
  <div class="brand"><span class="logo">S</span>Solana Trader</div>
  <span id="modeBadge" class="badge badge-paper">PAPER</span>
  <span class="badge badge-status"><span id="runDot" class="dot dot-off"></span><span id="runTxt">Stopped</span></span>
  <span class="spacer"></span>
  <span class="meta mono" id="updated">\u2014</span>
  <button type="button" class="btn ghost" id="btnRefresh" title="Refresh now" aria-label="Refresh now">\u21BB</button>
  <select id="selRefresh" class="select" aria-label="Auto-refresh interval">
    <option value="5000">5s</option>
    <option value="10000" selected>10s</option>
    <option value="30000">30s</option>
    <option value="off">Off</option>
  </select>
</header>

<div class="grid hero" style="margin-bottom:16px">
  <section class="card accent-price">
    <h2>Price <span class="count">SOL / USDC</span></h2>
    <div id="priceMain" class="val-xl">\u2014</div>
    <div id="priceChg" class="trend neu">\u2014</div>
    <div id="kpiPrice" class="kpis"></div>
  </section>
  <section class="card accent-port">
    <h2>Portfolio</h2>
    <div id="portVal" class="val-xl">\u2014</div>
    <div id="portPnl" class="trend neu">\u2014</div>
    <div id="kpiPort" class="kpis"></div>
    <div id="balances" class="balances"></div>
  </section>
  <section class="card accent-risk">
    <h2>Risk</h2>
    <div id="kpiRisk" class="kpis" style="margin-top:0"></div>
    <div id="riskDetail" class="kpis"></div>
    <div class="progress"><div id="riskBar" style="width:0%"></div></div>
    <div class="meta mono" id="riskLimit" style="margin-top:8px">\u2014</div>
    <div class="meta mono" id="feeConfig" style="margin-top:4px;font-size:10px">\u2014</div>
    <p id="riskWarn" class="warn"></p>
  </section>
</div>

<section class="card" style="margin-bottom:16px">
  <h2>Price chart <span class="count">last ~100 min</span></h2>
  <div class="chart-wrap"><canvas id="priceChart"></canvas></div>
</section>

<div class="grid wide">
  <section class="card">
    <h2>Open positions <span class="count" id="posCount">\u2014</span></h2>
    <ul id="posList" class="pos-list"></ul>
  </section>
  <section class="card">
    <h2>Recent trades</h2>
    <div id="trades" class="trades"></div>
  </section>
</div>

<button type="button" id="fab" class="fab" aria-label="Open controls">
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.6 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>
  Controls
</button>

<div id="drawerBack" class="drawer-back"></div>
<div id="drawer" class="drawer" role="dialog" aria-label="Controls">
  <div class="drawer-head">
    <h3>Controls</h3>
    <button class="drawer-close" id="drawerClose" aria-label="Close">\u00D7</button>
  </div>

  <div class="form-grid">
    <div class="field">
      <label for="inTh">Threshold %</label>
      <div class="field-row">
        <input id="inTh" class="input" type="text" placeholder="e.g. 2.0"/>
        <button type="button" id="btnTh" class="btn primary">Set</button>
      </div>
    </div>
    <div class="field">
      <label for="inSl">Stop loss</label>
      <div class="field-row">
        <input id="inSl" class="input" type="text" placeholder="e.g. 0.03"/>
        <button type="button" id="btnSl" class="btn primary">Set</button>
      </div>
    </div>
    <div class="field">
      <label for="inTp">Take profit</label>
      <div class="field-row">
        <input id="inTp" class="input" type="text" placeholder="e.g. 0.06"/>
        <button type="button" id="btnTp" class="btn primary">Set</button>
      </div>
    </div>
  </div>

  <div class="actions-row">
    <button type="button" id="btnCloseAll" class="btn danger">Close all positions</button>
    <button type="button" id="btnReset" class="btn danger">Reset paper portfolio</button>
  </div>
</div>

<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.1/dist/chart.umd.min.js" defer></script>
<script defer>${js}</script>
</body>
</html>`;
}
