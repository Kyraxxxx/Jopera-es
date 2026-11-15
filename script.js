'use strict';
// ============================================================
//  J TRADINGS — Bitcoin Exchange · front-end puro (GitHub-ready)
//  Canal de sync: http://127.0.0.1:47821/api/state (servidor do app)
//  Fallback: localStorage (mesma origem do iframe no Electron)
// ============================================================
const API_BASE = 'http://127.0.0.1:47821';
const SYNC_URL = API_BASE + '/api/state';
const CMD_URL = API_BASE + '/api/cmd';
const EQ_URL = API_BASE + '/api/equity';
const $ = id => document.getElementById(id);
const fmt$ = v => (v < 0 ? '-$' : '$') + Math.abs(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const lsGet = (k, d) => { try { return JSON.parse(localStorage.getItem(k) || d); } catch { return d; } };
const MONO = v => '$' + (v || 0).toLocaleString('en-US', { maximumFractionDigits: 0 });

const S = {
  price: 0, open: 0, high24: 0, low24: 0, vol24: 0, chg24: 0,
  candles: [], equity: [], markers: [],
  balance: 0, pos: 0, avg: 0, realized: 0,
  staffPos: new Map(),       // nome -> {pos, avg}
  traderStats: new Map(),    // nome -> {trades, wins, pnl}
  seenOrders: new Set(), seenPnl: new Set(),
  serverUp: false, lastStateTs: 0, meeting: false, historyLoaded: false,
};
const UP = '#0ECB81', DN = '#F6465D', ACCENT = '#F0B90B', BLUE = '#2E7CF6';

// ---------- helpers ----------
function stOf(who) {
  if (!who || who === 'MESA') return { pos: S.pos, avg: S.avg, main: true };
  if (!S.staffPos.has(who)) S.staffPos.set(who, { pos: 0, avg: 0 });
  return S.staffPos.get(who);
}
function orderKey(o) { return `${o.ts}|${o.trader}|${o.side}|${o.qty}`; }
function pnlKey(p) { return `${p.ts}|${p.trader}|${p.pnl}`; }

// ---------- mercado (Binance 24h) ----------
async function fetchMarket() {
  try {
    const r = await fetch('https://api.binance.com/api/v3/ticker/24hr?symbol=BTCUSDT');
    const j = await r.json();
    S.price = parseFloat(j.lastPrice);
    S.chg24 = parseFloat(j.priceChangePercent);
    S.high24 = parseFloat(j.highPrice);
    S.low24 = parseFloat(j.lowPrice);
    S.vol24 = parseFloat(j.volume);
    setConn('server', true);
  } catch {
    if (!S.serverUp) setConn('offline', false);
    if (!S.price) S.price = 67000 + Math.random() * 30000;
  }
}
function addTick() {
  if (!S.price) return;
  const now = Date.now();
  const last = S.candles[S.candles.length - 1];
  if (!last || now - last.t > 1000) {
    S.candles.push({ t: now, o: S.price, h: S.price, l: S.price, c: S.price });
    if (S.candles.length > 120) S.candles.shift();
  } else {
    last.c = S.price; last.h = Math.max(last.h, S.price); last.l = Math.min(last.l, S.price);
  }
}
setInterval(fetchMarket, 5000); fetchMarket();
setInterval(addTick, 250);

// ---------- conexão / sync ----------
function setConn(mode) {
  const dot = $('netDot'), net = $('net');
  S.serverUp = mode === 'server';
  dot.className = 'dot ' + (mode === 'server' ? 'on' : mode === 'local' ? 'mid' : '');
  net.textContent = mode === 'server' ? 'AO VIVO · APP' : mode === 'local' ? 'MODO LOCAL' : 'OFFLINE';
}
const trimSet = (set, n) => { if (set.size > n) { const keep = [...set].slice(-n >> 1); set.clear(); keep.forEach(k => set.add(k)); } };
async function pollServer() {
  try {
    const r = await fetch(SYNC_URL, { cache: 'no-store' });
    if (!r.ok) throw 0;
    const st = await r.json();
    setConn('server');
    // servidor cobre tudo via IPC — limpa filas locais para não duplicar depois
    try { localStorage.setItem('jt_orders', '[]'); localStorage.setItem('jt_pnl', '[]'); } catch {}
    ingestState(st);
  } catch {
    setConn('local');
    pollLocal(); // fallback: filas localStorage quando o app está fechado/acessando via GitHub Pages
  }
}
function ingestState(st) {
  if (!st || st.ts === S.lastStateTs) return;
  S.lastStateTs = st.ts;
  // ordens novas → executa no livro local (dedupe por chave)
  for (const o of (st.orders || [])) {
    const k = orderKey(o);
    if (S.seenOrders.has(k)) continue;
    S.seenOrders.add(k); trimSet(S.seenOrders, 800);
    execOrder(o.side, o.qty, o.trader || 'NPC', true);
  }
  // eventos de pnl → estatísticas por trader (win rate)
  for (const p of (st.pnl || [])) {
    const k = pnlKey(p);
    if (S.seenPnl.has(k)) continue;
    S.seenPnl.add(k); trimSet(S.seenPnl, 800);
    notePnl(p.trader, p.pnl);
  }
  // equipe + totais do banco
  S.dbStaff = st.staff || {};
  S.dbTotals = st.totals || null;
  // reunião → banner "MERCADO EM PAUSA" + bloqueia operação manual
  const wasMeeting = S.meeting;
  S.meeting = !!st.meeting;
  $('meetBanner').classList.toggle('hidden', !S.meeting);
  $('btnBuy').disabled = $('btnSell').disabled = S.meeting;
  $('btnBuy').style.opacity = $('btnSell').style.opacity = S.meeting ? .4 : 1;
  if (S.meeting && !wasMeeting) pushFeedSys('📅 Reunião executiva — mercado em pausa');
  if (!S.meeting && wasMeeting) pushFeedSys('✅ Reunião encerrada — operações retomadas');
  // semeia curva de patrimônio persistida na primeira sincronização
  if (!S.historyLoaded && Array.isArray(st.equity) && st.equity.length) {
    S.historyLoaded = true;
    S.equity = st.equity.slice(-300);
  }
  // histórico de ordens na primeira carga (feed não começa vazio)
  if (!S._histDone && Array.isArray(st.orders) && st.orders.length) {
    S._histDone = true;
    for (const o of st.orders.slice(-15).reverse()) {
      const d = document.createElement('div');
      d.className = 'ord ' + o.side + (o.trader ? ' npc' : '');
      d.innerHTML = `<span class="t">${new Date(o.ts).toLocaleTimeString('pt-BR')}</span><span>${o.side === 'buy' ? 'COMPRA' : 'VENDA'} ${o.qty} BTC <span class="who">· ${o.trader || 'MESA'}</span></span><span>—</span>`;
      $('feed').appendChild(d);
    }
  }
}
function pushFeedSys(msg) {
  const d = document.createElement('div');
  d.className = 'ord'; d.style.color = '#ffd54f'; d.style.borderLeft = '2px solid #ffd54f';
  d.innerHTML = `<span class="t">${new Date().toLocaleTimeString('pt-BR')}</span><span>${msg}</span><span></span>`;
  $('feed').prepend(d);
  while ($('feed').children.length > 80) $('feed').lastChild.remove();
}
// ---- comando remoto: site → jogo 3D ----
function sendCmd(payload) {
  try {
    fetch(CMD_URL, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    }).catch(() => {});
  } catch {}
  // fallback localStorage (lido pelo renderer quando o servidor está fora)
  try {
    const k = 'jt_cmd';
    const q = lsGet(k, []);
    q.push(payload); if (q.length > 50) q.splice(0, q.length - 50);
    localStorage.setItem(k, JSON.stringify(q));
  } catch {}
}
$('cmdMeet').onclick = (e) => { sendCmd({ cmd: 'reuniao' }); e.target.classList.add('sent'); setTimeout(() => e.target.classList.remove('sent'), 600); };
$('cmdEnd').onclick = (e) => { sendCmd({ cmd: 'fimreuniao' }); e.target.classList.add('sent'); setTimeout(() => e.target.classList.remove('sent'), 600); };
function pollLocal() {
  const q = lsGet('jt_orders', []);
  if (q.length) {
    try { localStorage.setItem('jt_orders', '[]'); } catch {}
    for (const o of q) if (o && o.trader && o.side) execOrder(o.side, o.qty, o.trader, false);
  }
  const pq = lsGet('jt_pnl', []);
  if (pq.length) {
    try { localStorage.setItem('jt_pnl', '[]'); } catch {}
    for (const p of pq) notePnl(p.trader, p.pnl);
  }
}
setInterval(pollServer, 900);

