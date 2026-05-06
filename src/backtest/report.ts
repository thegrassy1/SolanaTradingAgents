/**
 * HTML report generator. Self-contained file with inline equity curve
 * (SVG, no external deps), drawdown chart, and trade ledger.
 */
import type { BacktestResult } from './types';

export function renderHtmlReport(r: BacktestResult): string {
  const m = r.metrics;
  const fmt = (n: number, decimals = 2) =>
    Number.isFinite(n) ? n.toFixed(decimals) : '—';
  const fmtPct = (n: number) => fmt(n * 100, 2) + '%';
  const fmtUsd = (n: number) => (n < 0 ? '−$' : '$') + fmt(Math.abs(n));
  const colorClass = (n: number) => (n > 0 ? 'pos' : n < 0 ? 'neg' : '');

  const equitySvg = renderEquitySvg(r.equityCurve, m.startEquity);
  const ddSvg = renderDrawdownSvg(r.equityCurve);

  const tradeRows = r.trades.slice(-200).reverse().map((t) => `
    <tr>
      <td>${t.symbol}</td>
      <td>${new Date(t.entryT).toISOString().slice(0, 16).replace('T', ' ')}</td>
      <td>${new Date(t.exitT).toISOString().slice(0, 16).replace('T', ' ')}</td>
      <td>$${fmt(t.entryPrice, 4)}</td>
      <td>$${fmt(t.exitPrice, 4)}</td>
      <td class="${colorClass(t.realizedPnlNet)}">${fmtUsd(t.realizedPnlNet)}</td>
      <td>${t.exitReason}</td>
      <td>${fmt(t.holdMinutes, 1)}m</td>
    </tr>
  `).join('');

  const perSymbolRows = Object.entries(r.perSymbol).map(([sym, s]) => `
    <tr>
      <td>${sym}</td>
      <td>${s.trades}</td>
      <td>${s.wins}</td>
      <td>${s.losses}</td>
      <td class="${colorClass(s.realizedPnl)}">${fmtUsd(s.realizedPnl)}</td>
    </tr>
  `).join('');

  return `<!doctype html>
<html><head>
<meta charset="utf-8">
<title>Backtest · ${r.params.strategy} · ${r.params.symbols.join(',')}</title>
<style>
  :root {
    --bg: #0a0d12; --card: #111721; --line: #1f2733; --fg: #d8e1f3; --muted: #6b7a99;
    --green: #00ff9c; --red: #ff3b6b; --cyan: #00e5ff;
  }
  * { box-sizing: border-box; }
  body { margin: 0; padding: 20px; background: var(--bg); color: var(--fg); font-family: ui-monospace, Consolas, monospace; max-width: 1200px; margin: 0 auto; }
  h1 { font-size: 18px; color: var(--cyan); margin: 0 0 6px; }
  h2 { font-size: 14px; color: var(--muted); letter-spacing: 0.1em; text-transform: uppercase; margin: 24px 0 8px; }
  .meta { color: var(--muted); font-size: 13px; margin-bottom: 18px; }
  .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 1px; background: var(--line); border: 1px solid var(--line); }
  .stat { background: var(--card); padding: 14px; }
  .stat .v { font-size: 22px; font-weight: 600; font-variant-numeric: tabular-nums; }
  .stat .l { font-size: 11px; color: var(--muted); letter-spacing: 0.12em; text-transform: uppercase; margin-top: 4px; }
  .pos { color: var(--green); }
  .neg { color: var(--red); }
  table { width: 100%; border-collapse: collapse; font-size: 12px; margin-top: 4px; }
  th, td { padding: 6px 10px; border-bottom: 1px solid var(--line); text-align: left; font-variant-numeric: tabular-nums; }
  th { color: var(--muted); font-size: 11px; letter-spacing: 0.1em; text-transform: uppercase; font-weight: 500; }
  .chart { background: var(--card); border: 1px solid var(--line); padding: 14px; margin-top: 4px; }
  .ledger { max-height: 600px; overflow-y: auto; background: var(--card); border: 1px solid var(--line); }
</style>
</head><body>
<h1>Backtest · ${r.params.strategy} · ${r.params.symbols.join(', ')}</h1>
<div class="meta">
  ${new Date(r.params.fromMs).toISOString().slice(0, 10)} → ${new Date(r.params.toMs).toISOString().slice(0, 10)}
  · ${r.params.resolution} bars · ${m.bars} bars · ${m.duration.days.toFixed(0)} days
</div>

<h2>Returns</h2>
<div class="grid">
  <div class="stat"><div class="v ${colorClass(m.totalReturnUsd)}">${fmtUsd(m.totalReturnUsd)}</div><div class="l">Total P&L</div></div>
  <div class="stat"><div class="v ${colorClass(m.totalReturnPct)}">${fmtPct(m.totalReturnPct)}</div><div class="l">Total Return</div></div>
  <div class="stat"><div class="v">${fmt(m.sharpe)}</div><div class="l">Sharpe (ann)</div></div>
  <div class="stat"><div class="v">${fmt(m.sortino)}</div><div class="l">Sortino</div></div>
  <div class="stat"><div class="v neg">−${fmtPct(m.maxDrawdown)}</div><div class="l">Max DD</div></div>
  <div class="stat"><div class="v">${fmt(m.maxDrawdownDays, 1)}d</div><div class="l">Max DD Duration</div></div>
</div>

<h2>Trade Quality</h2>
<div class="grid">
  <div class="stat"><div class="v">${m.totalTrades}</div><div class="l">Trades</div></div>
  <div class="stat"><div class="v">${fmtPct(m.winRate)}</div><div class="l">Win Rate</div></div>
  <div class="stat"><div class="v pos">${fmtUsd(m.avgWin)}</div><div class="l">Avg Win</div></div>
  <div class="stat"><div class="v neg">${fmtUsd(m.avgLoss)}</div><div class="l">Avg Loss</div></div>
  <div class="stat"><div class="v ${colorClass(m.expectancy)}">${fmtUsd(m.expectancy)}</div><div class="l">Expectancy</div></div>
  <div class="stat"><div class="v">${fmt(m.profitFactor)}</div><div class="l">Profit Factor</div></div>
  <div class="stat"><div class="v">${fmt(m.avgHoldMinutes, 1)}m</div><div class="l">Avg Hold</div></div>
  <div class="stat"><div class="v">${fmt(m.medianHoldMinutes, 1)}m</div><div class="l">Median Hold</div></div>
</div>

<h2>Equity Curve</h2>
<div class="chart">${equitySvg}</div>

<h2>Drawdown</h2>
<div class="chart">${ddSvg}</div>

<h2>Per Symbol</h2>
<table><thead><tr><th>Symbol</th><th>Trades</th><th>Wins</th><th>Losses</th><th>Realized P&L</th></tr></thead><tbody>
${perSymbolRows}
</tbody></table>

<h2>Trade Ledger (last 200, newest first)</h2>
<div class="ledger">
<table><thead><tr><th>Symbol</th><th>Entry</th><th>Exit</th><th>Entry $</th><th>Exit $</th><th>Net P&L</th><th>Reason</th><th>Hold</th></tr></thead><tbody>
${tradeRows}
</tbody></table>
</div>

</body></html>`;
}

