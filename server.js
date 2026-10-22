const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const fs = require('fs');
const NAMES = require('./names');

const app = express();
const server = http.createServer(app);
const io = new Server(server);
app.use(express.static(__dirname + '/public', { setHeaders: (res, p) => { if (/\.(html|js)$/.test(p)) res.setHeader('Cache-Control', 'no-cache'); } })); // que el navegador no se quede con una versión vieja
app.get('/health', (q, res) => res.send('ok'));
// Modo solo / sin conexión: el navegador descarga el MISMO motor de este archivo (lo que hay entre los dos marcadores) y lo ejecuta en local con bots
let ENGINE_JS = null;
app.get('/engine.js', (q, res) => {
  try {
    if (!ENGINE_JS) {
      const src = fs.readFileSync(__filename, 'utf8');
      const a = src.indexOf('// >>> ' + 'ENGINE START'), b = src.indexOf('// <<< ' + 'ENGINE END');
      ENGINE_JS = 'window.__makeEngine=function(io){\nconst NAMES=' + JSON.stringify(NAMES) + ';\n' + src.slice(a, b) + '\n};';
    }
    res.set('Content-Type', 'application/javascript; charset=utf-8').set('Cache-Control', 'no-cache').send(ENGINE_JS);
  } catch (e) { res.status(500).send('// motor no disponible'); }
});

// >>> ENGINE START (todo lo de aquí hasta ENGINE END también se ejecuta en el navegador en el modo solo)

// ---- Ajustes del juego (cámbialos aquí) ----
const SIM_LEAGUES = ['FMS España', 'FMS Argentina', 'FMS México', 'FMS Chile', 'FMS Perú', 'FMS Colombia', 'FMS Caribe'];
const SIM_MAX = SIM_LEAGUES.length; // «Simulaciones»: una liga por jugador (1 a 7 jugadores)
const SIM_TEAM = 8;      // freestylers por jugador = participantes de su liga (7 jornadas de 4 batallas)
const CACHE_START = 1000, CACHE_WIN = 300, CACHE_WIN_REP = 150, CACHE_UPSET = 0.25; // caché: base, premio por victoria, premio tras réplica y extra por ganar a alguien con más caché
const SIM_GROUP_PLAYERS = 5; // desde 5 jugadores: formato de la FMS Internacional 2021 (fase de grupos con 5 ligas); con exactamente 4: cortes como en 2019
const GRP_NAMES = ['A', 'B', 'C', 'D', 'E', 'Reservas']; // 5 grupos (1.º a 5.º de cada liga) + reservas (6.º de cada liga)
const GRP_Q = 3, GRP_Q_RES = 1; // clasifican los 3 primeros de cada grupo y el 1.º de reservas = 16 en la Gran Final
const SIM_INTL_PLAYERS = 4; // con exactamente 4 jugadores (4 ligas) se juega la FMS Internacional (4 por liga = 16 en cada corte)
const SIM_CUT_J_DBL = 2;  // lo mismo con jornada doble (3 batallas jugadas por freestyler, igual que tras la jornada 3 normal)
const SIM_CUT_J = 3;        // el primer corte internacional se juega al terminar esta jornada en todas las ligas
const CACHE_INTL_WIN = 400, CACHE_INTL_WIN_REP = 200, CACHE_INTL_CHAMP = 3000; // caché en la internacional: por victoria, tras réplica y premio gordo al campeón
const WS_SIZE = 10, CACHE_WS_CHAMP = 1500; // Temporada 2: la World Series reúne a los 10 freestylers mejor pagados (caché) de todas las ligas; su campeón se lleva este premio
const EVENT_P = 1;        // probabilidad de que haya un evento al terminar una jornada (1 = siempre; no hay tras la última jornada)
const CACHE_MVP = 400;    // pago al MVP de cada jornada de cada liga (una victoria vale 300)
const CACHE_VIRAL = 500;  // caché que gana cada uno de los 2 competidores de la «batalla viral»
const CACHE_PIQUE = 500, CACHE_PIQUE_REP = 300; // caché del ganador de la exhibición del «pique» (directo / tras réplica)
const POLEMICA_LOSS = 0.3; // «polémica»: si no le pagas y lo mantienes, pierde este % de su caché
const DRAFT_ROUNDS = 1;   // rondas del draft: 1 propuesta de intercambio por jugador (hay que acordarlo con el dueño de la otra liga; si rechaza, pierdes el turno)
const EVENTS = ['baja', 'viral', 'polemica', 'pique', 'veto', 'streamer', 'music']; // el orden es el de la ruleta (el cliente usa el mismo)
// ---- Modo Carrera (solo con Simulaciones): todas las temporadas de la FMS, con más ligas cada año ----
const CAREER_LEAGUES = [ // ligas de cada temporada; las que ya existían conservan sus freestylers y su caché
  ['FMS España'],
  ['FMS España', 'FMS Argentina'],
  ['FMS España', 'FMS Argentina', 'FMS México', 'FMS Chile'] // + FMS Internacional con cortes clasificatorios (como en 2019)
];
const CAREER_SEASONS = CAREER_LEAGUES.length;
const CAREER_MAX_PLAYERS = 4; // las ligas se reparten entre los jugadores; si juegas solo llevas todas y eres el único jurado
const CAREER_INTL_SEASON = 3; // desde esta temporada hay FMS Internacional (las 4 ligas, con cortes)
const CACHE_MINI_CHAMP = 1500; // premio de caché del campeón de la mini inter (2 ligas)
const CAREER_WS_S2 = false;   // true = en la temporada 2 de la carrera también se juega la World Series
const STREAMER_MULT = 1.5, MUSIC_MULT = 1.5; // «streamer»: más caché a tu liga en la próxima jornada; «música»: más caché y visitas a un freestyler el resto de la temporada
// Visitas: cada batalla tiene un nº de visitas al azar según lo que cobran (caché) y lo conocidos que son; las visitas también dan caché
const VISIT_BASE = 60000;      // visitas de una batalla entre dos freestylers de 1000 de caché y fama 1
const VISITS_PER_CACHE = 300;  // cada 300 visitas = 1$ de caché extra a repartir en la batalla
const VISIT_SPLIT_W = 0.6;     // el ganador se lleva el 60% de ese caché por visitas y el perdedor el 40%
// Fama manual por nombre (sin bandera ni paréntesis, en minúsculas, sin tildes ni espacios: 'Lit Killah' -> 'litkillah'). Rango útil 0.5 a 2.
// La fama multiplica las visitas de las batallas (media de los dos). Lo que no está aquí sale de su puesto en la lista élite (1.8 el primero, 0.6 el último);
// los nombres que no están en la lista élite tienen fama baja por defecto (0.6 a 1.0), porque si no son conocidos atraen menos gente.
const FAME_OVERRIDE = {
  // Dedicados a la música (exfreestylers con carrera de artista): atraen a un público enorme fuera del freestyle
  duki: 2.0,        // primer artista latino en llenar el Santiago Bernabéu; empezó en las batallas del Quinto Escalón
  trueno: 1.9,      // nominado a los Latin Grammy, colabora con Duki, Bizarrap y Nicki Nicole
  gotti: 1.9,       // Tiago PZK (su alter ego es GOTTI): campeón de BDM y artista con éxitos internacionales
  wos: 1.9,         // campeón de Red Bull 2018 y el artista más nominado en los Premios Gardel 2022
  litkillah: 1.8,   // más de 7 millones de seguidores en Instagram, uno de los argentinos más escuchados en Spotify
  acru: 1.4,        // varios álbumes y giras; colaboraciones con Wos, Trueno y Bizarrap
  mks: 1.4,         // compañero de Duki en batallas que están entre las más vistas en español
  dani: 1.3,        // dejó la FMS junto a Wos para dedicarse a la música
  gsony: 1.2,       // campeón de Red Bull Argentina 2014 y cantante (La Voz Argentina)
  // Campeones y leyendas de las batallas (Red Bull Internacional, God Level, FMS)
  aczino: 2.0,      // varias veces campeón internacional de Red Bull, el más laureado
  chuty: 2.0,       // campeón de Red Bull 2023 y 2024 (esta última compartida con Gazir)
  skone: 1.8,       // campeón de Red Bull 2016 y finalista en varias ocasiones
  gazir: 1.8,       // campeón de Red Bull 2024 y subcampeón en 2021 y 2022
  papo: 1.6,        // referente argentino, finalista de grandes torneos y analista muy seguido en directos
  dtoke: 1.6,       // campeón de Red Bull Argentina
  mecha: 1.5,       // tercero en Red Bull 2022 y 2023
  rapder: 1.4,      // campeón de Red Bull 2020
  dozer: 1.4,       // jurado de la final internacional de 2024 y figura de la FMS
  bnet: 1.3,        // leyenda española, citado como referente por otros campeones
  kaiser: 1.3,      // campeón de Red Bull y God Level en Chile
  teorema: 1.3,     // leyenda chilena: campeón de BDM, de la FMS y de Red Bull a nivel nacional
  nekroos: 1.3,     // el referente del freestyle peruano
  kodigo: 1.3,      // admirado por otros campeones como uno de los mejores freestylers
  stuart: 1.3,
  stigma: 1.2,      // para Kaiser, el mejor freestyler de Chile
  jaze: 1.2,        // campeón de la primera FMS Perú y tres veces campeón de God Level
  marithea: 1.2,    // campeona de Red Bull Colombia en 2023
  fatn: 1.2,        // subcampeón de Red Bull Colombia en 2023
  jonybeltran: 1.2, // semifinalista de la Red Bull Internacional de 2013
  jessepungaz: 1.1, // campeón argentino de Red Bull 2024
  mnak: 1.1,        // finalista español de 2024
  invert: 1.1
};
// Freestylers que hoy se dedican a la música: además de su fama atraen más gente (se multiplica por ARTIST_BONUS)
const MUSIC_ARTISTS = new Set(['duki', 'trueno', 'gotti', 'wos', 'litkillah', 'acru', 'mks', 'dani', 'gsony']);
const ARTIST_BONUS = 1.2;
const KO_NAMES = ['Octavos de final', 'Cuartos de final', 'Semifinales', 'Gran final'];
const MAXP = 10;         // máximo de jugadores por sala
const GOAL = 5;          // personajes que hay que conseguir (= número de rondas)
const MONEY = 50;        // dinero inicial
const MONEY_TEMA = 70;   // dinero inicial en el modo «amar tema»
const MONEY_XI = 100;    // dinero inicial en el modo «armar 11» (Blue Lock)
const MONEY_BEST = 100;  // dinero inicial en «armar el mejor»
const XI_SIZE = 11;      // jugadores del once
const MARKET_ROUND = 6;  // ronda en la que se abre el mercado (armar 11): intercambios con personajes y dinero entre subastas
const OPEN_MS = 25000;   // segundos para ofertar desde que el anfitrión abre las ofertas
const BID_MS = 8000;     // tiempo extra tras cada puja
const DELAY = [2, 3, 4]; // retraso máximo de la voz por dificultad (s)
const MAX_PLAYS = 2;     // veces que se puede oír la voz en cada subasta
// Temáticas del modo cast (se elige una al azar al empezar). Para añadir otra, copia un bloque.
const THEMES = [
  { name: 'NEW GEN BLUE LOCK', roles: ['LOKI', 'DON LORENZO', 'SAE ITOSHI', 'MICHAEL KAISER', 'HUGO VIVIEN', 'TEDDY KNIGHT', 'BUNNY IGLESIAS'] }
];
// Temáticas del modo «amar tema» (se elige una al azar al empezar)
const TEMA_THEMES = ['BLUE LOCK', 'JUJUTSU KAISEN', 'KIMETSU NO YAIBA', 'ANIME ROMCOM', 'CUALQUIER VIDEOJUEGO', 'MACRORAP LIBRE'];
// En «amar tema» los 3 puestos de PARTICIPANTE son libres: cada jugador escribe a mano qué personaje hace cada uno
// (respetar la temática queda en su mano) y lo que se subasta es el frikirapper de cada puesto.
const TEMA_CHAR_COUNT = 3;
const SLOT_FIXED_START = ['INSTRUMENTAL', 'MINIATURA', 'MIX Y MASTER', 'VIDEO', 'ESTRIBILLO CANTADO POR']; // orden de subasta (la 1.ª ronda es la especial de INSTRUMENTAL)
const SHEET_ORDER = ['MINIATURA', 'INSTRUMENTAL', 'MIX Y MASTER', 'VIDEO', 'ESTRIBILLO CANTADO POR']; // orden en que se muestra la ficha
const TEMA_TOTAL = SLOT_FIXED_START.length + TEMA_CHAR_COUNT;
function buildTema(name) {
  const chars = Array.from({ length: TEMA_CHAR_COUNT }, (_, i) => 'PARTICIPANTE ' + (i + 1));
  return { theme: { name, slots: [...SHEET_ORDER, ...chars], charSlots: chars }, order: [...SLOT_FIXED_START, ...chars] };
}
// Modo «armar 11» (Blue Lock): puestos de cada formación (cada jugador elige la suya)
const FORMS = {
  '433': ['POR', 'D1', 'D2', 'D3', 'D4', 'M1', 'M2', 'M3', 'F1', 'F2', 'F3'],
  '442': ['POR', 'D1', 'D2', 'D3', 'D4', 'M1', 'M2', 'M3', 'M4', 'F1', 'F2']
};
// Modo «armar el mejor»: categorías que se llenan con los personajes que salgan (una lista por modo de personajes)
const BEST_PICK = 8; // cada partida de «armar el mejor» usa 8 categorías al azar de la lista del modo
const BEST = {
  f: ['Visitas', 'Punchline', 'Respuestas', 'Puesta en escena', 'Flow', 'Skills', 'Autenticidad', 'Perfil', 'Ingenio', 'Prime', 'Proyeccion', 'Consolidacion', 'Titulos', 'Coherencia'],
  k: ['Contenido (Variedad)', 'Manejo vocal', 'Agudos', 'Graves', 'Interpretacion', 'Potencia', 'Flow', 'Escritura', 'Comunidad', 'Experiencia', 'Proyeccion', 'Contactos', 'Estilo', 'Contenido y variedad', 'Gestion de apartado tecnico'],
  b: ['Control', 'Tiro', 'Lectura de campo', 'Regate', 'Estado De Flow', 'Pase', 'Defensa', 'Velocidad', 'Equipo profesional', 'Estilo de juego', 'Liderazgo']
};
const CHAT_MAX = 50;      // mensajes del chat que se guardan por sala
const CHAT_LEN = 200;     // longitud máxima de un mensaje
const CHAT_GAP = 600;     // ms mínimos entre mensajes del mismo jugador (anti-spam)
const ROULETTE_MS = 4500; // duración de la ruleta en caso de empate

const rooms = {};
const bySock = {};
let pidSeq = 0;

