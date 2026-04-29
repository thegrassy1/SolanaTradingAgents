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
  .layout { display: grid; grid-template-columns: 1fr; gap: 14px; }
  @media (min-width: 900px) {
    .layout { grid-template-columns: 240px 1fr; gap: 18px; }
    .col-sidebar, .col-main { display: flex; flex-direction: column; gap: 8px; }
    .col-sidebar .hdr, .col-main .hdr { margin: 6px 0 4px; }
    .score-panel { grid-column: 1 / -1; }
    .col-sidebar .loadout { grid-template-columns: 1fr; gap: 1px; }
    .col-sidebar .slot {
      display: grid;
      grid-template-columns: 52px 1fr;
      grid-template-rows: auto auto;
      align-items: center; gap: 12px;
      text-align: left; padding: 14px 12px; min-height: 0;
    }
    .col-sidebar .slot .avatar { margin: 0; width: 48px; height: 48px; grid-row: 1; grid-column: 1; }
    .col-sidebar .slot > div:nth-child(2) { grid-row: 1; grid-column: 2; }
    .col-sidebar .slot .stats-mini { grid-row: 2; grid-column: 1 / -1; margin-top: 8px; }
    .col-sidebar .slot .callsign { font-size: 14px; }
    .col-sidebar .slot .role { font-size: 10px; margin-top: 2px; }
    .col-sidebar .slot .status { font-size: 11px; margin-top: 4px; }
  }
  @media (min-width: 1400px) { .layout { grid-template-columns: 280px 1fr; } }

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

  .loadout { display: grid; grid-template-columns: repeat(4, 1fr); gap: 1px; background: var(--line-soft); }
  .slot { background: var(--bg-1); padding: 12px 8px; text-align: center; position: relative; min-height: 92px; --accent: var(--cyan); }
  .slot.persona-static { --accent: #00e5ff; }
  .slot.persona-rush   { --accent: #ff7a3c; }
  .slot.persona-stone  { --accent: #b985ff; }
  .slot.persona-oracle { --accent: #ff00d4; }
  .slot.persona-void   { --accent: #7d8a9b; }
  .slot .avatar {
    width: 44px; height: 44px; margin: 0 auto 6px;
    border: 1px solid var(--line);
    display: flex; align-items: center; justify-content: center;
    color: var(--accent);
    background: radial-gradient(circle at center, rgba(255,255,255,0.04), transparent 70%);
    transition: box-shadow 0.3s, border-color 0.3s;
  }
  .slot .avatar svg { width: 100%; height: 100%; display: block; }
  .slot .callsign { font-size: 13px; font-weight: 700; letter-spacing: 0.12em; color: var(--accent); text-shadow: 0 0 4px color-mix(in srgb, var(--accent) 50%, transparent); }
  .slot .role { font-size: 10px; letter-spacing: 0.1em; color: var(--muted); margin-top: 1px; }
  .slot .status { font-size: 11px; letter-spacing: 0.08em; margin-top: 4px; text-transform: uppercase; }
  .slot.active .status { color: var(--green); }
  .slot.cooldown .status { color: var(--amber); }
  .slot.idle .status { color: var(--muted); }
  .slot.disabled { opacity: 0.4; }
  .slot.active .avatar { border-color: var(--accent); box-shadow: 0 0 12px color-mix(in srgb, var(--accent) 40%, transparent), inset 0 0 8px color-mix(in srgb, var(--accent) 15%, transparent); }
  .slot.cooldown .avatar { border-color: var(--amber); }
  .slot.idle .avatar { opacity: 0.55; }

  /* Persona avatar animations (active state only) */
  @keyframes static-scan { 0%, 100% { transform: translateX(-3px); opacity: 0.6; } 50% { transform: translateX(3px); opacity: 1; } }
  .slot.persona-static.active .avatar svg line:nth-of-type(1),
  .slot.persona-static.active .avatar svg line:nth-of-type(2) { transform-origin: 25px 23px; animation: static-scan 2.4s ease-in-out infinite; }

  @keyframes rush-shake { 0%, 100% { transform: translateY(0); } 25% { transform: translateY(-1px) rotate(-1deg); } 75% { transform: translateY(0.5px) rotate(1deg); } }
  @keyframes rush-eye-pulse { 0%, 100% { stroke-width: 2.2; opacity: 1; } 50% { stroke-width: 3; opacity: 0.6; } }
  .slot.persona-rush.active .avatar svg path:first-of-type { transform-origin: 25px 12px; animation: rush-shake 0.6s ease-in-out infinite; }
  .slot.persona-rush.active .avatar svg path:nth-of-type(3),
  .slot.persona-rush.active .avatar svg path:nth-of-type(4) { animation: rush-eye-pulse 1.2s ease-in-out infinite; }

  @keyframes stone-blink { 0%, 92%, 100% { transform: scaleY(1); } 95% { transform: scaleY(0.1); } }
  .slot.persona-stone.active .avatar svg circle:last-of-type { transform-origin: 25px 24px; animation: stone-blink 4s ease-in-out infinite; }

  @keyframes oracle-scan { 0%, 100% { transform: translateX(-2.5px); } 50% { transform: translateX(2.5px); } }
  @keyframes oracle-rays { 0%, 100% { opacity: 0.4; } 50% { opacity: 1; } }
  .slot.persona-oracle.active .avatar svg circle { transform-origin: 25px 28px; animation: oracle-scan 3s ease-in-out infinite; }
  .slot.persona-oracle.active .avatar svg line { animation: oracle-rays 1.6s ease-in-out infinite; }

  /* VOID: scythe blade swings, hood drifts, eyes glow ominously */
  @keyframes void-scythe { 0%, 100% { transform: rotate(-4deg); } 50% { transform: rotate(4deg); } }
  @keyframes void-eyes { 0%, 100% { opacity: 0.6; } 50% { opacity: 1; } }
  .slot.persona-void.active .avatar svg path:nth-of-type(2) { transform-origin: 25px 30px; animation: void-scythe 2.6s ease-in-out infinite; }
  .slot.persona-void.active .avatar svg circle { animation: void-eyes 1.8s ease-in-out infinite; }

  /* Persona stats mini-bar */
  .slot .stats-mini { display: grid; grid-template-columns: repeat(3, 1fr); gap: 4px; margin-top: 8px; padding-top: 8px; border-top: 1px solid var(--line-soft); }
  .slot .stats-mini .sm-cell { text-align: center; }
  .slot .stats-mini .sm-cell .v { color: var(--fg); font-weight: 600; font-variant-numeric: tabular-nums; font-size: 13px; }
  .slot .stats-mini .sm-cell .v.pos { color: var(--green); }
  .slot .stats-mini .sm-cell .v.neg { color: var(--red); }
  .slot .stats-mini .sm-cell .l { color: var(--muted); font-size: 9px; letter-spacing: 0.06em; margin-top: 1px; }

  .slot .cd-bar { position: absolute; bottom: 0; left: 0; height: 2px; background: var(--amber); box-shadow: 0 0 4px var(--amber); }

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

<div class="col-sidebar">
<div class="hdr">Loadout</div>
<div class="hud" style="padding: 0;">
  <span class="corner-tl"></span><span class="corner-bl"></span>
  <div class="loadout" id="loadout"><div class="loading">LOADING…</div></div>
</div>
</div>

<div class="col-main">
<div class="hdr">Targets · <span id="targetCount">—</span> tracked</div>
<div class="hud" style="padding: 0;">
  <span class="corner-tl"></span><span class="corner-bl"></span>
  <div class="targets" id="targets"><div class="loading">LOADING…</div></div>
</div>

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

    renderScore(status, risk);
    renderTargets(symbols.symbols, status, positions, perps);
    await renderLoadout(strategies.strategies, status);
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

function renderTargets(symbols, status, positionsRes, perpsRes) {
  const container = document.getElementById('targets');
  document.getElementById('targetCount').textContent = symbols.length;

  // Map mint → open positions (spot longs)
  const posByMint = {};
  for (const p of (positionsRes.positions || [])) {
    posByMint[p.mint] = posByMint[p.mint] || [];
    posByMint[p.mint].push({ ...p, kind: 'spot' });
  }
  // Add perp positions, tagged with direction
  for (const p of (perpsRes.positions || [])) {
    posByMint[p.mint] = posByMint[p.mint] || [];
    posByMint[p.mint].push({ ...p, kind: 'perp' });
  }

  const overallRegime = status.regime || 'ranging';

  container.innerHTML = symbols.map((s) => {
    if (s.price === null || s.price === undefined) {
      return '<div class="target"><div class="marker">—</div><div><div class="name">' + s.symbol + '</div><div class="price">awaiting…</div></div><div class="change"></div><div></div></div><div class="target-expand"></div>';
    }
    const dev = s.sma20 && s.sma20 !== 0 ? ((s.price - s.sma20) / s.sma20) * 100 : 0;
    const cls = dev >= 0 ? 'pos' : 'neg';
    const arrow = dev >= 0 ? '▲' : '▼';
    // Per-symbol regime not yet computed — show overall regime as proxy
    const regime = s.symbol === 'SOL' ? overallRegime : 'ranging';

    const pos = posByMint[s.mint] || [];
    let badge = '<span class="pos-badge empty">—</span>';
    if (pos.length > 0) {
      // If any perp short is open, show 'S'. If both long+short, show split.
      const longs = pos.filter((p) => p.kind === 'spot' || (p.kind === 'perp' && p.direction === 'long'));
      const shorts = pos.filter((p) => p.kind === 'perp' && p.direction === 'short');
      if (longs.length > 0 && shorts.length > 0) {
        badge = '<span class="pos-badge long">' + longs.length + 'L</span><span class="pos-badge short" style="margin-left:4px">' + shorts.length + 'S</span>';
      } else if (shorts.length > 0) {
        badge = '<span class="pos-badge short">' + shorts.length + 'S</span>';
      } else {
        badge = '<span class="pos-badge long">' + longs.length + 'L</span>';
      }
    }

    const expandBody = pos.length > 0
      ? pos.map((p) => {
          if (p.kind === 'perp') {
            const pnl = p.unrealizedNet ?? 0;
            const pnlCls = pnl >= 0 ? 'pos' : 'neg';
            const dirLabel = p.direction === 'short' ? 'SHORT' : 'LONG';
            const fundingFmt = (p.fundingAccrued ?? 0).toFixed(2);
            return '<div class="te-row"><span class="l">' + (p.strategy || 'perp') + ' · ' + dirLabel + ' ' + (p.leverage || 1) + 'x @ ' + fmtPrice(p.entryPrice) + ' · funding −$' + fundingFmt + '</span><span class="v ' + pnlCls + '">' + fmtUsd(pnl) + '</span></div>' +
              '<div class="te-row"><span class="l" style="color:var(--amber)">LIQ ' + fmtPrice(p.liquidationPrice) + ' · equity ' + (p.equityPct ?? 100).toFixed(0) + '%</span><span class="v">collat ' + fmtUsd(p.collateralUsdc) + '</span></div>';
          }
          const pnl = p.unrealizedPnlNet ?? p.unrealizedPnlQuote ?? 0;
          const pnlCls = pnl >= 0 ? 'pos' : 'neg';
          return '<div class="te-row"><span class="l">' + (p.strategy || 'pos') + ' @ ' + fmtPrice(p.entryPrice) + '</span><span class="v ' + pnlCls + '">' + fmtUsd(pnl) + '</span></div>';
        }).join('')
      : '';

    return '<div class="target" data-mint="' + s.mint + '" data-prevprice="' + s.price + '" onclick="this.classList.toggle(\\'open\\'); window.SFX&&SFX.click()">' +
      '<div class="marker regime-' + regime + '">●</div>' +
      '<div><div class="name">' + s.symbol + '</div><div class="price">' + fmtPrice(s.price) + '</div></div>' +
      '<div class="change ' + cls + '"><span class="arrow">' + arrow + '</span>' + Math.abs(dev).toFixed(2) + '%</div>' +
      '<div>' + badge + '</div>' +
    '</div>' +
    '<div class="target-expand">' +
      '<div class="te-row"><span class="l">SMA20</span><span class="v">' + fmtPrice(s.sma20 || 0) + '</span></div>' +
      '<div class="te-row"><span class="l">VOL · 20</span><span class="v">' + ((s.volatility || 0) * 100).toFixed(2) + '%</span></div>' +
      '<div class="te-row"><span class="l">REGIME</span><span class="v">' + regime.toUpperCase() + '</span></div>' +
      '<div class="te-row"><span class="l">SAMPLES</span><span class="v">' + (s.sampleCount || 0) + '</span></div>' +
      expandBody +
    '</div>';
  }).join('');

  // Detect price ticks → pulse + sound
  for (const s of symbols) {
    if (s.price === null) continue;
    const prev = prevTickPrices.get(s.mint);
    if (prev !== undefined && prev !== s.price) {
      const row = container.querySelector('[data-mint="' + s.mint + '"]');
      if (row) { row.classList.remove('tick'); void row.offsetWidth; row.classList.add('tick'); SFX.tick(); }
    }
    prevTickPrices.set(s.mint, s.price);
  }
}

async function renderLoadout(strategies, status) {
  const container = document.getElementById('loadout');

  // Fetch per-strategy status in parallel
  const stratStatuses = await Promise.all(
    strategies.map((s) => fetchJson('/strategies/' + s.name + '/status').catch(() => null))
  );

  container.innerHTML = strategies.map((s, i) => {
    const persona = PERSONAS[s.name];
    if (!persona) return '';
    const stat = stratStatuses[i];
    if (!stat) return '';

    let stateClass = 'idle';
    let statusText = 'IDLE';

    const cdSec = Math.ceil((stat.cooldownRemaining || 0) / 1000);
    const lastTradeMs = stat.lastTradeTimestamp ? Date.now() - new Date(stat.lastTradeTimestamp).getTime() : Infinity;
    const idleDays = lastTradeMs / 86400000;

    if (cdSec > 0) {
      stateClass = 'cooldown';
      statusText = 'COOLDOWN ' + cdSec + 's';
    } else if (!stat.regimeAllowed) {
      stateClass = 'idle';
      statusText = 'GATED · ' + (stat.regime || '').toUpperCase();
    } else if (stat.openPositions > 0) {
      stateClass = 'active';
      statusText = stat.openPositions + ' OPEN';
    } else if (idleDays > 2) {
      stateClass = 'idle';
      statusText = 'IDLE ' + idleDays.toFixed(0) + 'd';
    } else {
      stateClass = 'active';
      statusText = 'ARMED';
    }

    const wins = stat.wins ?? 0;
    const losses = stat.losses ?? 0;
    const kdr = losses === 0 ? (wins > 0 ? '∞' : '0') : (wins / losses).toFixed(2);
    const totalPnl = stat.totalPnL ?? 0;
    const pnlCls = totalPnl >= 0 ? 'pos' : 'neg';

    const cdBar = cdSec > 0 ? '<div class="cd-bar" style="width:' + Math.min(100, cdSec * 2) + '%"></div>' : '';

    return '<div class="slot ' + stateClass + ' ' + persona.cls + '" title="' + persona.title + '">' +
      '<div class="avatar">' + persona.svg + '</div>' +
      '<div>' +
        '<div class="callsign">' + persona.callsign + '</div>' +
        '<div class="role">' + persona.role + '</div>' +
        '<div class="status">' + statusText + '</div>' +
      '</div>' +
      '<div class="stats-mini">' +
        '<div class="sm-cell"><div class="v">' + wins + '/' + losses + '</div><div class="l">W/L</div></div>' +
        '<div class="sm-cell"><div class="v">' + kdr + '</div><div class="l">KDR</div></div>' +
        '<div class="sm-cell"><div class="v ' + pnlCls + '">' + fmtUsd(totalPnl) + '</div><div class="l">P&L</div></div>' +
      '</div>' +
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
