// Servidor de emparejamiento PvP de MultiverZ
const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.get('/', (_, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/health', (_, res) => res.send('ok'));

const MAX_ID = 80;                 // sube este número cuando agregues personajes
const WX = ['Soleado', 'Nocturno', 'Lluvioso', 'Nublado'];
const queues = { 1: [], 2: [], 3: [], raid: [] };   // raid = RaidOnline 2vs2 cooperativo
const matches = new Map();         // socket.id -> partida

const validTeam = (mode, t) =>
  Array.isArray(t) && t.length === mode &&
  new Set(t.map(x => x && x.id)).size === mode &&
  t.every(x => x && Number.isInteger(x.id) && x.id >= 1 && x.id <= MAX_ID &&
                Number.isInteger(x.l) && x.l >= 0 && x.l <= 5);

function unqueue(s) { for (const m in queues) queues[m] = queues[m].filter(e => e.s !== s); }

function endMatch(s) {
  const m = matches.get(s.id);
  if (!m) return;
  const o = m.a === s ? m.b : m.a;
  clearTimeout(m.t);
  matches.delete(m.a.id); matches.delete(m.b.id);
  if (!m.done.has(s.id)) o.emit('oppleft');
}

function tryMatch(mode) {
  const q = queues[mode];
  while (q.length >= 2) {
    const a = q.shift(), b = q.shift();
    if (!a.s.connected) { q.unshift(b); continue; }
    if (!b.s.connected) { q.unshift(a); continue; }
    const seed = Math.floor(Math.random() * 4294967296);
    const wx = WX[Math.floor(Math.random() * WX.length)];
    const m = { a: a.s, b: b.s, t: null, got: new Set(), done: new Set() };
    matches.set(a.s.id, m); matches.set(b.s.id, m);
    const raid = mode === 'raid';   // en raid, "opp" es el equipo del compañero
    a.s.emit('match', { host: true,  seed, wx, me: a.team, opp: b.team, raid });
    b.s.emit('match', { host: false, seed, wx, me: b.team, opp: a.team, raid });
  }
}

io.on('connection', s => {
  s.on('find', d => {
    const mode = d && d.mode;
    if (![1, 2, 3].includes(mode) || !validTeam(mode, d.team)) return s.emit('err', 'Equipo inválido');
    endMatch(s); unqueue(s);
    queues[mode].push({ s, team: d.team });
    tryMatch(mode);
  });

  // RaidOnline: dos jugadores (2 personajes cada uno) se emparejan como compañeros
  s.on('findraid', d => {
    if (!d || !validTeam(2, d.team)) return s.emit('err', 'Equipo inválido');
    endMatch(s); unqueue(s);
    queues.raid.push({ s, team: d.team });
    tryMatch('raid');
  });

  s.on('cancel', () => unqueue(s));

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
  s.on('leave', () => endMatch(s));
  s.on('disconnect', () => { unqueue(s); endMatch(s); });
});

// ===== Mundo abierto: jardín compartido con estanque, chat y gemas escondidas =====
const WW = 2400, WH = 1800, POND = { x: 1200, y: 900, r: 280 }, SPEED = 240, MAX_WORLD = 60;
const world = new Map();           // socket.id -> { id, name, av, x, y, t, dirty }
const pub = p => ({ id: p.id, name: p.name, av: p.av, x: Math.round(p.x), y: Math.round(p.y) });
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

// --- Chat ---
const chatLog = [];                                  // últimos mensajes (se envían al entrar)
function pushChat(m) { chatLog.push(m); if (chatLog.length > 30) chatLog.shift(); io.to('world').emit('wmsg', m); }
const cleanMsg = v => String(v || '').replace(/[\u0000-\u001f<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, 80);

// --- Gemas escondidas (las ve y recoge quien llegue primero) ---
const GEM_N = 12, GEM_RESET = 2 * 60 * 60 * 1000, GEM_VALS = [20, 20, 20, 20, 50, 50, 150];   // todas las gemas se reinician cada 2 horas
const gems = new Map(); let gemSeq = 0;
function gemSpawn() {
  for (let k = 0; k < 40; k++) {
    const x = 80 + Math.random() * (WW - 160), y = 80 + Math.random() * (WH - 160);
    if (Math.hypot(x - POND.x, y - POND.y) < POND.r + 60) continue;
    const g = { id: ++gemSeq, x: Math.round(x), y: Math.round(y) };
    gems.set(g.id, g); io.to('world').emit('wgnew', g); return;
  }
}
for (let i = 0; i < GEM_N; i++) gemSpawn();
function gemReset() {                                // cada 2 h: se borran las que quedaban y salen 12 nuevas para todos
  gems.clear();
  io.to('world').emit('wgreset');
  for (let i = 0; i < GEM_N; i++) gemSpawn();
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
    x = clamp(x, 20, WW - 20); y = clamp(y, 20, WH - 20);
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
    const amt = GEM_VALS[Math.floor(Math.random() * GEM_VALS.length)];
    s.emit('wgot', { id: g.id, amt });
    io.to('world').emit('wgone', g.id);
    pushChat({ sys: true, text: '💎 ' + p.name + ' encontró una gema de ' + amt });
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