const clamp = (n, a, b) => Math.max(a, Math.min(b, n));
const spoken = n => n.replace(/\(.*?\)/g, '').replace(/[\u{1F1E6}-\u{1F1FF}]/gu, '').replace('$', '').replace(/\./g, ' ').trim();
const key = n => spoken(n).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]/g, '');
const dedupe = arr => { const seen = new Set(); return arr.filter(n => { const k = key(n); if (!k || seen.has(k)) return false; seen.add(k); return true; }); };
// Personajes del modo Blue Lock (van aquí para que server.js funcione aunque names.js sea una versión antigua)
const BLUE_NAMES = [
  'Ryosuke Kira',
  'Asahi Naruhaya',
  'Gin Gagamaru',
  'Gurimu Igarashi',
  'Hyoma Chigiri',
  'Jingo Raichi',
  'Meguru Bachira',
  'Okuhito Lemon',
  'Rensuke Kunigami',
  'Wataru Kuon',
  'Yoichi Isagi',
  'Yuudai Imamura',
  'Ikki Nikko',
  'Hibiki Ookawa',
  'Shouei Barou',
  'Keisuke Wanima',
  'Junichi Wanima',
  'Zantetsu Tsurugi',
  'Reo Mikage',
  'Seishiro Nagi',
  'Aoshi Tokimitsu',
  'Eita Otoya',
  'Hajime Nishioka',
  'Jin Kiyora',
  'Jyubei Aryu',
  'Kenyu Yukimiya',
  'Nijiro Nanase',
  'Ranze Kurona',
  'Reiji Hiiragi',
  'Itoshi Rin',
  'Ryusei Shidou',
  'Tabito Karasu',
  'Yo Hiori',
  'Adam Blake',
  'Dada Silva',
  'Julian Loki',
  'Leonardo Luna',
  'Pablo Cavasoz',
  'Gen Fukaku',
  'Kazuma Niou',
  'Miroku Darai',
  'Itoshi Sae',
  'Shuuto Sendou',
  'Oliver Aiku',
  'Teppei Neru',
  'Alexis Ness',
  'Michael Kaiser',
  'Noel Noa',
  'Lavinho',
  'Chris Prince',
  'Agi',
  'Marc Snuffy',
  'Don Lorenzo',
  'Charles Chevalier',
  'Onazi',
  'Kuso',
  'Bello',
  'Oboabona',
  'Vivian Hugo',
  'Camus',
  'Leyden',
  'Teddy Knight',
  'Lookhart',
  'Bunny Iglesias'
];
// Freestylers «élite» (alternativa a los de TWB: al empezar una partida de Freestylers una ruleta decide cuál de las dos bolsas se usa)
// El país de cada freestyler va como bandera junto al nombre (la lista original usa el código entre paréntesis)
const CC_FLAG = { ARG: 'AR', MEX: 'MX', GU: 'GT' }; // etiquetas que no son el código ISO del país
const flagOf = c => String.fromCodePoint(...[...(CC_FLAG[c] || c)].map(ch => 0x1F1E6 + ch.charCodeAt(0) - 65));
const flagify = n => n.replace(/\s*(\([A-Z]+\)\s*)+$/, m => ' ' + (m.match(/\(([A-Z]+)\)/g) || []).map(x => flagOf(x.slice(1, -1))).join(''));
const ELITE_RAW = [
  'GAZIR (ES)',
  'CHUTY (ES)',
  'DOZER (AR)',
  'MECHA (AR)',
  'SOPHIA (AR)',
  'MOTOSIERRA (PE)',
  'SARA SOCAS (ES)',
  'SKONE (ES)',
  'JONY BELTRAN (MEX)',
  'BARON (ES)',
  'NEKROOS (PE)',
  'ACZINO (MX)',
  'CTZ (ARG)',
  'BNET (ES)',
  'SATIM (CL)',
  'JOQERR (CL)',
  'HRD (ARG)',
  'KLAN (ARG)',
  'STUART (ARG)',
  'KUSA (ARG)',
  'BLON (ES)',
  'DTOKE (AR)',
  'SHECKA (AR)',
  'SWEETPAIN (ES)',
  'NAVAS (ES)',
  'EL MENOR (CL)',
  'DANI (AR)',
  'METALINGUISTICA (CL)',
  'COLOSO (CO)',
  'FORCE (ES)',
  'VALLES T (CO)',
  'ABEL (AR)',
  'CACHA (AR)',
  'PAPO (AR)',
  'REPLIK (AR)',
  'PIEZAS (ES)',
  'BELICO (ES)',
  'LIT KILLAH (AR)',
  'TRUENO (AR)',
  'G SONY (AR)',
  'LOKILLO (CO)',
  'ACRU (AR)',
  'LOBO LOPEZ (MX)',
  'RC (MX)',
  'FAT N (CO)',
  'EXODO LIRICAL (DO)',
  'TEOREMA (CL)',
  'GHETTO (GU)',
  'JAZE (PE)',
  'STRIKE (PE)',
  'NECIA (PE)',
  'SUMERIA (PE)',
  'NITRO (CL)',
  'FUSOK (CL)',
  'NOCRE (ES)',
  'KMBRA (ES)',
  'KAISER (CL)',
  'ZTICMA (MX)',
  'EXE (AR)',
  'RIFE (AR)',
  'J1 (CO)',
  'KIAN (PE)',
  'MARITHEA (CO)',
  'AZUKY (MX)',
  'SUB (AR)',
  'LIT IGNIS (CO) (VE)',
  'HORUS (CO)',
  'JOTA (PE)',
  'ALMENDRADES (PE)',
  'FAT TONY (MX)',
  'GOTTI (AR)',
  'PANDORA (CO)',
  'LARRIX (AR)',
  'DALIA C (MX) (ES)',
  'KG (PE)',
  'DIMA (CO)',
  'WOS (AR)',
  'KODIGO (AR)',
  '1TOBY (AR)',
  'DYSE (AR)',
  'NOTA ROJA (MX)',
  'LOBO ESTEPARIO (MX)',
  'DYBBUK (AR)',
  'FACU HDR (AR)',
  'MR EGO (ES)',
  'BABI (ES)',
  'INVERT (ES)',
  'WOLF (AR)',
  'ARMAMENTE (BO)',
  'CHANG (VE)',
  'LETRA (VE)',
  'LANCER LIRICAL (VE)',
  'NAICEN (UY)',
  'SPEKTRO (UY)',
  'HAMMER (UY)',
  'URKO (CO)',
  'VISIONARIO (CO)',
  'PUPPY (CO)',
  'AIRON (CO)',
  'VIJAY (PE)',
  'YENKY ONE (DO)',
  'REVERSE (CU)',
  'FILOSOFO (CO)',
  'ELEMECE (CL)',
  'ZAKI (SV)',
  '99 (CL)',
  'BASEK (CL)',
  'DROSE (CL)',
  'EL BARTO (CL)',
  'NASHO (CL)',
  'RODAMIENTO (CL)',
  'STIGMA (CL)',
  'INDICO (PA)',
  'ALDAHIR (PA)',
  'NASIR CATRIEL (AR)',
  'NAISTA (AR)',
  'COBE (AR)',
  'RITTER (AR)',
  'RAPDER (MX)',
  'XHAVEZ (MX)',
  'ARTIL (MX)',
  'IBAN (ES)',
  'ARKANO (ES)',
  'RAMSTER (PE)',
  'CAFU (PE)',
  'PIERO PISTAS (PE)',
  'VENTI (PE)',
  'JC SNAKE (PE)',
  'LETRAS TARAPOTO (PE)',
  'ICON (PE)',
  'MSL (PE)',
  'KATACRIST (PE)',
  'BLAXO (PE)',
  'XPLAIN (PE)',
  'ZASKO (ES)',
  'CHYSTE MC (CL)',
  'JALONER (ES)',
  'DANI VK (ES)',
  'DESTELLO (CL)',
  'BTI (CL)',
  'ADESONG (CL)',
  'ANUBIS (CL)',
  'STICK (PE)',
  'FABIUKI (ES)',
  'JESSE PUNGAZ (AR)',
  'MCKLOPEDIA (VE)',
  'NACHO (AR)',
  'ERRECE (ES)',
  'KHAN (ES)',
  'TIRPA (ES)',
  'MKS (AR)',
  'JACK ADRENALINA (MX)',
  'ZAINA (AR)',
  'DUKI (AR)',
  'POTENCIA (MX)',
  'YOIKER (MX)',
  'WALLS (ES)',
  'MNAK (ES)',
  'TATA (AR)',
  'DOMINIC (MX)',
  'BTA (ES)',
  'SKIPER (MX)',
  'GHOST (PE)'
];
const ELITE_NAMES = ELITE_RAW.map(flagify);
const POOL = { e: dedupe(ELITE_NAMES), f: dedupe(NAMES.f.map(flagify)), // los de TWB también llevan su país entre paréntesis en names.js: se muestra como bandera
   k: dedupe(NAMES.k), b: dedupe(BLUE_NAMES) };
// Listas del modo «amar tema» (van aquí para que server.js funcione aunque names.js sea una versión antigua)
const INSTR_NAMES = ['Kenn', 'Kenkisaurio', 'IsurMX', 'Alaxtor', 'Keyto', 'Dokkyzach', 'Proii', 'Akinno', 'Byaki', 'Natzhu', 'Elevenn'];
const VIDEO_EXTRA = ['Kaneki', 'Puntotoni', 'Sz', 'Leg4', 'Aztra', 'Corekar', 'Darkz', 'Burrito', 'Fabz', 'Yenova', 'Billzo', 'TakionRL'];
const TEMA_INSTR = dedupe(INSTR_NAMES);
const TEMA_VIDEO = dedupe([...POOL.k, ...VIDEO_EXTRA]); // cualquier artista + los agregados
const moneyOf = r => r.gm === 'tema' ? MONEY_TEMA : r.gm === 'xi' ? MONEY_XI : r.gm === 'best' ? MONEY_BEST : MONEY;
// Bolsa de nombres de la subasta actual (en «amar tema» depende del puesto)
const fPool = r => r.fset === 'elite' ? POOL.e : POOL.f; // bolsa de Freestylers de esta partida (TWB o élite)
const poolOf = r => r.mode === 'f' ? fPool(r) : POOL[r.mode];
// Kodigo puede estar en cualquier liga menos en la argentina
const noKodigo = (lg, n) => lg.name === 'FMS Argentina' && key(n) === 'kodigo';
// Élite: cada liga solo recibe freestylers de su país (según el país entre paréntesis del nombre); Caribe: cualquiera
const LEAGUE_CC = { 'FMS España': 'ES', 'FMS Argentina': 'AR', 'FMS México': 'MX', 'FMS Chile': 'CL', 'FMS Perú': 'PE', 'FMS Colombia': 'CO', 'FMS Caribe': null };
const tagsOf = n => (String(n).match(/[\u{1F1E6}-\u{1F1FF}]{2}/gu) || []).map(f => [...f].map(ch => String.fromCharCode(ch.codePointAt(0) - 0x1F1E6 + 65)).join('')); // países (códigos ISO) a partir de las banderas del nombre
const eligLg = (r, lgName, n) => { if (r.fset !== 'elite') return true; const cc = LEAGUE_CC[lgName]; return !cc || tagsOf(n).includes(cc); };
const poolFor = r => {
  if (r.gm === 'tema') {
    if (r.curSlot === 'INSTRUMENTAL') return TEMA_INSTR;
    if (r.curSlot === 'VIDEO') return TEMA_VIDEO;
    return POOL.k;
  }
  return poolOf(r);
};
// Puestos donde cada jugador puede colocar a sus personajes (según el modo de partida)
const rolesOf = (r, p) => r.gm === 'xi' ? FORMS[p.form || '433']
  : r.gm === 'versus' ? p.rivals
  : (r.gm === 'tema' && r.theme) ? r.theme.slots
  : ((r.gm === 'cast' || r.gm === 'best') && r.theme) ? r.theme.roles : null;
const specialOf = slot => (slot === 'INSTRUMENTAL' || slot === 'VIDEO') ? '⭐ Ronda especial' : null;
const freeLeft = r => poolFor(r).filter(n => !r.used.has(key(n)));
const find = (r, id) => r.players.find(p => p.id === id);
// ¿se puede intercambiar ahora? Siempre en la fase final; en «armar 11» también entre subastas desde la ronda del mercado
const marketOpen = r => r.phase === 'trade' || (r.gm === 'xi' && r.market && ['idle', 'sold'].includes(r.phase));
const minCount = r => Math.min(...r.players.map(p => p.roster.length));
const duel = r => r.players.length === 2; // 1 vs 1: no hay rondas, puja cualquiera que aún no tenga el cupo completo
const roundIdx = r => duel(r) ? Math.min(Math.floor((r.sales || 0) / 2), 99) : minCount(r); // «ronda» para elegir el puesto en «amar tema»
const rdOf = r => Math.floor((r.sales || 0) / Math.max(1, r.players.length)) + 1; // ronda según subastas hechas (para el mercado)
const goalOf = r => r.gm === 'xi' ? XI_SIZE : r.gm === 'tema' ? TEMA_TOTAL : ((r.gm === 'cast' || r.gm === 'best') && r.theme) ? r.theme.roles.length : GOAL; // personajes por jugador
const allDone = r => duel(r) ? r.players.every(p => p.roster.length >= goalOf(r)) : minCount(r) >= goalOf(r);
const eligible = r => {
  if (duel(r)) return r.players.filter(p => p.roster.length < goalOf(r)); // da igual que uno tenga 3 y el rival 0
  const m = minCount(r); return m >= goalOf(r) ? [] : r.players.filter(p => p.roster.length === m);
};

function newCode() {
  const A = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  let c;
  do { c = Array.from({ length: 4 }, () => A[Math.floor(Math.random() * A.length)]).join(''); } while (rooms[c]);
  return c;
}

// Puesto que se está subastando (o el siguiente, si aún no se lanzó)
function temaSlot(r) {
  if (r.gm !== 'tema' || !r.order || r.phase === 'lobby') return null;
  return ['auction', 'roulette', 'sold'].includes(r.phase) ? r.curSlot : (r.order[Math.min(roundIdx(r), r.order.length - 1)] || null);
}
function view(r) {
  const el = eligible(r);
  return {
    code: r.code, hostId: r.hostId, phase: r.phase, mode: r.mode, dif: r.dif, vol: r.vol, vv: r.vv,
    gm: r.gm, theme: r.theme, goal: goalOf(r), forms: r.gm === 'xi' ? FORMS : null, market: !!r.market, marketRound: MARKET_ROUND,
    slot: temaSlot(r), special: specialOf(temaSlot(r)), round: duel(r) ? null : allDone(r) ? goalOf(r) : minCount(r) + 1, duel: duel(r), sales: r.sales || 0, mktAt: (MARKET_ROUND - 1) * r.players.length,
    bid: r.bid, bidder: r.bidder,
    ms: r.phase === 'roulette' ? Math.max(0, r.endsAt - Date.now()) : (r.phase === 'auction' && r.bidsOpen ? (r.paused ? r.pausedLeft : Math.max(0, r.endsAt - Date.now())) : 0),
    paused: !!r.paused, bidsOpen: !!r.bidsOpen, plays: r.plays || 0, maxPlays: MAX_PLAYS, openMs: OPEN_MS,
    auc: r.auc,
    sealed: r.auc === 'blind' && r.phase === 'auction' ? Object.keys(r.sealed) : [],
    reveal: r.phase === 'roulette' ? r.reveal : null,
    last: r.last,
    players: r.players.map(p => ({ id: p.id, name: p.name, money: p.money, roster: p.roster, cast: p.cast, chars: p.chars, tname: p.tname, rivals: p.rivals, form: p.form, on: p.on, bot: !!p.bot, eligible: el.includes(p) })),
    offers: r.offers, career: isCareer(r), fset: r.fset || null, fsetId: r.fsetId || 0, jury: r.jury || 3, sim: r.gm === 'sim' && r.sim ? simView(r) : null,
    voted: r.phase === 'vote' ? Object.keys(r.votes) : [],
    results: r.results
  };
}
function push(r) { io.to(r.code).emit('state', view(r)); }

function pickName(r) {
  let pool = freeLeft(r);
  if (!pool.length) { if (r.gm !== 'tema') r.used.clear(); pool = poolFor(r); } // solo si se agotaron todos
  const n = pool[Math.floor(Math.random() * pool.length)];
  r.used.add(key(n));
  return n;
}

function sell(r, p, price, how) {
  clearTimeout(r.timer);
  r.players.forEach(b => { clearTimeout(b.bt); b.bt = null; });
  r.paused = false; r.bidsOpen = false;
  p.money -= price;
  if (r.gm === 'tema' && r.curSlot && !p.cast[r.curSlot]) p.cast[r.curSlot] = r.cur; // se coloca solo en el puesto de la ronda si está libre; luego el jugador puede moverlo
  if (r.gm === 'versus') { const f = p.rivals.find(x => !p.cast[x]); if (f) p.cast[f] = r.cur; } // va al primer rival libre; luego el jugador puede moverlo
  p.roster.push(r.cur);
  r.sales = (r.sales || 0) + 1;
  if (r.gm === 'xi' && rdOf(r) === MARKET_ROUND) r.market = true; // el mercado se abre al empezar la ronda 6 y dura solo esa ronda
  r.last = { name: r.cur, winner: p.id, price, how, bids: r.reveal ? r.reveal.bids : null, tie: r.reveal ? r.reveal.tie : null };
  r.phase = 'sold';
  push(r);
}

function closeBlind(r) {
  if (r.phase !== 'auction') return;
  clearTimeout(r.timer);
  const ids = Object.keys(r.sealed);
  const max = Math.max(...ids.map(i => r.sealed[i]));
  const top = ids.filter(i => r.sealed[i] === max);
  r.reveal = { bids: { ...r.sealed }, tie: top.length > 1 ? top : null };
  if (top.length > 1) { // empate: ruleta entre los empatados
    const winner = top[Math.floor(Math.random() * top.length)];
    r.phase = 'roulette';
    r.endsAt = Date.now() + ROULETTE_MS;
    push(r);
    r.timer = setTimeout(() => sell(r, find(r, winner), max, 'blind'), ROULETTE_MS);
  } else {
    sell(r, find(r, top[0]), max, 'blind');
  }
}

function close(r) {
  if (r.phase !== 'auction') return;
  if (r.auc === 'blind' && Object.keys(r.sealed).length) return closeBlind(r);
  if (r.bidder) return sell(r, find(r, r.bidder), r.bid, 'bid');
  // nadie pujó: se lo lleva gratis un jugador elegible al azar
  const el = eligible(r);
  const on = el.filter(p => p.on);
  const pool = on.length ? on : el;
  sell(r, pool[Math.floor(Math.random() * pool.length)], 0, 'free');
}

