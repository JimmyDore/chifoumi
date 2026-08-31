// Logique de jeu pure : aucune I/O, aucun timer, aucune WebSocket.
// Tout l'état d'un duel vit dans un objet `room` simple, manipulé par les
// fonctions ci-dessous. Le serveur (index.mjs) ne fait que du transport.

export const CHOICES = ['pierre', 'feuille', 'ciseaux'];

// Renvoie true si `a` bat `b` (a et b étant des choix valides et différents).
export function beats(a, b) {
  return (
    (a === 'pierre' && b === 'ciseaux') ||
    (a === 'ciseaux' && b === 'feuille') ||
    (a === 'feuille' && b === 'pierre')
  );
}

// Alphabet sans ambiguïté : pas de 0/o ni de 1/l.
export const ID_ALPHABET = 'abcdefghijkmnpqrstuvwxyz23456789';

export function generateRoomId(random = Math.random, length = 7) {
  let id = '';
  for (let i = 0; i < length; i++) {
    id += ID_ALPHABET[Math.floor(random() * ID_ALPHABET.length)];
  }
  return id;
}

export function createRoom({ id, stake = null, bestOf = 1, now = Date.now() }) {
  if (![1, 3, 5].includes(bestOf)) bestOf = 1;
  return {
    id,
    stake: typeof stake === 'string' && stake.trim() ? stake.trim().slice(0, 140) : null,
    bestOf,
    target: Math.ceil(bestOf / 2),
    phase: 'waiting', // 'waiting' | 'playing' | 'over'
    round: 1,
    winner: null, // index du siège vainqueur du duel
    players: [], // max 2 : { token, name, score, choice, connected }
    createdAt: now,
    lastActivity: now,
  };
}

// Rejoint (ou reprend) un siège. Le token identifie le joueur de façon
// stable : un refresh de page reprend le même siège.
export function join(room, { token, name, now = Date.now() }) {
  room.lastActivity = now;
  const existing = room.players.findIndex((p) => p.token === token);
  if (existing !== -1) {
    const player = room.players[existing];
    player.connected = true;
    if (typeof name === 'string' && name.trim()) player.name = cleanName(name);
    return { ok: true, seat: existing, resumed: true };
  }
  if (room.players.length >= 2) {
    return { ok: false, error: 'duel_complet' };
  }
  if (typeof name !== 'string' || !name.trim()) {
    return { ok: false, error: 'pseudo_requis' };
  }
  room.players.push({
    token,
    name: cleanName(name),
    score: 0,
    choice: null,
    connected: true,
  });
  if (room.players.length === 2 && room.phase === 'waiting') {
    room.phase = 'playing';
  }
  return { ok: true, seat: room.players.length - 1, resumed: false };
}

function cleanName(name) {
  return name.trim().slice(0, 24);
}

export function setConnected(room, token, connected, now = Date.now()) {
  const player = room.players.find((p) => p.token === token);
  if (player) {
    player.connected = connected;
    room.lastActivity = now;
  }
}

// Enregistre un choix. Quand les deux joueurs ont choisi, la manche est
// résolue immédiatement (le serveur est l'autorité : aucun choix ne circule
// avant que les deux soient posés).
export function choose(room, token, choice, now = Date.now()) {
  room.lastActivity = now;
  if (room.phase !== 'playing') return { ok: false, error: 'pas_en_jeu' };
  if (!CHOICES.includes(choice)) return { ok: false, error: 'choix_invalide' };
  const seat = room.players.findIndex((p) => p.token === token);
  if (seat === -1) return { ok: false, error: 'pas_dans_le_duel' };

  room.players[seat].choice = choice;

  const [a, b] = room.players;
  if (!a.choice || !b.choice) return { ok: true, revealed: false };

  // Les deux ont choisi : résolution.
  const choices = [a.choice, b.choice];
  const round = room.round;
  a.choice = null;
  b.choice = null;

  if (choices[0] === choices[1]) {
    // Égalité : on rejoue la manche, score inchangé.
    return {
      ok: true,
      revealed: true,
      reveal: { choices, round, tie: true, winnerSeat: null, gameOver: false },
    };
  }

  const winnerSeat = beats(choices[0], choices[1]) ? 0 : 1;
  room.players[winnerSeat].score += 1;
  const gameOver = room.players[winnerSeat].score >= room.target;
  if (gameOver) {
    room.phase = 'over';
    room.winner = winnerSeat;
  } else {
    room.round += 1;
  }
  return {
    ok: true,
    revealed: true,
    reveal: { choices, round, tie: false, winnerSeat, gameOver },
  };
}

// Revanche : même salle, mêmes joueurs, mêmes réglages, scores remis à zéro.
export function rematch(room, now = Date.now()) {
  room.lastActivity = now;
  if (room.phase !== 'over') return { ok: false, error: 'duel_pas_fini' };
  for (const p of room.players) {
    p.score = 0;
    p.choice = null;
  }
  room.round = 1;
  room.winner = null;
  room.phase = room.players.length === 2 ? 'playing' : 'waiting';
  return { ok: true };
}

// État visible par UN joueur : son propre choix est visible, celui de
// l'adversaire est réduit à un booléen `hasChosen` tant que la manche n'est
// pas résolue.
export function publicState(room, token) {
  const seat = room.players.findIndex((p) => p.token === token);
  return {
    id: room.id,
    stake: room.stake,
    bestOf: room.bestOf,
    target: room.target,
    phase: room.phase,
    round: room.round,
    winner: room.winner,
    seats: room.players.length,
    you:
      seat === -1
        ? null
        : { seat, name: room.players[seat].name, choice: room.players[seat].choice },
    players: room.players.map((p) => ({
      name: p.name,
      score: p.score,
      hasChosen: p.choice !== null,
      connected: p.connected,
    })),
  };
}