// ---------- execução de ordens ----------
function execOrder(side, qty, who, fromServer) {
  if (S.meeting && who === 'MESA') return; // mercado em pausa durante reunião
  qty = parseFloat(qty) || 0;
  if (qty <= 0 || !S.price) return;
  if (!fromServer && who === 'MESA') {
    // ordens manuais do operador → registra no app/banco via IPC
    try { window.electronAPI?.broker?.order?.({ trader: who, side, qty }); } catch {}
  }
  const signed = side === 'buy' ? qty : -qty;
  const st = stOf(who);
  const cur = st.pos, newPos = cur + signed;
  const reducing = cur !== 0 && (Math.sign(newPos) !== Math.sign(cur) || Math.abs(newPos) < Math.abs(cur));
  if (reducing) {
    const closed = Math.min(Math.abs(signed), Math.abs(cur));
    const rp = (S.price - st.avg) * closed * Math.sign(cur);
    S.realized += rp;
    notePnl(who, rp, true);
    reportPnl(who, rp);
  }
  if (newPos !== 0) {
    st.avg = (Math.sign(newPos) === Math.sign(cur) && cur !== 0)
      ? (st.avg * Math.abs(cur) + S.price * Math.abs(signed)) / Math.abs(newPos)
      : S.price;
  }
  st.pos = newPos;
  if (st.main) { S.pos = newPos; S.avg = st.avg; }
  S.balance = S.realized;
  // marcador no gráfico
  S.markers.push({ t: Date.now(), price: S.price, side, who });
  if (S.markers.length > 40) S.markers.shift();
  pushOrder(side, qty, who, st.pos);
  render();
}
function notePnl(who, pnl, alreadyCounted) {
  if (!who) return;
  const t = S.traderStats.get(who) || { trades: 0, wins: 0, pnl: 0 };
  if (!alreadyCounted) { t.trades++; if (pnl > 0) t.wins++; }
  t.pnl += pnl;
  S.traderStats.set(who, t);
}
function reportPnl(who, pnl) {
  try {
    const k = 'jt_pnl';
    const q = lsGet(k, []);
    q.push({ trader: who, pnl, price: S.price, ts: Date.now() });
    if (q.length > 200) q.splice(0, q.length - 200);
    localStorage.setItem(k, JSON.stringify(q));
  } catch {}
  try { window.electronAPI?.broker?.report?.({ trader: who, pnl, price: S.price, ts: Date.now() }); } catch {}
}
function pushOrder(side, qty, who, posAfter) {
  const feed = $('feed');
  const d = document.createElement('div');
  d.className = 'ord ' + side + (who && who !== 'MESA' ? ' npc' : '') + ' flash';
  d.innerHTML = `<span class="t">${new Date().toLocaleTimeString('pt-BR')}</span><span>${side === 'buy' ? 'COMPRA' : 'VENDA'} ${qty} BTC ${who && who !== 'MESA' ? `<span class="who">· ${who}</span>` : ''}</span><span>${MONO(S.price)}</span>`;
  feed.prepend(d);
  while (feed.children.length > 80) feed.lastChild.remove();
}
$('btnBuy').onclick = () => execOrder('buy', $('qty').value, 'MESA', false);
$('btnSell').onclick = () => execOrder('sell', $('qty').value, 'MESA', false);