function startAuction(r) {
  if (r.market && rdOf(r) > MARKET_ROUND) { r.market = false; r.offers = []; } // terminó la ronda del mercado
  const el = eligible(r);
  r.curSlot = r.gm === 'tema' && r.order ? r.order[Math.min(roundIdx(r), r.order.length - 1)] : null;
  r.cur = pickName(r);
  r.bid = 0; r.bidder = null; r.last = null;
  r.sealed = {}; r.reveal = null;
  botPlan(r);
  if (el.length === 1) { // el último de la ronda: compra directa a 1$
    return sell(r, el[0], Math.min(1, el[0].money), 'solo');
  }
  r.phase = 'auction';
  // las ofertas NO se abren solas: las abre el anfitrión (s.on('openBids'))
  r.bidsOpen = false; r.paused = false; r.plays = 1; r.endsAt = 0;
  clearTimeout(r.timer);
  r.lastPitch = 0.85 + Math.random() * 0.3;
  io.to(r.code).emit('play', {
    text: spoken(r.cur),
    pitch: r.lastPitch,
    delay: 1200 + Math.random() * DELAY[r.dif] * 1000,
    rep: false
  });
  r.lastAudioText = spoken(r.cur);
  push(r);
}

function autofill(r) { // los personajes sin puesto se colocan solos en los puestos vacíos
  r.players.forEach(p => {
    const roles = rolesOf(r, p); if (!roles) return;
    const free = p.roster.filter(n => !Object.values(p.cast).includes(n));
    roles.forEach(role => { if (!p.cast[role] && free.length) p.cast[role] = free.shift(); });
  });
}

function finishVote(r) {
  const tally = {};
  r.players.forEach(p => tally[p.id] = 0);
  // cada voto es un ranking de peor a mejor: el peor suma 1 punto, el siguiente 2, etc.
  Object.values(r.votes).forEach(rk => rk.forEach((id, i) => { if (tally[id] !== undefined) tally[id] += i + 1; }));
  const max = Math.max(...Object.values(tally));
  r.results = { tally, winners: max > 0 ? r.players.filter(p => tally[p.id] === max).map(p => p.id) : [] };
  r.phase = 'end';
  push(r);
}

// ---- Pujas (jugadores y bots) ----
function doBid(r, p, n) {
  if (r.phase !== 'auction' || !r.bidsOpen || r.paused) return;
  n = Math.floor(+n);
  if (r.auc === 'blind') { // oferta secreta: una sola vez, sin cambios
    if (!(n >= 0) || n > p.money || !eligible(r).includes(p) || p.id in r.sealed) return;
    r.sealed[p.id] = n;
    if (eligible(r).filter(q => q.on).every(q => q.id in r.sealed)) return closeBlind(r);
    return push(r);
  }
  if (!(n > r.bid) || n > p.money || !eligible(r).includes(p) || r.bidder === p.id) return;
  r.bid = n; r.bidder = p.id;
  const left = Math.max(BID_MS, r.endsAt - Date.now());
  r.endsAt = Date.now() + left;
  clearTimeout(r.timer);
  r.timer = setTimeout(() => close(r), left);
  push(r);
  botTick(r);
}

// ---- Bots (para jugar solo o completar una sala) ----
const BOT_NAMES = ['Kuro', 'Nami', 'Rex', 'Luna', 'Toru', 'Mika', 'Zed', 'Kira', 'Dante', 'Yuki'];
const rnd = (a, b) => a + Math.random() * (b - a);
function botPlan(r) { // al empezar cada subasta cada bot decide lo máximo que pagaría
  r.players.forEach(b => {
    if (!b.bot) return;
    clearTimeout(b.bt); b.bt = null;
    const need = Math.max(1, goalOf(r) - b.roster.length);
    const fair = (b.money - (need - 1)) / need; // deja al menos 1$ por cada personaje que le falta
    b.max = Math.max(0, Math.min(b.money, Math.floor(fair * rnd(0.5, 2.2))));
  });
}
function botTick(r) {
  if (r.phase !== 'auction' || !r.bidsOpen || r.paused) return;
  const el = eligible(r);
  r.players.forEach(b => {
    if (!b.bot || b.bt || !el.includes(b)) return;
    if (r.auc === 'blind') {
      if (b.id in r.sealed) return;
      b.bt = setTimeout(() => { b.bt = null; botBlind(r, b); }, rnd(1500, 9000));
    } else {
      if (r.bidder === b.id || r.bid >= Math.min(b.max, b.money)) return;
      b.bt = setTimeout(() => { b.bt = null; botBid(r, b); }, rnd(900, 3500));
    }
  });
}
function botBid(r, b) {
  if (r.phase !== 'auction' || !r.bidsOpen || r.paused || r.auc === 'blind' || r.bidder === b.id) return;
  const cap = Math.min(b.max, b.money);
  if (r.bid >= cap) return;
  doBid(r, b, Math.min(cap, r.bid + 1 + Math.floor(Math.random() * 3)));
}
function botBlind(r, b) {
  if (r.phase !== 'auction' || !r.bidsOpen || r.paused || r.auc !== 'blind' || b.id in r.sealed) return;
  doBid(r, b, Math.floor(rnd(0, Math.min(b.max, b.money) + 1)));
}
function botVotes(r) {
  r.players.forEach(b => {
    if (!b.bot) return;
    setTimeout(() => {
      if (r.phase !== 'vote' || b.id in r.votes || !find(r, b.id)) return;
      r.votes[b.id] = r.players.filter(q => q.id !== b.id).map(q => q.id).sort(() => Math.random() - 0.5);
      if (r.players.filter(q => q.on).every(q => r.votes[q.id])) return finishVote(r);
      push(r);
    }, rnd(1500, 5000));
  });
}
function botReply(r, o) { // un bot responde a una oferta que le hacen (acepta una parte de las veces)
  const b = find(r, o.to); if (!b || !b.bot) return;
  setTimeout(() => {
    if (!marketOpen(r) || !r.offers.includes(o)) return;
    respondOffer(r, b, o.id, Math.random() < (0.25 + (o.cash && o.cdir === 'pay' ? 0.25 : 0)));
  }, rnd(1500, 4000));
}

// ---- Intercambios: responder (jugadores y bots) ----
function respondOffer(r, p, id, ok) {
  if (!marketOpen(r)) return;
  const o = r.offers.find(x => x.id === id); if (!o) return;
  if (o.from === p.id && !ok) { r.offers = r.offers.filter(x => x !== o); return push(r); } // cancelar
  if (o.to !== p.id) return;
  r.offers = r.offers.filter(x => x !== o);
  if (ok) {
    const a = find(r, o.from), b = p;
    const cash = o.cash || 0;
    const payer = o.cdir === 'pay' ? a : b, getter = payer === a ? b : a;
    const valid = a && (!o.give || a.roster.includes(o.give)) && (!o.want || b.roster.includes(o.want)) && (!cash || payer.money >= cash);
    if (valid) {
      if (o.give && o.want) {
        a.roster[a.roster.indexOf(o.give)] = o.want;
        b.roster[b.roster.indexOf(o.want)] = o.give;
        for (const k of Object.keys(a.cast)) if (a.cast[k] === o.give) a.cast[k] = o.want;
        for (const k of Object.keys(b.cast)) if (b.cast[k] === o.want) b.cast[k] = o.give;
      } else if (o.give) { // vende un personaje por dinero
        a.roster.splice(a.roster.indexOf(o.give), 1); b.roster.push(o.give);
        for (const k of Object.keys(a.cast)) if (a.cast[k] === o.give) delete a.cast[k];
      } else if (o.want) { // compra un personaje con dinero
        b.roster.splice(b.roster.indexOf(o.want), 1); a.roster.push(o.want);
        for (const k of Object.keys(b.cast)) if (b.cast[k] === o.want) delete b.cast[k];
      }
      if (cash) { payer.money -= cash; getter.money += cash; }
      r.offers = r.offers.filter(x => ![x.give, x.want].some(n => n && (n === o.give || n === o.want)));
    }
  }
  push(r);
}

