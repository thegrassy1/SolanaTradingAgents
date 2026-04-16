/** Self-contained mobile-first dashboard HTML (inline CSS/JS + Chart.js CDN). */

const SOL_M = 'So11111111111111111111111111111111111111112';
const USDC_M = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

export function getDashboardHtml(): string {
  const css = `:root{--bg:#0d1117;--card:#161b22;--bd:#30363d;--txt:#c9d1d9;--muted:#8b949e;--ok:#3fb950;--bad:#f85149;--acc:#58a6ff;--live:#f0883e;}
*{box-sizing:border-box}body{margin:0;font-family:system-ui,-apple-system,sans-serif;background:var(--bg);color:var(--txt);font-size:15px;line-height:1.45;padding:12px;padding-bottom:240px}
header{display:flex;flex-wrap:wrap;align-items:center;gap:10px 14px;padding:12px 14px;background:var(--card);border:1px solid var(--bd);border-radius:8px;margin-bottom:12px}
header h1{margin:0;font-size:1.15rem;font-weight:600;flex:1 1 auto}
.badge{font-size:11px;font-weight:700;letter-spacing:.06em;padding:6px 10px;border-radius:6px;border:1px solid var(--bd)}
.badge-paper{color:var(--acc);border-color:#388bfd66;background:#388bfd22}
.badge-live{color:var(--live);border-color:#f0883e66;background:#f0883e22}
.dot{width:10px;height:10px;border-radius:50%;display:inline-block;margin-right:6px;vertical-align:middle}
.dot-on{background:var(--ok)}.dot-off{background:var(--bad)}
.meta{font-size:12px;color:var(--muted)}
.card{background:var(--card);border:1px solid var(--bd);border-radius:8px;padding:14px;margin-bottom:12px}
.card h2{margin:0 0 10px;font-size:11px;font-weight:600;letter-spacing:.08em;color:var(--muted);text-transform:uppercase}
.val-lg{font-size:1.75rem;font-weight:600;letter-spacing:-.02em}
.row{display:flex;flex-wrap:wrap;gap:8px 16px;margin-top:8px;font-size:13px}
.row span{color:var(--muted);font-size:11px;text-transform:uppercase;letter-spacing:.05em;display:block}
.row strong{color:var(--txt);font-size:14px;font-weight:500}
.pos{color:var(--ok)}.neg{color:var(--bad)}.neu{color:var(--txt)}
.chart-wrap{height:180px;position:relative;margin-top:8px}
.pos-list{margin:0;padding:0;list-style:none}
.pos-list li{border:1px solid var(--bd);border-radius:8px;padding:10px;margin-bottom:8px;display:grid;gap:6px;font-size:13px}
.pos-list li button{min-height:44px;padding:0 14px;border-radius:8px;border:1px solid var(--bd);background:var(--bg);color:var(--txt);font-weight:600;cursor:pointer;width:100%}
.pos-list li button:active{opacity:.85}
.trade-row{display:grid;grid-template-columns:72px 1fr;gap:6px;padding:8px 0;border-bottom:1px solid var(--bd);font-size:13px}
.trade-row:last-child{border-bottom:0}
footer.controls{position:fixed;left:0;right:0;bottom:0;background:var(--card);border-top:1px solid var(--bd);padding:12px;z-index:20;max-height:45vh;overflow-y:auto}
footer .row{margin:0 0 8px}
input[type=text]{min-height:44px;padding:0 12px;border-radius:8px;border:1px solid var(--bd);background:var(--bg);color:var(--txt);width:100%;max-width:140px}
footer button{min-height:44px;padding:0 16px;border-radius:8px;border:1px solid var(--bd);background:#21262d;color:var(--txt);font-weight:600;cursor:pointer;margin:4px 4px 0 0}
footer button.primary{border-color:var(--acc);color:var(--acc)}
.warn{font-size:12px;color:var(--live);margin-top:6px}
@media(min-width:900px){.grid-wide{display:grid;grid-template-columns:1fr 1fr;gap:12px;align-items:start}.grid-wide .card{margin-bottom:0}}
`;

  const js = `
(function(){
var SOL='${SOL_M}',USDC='${USDC_M}';
var refreshMs=10000,timer=null,priceChart=null;
function fmtUsd(n){if(n==null||!isFinite(n))return'\u2014';return n.toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2})}
function fmtSol(n){if(n==null||!isFinite(n))return'\u2014';return n.toLocaleString(undefined,{minimumFractionDigits:4,maximumFractionDigits:4})}
function fmtPct(n){if(n==null||!isFinite(n))return'\u2014';return n.toFixed(2)+'%'}
function clsPnL(n){if(n==null||!isFinite(n))return'neu';return n>=0?'pos':'neg'}
async function jget(url){try{var r=await fetch(url);if(!r.ok)throw new Error('HTTP'+r.status);return await r.json()}catch(e){return null}}
function setText(id,t){var el=document.getElementById(id);if(el)el.textContent=t==null?'\u2014':String(t)}
function shortMint(m){if(!m)return'';return m.slice(0,4)+'\u2026'+m.slice(-4)}
function tokenLabel(m){if(m===SOL)return'SOL';if(m===USDC)return'USDC';return shortMint(m)}
function rawToHuman(mint,raw){var b=BigInt(raw||'0');if(mint===SOL)return Number(b)/1e9;if(mint===USDC)return Number(b)/1e6;return Number(b)}
function tradeDir(t){if(t.inputMint===SOL&&t.outputMint===USDC)return'SELL';if(t.inputMint===USDC&&t.outputMint===SOL)return'BUY';return t.inputMint===SOL?'SELL':'BUY'}
function fmtTok(m,v){if(m===SOL)return fmtSol(v);if(m===USDC)return fmtUsd(v);return fmtUsd(v)}
function normTrade(t){return{timestamp:t.timestamp,inputMint:t.input_mint||t.inputMint,outputMint:t.output_mint||t.outputMint,inputAmount:t.input_amount||t.inputAmount,outputAmount:t.output_amount||t.outputAmount,exitReason:t.exit_reason||t.exitReason,realizedPnl:t.realized_pnl!=null?t.realized_pnl:t.realizedPnl,status:t.status}}
function fmtTime(iso){try{var d=new Date(iso);return d.toLocaleTimeString(undefined,{hour:'2-digit',minute:'2-digit',second:'2-digit'})}catch(x){return'\u2014'}}
async function postJson(url,body){var r=await fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});return r.json()}
function renderChart(points){var canvas=document.getElementById('priceChart');if(!canvas||typeof Chart==='undefined')return;var labels=points.map(function(p,i){return''+i});var data=points.map(function(p){return p.price});
if(priceChart){priceChart.data.labels=labels;priceChart.data.datasets[0].data=data;priceChart.update('none');return}
var ctx=canvas.getContext('2d');priceChart=new Chart(ctx,{type:'line',data:{labels:labels,datasets:[{label:'SOL/USDC',data:data,borderColor:'#58a6ff',backgroundColor:'rgba(88,166,255,0.08)',fill:true,tension:0.25,pointRadius:0,borderWidth:2}]},options:{responsive:true,maintainAspectRatio:false,plugins:{legend:{display:false}},scales:{x:{display:false},y:{ticks:{color:'#8b949e',maxTicksLimit:5},grid:{color:'#30363d'}}}}})}
async function refresh(){
var st=await jget('/status'),pos=await jget('/positions'),risk=await jget('/risk'),hist=await jget('/history?limit=10'),series=await jget('/prices/recent?limit=50');
await jget('/positions/closed?limit=10');
document.getElementById('updated').textContent=new Date().toLocaleString();
if(st){setText('modeBadge',st.mode==='live'?'LIVE':'PAPER');var mb=document.getElementById('modeBadge');mb.className='badge '+(st.mode==='live'?'badge-live':'badge-paper');
document.getElementById('runDot').className='dot '+(st.running?'dot-on':'dot-off');setText('runTxt',st.running?'Running':'Stopped');
var lp=st.latestPrice;if(lp!=null){setText('priceMain',fmtUsd(lp));var ch=st.priceChange;if(ch!=null){setText('priceChg',(ch>=0?'+':'')+fmtPct(ch));document.getElementById('priceChg').className=(ch>=0?'pos':'neg')}}else{setText('priceMain','\u2014');setText('priceChg','\u2014')}
var sma=st.sma,vol=st.volatility;if(lp!=null&&sma!=null){var dev=((lp-sma)/sma)*100;setText('smaVal',fmtUsd(sma));setText('devVal',(dev>=0?'+':'')+fmtPct(dev));document.getElementById('devVal').className=clsPnL(dev)}else{setText('smaVal','\u2014');setText('devVal','\u2014')}
setText('volVal',st.volatility!=null?fmtPct(st.volatility*100):'\u2014');
var pnl=st.paperPortfolio&&st.paperPortfolio.pnl;if(pnl){setText('portVal',fmtUsd(pnl.currentValue));setText('portPnl',(pnl.pnl>=0?'+':'')+fmtUsd(pnl.pnl));setText('portPct',(pnl.pnlPercent>=0?'+':'')+fmtPct(pnl.pnlPercent));document.getElementById('portPnl').className=clsPnL(pnl.pnl);document.getElementById('portPct').className=clsPnL(pnl.pnlPercent)}else{setText('portVal','\u2014');setText('portPnl','\u2014');setText('portPct','\u2014')}
var balEl=document.getElementById('balances');balEl.innerHTML='';
if(st&&st.paperPortfolio&&st.paperPortfolio.balances){var px=st.latestPrice||0;for(var mint in st.paperPortfolio.balances){var h=st.paperPortfolio.balances[mint].human;var usd=mint===SOL?h*px:(mint===USDC?h:0);var row=document.createElement('div');row.className='row';row.innerHTML='<div><span>'+tokenLabel(mint)+'</span><strong>'+(mint===SOL?fmtSol(h):fmtUsd(h))+'</strong></div><div><span>USD</span><strong>'+fmtUsd(usd)+'</strong></div>';balEl.appendChild(row)}}
var cd=st.cooldownRemaining||0;setText('cdVal',cd>0?cd+' s':'None');}else{['priceMain','priceChg','smaVal','devVal','volVal','portVal','portPnl','portPct','cdVal'].forEach(function(id){setText(id,'\u2014')})}
if(series&&series.points&&series.points.length)renderChart(series.points);else if(priceChart){priceChart.data.labels=[];priceChart.data.datasets[0].data=[];priceChart.update()}
var list=document.getElementById('posList');list.innerHTML='';
if(pos&&pos.positions&&pos.positions.length){var cur=st&&st.latestPrice;pos.positions.forEach(function(p){var li=document.createElement('li');var sl=p.stopLossPrice,tp=p.takeProfitPrice;var u=p.unrealizedPnlQuote;li.innerHTML='<div><strong>'+tokenLabel(p.mint)+'</strong> \u00b7 entry '+fmtUsd(p.entryPrice)+' \u2192 now '+(cur!=null?fmtUsd(cur):'\u2014')+'</div><div>Unrealized PnL <span class="'+clsPnL(u)+'">'+fmtUsd(u)+'</span></div><div>SL '+fmtUsd(sl)+' \u00b7 TP '+fmtUsd(tp)+'</div><button type="button" data-id="'+p.id+'">Close</button>';list.appendChild(li)});list.querySelectorAll('button').forEach(function(btn){btn.onclick=function(){var id=btn.getAttribute('data-id');if(!id||!confirm('Close this position?'))return;postJson('/positions/close',{positionId:id,reason:'dashboard'}).then(function(){refresh()});};});}else{list.innerHTML='<p class="meta">No open positions</p>'}
if(risk){setText('dPnl',fmtUsd(risk.dailyRealizedPnL));document.getElementById('dPnl').className=clsPnL(risk.dailyRealizedPnL);
setText('slPct',(Number(risk.stopLossPercent)*100).toFixed(2)+'%');setText('tpPct',(Number(risk.takeProfitPercent)*100).toFixed(2)+'%');setText('mdlPct',(Number(risk.maxDailyLossPercent)*100).toFixed(2)+'%');setText('maxOpen',String(risk.maxOpenPositions));setText('rptPct',(Number(risk.riskPerTradePercent)*100).toFixed(2)+'%');
var start=risk.dailyStartingValueQuote||0;var dr=risk.dailyRealizedPnL||0;var lim=Number(risk.maxDailyLossPercent)||0;var w=document.getElementById('riskWarn');w.textContent='';
if(start>0&&lim>0){var lossRatio=dr<0?-dr/start:0;if(lossRatio>=lim*0.8)w.textContent='Daily loss is at or above '+fmtPct(lossRatio*100)+' of start NAV (max allowed '+fmtPct(lim*100)+')'}}else{setText('dPnl','\u2014');setText('slPct','\u2014');setText('tpPct','\u2014');setText('mdlPct','\u2014');setText('maxOpen','\u2014');setText('rptPct','\u2014')}
var th=document.getElementById('trades');th.innerHTML='';
if(hist&&hist.length){hist.slice().reverse().forEach(function(tr){var t=normTrade(tr);var div=document.createElement('div');div.className='trade-row';var dir=tradeDir(t);var inH=rawToHuman(t.inputMint,t.inputAmount),outH=rawToHuman(t.outputMint,t.outputAmount);var pnl=t.realizedPnl;var rowCls='neu';if(pnl!=null&&isFinite(pnl))rowCls=clsPnL(pnl);else if(t.exitReason)rowCls='neu';
div.innerHTML='<div class="meta">'+fmtTime(t.timestamp)+'</div><div><strong class="'+rowCls+'">'+dir+'</strong> '+fmtTok(t.inputMint,inH)+' \u2192 '+fmtTok(t.outputMint,outH)+(t.exitReason?'<br><span class="meta">'+t.exitReason+'</span>':'')+(pnl!=null&&isFinite(pnl)?'<br><span class="'+clsPnL(pnl)+'">PnL '+fmtUsd(pnl)+'</span>':'')+'</div>';th.appendChild(div)})}else{th.innerHTML='<p class="meta">No trades</p>'}
}
function armTimer(){if(timer)clearInterval(timer);timer=null;if(refreshMs>0)timer=setInterval(refresh,refreshMs)}
document.getElementById('btnTh').onclick=function(){var v=document.getElementById('inTh').value;if(v)postJson('/config',{key:'threshold',value:v}).then(function(){document.getElementById('inTh').value='';refresh()})};
document.getElementById('btnSl').onclick=function(){var v=document.getElementById('inSl').value;if(v)postJson('/config',{key:'stop_loss',value:v}).then(function(){document.getElementById('inSl').value='';refresh()})};
document.getElementById('btnTp').onclick=function(){var v=document.getElementById('inTp').value;if(v)postJson('/config',{key:'take_profit',value:v}).then(function(){document.getElementById('inTp').value='';refresh()})};
document.getElementById('btnCloseAll').onclick=function(){if(!confirm('Close ALL open positions?'))return;postJson('/positions/close',{all:true,reason:'dashboard'}).then(function(){refresh()})};
document.getElementById('btnReset').onclick=function(){if(!confirm('Reset paper portfolio? This cannot be undone.'))return;fetch('/reset',{method:'POST'}).then(function(){refresh()})};
document.getElementById('selRefresh').onchange=function(){var v=this.value;if(v==='off')refreshMs=0;else refreshMs=parseInt(v,10);armTimer();refresh()};
function boot(){refresh();armTimer()}
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
<header>
<h1>Solana Trader</h1>
<span id="modeBadge" class="badge badge-paper">PAPER</span>
<span><span id="runDot" class="dot dot-off"></span><span id="runTxt">Stopped</span></span>
<span class="meta" id="updated">—</span>
</header>
<div class="grid-wide">
<section class="card"><h2>Price</h2>
<div id="priceMain" class="val-lg">—</div>
<div id="priceChg" class="neu" style="margin-top:4px">—</div>
<div class="row"><div><span>SMA 20</span><strong id="smaVal">—</strong></div><div><span>Dev vs SMA</span><strong id="devVal">—</strong></div><div><span>Volatility</span><strong id="volVal">—</strong></div></div>
</section>
<section class="card"><h2>Price chart</h2><div class="chart-wrap"><canvas id="priceChart"></canvas></div></section>
</div>
<section class="card"><h2>Portfolio</h2>
<div class="row"><div><span>Total value (USDC)</span><strong id="portVal">—</strong></div><div><span>P&amp;L</span><strong id="portPnl">—</strong></div><div><span>P&amp;L %</span><strong id="portPct">—</strong></div></div>
<div id="balances"></div>
</section>
<section class="card"><h2>Open positions</h2><ul id="posList" class="pos-list"></ul></section>
<section class="card"><h2>Risk</h2>
<div class="row"><div><span>Daily realized P&amp;L</span><strong id="dPnl">—</strong></div><div><span>Cooldown</span><strong id="cdVal">—</strong></div></div>
<div class="row"><div><span>Stop loss</span><strong id="slPct">—</strong></div><div><span>Take profit</span><strong id="tpPct">—</strong></div><div><span>Max daily loss</span><strong id="mdlPct">—</strong></div></div>
<div class="row"><div><span>Max open positions</span><strong id="maxOpen">—</strong></div><div><span>Risk per trade</span><strong id="rptPct">—</strong></div></div>
<p id="riskWarn" class="warn"></p>
</section>
<section class="card"><h2>Recent trades</h2><div id="trades"></div></section>
<footer class="controls">
<h2 style="margin:0 0 8px">Controls</h2>
<div class="row"><input id="inTh" type="text" placeholder="Threshold %" aria-label="Threshold"/><button type="button" id="btnTh" class="primary">Set threshold</button></div>
<div class="row"><input id="inSl" type="text" placeholder="Stop loss (e.g. 0.03)" aria-label="Stop loss"/><button type="button" id="btnSl" class="primary">Set stop loss</button></div>
<div class="row"><input id="inTp" type="text" placeholder="Take profit (e.g. 06)" aria-label="Take profit"/><button type="button" id="btnTp" class="primary">Set take profit</button></div>
<button type="button" id="btnCloseAll">Close all positions</button>
<button type="button" id="btnReset">Reset paper portfolio</button>
<div class="row" style="margin-top:10px"><span style="display:inline-flex;align-items:center;gap:8px;width:100%"><span class="meta">Refresh</span>
<select id="selRefresh" style="min-height:44px;border-radius:8px;border:1px solid var(--bd);background:var(--bg);color:var(--txt);padding:0 8px">
<option value="10000" selected>10 s</option><option value="30000">30 s</option><option value="off">Off</option>
</select></span></div>
</footer>
<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.1/dist/chart.umd.min.js" defer></script>
<script defer>${js}</script>
</body>
</html>`;
}