// ---------- gráfico de candles + EMA/SMA + marcadores ----------
const cv = $('cv'), ctx = cv.getContext('2d');
const C_UP = UP, C_DN = DN;
function ema(vals, n) {
  const k = 2 / (n + 1); let e = vals[0] || 0; const out = [];
  for (const v of vals) { e = v * k + e * (1 - k); out.push(e); }
  return out;
}
function sma(vals, n) {
  const out = [];
  for (let i = 0; i < vals.length; i++) {
    if (i < n - 1) { out.push(null); continue; }
    let s = 0; for (let j = i - n + 1; j <= i; j++) s += vals[j];
    out.push(s / n);
  }
  return out;
}
function drawChart() {
  const W = cv.clientWidth, H = cv.clientHeight;
  if (!W || !H) return;
  const dpr = devicePixelRatio || 1;
  if (cv.width !== W * dpr) { cv.width = W * dpr; cv.height = H * dpr; }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = '#0B0E11'; ctx.fillRect(0, 0, W, H);
  const cs = S.candles; if (cs.length < 2) return;
  const padR = 64, padT = 10, padB = 22;
  const plotW = W - padR, plotH = H - padT - padB;
  const vis = cs.slice(-90);
  const closes = vis.map(c => c.c);
  const e20 = ema(closes, 20), s50 = sma(closes, 50);
  let mn = Infinity, mx = -Infinity;
  for (const c of vis) { mn = Math.min(mn, c.l); mx = Math.max(mx, c.h); }
  for (const v of [...e20, ...s50]) if (v != null) { mn = Math.min(mn, v); mx = Math.max(mx, v); }
  const rg = (mx - mn) || 1; mn -= rg * 0.07; mx += rg * 0.07;
  const n = vis.length;
  const X = i => (i / (n - 1)) * plotW;
  const Y = v => padT + (1 - (v - mn) / (mx - mn)) * plotH;
  // grid + preços eixo Y
  ctx.strokeStyle = 'rgba(43,49,57,.7)'; ctx.fillStyle = '#848E9C';
  ctx.font = '10px JetBrains Mono, monospace'; ctx.lineWidth = 1;
  for (let i = 0; i <= 5; i++) {
    const v = mn + (mx - mn) * i / 5, y = Y(v);
    ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(plotW, y); ctx.stroke();
    ctx.fillText(MONO(v), plotW + 6, y + 3);
  }
  const cw = plotW / n;
  vis.forEach((c, i) => {
    const x = X(i) + cw / 2, up = c.c >= c.o;
    ctx.strokeStyle = up ? C_UP : C_DN; ctx.fillStyle = up ? C_UP : C_DN;
    ctx.beginPath(); ctx.moveTo(x, Y(c.h)); ctx.lineTo(x, Y(c.l)); ctx.stroke();
    const yO = Y(c.o), yC = Y(c.c);
    ctx.globalAlpha = .92;
    ctx.fillRect(x - cw * .36, Math.min(yO, yC), Math.max(1, cw * .72), Math.max(1, Math.abs(yC - yO)));
    ctx.globalAlpha = 1;
  });
  // médias móveis
  const line = (arr, color, dash) => {
    ctx.strokeStyle = color; ctx.lineWidth = 1.4;
    ctx.setLineDash(dash || []);
    ctx.beginPath(); let started = false;
    arr.forEach((v, i) => {
      if (v == null) return;
      const x = X(i) + cw / 2, y = Y(v);
      started ? ctx.lineTo(x, y) : ctx.moveTo(x, y); started = true;
    });
    ctx.stroke(); ctx.setLineDash([]);
  };
  line(e20, ACCENT); line(s50, BLUE, [4, 3]);
  // linha do último preço (pontilhada)
  const lp = vis[n - 1].c, ly = Y(lp);
  ctx.strokeStyle = 'rgba(234,236,239,.5)'; ctx.setLineDash([5, 4]); ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(0, ly); ctx.lineTo(plotW, ly); ctx.stroke(); ctx.setLineDash([]);
  ctx.fillStyle = lp >= vis[n - 1].o ? C_UP : C_DN;
  ctx.fillRect(plotW + 2, ly - 8, padR - 4, 16);
  ctx.fillStyle = '#0B0E11'; ctx.font = 'bold 10px JetBrains Mono, monospace';
  ctx.fillText(MONO(lp), plotW + 6, ly + 3.5);
  // marcadores de ordens NPC
  const t0 = vis[0].t, t1 = vis[n - 1].t;
  ctx.font = 'bold 9px Inter, sans-serif';
  for (const m of S.markers) {
    if (m.t < t0 || m.price < mn || m.price > mx) continue;
    const i = ((m.t - t0) / Math.max(1, t1 - t0)) * (n - 1);
    const x = X(Math.max(0, Math.min(n - 1, i))) + cw / 2, y = Y(m.price);
    ctx.fillStyle = m.side === 'buy' ? C_UP : C_DN;
    ctx.beginPath();
    if (m.side === 'buy') { ctx.moveTo(x, y - 7); ctx.lineTo(x - 4.5, y + 3); ctx.lineTo(x + 4.5, y + 3); }
    else { ctx.moveTo(x, y + 7); ctx.lineTo(x - 4.5, y - 3); ctx.lineTo(x + 4.5, y - 3); }
    ctx.closePath(); ctx.fill();
  }
}
setInterval(drawChart, 250);