// ================= SIMULACIONES (ligas FMS) =================
// Cada jugador recibe una liga y 8 freestylers que son los participantes de esa liga (todos contra todos, 7 jornadas de 4 batallas).
// Un jurado de jugadores vota cada batalla (A, B o réplica). Victoria directa 3 pts; tras réplica 2 pts y el perdedor 1 pt.
// Con 4 jugadores se añade la FMS INTERNACIONAL (como en 2019):
//   · Tras la jornada SIM_CUT_J de todas las ligas: PRIMER CORTE. Los 4 primeros de cada liga se cruzan con los de otra liga
//     (1.º vs 4.º de otra liga, 2.º vs 3.º de otra liga = 8 batallas). Los 8 ganadores clasifican a la Gran Final.
//   · Al acabar las ligas: SEGUNDO CORTE con los 4 mejores de cada tabla que aún NO estén clasificados (mismos cruces). Otros 8 billetes.
//   · GRAN FINAL: los 16 clasificados en eliminatorias (octavos, cuartos, semis y final). El campeón gana mucho caché.
//   · Gana la partida el jugador cuyo freestyler tenga más caché al final.
//   · Con MÁS de 4 jugadores: tras la jornada SIM_CUT_J todos los jugadores VOTAN las 4 mejores ligas, y solo esas 4 van a la inter.
//   · Desde 5 JUGADORES (formato FMS Internacional 2021): al acabar las ligas, los 5 primeros de cada una (5 ligas) se reparten en los grupos A-E
//     (cada grupo: un freestyler de cada liga, y un 1.º, 2.º, 3.º, 4.º y 5.º) y los 6.º forman el grupo Reservas. Cada grupo se juega entero
//     (todos contra todos, 5 jornadas de 2 batallas) antes de pasar al siguiente. Clasifican los 3 primeros de cada grupo y el 1.º de Reservas (16).
//     Con más de 5 jugadores se votan las 5 mejores ligas. Con 4 jugadores sigue el formato de cortes (2019).
//   · DRAFT: tras el sorteo, por turnos (serpiente) cada jugador puede intercambiar un freestyler suyo por uno de otra liga (los dos quedan bloqueados).
//   · EVENTOS: al acabar cada jornada (1 a 6) hay un 50% de que le pase uno a un jugador al azar: baja de un competidor, batalla viral, polémica o pique con otra liga.
const simShuffle = a => a.map(x => [Math.random(), x]).sort((u, v) => u[0] - v[0]).map(x => x[1]);
const isCareer = r => r.gm === 'sim' && !!r.career; // Modo Carrera: solo existe dentro de Simulaciones
const maxPlayers = r => r.gm === 'sim' ? (isCareer(r) ? CAREER_MAX_PLAYERS : SIM_MAX) : MAXP;
const simSolo = (r, S) => !!(S && S.career && r.players.length === 1); // carrera en solitario: eres el único jurado
function simSyncRoster(r, pid) { // la plantilla de un jugador son los freestylers de todas las ligas que lleva
  const S = r.sim, p = find(r, pid); if (p && S) p.roster = S.leagues.filter(l => l.ownerId === pid).flatMap(l => l.teams);
}
function simFixture(teams) { // método del círculo: 8 participantes -> 7 jornadas, todos contra todos una sola vez
  const t = simShuffle(teams), n = t.length, rounds = [];
  for (let j = 0; j < n - 1; j++) {
    const m = [];
    for (let i = 0; i < n / 2; i++) m.push(simShuffle([t[i], t[n - 1 - i]]));
    rounds.push(simShuffle(m));
    t.splice(1, 0, t.pop());
  }
  return rounds;
}
// Formato de jornada: normal = 7 jornadas de 4 batallas; doble = 4 jornadas de 8, 4, 8 y 8 batallas (cada freestyler pelea 2 veces por jornada, salvo en la 2, que pelea 1)
const simSched = dbl => dbl ? [[0, 1], [2], [3, 4], [5, 6]] : [0, 1, 2, 3, 4, 5, 6].map(k => [k]); // rondas del round-robin que se juegan en cada jornada
const simJBattles = (S, lg) => S.sched[S.j - 1].flatMap(k => lg.fix[k]);
function simFmtAuto(r) { // se resuelve cuando han votado todos los jugadores humanos conectados
  const S = r.sim; if (!S || S.step !== 'fmt') return;
  const F = S.fmt;
  if (r.players.filter(p => !p.bot && p.on).every(p => F.votes[p.id])) {
    const v = Object.values(F.votes), d = v.filter(x => x === 'dbl').length, nr = v.length - d;
    S.dbl = d === nr ? Math.random() < 0.5 : d > nr; // gana la mayoría; empate al azar
    S.jn = S.dbl ? 4 : SIM_TEAM - 1; S.cutJ = S.dbl ? SIM_CUT_J_DBL : SIM_CUT_J; S.sched = simSched(S.dbl);
    if (S.lp) { S.step = 'lpick'; return simLpAuto(r); }
    S.step = 'draw';
  }
  push(r);
}
function simFixKodigo(r) { // Kodigo no puede tocar la liga argentina: se cambia por un freestyler de otra liga (o por uno libre si es la única)
  const leagues = r.sim.leagues;
  const arg = leagues.find(l => l.name === 'FMS Argentina'), kd = arg && arg.teams.find(t => key(t) === 'kodigo');
  if (!kd) return;
  const other = leagues.find(l => l !== arg);
  const swap = other ? simShuffle(other.teams)[0] : simShuffle(fPool(r)).find(x => !leagues.some(l => l.teams.includes(x)) && key(x) !== 'kodigo');
  if (!swap) return;
  const mv = (lg, a, b) => { lg.teams[lg.teams.indexOf(a)] = b; lg.cache[b] = lg.cache[a]; lg.st[b] = lg.st[a]; delete lg.cache[a]; delete lg.st[a]; lg.fix = lg.fix.map(rd => rd.map(pr => pr.map(n => n === a ? b : n))); };
  mv(arg, kd, swap);
  if (other) mv(other, swap, kd);
  leagues.forEach(l => simSyncRoster(r, l.ownerId));
}
function simIntlInit(n, leagues) { // estado de la FMS Internacional según el número de jugadores (se reinicia en la temporada 2)
  if (n === 2 && leagues.length === 2) return { q: [], champ: null, grp: false, mini: true, nl: 2, lgs: [0, 1], vres: null }; // MINI INTER: con 2 ligas, los 4 primeros de cada una juegan unos cuartos de final
  return n >= SIM_INTL_PLAYERS ? { q: [], champ: null, grp: n >= SIM_GROUP_PLAYERS, nl: n >= SIM_GROUP_PLAYERS ? 5 : 4, lgs: n === SIM_INTL_PLAYERS || n === SIM_GROUP_PLAYERS ? leagues.map((_, i) => i) : null, vres: null } : null; // q = clasificados a la Gran Final {l: liga, n: freestyler, via}
}
function simMakeLeague(r, lname, owner, used) { // crea una liga con 8 freestylers que no estén en otra (élite: solo de ese país)
  const elite = r.fset === 'elite', all = fPool(r);
  const ok = x => !used.has(key(x)) && !noKodigo({ name: lname }, x) && (!elite || eligLg(r, lname, x));
  let teams = simShuffle(all).filter(ok).slice(0, SIM_TEAM);
  if (teams.length < SIM_TEAM) { const have = new Set(teams.map(key)); teams = [...teams, ...simShuffle(all).filter(x => !have.has(key(x)) && !noKodigo({ name: lname }, x) && (!elite || eligLg(r, lname, x)))].slice(0, SIM_TEAM); }
  teams.forEach(t => used.add(key(t)));
  const cache = {}, st = {};
  teams.forEach(t => { cache[t] = CACHE_START; st[t] = { pts: 0, w: 0, wr: 0, lr: 0, l: 0 }; });
  return { name: lname, ownerId: owner.id, ownerName: owner.name, teams, cache, st, fix: simFixture(teams) };
}
function simStart(r) {
  const n = r.players.length, elite = r.fset === 'elite', all = fPool(r);
  // Élite: a cada jugador le toca una liga (país) al azar. TWB: estos nombres son provisionales, luego cada jugador elige la suya.
  const names = simShuffle(SIM_LEAGUES).slice(0, n);
  const career = isCareer(r), used = new Set(), leagues = new Array(n);
  const idxs = r.players.map((_, i) => i).sort((a, b) => (LEAGUE_CC[names[a]] ? 0 : 1) - (LEAGUE_CC[names[b]] ? 0 : 1)); // primero las ligas con país, Caribe (cualquiera) al final
  if (career) { // Modo Carrera: la temporada 1 solo tiene la FMS España (la lleva el primer jugador; los demás son jurado)
    leagues.length = 0;
    CAREER_LEAGUES[0].forEach((nm, i) => leagues.push(simMakeLeague(r, nm, r.players[i % n], used)));
    r.players.forEach(p => { p.cast = {}; p.chars = {}; });
  } else idxs.forEach(i => {
    const p = r.players[i], lname = names[i];
    const ok = x => !used.has(key(x)) && (!elite || (eligLg(r, lname, x) && !noKodigo({ name: lname }, x)));
    let teams = simShuffle(all).filter(ok).slice(0, SIM_TEAM);
    if (teams.length < SIM_TEAM) { const have = new Set(teams.map(key)); teams = [...teams, ...simShuffle(all).filter(x => !have.has(key(x)) && (!elite || eligLg(r, lname, x)))].slice(0, SIM_TEAM); } // por si la bolsa se queda corta
    teams.forEach(t => used.add(key(t)));
    p.roster = teams.slice(); p.cast = {}; p.chars = {};
    const cache = {}, st = {};
    teams.forEach(t => { cache[t] = CACHE_START; st[t] = { pts: 0, w: 0, wr: 0, lr: 0, l: 0 }; });
    leagues[i] = { name: lname, ownerId: p.id, ownerName: p.name, teams, cache, st, fix: simFixture(teams) };
  });
  const spare = simShuffle(all).filter(x => !used.has(key(x))); // suplentes para las bajas
  r.sim = {
    id: Date.now(), gid: Date.now() + '-' + Math.floor(Math.random() * 1e6), jury: (!career && r.jury === 5 && n >= 6) ? 5 : 3, leagues, career, histAll: [],
    order: simShuffle(leagues.map((_, i) => i)), // orden (al azar) en que se juega cada jornada de cada liga
    stage: 'league', ko: -1, intl: career ? null : simIntlInit(n, leagues), grp: null, lvotes: {},
    j: 1, li: 0, b: 0, round: 1, step: 'fmt', fmt: { votes: {} }, dbl: false, jn: SIM_TEAM - 1, cutJ: SIM_CUT_J, sched: simSched(false), battles: [], jurors: [], votes: {}, last: null, needRep: false,
    mk: null, ev: null, evSeq: 0, dft: null, spare, season: 1, kp: null, ws: null, keep: [], hist: null,
    lp: (elite || career) ? null : { order: simShuffle(r.players.map(p => p.id)), idx: 0, picks: {} }
  };
  if (career) r.players.forEach(p => simSyncRoster(r, p.id));
  r.phase = 'sim';
  simFmtAuto(r);
}
// ---- TWB: cada jugador elige su liga (por turnos al azar) ----
function simLpPick(r, pid, name) { // name null = al azar
  const L = r.sim.lp, free = SIM_LEAGUES.filter(x => !Object.values(L.picks).includes(x));
  if (name == null) name = simShuffle(free)[0];
  if (!free.includes(name)) return false;
  L.picks[pid] = name; L.idx++;
  return true;
}
function simLpAuto(r) {
  const S = r.sim; if (!S || S.step !== 'lpick') return;
  const L = S.lp;
  while (L.idx < L.order.length) {
    const p = find(r, L.order[L.idx]);
    if (p && !p.bot && p.on) break;
    simLpPick(r, L.order[L.idx], null);
  }
  if (L.idx >= L.order.length) {
    S.leagues.forEach(lg => { lg.name = L.picks[lg.ownerId] || lg.name; });
    simFixKodigo(r);
    S.step = 'draw';
  }
  push(r);
}
function simMakeJury(r, exclude, auto) {
  if (simSolo(r, r.sim)) { const p = r.players[0]; return [{ k: 'p', id: p.id, name: p.name }]; } // carrera en solitario: tú eres el único jurado // 3 (o 5) jurados; los dueños de los freestylers que se enfrentan no votan; el último voto puede ser del favorito por caché. Los vetados por esos dueños no votan.
  const S = r.sim;
  const banned = (S.vetoes || []).filter(v => exclude.includes(v.owner)).map(v => v.target);
  const useC = auto && !banned.includes('c'), seats = S.jury - (useC ? 1 : 0);
  const others = simShuffle(r.players.filter(p => !exclude.includes(p.id) && !banned.includes(p.id)));
  const jurors = others.slice(0, seats).map(p => ({ k: 'p', id: p.id, name: p.name }));
  for (let i = jurors.length; i < seats; i++) jurors.push({ k: 'v', id: 'v' + i, name: 'Jurado invitado ' + (i - others.length + 1) });
  if (useC) jurors.push({ k: 'c', id: 'c', name: 'Favorito por caché' });
  return jurors;
}
const simCacheOf = (S, bt, side) => side === 'a' ? S.leagues[bt.la].cache[bt.a] : S.leagues[bt.lb].cache[bt.b];
function simBegin(r) { // empieza la jornada de una liga: se muestran las 4 batallas y se eligen los jurados
  const S = r.sim, li = S.order[S.li], lg = S.leagues[li];
  S.stage = 'league'; S.mk = null; S.step = 'intro'; S.b = 0; S.round = 1; S.votes = {}; S.last = null; S.needRep = false;
  S.battles = simJBattles(S, lg).map(([a, b]) => ({ a, b, la: li, lb: li, res: null, fav: null }));
  S.jurors = simMakeJury(r, [lg.ownerId], S.j >= 2); // desde la jornada 2 el último voto es del favorito por caché
  push(r);
}
function simAi(ca, cb, allowR) { // voto de un bot / jurado invitado / jugador desconectado
  const hi = ca === cb ? (Math.random() < 0.5 ? 'a' : 'b') : (ca > cb ? 'a' : 'b'), lo = hi === 'a' ? 'b' : 'a';
  if (allowR && Math.random() < 0.14) return 'r';
  return Math.random() < 0.62 ? hi : lo;
}
function simAutoVotes(r) {
  const S = r.sim; if (!S || S.step !== 'vote') return;
  const bt = S.battles[S.b], ca = simCacheOf(S, bt, 'a'), cb = simCacheOf(S, bt, 'b');
  if (!bt.fav) bt.fav = ca === cb ? (Math.random() < 0.5 ? 'a' : 'b') : (ca > cb ? 'a' : 'b');
  S.jurors.forEach((j, i) => {
    if (i in S.votes) return;
    if (j.k === 'c') S.votes[i] = bt.fav;
    else if (j.k === 'v') S.votes[i] = simAi(ca, cb, S.round === 1);
    else { const q = find(r, j.id); if (!q || q.bot || !q.on) S.votes[i] = simAi(ca, cb, S.round === 1); }
  });
}
function simOpenVote(r) {
  r.sim.step = 'vote'; r.sim.votes = {};
  simAutoVotes(r); simCheck(r);
}
function simStartBattle(r) { // primera ronda de una batalla (en la internacional cada batalla tiene su propio jurado, sin los dueños de los dos freestylers)
  const S = r.sim; S.round = 1;
  if (S.stage !== 'league') { const bt = S.battles[S.b]; S.jurors = simMakeJury(r, [S.leagues[bt.la].ownerId, S.leagues[bt.lb].ownerId], true); }
  simOpenVote(r);
}
function simCheck(r) {
  const S = r.sim; if (!S || S.step !== 'vote') return;
  if (S.jurors.every((_, i) => i in S.votes)) simTally(r); else push(r);
}
function simTally(r) {
  const S = r.sim, bt = S.battles[S.b];
  const cnt = { a: 0, b: 0, r: 0 };
  Object.values(S.votes).forEach(v => cnt[v]++);
  const need = Math.floor(S.jurors.length / 2) + 1;
  let w = null;
  if (S.round === 1) { if (cnt.a >= need) w = 'a'; else if (cnt.b >= need) w = 'b'; } // sin mayoría (o con réplicas) -> réplica
  else w = cnt.a > cnt.b ? 'a' : 'b';
  S.last = { round: S.round, cnt, votes: { ...S.votes } };
  S.needRep = !w;
  if (w) simApply(r, w);
  S.step = 'reveal';
  push(r);
}
const ELITE_RANK = new Map(POOL.e.map((n, i) => [key(n), i]));
function simFame(n) { // lo conocido que es un nombre: tabla manual (FAME_OVERRIDE) > puesto en la lista élite > valor bajo fijo por nombre; los artistas de música atraen más
  const k = key(n); let f;
  if (k in FAME_OVERRIDE) f = FAME_OVERRIDE[k];
  else if (ELITE_RANK.has(k)) f = 1.8 - 1.2 * ELITE_RANK.get(k) / Math.max(1, ELITE_RANK.size - 1);
  else { let h = 0; for (const ch of k) h = (h * 31 + ch.charCodeAt(0)) % 1000; f = 0.6 + 0.4 * h / 1000; }
  return MUSIC_ARTISTS.has(k) ? f * ARTIST_BONUS : f;
}
function simMult(S, li, n) { // multiplicadores de caché: streamer cubriendo la jornada de esa liga y freestyler dedicado a la música
  const lg = S.leagues[li]; let m = 1;
  if (S.stage === 'league' && !S.mk && lg.boost && lg.boost.j === S.j) m *= STREAMER_MULT;
  if ((lg.music || []).includes(n)) m *= MUSIC_MULT;
  return m;
}
function simVisits(cw, cl, W, L, mW, mL, stageMul) {
  const raw = VISIT_BASE * Math.min(6, Math.pow((cw + cl) / 2000, 0.6)) * ((simFame(W) + simFame(L)) / 2) * (0.6 + Math.random() * 0.8) * stageMul * ((mW + mL) / 2);
  const v = Math.max(1000, Math.round(raw / 1000) * 1000);
  const pool = Math.round(v / VISITS_PER_CACHE / 10) * 10;
  return { v, vw: Math.round(pool * VISIT_SPLIT_W / 10) * 10, vl: Math.round(pool * (1 - VISIT_SPLIT_W) / 10) * 10 };
}
function simApply(r, w) {
  const S = r.sim, bt = S.battles[S.b], isLg = S.stage === 'league', isPq = S.stage === 'pique', isGp = S.stage === 'grp', isWs = S.stage === 'ws';
  const W = w === 'a' ? bt.a : bt.b, lW = w === 'a' ? bt.la : bt.lb, L = w === 'a' ? bt.b : bt.a, lL = w === 'a' ? bt.lb : bt.la, rep = S.round === 2;
  const cw = S.leagues[lW].cache[W], cl = S.leagues[lL].cache[L];
  let gain = isPq ? (rep ? CACHE_PIQUE_REP : CACHE_PIQUE) : isLg ? (rep ? CACHE_WIN_REP : CACHE_WIN) : (rep ? CACHE_INTL_WIN_REP : CACHE_INTL_WIN);
  if (!isPq && cl > cw) gain += Math.round((cl - cw) * CACHE_UPSET / 10) * 10; // ganar a alguien con más caché paga más
  const mW = simMult(S, lW, W), mL = simMult(S, lL, L);
  gain = Math.round(gain * mW / 10) * 10;
  const vis = simVisits(cw, cl, W, L, mW, mL, isPq ? 1.5 : isLg ? 1 : 2.5); // en la internacional y en los piques las batallas se ven más
  const base = gain;
  gain += vis.vw;
  S.leagues[lW].cache[W] += gain; S.leagues[lL].cache[L] += vis.vl;
  [[lW, W], [lL, L]].forEach(([l, n]) => { const g = S.leagues[l]; g.views = g.views || {}; g.views[n] = (g.views[n] || 0) + vis.v; });
  if (isLg) { // los puntos de la tabla solo se mueven en la liga; la internacional solo mueve caché
    const sw = S.leagues[lW].st[W], sl = S.leagues[lL].st[L];
    if (rep) { sw.pts += 2; sw.wr++; sl.pts += 1; sl.lr++; } else { sw.pts += 3; sw.w++; sl.l++; }
  }
  if (isGp) { // fase de grupos: tabla propia del grupo (3 pts victoria, 2/1 tras réplica)
    const G = S.grp.groups[S.grp.g], sw = G.st[W], sl = G.st[L];
    if (rep) { sw.pts += 2; sw.wr++; sl.pts += 1; sl.lr++; } else { sw.pts += 3; sw.w++; sl.l++; }
  }
  if (isWs) { // World Series: tabla propia (3 pts victoria, 2/1 tras réplica); el caché sube en la liga de origen de cada freestyler
    const sw = S.ws.st[W], sl = S.ws.st[L];
    if (rep) { sw.pts += 2; sw.wr++; sl.pts += 1; sl.lr++; } else { sw.pts += 3; sw.w++; sl.l++; }
  }
  if ((S.stage === 'cut1' || S.stage === 'cut2') && !S.intl.q.some(x => x.l === lW && x.n === W)) S.intl.q.push({ l: lW, n: W, via: S.stage }); // el ganador de un corte clasifica
  bt.res = { w, rep, gain, base, visits: vis.v, vw: vis.vw, vl: vis.vl, lg: isLg || isGp || isWs, pw: (isLg || isGp || isWs) ? (rep ? 2 : 3) : 0, pl: (isLg || isGp || isWs) ? (rep ? 1 : 0) : 0, cnt: { ...S.last.cnt } };
}
function simMvp(r) { // MVP de la jornada: cualquiera de los 8 freestylers de la liga, al azar. Cobra caché.
  const S = r.sim, li = S.order[S.li], lg = S.leagues[li];
  const n = simShuffle(lg.teams)[0];
  lg.cache[n] += CACHE_MVP;
  (lg.mvps = lg.mvps || []).push({ j: S.j, n });
  S.mvp = { li, n, pay: CACHE_MVP };
}
function simTable(lg) {
  return lg.teams.map(t => ({ n: t, c: lg.cache[t], v: (lg.views || {})[t] || 0, ...lg.st[t] })).sort((a, b) => b.pts - a.pts || b.c - a.c || a.n.localeCompare(b.n));
}
// ---- FMS Internacional ----
// ---- Votación de las 4 (cortes) o 5 (grupos) mejores ligas: solo si hay más ligas que plazas ----
function simLeagueAuto(r) { // bots y jugadores desconectados votan solos: prefieren ligas con más caché, con algo de azar
  const S = r.sim;
  r.players.forEach(p => {
    if (p.id in S.lvotes) return;
    if (!p.bot && p.on) return;
    const sc = S.leagues.map((lg, l) => ({ l, s: lg.teams.reduce((a, t) => a + lg.cache[t], 0) * (0.7 + Math.random() * 0.6) }));
    S.lvotes[p.id] = sc.sort((a, b) => b.s - a.s).slice(0, S.intl.nl).map(x => x.l);
  });
}
function simLeagueBegin(r) {
  const S = r.sim; S.stage = 'lvote'; S.step = 'lvote'; S.lvotes = {};
  simLeagueAuto(r); simLeagueCheck(r);
}
function simLeagueCheck(r) {
  const S = r.sim; if (!S || S.step !== 'lvote') return;
  if (r.players.every(p => p.id in S.lvotes)) simLeagueTally(r); else push(r);
}
function simLeagueTally(r) {
  const S = r.sim, cnt = S.leagues.map(() => 0);
  Object.values(S.lvotes).forEach(v => v.forEach(l => { cnt[l]++; }));
  const tot = S.leagues.map(lg => lg.teams.reduce((a, t) => a + lg.cache[t], 0));
  const rank = S.leagues.map((_, l) => ({ l, v: cnt[l], t: tot[l], z: Math.random() })).sort((a, b) => b.v - a.v || b.t - a.t || a.z - b.z); // empate: más caché total, y si no al azar
  S.intl.lgs = rank.slice(0, S.intl.nl).map(x => x.l);
  S.intl.vres = rank.map((x, i) => ({ l: x.l, v: x.v, in: i < S.intl.nl }));
  S.step = 'lres'; push(r);
}
function simPending(r) { // tras una desconexión / salida: repasar lo que estaba esperando votos
  const S = r.sim; if (!S) return;
  if (S.step === 'vote') { simAutoVotes(r); return simCheck(r); }
  if (S.step === 'lvote') { simLeagueAuto(r); return simLeagueCheck(r); }
  if (S.step === 'ev') return simEventAuto(r);
  if (S.step === 'dft') return simDraftAuto(r);
  if (S.step === 'fmt') return simFmtAuto(r);
  if (S.step === 'lpick') return simLpAuto(r);
  if (S.step === 'rr') return simRrAuto(r);
  if (S.step === 'kopick') return simKoPickAuto(r);
  push(r);
}
function simIntlBegin(r, kind) { // kind: 'cut1' | 'cut2'
  const S = r.sim, taken = new Set(S.intl.q.map(x => x.l + '|' + x.n)); // quien ya clasificó en el primer corte no puede clasificar otra vez
  const lgs = S.intl.lgs, tops = {};
  lgs.forEach(l => { tops[l] = simTable(S.leagues[l]).filter(x => !taken.has(l + '|' + x.n)).slice(0, 4).map(x => x.n); });
  if (lgs.some(l => tops[l].length < 4)) { // no debería pasar nunca (8 - 4 ya clasificados = 4), pero por si acaso la temporada sigue sin internacional
    S.intl = null; S.stage = 'league';
    if (kind === 'cut1') return simNextJornada(r);
    S.step = 'end'; return push(r);
  }
  const ord = simShuffle(lgs), n = ord.length, pairs = [];
  const mk = (A, ia, B, ib) => ({ a: tops[A][ia], la: A, ra: ia + 1, b: tops[B][ib], lb: B, rb: ib + 1, res: null, fav: null });
  for (let i = 0; i < n; i++) { // ciclo de ligas: cada liga da su 1.º y su 2.º, y recibe a un 4.º y a un 3.º de ligas distintas (todas distintas a la suya)
    const A = ord[i], B = ord[(i + 1) % n], C = ord[(i - 1 + n) % n];
    pairs.push(mk(A, 0, B, 3)); // 1.º contra el 4.º de otra liga
    pairs.push(mk(A, 1, C, 2)); // 2.º contra el 3.º de otra liga
  }
  S.stage = kind; S.battles = simShuffle(pairs); S.step = 'intro'; S.b = 0; S.round = 1; S.votes = {}; S.last = null; S.needRep = false; S.jurors = [];
  push(r);
}
// ---- Fase de grupos (FMS Internacional 2021) ----
function simFix5(keys) { // todos contra todos de 5: método del círculo con un descanso -> 5 jornadas de 2 batallas
  const t = simShuffle(keys).concat([null]), rounds = [];
  for (let j = 0; j < 5; j++) {
    const m = [];
    for (let i = 0; i < 3; i++) { const a = t[i], b = t[5 - i]; if (a && b) m.push(simShuffle([a, b])); }
    rounds.push(m);
    t.splice(1, 0, t.pop());
  }
  return rounds;
}
function simGrpTable(S, G) {
  return G.members.map(m => ({ n: m.n, lgi: m.l, r: m.r, c: S.leagues[m.l].cache[m.n], ...G.st[m.n] })).sort((a, b) => b.pts - a.pts || b.c - a.c || a.n.localeCompare(b.n));
}
function simGrpBegin(r) { // sorteo de grupos: un freestyler de cada liga en cada grupo, y un 1.º, 2.º, 3.º, 4.º y 5.º en cada uno
  const S = r.sim, lgs = S.intl.lgs;
  if (!lgs || lgs.length !== 5) { S.intl = null; S.stage = 'league'; S.step = 'end'; return push(r); } // no debería pasar
  const tops = {}; lgs.forEach(l => { tops[l] = simTable(S.leagues[l]).slice(0, 6).map(x => x.n); });
  const perm = simShuffle(lgs), rk = simShuffle([0, 1, 2, 3, 4]), groups = [];
  const mkG = (name, members) => { const st = {}; members.forEach(m => { st[m.n] = { pts: 0, w: 0, wr: 0, lr: 0, l: 0 }; }); return { name, members: simShuffle(members), fix: simFix5(members.map(m => m.n)), st, done: false }; };
  for (let g = 0; g < 5; g++) { // cuadrado latino: en el grupo g, el puesto k sale de la liga perm[(g + rk[k]) % 5]
    const members = []; for (let k = 0; k < 5; k++) { const l = perm[(g + rk[k]) % 5]; members.push({ l, n: tops[l][k], r: k + 1 }); }
    groups.push(mkG(GRP_NAMES[g], members));
  }
  groups.push(mkG('Reservas', lgs.map(l => ({ l, n: tops[l][5], r: 6 })))); // el 6.º de cada liga
  S.grp = { groups, g: 0, gj: 1 }; S.stage = 'grp'; S.step = 'gdraw'; S.battles = []; S.jurors = [];
  push(r);
}
function simGrpJornada(r) {
  const S = r.sim, G = S.grp.groups[S.grp.g], by = Object.fromEntries(G.members.map(m => [m.n, m]));
  S.stage = 'grp'; S.step = 'intro'; S.b = 0; S.round = 1; S.votes = {}; S.last = null; S.needRep = false; S.jurors = [];
  S.battles = G.fix[S.grp.gj - 1].map(([a, b]) => ({ a, la: by[a].l, ra: by[a].r, b, lb: by[b].l, rb: by[b].r, res: null, fav: null }));
  push(r);
}
function simGrpClose(r) { // el grupo ha terminado: clasifican los 3 primeros (1 en Reservas)
  const S = r.sim, G = S.grp.groups[S.grp.g]; G.done = true;
  simGrpTable(S, G).slice(0, G.name === 'Reservas' ? GRP_Q_RES : GRP_Q).forEach(x => {
    if (!S.intl.q.some(q => q.l === x.lgi && q.n === x.n)) S.intl.q.push({ l: x.lgi, n: x.n, via: 'grp', g: G.name });
  });
}
function simKoPairs(q) { // sorteo de octavos: se evita (si se puede) cruzar a dos freestylers de la misma liga
  let s = simShuffle(q);
  for (let t = 0; t < 300; t++) {
    s = simShuffle(q);
    let ok = true; for (let i = 0; i < s.length; i += 2) if (s[i].l === s[i + 1].l) ok = false;
    if (ok) break;
  }
  const p = []; for (let i = 0; i < s.length; i += 2) p.push([s[i], s[i + 1]]);
  return p;
}
const simKo0 = S => S.intl && S.intl.mini ? 1 : 0; // ronda con la que empieza el cuadro: octavos (0) o, en la mini inter, cuartos (1)
function simKoBegin(r, k) { // k: 0 = primera ronda del cuadro; luego 1 cuartos, 2 semis, 3 final
  const S = r.sim; let pairs; const first = k === 0; if (first) k = simKo0(S);
  if (first && !(S.kp && S.kp.built)) return simKoPickBegin(r); // las llaves de octavos se eligen una a una (ver simKoPickBegin)
  if (first) pairs = S.kp.slots.map(sl => [sl[0], sl[1]]);
  else {
    const prev = S.battles.map(bt => bt.res.w === 'a' ? { l: bt.la, n: bt.a } : { l: bt.lb, n: bt.b }); // ganadores en el orden del cuadro
    pairs = []; for (let i = 0; i < prev.length; i += 2) pairs.push([prev[i], prev[i + 1]]);
  }
  S.stage = 'ko'; S.ko = k;
  S.battles = pairs.map(([x, y]) => ({ a: x.n, la: x.l, b: y.n, lb: y.l, res: null, fav: null }));
  S.step = 'intro'; S.b = 0; S.round = 1; S.votes = {}; S.last = null; S.needRep = false; S.jurors = [];
  push(r);
}
function simFinish(r) { // fin: el campeón de la internacional se lleva el premio gordo de caché
  const S = r.sim;
  if (S.intl && S.stage === 'ko' && S.ko === 3 && S.battles[0] && S.battles[0].res) {
    const bt = S.battles[0], w = bt.res.w, l = w === 'a' ? bt.la : bt.lb, n = w === 'a' ? bt.a : bt.b;
    const bonus = S.intl.mini ? CACHE_MINI_CHAMP : CACHE_INTL_CHAMP;
    S.leagues[l].cache[n] += bonus;
    S.intl.champ = { l, n, bonus };
  }
  S.step = 'end'; push(r);
}
function simNextJornada(r) { // la liga sigue con la siguiente jornada; si ya no quedan, empieza el segundo corte (o acaba la temporada)
  const S = r.sim;
  if (S.j < S.jn) { S.j++; S.li = 0; return simBegin(r); }
  if (S.season === 2 && S.ws && !S.ws.done) return simWsBegin(r); // temporada 2: tras las ligas se juega la World Series
  simAfterLeagues(r);
}
function simMiniBegin(r) { // mini inter (2 ligas): clasifican los 4 primeros de cada tabla y se juegan unos cuartos de final
  const S = r.sim, I = S.intl; I.q = [];
  I.lgs.forEach(l => simTable(S.leagues[l]).slice(0, 4).forEach(x => I.q.push({ l, n: x.n, via: 'mini' })));
  S.stage = 'ko'; S.ko = simKo0(S); S.step = 'mini'; S.battles = []; S.jurors = [];
  push(r);
}
function simAfterLeagues(r) { // ligas (y World Series) terminadas: segundo corte / grupos de la internacional, o fin de la temporada
  const S = r.sim;
  if (S.intl && S.intl.mini) return simMiniBegin(r);
  if (S.intl) return S.intl.grp ? (S.intl.lgs ? simGrpBegin(r) : simLeagueBegin(r)) : simIntlBegin(r, 'cut2');
  S.stage = 'league'; S.step = 'end'; push(r);
}
// ---- Gran Final: los clasificados eligen su llave de octavos ----
function simKpOpts(S, x) { // batallas con algún hueco libre; si se puede, sin cruzar a dos freestylers de la misma liga
  const free = [];
  S.kp.slots.forEach((sl, i) => { if (!sl[0] || !sl[1]) free.push(i); });
  const ok = free.filter(i => { const o = S.kp.slots[i][0] || S.kp.slots[i][1]; return !o || o.l !== x.l; });
  return ok.length ? ok : free;
}
function simKoPickBegin(r) {
  const S = r.sim, q = simShuffle(S.intl.q.map(x => ({ l: x.l, n: x.n })));
  S.kp = { order: q, idx: 0, slots: Array.from({ length: Math.floor(q.length / 2) }, () => [null, null]), done: false, built: false, log: [] };
  S.stage = 'ko'; S.ko = simKo0(S); S.step = 'kopick'; S.battles = []; S.jurors = [];
  simKoPickAuto(r);
}
function simKoPlace(r, slot) { // el clasificado que ha salido entra en la batalla «slot»
  const S = r.sim, K = S.kp, x = K.order[K.idx];
  if (!K || K.done || !simKpOpts(S, x).includes(slot)) return false;
  const sl = K.slots[slot], seat = sl[0] ? 1 : 0;
  sl[seat] = x; K.log.push({ l: x.l, n: x.n, slot }); K.idx++;
  if (K.idx >= K.order.length) K.done = true;
  return true;
}
function simKpBot(S, x) { // bot o jugador desconectado: el 60% de las veces va contra el rival de menos caché, si no al azar
  const opts = simKpOpts(S, x), occ = opts.filter(i => S.kp.slots[i][0] || S.kp.slots[i][1]);
  if (occ.length && Math.random() < 0.6) {
    const cache = i => { const o = S.kp.slots[i][0] || S.kp.slots[i][1]; return S.leagues[o.l].cache[o.n]; };
    return occ.slice().sort((a, b) => cache(a) - cache(b))[0];
  }
  return simShuffle(opts)[0];
}
function simKoPickAuto(r) { // avanza solo hasta que le toca elegir a una persona (si solo queda una opción, entra solo)
  const S = r.sim; if (!S || S.step !== 'kopick') return;
  const K = S.kp;
  while (!K.done) {
    const x = K.order[K.idx], opts = simKpOpts(S, x), p = find(r, S.leagues[x.l].ownerId);
    if (opts.length > 1 && p && !p.bot && p.on) break; // espera a que elija el representante de su liga
    simKoPlace(r, opts.length === 1 ? opts[0] : simKpBot(S, x));
  }
  push(r);
}
// ---- Temporada 2 ----
function simHofEntry(r) { // Hall of Fame de la temporada: podio (1.º, 2.º y 3.º) de cada liga, finalistas de la internacional y campeón de la World Series
  const S = r.sim, nm = l => S.leagues[l] ? S.leagues[l].name : '';
  const pod = S.leagues.map(lg => ({ name: lg.name, p: simTable(lg).slice(0, 3).map(x => ({ n: x.n, pts: x.pts, c: x.c })) }));
  let ic = null;
  if (S.intl && S.intl.champ) {
    const ch = S.intl.champ, bt = S.battles[0]; let second = null;
    if (S.stage === 'ko' && S.ko === 3 && bt && bt.res) second = bt.res.w === 'a' ? { n: bt.b, lg: nm(bt.lb) } : { n: bt.a, lg: nm(bt.la) };
    ic = { champ: { n: ch.n, lg: nm(ch.l) }, second, mini: !!S.intl.mini };
  }
  const wsc = S.ws && S.ws.champ ? { n: S.ws.champ.n, lg: nm(S.ws.champ.l) } : null;
  return { gid: S.gid, season: S.season, career: !!S.career, pod, ic, wsc };
}
function simCareerGrow(r) { // Modo Carrera: al empezar la temporada se suman las ligas nuevas (las anteriores siguen con los suyos)
  const S = r.sim, names = CAREER_LEAGUES[Math.min(S.season, CAREER_SEASONS) - 1];
  const used = new Set(S.leagues.flatMap(l => l.teams).map(key));
  names.forEach((nm, i) => {
    if (S.leagues.some(l => l.name === nm)) return;
    S.leagues.push(simMakeLeague(r, nm, r.players[i % r.players.length], used)); // reparto: España al 1.º, Argentina al 2.º, México al 3.º, Chile al 4.º (y vuelta al 1.º si hay menos)
  });
  S.spare = (S.spare || []).filter(x => !used.has(key(x)));
  r.players.forEach(p => simSyncRoster(r, p.id));
}
function simSeason2Begin(r) { // abre la siguiente temporada: la 2 de siempre o, en el Modo Carrera, la 2 y la 3
  const S = r.sim; if (!S || S.step !== 'end' || (S.career ? S.season >= CAREER_SEASONS : S.season !== 1)) return;
  const champs = S.leagues.map(lg => simTable(lg)[0].n), ic = S.intl && S.intl.champ ? S.intl.champ : null, w = simWinner(r);
  S.keep = [...new Set([...champs, ...(ic ? [ic.n] : [])])]; // los campeones (de liga y de la internacional) se mantienen: no se pueden despedir ni draftear
  S.hist = { winner: w ? { ownerName: w.ownerName, n: w.n, c: w.c, league: w.league } : null, champs: S.leagues.map((lg, l) => ({ l, n: champs[l] })), intl: ic ? { l: ic.l, n: ic.n } : null };
  (S.histAll = S.histAll || []).push({ ...simHofEntry(r), ...S.hist });
  S.season++; S.id = Date.now();
  if (S.career) simCareerGrow(r);
  S.leagues.forEach(lg => { // nueva temporada: tablas y calendario a cero; el caché, las visitas y la música se conservan
    lg.st = {}; lg.teams.forEach(t => { lg.st[t] = { pts: 0, w: 0, wr: 0, lr: 0, l: 0 }; });
    lg.fix = simFixture(lg.teams); lg.mvps = []; lg.boost = null; lg.makeup = null;
  });
  S.order = simShuffle(S.leagues.map((_, i) => i));
  S.stage = 'league'; S.ko = -1; S.intl = simIntlInit(S.career ? (S.season >= CAREER_INTL_SEASON ? SIM_INTL_PLAYERS : S.leagues.length === 2 ? 2 : 0) : r.players.length, S.leagues); S.grp = null; S.lvotes = {};
  S.j = 1; S.li = 0; S.b = 0; S.round = 1; S.battles = []; S.jurors = []; S.votes = {}; S.last = null; S.needRep = false;
  S.mk = null; S.ev = null; S.dft = null; S.rr = null; S.kp = null; S.ws = null; S.vetoes = []; S.mvp = null;
  simRrBegin(r); // primero los despidos (hasta 2) y luego el draft (1 intercambio)
}
function simSeasonGo(r) { // todo listo para jugar la temporada: en la 2 se fija la World Series con los 10 mejor pagados tras despidos y draft
  const S = r.sim;
  if (S.season === 2 && (!S.career || CAREER_WS_S2)) simWsPrepare(r);
  simBegin(r);
}
function simWsPrepare(r) {
  const S = r.sim; S.ws = null;
  const all = [];
  S.leagues.forEach((lg, l) => lg.teams.forEach(n => all.push({ l, n, c: lg.cache[n] })));
  if (all.length < WS_SIZE) return; // con una sola liga (8 freestylers) no hay World Series
  const top = all.sort((a, b) => b.c - a.c || a.n.localeCompare(b.n)).slice(0, WS_SIZE), st = {};
  top.forEach(x => { st[x.n] = { pts: 0, w: 0, wr: 0, lr: 0, l: 0 }; });
  S.ws = { members: top.map(x => ({ l: x.l, n: x.n })), fix: simFixture(top.map(x => x.n)), st, j: 1, jn: S.dbl ? 5 : WS_SIZE - 1, sched: S.dbl ? [[0, 1], [2, 3], [4, 5], [6, 7], [8]] : [0, 1, 2, 3, 4, 5, 6, 7, 8].map(k => [k]), done: false, champ: null };
}
function simWsRename(S, old, nw) { // un freestyler de la World Series ha sido sustituido en su liga: el nuevo ocupa su plaza con sus puntos
  const W = S.ws, m = W.members.find(x => x.n === old); if (!m) return;
  m.n = nw; W.st[nw] = W.st[old]; delete W.st[old];
  W.fix = W.fix.map(rd => rd.map(pr => pr.map(n => n === old ? nw : n)));
}
function simWsTable(S) {
  return S.ws.members.map(m => ({ n: m.n, lgi: m.l, c: S.leagues[m.l].cache[m.n], v: (S.leagues[m.l].views || {})[m.n] || 0, ...S.ws.st[m.n] })).sort((a, b) => b.pts - a.pts || b.c - a.c || a.n.localeCompare(b.n));
}
function simWsBegin(r) { // presentación de la World Series
  const S = r.sim; S.stage = 'ws'; S.step = 'wsdraw'; S.battles = []; S.jurors = []; S.mk = null; push(r);
}
function simWsJornada(r) {
  const S = r.sim, W = S.ws, lOf = Object.fromEntries(W.members.map(m => [m.n, m.l]));
  S.stage = 'ws'; S.step = 'intro'; S.b = 0; S.round = 1; S.votes = {}; S.last = null; S.needRep = false; S.jurors = [];
  S.battles = W.sched[W.j - 1].flatMap(k => W.fix[k]).map(([a, b]) => ({ a, la: lOf[a], b, lb: lOf[b], res: null, fav: null }));
  push(r);
}
function simWsClose(r) { // acaba la World Series: el campeón de la tabla cobra el premio
  const S = r.sim, W = S.ws; W.done = true;
  const t = simWsTable(S)[0], m = W.members.find(x => x.n === t.n);
  S.leagues[m.l].cache[m.n] += CACHE_WS_CHAMP;
  W.champ = { l: m.l, n: m.n, bonus: CACHE_WS_CHAMP };
}
// ---- Draft entre ligas ----
const simOwnLg = (S, pid) => S.leagues.findIndex(l => l.ownerId === pid);
function simDraftBegin(r) {
  const S = r.sim, ids = simShuffle([...new Set(S.leagues.map(l => l.ownerId))].filter(id => find(r, id))), order = []; // solo juegan el draft quienes llevan alguna liga
  for (let k = 0; k < DRAFT_ROUNDS; k++) (k % 2 ? ids.slice().reverse() : ids).forEach(id => order.push(id)); // serpiente
  S.dft = { order, idx: 0, locked: S.season >= 2 ? S.keep.slice() : [], log: [], done: false };
  S.step = 'dft';
  simDraftAuto(r);
}
function simDraftSwap(r, pid, take, give) { // el jugador cede «give» (de una liga suya) y ficha «take» (de una liga que no lleva él)
  const S = r.sim, D = S.dft, a = S.leagues.findIndex(lg => lg.ownerId === pid && lg.teams.includes(give)); if (a < 0) return false;
  const b = S.leagues.findIndex(lg => lg.ownerId !== pid && lg.teams.includes(take));
  if (b < 0 || D.locked.includes(take) || D.locked.includes(give)) return false;
  const A = S.leagues[a], B = S.leagues[b];
  if (noKodigo(A, take) || noKodigo(B, give)) return false;
  A.teams[A.teams.indexOf(give)] = take; B.teams[B.teams.indexOf(take)] = give;
  const cg = A.cache[give], sg = A.st[give], ct = B.cache[take], stt = B.st[take];
  delete A.cache[give]; delete A.st[give]; delete B.cache[take]; delete B.st[take];
  A.cache[take] = ct; A.st[take] = stt; B.cache[give] = cg; B.st[give] = sg;
  const sub = (lg, x, y) => { lg.fix = lg.fix.map(rd => rd.map(pr => pr.map(n => n === x ? y : n))); };
  sub(A, give, take); sub(B, take, give);
  simSyncRoster(r, A.ownerId); simSyncRoster(r, B.ownerId);
  D.locked.push(take, give);
  D.log.push({ pid, take, give, from: b, to: a });
  return true;
}
function simDraftPropose(r, pid, take, give) { // el intercambio queda pendiente de que lo acepte el dueño de la otra liga
  const S = r.sim, D = S.dft, a = S.leagues.findIndex(lg => lg.ownerId === pid && lg.teams.includes(give)); if (a < 0) return false;
  const b = S.leagues.findIndex(lg => lg.ownerId !== pid && lg.teams.includes(take));
  if (b < 0 || D.locked.includes(take) || D.locked.includes(give)) return false;
  if (noKodigo(S.leagues[a], take) || noKodigo(S.leagues[b], give)) return false;
  D.prop = { pid, take, give, to: S.leagues[b].ownerId, b };
  return true;
}
function simDraftResolve(r, ok) { // responde el dueño (o el azar): si rechaza, el que propuso pierde su turno
  const D = r.sim.dft, pr = D.prop; if (!pr) return;
  D.prop = null;
  if (!(ok && simDraftSwap(r, pr.pid, pr.take, pr.give))) D.log.push({ pid: pr.pid, take: pr.take, give: pr.give, from: pr.b, rejected: true, by: pr.to });
  D.idx++;
}
function simDraftRandom(r, pid) { // turno automático (bots, desconectados o «dar por decidido»): propone un intercambio al azar o pasa
  const S = r.sim, D = S.dft, me = simOwnLg(S, pid);
  if (me >= 0 && Math.random() < 0.7) {
    const mine = S.leagues.filter(lg => lg.ownerId === pid).flatMap(lg => lg.teams).filter(t => !D.locked.includes(t)), others = [];
    S.leagues.forEach(lg => { if (lg.ownerId !== pid) lg.teams.forEach(t => { if (!D.locked.includes(t)) others.push(t); }); });
    if (mine.length && others.length && simDraftPropose(r, pid, simShuffle(others)[0], simShuffle(mine)[0])) return; // queda pendiente de respuesta
  }
  D.log.push({ pid, pass: true });
  D.idx++;
}
function simDraftAuto(r) { // bots y desconectados juegan solos (también aceptan o rechazan al azar)
  const S = r.sim; if (!S || S.step !== 'dft') return;
  const D = S.dft;
  while (D.idx < D.order.length) {
    if (D.prop) {
      const o = find(r, D.prop.to);
      if (o && !o.bot && o.on) break; // espera a que responda una persona
      simDraftResolve(r, Math.random() < 0.5);
      continue;
    }
    const p = find(r, D.order[D.idx]);
    if (p && !p.bot && p.on) break;
    simDraftRandom(r, D.order[D.idx]);
  }
  if (D.idx >= D.order.length && !D.prop) D.done = true;
  push(r);
}

