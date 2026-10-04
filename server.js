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

const MAX_ID = 55;                 // sube este número cuando agregues personajes
const WX = ['Soleado', 'Nocturno', 'Lluvioso', 'Nublado'];
const queues = { 1: [], 2: [], 3: [] };
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
    a.s.emit('match', { host: true,  seed, wx, me: a.team, opp: b.team });
    b.s.emit('match', { host: false, seed, wx, me: b.team, opp: a.team });
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

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log('MultiverZ PvP en puerto ' + PORT));