// ---------- curva de patrimônio ----------
const eq = $('eq'), eqx = eq.getContext('2d');
function drawEquity() {
  const W = eq.clientWidth, H = eq.clientHeight;
  if (!W || !H) return;
  const dpr = devicePixelRatio || 1;
  if (eq.width !== W * dpr) { eq.width = W * dpr; eq.height = H * dpr; }
  eqx.setTransform(dpr, 0, 0, dpr, 0, 0);
  eqx.fillStyle = '#0B0E11'; eqx.fillRect(0, 0, W, H);
  const h = S.equity; if (h.length < 2) {
    eqx.fillStyle = '#848E9C'; eqx.font = '11px Inter'; eqx.textAlign = 'center';
    eqx.fillText('Aguardando operações da equipe…', W / 2, H / 2); eqx.textAlign = 'left';
    return;
  }
  const pad = 8;
  let mn = Math.min(0, ...h.map(p => p.v)), mx = Math.max(1, ...h.map(p => p.v));
  const rg = (mx - mn) || 1; mn -= rg * .1; mx += rg * .1;
  const X = i => pad + (i / (h.length - 1)) * (W - pad * 2);
  const Y = v => H - pad - ((v - mn) / (mx - mn)) * (H - pad * 2);
  // linha zero
  if (mn < 0 && mx > 0) {
    eqx.strokeStyle = 'rgba(43,49,57,.8)'; eqx.setLineDash([4, 4]);
    eqx.beginPath(); eqx.moveTo(pad, Y(0)); eqx.lineTo(W - pad, Y(0)); eqx.stroke(); eqx.setLineDash([]);
  }
  // área com gradiente
  const grad = eqx.createLinearGradient(0, 0, 0, H);
  grad.addColorStop(0, 'rgba(14,203,129,.35)'); grad.addColorStop(1, 'rgba(14,203,129,0)');
  eqx.beginPath(); eqx.moveTo(X(0), Y(h[0].v));
  h.forEach((p, i) => eqx.lineTo(X(i), Y(p.v)));
  eqx.lineTo(X(h.length - 1), H); eqx.lineTo(X(0), H); eqx.closePath();
  eqx.fillStyle = grad; eqx.fill();
  // linha
  eqx.beginPath(); eqx.moveTo(X(0), Y(h[0].v));
  h.forEach((p, i) => eqx.lineTo(X(i), Y(p.v)));
  eqx.strokeStyle = h[h.length - 1].v >= 0 ? UP : DN; eqx.lineWidth = 1.6; eqx.stroke();
  // ponto final
  const last = h[h.length - 1];
  eqx.fillStyle = last.v >= 0 ? UP : DN;
  eqx.beginPath(); eqx.arc(X(h.length - 1), Y(last.v), 3, 0, 7); eqx.fill();
}
setInterval(drawEquity, 300);