// ---- Antes del draft: cancelar hasta 2 contratos ----
const RR_MAX = 2;
function simRrBegin(r) {
  const S = r.sim;
  S.rr = { sel: {}, done: {}, log: [], applied: false };
  S.step = 'rr';
  simRrAuto(r);
}
function simRrAuto(r) { // bots y desconectados se quedan con los suyos; cuando todos han decidido se aplica
  const S = r.sim; if (!S || S.step !== 'rr') return;
  const R = S.rr;
  r.players.forEach(p => { if (!R.done[p.id] && (p.bot || !p.on || !S.leagues.some(l => l.ownerId === p.id))) R.done[p.id] = true; }); // bots, desconectados y quien no lleva ninguna liga
  if (!R.applied && r.players.every(p => R.done[p.id])) {
    R.applied = true;
    S.leagues.forEach((lg, li) => {
      const out = [];
      (R.sel[lg.ownerId] || []).forEach(old => {
        if (!lg.teams.includes(old)) return;
        const x = simReplace(r, li, old, 'inherit'); // los nuevos entran de cero (aún no se ha jugado nada)
        if (x) { out.push({ old, nw: x.nw }); S.spare.push(old); }
      });
      if (out.length) R.log.push({ pid: lg.ownerId, out });
    });
  }
  push(r);
}

