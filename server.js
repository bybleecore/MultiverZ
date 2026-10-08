// Servidor de MultiverZ 7.0: PvP con votación de modo, chat, Raid, mundo abierto, cuentas y baneos
const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

// ===== Cuentas por navegador + baneos (se guardan en un archivo del servidor) =====
// Cada navegador crea un ID (uid) y un token secreto. El servidor los registra en la primera conexión.
// Variables de entorno:  ADMIN_KEY (clave del panel /admin, obligatoria)  ·  DATA_FILE (ruta del archivo, opcional)
//                        BANNED_UIDS / BANNED_IPS (listas separadas por comas que sobreviven a los reinicios)
const crypto = require('crypto');
const fs = require('fs');
const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, 'data.json');
const ADMIN_KEY = process.env.ADMIN_KEY || '';
// Versión "oficial" del cliente: se lee sola de index.html (const VER='...'), o de la variable CLIENT_VER si la defines
let CURRENT_VER = String(process.env.CLIENT_VER || '').trim();
if (!CURRENT_VER) { try { CURRENT_VER = (fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8').match(/const VER='([^']+)'/) || [])[1] || ''; } catch (e) {} }
const cver = v => String(v || '').replace(/[^0-9A-Za-z._-]/g, '').slice(0, 16);
const cid = v => String(v || '').replace(/[^a-zA-Z0-9]/g, '').slice(0, 24);
const clean = (v, n) => String(v || '').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, n);
const sha = v => crypto.createHash('sha256').update(String(v)).digest('hex');
const firstIp = h => String((h && h['x-forwarded-for']) || '').split(',')[0].trim();
let db = { players: {}, bans: {}, ipbans: {}, gifts: {} };
try {
  const d = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  db = { players: d.players || {}, bans: d.bans || {}, ipbans: d.ipbans || {}, gifts: d.gifts || {} };
  console.log('Datos cargados: ' + Object.keys(db.players).length + ' jugadores, ' + Object.keys(db.bans).length + ' baneados');
} catch (e) { console.log('Sin archivo de datos previo: se creará uno nuevo en ' + DATA_FILE); }
const envBans = new Set((process.env.BANNED_UIDS || '').split(',').map(cid).filter(Boolean));
const envIps = new Set((process.env.BANNED_IPS || '').split(',').map(x => x.trim()).filter(Boolean));
let saveT = null, dirty = false;
function writeNow() {
  clearTimeout(saveT); dirty = false;
  const tmp = DATA_FILE + '.tmp';
  try { fs.writeFileSync(tmp, JSON.stringify(db)); fs.renameSync(tmp, DATA_FILE); }
  catch (e) { console.error('No se pudieron guardar los datos:', e.message); }
}
function save() { dirty = true; clearTimeout(saveT); saveT = setTimeout(writeNow, 400); }
process.on('exit', () => { if (dirty) writeNow(); });                  // no perder cambios pendientes al apagar
for (const sg of ['SIGTERM', 'SIGINT']) process.on(sg, () => process.exit(0));
const banInfo = uid => db.bans[uid] || (envBans.has(uid) ? { reason: 'Baneo permanente', env: true } : null);
const ipBanned = ip => !!ip && !!(db.ipbans[ip] || envIps.has(ip));
const online = new Map();                 // uid -> Set(sockets)
// Gemas y datos del jugador tal como los INFORMA su juego (sirve para el panel de admin; no es un dato verificado)
let lastStatSave = 0;
function noteStats(p, d) {
  if (!p || !d || typeof d !== 'object' || d.gems === undefined) return;
  const n = (v, max) => Math.min(max, Math.max(0, Math.floor(Number(v)) || 0)), now = Date.now(), g = n(d.gems, 1e9);
  const changed = p.gems !== g;
  p.gems = g; p.chars = n(d.chars, 1000); p.wins = n(d.wins, 1e9); p.battles = n(d.battles, 1e9); p.days = n(d.days, 100000); p.gt = now;
  if (changed && now - lastStatSave > 20000) { lastStatSave = now; save(); }      // no escribir el archivo en cada reporte
}
const sockIp = s => firstIp(s.handshake.headers) || s.handshake.address || '';
const regIp = new Map();                  // límite de cuentas nuevas por IP