// ---------- livro de ordens ----------
let bookSeed = 0;
function drawBook() {
  if (!S.price) return;
  bookSeed = (bookSeed * 9301 + 49297) % 233280;
  const rnd = () => bookSeed / 233280;
  let html = '';
  for (let i = 5; i >= 1; i--) {
    const p = S.price * (1 + i * 0.0004 + rnd() * 0.0002);
    html += `<div class="book-row ask"><span>${MONO(p)}</span><span class="sz">${(rnd() * 2).toFixed(3)}</span></div>`;
  }
  html += `<div class="book-mid">${MONO(S.price)}</div>`;
  for (let i = 1; i <= 5; i++) {
    const p = S.price * (1 - i * 0.0004 - rnd() * 0.0002);
    html += `<div class="book-row bid"><span>${MONO(p)}</span><span class="sz">${(rnd() * 2).toFixed(3)}</span></div>`;
  }
  $('book').innerHTML = html;
}
setInterval(drawBook, 900);

// ---------- equipe ----------
function renderStaff() {
  const grid = $('staffGrid');
  const staff = S.dbStaff && Object.keys(S.dbStaff).length ? S.dbStaff : lsGet('jt_staff', {});
  const names = Object.keys(staff);
  if (!names.length) {
    grid.innerHTML = '<div style="color:#848E9C;font-size:11px;grid-column:1/-1">Sincronizando equipe…</div>';
    return;
  }
  grid.innerHTML = names.map(n => {
    const s = staff[n] || {};
    const iq = s.iq || 0;
    const cls = iq >= 60 ? 'iq-hi' : iq >= 35 ? 'iq-md' : 'iq-lo';
    const ts = S.traderStats.get(n) || { trades: 0, wins: 0, pnl: 0 };
    const wr = ts.trades ? Math.round(ts.wins / ts.trades * 100) : 0;
    const ini = n.split(' ').map(w => w[0]).join('').slice(0, 2).toUpperCase();
    const prof = (s.profit || 0) + ts.pnl;
    return `<div class="staff-card">
      <div class="avatar">${ini}</div>
      <div class="staff-info">
        <div class="staff-name">${n}</div>
        <div class="staff-meta">QI ${iq} · ${ts.trades} ops · ${wr}% acerto</div>
      </div>
      <div class="staff-actions">
        <button class="mini-btn warn" data-trader="${n}" title="Corrigir erro / Advertir IA">⚠</button>
        <button class="mini-btn train" data-trader="${n}" title="Enviar estratégia de treinamento">🎓</button>
      </div>
      <span class="iq-pill ${cls}">${iq}</span>
    </div>`;
  }).join('');
  // ações remotas por trader
  grid.querySelectorAll('.mini-btn').forEach((b) => {
    b.onclick = () => {
      const cmd = b.classList.contains('warn') ? 'warn' : 'train';
      sendCmd({ cmd, trader: b.dataset.trader });
      b.classList.add('sent'); setTimeout(() => b.classList.remove('sent'), 600);
    };
  });
}
setInterval(renderStaff, 1500); renderStaff();