// ---- Eventos al terminar una jornada ----
function simReplace(r, li, old, mode) { // sustituye a «old» por un freestyler nuevo. mode: 'inherit' (hereda los puntos) | 'redo' (empieza de cero y rehace sus batallas)
  const S = r.sim, lg = S.leagues[li];
  const used = new Set(S.leagues.flatMap(l => l.teams).map(key));
  let nw = (S.spare || []).find(x => !used.has(key(x)) && !noKodigo(lg, x) && eligLg(r, lg.name, x));
  if (!nw) nw = simShuffle(fPool(r)).find(x => !used.has(key(x)) && !noKodigo(lg, x) && eligLg(r, lg.name, x));
  if (!nw) nw = simShuffle(fPool(r)).find(x => !used.has(key(x)) && !noKodigo(lg, x));
  if (!nw) return null;
  S.spare = (S.spare || []).filter(x => x !== nw);
  const oldSt = lg.st[old], prev = [];
  for (const k of S.sched.slice(0, S.j).flat()) { const pr = lg.fix[k].find(q => q.includes(old)); if (pr) prev.push(pr[0] === old ? pr[1] : pr[0]); } // rivales que ya había enfrentado
  lg.teams[lg.teams.indexOf(old)] = nw;
  delete lg.cache[old]; delete lg.st[old]; if (lg.views) delete lg.views[old];
  lg.cache[nw] = CACHE_START;
  lg.st[nw] = mode === 'inherit' ? { ...oldSt } : { pts: 0, w: 0, wr: 0, lr: 0, l: 0 };
  lg.fix = lg.fix.map(rd => rd.map(pr => pr.map(n => n === old ? nw : n))); // el nuevo ocupa su sitio en todo el calendario (el pasado solo sirve para saber a quién enfrentó cada uno)
  if (lg.music) lg.music = lg.music.filter(x => x !== old);
  if (S.ws) simWsRename(S, old, nw);
  simSyncRoster(r, lg.ownerId);
  if (mode === 'redo' && prev.length) lg.makeup = prev.map(o => [nw, o]);
  return { nw, redo: mode === 'redo' ? prev.length : 0 };
}
function simAfterJornada(r) { // lo que viene al acabar la jornada en todas las ligas (y su evento, si lo hubo)
  const S = r.sim; S.mk = null; S.ev = null;
  if (S.intl && !S.intl.grp && !S.intl.mini && S.j === S.cutJ) return S.intl.lgs ? simIntlBegin(r, 'cut1') : simLeagueBegin(r); // en el formato de grupos no hay cortes a mitad de liga
  return simNextJornada(r);
}
function simJornadaEnd(r) { // 50% de que pase un evento (no tras la última jornada: ya no quedan batallas que afectar)
  const S = r.sim;
  if (S.j < S.jn && Math.random() < EVENT_P) return simEventBegin(r);
  simAfterJornada(r);
}
function simVetoOpts(r, lg) { // a quién puede vetar el dueño de la liga: otros jugadores y el voto por caché (que aún no haya vetado)
  const S = r.sim, done = (S.vetoes || []).filter(v => v.owner === lg.ownerId).map(v => v.target);
  return [...r.players.filter(p => p.id !== lg.ownerId).map(p => ({ id: p.id, name: p.name })), { id: 'c', name: 'Favorito por caché' }].filter(o => !done.includes(o.id));
}
function simEventBegin(r) {
  const S = r.sim, li = Math.floor(Math.random() * S.leagues.length), lg = S.leagues[li];
  const kinds = EVENTS.filter(k => (k !== 'pique' || S.leagues.length > 1) && (k !== 'veto' || (simVetoOpts(r, lg).length && !simSolo(r, S))));
  const type = simShuffle(kinds)[0];
  const q = S.intl ? S.intl.q : [];
  const free = lg.teams.filter(t => !q.some(x => x.l === li && x.n === t)); // los ya clasificados a la Gran Final no se tocan
  const target = (type === 'baja' || type === 'polemica') ? simShuffle(free)[0] : null;
  const ev = { id: ++S.evSeq, type, li, pid: lg.ownerId, target, done: false, res: null, played: S.sched.slice(0, S.j).flat().length };
  if (target) { ev.pts = lg.st[target].pts; ev.cache = lg.cache[target]; ev.loss = Math.round(lg.cache[target] * POLEMICA_LOSS / 10) * 10; }
  if (type === 'viral') {
    const pr = simShuffle(simJBattles(S, lg))[0];
    pr.forEach(n => { lg.cache[n] += CACHE_VIRAL; });
    ev.res = { a: pr[0], b: pr[1], gain: CACHE_VIRAL }; ev.done = true;
  }
  if (type === 'veto') ev.opts = simVetoOpts(r, lg);
  if (type === 'streamer') { lg.boost = { j: S.j + 1, mult: STREAMER_MULT }; ev.res = { j: S.j + 1, mult: STREAMER_MULT }; ev.done = true; }
  S.ev = ev; S.step = 'ev';
  simEventAuto(r);
}
function simEventRandomChoice(S, ev) {
  if (ev.type === 'baja') return Math.random() < 0.5 ? 'inherit' : 'redo';
  if (ev.type === 'polemica') return Math.random() < 0.5 ? 'keep' : 'fire';
  if (ev.type === 'veto') return simShuffle(ev.opts)[0].id;
  if (ev.type === 'music') { const lg = S.leagues[ev.li]; return simShuffle(lg.teams.filter(t => !(lg.music || []).includes(t)))[0]; }
  if (Math.random() < 0.3) return { pass: true };
  const others = S.leagues.map((_, l) => l).filter(l => l !== ev.li);
  return { lg: simShuffle(others)[0], n: simShuffle(S.leagues[ev.li].teams)[0] };
}
function simEventAuto(r) { // si decide un bot o alguien desconectado, se resuelve solo
  const S = r.sim, ev = S.ev; if (!ev || ev.done) return push(r);
  const p = find(r, ev.pid);
  if (p && !p.bot && p.on) return push(r);
  if (!simEventResolve(r, simEventRandomChoice(S, ev))) push(r);
}
function simEventResolve(r, c) { // c: la decisión del jugador afectado
  const S = r.sim, ev = S.ev; if (!ev || ev.done) return false;
  const lg = S.leagues[ev.li], t = ev.target;
  if (ev.type === 'baja') {
    if (c !== 'inherit' && c !== 'redo') return false;
    const x = simReplace(r, ev.li, t, c); if (!x) return false;
    ev.res = { old: t, nw: x.nw, mode: c, redo: x.redo, pts: ev.pts };
  } else if (ev.type === 'polemica') {
    if (c === 'keep') { lg.cache[t] -= ev.loss; ev.res = { t, keep: true, loss: ev.loss }; }
    else if (c === 'fire') { const x = simReplace(r, ev.li, t, 'inherit'); if (!x) return false; ev.res = { t, fired: true, nw: x.nw }; }
    else return false;
  } else if (ev.type === 'veto') {
    const o = ev.opts.find(x => x.id === c); if (!o) return false;
    (S.vetoes = S.vetoes || []).push({ owner: lg.ownerId, target: o.id });
    ev.res = { name: o.name };
  } else if (ev.type === 'music') {
    if (typeof c !== 'string' || !lg.teams.includes(c) || (lg.music || []).includes(c)) return false;
    (lg.music = lg.music || []).push(c);
    ev.res = { n: c };
  } else if (ev.type === 'pique') {
    if (c && c.pass) ev.res = { pass: true };
    else {
      const l = c && c.lg;
      if (!Number.isInteger(l) || l === ev.li || !S.leagues[l] || !lg.teams.includes(c.n)) return false;
      ev.res = { pq: { a: c.n, la: ev.li, b: simShuffle(S.leagues[l].teams)[0], lb: l } };
    }
  } else return false;
  ev.done = true; push(r); return true;
}
function simMakeupBegin(r, li) { // jornada de recuperación: el reemplazo rehace las batallas que ya había jugado el que se bajó
  const S = r.sim, lg = S.leagues[li];
  S.stage = 'league'; S.mk = { li }; S.step = 'intro'; S.b = 0; S.round = 1; S.votes = {}; S.last = null; S.needRep = false;
  S.battles = lg.makeup.map(([a, b]) => ({ a, b, la: li, lb: li, res: null, fav: null }));
  lg.makeup = null;
  S.jurors = simMakeJury(r, [lg.ownerId], true);
  push(r);
}
function simPiqueBegin(r, pq) { // exhibición entre un freestyler de tu liga y uno de la liga rival: solo mueve caché
  const S = r.sim;
  S.stage = 'pique'; S.step = 'intro'; S.b = 0; S.round = 1; S.votes = {}; S.last = null; S.needRep = false; S.jurors = [];
  S.battles = [{ a: pq.a, la: pq.la, b: pq.b, lb: pq.lb, res: null, fav: null }];
  push(r);
}
function simEventNext(r) {
  const S = r.sim, ev = S.ev; if (!ev || !ev.done) return;
  S.ev = null;
  const lg = S.leagues[ev.li];
  if (lg.makeup && lg.makeup.length) return simMakeupBegin(r, ev.li);
  if (ev.res && ev.res.pq) return simPiqueBegin(r, ev.res.pq);
  simAfterJornada(r);
}