io.use((s, next) => {
  const a = s.handshake.auth || {};
  const uid = cid(a.uid), tok = String(a.tok || '').slice(0, 64), ip = sockIp(s);
  if (uid.length < 8 || tok.length < 16) return next(new Error('actualiza'));
  const ban = banInfo(uid);
  if (ban || ipBanned(ip)) {
    const e = new Error('baneado');
    e.data = { reason: ban ? ban.reason : 'Tu conexión está bloqueada', lock: !!(ban && ban.lock) };
    return next(e);
  }
  const now = Date.now(), h = sha(tok);
  let p = db.players[uid];
  if (p && p.tok && p.tok !== h) return next(new Error('id_en_uso'));
  if (!p) {
    const r = regIp.get(ip) || { n: 0, t: now };
    if (now - r.t > 3600000) { r.n = 0; r.t = now; }
    if (r.n >= 30) return next(new Error('demasiados'));
    r.n++; regIp.set(ip, r);
    p = db.players[uid] = { name: 'Jugador', tok: h, first: now, last: now, ips: [] };
  }
  p.last = now; p.ver = cver(a.ver); p.vt = now;
  const nm = clean(a.name, 14); if (nm) p.name = nm;
  noteStats(p, a);                                  // gemas y datos que informa el juego al conectarse
  if (ip && !p.ips.includes(ip)) { p.ips.push(ip); if (p.ips.length > 5) p.ips.shift(); }
  save();
  s.data.uid = uid; s.data.ip = ip; s.data.ver = p.ver;
  next();
});

io.on('connection', s => {
  const uid = s.data.uid;
  if (!online.has(uid)) online.set(uid, new Set());
  online.get(uid).add(s);
  if (db.gifts[uid] && db.gifts[uid].length) s.emit('gifts', db.gifts[uid]);   // regalos pendientes del admin
  s.on('stat', d => {                                                          // el juego informa sus gemas cada rato
    const p = db.players[uid];
    if (p && Date.now() - (p.gt || 0) > 5000) noteStats(p, d);
  });
  s.on('giftok', ids => {                                                      // el jugador confirma que ya los cobró
    if (!Array.isArray(ids) || !db.gifts[uid]) return;
    const ok = new Set(ids.slice(0, 50).map(x => String(x)));
    db.gifts[uid] = db.gifts[uid].filter(g => !ok.has(g.id));
    if (!db.gifts[uid].length) delete db.gifts[uid];
    save();
  });
  s.on('disconnect', () => {
    const o = online.get(uid);
    if (o) { o.delete(s); if (!o.size) online.delete(uid); }
    const p = db.players[uid]; if (p) { p.last = Date.now(); save(); }
  });
});

function kickSock(s, reason, lock) { s.emit('banned', { reason, lock: !!lock }); s.disconnect(true); }
function banUid(uid, reason, alsoIp, lock) {
  const p = db.players[uid];
  db.bans[uid] = { reason: clean(reason, 80) || 'Trampas', at: Date.now(), name: p ? p.name : '?', lock: !!lock };
  if (alsoIp && p) for (const ip of p.ips) db.ipbans[ip] = { uid, at: Date.now() };
  save();
  let n = 0;
  for (const s of [...(online.get(uid) || [])]) { kickSock(s, db.bans[uid].reason, db.bans[uid].lock); n++; }
  if (alsoIp) for (const set of [...online.values()]) for (const s of [...set]) if (ipBanned(s.data.ip)) { kickSock(s, 'Tu conexión está bloqueada'); n++; }
  return n;
}
function unbanUid(uid) {
  delete db.bans[uid];
  for (const ip in db.ipbans) if (db.ipbans[ip].uid === uid) delete db.ipbans[ip];
  save();
}

