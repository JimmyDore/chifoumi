import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CHOICES,
  ID_ALPHABET,
  beats,
  generateRoomId,
  createRoom,
  join,
  choose,
  rematch,
  setConnected,
  publicState,
} from '../game.mjs';

function makeDuel({ bestOf = 1, stake = null } = {}) {
  const room = createRoom({ id: 'test123', stake, bestOf, now: 0 });
  assert.equal(join(room, { token: 'tA', name: 'Marie', now: 0 }).ok, true);
  assert.equal(join(room, { token: 'tB', name: 'Jimmy', now: 0 }).ok, true);
  return room;
}

test('matrice de résolution complète (9 combinaisons)', () => {
  const expected = {
    'pierre/pierre': null,
    'pierre/feuille': 1,
    'pierre/ciseaux': 0,
    'feuille/pierre': 0,
    'feuille/feuille': null,
    'feuille/ciseaux': 1,
    'ciseaux/pierre': 1,
    'ciseaux/feuille': 0,
    'ciseaux/ciseaux': null,
  };
  for (const a of CHOICES) {
    for (const b of CHOICES) {
      const room = makeDuel();
      choose(room, 'tA', a);
      const res = choose(room, 'tB', b);
      assert.equal(res.revealed, true, `${a}/${b} doit révéler`);
      const want = expected[`${a}/${b}`];
      if (want === null) {
        assert.equal(res.reveal.tie, true, `${a}/${b} doit être une égalité`);
      } else {
        assert.equal(res.reveal.tie, false);
        assert.equal(res.reveal.winnerSeat, want, `${a}/${b} → siège ${want}`);
      }
    }
  }
  // Cohérence de beats() lui-même.
  assert.equal(beats('pierre', 'ciseaux'), true);
  assert.equal(beats('ciseaux', 'pierre'), false);
});

test('égalité : la manche se rejoue, score inchangé, choix effacés', () => {
  const room = makeDuel({ bestOf: 3 });
  choose(room, 'tA', 'pierre');
  const res = choose(room, 'tB', 'pierre');
  assert.equal(res.reveal.tie, true);
  assert.equal(res.reveal.gameOver, false);
  assert.deepEqual(
    room.players.map((p) => p.score),
    [0, 0]
  );
  assert.equal(room.round, 1, 'même manche rejouée');
  assert.deepEqual(
    room.players.map((p) => p.choice),
    [null, null]
  );
  assert.equal(room.phase, 'playing');
});

test('coup sec (bestOf 1) : une manche gagnée termine le duel', () => {
  const room = makeDuel({ bestOf: 1 });
  choose(room, 'tA', 'feuille');
  const res = choose(room, 'tB', 'pierre');
  assert.equal(res.reveal.winnerSeat, 0);
  assert.equal(res.reveal.gameOver, true);
  assert.equal(room.phase, 'over');
  assert.equal(room.winner, 0);
});

test('meilleur des 3 : séquence complète, premier à 2', () => {
  const room = makeDuel({ bestOf: 3 });
  assert.equal(room.target, 2);

  // Manche 1 : B gagne (ciseaux battent feuille).
  choose(room, 'tA', 'feuille');
  let res = choose(room, 'tB', 'ciseaux');
  assert.equal(res.reveal.winnerSeat, 1);
  assert.equal(res.reveal.gameOver, false);
  assert.deepEqual(room.players.map((p) => p.score), [0, 1]);
  assert.equal(room.round, 2);

  // Manche 2 : égalité → rejouée.
  choose(room, 'tA', 'ciseaux');
  res = choose(room, 'tB', 'ciseaux');
  assert.equal(res.reveal.tie, true);
  assert.equal(room.round, 2, 'la manche 2 se rejoue');

  // Manche 2 (bis) : A gagne.
  choose(room, 'tA', 'pierre');
  res = choose(room, 'tB', 'ciseaux');
  assert.equal(res.reveal.winnerSeat, 0);
  assert.deepEqual(room.players.map((p) => p.score), [1, 1]);
  assert.equal(room.phase, 'playing');

  // Manche 3 : A gagne le duel.
  choose(room, 'tB', 'feuille');
  res = choose(room, 'tA', 'ciseaux');
  assert.equal(res.reveal.winnerSeat, 0);
  assert.equal(res.reveal.gameOver, true);
  assert.equal(room.phase, 'over');
  assert.equal(room.winner, 0);
  assert.deepEqual(room.players.map((p) => p.score), [2, 1]);

  // Plus aucun coup accepté une fois le duel terminé.
  assert.equal(choose(room, 'tA', 'pierre').ok, false);
});