function simAdvance(r) { // desde la pantalla de cierre (jEnd) a lo siguiente
  const S = r.sim;
  if (S.mk || S.stage === 'pique') return simAfterJornada(r); // acaba la recuperación o el pique: sigue la temporada
  if (S.stage === 'league') {
    if (S.li < S.order.length - 1) { S.li++; return simBegin(r); } // la jornada de la siguiente liga
    return simJornadaEnd(r); // acaba la jornada en todas las ligas: posible evento y luego (votación de ligas si hay más de 4 y) primer corte internacional
  }
  if (S.stage === 'grp') { // se completa el grupo entero antes de pasar al siguiente
    const g = S.grp;
    if (g.gj < 5) { g.gj++; return simGrpJornada(r); }
    if (g.g < 5) { g.g++; g.gj = 1; return simGrpJornada(r); }
    return simKoBegin(r, 0); // 16 clasificados: octavos con llaves al azar
  }
  if (S.stage === 'ws') { // World Series: siguiente jornada o, al acabar, lo que viniera después de las ligas
    if (S.ws.j < S.ws.jn) { S.ws.j++; return simWsJornada(r); }
    return simAfterLeagues(r);
  }
  if (S.stage === 'cut1') return simNextJornada(r); // de vuelta a las ligas (jornada 4)
  if (S.stage === 'cut2') return simKoBegin(r, 0);
  if (S.stage === 'ko') return S.ko < 3 ? simKoBegin(r, S.ko + 1) : simFinish(r);
}
function simNextStep(r) { // paso del anfitrión (botón «siguiente»)
  const S = r.sim; if (!S) return;
  if (S.step === 'draw') return simRrBegin(r);
  if (S.step === 'rr') { if (S.rr && S.rr.applied) { if (new Set(S.leagues.map(l => l.ownerId)).size > 1) simDraftBegin(r); else simSeasonGo(r); } return; } // el draft necesita al menos 2 dueños distintos
  if (S.step === 'dft') { if (S.dft && S.dft.done) simSeasonGo(r); return; }
  if (S.step === 'kopick') { if (S.kp && S.kp.done) { S.kp.built = true; simKoBegin(r, 0); } return; }
  if (S.step === 'wsdraw') return simWsJornada(r);
  if (S.step === 'mini') return simKoPickBegin(r); // los 8 clasificados eligen su llave de cuartos
  if (S.step === 'ev') return simEventNext(r);
  if (S.step === 'intro') { S.b = 0; return simStartBattle(r); }
  if (S.step === 'reveal') {
    if (S.needRep) { S.round = 2; S.needRep = false; return simOpenVote(r); } // ronda extra: ya no se puede votar réplica
    if (S.b < S.battles.length - 1) { S.b++; return simStartBattle(r); }
    if (S.stage === 'grp' && S.grp.gj === 5) simGrpClose(r); // último partido del grupo: se conocen los clasificados
    if (S.stage === 'ws' && S.ws.j === S.ws.jn) simWsClose(r); // última jornada de la World Series: se conoce el campeón
    if (S.stage === 'league' && !S.mk) simMvp(r); // MVP de la jornada de esta liga
    S.step = 'jEnd'; return push(r);
  }
  if (S.step === 'jEnd') { S.mvp = null; return simAdvance(r); }
  if (S.step === 'lres') return S.intl.grp ? simGrpBegin(r) : simIntlBegin(r, 'cut1');
  if (S.step === 'gdraw') return simGrpJornada(r);
}
function simWinner(r) { // gana el jugador cuyo freestyler tiene más caché al final (el campeón de la inter ya lleva su premio sumado)
  const S = r.sim; if (!S || S.step !== 'end') return null;
  const rank = S.leagues.map((lg, l) => {
    const n = lg.teams.slice().sort((a, b) => lg.cache[b] - lg.cache[a] || lg.st[b].pts - lg.st[a].pts || a.localeCompare(b))[0];
    return { l, owner: lg.ownerId, ownerName: lg.ownerName, league: lg.name, n, c: lg.cache[n], pts: lg.st[n].pts };
  }).sort((x, y) => y.c - x.c || y.pts - x.pts || x.ownerName.localeCompare(y.ownerName));
  return { ...rank[0], ranking: rank };
}
function simView(r) {
  const S = r.sim;
  // la liga l ya ha cerrado su última jornada (su campeón está decidido)
  const finLg = l => S.step === 'end' || (S.j >= S.jn && (S.stage !== 'league' || S.order.indexOf(l) < S.li || (S.order.indexOf(l) === S.li && S.step === 'jEnd')));
  const v = {
    id: S.id, step: S.step, j: S.j, jn: S.jn, dbl: S.dbl, fmt: S.step === 'fmt' ? { voted: Object.keys(S.fmt.votes), total: r.players.filter(p => !p.bot && p.on).length } : null, jury: S.jury, li: S.li, total: S.order.length, order: S.order,
    stage: S.stage, ko: S.ko, ko0: simKo0(S), cutJ: S.cutJ, intlChamp: S.intl && S.intl.mini ? CACHE_MINI_CHAMP : CACHE_INTL_CHAMP, mk: !!S.mk, cacheStart: CACHE_START, streamerMult: STREAMER_MULT, musicMult: MUSIC_MULT, vetoes: (S.vetoes || []).map(v => ({ o: v.owner, t: v.target })), piqueCache: CACHE_PIQUE,
    rr: S.step === 'rr' && S.rr ? { done: Object.keys(S.rr.done), applied: S.rr.applied, log: S.rr.applied ? S.rr.log : [], max: RR_MAX, total: r.players.length } : null,
    career: !!S.career, cSeasons: CAREER_SEASONS, solo: simSolo(r, S), owners: new Set(S.leagues.map(l => l.ownerId)).size, histAll: S.histAll || [], hofNow: S.step === 'end' ? simHofEntry(r) : null,
    cnext: S.career && S.step === 'end' && S.season < CAREER_SEASONS ? { season: S.season + 1, add: CAREER_LEAGUES[S.season].filter(n => !S.leagues.some(l => l.name === n)), intl: S.season + 1 >= CAREER_INTL_SEASON, mini: S.season + 1 < CAREER_INTL_SEASON && CAREER_LEAGUES[S.season].length === 2 } : null,
    mvp: S.step === 'jEnd' && S.stage === 'league' && !S.mk && S.mvp ? S.mvp : null,
    lp: S.step === 'lpick' && S.lp ? { order: S.lp.order, idx: S.lp.idx, picks: S.lp.picks, all: SIM_LEAGUES } : null,
    dft: S.step === 'dft' && S.dft ? { order: S.dft.order, idx: S.dft.idx, locked: S.dft.locked, log: S.dft.log, done: S.dft.done, rounds: DRAFT_ROUNDS, prop: S.dft.prop } : null,
    ev: S.step === 'ev' && S.ev ? { id: S.ev.id, type: S.ev.type, li: S.ev.li, pid: S.ev.pid, target: S.ev.target, done: S.ev.done, res: S.ev.res, opts: S.ev.opts || null, mus: S.leagues[S.ev.li].music || [], j: S.j, played: S.ev.played, pts: S.ev.pts, cache: S.ev.cache, loss: S.ev.loss } : null,
    intl: S.intl ? { mini: !!S.intl.mini, q: S.intl.q.map(x => ({ l: x.l, n: x.n, via: x.via, g: x.g })), champ: S.intl.champ, lgs: S.intl.lgs, nl: S.intl.nl, grp: S.intl.grp, vres: S.step === 'lres' ? S.intl.vres : null } : null,
    grp: S.grp ? { g: S.grp.g, gj: S.grp.gj, q: GRP_Q, qr: GRP_Q_RES, groups: S.grp.groups.map(G => ({ name: G.name, done: G.done, table: simGrpTable(S, G) })) } : null,
    lvoted: S.step === 'lvote' ? Object.keys(S.lvotes) : [], lvoters: S.step === 'lvote' || S.step === 'lres' ? r.players.map(p => ({ id: p.id, name: p.name })) : [],
    leagues: S.leagues.map((lg, i) => ({ name: lg.name, owner: lg.ownerId, ownerName: lg.ownerName, teams: lg.teams, table: simTable(lg), fin: finLg(i), mvps: lg.mvps || [], boostJ: lg.boost ? lg.boost.j : 0, music: lg.music || [] })),
    season: S.season, keep: S.season >= 2 ? S.keep : [], hist: S.hist,
    kp: S.step === 'kopick' && S.kp ? (() => {
      const K = S.kp, cur = K.done ? null : K.order[K.idx], cc = x => x ? { l: x.l, n: x.n, c: S.leagues[x.l].cache[x.n] } : null;
      return { idx: K.idx, total: K.order.length, done: K.done, cur: cc(cur), pid: cur ? S.leagues[cur.l].ownerId : null, opts: cur ? simKpOpts(S, cur) : [], slots: K.slots.map(sl => sl.map(cc)),
        pending: K.order.slice(K.idx + (K.done ? 0 : 1)).map(cc).sort((a, b) => a.l - b.l || a.n.localeCompare(b.n)) }; // el orden de salida no se revela
    })() : null,
    ws: S.ws ? { j: S.ws.j, jn: S.ws.jn, done: S.ws.done, champ: S.ws.champ, bonus: CACHE_WS_CHAMP, size: WS_SIZE, table: simWsTable(S) } : null,
    winner: simWinner(r), cur: null
  };
  if (['intro', 'vote', 'reveal', 'jEnd'].includes(S.step)) {
    v.cur = {
      lg: S.mk ? S.mk.li : (S.stage === 'league' ? S.order[S.li] : null), b: S.b, round: S.round, needRep: !!S.needRep,
      jurors: S.jurors.map(j => ({ k: j.k, id: j.id, name: j.name })),
      voted: S.step === 'vote' ? Object.keys(S.votes).map(Number) : [],
      battles: S.battles.map(bt => ({ a: bt.a, b: bt.b, la: bt.la, lb: bt.lb, ra: bt.ra || 0, rb: bt.rb || 0, ca: S.leagues[bt.la].cache[bt.a], cb: S.leagues[bt.lb].cache[bt.b], res: bt.res })),
      last: S.step === 'reveal' ? S.last : null
    };
  }
  return v;
}

function toLobby(r) {
  clearTimeout(r.timer);
  r.players.forEach(b => { clearTimeout(b.bt); b.bt = null; });
  r.players = r.players.filter(p => p.on);
  r.theme = null; r.order = null; r.curSlot = null; r.market = false; r.sales = 0; r.sim = null;
  r.players.forEach(p => { p.money = moneyOf(r); p.roster = []; p.cast = {}; p.chars = {}; p.tname = null; p.rivals = []; p.form = (p.bot && Math.random() < 0.5) ? '442' : '433'; });
  r.offers = []; r.votes = {}; r.results = null; r.last = null; r.sealed = {}; r.reveal = null; r.bid = 0; r.bidder = null; r.bidsOpen = false; r.paused = false;
  r.phase = 'lobby';
  push(r);
}
function removePlayer(r, t) {
  clearTimeout(t.bt);
  r.players = r.players.filter(q => q !== t);
  r.offers = r.offers.filter(o => o.from !== t.id && o.to !== t.id);
  delete r.votes[t.id];
  Object.keys(r.votes).forEach(k => { r.votes[k] = r.votes[k].filter(id => id !== t.id); });
  delete r.sealed[t.id];
  if (r.bidder === t.id) { r.bidder = null; r.bid = 0; }
  if (r.last && r.last.winner === t.id) r.last = null;
  if (r.phase !== 'lobby' && r.players.length < (r.gm === 'sim' ? 1 : 2)) return toLobby(r); // sin rivales no hay partida
  if (r.phase === 'sim' && r.sim) return simPending(r);
  if (r.phase === 'auction' && r.auc === 'blind' && Object.keys(r.sealed).length && eligible(r).filter(q => q.on).every(q => q.id in r.sealed)) return closeBlind(r);
  if (r.phase === 'vote' && r.players.filter(q => q.on).every(q => r.votes[q.id])) return finishVote(r);
  push(r);
}