function renderEquitySvg(curve: BacktestResult['equityCurve'], start: number): string {
  if (curve.length < 2) return '<div style="color:var(--muted)">No data</div>';
  const W = 1100, H = 220, P = 30;
  const ts = curve.map((p) => p.t);
  const eqs = curve.map((p) => p.equity);
  const tMin = ts[0], tMax = ts[ts.length - 1];
  const eMin = Math.min(start, ...eqs), eMax = Math.max(start, ...eqs);
  const xs = (t: number) => P + ((t - tMin) / (tMax - tMin || 1)) * (W - 2 * P);
  const ys = (e: number) => H - P - ((e - eMin) / (eMax - eMin || 1)) * (H - 2 * P);
  const path = curve.map((p, i) => `${i === 0 ? 'M' : 'L'}${xs(p.t).toFixed(1)},${ys(p.equity).toFixed(1)}`).join(' ');
  const startY = ys(start);
  const endColor = eqs[eqs.length - 1] >= start ? 'var(--green)' : 'var(--red)';
  return `<svg viewBox="0 0 ${W} ${H}" width="100%" preserveAspectRatio="none">
    <line x1="${P}" x2="${W - P}" y1="${startY}" y2="${startY}" stroke="var(--muted)" stroke-dasharray="2,4"/>
    <path d="${path}" stroke="${endColor}" stroke-width="1.5" fill="none"/>
    <text x="${P}" y="${P - 8}" fill="var(--muted)" font-size="10">$${eMax.toFixed(0)}</text>
    <text x="${P}" y="${H - 6}" fill="var(--muted)" font-size="10">$${eMin.toFixed(0)}</text>
    <text x="${W - P}" y="${P - 8}" fill="var(--muted)" font-size="10" text-anchor="end">${new Date(tMax).toISOString().slice(0, 10)}</text>
  </svg>`;
}

function renderDrawdownSvg(curve: BacktestResult['equityCurve']): string {
  if (curve.length < 2) return '<div style="color:var(--muted)">No data</div>';
  const W = 1100, H = 140, P = 30;
  const ts = curve.map((p) => p.t);
  const dds = curve.map((p) => p.drawdown);
  const tMin = ts[0], tMax = ts[ts.length - 1];
  const ddMax = Math.max(0.01, ...dds);
  const xs = (t: number) => P + ((t - tMin) / (tMax - tMin || 1)) * (W - 2 * P);
  const ys = (d: number) => P + (d / ddMax) * (H - 2 * P);
  const path = curve.map((p, i) =>
    `${i === 0 ? 'M' : 'L'}${xs(p.t).toFixed(1)},${ys(p.drawdown).toFixed(1)}`
  ).join(' ');
  const close = `L${xs(tMax).toFixed(1)},${ys(0).toFixed(1)} L${xs(tMin).toFixed(1)},${ys(0).toFixed(1)} Z`;
  return `<svg viewBox="0 0 ${W} ${H}" width="100%" preserveAspectRatio="none">
    <path d="${path} ${close}" fill="rgba(255,59,107,0.2)" stroke="var(--red)" stroke-width="1"/>
    <text x="${P}" y="${P - 8}" fill="var(--muted)" font-size="10">−${(ddMax * 100).toFixed(1)}%</text>
    <text x="${P}" y="${H - P + 12}" fill="var(--muted)" font-size="10">0%</text>
  </svg>`;
}
