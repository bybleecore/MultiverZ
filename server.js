// Servidor de MultiverZ 8.0: PvP con votación de modo, chat, Raid, mundo abierto, cuentas y baneos
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
let db = { players: {}, bans: {}, ipbans: {}, gifts: {}, crews: {}, trd: {}, accts: {} };
try {
  const d = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  db = { players: d.players || {}, bans: d.bans || {}, ipbans: d.ipbans || {}, gifts: d.gifts || {}, crews: d.crews || {}, trd: d.trd || {}, accts: d.accts || {} };
  console.log('Datos cargados: ' + Object.keys(db.players).length + ' jugadores, ' + Object.keys(db.bans).length + ' baneados');
} catch (e) { console.log('Sin archivo de datos previo: se creará uno nuevo en ' + DATA_FILE); }

// ===== Servidor de datos externo (variables VAULT_URL y VAULT_KEY) =====
// Si las defines, el juego carga TODO desde tu servidor de datos al arrancar y le manda cada cambio (solo lo que cambió).
// El data.json local queda como copia de emergencia. Sin estas variables todo funciona como antes.
const VAULT_URL = String(process.env.VAULT_URL || '').trim().replace(/\/+$/, ''), VAULT_KEY = String(process.env.VAULT_KEY || '').trim();
const VCOLLS = ['players', 'bans', 'ipbans', 'gifts', 'crews', 'trd', 'accts'];
const vsent = {}; for (const c of VCOLLS) vsent[c] = new Map();           // lo último que ya está guardado en el servidor de datos
let vready = !VAULT_URL, vbusy = false, vagain = false, vtimer = null, vseen = 0;
const vsleep = ms => new Promise(r => setTimeout(r, ms));
const vown = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const vgate = (req, res, next) => vready ? next() : res.status(503).send('Iniciando: conectando con el servidor de datos…');
app.use('/admin/api', vgate);
io.use((s, next) => vready ? next() : next(new Error('Servidor iniciando, reintenta en unos segundos')));   // nadie entra hasta cargar los datos
async function vreq(method, p, body, ms) {
  const r = await fetch(VAULT_URL + p, { method, headers: { 'x-key': VAULT_KEY, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(ms || 30000) });
  let j = {}; try { j = await r.json(); } catch (e) {}
  if (!r.ok) throw new Error('HTTP ' + r.status + (j.error ? ' · ' + j.error : ''));
  return j;
}
function vIndex() { for (const c of VCOLLS) { vsent[c].clear(); for (const [k, v] of Object.entries(db[c])) vsent[c].set(k, JSON.stringify(v)); } }
function vSoon() { if (!VAULT_URL || !vready || vtimer) return; vtimer = setTimeout(() => { vtimer = null; vFlush(); }, 4000); }
async function vFlush() {                                                  // manda al servidor de datos lo que cambió desde la última vez
  if (!VAULT_URL || !vready) return;
  if (vbusy) { vagain = true; return; }
  vbusy = true;
  try {
    const sets = [], dels = [];
    for (const c of VCOLLS) {
      const cur = db[c] || {};
      for (const [k, v] of Object.entries(cur)) { const s = JSON.stringify(v); if (vsent[c].get(k) !== s) sets.push([c, k, s]); }
      for (const k of vsent[c].keys()) if (!vown(cur, k)) dels.push([c, k]);
    }
    if (dels.length > 250) { console.error('Vault: se negó a borrar ' + dels.length + ' registros de golpe (protección)'); dels.length = 0; }
    const batches = []; let cur = [], bytes = 0;
    for (const e of sets) { cur.push(e); bytes += e[2].length + 40; if (bytes > 6e6 || cur.length >= 1500) { batches.push({ set: cur, del: [] }); cur = []; bytes = 0; } }
    if (cur.length || dels.length) batches.push({ set: cur, del: dels });
    for (const b of batches) {
      await vreq('POST', '/vault/batch', b, 60000);
      for (const [c, k, s] of b.set) vsent[c].set(k, s);
      for (const [c, k] of b.del) vsent[c].delete(k);
    }
    if (sets.length || dels.length) console.log('Vault: ' + sets.length + ' registros guardados, ' + dels.length + ' borrados');
  } catch (e) {
    console.error('Vault: no se pudo guardar (' + e.message + '). Reintento en 10 s');
    clearTimeout(vtimer); vtimer = setTimeout(() => { vtimer = null; vFlush(); }, 10000);
  }
  vbusy = false;
  if (vagain) { vagain = false; vSoon(); }
}
async function vCheck() {                                                  // ¿el servidor de datos perdió registros (se reinició/borró)? entonces se le reenvía todo
  if (!VAULT_URL || !vready || vbusy || vtimer) return;
  try {
    const st = await vreq('GET', '/vault/stats', null, 15000);
    let lost = !!vseen && st.startedAt !== vseen;
    for (const c of VCOLLS) if (Object.keys(db[c]).length > ((st.counts && st.counts[c]) || 0)) lost = true;
    vseen = st.startedAt;
    if (lost) { console.log('Vault: el servidor de datos perdió registros (¿se reinició?). Reenvío todo'); for (const c of VCOLLS) vsent[c].clear(); vSoon(); }
  } catch (e) { /* se vuelve a intentar en la siguiente vuelta */ }
}
setInterval(vCheck, Number(process.env.VAULT_CHECK_MS) || 60000);
async function vInit() {                                                   // al arrancar: carga todo desde el servidor de datos (espera todo lo que haga falta)
  if (!VAULT_URL) return;
  if (!VAULT_KEY) console.warn('⚠ VAULT_URL está definida pero falta VAULT_KEY');
  const have = o => Object.keys(o || {}).length;
  for (let i = 1; ; i++) {
    try {
      const r = await vreq('GET', '/vault/all', null, 60000);
      if (r.empty) {
        console.log(have(db.players) + have(db.accts) + have(db.crews) ? 'Vault vacío: subo los ' + have(db.players) + ' jugadores que había en el archivo local' : 'Vault vacío y sin datos locales: empiezo desde cero');
        for (const c of VCOLLS) vsent[c].clear();
      } else {
        const d = r.db || {};
        db = { players: d.players || {}, bans: d.bans || {}, ipbans: d.ipbans || {}, gifts: d.gifts || {}, crews: d.crews || {}, trd: d.trd || {}, accts: d.accts || {} };
        vIndex();
        console.log('Datos cargados del servidor de datos: ' + have(db.players) + ' jugadores, ' + have(db.accts) + ' cuentas, ' + have(db.crews) + ' crews');
      }
      try { vseen = (await vreq('GET', '/vault/stats', null, 15000)).startedAt; } catch (e) {}
      vready = true; vSoon(); return;
    } catch (e) { console.log('Servidor de datos no responde (' + e.message + '). Reintento…'); await vsleep(Math.min(30000, 2000 * i)); }
  }
}
vInit();
const envBans = new Set((process.env.BANNED_UIDS || '').split(',').map(cid).filter(Boolean));
const envIps = new Set((process.env.BANNED_IPS || '').split(',').map(x => x.trim()).filter(Boolean));
let saveT = null, dirty = false;
function writeNow() {
  clearTimeout(saveT); dirty = false;
  const tmp = DATA_FILE + '.tmp';
  try { fs.writeFileSync(tmp, JSON.stringify(db)); fs.renameSync(tmp, DATA_FILE); }
  catch (e) { console.error('No se pudieron guardar los datos:', e.message); }
}
function save() { dirty = true; clearTimeout(saveT); saveT = setTimeout(writeNow, 400); vSoon(); }
process.on('exit', () => { if (dirty) writeNow(); });                  // no perder cambios pendientes al apagar
for (const sg of ['SIGTERM', 'SIGINT']) process.on(sg, async () => { try { if (VAULT_URL && vready) { clearTimeout(vtimer); vtimer = null; await Promise.race([vFlush(), vsleep(8000)]); } } catch (e) {} process.exit(0); });
const banInfo = uid => db.bans[uid] || (envBans.has(uid) ? { reason: 'Baneo permanente', env: true } : null);
const ipBanned = ip => !!ip && !!(db.ipbans[ip] || envIps.has(ip));
const online = new Map();                 // uid -> Set(sockets)
// Gemas y datos del jugador tal como los INFORMA su juego (sirve para el panel de admin; no es un dato verificado)
let lastStatSave = 0;
function noteStats(p, d) {
  if (!p || !d || typeof d !== 'object' || d.gems === undefined) return;
  const n = (v, max) => Math.min(max, Math.max(0, Math.floor(Number(v)) || 0)), now = Date.now(), g = n(d.gems, 1e9);
  const changed = p.gems !== g;
  p.gems = g; if (d.av !== undefined) p.av = cleanAv(d.av); p.chars = n(d.chars, 1000); p.wins = n(d.wins, 1e9); p.battles = n(d.battles, 1e9); p.days = n(d.days, 100000); p.gt = now;
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
  s.emit('bonus', bonusState());                                              // estado del evento x2
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
// ===== Evento diario: recompensas x2 en PvP y Rankeds =====
// Todos los días a las 2:00 pm y a las 8:00 pm hora de Ciudad de México, durante 1 hora cada vez.
// Se puede cambiar con variables de entorno: BONUS_TIMES (ej. "14:00,20:00", hora CDMX en 24 h) y BONUS_LEN (minutos de duración).
const BONUS_TZ = 'America/Mexico_City';
const BONUS_STARTS = String(process.env.BONUS_TIMES || '14:00,20:00').split(',').map(t => { const [h, m] = t.trim().split(':'); return (Number(h) || 0) * 60 + (Number(m) || 0); }).filter(x => x >= 0 && x < 1440);
const BONUS_LEN = Number(process.env.BONUS_LEN ?? 60);
const mxFmt = new Intl.DateTimeFormat('en-US', { timeZone: BONUS_TZ, hourCycle: 'h23', hour: 'numeric', minute: 'numeric', second: 'numeric' });
function mxSecs(d) { const o = {}; for (const p of mxFmt.formatToParts(d)) o[p.type] = p.value; return (+o.hour * 60 + +o.minute) * 60 + +o.second; }
function bonusState() {
  const now = Date.now(), sec = mxSecs(new Date(now)), len = BONUS_LEN * 60;
  const act = BONUS_STARTS.map(m => m * 60).find(a => sec >= a && sec < a + len);          // ventana activa ahora (si hay)
  if (act !== undefined) return { on: true, x: 2, now, until: now + (act + len - sec) * 1000, next: 0 };
  const nx = Math.min(...BONUS_STARTS.map(m => { const d = m * 60 - sec; return d > 0 ? d : d + 86400; }));
  return { on: false, x: 2, now, until: 0, next: now + nx * 1000 };
}
let bonusOn = bonusState().on;
setInterval(() => { const b = bonusState(); if (b.on !== bonusOn) { bonusOn = b.on; io.emit('bonus', b); } }, 3000);   // avisa a todos al empezar y al terminar
app.get('/bonus', (_, res) => { res.set({ 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' }); res.json(bonusState()); });   // los juegos lo consultan aunque no estén conectados por socket

// ===== Cuentas básicas (nombre + contraseña) para pasar la partida de un dispositivo a otro =====
// Todo se guarda en data.json junto al servidor (sin nube). Las contraseñas se guardan con scrypt (nunca en claro).
// OJO: en el plan gratis de Render data.json se borra al reiniciar; usa un Disco persistente y apunta DATA_FILE a él.
app.use('/acct', (req, res, next) => {
  res.set({ 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Cache-Control': 'no-store' });
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
}, express.json({ limit: '3mb' }));
const acctKey = n => String(n || '').normalize('NFKC').trim().toLowerCase();
const acctOkName = n => /^[\p{L}\p{N}_.\- ]{3,20}$/u.test(n);
const acctHash = (pw, salt) => crypto.scryptSync(String(pw), salt, 32).toString('hex');
const acctTries = new Map(), acctNew = new Map();     // intentos fallidos (ip|nombre) y cuentas nuevas por IP
const acctFail = k => { const e = acctTries.get(k); if (!e || Date.now() - e.t > 600000) acctTries.set(k, { n: 1, t: Date.now() }); else { e.n++; e.t = Date.now(); } };
setInterval(() => { const now = Date.now(); for (const [k, e] of acctTries) if (now - e.t > 600000) acctTries.delete(k); for (const [k, e] of acctNew) if (now - e.t > 3600000) acctNew.delete(k); }, 600000);
function acctValidSave(s) {
  if (typeof s !== 'string' || s.length < 2 || s.length > 2.5e6) return '';
  try { const o = JSON.parse(s); return o && typeof o === 'object' && !Array.isArray(o) ? s : ''; } catch (e) { return ''; }
}
function acctAuth(req, res) {
  const b = req.body || {}, name = acctKey(b.name), k = (firstIp(req.headers) || req.ip) + '|' + name;
  const t = acctTries.get(k);
  if (t && t.n >= 8 && Date.now() - t.t < 600000) { res.status(429).json({ ok: false, err: 'Demasiados intentos. Espera unos minutos.' }); return null; }
  const a = db.accts[name];
  let good = false;
  if (a) { try { good = crypto.timingSafeEqual(Buffer.from(acctHash(b.pass, a.salt), 'hex'), Buffer.from(a.hash, 'hex')); } catch (e) {} }
  if (!good) { acctFail(k); res.status(401).json({ ok: false, err: 'Nombre o contraseña incorrectos' }); return null; }
  acctTries.delete(k);
  return a;
}
app.post('/acct/register', (req, res) => {
  const b = req.body || {}, name = clean(b.name, 20).replace(/\s+/g, ' '), key = acctKey(name), pass = String(b.pass || '');
  if (!acctOkName(name)) return res.status(400).json({ ok: false, err: 'El nombre debe tener de 3 a 20 letras, números o _ . -' });
  if (pass.length < 4 || pass.length > 64) return res.status(400).json({ ok: false, err: 'La contraseña debe tener de 4 a 64 caracteres' });
  if (db.accts[key]) return res.status(409).json({ ok: false, err: 'Ese nombre de cuenta ya existe' });
  const ip = firstIp(req.headers) || req.ip, e = acctNew.get(ip) || { n: 0, t: Date.now() };
  if (e.n >= 5) return res.status(429).json({ ok: false, err: 'Demasiadas cuentas nuevas desde esta conexión. Intenta más tarde.' });
  e.n++; acctNew.set(ip, e);
  const salt = crypto.randomBytes(16).toString('hex'), data = acctValidSave(b.save);
  db.accts[key] = { name, salt, hash: acctHash(pass, salt), save: data, t: data ? Date.now() : 0, c: Date.now() };
  save();
  res.json({ ok: true, name, t: db.accts[key].t });
});
app.post('/acct/login', (req, res) => {
  const a = acctAuth(req, res); if (!a) return;
  res.json({ ok: true, name: a.name, t: a.t || 0, save: a.save || '' });
});
app.post('/acct/save', (req, res) => {
  const a = acctAuth(req, res); if (!a) return;
  const b = req.body || {}, data = acctValidSave(b.save);
  if (!data) return res.status(400).json({ ok: false, err: 'Partida no válida o demasiado grande' });
  if (!b.force && a.t && Number(b.base || 0) < a.t) return res.status(409).json({ ok: false, conflict: true, t: a.t, err: 'La cuenta tiene una partida más reciente' });
  a.save = data; a.t = Date.now(); save();
  res.json({ ok: true, t: a.t });
});
app.post('/acct/passwd', (req, res) => {
  const a = acctAuth(req, res); if (!a) return;
  const np = String((req.body || {}).npass || '');
  if (np.length < 4 || np.length > 64) return res.status(400).json({ ok: false, err: 'La contraseña nueva debe tener de 4 a 64 caracteres' });
  a.salt = crypto.randomBytes(16).toString('hex'); a.hash = acctHash(np, a.salt); save();
  res.json({ ok: true });
});
app.use('/acct', (err, req, res, next) => res.status(err.status || 400).json({ ok: false, err: 'Datos no válidos o demasiado grandes' }));
app.get('/', (_, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/health', (_, res) => res.send('ok'));

const MAX_ID = 100;                // sube este número cuando agregues personajes
const WX = ['Soleado', 'Nocturno', 'Lluvioso', 'Nublado'];
const queues = { pvp: [], rank: [], raid: [] };   // pvp = sala de votación 1vs1/2vs2/3vs3 · raid = RaidOnline 2vs2 cooperativo
const matches = new Map();         // socket.id -> partida en curso
const lobbies = new Map();         // socket.id -> sala previa (votación -> ruleta -> elegir equipo)
const VOTE_MS = 20000, SPIN_MS = 5200, PICK_MS = 45000;

const validTeam = (mode, t) =>
  Array.isArray(t) && t.length === mode &&
  new Set(t.map(x => x && x.id)).size === mode &&
  t.every(x => x && Number.isInteger(x.id) && x.id >= 1 && x.id <= MAX_ID &&
                Number.isInteger(x.l) && x.l >= 0 && x.l <= 5);

const ni = (v, max) => Math.min(max, Math.max(0, Math.floor(Number(v)) || 0));
// Foto de perfil: número de personaje (1..MAX_ID) o clave de una forma alterna ("a52" = Awaken, "57c", "89k"…)
const cleanAv = v => {
  if (typeof v === 'string') { const m = /^(a?)(\d{1,3})([a-z]?)$/.exec(v); return m && +m[2] >= 1 && +m[2] <= MAX_ID ? v : 0; }
  return ni(v, MAX_ID);
};
// Perfil visible para el rival. Nombre = el registrado en el servidor; el resto lo informa el juego del jugador.
// ===== Ranking de victorias de Rankeds =====
// Cada victoria ranked cuenta en el servidor (una por partida, y se cuenta aunque el rival se desconecte).
// Como el combate se calcula en los juegos de los jugadores, no es un dato 100% verificable. Un empate en el 1er lugar: todos los empatados son dorados.
function rkRows() {
  const all = Object.entries(db.players).filter(([u, p]) => (p.pw || 0) > 0 && !banInfo(u))
    .map(([u, p]) => ({ u, name: p.name, av: p.av || 0, pw: p.pw, t: p.pwt || 0 }))
    .sort((a, b) => b.pw - a.pw || a.t - b.t);
  all.forEach((x, i) => { x.pos = i && x.pw === all[i - 1].pw ? all[i - 1].pos : i + 1; });
  return all;
}
let _ld = null, _ldT = 0;
function leaders() {                                                    // uids con el nombre dorado (los que van primero, empatados incluidos)
  const now = Date.now();
  if (_ld && now - _ldT < 5000) return _ld;
  const all = rkRows();
  _ld = new Set(all.filter(x => x.pos === 1).map(x => x.u)); _ldT = now;
  return _ld;
}
function rkBoard(uid) {
  const all = rkRows(), mine = all.find(x => x.u === uid);
  return { total: all.length, me: mine ? { pos: mine.pos, pw: mine.pw } : null,
           list: all.slice(0, 25).map(x => ({ pos: x.pos, name: x.name, av: x.av, pw: x.pw, gold: x.pos === 1, me: x.u === uid })) };
}
function rkCredit(s) {                                                  // suma una victoria ranked a este jugador
  const p = db.players[s.data.uid], now = Date.now();
  if (!p || now - (s.data.lw || 0) < 15000) return false;               // anti-abuso: una victoria cada 15 s como mucho
  s.data.lw = now; p.pw = (p.pw || 0) + 1; p.pwt = now; _ld = null; save();
  return true;
}

function cleanProf(s, d) {
  d = d || {};
  const p = db.players[s.data.uid];
  return { name: (p && p.name) || 'Jugador', av: cleanAv(d.av), gems: ni(d.gems, 1e9), chars: ni(d.chars, MAX_ID),
           wins: ni(d.wins, 1e9), rk: d.rk == null ? null : ni(d.rk, 10), pw: ni(d.pw, 1e9), battles: ni(d.battles, 1e9), days: ni(d.days, 100000),
           gold: leaders().has(s.data.uid) };
}

function unqueue(s) { for (const m in queues) queues[m] = queues[m].filter(e => e.s !== s); }
// Cuántas personas están buscando partida (PvP = sala/rápida + rankeds, y Raid): lo ven todos los juegos
const searching = () => ({ pvp: queues.pvp.filter(e => e.s.connected).length + queues.rank.filter(e => e.s.connected).length, raid: queues.raid.filter(e => e.s.connected).length });
app.get('/searching', (_, res) => { res.set({ 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' }); res.json(searching()); });
let lastSrch = JSON.stringify(searching());
setInterval(() => { const st = searching(), j = JSON.stringify(st); if (j !== lastSrch) { lastSrch = j; io.emit('srch', st); } }, 1500);   // avisa a los conectados cuando cambia

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
  if (m.rank && !m.won && !m.done.has(s.id) && !m.done.has(o.id)) { m.won = o.id; rkCredit(o); }   // el rival abandonó la ranked: victoria para quien se quedó
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

function startMatch(sa, ta, sb, tb, raid, rank) {
  const seed = Math.floor(Math.random() * 4294967296);
  const wx = WX[Math.floor(Math.random() * WX.length)];
  const m = { a: sa, b: sb, t: null, got: new Set(), done: new Set(), rank: !!rank && !raid, won: 0 };
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

// --- Rankeds: matchmaking por rango. Familias: 0 Sangano, 1 Obrera, 2 Guardia, 3 Reina.
// Al inicio solo se emparejan jugadores de la misma familia (se prefiere el rango más cercano);
// tras 30 s se acepta una familia de diferencia y tras 60 s cualquiera. Luego votan el modo.
const RK_FAM = [0, 0, 0, 1, 1, 1, 2, 2, 2, 2, 3];
const rkFam = r => RK_FAM[ni(r, 10)];
// Lobby de votación entre dos jugadores (partida rápida y rankeds)
function openLobby(a, b, rank) {
  const L = { rank: !!rank, a: { s: a.s, prof: a.prof, vote: 0, team: null }, b: { s: b.s, prof: b.prof, vote: 0, team: null }, phase: 'vote', mode: 0, t: null };
  lobbies.set(a.s.id, L); lobbies.set(b.s.id, L);
  a.s.emit('plobby', { opp: b.prof, ms: VOTE_MS });
  b.s.emit('plobby', { opp: a.prof, ms: VOTE_MS });
  L.t = setTimeout(() => resolveVote(L), VOTE_MS + 500);
}
// Partida rápida: no cuenta para rankeds; se empareja por orden de llegada
function tryPvp() {
  const q = queues.pvp;
  while (q.length >= 2) {
    const a = q.shift(), b = q.shift();
    if (!a.s.connected) { q.unshift(b); continue; }
    if (!b.s.connected) { q.unshift(a); continue; }
    openLobby(a, b);
  }
}
function tryRank() {
  queues.rank = queues.rank.filter(e => e.s.connected);
  for (;;) {
    const q = queues.rank, now = Date.now();
    let best = null;
    for (let i = 0; i < q.length; i++) for (let j = i + 1; j < q.length; j++) {
      const a = q[i], b = q[j], wait = Math.max(now - a.t, now - b.t);
      const maxFam = wait >= 60000 ? 9 : wait >= 30000 ? 1 : 0;
      if (Math.abs(rkFam(a.prof.rk) - rkFam(b.prof.rk)) > maxFam) continue;
      const d = Math.abs(a.prof.rk - b.prof.rk) * 1e6 - wait;
      if (!best || d < best.d) best = { i, j, d };
    }
    if (!best) return;
    const a = q[best.i], b = q[best.j];
    queues.rank = q.filter((_, k) => k !== best.i && k !== best.j);
    openLobby(a, b, true);
  }
}
setInterval(tryRank, 5000);   // reintenta para ampliar la búsqueda de quien lleva tiempo esperando

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
    queues.pvp.push({ s, prof: cleanProf(s, d && d.prof), t: Date.now() });
    tryPvp();
  });
  // Rankeds: emparejamiento por rango
  s.on('rkfind', d => {
    endMatch(s); unqueue(s); lobbyEnd(s, '🔌 Tu rival salió de la sala');
    const pr = cleanProf(s, d && d.prof), me = db.players[s.data.uid];
    if (me) { if (me.pw === undefined && pr.pw > 0) { me.pw = Math.min(pr.pw, 500); me.pwt = Date.now(); _ld = null; } if (pr.av) me.av = pr.av; save(); }   // la primera vez se copian las victorias que ya tenía
    queues.rank.push({ s, prof: pr, t: Date.now() });
    tryRank();
  });
  s.on('find', () => s.emit('err', 'Actualiza el juego a la versión 8.0'));   // clientes viejos

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
      startMatch(L.a.s, L.a.team, L.b.s, L.b.team, false, L.rank);
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
  s.on('rkwin', () => {                                            // el juego avisa que ganó una ranked
    const m = matches.get(s.id);
    if (!m || !m.rank || m.won || !m.done.has(s.id)) return;
    m.won = s.id; rkCredit(s);
  });
  s.on('rktop', () => {                                            // ranking de victorias (Top 25)
    const now = Date.now();
    if (now - (s.data.rt || 0) < 1500) return;
    s.data.rt = now;
    s.emit('rktop', rkBoard(s.data.uid));
  });
  s.on('leave', () => { endMatch(s); lobbyEnd(s, '🔌 Tu rival salió de la sala'); });
  s.on('disconnect', () => { unqueue(s); endMatch(s); lobbyEnd(s, '🔌 Tu rival se desconectó'); });
});

// ===== Mundo abierto: jardín compartido con estanque, chat y gemas escondidas =====
const WW = 4840, LW = 2400, WH = 1800, WY0 = -1000, NPC = { x: 1200, y: -760 }, POND = { x: 1200, y: 900, r: 280 }, SPEED = 240, MAX_WORLD = 60;
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
    const x = 80 + Math.random() * (LW - 160), y = des ? WY0 + 80 + Math.random() * (-WY0 - 140) : 80 + Math.random() * (WH - 160);
    if (!des && Math.hypot(x - POND.x, y - POND.y) < POND.r + 60) continue;
    if (!des && x > 960 && x < 1440 && y > 1440) continue;
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

// --- La Mina: minerales para todo el servidor (los toma quien llegue primero; se reinician cada 30 minutos) ---
// Para cambiar los premios: lo (mínimo) y hi (máximo) por mineral; ms = cuánto hay que mantener presionado para sacarlo (milisegundos); k:'m' = monedas 🪙, k:'g' = gemas 💎; cnt = cuántos salen en cada reinicio
const MINE = { x1: 2400, x2: 4800, y1: 400, y2: 1400, gy: 900 }, ORE_RESET = 30 * 60 * 1000;
const ORE_T = { c: { n: 'Carbón', k: 'm', lo: 3, hi: 6, ms: 1000, cnt: 88 }, k: { n: 'Cobre', k: 'm', lo: 8, hi: 14, ms: 1800, cnt: 56 }, i: { n: 'Hierro', k: 'm', lo: 18, hi: 30, ms: 3000, cnt: 40 },
  o: { n: 'Oro', k: 'g', lo: 60, hi: 120, ms: 4500, cnt: 9 }, d: { n: 'Diamante', k: 'g', lo: 250, hi: 400, ms: 6500, cnt: 3 } };
const ores = new Map(); let oreSeq = 0, oreNext = Date.now() + ORE_RESET;
const orePub = o => ({ id: o.id, x: o.x, y: o.y });               // a los jugadores solo se les dice dónde hay un mineral, NO cuál es
function oreSpawnAll() {
  ores.clear(); const placed = [];
  for (const t of ['d', 'o', 'i', 'k', 'c']) for (let i = 0; i < ORE_T[t].cnt; i++) for (let k = 0; k < 300; k++) {      // primero los raros, para que siempre salgan
    const x = MINE.x1 + 80 + Math.random() * (MINE.x2 - MINE.x1 - 160), y = MINE.y1 + 80 + Math.random() * (MINE.y2 - MINE.y1 - 160);
    if (x < MINE.x1 + 170 && Math.abs(y - MINE.gy) < 100) continue;            // deja libre la entrada
    if (placed.some(o => Math.hypot(o.x - x, o.y - y) < 65)) continue;
    placed.push({ x: Math.round(x), y: Math.round(y), t }); break;
  }
  for (let i = placed.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [placed[i], placed[j]] = [placed[j], placed[i]]; }   // se mezclan: ni el id ni el orden delatan el tipo
  for (const o of placed) { o.id = ++oreSeq; ores.set(o.id, o); }
}
oreSpawnAll();
function oreReset() {
  oreSpawnAll(); oreNext = Date.now() + ORE_RESET;
  io.to('world').emit('wores', { list: [...ores.values()].map(orePub), next: oreNext, now: Date.now() });
  if (world.size) pushChat({ sys: true, text: '⛏️ ¡La mina se reinició! Hay ' + ores.size + ' minerales nuevos' });
}
setInterval(oreReset, ORE_RESET);
const inMine = p => p.x > MINE.x1 && p.x < MINE.x2 + 20 && p.y > MINE.y1 && p.y < MINE.y2;
function oreTick(now) {                              // cada 0,1 s: revisa quién está picando y quién termina primero se lleva el mineral
  const done = [];
  for (const [sid, p] of world) {
    const m = p.mn; if (!m) continue;
    const o = ores.get(m.id);
    if (!o) { p.mn = null; continue; }                                                     // ya lo sacó otro o la mina se reinició
    if (!inMine(p) || Math.hypot(p.x - o.x, p.y - o.y) > 130) { p.mn = null; io.to(sid).emit('wmstop', { id: m.id, why: 'lejos' }); continue; }
    const fin = m.t0 + ORE_T[o.t].ms;
    if (now >= fin) done.push({ sid, p, o, fin });
  }
  done.sort((a, b) => a.fin - b.fin);                                                      // si dos terminan en el mismo instante, gana el que empezó antes
  for (const { sid, p, o } of done) {
    if (!ores.has(o.id)) continue;
    ores.delete(o.id); p.mn = null;
    const T = ORE_T[o.t], amt = T.lo + Math.floor(Math.random() * (T.hi - T.lo + 1));
    io.to(sid).emit('wmined', { id: o.id, t: o.t, k: T.k, amt });
    io.to('world').emit('wogone', o.id);
    for (const [sid2, q] of world) if (q.mn && q.mn.id === o.id) { q.mn = null; io.to(sid2).emit('wmstop', { id: o.id, why: 'taken' }); }
    if (T.k === 'g') pushChat({ sys: true, text: '⛏️ ' + p.name + ' sacó ' + T.n + ' y ganó 💎' + amt });
  }
}
setInterval(() => oreTick(Date.now()), 100);

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
    const av = cleanAv(d && d.av);
    const a = Math.random() * Math.PI * 2, r = POND.r + 150 + Math.random() * 150;
    const p = { id: s.id, name, av, x: POND.x + Math.cos(a) * r, y: POND.y + Math.sin(a) * r, t: Date.now(), dirty: false, lc: 0, ld: 0, lr: 0,
      uid: cleanUid(d && d.uid), fr: new Set((Array.isArray(d && d.fr) ? d.fr : []).slice(0, 300).map(cleanUid)) };
    if (p.uid) uidSock.set(p.uid, s.id);
    s.emit('wstate', { you: s.id, players: [...world.values(), p].map(pub), gems: [...gems.values()], ores: [...ores.values()].map(orePub), oreNext, now: Date.now(), chat: chatLog });
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

  s.on('wmstart', d => {                                     // empieza a picar (hay que mantener presionado; el servidor cuenta el tiempo)
    const p = world.get(s.id), o = d && ores.get(d.id), now = Date.now();
    if (!p || !o || now - (p.lm || 0) < 300) return;
    p.lm = now;
    if (!inMine(p) || Math.hypot(p.x - o.x, p.y - o.y) > 130) return;
    p.mn = { id: o.id, t0: now };
  });
  s.on('wmstop', () => { const p = world.get(s.id); if (p) p.mn = null; });

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

/* ===== Crews (clanes): miembros, chat e intercambio ===== */
const CREW_MAX = 20, CREW_LOG = 40, TR_CAP = { c: 3 }, TR_PER_HOUR = 10;
const crewOf = uid => { const p = db.players[uid]; return p && p.crew && db.crews[p.crew] ? db.crews[p.crew] : null; };
const crSocks = uid => [...(online.get(uid) || [])];
const crView = c => ({ id: c.id, name: c.name, leader: c.leader, max: CREW_MAX,
  members: c.members.map(u => { const p = db.players[u] || {}; return { uid: u, name: p.name || 'Jugador', av: p.av || 0, on: online.has(u) }; }) });
function crToAll(c, ev, data) { for (const u of c.members) for (const s of crSocks(u)) s.emit(ev, data); }
function crPush(c, withLog) { crToAll(c, 'crstate', withLog ? { c: crView(c), log: c.log } : { c: crView(c) }); }
function crSys(c, text) { const m = { n: '', x: text, t: Date.now(), s: 1 }; c.log.push(m); if (c.log.length > CREW_LOG) c.log.shift(); crToAll(c, 'crmsg', m); }
const cleanCards = a => [...new Set((Array.isArray(a) ? a : []).slice(0, 10).map(x => ni(x, MAX_ID)).filter(x => x >= 1))].slice(0, TR_CAP.c);
const trades = new Map(), tradeOf = new Map();            // intercambios en curso (solo en memoria)
function tView(tr, uid) {
  const me = tr.a === uid ? 'a' : 'b', ot = me === 'a' ? 'b' : 'a', op = db.players[tr[ot]] || {};
  return { id: tr.id, with: { uid: tr[ot], name: op.name || 'Jugador' }, mine: tr.of[me], theirs: tr.of[ot], mok: tr.ok[me], tok: tr.ok[ot], cap: TR_CAP };
}
function tPush(tr) { for (const u of [tr.a, tr.b]) for (const s of crSocks(u)) s.emit('crt', tView(tr, u)); }
function tEnd(tr, reason) {
  trades.delete(tr.id); tradeOf.delete(tr.a); tradeOf.delete(tr.b);
  for (const u of [tr.a, tr.b]) for (const s of crSocks(u)) s.emit('crtend', { id: tr.id, reason });
}
function tCancelUid(uid, reason) { const id = tradeOf.get(uid), tr = id && trades.get(id); if (tr) tEnd(tr, reason); }
function crRemove(uid, reason) {                           // sacar a un jugador de su crew (salió o lo expulsaron)
  const c = crewOf(uid), p = db.players[uid]; if (!c || !p) return;
  tCancelUid(uid, 'Se canceló el intercambio');
  c.members = c.members.filter(u => u !== uid); delete p.crew;
  for (const s of crSocks(uid)) s.emit('crstate', { c: null, log: [] });
  if (!c.members.length) delete db.crews[c.id];
  else { if (c.leader === uid) c.leader = c.members[0]; crSys(c, '👋 ' + (p.name || 'Jugador') + ' ' + reason); crPush(c); }
  save();
}
io.on('connection', s => {
  const uid = s.data.uid;
  const c0 = crewOf(uid); if (c0) setTimeout(() => crPush(c0), 200);     // avisa a la crew que este miembro está en línea
  if (db.trd[uid] && db.trd[uid].length) s.emit('crsettle', db.trd[uid]);   // intercambios que aún no cobró
  const lastAt = {}; const rate = (k, ms) => { const n = Date.now(); if (n - (lastAt[k] || 0) < ms) return false; lastAt[k] = n; return true; };
  s.on('crme', () => { const c = crewOf(uid); s.emit('crstate', { c: c ? crView(c) : null, log: c ? c.log : [] });
    const id = tradeOf.get(uid), tr = id && trades.get(id); if (tr) s.emit('crt', tView(tr, uid)); });
  s.on('crlist', () => s.emit('crlistr', Object.values(db.crews).sort((a, b) => b.members.length - a.members.length).slice(0, 40)
    .map(c => ({ id: c.id, name: c.name, n: c.members.length, max: CREW_MAX, lname: (db.players[c.leader] || {}).name || '' }))));
  s.on('crnew', d => {
    if (!rate('new', 800)) return;
    if (crewOf(uid)) return s.emit('crerr', 'Ya estás en una Crew');
    const name = clean(d && d.name, 16).replace(/\s+/g, ' ');
    if (name.length < 3) return s.emit('crerr', 'El nombre debe tener al menos 3 letras');
    if (Object.values(db.crews).some(c => c.name.toLowerCase() === name.toLowerCase())) return s.emit('crerr', 'Ya existe una Crew con ese nombre');
    if (Object.keys(db.crews).length >= 1000) return s.emit('crerr', 'Ya no caben más Crews');
    const id = crypto.randomBytes(5).toString('hex');
    const c = db.crews[id] = { id, name, leader: uid, members: [uid], log: [], at: Date.now() };
    db.players[uid].crew = id; crSys(c, '🎉 ' + db.players[uid].name + ' creó la Crew'); crPush(c, true); save();
  });
  s.on('crjoin', d => {
    if (!rate('join', 800)) return;
    if (crewOf(uid)) return s.emit('crerr', 'Ya estás en una Crew');
    const c = db.crews[cid(d && d.id)];
    if (!c) return s.emit('crerr', 'Esa Crew ya no existe');
    if (c.members.length >= CREW_MAX) return s.emit('crerr', 'La Crew está llena');
    c.members.push(uid); db.players[uid].crew = c.id; crSys(c, '👋 ' + db.players[uid].name + ' se unió'); crPush(c, true); save();
  });
  s.on('crleave', () => crRemove(uid, 'salió de la Crew'));
  s.on('crkick', d => {
    const c = crewOf(uid), t = cid(d && d.uid);
    if (!c || c.leader !== uid || t === uid || !c.members.includes(t)) return;
    crRemove(t, 'fue expulsado de la Crew');
    for (const k of crSocks(t)) k.emit('crerr', 'Te expulsaron de la Crew');
  });
  s.on('crchat', d => {
    const c = crewOf(uid); if (!c || !rate('chat', 700)) return;
    const x = String((d && d.msg) || '').replace(/[\u0000-\u001f<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, 200); if (!x) return;
    const m = { u: uid, n: db.players[uid].name, x, t: Date.now() };
    c.log.push(m); if (c.log.length > CREW_LOG) c.log.shift(); crToAll(c, 'crmsg', m); save();
  });
  /* intercambio de CARTAS (sin gemas): los dos ofrecen y los dos aceptan; el servidor guarda el resultado hasta que cada uno lo cobra */
  s.on('crtstart', d => {
    if (!rate('ts', 500)) return;
    const c = crewOf(uid), to = cid(d && d.uid);
    if (!c || to === uid || !c.members.includes(to)) return s.emit('crerr', 'Solo puedes intercambiar con miembros de tu Crew');
    if (!online.has(to)) return s.emit('crerr', 'Ese miembro no está conectado');
    if (tradeOf.has(uid) || tradeOf.has(to)) return s.emit('crerr', 'Uno de los dos ya está en un intercambio');
    const tr = { id: crypto.randomBytes(5).toString('hex'), a: uid, b: to, of: { a: { c: [] }, b: { c: [] } }, ok: { a: false, b: false } };
    trades.set(tr.id, tr); tradeOf.set(uid, tr.id); tradeOf.set(to, tr.id); tPush(tr);
  });
  const myTrade = d => { const tr = trades.get(String((d && d.id) || '')); return tr && (tr.a === uid || tr.b === uid) ? tr : null; };
  s.on('crtoffer', d => {
    const tr = myTrade(d); if (!tr) return;
    const me = tr.a === uid ? 'a' : 'b';
    tr.of[me] = { c: cleanCards(d.c) }; tr.ok.a = tr.ok.b = false; tPush(tr);
  });
  s.on('crtok', d => {
    const tr = myTrade(d); if (!tr) return;
    const me = tr.a === uid ? 'a' : 'b', ot = me === 'a' ? 'b' : 'a';
    tr.ok[me] = true;
    if (!(tr.ok.a && tr.ok.b)) return tPush(tr);
    const sum = x => x.c.length;
    if (!sum(tr.of.a) && !sum(tr.of.b)) { tr.ok.a = tr.ok.b = false; tPush(tr); return s.emit('crerr', 'Nadie ofreció nada'); }
    const now = Date.now();
    for (const u of [tr.a, tr.b]) { const p = db.players[u]; p.tl = (p.tl || []).filter(x => now - x < 3600000); if (p.tl.length >= TR_PER_HOUR) { tr.ok.a = tr.ok.b = false; tPush(tr); return s.emit('crerr', 'Límite de intercambios por hora alcanzado (alguno de los dos)'); } }
    for (const u of [tr.a, tr.b]) {                          // cada uno pierde lo que ofrece y recibe lo del otro
      const k = u === tr.a ? 'a' : 'b', o = k === 'a' ? 'b' : 'a', p = db.players[u];
      p.tl.push(now);
      (db.trd[u] = db.trd[u] || []).push({ id: tr.id, give: tr.of[k].c, get: tr.of[o].c });
    }
    const c = crewOf(uid);
    trades.delete(tr.id); tradeOf.delete(tr.a); tradeOf.delete(tr.b); save();
    for (const u of [tr.a, tr.b]) { const ss = crSocks(u); if (ss[0]) ss[0].emit('crsettle', db.trd[u]); for (const k of ss) k.emit('crtend', { id: tr.id, reason: 'done' }); }
    if (c) crSys(c, '🔄 ' + db.players[tr.a].name + ' y ' + db.players[tr.b].name + ' hicieron un intercambio');
  });
  s.on('crtcancel', d => { const tr = myTrade(d); if (tr) tEnd(tr, '❌ ' + (db.players[uid].name || 'El otro jugador') + ' rechazó el intercambio'); });
  s.on('crack', ids => {                                     // el jugador ya aplicó el resultado de sus intercambios
    if (!Array.isArray(ids) || !db.trd[uid]) return;
    const ok = new Set(ids.slice(0, 50).map(x => String(x)));
    db.trd[uid] = db.trd[uid].filter(g => !ok.has(g.id));
    if (!db.trd[uid].length) delete db.trd[uid];
    save();
  });
  s.on('disconnect', () => setTimeout(() => {
    if (!online.has(uid)) tCancelUid(uid, '🔌 El otro jugador se desconectó');
    const c = crewOf(uid); if (c) crPush(c);
  }, 400));
});

const PORT = process.env.PORT || 3000;
// =====================================================================
//  MEGABATALLA CONTRA BUNNY IGLESIAS: fiesta de hasta 8 jugadores
//  Flujo: el anfitrión crea la fiesta (mp:create) -> invita a jugadores conectados (mp:online / mp:invite)
//  -> cada invitado se une con 1 personaje (mp:join) -> el anfitrión empieza (mp:start) y todos reciben
//  la misma semilla (mstart). Durante el combate el servidor solo reenvía las acciones de cada turno (mplan).
// =====================================================================
const MP_MAX = 8, MP_PLAN_MS = Number(process.env.MP_PLAN_MS) || 60000;
const parties = new Map();                 // pid -> fiesta
const partyOf = new Map();                 // socket.id -> fiesta
let pidSeq = 0;
const mpName = s => ((db.players[s.data.uid] || {}).name) || 'Jugador';
const mpFree = s => s && s.connected !== false && !partyOf.has(s.id) && !matches.has(s.id) && !lobbies.has(s.id);
function mpState(P, viewer) {
  return { pid: P.pid, max: MP_MAX, host: P.host === viewer.id,
    members: P.members.map(m => ({ id: m.s.id, name: m.name, av: m.av, ch: m.ch, host: m.s.id === P.host, me: m.s === viewer })) };
}
const mpPush = P => P.members.forEach(m => { if (!m.left) m.s.emit('mp', mpState(P, m.s)); });
function mpGone(P, idx, at) {              // un jugador sale en pleno combate: los demás dejan de esperar su plan desde la ronda "at"
  const m = P.members[idx]; if (!m || m.left) return;
  m.left = true; m.at = at;
  partyOf.delete(m.s.id);
  P.members.forEach((o, i) => { if (i !== idx && !o.left) o.s.emit('mleft', { idx, at }); });
  if (P.members.every(x => x.left)) { Object.values(P.timers).forEach(clearTimeout); parties.delete(P.pid); }
}
function mpLeave(s) {
  const P = partyOf.get(s.id); if (!P) return;
  const idx = P.members.findIndex(m => m.s === s);
  if (P.started) { mpGone(P, idx, P.members[idx].last + 1); return; }
  if (P.host === s.id) {                   // si se va el anfitrión, la fiesta se deshace
    P.members.forEach(m => { partyOf.delete(m.s.id); if (m.s !== s) m.s.emit('mp', null); });
    parties.delete(P.pid); return;
  }
  P.members.splice(idx, 1); partyOf.delete(s.id); mpPush(P);
}
function mpTimer(P, rd) {                  // si alguien tarda más de 60 s en mandar su plan de la ronda, se le expulsa
  if (P.timers[rd] || P.done) return;
  P.timers[rd] = setTimeout(() => {
    delete P.timers[rd];
    P.members.forEach((m, i) => {
      if (!m.left && !(P.got[rd] && P.got[rd].has(i))) { m.s.emit('mkicked'); mpGone(P, i, rd); }
    });
  }, MP_PLAN_MS);
}
io.on('connection', s => {
  s.on('mp:create', d => {
    if (!d || !validTeam(1, d.team)) return s.emit('mperr', 'Equipo inválido');
    if (partyOf.has(s.id)) return s.emit('mperr', 'Ya estás en una fiesta');
    if (matches.has(s.id) || lobbies.has(s.id)) return s.emit('mperr', 'Termina tu partida antes de crear una fiesta');
    const P = { pid: 'p' + (++pidSeq) + Math.random().toString(36).slice(2, 6), host: s.id, members: [], inv: new Set(), started: false, timers: {}, got: {} };
    P.members.push({ s, name: mpName(s), av: cleanAv(d.av), ch: { id: d.team[0].id, l: d.team[0].l }, last: -1, left: false });
    parties.set(P.pid, P); partyOf.set(s.id, P);
    mpPush(P);
  });
  s.on('mp:online', () => {                // jugadores conectados a los que se puede invitar
    const P = partyOf.get(s.id); if (!P || P.host !== s.id || P.started) return;
    const now = Date.now(); if (now - (s.data.mo || 0) < 800) return; s.data.mo = now;
    const out = [];
    for (const [uid, set] of online) {
      if (uid === s.data.uid || banInfo(uid)) continue;
      const t = [...set].find(mpFree); if (!t) continue;
      out.push({ id: t.id, name: mpName(t), av: cleanAv((db.players[uid] || {}).av) });
    }
    out.sort((a, b) => a.name.localeCompare(b.name)); s.emit('mponline', out.slice(0, 40));
  });
  s.on('mp:invite', d => {
    const P = partyOf.get(s.id); if (!P || P.host !== s.id || P.started || !d) return;
    const now = Date.now(); if (now - (s.data.mv || 0) < 600) return; s.data.mv = now;
    if (P.members.length >= MP_MAX) return s.emit('mperr', 'La fiesta está llena');
    const t = io.sockets.sockets.get(String(d.id));
    if (!t || !mpFree(t)) return s.emit('mperr', 'Ese jugador ya no está disponible');
    P.inv.add(t.data.uid);
    t.emit('mpinv', { pid: P.pid, from: mpName(s), n: P.members.length });
    s.emit('mpinvd');
  });
  s.on('mp:join', d => {
    const P = d && parties.get(String(d.pid));
    if (!P || P.started) return s.emit('mperr', 'La fiesta ya no existe o ya empezó');
    if (!validTeam(1, d.team)) return s.emit('mperr', 'Equipo inválido');
    if (partyOf.has(s.id)) return s.emit('mperr', 'Ya estás en una fiesta');
    if (matches.has(s.id) || lobbies.has(s.id)) return s.emit('mperr', 'Termina tu partida antes de unirte');
    if (!P.inv.has(s.data.uid)) return s.emit('mperr', 'Necesitas una invitación del anfitrión');
    if (P.members.length >= MP_MAX) return s.emit('mperr', 'La fiesta está llena');
    P.members.push({ s, name: mpName(s), av: cleanAv(d.av), ch: { id: d.team[0].id, l: d.team[0].l }, last: -1, left: false });
    partyOf.set(s.id, P); P.inv.delete(s.data.uid);
    mpPush(P);
  });
  s.on('mp:start', () => {
    const P = partyOf.get(s.id); if (!P || P.host !== s.id || P.started) return;
    P.started = true; P.inv.clear();
    const seed = Math.floor(Math.random() * 4294967296), wx = WX[Math.floor(Math.random() * WX.length)];
    const members = P.members.map(m => ({ name: m.name, av: m.av, ch: m.ch }));
    P.members.forEach((m, i) => m.s.emit('mstart', { idx: i, members, seed, wx }));
  });
  s.on('mp:leave', () => mpLeave(s));
  s.on('mleave', () => mpLeave(s));
  s.on('mplan', p => {                     // cada turno cada jugador manda sus acciones; el servidor solo las reenvía a los demás
    const P = partyOf.get(s.id);
    if (!P || !P.started || !p || typeof p !== 'object') return;
    const idx = P.members.findIndex(m => m.s === s), me = P.members[idx];
    if (idx < 0 || me.left) return;
    const rd = Math.max(0, Math.floor(Number(p.rd)) || 0);
    const a = Array.isArray(p.a) ? p.a.slice(0, 6) : [], sw = Array.isArray(p.sw) ? p.sw.slice(0, 6) : [];
    if (JSON.stringify({ a, sw }).length > 6000) return;
    me.last = Math.max(me.last, rd);
    (P.got[rd] = P.got[rd] || new Set()).add(idx);
    P.members.forEach((m, i) => { if (i !== idx && !m.left) m.s.emit('mplan', { idx, rd, a, sw }); });
    if (P.members.every(m => m.left || P.got[rd].has(P.members.indexOf(m)))) { clearTimeout(P.timers[rd]); delete P.timers[rd]; delete P.got[rd - 3]; }
    else mpTimer(P, rd);
  });
  s.on('disconnect', () => mpLeave(s));
});

server.listen(PORT, () => console.log('MultiverZ PvP en puerto ' + PORT));