io.on('connection', s => {
  const ctxOf = () => {
    const x = bySock[s.id]; if (!x) return {};
    const r = rooms[x.code]; if (!r) return {};
    return { r, p: find(r, x.pid) };
  };
  const hostCtx = () => { const c = ctxOf(); return c.r && c.p && c.p.id === c.r.hostId ? c : {}; };

  function attach(r, p) {
    p.sid = s.id; p.on = true;
    bySock[s.id] = { code: r.code, pid: p.id };
    s.join(r.code);
    clearTimeout(r.gc);
  }
  function joinRoom(r, name, tok, cb) {
    let p = r.players.find(q => q.tok === tok);
    if (!p) {
      if (r.phase !== 'lobby') return cb({ err: 'La partida ya empezó' });
      if (r.players.length >= maxPlayers(r)) return cb({ err: 'Sala llena (máx. ' + maxPlayers(r) + ')' });
      const nm = String(name || '').trim().slice(0, 14) || 'Jugador ' + (r.players.length + 1);
      p = { id: 'p' + (++pidSeq), tok, name: nm, money: moneyOf(r), roster: [], cast: {}, chars: {}, on: true, sid: null, tname: null, rivals: [], form: '433' };
      r.players.push(p);
      if (!r.hostId) r.hostId = p.id;
    }
    attach(r, p);
    cb({ ok: true, id: p.id, code: r.code });
    s.emit('chatHistory', r.chat);
    push(r);
  }

  s.on('create', ({ name, tok }, cb) => {
    const r = {
      code: newCode(), chat: [], mode: 'f', gm: 'std', theme: null, auc: 'open', sealed: {}, reveal: null, dif: 1, vol: 70, vv: 25, phase: 'lobby', players: [], used: new Set(),
      cur: null, bid: 0, bidder: null, last: null, offers: [], oid: 0, votes: {}, results: null,
      timer: null, endsAt: 0, hostId: null, gc: null
    };
    rooms[r.code] = r;
    joinRoom(r, name, tok, cb);
  });

  s.on('join', ({ code, name, tok }, cb) => {
    const r = rooms[String(code || '').toUpperCase().trim()];
    if (!r) return cb({ err: 'Sala no encontrada' });
    joinRoom(r, name, tok, cb);
  });

  s.on('settings', d => {
    const { r } = hostCtx(); if (!r || !d) return;
    if (typeof d.vol === 'number') r.vol = clamp(d.vol, 0, 100);
    if (typeof d.vv === 'number') r.vv = clamp(d.vv, 1, 100);
    if ([0, 1, 2].includes(+d.dif)) r.dif = +d.dif;
    if (r.phase === 'lobby' && (d.mode === 'f' || d.mode === 'k' || d.mode === 'b')) r.mode = d.mode;
    if (['lobby', 'idle', 'sold'].includes(r.phase) && (d.auc === 'open' || d.auc === 'blind')) r.auc = d.auc;
    if (r.phase === 'lobby' && ['std', 'cast', 'tema', 'versus', 'best', 'xi', 'sim'].includes(d.gm)) r.gm = d.gm;
    if (r.phase === 'lobby' && (d.jury === 3 || d.jury === 5)) r.jury = d.jury;
    if (r.phase === 'lobby' && typeof d.career === 'boolean') r.career = d.career && r.players.length <= CAREER_MAX_PLAYERS; // Modo Carrera (solo con Simulaciones)
    if ((r.gm === 'cast' || r.gm === 'tema') && r.mode !== 'k') r.gm = 'std'; // cast y amar tema solo existen con Frikirappers
    if ((r.gm === 'versus' || r.gm === 'sim') && r.mode !== 'f') r.gm = 'std'; // versus y simulaciones solo existen con Freestylers
    if (r.mode === 'b') { if (r.gm !== 'xi' && r.gm !== 'best') r.gm = 'xi'; } // Blue Lock: «armar 11» o «armar el mejor»
    else if (r.gm === 'xi') r.gm = 'std';
    if (r.phase === 'lobby') r.players.forEach(p => p.money = moneyOf(r));
    push(r);
  });

  s.on('start', () => {
    const { r } = hostCtx(); if (!r || r.phase !== 'lobby' || r.players.length < (r.gm === 'sim' ? 1 : 2)) return;
    if ((r.gm === 'cast' || r.gm === 'tema') && r.mode !== 'k') r.gm = 'std';
    if ((r.gm === 'versus' || r.gm === 'sim') && r.mode !== 'f') r.gm = 'std';
    { // ruleta: ¿freestylers de TWB o élite? (solo con Freestylers, en cualquier modo de partida)
      const prev = r.fset;
      r.fset = r.mode === 'f' ? (Math.random() < 0.5 ? 'twb' : 'elite') : null;
      r.fsetId = Date.now();
      if (prev !== r.fset) r.used.clear();
    }
    if (r.gm === 'sim') { if (r.players.length > maxPlayers(r)) return; return simStart(r); } // simulaciones: sin subasta
    if (r.mode === 'b') { if (r.gm !== 'xi' && r.gm !== 'best') r.gm = 'xi'; } else if (r.gm === 'xi') r.gm = 'std';
    r.theme = r.gm === 'cast' ? THEMES[Math.floor(Math.random() * THEMES.length)]
      : r.gm === 'best' ? { name: 'ARMAR EL MEJOR', roles: BEST[r.mode].map(c => [Math.random(), c]).sort((a, b) => a[0] - b[0]).slice(0, BEST_PICK).map(x => x[1]).sort((a, b) => BEST[r.mode].indexOf(a) - BEST[r.mode].indexOf(b)) }
      : null;
    r.order = null;
    if (r.gm === 'tema') {
      const t = buildTema('AMAR TEMA'); r.theme = t.theme; r.order = t.order;
      // cada jugador recibe una temática distinta (si hay más jugadores que temáticas, se vuelven a repartir)
      let bag = [];
      r.players.forEach(p => {
        if (!bag.length) bag = [...TEMA_THEMES].sort(() => Math.random() - 0.5);
        p.tname = bag.pop();
      });
    }
    r.curSlot = null; r.market = false; r.sales = 0;
    r.players.forEach(p => { p.money = moneyOf(r); p.roster = []; p.cast = {}; p.chars = {}; p.rivals = []; p.form = (p.bot && Math.random() < 0.5) ? '442' : '433'; });
    if (r.gm === 'tema' || r.gm === 'versus' || poolOf(r).filter(n => !r.used.has(key(n))).length < r.players.length * goalOf(r)) r.used.clear();
    if (r.gm === 'versus') { // 5 rivales distintos para cada jugador, sacados de la bolsa y apartados de la subasta
      let bag = [...fPool(r)].sort(() => Math.random() - 0.5);
      r.players.forEach(p => {
        if (bag.length < GOAL) { // con muchos jugadores la bolsa puede agotarse: se rellena (sin repetir nombres dentro de los 5 del mismo jugador)
          const left = new Set(bag.map(key));
          bag = [...bag, ...[...fPool(r)].sort(() => Math.random() - 0.5).filter(n => !left.has(key(n)))];
        }
        p.rivals = bag.splice(0, GOAL); p.rivals.forEach(n => r.used.add(key(n)));
      });
    }
    r.phase = 'idle';
    push(r);
  });

  s.on('next', () => {
    const { r } = hostCtx(); if (!r || !['idle', 'sold'].includes(r.phase)) return;
    if (allDone(r)) { r.phase = 'trade'; r.last = null; return push(r); }
    startAuction(r);
  });

  s.on('repeat', () => {
    const { r } = hostCtx(); if (!r || r.phase !== 'auction' || r.paused || r.plays >= MAX_PLAYS) return;
    r.plays++;
    io.to(r.code).emit('play', { text: r.lastAudioText, pitch: r.lastPitch || 1, delay: 0, rep: true });
    push(r);
  });

  s.on('openBids', () => {
    const { r } = hostCtx(); if (!r || r.phase !== 'auction' || r.bidsOpen || r.paused) return;
    r.bidsOpen = true;
    r.endsAt = Date.now() + OPEN_MS;
    clearTimeout(r.timer);
    r.timer = setTimeout(() => close(r), OPEN_MS);
    push(r);
    botTick(r);
  });

  s.on('pause', () => {
    const { r } = hostCtx(); if (!r || r.phase !== 'auction') return;
    if (!r.paused) {
      r.paused = true;
      if (r.bidsOpen) { r.pausedLeft = Math.max(0, r.endsAt - Date.now()); clearTimeout(r.timer); }
    } else {
      r.paused = false;
      if (r.bidsOpen) { r.endsAt = Date.now() + r.pausedLeft; r.timer = setTimeout(() => close(r), r.pausedLeft); }
    }
    push(r);
    botTick(r);
  });

  s.on('bid', n => {
    const { r, p } = ctxOf(); if (!r || !p) return;
    doBid(r, p, n);
  });

  // ---- Cast ----
  s.on('place', ({ name, role } = {}) => {
    const { r, p } = ctxOf();
    if (!r || !p || ['lobby', 'vote', 'end'].includes(r.phase)) return;
    const roles = rolesOf(r, p); if (!roles) return;
    if (!p.roster.includes(name)) return;
    if (role !== null && !roles.includes(role)) return;
    for (const k of Object.keys(p.cast)) if (p.cast[k] === name) delete p.cast[k];
    if (role !== null) p.cast[role] = name; // si el puesto estaba ocupado, el anterior queda sin colocar
    push(r);
  });

  // ---- Armar 11: elegir formación ----
  s.on('form', f => {
    const { r, p } = ctxOf();
    if (!r || !p || r.gm !== 'xi' || ['lobby', 'vote', 'end'].includes(r.phase) || !FORMS[f]) return;
    p.form = f;
    for (const k of Object.keys(p.cast)) if (!FORMS[f].includes(k)) delete p.cast[k]; // los puestos que ya no existen quedan sin colocar
    push(r);
  });

  // ---- Chat ----
  s.on('chat', text => {
    const { r, p } = ctxOf(); if (!r || !p) return;
    text = String(text || '').replace(/\s+/g, ' ').trim().slice(0, CHAT_LEN);
    const now = Date.now();
    if (!text || now - (p.lastChat || 0) < CHAT_GAP) return;
    p.lastChat = now;
    const m = { from: p.id, name: p.name, text, t: now };
    r.chat.push(m);
    if (r.chat.length > CHAT_MAX) r.chat.shift();
    io.to(r.code).emit('chat', m);
  });

  // ---- Amar tema: personaje de cada participante ----
  s.on('char', ({ slot, text } = {}) => {
    const { r, p } = ctxOf();
    if (!r || !p || r.gm !== 'tema' || !r.theme || ['lobby', 'vote', 'end'].includes(r.phase)) return;
    if (!r.theme.charSlots.includes(slot)) return;
    p.chars[slot] = String(text || '').slice(0, 30);
    push(r);
  });

  // ---- Intercambios ----
  s.on('offer', ({ to, give, want, cash, cdir } = {}) => {
    const { r, p } = ctxOf(); if (!r || !p || !marketOpen(r)) return;
    const t = find(r, to);
    if (!t || t.id === p.id) return;
    give = give || null; want = want || null;
    if (give && !p.roster.includes(give)) return;
    if (want && !t.roster.includes(want)) return;
    if (r.gm === 'xi') {
      // en «armar 11» se puede añadir dinero: «pago» (yo pongo) o «pido» (el otro pone)
      cash = Math.min(999, Math.max(0, Math.floor(+cash) || 0));
      if (cdir !== 'pay' && cdir !== 'ask') cdir = 'pay';
      if (!give && !want) return;
      if (!give && !(cash > 0 && cdir === 'pay')) return; // comprar un personaje: hay que pagar
      if (!want && !(cash > 0 && cdir === 'ask')) return; // vender un personaje: hay que pedir dinero
      if (cash > 0 && (cdir === 'pay' ? p : t).money < cash) return; // quien paga debe tener el dinero
    } else {
      if (!give || !want) return;
      cash = 0; cdir = null;
    }
    if (r.offers.filter(o => o.from === p.id).length >= 6) return;
    const o = { id: ++r.oid, from: p.id, to: t.id, give, want, cash, cdir };
    r.offers.push(o);
    push(r);
    botReply(r, o);
  });

  s.on('respond', ({ id, ok } = {}) => {
    const { r, p } = ctxOf(); if (!r || !p) return;
    respondOffer(r, p, id, ok);
  });

  // ---- Votación ----
  s.on('voteStart', () => {
    const { r } = hostCtx(); if (!r || r.phase !== 'trade') return;
    autofill(r);
    r.phase = 'vote'; r.votes = {}; r.offers = [];
    push(r);
    botVotes(r);
  });
  s.on('vote', ranking => {
    const { r, p } = ctxOf(); if (!r || !p || r.phase !== 'vote' || p.id in r.votes) return;
    const others = r.players.filter(q => q.id !== p.id).map(q => q.id);
    if (!Array.isArray(ranking) || ranking.length !== others.length || new Set(ranking).size !== others.length || !ranking.every(id => others.includes(id))) return;
    r.votes[p.id] = ranking;
    if (r.players.filter(q => q.on).every(q => r.votes[q.id])) return finishVote(r);
    push(r);
  });
  s.on('voteEnd', () => {
    const { r } = hostCtx(); if (!r || r.phase !== 'vote') return;
    finishVote(r);
  });

  s.on('restart', () => {
    const { r } = hostCtx(); if (!r || !(r.phase === 'end' || (r.phase === 'sim' && r.sim && r.sim.step === 'end'))) return;
    toLobby(r);
  });

  // ---- Simulaciones: jurado y avance de la temporada ----
  s.on('simVote', c => {
    const { r, p } = ctxOf(); if (!r || !p || r.phase !== 'sim' || !r.sim) return;
    const S = r.sim; if (S.step !== 'vote') return;
    if (!['a', 'b', 'r'].includes(c) || (c === 'r' && S.round === 2)) return;
    const i = S.jurors.findIndex(j => j.k === 'p' && j.id === p.id);
    if (i < 0 || i in S.votes) return;
    S.votes[i] = c;
    simCheck(r);
  });
  s.on('simLeagueVote', c => { // voto de las 4 (cortes) o 5 (grupos) mejores ligas
    const { r, p } = ctxOf(); if (!r || !p || r.phase !== 'sim' || !r.sim || r.sim.step !== 'lvote') return;
    const S = r.sim;
    if (!S.intl || !Array.isArray(c) || c.length !== S.intl.nl || p.id in S.lvotes) return;
    if (!c.every(x => Number.isInteger(x) && x >= 0 && x < S.leagues.length) || new Set(c).size !== S.intl.nl) return;
    S.lvotes[p.id] = c.slice();
    simLeagueCheck(r);
  });
  s.on('simSkip', () => { // el anfitrión da por votados (al azar) a los que faltan
    const { r } = hostCtx(); if (!r || r.phase !== 'sim' || !r.sim) return;
    if (r.sim.step === 'fmt') { r.players.filter(p => !p.bot && p.on && !r.sim.fmt.votes[p.id]).forEach(p => { r.sim.fmt.votes[p.id] = Math.random() < 0.5 ? 'dbl' : 'nrm'; }); return simFmtAuto(r); }
    if (r.sim.step === 'lpick') { const L = r.sim.lp; if (L && L.idx < L.order.length) simLpPick(r, L.order[L.idx], null); return simLpAuto(r); }
    if (r.sim.step === 'ev') { const ev = r.sim.ev; if (ev && !ev.done) simEventResolve(r, simEventRandomChoice(r.sim, ev)); return; }
    if (r.sim.step === 'rr') { const R = r.sim.rr; if (R) r.players.forEach(p => { R.done[p.id] = true; }); return simRrAuto(r); }
    if (r.sim.step === 'kopick') { const K = r.sim.kp; if (K && !K.done) simKoPlace(r, simKpBot(r.sim, K.order[K.idx])); return simKoPickAuto(r); }
    if (r.sim.step === 'dft') { const D = r.sim.dft; if (D && D.prop) simDraftResolve(r, Math.random() < 0.5); else if (D && D.idx < D.order.length) simDraftRandom(r, D.order[D.idx]); return simDraftAuto(r); }
    if (r.sim.step === 'lvote') { // quien no ha votado vota solo como un bot
      const S = r.sim; r.players.forEach(p => { if (!(p.id in S.lvotes)) { const t = S.leagues.map((_, l) => l); S.lvotes[p.id] = simShuffle(t).slice(0, S.intl.nl); } });
      return simLeagueCheck(r);
    }
    if (r.sim.step !== 'vote') return;
    const S = r.sim, bt = S.battles[S.b];
    S.jurors.forEach((j, i) => { if (!(i in S.votes)) S.votes[i] = simAi(simCacheOf(S, bt, 'a'), simCacheOf(S, bt, 'b'), S.round === 1); });
    simAutoVotes(r); simCheck(r);
  });
  s.on('simFmt', v => { // voto: jornada normal ('nrm') o doble ('dbl')
    const { r, p } = ctxOf(); if (!r || !p || r.phase !== 'sim' || !r.sim || r.sim.step !== 'fmt') return;
    if (v !== 'nrm' && v !== 'dbl') return;
    r.sim.fmt.votes[p.id] = v;
    simFmtAuto(r);
  });
  s.on('simLeaguePick', name => { // TWB: el jugador elige su liga
    const { r, p } = ctxOf(); if (!r || !p || r.phase !== 'sim' || !r.sim || r.sim.step !== 'lpick') return;
    const L = r.sim.lp; if (!L || L.idx >= L.order.length || L.order[L.idx] !== p.id) return;
    if (!simLpPick(r, p.id, String(name))) return;
    simLpAuto(r);
  });
  s.on('simEvent', c => { // decisión del jugador afectado por el evento
    const { r, p } = ctxOf(); if (!r || !p || r.phase !== 'sim' || !r.sim || r.sim.step !== 'ev') return;
    const ev = r.sim.ev; if (!ev || ev.done || ev.pid !== p.id) return;
    simEventResolve(r, c);
  });
  s.on('simDraft', ({ take, give, pass } = {}) => { // turno del draft: propone un intercambio (o pasa)
    const { r, p } = ctxOf(); if (!r || !p || r.phase !== 'sim' || !r.sim || r.sim.step !== 'dft') return;
    const D = r.sim.dft; if (!D || D.prop || D.idx >= D.order.length || D.order[D.idx] !== p.id) return;
    if (pass) { D.log.push({ pid: p.id, pass: true }); D.idx++; }
    else if (!simDraftPropose(r, p.id, String(take), String(give))) return;
    simDraftAuto(r);
  });
  s.on('simDraftAns', ok => { // el dueño de la otra liga acepta o rechaza
    const { r, p } = ctxOf(); if (!r || !p || r.phase !== 'sim' || !r.sim || r.sim.step !== 'dft') return;
    const D = r.sim.dft; if (!D || !D.prop || D.prop.to !== p.id) return;
    simDraftResolve(r, !!ok);
    simDraftAuto(r);
  });
  s.on('simRr', cancel => { // cancelar contratos antes del draft
    const { r, p } = ctxOf(); if (!r || !p || r.phase !== 'sim' || !r.sim || r.sim.step !== 'rr') return;
    const R = r.sim.rr; if (!R || R.done[p.id]) return;
    const mine = r.sim.leagues.filter(l => l.ownerId === p.id); if (!mine.length) return;
    const teams = mine.flatMap(l => l.teams); // hasta RR_MAX despidos por cada liga que lleves
    const list = [...new Set(Array.isArray(cancel) ? cancel.map(String) : [])].filter(n => teams.includes(n) && !(r.sim.keep || []).includes(n)).slice(0, RR_MAX * mine.length);
    R.sel[p.id] = list; R.done[p.id] = true;
    simRrAuto(r);
  });
  s.on('simKoPick', slot => { // octavos: el representante de la liga del clasificado que ha salido elige batalla
    const { r, p } = ctxOf(); if (!r || !p || r.phase !== 'sim' || !r.sim || r.sim.step !== 'kopick') return;
    const K = r.sim.kp; if (!K || K.done) return;
    const x = K.order[K.idx]; if (r.sim.leagues[x.l].ownerId !== p.id) return;
    if (!Number.isInteger(slot) || !simKoPlace(r, slot)) return;
    simKoPickAuto(r);
  });
  s.on('simSeason2', () => { // el anfitrión abre la siguiente temporada al acabar la actual (la 2; en el Modo Carrera también la 3)
    const { r } = hostCtx(); if (!r || r.phase !== 'sim' || !r.sim) return;
    simSeason2Begin(r);
  });
  s.on('simNext', () => {
    const { r } = hostCtx(); if (!r || r.phase !== 'sim' || !r.sim) return;
    simNextStep(r);
  });

  // ---- Bots ----
  s.on('addBot', () => {
    const { r } = hostCtx(); if (!r || r.phase !== 'lobby' || r.players.length >= maxPlayers(r)) return;
    const taken = new Set(r.players.map(q => q.name));
    const nm = '🤖 ' + (BOT_NAMES.find(n => !taken.has('🤖 ' + n)) || 'Bot ' + (r.players.length + 1));
    const id = 'p' + (++pidSeq);
    r.players.push({ id, tok: 'bot-' + id, name: nm, money: moneyOf(r), roster: [], cast: {}, chars: {}, on: true, sid: null, tname: null, rivals: [], form: '433', bot: true, max: 0, bt: null });
    push(r);
  });

  // ---- Sacar de la sala a un jugador desconectado (solo el anfitrión) ----
  s.on('kick', id => {
    const { r, p } = hostCtx(); if (!r) return;
    const t = find(r, id);
    if (!t || t.id === p.id || (t.on && !t.bot)) return; // solo se puede sacar a quien está sin conexión (o a un bot)
    removePlayer(r, t);
  });

  s.on('disconnect', () => {
    const x = bySock[s.id]; delete bySock[s.id]; if (!x) return;
    const r = rooms[x.code]; if (!r) return;
    const p = find(r, x.pid); if (!p || p.sid !== s.id) return;
    p.on = false;
    if (r.phase === 'lobby') r.players = r.players.filter(q => q !== p);
    if (r.hostId === p.id) { const n = r.players.find(q => q.on && !q.bot); if (n) r.hostId = n.id; }
    if (!r.players.some(q => q.on && !q.bot)) {
      r.gc = setTimeout(() => { clearTimeout(r.timer); delete rooms[r.code]; }, 10 * 60 * 1000);
    } else {
      if (r.phase === 'auction' && r.auc === 'blind' && Object.keys(r.sealed).length && eligible(r).filter(q => q.on).every(q => q.id in r.sealed)) return closeBlind(r);
      if (r.phase === 'vote' && r.players.filter(q => q.on).every(q => r.votes[q.id])) return finishVote(r);
      if (r.phase === 'sim' && r.sim && ['vote', 'lvote', 'ev', 'dft', 'lpick', 'rr', 'fmt', 'kopick'].includes(r.sim.step)) return simPending(r);
      push(r);
    }
  });
});

// <<< ENGINE END
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log('Subasta a sordas escuchando en el puerto ' + PORT));