// --- Panel de administración (/admin) ---
app.use('/admin/api', express.json({ limit: '200kb' }));
const fails = new Map();
const keyOk = k => crypto.timingSafeEqual(Buffer.from(sha(k), 'hex'), Buffer.from(sha(ADMIN_KEY), 'hex'));
function adminAuth(req, res, next) {
  if (!ADMIN_KEY) return res.status(503).json({ error: 'Falta definir ADMIN_KEY en el servidor' });
  const ip = firstIp(req.headers) || (req.socket && req.socket.remoteAddress) || '?', now = Date.now();
  const f = fails.get(ip) || { n: 0, t: now };
  if (now - f.t > 600000) { f.n = 0; f.t = now; }
  if (f.n >= 10) return res.status(429).json({ error: 'Demasiados intentos. Espera 10 minutos' });
  if (!keyOk(req.get('x-admin-key') || '')) { f.n++; fails.set(ip, f); return res.status(401).json({ error: 'Clave incorrecta' }); }
  next();
}
app.get('/admin', (_, res) => { res.set({ 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex' }); res.sendFile(path.join(__dirname, 'admin.html')); });
app.get('/admin/api/players', adminAuth, (req, res) => {
  const q = clean(req.query && req.query.q, 30).toLowerCase(), sortGems = (req.query && req.query.sort) === 'gems';
  const list = Object.entries(db.players)
    .filter(([uid, p]) => !q || uid.toLowerCase().includes(q) || String(p.name).toLowerCase().includes(q))
    .sort(sortGems ? (a, b) => (b[1].gems || 0) - (a[1].gems || 0) || b[1].last - a[1].last : (a, b) => b[1].last - a[1].last).slice(0, 200)
    .map(([uid, p]) => { const b = banInfo(uid); return { uid, name: p.name, first: p.first, last: p.last, online: online.has(uid), gifts: (db.gifts[uid] || []).length, ips: p.ips.slice(-3), banned: !!b, reason: b ? b.reason : '', lock: !!(b && b.lock), ver: p.ver || '', vt: p.vt || 0, vdiff: !!CURRENT_VER && (p.ver || '') !== CURRENT_VER,
      gems: p.gems || 0, chars: p.chars || 0, wins: p.wins || 0, battles: p.battles || 0, gt: p.gt || 0 }; });
  const gemsSum = Object.values(db.players).reduce((t, p) => t + (p.gems || 0), 0);
  const vers = {}; let vdiff = 0;
  for (const p of Object.values(db.players)) { const v = p.ver || '—'; vers[v] = (vers[v] || 0) + 1; if (CURRENT_VER && (p.ver || '') !== CURRENT_VER) vdiff++; }
  res.json({ total: Object.keys(db.players).length, online: online.size, gemsSum, list, currentVer: CURRENT_VER, vers, vdiff });
});
app.get('/admin/api/bans', adminAuth, (_, res) => {
  const list = [...new Set([...Object.keys(db.bans), ...envBans])].map(uid => { const b = banInfo(uid), p = db.players[uid]; return { uid, name: (b && b.name) || (p && p.name) || '?', reason: b.reason, at: b.at || 0, env: !!b.env && !db.bans[uid] }; });
  res.json({ list, ips: Object.keys(db.ipbans), envIps: [...envIps] });
});
app.post('/admin/api/ban', adminAuth, (req, res) => {
  const uid = cid(req.body && req.body.uid);
  if (uid.length < 8) return res.status(400).json({ error: 'ID inválido' });
  const kicked = banUid(uid, req.body.reason, !!req.body.ip, !!req.body.lock);
  res.json({ ok: true, kicked });
});
app.post('/admin/api/banver', adminAuth, (req, res) => {       // bloquear a todos los CONECTADOS con una versión distinta a la oficial
  if (!CURRENT_VER) return res.status(400).json({ error: 'El servidor no conoce la versión oficial (falta const VER en index.html o la variable CLIENT_VER)' });
  const targets = [...online.entries()].filter(([uid, set]) => !banInfo(uid) && [...set].some(s => s.data.ver !== CURRENT_VER)).map(([uid]) => uid);
  if (req.body && req.body.dry) return res.json({ ok: true, count: targets.length, names: targets.slice(0, 30).map(u => (db.players[u] && db.players[u].name) || u) });
  for (const uid of targets) banUid(uid, 'Cliente desactualizado', !!(req.body && req.body.ip), true);
  res.json({ ok: true, count: targets.length });
});
app.post('/admin/api/unban', adminAuth, (req, res) => {
  const uid = cid(req.body && req.body.uid);
  if (!uid) return res.status(400).json({ error: 'ID inválido' });
  const env = envBans.has(uid) && !db.bans[uid];
  unbanUid(uid);
  res.json({ ok: true, env });
});
app.post('/admin/api/gift', adminAuth, (req, res) => {          // regalar gemas / tickets a una cuenta
  const b = req.body || {}, uid = cid(b.uid);
  const gems = Math.floor(Number(b.gems) || 0), tk = Math.floor(Number(b.tk) || 0);
  if (!db.players[uid]) return res.status(404).json({ error: 'Esa cuenta no está registrada' });
  if (gems < 0 || tk < 0 || gems > 100000 || tk > 1000 || (!gems && !tk)) return res.status(400).json({ error: 'Cantidad inválida (gemas 0-100000, tickets 0-1000)' });
  const list = db.gifts[uid] = db.gifts[uid] || [];
  if (list.length >= 20) return res.status(400).json({ error: 'Ya tiene 20 regalos pendientes' });
  list.push({ id: crypto.randomBytes(6).toString('hex'), gems, tk, msg: clean(b.msg, 80), at: Date.now() });
  save();
  let sent = 0;
  for (const s of [...(online.get(uid) || [])]) { s.emit('gifts', list); sent++; }
  res.json({ ok: true, delivered: sent > 0 });
});
app.post('/admin/api/setgems', adminAuth, (req, res) => {       // fijar las gemas de una cuenta a una cantidad exacta
  const b = req.body || {}, uid = cid(b.uid), n = Math.floor(Number(b.gems));
  if (!db.players[uid]) return res.status(404).json({ error: 'Esa cuenta no está registrada' });
  if (!Number.isFinite(n) || n < 0 || n > 1e9) return res.status(400).json({ error: 'Cantidad inválida (0 a 1000000000)' });
  const list = db.gifts[uid] = db.gifts[uid] || [];
  for (let i = list.length - 1; i >= 0; i--) if (list[i].sg !== undefined) list.splice(i, 1);   // solo vale el último "fijar"
  if (list.length >= 20) return res.status(400).json({ error: 'Ya tiene 20 regalos pendientes' });
  list.push({ id: crypto.randomBytes(6).toString('hex'), sg: n, gems: 0, tk: 0, msg: clean(b.msg, 80), at: Date.now() });
  save();
  let sent = 0;
  for (const s of [...(online.get(uid) || [])]) { s.emit('gifts', list); sent++; }
  res.json({ ok: true, delivered: sent > 0 });
});
app.get('/admin/api/backup', adminAuth, (_, res) => {
  const uids = [...new Set([...Object.keys(db.bans), ...envBans])], ips = [...new Set([...Object.keys(db.ipbans), ...envIps])];
  res.json({ bans: db.bans, ipbans: db.ipbans, BANNED_UIDS: uids.join(','), BANNED_IPS: ips.join(',') });
});
app.post('/admin/api/restore', adminAuth, (req, res) => {
  const b = (req.body && req.body.bans) || {}, ib = (req.body && req.body.ipbans) || {};
  let n = 0;
  for (const k of Object.keys(b).slice(0, 5000)) {
    const uid = cid(k); if (uid.length < 8) continue;
    const v = b[k] || {}; if (!db.bans[uid]) n++;
    banUid(uid, v.reason, false, !!v.lock);
    db.bans[uid].name = clean(v.name, 14) || db.bans[uid].name;
  }
  for (const ip of Object.keys(ib).slice(0, 5000)) db.ipbans[clean(ip, 64)] = { uid: cid(ib[ip] && ib[ip].uid), at: Date.now() };
  save();
  res.json({ ok: true, added: n });
});
if (!ADMIN_KEY) console.warn('⚠ ADMIN_KEY no está definida: el panel /admin está desactivado hasta que la configures');

app.get('/lockcheck', (req, res) => {      // el cliente bloqueado pregunta si sigue bloqueado (así un desbaneo lo libera)
  res.set({ 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' });
  res.json({ locked: !!banInfo(cid(req.query && req.query.uid)) });
});
app.get('/', (_, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/health', (_, res) => res.send('ok'));

const MAX_ID = 90;                 // sube este número cuando agregues personajes
const WX = ['Soleado', 'Nocturno', 'Lluvioso', 'Nublado'];
const queues = { pvp: [], raid: [] };   // pvp = sala de votación 1vs1/2vs2/3vs3 · raid = RaidOnline 2vs2 cooperativo
const matches = new Map();         // socket.id -> partida en curso
const lobbies = new Map();         // socket.id -> sala previa (votación -> ruleta -> elegir equipo)
const VOTE_MS = 20000, SPIN_MS = 5200, PICK_MS = 45000;

const validTeam = (mode, t) =>
  Array.isArray(t) && t.length === mode &&
  new Set(t.map(x => x && x.id)).size === mode &&
  t.every(x => x && Number.isInteger(x.id) && x.id >= 1 && x.id <= MAX_ID &&
                Number.isInteger(x.l) && x.l >= 0 && x.l <= 5);

const ni = (v, max) => Math.min(max, Math.max(0, Math.floor(Number(v)) || 0));
// Perfil visible para el rival. Nombre = el registrado en el servidor; el resto lo informa el juego del jugador.
function cleanProf(s, d) {
  d = d || {};
  const p = db.players[s.data.uid];
  return { name: (p && p.name) || 'Jugador', av: ni(d.av, MAX_ID), gems: ni(d.gems, 1e9), chars: ni(d.chars, MAX_ID),
           wins: ni(d.wins, 1e9), battles: ni(d.battles, 1e9), days: ni(d.days, 100000) };
}

function unqueue(s) { for (const m in queues) queues[m] = queues[m].filter(e => e.s !== s); }

// El otro jugador de la sala o de la partida (sirve para el chat)
function peer(s) {
  const L = lobbies.get(s.id);
  if (L) return L.a.s === s ? L.b.s : L.a.s;
  const m = matches.get(s.id);
  return m ? (m.a === s ? m.b : m.a) : null;
}

function endMatch(s) {
  const m = matches.get(s.id);
  if (!m) return;
  const o = m.a === s ? m.b : m.a;
  clearTimeout(m.t);
  matches.delete(m.a.id); matches.delete(m.b.id);
  if (!m.done.has(s.id)) o.emit('oppleft');
}

// Cierra la sala previa; si se da msg, el otro jugador lo recibe
function lobbyEnd(s, msg) {
  const L = lobbies.get(s.id);
  if (!L) return;
  clearTimeout(L.t);
  lobbies.delete(L.a.s.id); lobbies.delete(L.b.s.id);
  const o = L.a.s === s ? L.b.s : L.a.s;
  if (msg) o.emit('plend', { msg });
}

function startMatch(sa, ta, sb, tb, raid) {
  const seed = Math.floor(Math.random() * 4294967296);
  const wx = WX[Math.floor(Math.random() * WX.length)];
  const m = { a: sa, b: sb, t: null, got: new Set(), done: new Set() };
  matches.set(sa.id, m); matches.set(sb.id, m);
  // en raid, "opp" es el equipo del compañero
  sa.emit('match', { host: true,  seed, wx, me: ta, opp: tb, raid });
  sb.emit('match', { host: false, seed, wx, me: tb, opp: ta, raid });
}

function tryRaid() {
  const q = queues.raid;
  while (q.length >= 2) {
    const a = q.shift(), b = q.shift();
    if (!a.s.connected) { q.unshift(b); continue; }
    if (!b.s.connected) { q.unshift(a); continue; }
    startMatch(a.s, a.team, b.s, b.team, true);
  }
}

// --- PvP: dos jugadores se conectan, votan el modo; si difieren, ruleta entre los dos votos ---
function tryPvp() {
  const q = queues.pvp;
  while (q.length >= 2) {
    const a = q.shift(), b = q.shift();
    if (!a.s.connected) { q.unshift(b); continue; }
    if (!b.s.connected) { q.unshift(a); continue; }
    const L = { a: { s: a.s, prof: a.prof, vote: 0, team: null }, b: { s: b.s, prof: b.prof, vote: 0, team: null }, phase: 'vote', mode: 0, t: null };
    lobbies.set(a.s.id, L); lobbies.set(b.s.id, L);
    a.s.emit('plobby', { opp: b.prof, ms: VOTE_MS });
    b.s.emit('plobby', { opp: a.prof, ms: VOTE_MS });
    L.t = setTimeout(() => resolveVote(L), VOTE_MS + 500);
  }
}

function resolveVote(L) {
  if (L.phase !== 'vote') return;
  clearTimeout(L.t);
  L.phase = 'spin';
  const v = [L.a.vote, L.b.vote].filter(Boolean);
  let opts, mode;
  if (!v.length) { mode = 1 + Math.floor(Math.random() * 3); opts = [mode]; }          // nadie votó: al azar
  else if (v.length === 1 || v[0] === v[1]) { mode = v[0]; opts = [mode]; }             // acuerdo, o solo votó uno
  else { opts = Math.random() < 0.5 ? [v[0], v[1]] : [v[1], v[0]]; mode = opts[Math.floor(Math.random() * 2)]; }   // ruleta
  L.mode = mode;
  L.a.s.emit('pspin', { opts, mode, me: L.a.vote, opp: L.b.vote });
  L.b.s.emit('pspin', { opts, mode, me: L.b.vote, opp: L.a.vote });
  L.t = setTimeout(() => {
    L.phase = 'pick';
    L.a.s.emit('ppick', { mode, ms: PICK_MS });
    L.b.s.emit('ppick', { mode, ms: PICK_MS });
    L.t = setTimeout(() => {
      if (lobbies.get(L.a.s.id) !== L) return;
      L.a.s.emit('plend', { msg: L.a.team ? '⏰ Tu rival tardó demasiado en elegir su equipo' : '⏰ Tardaste demasiado en elegir tu equipo' });
      L.b.s.emit('plend', { msg: L.b.team ? '⏰ Tu rival tardó demasiado en elegir su equipo' : '⏰ Tardaste demasiado en elegir tu equipo' });
      lobbies.delete(L.a.s.id); lobbies.delete(L.b.s.id);
    }, PICK_MS + 1500);
  }, opts.length > 1 ? SPIN_MS : 2600);
}

io.on('connection', s => {
  // Sala PvP: no se elige modo antes de entrar; se envía solo el perfil público
  s.on('pvpfind', d => {
    endMatch(s); unqueue(s); lobbyEnd(s, '🔌 Tu rival salió de la sala');
    queues.pvp.push({ s, prof: cleanProf(s, d && d.prof) });
    tryPvp();
  });
  s.on('find', () => s.emit('err', 'Actualiza el juego a la versión 7.0'));   // clientes viejos

  s.on('pvote', d => {
    const L = lobbies.get(s.id), mode = d && d.mode;
    if (!L || L.phase !== 'vote' || ![1, 2, 3].includes(mode)) return;
    const me = L.a.s === s ? L.a : L.b, o = L.a.s === s ? L.b : L.a;
    const first = !me.vote;
    me.vote = mode;
    if (first) o.s.emit('pvoted');
    if (L.a.vote && L.b.vote) resolveVote(L);
  });

  s.on('pteam', d => {
    const L = lobbies.get(s.id);
    if (!L || L.phase !== 'pick') return;
    const me = L.a.s === s ? L.a : L.b, o = L.a.s === s ? L.b : L.a;
    if (me.team) return;
    if (!d || !validTeam(L.mode, d.team)) return s.emit('perr', 'Equipo inválido');
    me.team = d.team;
    o.s.emit('pready');
    if (L.a.team && L.b.team) {
      clearTimeout(L.t);
      lobbies.delete(L.a.s.id); lobbies.delete(L.b.s.id);
      startMatch(L.a.s, L.a.team, L.b.s, L.b.team, false);
    }
  });

  // Chat entre los dos jugadores (sala previa, combate y pantalla de resultado)
  s.on('pchat', d => {
    const o = peer(s);
    if (!o || !d) return;
    const text = cleanMsg(d.text), now = Date.now();
    if (!text || now - (s.data.pc || 0) < 700) return;      // anti-spam
    s.data.pc = now;
    const msg = { id: s.id, text };
    s.emit('pchat', msg); o.emit('pchat', msg);
  });

  // RaidOnline: dos jugadores (2 personajes cada uno) se emparejan como compañeros
  s.on('findraid', d => {
    if (!d || !validTeam(2, d.team)) return s.emit('err', 'Equipo inválido');
    endMatch(s); unqueue(s); lobbyEnd(s, '🔌 Tu rival salió de la sala');
    queues.raid.push({ s, team: d.team });
    tryRaid();
  });

  s.on('cancel', () => { unqueue(s); lobbyEnd(s, '🔌 Tu rival salió de la sala'); });

  // Cada turno los dos jugadores mandan sus acciones; el servidor solo las reenvía.
  s.on('plan', p => {
    const m = matches.get(s.id);
    if (!m || !p || typeof p !== 'object') return;
    const o = m.a === s ? m.b : m.a;
    o.emit('plan', p);
    m.got.add(s.id);
    clearTimeout(m.t);
    if (m.got.size >= 2) { m.got.clear(); return; }
    m.t = setTimeout(() => { o.emit('kicked'); s.emit('oppleft'); endMatch(o); }, 60000);
  });

  s.on('done', () => { const m = matches.get(s.id); if (m) m.done.add(s.id); });
  s.on('leave', () => { endMatch(s); lobbyEnd(s, '🔌 Tu rival salió de la sala'); });
  s.on('disconnect', () => { unqueue(s); endMatch(s); lobbyEnd(s, '🔌 Tu rival se desconectó'); });
});

// ===== Mundo abierto: jardín compartido con estanque, chat y gemas escondidas =====
const WW = 2400, WH = 1800, WY0 = -1000, NPC = { x: 1200, y: -760 }, POND = { x: 1200, y: 900, r: 280 }, SPEED = 240, MAX_WORLD = 60;
const world = new Map();           // socket.id -> { id, name, av, x, y, t, dirty }
const pub = p => ({ id: p.id, name: p.name, av: p.av, x: Math.round(p.x), y: Math.round(p.y) });
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

// --- Chat ---
const chatLog = [];                                  // últimos mensajes (se envían al entrar)
function pushChat(m) { chatLog.push(m); if (chatLog.length > 30) chatLog.shift(); io.to('world').emit('wmsg', m); }
const cleanMsg = v => String(v || '').replace(/[\u0000-\u001f<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, 80);

// --- Gemas escondidas (las ve y recoge quien llegue primero) ---
const GEM_N = 12, GEM_D = 15, GEM_VALS_D = [30, 50, 50, 100, 150, 300], GEM_RESET = 2 * 60 * 60 * 1000, GEM_VALS = [20, 20, 20, 20, 50, 50, 150];   // todas las gemas se reinician cada 2 horas
const gems = new Map(); let gemSeq = 0;
function gemSpawn(des) {                             // des = true -> gema del Desierto (parte de arriba del mapa)
  for (let k = 0; k < 40; k++) {
    const x = 80 + Math.random() * (WW - 160), y = des ? WY0 + 80 + Math.random() * (-WY0 - 140) : 80 + Math.random() * (WH - 160);
    if (!des && Math.hypot(x - POND.x, y - POND.y) < POND.r + 60) continue;
    if (des && Math.hypot(x - NPC.x, y - NPC.y) < 150) continue;
    const g = { id: ++gemSeq, x: Math.round(x), y: Math.round(y), d: des ? 1 : 0 };
    gems.set(g.id, g); io.to('world').emit('wgnew', g); return;
  }
}
for (let i = 0; i < GEM_N; i++) gemSpawn();
for (let i = 0; i < GEM_D; i++) gemSpawn(true);
function gemReset() {                                // cada 2 h: se borran las que quedaban y salen 12 nuevas para todos
  gems.clear();
  io.to('world').emit('wgreset');
  for (let i = 0; i < GEM_N; i++) gemSpawn();
  for (let i = 0; i < GEM_D; i++) gemSpawn(true);
  if (world.size) pushChat({ sys: true, text: '💎 ¡Las gemas escondidas se reiniciaron! Hay ' + gems.size + ' nuevas por el mapa' });
}
setInterval(gemReset, GEM_RESET);

// --- Amigos: solicitudes, regalo de gemas y mensajes directos ---
const FR_GIFT = 25;                                   // gemas para cada uno al hacerse amigos (una vez por pareja)
const uidSock = new Map();                            // uid del jugador -> socket.id (solo mientras está en el mundo)
const pend = new Map();                               // 'origen>destino' -> hora de la solicitud
const gifted = new Set();                             // parejas que ya cobraron el regalo
const cleanUid = v => String(v || '').replace(/[^a-zA-Z0-9]/g, '').slice(0, 24);
const pairKey = (a, b) => (a < b ? a + '|' + b : b + '|' + a);
const areFriends = (p, q) => !!(p && q && p.uid && q.uid && p.fr.has(q.uid) && q.fr.has(p.uid));
const pendOk = k => pend.has(k) && Date.now() - pend.get(k) < 300000;   // las solicitudes caducan a los 5 min

function worldRemove(s) {
  const p0 = world.get(s.id);
  if (p0 && p0.uid && uidSock.get(p0.uid) === s.id) uidSock.delete(p0.uid);
  for (const k of [...pend.keys()]) if (k.startsWith(s.id + '>') || k.endsWith('>' + s.id)) pend.delete(k);
  worldRemove0(s);
}
function worldRemove0(s) {
  if (!world.delete(s.id)) return;
  s.leave('world');
  io.to('world').emit('wleft', s.id);
}

io.on('connection', s => {
  s.on('wjoin', d => {
    if (world.has(s.id)) return;
    if (world.size >= MAX_WORLD) return s.emit('wfull');
    const name = String((d && d.name) || 'Jugador').replace(/[<>]/g, '').slice(0, 14) || 'Jugador';
    const av = d && Number.isInteger(d.av) && d.av >= 0 && d.av <= MAX_ID ? d.av : 0;
    const a = Math.random() * Math.PI * 2, r = POND.r + 150 + Math.random() * 150;
    const p = { id: s.id, name, av, x: POND.x + Math.cos(a) * r, y: POND.y + Math.sin(a) * r, t: Date.now(), dirty: false, lc: 0, ld: 0, lr: 0,
      uid: cleanUid(d && d.uid), fr: new Set((Array.isArray(d && d.fr) ? d.fr : []).slice(0, 300).map(cleanUid)) };
    if (p.uid) uidSock.set(p.uid, s.id);
    s.emit('wstate', { you: s.id, players: [...world.values(), p].map(pub), gems: [...gems.values()], chat: chatLog });
    world.set(s.id, p);
    s.join('world');
    s.to('world').emit('wjoined', pub(p));
  });

  s.on('wmove', d => {
    const p = world.get(s.id);
    if (!p || !d) return;
    let x = Number(d.x), y = Number(d.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    const now = Date.now(), dt = Math.min(1, (now - p.t) / 1000);
    p.t = now;
    const max = SPEED * 1.6 * dt + 12, dx = x - p.x, dy = y - p.y, dist = Math.hypot(dx, dy);
    if (dist > max) { x = p.x + dx / dist * max; y = p.y + dy / dist * max; }   // límite de velocidad
    x = clamp(x, 20, WW - 20); y = clamp(y, WY0 + 20, WH - 20);
    if (Math.hypot(x - POND.x, y - POND.y) < POND.r - 10) return;              // no se puede entrar al agua
    p.x = x; p.y = y; p.dirty = true;
  });

  s.on('wchat', d => {
    const p = world.get(s.id);
    if (!p || !d) return;
    const text = cleanMsg(d.text), now = Date.now();
    if (!text || now - p.lc < 700) return;          // anti-spam: 1 mensaje cada 0,7 s
    p.lc = now;
    pushChat({ id: s.id, name: p.name, text });
  });

  s.on('wgem', d => {
    const p = world.get(s.id), g = d && gems.get(d.id);
    if (!p || !g || Math.hypot(p.x - g.x, p.y - g.y) > 110) return;   // tiene que estar cerca de verdad
    gems.delete(g.id);
    const vals = g.d ? GEM_VALS_D : GEM_VALS, amt = vals[Math.floor(Math.random() * vals.length)];
    s.emit('wgot', { id: g.id, amt, d: g.d ? 1 : 0 });
    io.to('world').emit('wgone', g.id);
    pushChat({ sys: true, text: (g.d ? '🏜️ ' + p.name + ' encontró una joya del desierto de ' : '💎 ' + p.name + ' encontró una gema de ') + amt });
  });

  // Estado de otro jugador al tocarlo: ¿amigo?, ¿solicitud enviada o recibida?
  s.on('fprof', d => {
    const p = world.get(s.id), q = d && world.get(d.to);
    if (!p || !q || q === p) return;
    const friend = areFriends(p, q);
    s.emit('fprof', { id: q.id, friend, uid: friend ? q.uid : null, pending: pendOk(s.id + '>' + q.id), incoming: pendOk(q.id + '>' + s.id) });
  });

  s.on('frreq', d => {
    const p = world.get(s.id), q = d && world.get(d.to), now = Date.now();
    if (!p || !q || q === p || !p.uid || !q.uid || p.uid === q.uid) return;
    if (now - p.lr < 1500) return;                    // anti-spam
    p.lr = now;
    if (areFriends(p, q)) return s.emit('frmsg', 'Ya sois amigos');
    if (pendOk(s.id + '>' + q.id)) return s.emit('frmsg', 'Ya le enviaste una solicitud');
    pend.set(s.id + '>' + q.id, now);
    io.to(q.id).emit('frreq', { from: p.id, name: p.name, av: p.av });
  });

  s.on('fracc', d => {
    const p = world.get(s.id), q = d && world.get(d.to), k = q && (q.id + '>' + s.id);
    if (!p || !q || !pendOk(k)) return;
    pend.delete(k);
    p.fr.add(q.uid); q.fr.add(p.uid);
    const pk = pairKey(p.uid, q.uid), gift = gifted.has(pk) ? 0 : FR_GIFT;
    gifted.add(pk);
    s.emit('frok', { uid: q.uid, name: q.name, av: q.av, gift });
    io.to(q.id).emit('frok', { uid: p.uid, name: p.name, av: p.av, gift });
  });

  s.on('frno', d => {
    const p = world.get(s.id), q = d && world.get(d.to);
    if (!p || !q) return;
    if (pend.delete(q.id + '>' + s.id)) io.to(q.id).emit('frno', { name: p.name });
  });

  s.on('frdel', d => {
    const p = world.get(s.id), uid = cleanUid(d && d.uid);
    if (!p || !uid) return;
    p.fr.delete(uid);
    const sid = uidSock.get(uid), q = sid && world.get(sid);
    if (q) { q.fr.delete(p.uid); io.to(q.id).emit('frgone', { uid: p.uid }); }
  });

  s.on('frstat', d => {                               // ¿cuáles de mis amigos están en el mundo ahora?
    const p = world.get(s.id);
    if (!p || !d || !Array.isArray(d.uids)) return;
    s.emit('frstat', d.uids.slice(0, 300).map(cleanUid).filter(u => { const q = world.get(uidSock.get(u)); return areFriends(p, q); }));
  });

  s.on('dm', d => {                                   // mensaje directo (solo entre amigos conectados)
    const p = world.get(s.id);
    if (!p || !d) return;
    const uid = cleanUid(d.uid), text = cleanMsg(d.text), now = Date.now();
    if (!text || now - p.ld < 500) return;
    p.ld = now;
    const q = world.get(uidSock.get(uid));
    if (!areFriends(p, q)) return s.emit('dmfail', { uid });
    io.to(q.id).emit('dm', { uid: p.uid, name: p.name, text });
    s.emit('dmok', { uid, text });
  });

  s.on('wleave', () => worldRemove(s));
  s.on('disconnect', () => worldRemove(s));
});

// Cada 80 ms se envían solo las posiciones que cambiaron
setInterval(() => {
  const ch = [...world.values()].filter(p => p.dirty);
  if (!ch.length) return;
  io.to('world').emit('wpos', ch.map(p => [p.id, Math.round(p.x), Math.round(p.y)]));
  ch.forEach(p => { p.dirty = false; });
}, 80);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log('MultiverZ PvP en puerto ' + PORT));