// ---------- metas diárias ----------
const GOALS = [
  { v: 0, label: 'Sair do Vermelho' },
  { v: 1000, label: 'Meta 1' },
  { v: 5000, label: 'Meta 2' },
];
const GOALS_KEY = 'jt_goals_v1';
let goalsDone = (() => { try { return JSON.parse(localStorage.getItem(GOALS_KEY) || '[]'); } catch { return []; } })();
function renderGoals(realized) {
  const el = $('goals');
  if (!el) return;
  el.innerHTML = GOALS.map((g) => {
    const done = realized >= g.v || (g.v === 0 && realized > -0.01);
    const pct = g.v === 0 ? (realized >= 0 ? 100 : Math.max(0, (realized / -500) * 100 + 100)) : Math.min(100, realized / g.v * 100);
    return `<div class="goal ${done ? 'done' : ''}">
      <div class="goal-top"><span>${g.v === 0 ? 'Meta: zerar o caixa' : g.label + ' · ' + fmt$(g.v)}</span><b>${fmt$(realized)}</b></div>
      <div class="goal-bar"><div class="goal-fill" style="width:${pct}%"></div></div>
    </div>`;
  }).join('');
  // celebração ao bater meta nova
  for (const g of GOALS) {
    if (realized >= g.v && !goalsDone.includes(g.v)) {
      goalsDone.push(g.v);
      try { localStorage.setItem(GOALS_KEY, JSON.stringify(goalsDone)); } catch {}
      pushFeedSys(`🎯 META BATIDA: ${fmt$(g.v)} — parabéns, equipe!`);
      const badge = $('eqBadge');
      badge.classList.remove('goalHit'); void badge.offsetWidth; badge.classList.add('goalHit');
    }
  }
}