test('un troisième joueur est rejeté (duel complet)', () => {
  const room = makeDuel();
  const res = join(room, { token: 'tC', name: 'Intrus' });
  assert.equal(res.ok, false);
  assert.equal(res.error, 'duel_complet');
  assert.equal(room.players.length, 2);
});

test('rejoin avec le même token reprend le même siège (refresh-proof)', () => {
  const room = makeDuel({ bestOf: 3 });
  choose(room, 'tA', 'pierre');
  choose(room, 'tB', 'ciseaux'); // A mène 1-0
  setConnected(room, 'tB', false);
  assert.equal(room.players[1].connected, false);

  const res = join(room, { token: 'tB', name: 'Jimmy', now: 99 });
  assert.equal(res.ok, true);
  assert.equal(res.resumed, true);
  assert.equal(res.seat, 1);
  assert.equal(room.players[1].connected, true);
  assert.deepEqual(room.players.map((p) => p.score), [1, 0], 'score conservé');
  assert.equal(room.players.length, 2, 'pas de siège en double');
});

test('le choix adverse reste caché avant la révélation', () => {
  const room = makeDuel();
  choose(room, 'tA', 'pierre');
  const forB = publicState(room, 'tB');
  assert.equal(forB.players[0].hasChosen, true);
  assert.equal('choice' in forB.players[0], false, 'jamais le choix adverse');
  assert.equal(forB.you.choice, null);
  const forA = publicState(room, 'tA');
  assert.equal(forA.you.choice, 'pierre', 'son propre choix est visible');
});

test('revanche : mêmes joueurs et réglages, scores remis à zéro', () => {
  const room = makeDuel({ bestOf: 3, stake: 'fait la vaisselle' });
  // A gagne 2-0.
  choose(room, 'tA', 'pierre');
  choose(room, 'tB', 'ciseaux');
  choose(room, 'tA', 'pierre');
  choose(room, 'tB', 'ciseaux');
  assert.equal(room.phase, 'over');

  assert.equal(rematch(room).ok, true);
  assert.equal(room.phase, 'playing');
  assert.equal(room.round, 1);
  assert.equal(room.winner, null);
  assert.deepEqual(room.players.map((p) => p.score), [0, 0]);
  assert.equal(room.stake, 'fait la vaisselle');
  assert.equal(room.bestOf, 3);

  // Pas de revanche en cours de duel.
  assert.equal(rematch(room).ok, false);
});

test('garde-fous : pseudo requis, choix invalide, inconnu au duel', () => {
  const room = createRoom({ id: 'x', bestOf: 1 });
  assert.equal(join(room, { token: 't1', name: '   ' }).ok, false);
  join(room, { token: 't1', name: 'A' });
  assert.equal(choose(room, 't1', 'pierre').ok, false, 'pas en jeu à 1 joueur');
  join(room, { token: 't2', name: 'B' });
  assert.equal(choose(room, 't1', 'puits').ok, false);
  assert.equal(choose(room, 'tX', 'pierre').ok, false);
});

test('ids de salle : 7 caractères, alphabet sans 0/o/1/l', () => {
  assert.equal(/[01ol]/.test(ID_ALPHABET), false);
  for (let i = 0; i < 200; i++) {
    const id = generateRoomId();
    assert.match(id, /^[a-km-np-z2-9]{7}$/);
  }
});
