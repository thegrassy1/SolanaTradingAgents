/**
 * Self-contained HUD dashboard — gamified strategy personas + live data.
 * No external deps (CSS + JS inline; no Chart.js, no images).
 */

export function getDashboardHtml(): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>SOL/TRADER — HUD</title>
<style>
  :root {
    --bg-0: #04060c;
    --bg-1: #070b15;
    --bg-2: #0c1322;
    --grid: rgba(0, 229, 255, 0.04);
    --line: rgba(0, 229, 255, 0.18);
    --line-soft: rgba(0, 229, 255, 0.08);
    --cyan: #00e5ff;
    --cyan-dim: #4fb6c2;
    --green: #00ff9c;
    --red: #ff3b6b;
    --amber: #ffae00;
    --magenta: #ff00d4;
    --fg: #d8e1f3;
    --muted: #6b7a99;
  }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; }
  body {
    font-family: ui-monospace, "SF Mono", "JetBrains Mono", Consolas, monospace;
    color: var(--fg);
    background: radial-gradient(ellipse at top, #0d1730 0%, var(--bg-0) 70%) fixed, var(--bg-0);
    min-height: 100vh;
    padding: 16px 20px;
    overflow-x: hidden;
    -webkit-font-smoothing: antialiased;
  }
  /* Layout: strategy cards on the left (primary), activity log on the right.
     Targets become a 1-line ticker at the top — informational, not central. */
  .layout { display: grid; grid-template-columns: 1fr; gap: 14px; }
  @media (min-width: 1100px) {
    .layout { grid-template-columns: 1.6fr 1fr; gap: 20px; }
    .col-main, .col-side { display: flex; flex-direction: column; gap: 10px; }
    .col-main .hdr, .col-side .hdr { margin: 6px 0 4px; }
    .score-panel { grid-column: 1 / -1; }
    .ticker-wrap { grid-column: 1 / -1; }
  }

  body::before {
    content: ''; pointer-events: none; position: fixed; inset: 0;
    background: repeating-linear-gradient(0deg, rgba(0,229,255,0.02) 0, rgba(0,229,255,0.02) 1px, transparent 1px, transparent 3px);
    z-index: 999;
  }
  body::after {
    content: ''; pointer-events: none; position: fixed; inset: 0;
    background:
      linear-gradient(var(--grid) 1px, transparent 1px) 0 0/40px 40px,
      linear-gradient(90deg, var(--grid) 1px, transparent 1px) 0 0/40px 40px;
    z-index: -1;
  }

  .hdr {
    display: flex; align-items: center; gap: 8px;
    font-size: 12px; letter-spacing: 0.18em;
    color: var(--cyan-dim); text-transform: uppercase;
    margin: 16px 0 8px;
  }
  .hdr::before {
    content: ''; width: 8px; height: 8px;
    background: var(--cyan); box-shadow: 0 0 8px var(--cyan);
    transform: rotate(45deg);
  }
  .hdr::after { content: ''; flex: 1; height: 1px; background: linear-gradient(to right, var(--line), transparent); }

  .hud {
    position: relative;
    background: linear-gradient(180deg, var(--bg-2) 0%, var(--bg-1) 100%);
    border: 1px solid var(--line);
    padding: 14px;
    margin-bottom: 14px;
  }
  .hud::before, .hud::after, .hud > .corner-tl, .hud > .corner-bl {
    content: ''; position: absolute; width: 14px; height: 14px;
    border: 2px solid var(--cyan);
  }
  .hud::before { top: -1px; right: -1px; border-left: none; border-bottom: none; }
  .hud::after { bottom: -1px; left: -1px; border-right: none; border-top: none; }
  .hud > .corner-tl { top: -1px; left: -1px; border-right: none; border-bottom: none; }
  .hud > .corner-bl { bottom: -1px; right: -1px; border-left: none; border-top: none; }

  .score-panel { text-align: center; padding: 18px 14px 16px; }
  .rank-row {
    display: flex; justify-content: space-between; align-items: center;
    font-size: 12px; letter-spacing: 0.2em; color: var(--cyan-dim);
    margin-bottom: 10px;
  }
  .rank-row .rank { color: var(--cyan); text-shadow: 0 0 6px rgba(0,229,255,0.6); }
  .score-label { font-size: 12px; letter-spacing: 0.3em; color: var(--cyan-dim); margin-bottom: 4px; }
  .score {
    font-size: 52px; font-weight: 700; letter-spacing: -0.02em;
    font-variant-numeric: tabular-nums; line-height: 1;
    transition: color 0.3s, text-shadow 0.3s;
  }
  .score.neg { color: var(--red); text-shadow: 0 0 14px rgba(255,59,107,0.5); }
  .score.pos { color: var(--green); text-shadow: 0 0 14px rgba(0,255,156,0.5); }
  .score-sub { font-size: 13px; color: var(--muted); margin-top: 6px; letter-spacing: 0.06em; }

  .xp-wrap { margin-top: 14px; }
  .xp-meta { display: flex; justify-content: space-between; font-size: 12px; color: var(--muted); letter-spacing: 0.1em; margin-bottom: 6px; }
  .xp-bar { height: 10px; background: rgba(0,229,255,0.08); position: relative; overflow: hidden; border: 1px solid var(--line-soft); }
  .xp-fill {
    position: absolute; inset: 0 auto 0 0; width: 0%;
    background: linear-gradient(90deg, var(--cyan), var(--green));
    box-shadow: 0 0 8px var(--cyan);
    transition: width 1.2s cubic-bezier(0.4, 0, 0.2, 1);
  }
  .xp-fill.danger { background: linear-gradient(90deg, var(--amber), var(--red)); box-shadow: 0 0 8px var(--red); }

  .stats { display: grid; grid-template-columns: repeat(4, 1fr); gap: 1px; background: var(--line-soft); margin-top: 14px; border-top: 1px solid var(--line-soft); }
  .stat { background: var(--bg-1); padding: 10px 4px; text-align: center; }
  .stat .v { font-size: 20px; font-weight: 600; font-variant-numeric: tabular-nums; }
  .stat .l { font-size: 11px; letter-spacing: 0.18em; color: var(--cyan-dim); margin-top: 4px; text-transform: uppercase; }
  .stat .v.streak { color: var(--amber); text-shadow: 0 0 6px rgba(255,174,0,0.5); }
  .stat .v.win { color: var(--green); }

  .flame { display: inline-block; animation: flicker 1.4s infinite; }
  @keyframes flicker { 0%, 100% { opacity: 1; transform: scale(1); } 50% { opacity: 0.85; transform: scale(1.06); } }

  .targets { padding: 0; }
  .target {
    display: grid; grid-template-columns: 36px 1fr auto auto;
    align-items: center; gap: 12px;
    padding: 12px 14px;
    border-bottom: 1px solid var(--line-soft);
    cursor: pointer; position: relative;
    transition: background 0.2s;
  }
  .target:last-of-type { border-bottom: none; }
  .target:hover { background: rgba(0,229,255,0.04); }
  .target.tick { animation: pulse-row 1s ease-out; }
  @keyframes pulse-row { 0% { background: rgba(0,229,255,0.16); } 100% { background: transparent; } }

  .target .marker {
    width: 32px; height: 32px;
    display: flex; align-items: center; justify-content: center;
    font-size: 14px; font-weight: 700; letter-spacing: 0.04em;
    border: 1px solid var(--line);
    color: var(--cyan-dim);
  }
  .target .marker.regime-trending_up { color: var(--green); border-color: var(--green); }
  .target .marker.regime-trending_down { color: var(--red); border-color: var(--red); }
  .target .marker.regime-dead { opacity: 0.4; }
  .target .name { font-weight: 600; font-size: 17px; letter-spacing: 0.04em; }
  .target .price { font-size: 13px; color: var(--muted); margin-top: 2px; font-variant-numeric: tabular-nums; }
  .target .change { text-align: right; font-variant-numeric: tabular-nums; font-weight: 600; font-size: 15px; min-width: 80px; }
  .target .change.pos { color: var(--green); text-shadow: 0 0 4px rgba(0,255,156,0.4); }
  .target .change.neg { color: var(--red); text-shadow: 0 0 4px rgba(255,59,107,0.4); }
  .target .arrow { display: inline-block; margin-right: 2px; }

  .pos-badge { font-size: 12px; letter-spacing: 0.08em; font-weight: 700; padding: 4px 9px; border: 1px solid; background: var(--bg-1); }
  .pos-badge.long { color: var(--green); border-color: var(--green); box-shadow: 0 0 6px rgba(0,255,156,0.3); }
  .pos-badge.short { color: var(--red); border-color: var(--red); box-shadow: 0 0 6px rgba(255,59,107,0.3); }
  .pos-badge.empty { color: var(--muted); border-color: var(--line-soft); opacity: 0.5; }

  .target-expand { display: none; background: rgba(0,229,255,0.025); border-top: 1px dashed var(--line-soft); padding: 10px 14px 14px; }
  .target.open + .target-expand { display: block; animation: slideDown 0.2s ease-out; }
  @keyframes slideDown { from { opacity: 0; transform: translateY(-4px); } to { opacity: 1; transform: translateY(0); } }
  .te-row { display: flex; justify-content: space-between; padding: 6px 0; font-size: 13px; border-bottom: 1px dashed var(--line-soft); }
  .te-row:last-child { border-bottom: none; }
  .te-row .l { color: var(--muted); letter-spacing: 0.1em; }
  .te-row .v { color: var(--fg); font-variant-numeric: tabular-nums; }
  .te-row .v.pos { color: var(--green); }
  .te-row .v.neg { color: var(--red); }

  /* ===== TICKER (was: targets section) — 1-line price strip ===== */
  .ticker {
    display: flex; gap: 0; overflow-x: auto;
    background: linear-gradient(180deg, var(--bg-2), var(--bg-1));
    border: 1px solid var(--line);
    position: relative;
  }
  .ticker::-webkit-scrollbar { height: 0; }
  .ticker > .corner-tl, .ticker > .corner-bl { position: absolute; width: 10px; height: 10px; border: 2px solid var(--cyan); }
  .ticker > .corner-tl { top: -1px; left: -1px; border-right: none; border-bottom: none; }
  .ticker > .corner-bl { bottom: -1px; right: -1px; border-left: none; border-top: none; }
  .ticker-cell {
    flex: 1 0 auto; padding: 12px 18px;
    border-right: 1px solid var(--line-soft);
    display: grid;
    grid-template-columns: auto 1fr auto;
    align-items: baseline;
    gap: 8px;
    min-width: 150px;
    cursor: pointer;
    transition: background 0.2s;
  }
  .ticker-cell:last-child { border-right: none; }
  .ticker-cell:hover { background: rgba(0,229,255,0.04); }
  .ticker-cell.tick { animation: pulse-row 1s ease-out; }
  @keyframes pulse-row { 0% { background: rgba(0,229,255,0.16); } 100% { background: transparent; } }
  .ticker-cell .sym { font-size: 14px; font-weight: 700; color: var(--fg); letter-spacing: 0.04em; }
  .ticker-cell .px { font-variant-numeric: tabular-nums; font-size: 12px; color: var(--muted); }
  .ticker-cell .ch { font-variant-numeric: tabular-nums; font-size: 12px; font-weight: 600; }
  .ticker-cell .ch.pos { color: var(--green); }
  .ticker-cell .ch.neg { color: var(--red); }
  .ticker-cell .reg { width: 6px; height: 6px; display: inline-block; border-radius: 50%; margin-right: 6px; vertical-align: middle; }
  .ticker-cell .reg.ranging { background: var(--muted); }
  .ticker-cell .reg.trending_up { background: var(--green); box-shadow: 0 0 4px var(--green); }
  .ticker-cell .reg.trending_down { background: var(--red); box-shadow: 0 0 4px var(--red); }
  .ticker-cell .reg.dead { background: #333; }

  /* ===== STRATEGY CARDS — the centerpiece ===== */
  .cards { display: flex; flex-direction: column; gap: 10px; }
  .card {
    --accent: var(--cyan);
    display: grid;
    grid-template-columns: 96px 1fr;
    grid-template-rows: auto auto auto;
    gap: 10px 18px;
    padding: 18px;
    background: linear-gradient(180deg, var(--bg-2) 0%, var(--bg-1) 100%);
    border: 1px solid var(--line);
    border-left: 3px solid var(--accent);
    position: relative;
    transition: border-color 0.3s, box-shadow 0.3s;
  }
  .card.persona-static { --accent: #00e5ff; }
  .card.persona-rush   { --accent: #ff7a3c; }
  .card.persona-stone  { --accent: #b985ff; }
  .card.persona-oracle { --accent: #ff00d4; }
  .card.persona-void   { --accent: #7d8a9b; }
  .card.persona-hunter { --accent: #ffd66b; }
  .card.active { box-shadow: 0 0 20px color-mix(in srgb, var(--accent) 18%, transparent); }
  .card.disabled { opacity: 0.45; border-left-color: var(--muted); }
  .card.disabled .avatar { opacity: 0.5; }

  .card .avatar {
    grid-row: 1 / span 2; grid-column: 1;
    width: 80px; height: 80px;
    border: 1px solid var(--line);
    display: flex; align-items: center; justify-content: center;
    color: var(--accent);
    background: radial-gradient(circle at center, rgba(255,255,255,0.04), transparent 70%);
    transition: box-shadow 0.3s, border-color 0.3s;
  }
  .card .avatar svg { width: 100%; height: 100%; display: block; }
  .card.active .avatar {
    border-color: var(--accent);
    box-shadow: 0 0 14px color-mix(in srgb, var(--accent) 40%, transparent),
                inset 0 0 10px color-mix(in srgb, var(--accent) 15%, transparent);
  }
  .card.cooldown .avatar { border-color: var(--amber); }

  /* Card header: callsign + role + status badge */
  .card .head {
    grid-row: 1; grid-column: 2;
    display: flex; align-items: baseline; gap: 12px; flex-wrap: wrap;
  }
  .card .callsign {
    font-size: 18px; font-weight: 700; letter-spacing: 0.12em;
    color: var(--accent);
    text-shadow: 0 0 6px color-mix(in srgb, var(--accent) 50%, transparent);
  }
  .card .role { font-size: 11px; letter-spacing: 0.12em; color: var(--muted); }
  .card .state-badge {
    margin-left: auto;
    font-size: 11px; font-weight: 700; letter-spacing: 0.12em;
    padding: 3px 9px; border: 1px solid; text-transform: uppercase;
  }
  .state-badge.active   { color: var(--green);  border-color: var(--green); }
  .state-badge.cooldown { color: var(--amber);  border-color: var(--amber); }
  .state-badge.idle     { color: var(--muted);  border-color: var(--line-soft); }
  .state-badge.disabled { color: var(--muted);  border-color: var(--line-soft); opacity: 0.7; }
  .state-badge.gated    { color: var(--magenta); border-color: var(--magenta); }

  /* Whitelist chips strip — directly under header */
  .card .wl {
    grid-row: 2; grid-column: 2;
    display: flex; gap: 6px; flex-wrap: wrap; align-items: center;
    font-size: 10px; color: var(--muted); letter-spacing: 0.1em;
  }
  .card .wl-label { text-transform: uppercase; opacity: 0.7; }
  .card .wl-chip {
    padding: 2px 7px;
    border: 1px solid var(--line-soft);
    color: var(--fg);
    font-weight: 600; letter-spacing: 0.06em; font-size: 11px;
    background: rgba(0,229,255,0.03);
  }
  .card .wl-chip.disabled-tag {
    color: var(--red); border-color: var(--red); background: rgba(255,59,107,0.05);
  }
  .card .wl-chip.all-tag { color: var(--cyan-dim); }

  /* Stat grid — 6 KPIs */
  .card .stats {
    grid-row: 3; grid-column: 1 / -1;
    display: grid; grid-template-columns: repeat(3, 1fr); gap: 1px;
    background: var(--line-soft);
    border-top: 1px solid var(--line-soft);
    margin-top: 6px;
  }
  @media (min-width: 640px) {
    .card .stats { grid-template-columns: repeat(6, 1fr); }
  }
  .card .stat {
    background: var(--bg-1);
    padding: 10px 6px; text-align: center;
  }
  .card .stat .v {
    font-size: 16px; font-weight: 600;
    font-variant-numeric: tabular-nums;
    color: var(--fg);
  }
  .card .stat .v.pos { color: var(--green); }
  .card .stat .v.neg { color: var(--red); }
  .card .stat .l {
    font-size: 9px; letter-spacing: 0.14em; color: var(--cyan-dim);
    margin-top: 3px; text-transform: uppercase;
  }

  /* Open-positions strip inside cards (only renders if positions > 0) */
  .card .openpos {
    grid-row: 4; grid-column: 1 / -1;
    margin-top: 6px;
    border-top: 1px dashed var(--line-soft);
    padding-top: 8px;
  }
  .card .openpos-row {
    display: grid;
    grid-template-columns: 60px 1fr auto auto;
    gap: 10px; align-items: center;
    padding: 4px 0;
    font-size: 12px;
    border-bottom: 1px dashed var(--line-soft);
  }
  .card .openpos-row:last-child { border-bottom: none; }
  .card .openpos .pos-sym { color: var(--accent); font-weight: 600; }
  .card .openpos .pos-info { color: var(--muted); font-size: 11px; }
  .card .openpos .pos-pnl { font-variant-numeric: tabular-nums; font-weight: 600; }
  .card .openpos .pos-pnl.pos { color: var(--green); }
  .card .openpos .pos-pnl.neg { color: var(--red); }
  .card .openpos .pos-tag { font-size: 9px; padding: 1px 5px; border: 1px solid; letter-spacing: 0.1em; }
  .card .openpos .pos-tag.long { color: var(--green); border-color: var(--green); }
  .card .openpos .pos-tag.short { color: var(--red); border-color: var(--red); }

  /* Cooldown drain bar across the bottom */
  .card .cd-bar { position: absolute; bottom: 0; left: 0; height: 2px; background: var(--amber); box-shadow: 0 0 4px var(--amber); transition: width 0.4s linear; }

  /* Persona animations (port from old .slot rules to .card) */
  @keyframes static-scan { 0%, 100% { transform: translateX(-3px); opacity: 0.6; } 50% { transform: translateX(3px); opacity: 1; } }
  .card.persona-static.active .avatar svg line:nth-of-type(1),
  .card.persona-static.active .avatar svg line:nth-of-type(2) { transform-origin: 25px 23px; animation: static-scan 2.4s ease-in-out infinite; }

  @keyframes rush-shake { 0%, 100% { transform: translateY(0); } 25% { transform: translateY(-1px) rotate(-1deg); } 75% { transform: translateY(0.5px) rotate(1deg); } }
  @keyframes rush-eye-pulse { 0%, 100% { stroke-width: 2.2; opacity: 1; } 50% { stroke-width: 3; opacity: 0.6; } }
  .card.persona-rush.active .avatar svg path:first-of-type { transform-origin: 25px 12px; animation: rush-shake 0.6s ease-in-out infinite; }
  .card.persona-rush.active .avatar svg path:nth-of-type(3),
  .card.persona-rush.active .avatar svg path:nth-of-type(4) { animation: rush-eye-pulse 1.2s ease-in-out infinite; }

  @keyframes stone-blink { 0%, 92%, 100% { transform: scaleY(1); } 95% { transform: scaleY(0.1); } }
  .card.persona-stone.active .avatar svg circle:last-of-type { transform-origin: 25px 24px; animation: stone-blink 4s ease-in-out infinite; }

  @keyframes oracle-scan { 0%, 100% { transform: translateX(-2.5px); } 50% { transform: translateX(2.5px); } }
  @keyframes oracle-rays { 0%, 100% { opacity: 0.4; } 50% { opacity: 1; } }
  .card.persona-oracle.active .avatar svg circle { transform-origin: 25px 28px; animation: oracle-scan 3s ease-in-out infinite; }
  .card.persona-oracle.active .avatar svg line { animation: oracle-rays 1.6s ease-in-out infinite; }

  @keyframes void-scythe { 0%, 100% { transform: rotate(-4deg); } 50% { transform: rotate(4deg); } }
  @keyframes void-eyes { 0%, 100% { opacity: 0.6; } 50% { opacity: 1; } }
  .card.persona-void.active .avatar svg path:nth-of-type(2) { transform-origin: 25px 30px; animation: void-scythe 2.6s ease-in-out infinite; }
  .card.persona-void.active .avatar svg circle { animation: void-eyes 1.8s ease-in-out infinite; }

  @keyframes hunter-perk { 0%, 100% { transform: translateY(0); } 50% { transform: translateY(-1.5px); } }
  .card.persona-hunter.active .avatar svg path:nth-of-type(1),
  .card.persona-hunter.active .avatar svg path:nth-of-type(2) { animation: hunter-perk 2s ease-in-out infinite; }

  .log { max-height: 320px; overflow-y: auto; font-size: 13px; padding: 0; }
  .log::-webkit-scrollbar { width: 4px; }
  .log::-webkit-scrollbar-thumb { background: var(--line); }
  .log-entry { display: grid; grid-template-columns: 26px 64px 70px 1fr; gap: 10px; padding: 8px 14px; border-bottom: 1px solid var(--line-soft); align-items: center; }
  .log-entry:last-child { border-bottom: none; }
  .log-entry .t { color: var(--muted); font-size: 11px; }
  .log-entry .tag { font-size: 11px; font-weight: 700; letter-spacing: 0.1em; padding: 2px 6px; text-align: center; border: 1px solid; }

  /* Mini avatar in activity feed */
  .log-avatar {
    width: 22px; height: 22px;
    display: flex; align-items: center; justify-content: center;
    border: 1px solid var(--line);
    color: var(--cyan-dim);
    background: rgba(0,0,0,0.25);
  }
  .log-avatar svg { width: 100%; height: 100%; display: block; }
  .log-avatar.persona-static  { color: #00e5ff; border-color: rgba(0,229,255,0.4); }
  .log-avatar.persona-rush    { color: #ff7a3c; border-color: rgba(255,122,60,0.4); }
  .log-avatar.persona-stone   { color: #b985ff; border-color: rgba(185,133,255,0.4); }
  .log-avatar.persona-oracle  { color: #ff00d4; border-color: rgba(255,0,212,0.4); }
  .log-avatar.persona-void    { color: #7d8a9b; border-color: rgba(125,138,155,0.4); }
  .log-avatar.persona-hunter  { color: #ffd66b; border-color: rgba(255,214,107,0.4); }
  .log-avatar.system { color: var(--muted); opacity: 0.5; }
  .tag.open { color: var(--cyan); border-color: var(--cyan); }
  .tag.win  { color: var(--green); border-color: var(--green); }
  .tag.loss { color: var(--red); border-color: var(--red); }
  .tag.ai   { color: var(--magenta); border-color: var(--magenta); }
  .tag.tune { color: var(--amber); border-color: var(--amber); }
  .log-entry .msg { color: var(--fg); word-break: break-word; }
  .log-entry .msg b { color: var(--cyan); font-weight: 600; }
  .log-entry .msg .pnl-pos { color: var(--green); }
  .log-entry .msg .pnl-neg { color: var(--red); }

  .notif {
    position: fixed; top: 16px; right: 12px;
    background: var(--bg-2); border: 1px solid var(--green);
    padding: 10px 16px; font-size: 14px; letter-spacing: 0.1em;
    box-shadow: 0 0 16px rgba(0,255,156,0.3);
    transform: translateX(120%);
    transition: transform 0.4s cubic-bezier(0.4, 0, 0.2, 1);
    z-index: 1000; color: var(--green);
  }
  .notif.show { transform: translateX(0); }
  .notif.loss { border-color: var(--red); color: var(--red); box-shadow: 0 0 16px rgba(255,59,107,0.3); }

  .details-toggle { margin: 12px 0 0; text-align: center; color: var(--cyan-dim); font-size: 12px; letter-spacing: 0.2em; cursor: pointer; text-transform: uppercase; }
  .details-toggle:hover { color: var(--cyan); }
  .details-panel { display: none; padding: 14px; }
  .details-panel.open { display: block; animation: slideDown 0.2s ease-out; }
  .dp-row { display: flex; justify-content: space-between; padding: 6px 0; font-size: 13px; border-bottom: 1px dashed var(--line-soft); }
  .dp-row:last-child { border-bottom: none; }
  .dp-row .l { color: var(--muted); }
  .dp-row .v { color: var(--fg); font-variant-numeric: tabular-nums; }

  .loading { color: var(--muted); padding: 20px; text-align: center; font-size: 12px; letter-spacing: 0.2em; }

  @media (max-width: 480px) {
    body { padding: 8px; }
    .score { font-size: 42px; }
    .stat .v { font-size: 17px; }
    .target .name { font-size: 16px; }
  }
</style>
</head>
<body>

<div class="notif" id="notif"></div>

<div class="layout">

<div class="hud score-panel">
  <span class="corner-tl"></span><span class="corner-bl"></span>
  <div class="rank-row">
    <span>OPERATOR · <span class="rank" id="rank">EX-001</span></span>
    <span>
      <span id="soundToggle" style="cursor:pointer; padding:0 8px;" title="Toggle sound">♪</span>
      <span id="modeLabel">— · INIT</span>
    </span>
  </div>
  <div class="score-label">TOTAL · CREDITS</div>
  <div class="score" id="score">$0.00</div>
  <div class="score-sub" id="scoreSub">—</div>
  <div class="xp-wrap">
    <div class="xp-meta"><span>DAILY · LIMIT</span><span id="xpPct">—</span></div>
    <div class="xp-bar"><div class="xp-fill" id="xpFill" style="width: 0%"></div></div>
  </div>
  <div class="stats">
    <div class="stat"><div class="v win" id="wins">—</div><div class="l">Wins</div></div>
    <div class="stat"><div class="v" id="losses" style="color: var(--red)">—</div><div class="l">Losses</div></div>
    <div class="stat"><div class="v streak"><span class="flame">▲</span> <span id="streak">—</span></div><div class="l">Streak</div></div>
    <div class="stat"><div class="v" id="winRate">—</div><div class="l">Hit Rate</div></div>
  </div>
</div>

<!-- Tiny ticker strip — replaces the old big Targets section -->
<div class="ticker-wrap">
  <div class="ticker" id="ticker">
    <span class="corner-tl"></span><span class="corner-bl"></span>
    <div class="ticker-cell"><span class="sym">…</span></div>
  </div>
</div>

<!-- Strategy cards: the new centerpiece -->
<div class="col-main">
  <div class="hdr">Strategies · Loadout</div>
  <div class="cards" id="cards">
    <div class="loading">LOADING…</div>
  </div>
</div>

<!-- Activity + details: secondary column -->
<div class="col-side">
  <div class="hdr">Activity · Live</div>
  <div class="hud" style="padding: 0;">
    <span class="corner-tl"></span><span class="corner-bl"></span>
    <div class="log" id="log"><div class="loading">LOADING…</div></div>
  </div>

  <div class="details-toggle" onclick="document.getElementById('details').classList.toggle('open')">⌄ DETAILS ⌄</div>
  <div class="hud details-panel" id="details">
    <span class="corner-tl"></span><span class="corner-bl"></span>
    <div id="detailsBody"></div>
  </div>
</div>

</div>

<script>
// ========================================================================
// SOUND ENGINE
// ========================================================================
const SFX = (() => {
  let ctx = null;
  let muted = localStorage.getItem('hud-muted') === '1';
  function ensureCtx() {
    if (!ctx) ctx = new (window.AudioContext || window.webkitAudioContext)();
    if (ctx.state === 'suspended') ctx.resume();
    return ctx;
  }
  function tone(freq, dur, opts = {}) {
    if (muted) return;
    const c = ensureCtx();
    const t0 = c.currentTime;
    const osc = c.createOscillator(), gain = c.createGain();
    osc.type = opts.type || 'sine';
    osc.frequency.setValueAtTime(freq, t0);
    if (opts.glide) osc.frequency.exponentialRampToValueAtTime(opts.glide, t0 + dur);
    const peak = (opts.gain ?? 0.18);
    gain.gain.setValueAtTime(0, t0);
    gain.gain.linearRampToValueAtTime(peak, t0 + 0.005);
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    osc.connect(gain).connect(c.destination);
    osc.start(t0); osc.stop(t0 + dur);
  }
  return {
    tick: () => tone(880, 0.06, { type: 'sine', gain: 0.04 }),
    click: () => tone(620, 0.04, { type: 'square', gain: 0.06 }),
    open: () => { tone(440, 0.08, { type: 'triangle', gain: 0.08 }); setTimeout(() => tone(660, 0.10, { type: 'triangle', gain: 0.08 }), 70); },
    win: () => { tone(523, 0.08, { type: 'square', gain: 0.10 }); setTimeout(() => tone(659, 0.08, { type: 'square', gain: 0.10 }), 70); setTimeout(() => tone(784, 0.18, { type: 'square', gain: 0.10 }), 140); },
    loss: () => tone(220, 0.30, { type: 'sawtooth', gain: 0.10, glide: 80 }),
    sweepUp: () => tone(180, 0.5, { type: 'sine', gain: 0.05, glide: 540 }),
    alert: () => { tone(880, 0.15, { type: 'square', gain: 0.12 }); setTimeout(() => tone(660, 0.15, { type: 'square', gain: 0.12 }), 160); setTimeout(() => tone(880, 0.15, { type: 'square', gain: 0.12 }), 320); },
    ai: () => { tone(1200, 0.04, { type: 'triangle', gain: 0.05 }); setTimeout(() => tone(900, 0.04, { type: 'triangle', gain: 0.05 }), 30); },
    setMuted: (m) => { muted = m; localStorage.setItem('hud-muted', m ? '1' : '0'); },
    isMuted: () => muted,
  };
})();

const soundBtn = document.getElementById('soundToggle');
function refreshSoundBtn() {
  soundBtn.textContent = SFX.isMuted() ? '♪̸' : '♪';
  soundBtn.style.color = SFX.isMuted() ? 'var(--muted)' : 'var(--cyan)';
}
refreshSoundBtn();
soundBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  SFX.setMuted(!SFX.isMuted());
  refreshSoundBtn();
  if (!SFX.isMuted()) SFX.click();
});

function notify(msg, type = '') {
  const n = document.getElementById('notif');
  n.textContent = msg;
  n.className = 'notif ' + type + ' show';
  setTimeout(() => n.classList.remove('show'), 3500);
}

// ========================================================================
// PERSONA REGISTRY — maps strategy name → {callsign, role, persona class, SVG}
// ========================================================================
const PERSONAS = {
  mean_reversion_v1: {
    callsign: 'STATIC', role: 'SNIPER · MEAN_REV', cls: 'persona-static',
    title: 'STATIC — The Sniper. Waits for prices to deviate from the mean, fires on reversion.',
    svg: '<svg viewBox="0 0 50 50" fill="none"><path d="M 8 28 Q 8 8 25 8 Q 42 8 42 28 L 42 40 L 8 40 Z" stroke="currentColor" stroke-width="2"/><rect x="12" y="20" width="26" height="6" fill="currentColor" opacity="0.85"/><line x1="20" y1="23" x2="30" y2="23" stroke="#04060c" stroke-width="1.2"/><line x1="25" y1="20.5" x2="25" y2="25.5" stroke="#04060c" stroke-width="1.2"/><line x1="14" y1="40" x2="14" y2="44" stroke="currentColor" stroke-width="2"/><line x1="36" y1="40" x2="36" y2="44" stroke="currentColor" stroke-width="2"/></svg>',
  },
  breakout_v1: {
    callsign: 'RUSH', role: 'BERSERKER · BREAKOUT', cls: 'persona-rush',
    title: 'RUSH — The Berserker. Charges momentum breakouts when volatility spikes.',
    svg: '<svg viewBox="0 0 50 50" fill="none"><path d="M 14 12 L 17 4 L 20 12 L 23 2 L 26 12 L 29 4 L 32 12 L 35 6 L 38 12" stroke="currentColor" stroke-width="2" fill="currentColor"/><path d="M 10 30 Q 10 14 25 14 Q 40 14 40 30 L 40 42 L 10 42 Z" stroke="currentColor" stroke-width="2"/><path d="M 15 24 L 22 22" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/><path d="M 28 22 L 35 24" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/><path d="M 18 33 L 24 35 L 32 33" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>',
  },
  buy_and_hold_v1: {
    callsign: 'STONE', role: 'SENTINEL · BUY_HOLD', cls: 'persona-stone',
    title: 'STONE — The Sentinel. Plants flag, holds ground regardless of weather.',
    svg: '<svg viewBox="0 0 50 50" fill="none"><circle cx="25" cy="22" r="14" stroke="currentColor" stroke-width="2"/><path d="M 13 22 Q 25 8 37 22" stroke="currentColor" stroke-width="1.5" opacity="0.6"/><circle cx="25" cy="24" r="2.5" fill="currentColor"/><path d="M 22 28 Q 25 32 28 28" stroke="currentColor" stroke-width="1.2" opacity="0.8"/><path d="M 6 42 Q 25 32 44 42 L 44 46 L 6 46 Z" fill="currentColor" opacity="0.4"/></svg>',
  },
  ai_strategy_v1: {
    callsign: 'ORACLE', role: 'SEER · AI_FILTER', cls: 'persona-oracle',
    title: 'ORACLE — The Seer. Channels Haiku to approve or reject signals.',
    svg: '<svg viewBox="0 0 50 50" fill="none"><path d="M 25 5 L 45 42 L 5 42 Z" stroke="currentColor" stroke-width="2"/><ellipse cx="25" cy="28" rx="11" ry="6" stroke="currentColor" stroke-width="1.5"/><circle cx="25" cy="28" r="3.5" fill="currentColor"/><line x1="25" y1="11" x2="25" y2="16" stroke="currentColor" stroke-width="1.2" opacity="0.7"/><line x1="14" y1="38" x2="17" y2="35" stroke="currentColor" stroke-width="1.2" opacity="0.7"/><line x1="36" y1="38" x2="33" y2="35" stroke="currentColor" stroke-width="1.2" opacity="0.7"/><line x1="25" y1="20" x2="25" y2="22" stroke="currentColor" stroke-width="1" opacity="0.5"/></svg>',
  },
  mean_reversion_short_v1: {
    callsign: 'VOID', role: 'REAPER · MR_SHORT', cls: 'persona-void',
    title: 'VOID — The Reaper. Shorts overheated prices on the perp engine. Reaps when markets revert.',
    // Hooded reaper silhouette with curved scythe blade
    svg: '<svg viewBox="0 0 50 50" fill="none"><path d="M 12 36 Q 12 16 25 16 Q 38 16 38 36 L 38 44 L 12 44 Z" stroke="currentColor" stroke-width="2"/><path d="M 6 14 Q 16 4 22 12 L 20 14 Q 14 8 8 16 Z" stroke="currentColor" stroke-width="1.5" fill="currentColor" opacity="0.85"/><circle cx="20" cy="26" r="1.6" fill="currentColor"/><circle cx="30" cy="26" r="1.6" fill="currentColor"/><path d="M 20 32 L 30 32" stroke="currentColor" stroke-width="1" opacity="0.6"/></svg>',
  },
  momentum_v1: {
    callsign: 'HUNTER', role: 'TRACKER · MOMENTUM', cls: 'persona-hunter',
    title: 'HUNTER — The Tracker. Picks the strongest scent (trend) and runs with it. Buys breakouts confirmed by SMA alignment.',
    // Wolf/predator silhouette: pointed ears, alert eyes, snout
    svg: '<svg viewBox="0 0 50 50" fill="none"><path d="M 10 20 L 14 8 L 20 16" stroke="currentColor" stroke-width="2" fill="currentColor" opacity="0.8"/><path d="M 30 16 L 36 8 L 40 20" stroke="currentColor" stroke-width="2" fill="currentColor" opacity="0.8"/><path d="M 10 20 Q 10 32 18 40 L 25 44 L 32 40 Q 40 32 40 20" stroke="currentColor" stroke-width="2" fill="none"/><path d="M 18 38 L 25 44 L 32 38" stroke="currentColor" stroke-width="1" opacity="0.6"/><circle cx="18" cy="26" r="1.8" fill="currentColor"/><circle cx="32" cy="26" r="1.8" fill="currentColor"/><path d="M 22 33 L 25 36 L 28 33" stroke="currentColor" stroke-width="1.5" fill="none" stroke-linecap="round"/></svg>',
  },
};

// Compute rank from total realized P&L
function rankFromPnL(pnl) {
  if (pnl >= 10000) return { code: 'ELITE-V', tier: 5 };
  if (pnl >= 5000)  return { code: 'ELITE-IV', tier: 4 };
  if (pnl >= 1000)  return { code: 'ELITE-III', tier: 3 };
  if (pnl >= 250)   return { code: 'EX-II', tier: 2 };
  if (pnl >= 0)     return { code: 'EX-I', tier: 1 };
  return { code: 'RECRUIT', tier: 0 };
}

function fmtUsd(n) {
  if (!Number.isFinite(n)) return '—';
  const sign = n < 0 ? '−' : '';
  const v = Math.abs(n);
  return sign + '$' + v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function fmtPrice(n, decimals = 4) {
  if (!Number.isFinite(n)) return '—';
  // For very small prices (BONK-style): show first 3 significant digits
  // e.g. 0.00000626 → $0.00000626 (compact: $0.0₅626 if browsers supported subscript)
  if (n > 0 && n < 0.001) {
    // Find leading zeros after decimal
    const log = Math.floor(Math.log10(n));      // e.g. -6 for 0.000006
    const sigDigits = Math.max(2, -log + 2);    // ~ 4 significant digits
    return '$' + n.toFixed(sigDigits);
  }
  return '$' + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: decimals });
}

function fmtPct(n) {
  if (!Number.isFinite(n)) return '—';
  return (n >= 0 ? '+' : '') + n.toFixed(2) + '%';
}

// ========================================================================
// STATE — track last-seen IDs to detect new events for sound + notif
// ========================================================================
let lastTradeId = -1;
let lastAiDecisionTs = '';
let lastAiActionId = -1;
let prevTickPrices = new Map(); // mint → last price for tick detection

// ========================================================================
// FETCH + RENDER
// ========================================================================
async function fetchJson(path) {
  const r = await fetch(path, { cache: 'no-store' });
  if (!r.ok) throw new Error(path + ' ' + r.status);
  return r.json();
}

async function refresh() {
  try {
    const [status, symbols, strategies, history, decisions, actions, positions, perps, perpsClosed, risk] = await Promise.all([
      fetchJson('/status'),
      fetchJson('/symbols'),
      fetchJson('/strategies'),
      fetchJson('/history?limit=15'),
      fetchJson('/ai/decisions?limit=8').catch(() => []),
      fetchJson('/ai/actions?limit=5').catch(() => []),
      fetchJson('/positions'),
      fetchJson('/perps').catch(() => ({ positions: [] })),
      fetchJson('/perps/closed?limit=10').catch(() => []),
      fetchJson('/risk'),
    ]);

    // Optional whitelist (graceful if endpoint missing on older builds)
    let whitelist = {};
    try { whitelist = await fetchJson('/whitelist'); } catch {}

    renderScore(status, risk);
    renderTicker(symbols.symbols, status);
    await renderCards(strategies.strategies, status, positions, perps, whitelist);
    renderActivity(history, decisions, actions, perps, perpsClosed);
    renderDetails(status, risk);

  } catch (e) {
    console.error('refresh failed', e);
  }
}

function renderScore(status, risk) {
  const totalPnl = status.tradeSummary?.totalRealizedPnl ?? 0;
  const wins = status.tradeSummary?.wins ?? 0;
  const losses = status.tradeSummary?.losses ?? 0;
  const winRate = status.tradeSummary?.winRate ?? 0;
  const dailyPnl = status.dailyRealizedPnL ?? 0;
  const dayStartNav = status.dailyStartingValueQuote || 1;
  const dailyPct = (dailyPnl / dayStartNav) * 100;
  const lossLimit = (risk.maxDailyLossPercent ?? 0.05) * 100;

  // Score
  const scoreEl = document.getElementById('score');
  scoreEl.textContent = fmtUsd(totalPnl);
  scoreEl.className = 'score ' + (totalPnl >= 0 ? 'pos' : 'neg');
  document.getElementById('scoreSub').textContent =
    fmtPct(totalPnl >= 0 ? winRate : -winRate * 0) + ' hit · ' +
    (status.tradeSummary?.closedTrades ?? 0) + ' closed trades';

  // Mode label
  const mode = (status.mode || '').toUpperCase();
  const regime = (status.regime || 'unknown').toUpperCase();
  document.getElementById('modeLabel').textContent = mode + ' · ' + regime;

  // Daily-loss XP bar (fills toward red as you approach circuit breaker)
  const fillPct = dailyPct < 0 ? Math.min(100, (Math.abs(dailyPct) / lossLimit) * 100) : 0;
  const fillEl = document.getElementById('xpFill');
  fillEl.style.width = fillPct + '%';
  fillEl.classList.toggle('danger', fillPct > 50);
  document.getElementById('xpPct').textContent = fmtPct(dailyPct) + ' / -' + lossLimit.toFixed(1) + '%';

  // Stats
  document.getElementById('wins').textContent = wins;
  document.getElementById('losses').textContent = losses;
  document.getElementById('streak').textContent = computeStreak(status.recentTrades || []);
  document.getElementById('winRate').textContent = winRate.toFixed(1) + '%';

  // Rank
  document.getElementById('rank').textContent = rankFromPnL(totalPnl).code;
}

function computeStreak(recentTrades) {
  // recentTrades is newest-first; walk until we see a loss
  let streak = 0;
  for (const t of recentTrades) {
    if (t.exit_reason === null || t.exit_reason === undefined) continue;
    const pnl = parseFloat(t.realized_pnl);
    if (!Number.isFinite(pnl)) continue;
    if (pnl > 0) streak++;
    else break;
  }
  return streak;
}

/**
 * Compact ticker strip — replaces the verbose Targets section.
 * One row per symbol: regime dot + ticker + price + dev-from-SMA %.
 * Click a cell → could expand a chart later; for now it just pulses on tick.
 */
function renderTicker(symbols, status) {
  const container = document.getElementById('ticker');
  const overallRegime = status.regime || 'ranging';

  // Preserve corner SVGs at start/end
  const cellsHtml = symbols.map((s) => {
    if (s.price === null || s.price === undefined) {
      return '<div class="ticker-cell" data-mint="' + s.mint + '"><span class="sym">' + s.symbol + '</span><span class="px">—</span><span class="ch">…</span></div>';
    }
    const dev = s.sma20 && s.sma20 !== 0 ? ((s.price - s.sma20) / s.sma20) * 100 : 0;
    const cls = dev >= 0 ? 'pos' : 'neg';
    const arrow = dev >= 0 ? '▲' : '▼';
    const regime = s.symbol === 'SOL' ? overallRegime : 'ranging';
    return '<div class="ticker-cell" data-mint="' + s.mint + '">' +
      '<span class="sym"><span class="reg ' + regime + '" title="' + regime + '"></span>' + s.symbol + '</span>' +
      '<span class="px">' + fmtPrice(s.price) + '</span>' +
      '<span class="ch ' + cls + '">' + arrow + Math.abs(dev).toFixed(2) + '%</span>' +
      '</div>';
  }).join('');

  container.innerHTML = '<span class="corner-tl"></span><span class="corner-bl"></span>' + cellsHtml;

  // Pulse on price change + sound
  for (const s of symbols) {
    if (s.price === null) continue;
    const prev = prevTickPrices.get(s.mint);
    if (prev !== undefined && prev !== s.price) {
      const cell = container.querySelector('[data-mint="' + s.mint + '"]');
      if (cell) { cell.classList.remove('tick'); void cell.offsetWidth; cell.classList.add('tick'); SFX.tick(); }
    }
    prevTickPrices.set(s.mint, s.price);
  }
}

/**
 * Big strategy cards — the new centerpiece of the dashboard.
 * Each card shows: avatar, callsign/role, state badge, whitelist chips,
 * 6 KPIs (P&L total, P&L today, W/L, win rate, expectancy, risk-mult),
 * and live open positions. Cooldown drain bar at the bottom when active.
 */
async function renderCards(strategies, status, positionsRes, perpsRes, whitelist) {
  const container = document.getElementById('cards');

  // Per-strategy status in parallel
  const stratStatuses = await Promise.all(
    strategies.map((s) => fetchJson('/strategies/' + s.name + '/status').catch(() => null))
  );

  // Index open positions by strategy
  const posByStrat = {};
  for (const p of (positionsRes.positions || [])) {
    (posByStrat[p.strategy] = posByStrat[p.strategy] || []).push({ ...p, kind: 'spot' });
  }
  for (const p of (perpsRes.positions || [])) {
    (posByStrat[p.strategy] = posByStrat[p.strategy] || []).push({ ...p, kind: 'perp' });
  }

  // Render order: put Hunter/Rush/Stone (winners + benchmark) on top
  const order = ['momentum_v1', 'breakout_v1', 'buy_and_hold_v1', 'ai_strategy_v1', 'mean_reversion_v1', 'mean_reversion_short_v1'];
  const sorted = [...strategies].sort((a, b) => {
    const ai = order.indexOf(a.name); const bi = order.indexOf(b.name);
    return (ai < 0 ? 99 : ai) - (bi < 0 ? 99 : bi);
  });

  container.innerHTML = sorted.map((s) => {
    const stat = stratStatuses[strategies.findIndex((x) => x.name === s.name)];
    if (!stat) return '';
    const persona = PERSONAS[s.name];
    if (!persona) return '';

    // ── State classification ────────────────────────────────────
    const cdSec = Math.ceil((stat.cooldownRemaining || 0) / 1000);
    const lastTradeMs = stat.lastTradeTimestamp ? Date.now() - new Date(stat.lastTradeTimestamp).getTime() : Infinity;
    const idleDays = lastTradeMs / 86400000;
    const wlList = whitelist[s.name];
    const isDisabled = Array.isArray(wlList) && wlList.length === 0;

    let stateClass = 'idle';
    let stateLabel = 'IDLE';
    if (isDisabled) { stateClass = 'disabled'; stateLabel = 'DISABLED'; }
    else if (cdSec > 0) { stateClass = 'cooldown'; stateLabel = 'COOLDOWN ' + cdSec + 's'; }
    else if (!stat.regimeAllowed) { stateClass = 'gated'; stateLabel = 'GATED · ' + (stat.regime || '').toUpperCase(); }
    else if (stat.openPositions > 0) { stateClass = 'active'; stateLabel = stat.openPositions + ' OPEN'; }
    else if (idleDays > 2 && Number.isFinite(idleDays)) { stateClass = 'idle'; stateLabel = 'IDLE ' + idleDays.toFixed(0) + 'd'; }
    else { stateClass = 'active'; stateLabel = 'ARMED'; }

    // ── Stats ──────────────────────────────────────────────────
    const totalPnl = stat.totalPnL ?? 0;
    const todayPnl = stat.dailyRealizedPnLNet ?? stat.dailyRealizedPnL ?? 0;
    const wins = stat.wins ?? 0;
    const losses = stat.losses ?? 0;
    const winRate = stat.winRate ?? 0;
    const expectancy = stat.expectancy ?? 0;
    const riskMult = stat.riskMultiplier ?? 1.0;
    const portfolioValue = stat.portfolio?.currentValue ?? 0;

    // ── Whitelist chips ────────────────────────────────────────
    let wlHtml;
    if (isDisabled) {
      wlHtml = '<span class="wl-label">SYMBOLS</span><span class="wl-chip disabled-tag">DISABLED</span>';
    } else if (Array.isArray(wlList) && wlList.length > 0) {
      wlHtml = '<span class="wl-label">SYMBOLS</span>' +
        wlList.map((sym) => '<span class="wl-chip">' + sym + '</span>').join('');
    } else {
      wlHtml = '<span class="wl-label">SYMBOLS</span><span class="wl-chip all-tag">ALL</span>';
    }

    // ── Open positions ─────────────────────────────────────────
    const positions = posByStrat[s.name] || [];
    let posHtml = '';
    if (positions.length > 0) {
      posHtml = '<div class="openpos">' + positions.map((p) => {
        const sym = SYMBOL_BY_MINT[p.mint] || p.symbol || p.mint.slice(0, 4);
        if (p.kind === 'perp') {
          const pnl = p.unrealizedNet ?? 0;
          const pnlCls = pnl >= 0 ? 'pos' : 'neg';
          const dirCls = p.direction === 'short' ? 'short' : 'long';
          const dirText = p.direction === 'short' ? 'SHORT' : 'LONG';
          return '<div class="openpos-row">' +
            '<span class="pos-sym">' + sym + '</span>' +
            '<span class="pos-info">' + dirText + ' ' + (p.leverage || 1) + 'x @ ' + fmtPrice(p.entryPrice) + ' · liq ' + fmtPrice(p.liquidationPrice) + ' · funding −$' + (p.fundingAccrued ?? 0).toFixed(2) + '</span>' +
            '<span class="pos-tag ' + dirCls + '">' + dirText[0] + '</span>' +
            '<span class="pos-pnl ' + pnlCls + '">' + fmtUsd(pnl) + '</span>' +
            '</div>';
        }
        const pnl = p.unrealizedPnlNet ?? p.unrealizedPnlQuote ?? 0;
        const pnlCls = pnl >= 0 ? 'pos' : 'neg';
        return '<div class="openpos-row">' +
          '<span class="pos-sym">' + sym + '</span>' +
          '<span class="pos-info">LONG @ ' + fmtPrice(p.entryPrice) + '</span>' +
          '<span class="pos-tag long">L</span>' +
          '<span class="pos-pnl ' + pnlCls + '">' + fmtUsd(pnl) + '</span>' +
          '</div>';
      }).join('') + '</div>';
    }

    // ── Cooldown drain bar ────────────────────────────────────
    const cdBar = cdSec > 0
      ? '<div class="cd-bar" style="width:' + Math.min(100, cdSec * 2) + '%"></div>'
      : '';

    return '<div class="card ' + stateClass + ' ' + persona.cls + '" title="' + persona.title + '">' +
      '<div class="avatar">' + persona.svg + '</div>' +
      '<div class="head">' +
        '<span class="callsign">' + persona.callsign + '</span>' +
        '<span class="role">' + persona.role + '</span>' +
        '<span class="state-badge ' + stateClass + '">' + stateLabel + '</span>' +
      '</div>' +
      '<div class="wl">' + wlHtml + '</div>' +
      '<div class="stats">' +
        '<div class="stat"><div class="v ' + (totalPnl >= 0 ? 'pos' : 'neg') + '">' + fmtUsd(totalPnl) + '</div><div class="l">P&L Total</div></div>' +
        '<div class="stat"><div class="v ' + (todayPnl >= 0 ? 'pos' : 'neg') + '">' + fmtUsd(todayPnl) + '</div><div class="l">Today</div></div>' +
        '<div class="stat"><div class="v">' + wins + '/' + losses + '</div><div class="l">W / L</div></div>' +
        '<div class="stat"><div class="v">' + winRate.toFixed(1) + '%</div><div class="l">Win Rate</div></div>' +
        '<div class="stat"><div class="v ' + (expectancy >= 0 ? 'pos' : 'neg') + '">' + fmtUsd(expectancy) + '</div><div class="l">Expect</div></div>' +
        '<div class="stat"><div class="v">' + riskMult.toFixed(2) + 'x</div><div class="l">Risk Mult</div></div>' +
      '</div>' +
      posHtml +
      cdBar +
    '</div>';
  }).join('');
}

function renderActivity(history, decisions, actions, perpsOpenRes, perpsClosed) {
  const items = [];

  // Perp opens — pull from currently-open perps (so they show in feed even
  // before they close). Use entryTime as the timestamp.
  for (const p of (perpsOpenRes?.positions || [])) {
    items.push({
      ts: new Date(p.entryTime).getTime(),
      tag: 'OPEN',
      tagCls: 'open',
      msg: 'OPEN · <b>' + p.symbol + '</b> · ' + p.direction.toUpperCase() + ' ' + p.leverage + 'x · ' + (p.strategy || '') + ' @ ' + fmtPrice(p.entryPrice),
      id: 'po' + p.id,
      strategy: p.strategy,
    });
  }

  // Perp closes — most recent first
  for (const c of (perpsClosed || [])) {
    const pnl = c.realizedPnlUsdc ?? 0;
    const cls = pnl >= 0 ? 'win' : 'loss';
    const sign = pnl >= 0 ? '+' : '−';
    const reasonTag = c.exitReason === 'liquidation' ? 'loss' : cls;
    const reasonLabel = c.exitReason === 'liquidation' ? 'LIQ' : cls.toUpperCase();
    items.push({
      ts: new Date(c.exitTime).getTime(),
      tag: reasonLabel,
      tagCls: reasonTag,
      msg: 'CLOSE · <b>' + c.symbol + '</b> · ' + c.direction.toUpperCase() + ' ' + c.leverage + 'x · ' + c.exitReason + ' · <span class="pnl-' + (pnl >= 0 ? 'pos' : 'neg') + '">' + sign + '$' + Math.abs(pnl).toFixed(2) + '</span>',
      id: 'pc' + c.id,
      strategy: c.strategy,
    });
  }


  // Trades — newest first, classify as open/win/loss
  for (const t of history) {
    const ts = new Date(t.timestamp).getTime();
    // For close rows, the strategy field on exit rows is "risk_exit_*" or
    // "close_*". Normalize back to the underlying strategy by looking at the
    // closed-position entry — but we don't have that here. Use t.strategy as-is.
    // The combat log treats risk_exit_take_profit etc. as system events.
    // Trades-with-exit records the exiting strategy alias; use input_mint→USDC
    // pattern to know it's a sell.
    const stratRaw = t.strategy || '';
    // Map alias forms back to canonical strategy if possible
    const strategy = stratRaw.startsWith('risk_exit_') || stratRaw.startsWith('close_')
      ? null  // exit alias — strategy unknown from this row alone
      : stratRaw;

    if (t.exit_reason) {
      const pnl = parseFloat(t.realized_pnl);
      const cls = pnl >= 0 ? 'win' : 'loss';
      const sign = pnl >= 0 ? '+' : '−';
      const symbol = symbolFromMint(t.input_mint) === 'USDC' ? symbolFromMint(t.output_mint) : symbolFromMint(t.input_mint);
      items.push({
        ts, tag: cls.toUpperCase(), tagCls: cls,
        msg: 'CLOSE · <b>' + symbol + '</b> · ' + t.exit_reason + ' · <span class="pnl-' + (pnl >= 0 ? 'pos' : 'neg') + '">' + sign + '$' + Math.abs(pnl).toFixed(2) + '</span>',
        id: 't' + t.id,
        strategy,
      });
    } else if (t.status === 'paper_filled' || t.status === 'success') {
      const symbol = symbolFromMint(t.input_mint) === 'USDC' ? symbolFromMint(t.output_mint) : symbolFromMint(t.input_mint);
      items.push({
        ts, tag: 'OPEN', tagCls: 'open',
        msg: 'OPEN · <b>' + symbol + '</b> · ' + (strategy || 'manual') + ' · ' + fmtPrice(t.price_at_trade || 0),
        id: 't' + t.id,
        strategy,
      });
    }
  }

  // AI decisions — always Oracle persona
  for (const d of decisions) {
    const ts = new Date(d.timestamp).getTime();
    items.push({
      ts, tag: 'AI', tagCls: 'ai',
      msg: 'Decider <b>' + (d.action || '?').toUpperCase() + '</b> · conf ' + (d.confidence ?? 0) + ' · "' + (d.reason || '').slice(0, 80) + '"',
      id: 'd' + d.id,
      strategy: 'ai_strategy_v1',
    });
  }

  // AI actions (auto-tune, reviewer) — credited to the strategy being tuned
  for (const a of actions) {
    const ts = new Date(a.timestamp).getTime();
    items.push({
      ts, tag: 'TUNE', tagCls: 'tune',
      msg: a.source + ' · ' + (a.strategy || '') + ' · ' + (a.key || '') + ' <b>' + a.old_value + ' → ' + a.new_value + '</b>',
      id: 'a' + a.id,
      strategy: a.strategy || null,
    });
  }

  // Sort by timestamp desc
  items.sort((a, b) => b.ts - a.ts);

  // Detect new events for sound/notif
  const newestTradeId = Math.max(...history.map((t) => t.id), 0);
  if (lastTradeId > 0 && newestTradeId > lastTradeId) {
    const newest = history[0];
    if (newest.exit_reason) {
      const pnl = parseFloat(newest.realized_pnl);
      if (pnl >= 0) { SFX.win(); notify('✓ TAKE PROFIT · ' + (newest.exit_reason.toUpperCase()) + ' · +$' + pnl.toFixed(2)); }
      else { SFX.loss(); notify('✗ ' + newest.exit_reason.toUpperCase() + ' · −$' + Math.abs(pnl).toFixed(2), 'loss'); }
    } else {
      SFX.open(); notify('▲ POSITION OPENED · ' + (newest.strategy || ''));
    }
  }
  lastTradeId = newestTradeId;

  if (decisions.length > 0 && lastAiDecisionTs && decisions[0].timestamp > lastAiDecisionTs) {
    SFX.ai();
  }
  lastAiDecisionTs = decisions[0]?.timestamp || lastAiDecisionTs;

  const newestActionId = actions.length > 0 ? actions[0].id : 0;
  if (lastAiActionId > 0 && newestActionId > lastAiActionId) {
    notify('◆ AI ' + actions[0].source + ' · ' + actions[0].key + ' tuned');
  }
  lastAiActionId = newestActionId;

  // Render top 25 with strategy avatar prepended
  const top = items.slice(0, 25);
  document.getElementById('log').innerHTML = top.map((it) => {
    const persona = it.strategy ? PERSONAS[it.strategy] : null;
    const avatar = persona
      ? '<span class="log-avatar ' + persona.cls + '" title="' + persona.callsign + '">' + persona.svg + '</span>'
      : '<span class="log-avatar system" title="system">·</span>';
    return '<div class="log-entry">' +
      avatar +
      '<span class="t">' + fmtTime(it.ts) + '</span>' +
      '<span class="tag ' + it.tagCls + '">' + it.tag + '</span>' +
      '<span class="msg">' + it.msg + '</span>' +
    '</div>';
  }).join('') || '<div class="loading">No activity</div>';
}

function renderDetails(status, risk) {
  const uptimeSec = status.uptimeMs ? Math.floor(status.uptimeMs / 1000) : 0;
  const h = Math.floor(uptimeSec / 3600), m = Math.floor((uptimeSec % 3600) / 60);
  document.getElementById('detailsBody').innerHTML = [
    '<div class="dp-row"><span class="l">MODE</span><span class="v">' + (status.mode || '').toUpperCase() + '</span></div>',
    '<div class="dp-row"><span class="l">UPTIME</span><span class="v">' + h + 'h ' + m + 'm</span></div>',
    '<div class="dp-row"><span class="l">DAY-START NAV</span><span class="v">' + fmtUsd(status.dailyStartingValueQuote || 0) + '</span></div>',
    '<div class="dp-row"><span class="l">RISK / TRADE</span><span class="v">' + ((risk.riskPerTradePercent ?? 0) * 100).toFixed(1) + '%</span></div>',
    '<div class="dp-row"><span class="l">MAX OPEN</span><span class="v">' + (risk.maxOpenPositions ?? '—') + '</span></div>',
    '<div class="dp-row"><span class="l">REGIME</span><span class="v">' + (status.regime || '').toUpperCase() + ' · vol ' + ((status.volatility ?? 0) * 100).toFixed(2) + '%</span></div>',
    '<div class="dp-row"><span class="l">PORTFOLIO</span><span class="v">' + fmtUsd(status.paperPortfolio?.pnl?.currentValue || 0) + '</span></div>',
  ].join('');
}

const SYMBOL_BY_MINT = {
  'So11111111111111111111111111111111111111112': 'SOL',
  'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v': 'USDC',
  'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB': 'USDT',
  'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN': 'JUP',
  'jtojtomepa8beP8AuQc6eXt5FriJwfFMwQx2v2f9mCL': 'JTO',
  'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263': 'BONK',
  'EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm': 'WIF',
};
function symbolFromMint(mint) { return SYMBOL_BY_MINT[mint] || (mint || '').slice(0, 4); }

function fmtTime(ts) {
  const d = new Date(ts);
  const today = new Date();
  if (d.toDateString() === today.toDateString()) {
    return d.toTimeString().slice(0, 8);
  }
  return (d.getMonth() + 1).toString().padStart(2, '0') + '-' + d.getDate().toString().padStart(2, '0') + ' ' + d.toTimeString().slice(0, 5);
}

// Expose SFX globally so inline onclick can hit it
window.SFX = SFX;

// First render + 4s refresh loop
refresh();
setInterval(refresh, 4000);

// Score sweep on first user click
document.addEventListener('click', function startup() {
  if (!SFX.isMuted()) SFX.sweepUp();
}, { once: true });
</script>
</body>
</html>`;
}