// ---------- render principal ----------
function render() {
  $('price').textContent = S.price ? MONO(S.price) : '—';
  const chg = S.chg24 || (S.open ? (S.price / S.open - 1) * 100 : 0);
  $('chg').textContent = (chg >= 0 ? '+' : '') + chg.toFixed(2) + '% 24h';
  $('chg').className = 't-chg mono ' + (chg >= 0 ? 'up' : 'dn');
  $('price').className = 't-price mono ' + (chg >= 0 ? 'up' : 'dn');
  $('h24').textContent = S.high24 ? MONO(S.high24) : '—';
  $('l24').textContent = S.low24 ? MONO(S.low24) : '—';
  $('v24').textContent = S.vol24 ? S.vol24.toFixed(2) + ' BTC' : '—';
  // saldo oficial = banco persistido no app (disco); local é fallback offline
  const realized = S.dbTotals ? (S.dbTotals.realizedPnl || 0) : S.realized;
  $('bal').textContent = fmt$(realized);
  const upnl = S.pos ? (S.price - S.avg) * S.pos : 0;
  const tot = realized + upnl;
  $('pnl').textContent = 'PnL ' + fmt$(tot);
  $('pnl').className = 'pnl mono ' + (tot >= 0 ? 'up' : 'dn');
  $('pos').textContent = S.pos.toFixed(4) + ' BTC';
  $('avg').textContent = S.avg ? MONO(S.avg) : '—';
  $('dbtot').textContent = S.dbTotals ? fmt$(S.dbTotals.realizedPnl || 0) : fmt$(S.realized);
  $('eqBadge').textContent = fmt$(tot);
  $('eqBadge').style.color = tot >= 0 ? 'var(--up)' : 'var(--dn)';
  renderGoals(realized);
  // equity history (~1 ponto/2s) + persiste no banco via POST
  S._eqT = (S._eqT || 0) - 1;
  if (S._eqT <= 0) {
    S._eqT = 8;
    S.equity.push({ t: Date.now(), v: tot });
    if (S.equity.length > 300) S.equity.shift();
    try { fetch(EQ_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ v: tot }) }).catch(() => {}); } catch {}
  }
}
setInterval(render, 500);
setInterval(() => { if (!S.open && S.price) S.open = S.price; }, 5000);
