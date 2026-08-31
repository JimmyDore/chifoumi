// Serveur Chifoumi : UN processus qui sert le front statique ET la WebSocket.
// Les salles vivent en mémoire (Map) avec un TTL d'inactivité d'environ 1h.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import fastifyWebsocket from '@fastify/websocket';
import {
  createRoom,
  generateRoomId,
  join,
  choose,
  rematch,
  setConnected,
  publicState,
} from './game.mjs';

const PORT = Number(process.env.PORT) || 8787;
const ROOM_TTL_MS = 60 * 60 * 1000; // 1h d'inactivité
const SWEEP_INTERVAL_MS = 5 * 60 * 1000;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, '..', 'public');

// roomId → { room, sockets: Map<token, WebSocket> }
const rooms = new Map();

function newRoomId() {
  let id;
  do {
    id = generateRoomId();
  } while (rooms.has(id));
  return id;
}

function broadcast(entry, extra = null, exceptToken = null) {
  for (const [token, ws] of entry.sockets) {
    if (ws.readyState !== 1 || token === exceptToken) continue;
    const payload = { type: 'state', state: publicState(entry.room, token) };
    if (extra) Object.assign(payload, extra);
    ws.send(JSON.stringify(payload));
  }
}

function send(ws, payload) {
  if (ws.readyState === 1) ws.send(JSON.stringify(payload));
}

// Balayage périodique des salles inactives.
const sweeper = setInterval(() => {
  const now = Date.now();
  for (const [id, entry] of rooms) {
    if (now - entry.room.lastActivity > ROOM_TTL_MS) {
      for (const ws of entry.sockets.values()) {
        try {
          ws.close(1000, 'salle expirée');
        } catch {
          /* déjà fermée */
        }
      }
      rooms.delete(id);
    }
  }
}, SWEEP_INTERVAL_MS);
sweeper.unref();

const app = Fastify({ logger: true });

await app.register(fastifyWebsocket);

// Statique : les assets peuvent être cachés normalement, mais JAMAIS les
// pages HTML (leçon apprise à la dure sur music-bingo : un index.html mis en
// cache sert un vieux front après déploiement).
await app.register(fastifyStatic, {
  root: PUBLIC_DIR,
  prefix: '/',
  index: false,
  maxAge: '1d',
  setHeaders(reply, filePath) {
    if (filePath.endsWith('.html')) {
      reply.header('cache-control', 'no-cache');
    }
  },
});

app.get('/health', async () => ({ ok: true }));

app.get('/', (req, reply) => reply.sendFile('index.html'));
app.get('/r/:roomId', (req, reply) => reply.sendFile('room.html'));

// Création d'un duel : le créateur est assis d'office (siège 0) avec son
// token, généré côté client et gardé en localStorage.
app.post('/api/rooms', async (req, reply) => {
  const body = req.body ?? {};
  const name = typeof body.name === 'string' ? body.name : '';
  const token = typeof body.token === 'string' ? body.token : '';
  const stake = typeof body.stake === 'string' ? body.stake : null;
  const bestOf = Number(body.bestOf);

  if (!name.trim() || !token || token.length > 100) {
    reply.code(400);
    return { error: 'pseudo_et_token_requis' };
  }

  const id = newRoomId();
  const room = createRoom({ id, stake, bestOf });
  const seated = join(room, { token, name });
  if (!seated.ok) {
    reply.code(400);
    return { error: seated.error };
  }
  // Le créateur n'est pas encore connecté en WebSocket.
  setConnected(room, token, false);
  rooms.set(id, { room, sockets: new Map() });
  reply.code(201);
  return { roomId: id };
});

// Infos publiques d'une salle : permet à la page duel d'afficher le bon
// écran (formulaire de pseudo, « duel complet », introuvable) avant de
// rejoindre. Aucun choix n'est exposé ici.
app.get('/api/rooms/:roomId', async (req, reply) => {
  const entry = rooms.get(req.params.roomId);
  if (!entry) {
    reply.code(404);
    return { error: 'duel_introuvable' };
  }
  const { room } = entry;
  return {
    roomId: room.id,
    seats: room.players.length,
    stake: room.stake,
    bestOf: room.bestOf,
    names: room.players.map((p) => p.name),
  };
});

// WebSocket : messages JSON minimalistes.
//   client → serveur : {type:'join', token, name?} {type:'choose', choice} {type:'rematch'}
//   serveur → client : {type:'joined', seat, state} {type:'state', state}
//                      {type:'reveal', reveal, state} {type:'error', code}
app.register(async (instance) => {
  instance.get('/ws/:roomId', { websocket: true }, (conn, req) => {
    const ws = conn.socket ?? conn; // compat selon version de @fastify/websocket
    const { roomId } = req.params;
    let token = null;

    ws.on('message', (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return send(ws, { type: 'error', code: 'message_invalide' });
      }

      const entry = rooms.get(roomId);
      if (!entry) {
        send(ws, { type: 'error', code: 'duel_introuvable' });
        ws.close(1000, 'duel introuvable');
        return;
      }

      if (msg.type === 'join') {
        if (typeof msg.token !== 'string' || !msg.token || msg.token.length > 100) {
          return send(ws, { type: 'error', code: 'token_requis' });
        }
        const res = join(entry.room, { token: msg.token, name: msg.name });
        if (!res.ok) {
          send(ws, { type: 'error', code: res.error });
          if (res.error === 'duel_complet') ws.close(1000, 'duel complet');
          return;
        }
        token = msg.token;
        // Un ancien onglet avec le même token est supplanté.
        const old = entry.sockets.get(token);
        if (old && old !== ws) {
          try {
            old.close(1000, 'remplacé par une nouvelle connexion');
          } catch {
            /* déjà fermée */
          }
        }
        entry.sockets.set(token, ws);
        send(ws, { type: 'joined', seat: res.seat, state: publicState(entry.room, token) });
        // Les autres joueurs apprennent l'arrivée ; le nouveau venu a déjà
        // tout l'état dans `joined`.
        broadcast(entry, null, token);
        return;
      }

      // Tous les autres messages exigent d'avoir rejoint.
      if (!token) return send(ws, { type: 'error', code: 'pas_rejoint' });

      if (msg.type === 'choose') {
        const res = choose(entry.room, token, msg.choice);
        if (!res.ok) return send(ws, { type: 'error', code: res.error });
        if (res.revealed) {
          // Révélation simultanée : chacun reçoit les deux choix en même temps.
          for (const [t, sock] of entry.sockets) {
            send(sock, {
              type: 'reveal',
              reveal: res.reveal,
              state: publicState(entry.room, t),
            });
          }
        } else {
          broadcast(entry);
        }
        return;
      }

      if (msg.type === 'rematch') {
        const res = rematch(entry.room);
        if (!res.ok) return send(ws, { type: 'error', code: res.error });
        broadcast(entry, { rematch: true });
        return;
      }

      send(ws, { type: 'error', code: 'type_inconnu' });
    });

    ws.on('close', () => {
      if (!token) return;
      const entry = rooms.get(roomId);
      if (!entry) return;
      // Ne pas écraser une connexion plus récente du même joueur.
      if (entry.sockets.get(token) === ws) {
        entry.sockets.delete(token);
        setConnected(entry.room, token, false);
        broadcast(entry);
      }
    });
  });
});

try {
  await app.listen({ port: PORT, host: '0.0.0.0' });
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
