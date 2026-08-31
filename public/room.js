// Page duel : rejoint la salle en WebSocket, gère les écrans et les
// animations. Le serveur est l'autorité ; ici on ne fait que de l'affichage.

const PSEUDO_KEY = 'chifoumi:pseudo';
const roomId = location.pathname.split('/').pop();
const TOKEN_KEY = `chifoumi:token:${roomId}`;

const EMOJI = { pierre: '✊', feuille: '✋', ciseaux: '✌️' };

const $ = (id) => document.getElementById(id);
const screens = {
  notfound: $('screen-notfound'),
  full: $('screen-full'),
  join: $('screen-join'),
  game: $('screen-game'),
};

let ws = null;
let token = null;
let mySeat = -1;
let state = null;
let animating = false;
let pendingRender = false;
let dead = false; // duel introuvable ou complet : on ne se reconnecte pas
let reconnectDelay = 1000;

function storageGet(key) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function storageSet(key, value) {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* ignore */
  }
}

function randomToken() {
  if (crypto.randomUUID) return crypto.randomUUID();
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) =>
    b.toString(16).padStart(2, '0')
  ).join('');
}

function show(name) {
  for (const [key, el] of Object.entries(screens)) {
    el.classList.toggle('hidden', key !== name);
  }
}

// Pancarte d'enjeu : visible dans tous les états dès que l'enjeu est connu.
function setStake(stake) {
  const banner = $('stake-banner');
  if (stake) {
    $('stake-text').textContent = stake;
    banner.classList.remove('hidden');
  } else {
    banner.classList.add('hidden');
  }
}

// ---------- Connexion ----------

function connect(joinName) {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${proto}://${location.host}/ws/${roomId}`);

  ws.addEventListener('open', () => {
    reconnectDelay = 1000;
    $('conn-status').textContent = '';
    ws.send(JSON.stringify({ type: 'join', token, name: joinName || undefined }));
  });

  ws.addEventListener('message', (event) => {
    let msg;
    try {
      msg = JSON.parse(event.data);
    } catch {
      return;
    }
    handleMessage(msg);
  });

  ws.addEventListener('close', () => {
    if (dead) return;
    $('conn-status').textContent = 'Connexion perdue, reconnexion…';
    setTimeout(() => connect(), reconnectDelay);
    reconnectDelay = Math.min(reconnectDelay * 1.5, 8000);
  });
}

function handleMessage(msg) {
  switch (msg.type) {
    case 'joined':
      mySeat = msg.seat;
      state = msg.state;
      render();
      break;
    case 'state':
      state = msg.state;
      if (msg.rematch) resetRoundUI();
      scheduleRender();
      break;
    case 'reveal':
      state = msg.state;
      playReveal(msg.reveal);
      break;
    case 'error':
      handleError(msg.code);
      break;
  }
}

function handleError(code) {
  if (code === 'duel_complet') {
    dead = true;
    show('full');
  } else if (code === 'duel_introuvable') {
    dead = true;
    show('notfound');
  }
  // Les autres erreurs (choix invalide, etc.) sont silencieuses : l'état
  // suivant remet l'interface d'aplomb.
}

// ---------- Rendu ----------

function scheduleRender() {
  if (animating) {
    pendingRender = true;
    return;
  }
  render();
}

function render() {
  if (!state || mySeat === -1) return;
  show('game');
  setStake(state.stake);

  const me = state.players[mySeat];
  const opp = state.players[1 - mySeat];
  const waiting = state.seats < 2;
  const over = state.phase === 'over';

  // Ligne adversaire, compacte : « Marie ✅ a choisi »
  const oppLine = $('opp-line');
  if (!opp || over) {
    oppLine.textContent = '';
  } else if (!opp.connected) {
    oppLine.textContent = `${opp.name} 🔌 déconnecté·e…`;
  } else if (state.phase === 'playing') {
    oppLine.textContent = opp.hasChosen
      ? `${opp.name} ✅ a choisi`
      : `${opp.name} 🤔 réfléchit…`;
  } else {
    oppLine.textContent = `${opp.name} est là !`;
  }

  // Score / manche : seulement quand ça apporte quelque chose.
  const chip = $('score-chip');
  const total = (me ? me.score : 0) + (opp ? opp.score : 0);
  let chipVisible = !!opp && (state.bestOf > 1 || total > 0);
  if (over && state.bestOf === 1) chipVisible = false;
  if (chipVisible) {
    let text = `Toi ${me.score} — ${opp.score} ${opp.name}`;
    if (state.phase === 'playing' && state.bestOf > 1) {
      text += ` · Manche ${state.round}/${state.bestOf}`;
    }
    chip.textContent = text;
  }
  chip.classList.toggle('hidden', !chipVisible);

  // Partage du lien tant que l'adversaire n'est pas là.
  $('share-card').classList.toggle('hidden', !waiting);

  // Invite au-dessus des mains.
  const myChoice = state.you ? state.you.choice : null;
  const prompt = $('prompt');
  if (state.phase === 'playing' && opp) {
    if (myChoice) {
      prompt.textContent = `${EMOJI[myChoice]} Choix posé !`;
      prompt.classList.remove('go');
    } else {
      prompt.textContent = 'À toi de jouer 👇';
      prompt.classList.add('go');
    }
  } else {
    prompt.textContent = '';
  }

  // Boutons.
  const playable = state.phase === 'playing' && !animating;
  for (const btn of document.querySelectorAll('.hand')) {
    btn.disabled = !playable;
    btn.classList.toggle('selected', myChoice === btn.dataset.choice);
  }
  $('hands').classList.toggle('hidden', waiting || over);
  $('rematch-btn').classList.toggle('hidden', !over);
  $('home-link').classList.toggle('hidden', !over);

  // Fin de duel.
  if (over && !animating) {
    showFinal();
  } else if (!over) {
    $('final').classList.add('hidden');
  }
}

function showFinal() {
  const winner = state.players[state.winner];
  const loser = state.players[1 - state.winner];
  const iWon = state.winner === mySeat;
  $('final-emoji').textContent = iWon ? '🏆' : '😵';
  $('final-title').textContent = iWon ? 'Tu gagnes !' : `${winner.name} gagne !`;
  const stakeEl = $('final-stake');
  if (state.stake && loser) {
    stakeEl.textContent = `😬 ${iWon ? loser.name : 'Toi'}, celui qui perd : ${state.stake}`;
    stakeEl.classList.remove('hidden');
  } else {
    stakeEl.classList.add('hidden');
  }
  $('final').classList.remove('hidden');
}

function resetRoundUI() {
  $('arena').classList.add('hidden');
  $('countdown').classList.add('hidden');
  $('result-text').textContent = '';
  $('final').classList.add('hidden');
}

// ---------- Révélation : 3, 2, 1… puis les deux coups en même temps ----------

function playReveal(reveal) {
  animating = true;
  for (const btn of document.querySelectorAll('.hand')) btn.disabled = true;
  $('prompt').textContent = '';
  $('opp-line').textContent = '';
  $('result-text').textContent = '';
  $('arena').classList.add('hidden');

  const countdown = $('countdown');
  countdown.classList.remove('hidden');

  const ticks = ['3', '2', '1'];
  let i = 0;
  const step = () => {
    if (i < ticks.length) {
      countdown.innerHTML = `<span class="tick">${ticks[i]}</span>`;
      i += 1;
      setTimeout(step, 550);
    } else {
      countdown.classList.add('hidden');
      revealHands(reveal);
    }
  };
  step();
}

function revealHands(reveal) {
  const myChoice = reveal.choices[mySeat];
  const oppChoice = reveal.choices[1 - mySeat];
  $('arena-you').textContent = EMOJI[myChoice];
  $('arena-opp').textContent = EMOJI[oppChoice];
  const oppName = state.players[1 - mySeat]?.name;
  $('arena-opp-name').textContent = oppName || 'Adversaire';
  const arena = $('arena');
  arena.classList.remove('hidden');

  const resultEl = $('result-text');
  let holdMs;
  if (reveal.tie) {
    resultEl.textContent = '🤝 Égalité ! On rejoue…';
    holdMs = 1600;
  } else if (reveal.gameOver) {
    resultEl.textContent = '';
    holdMs = 1200;
  } else {
    const iWonRound = reveal.winnerSeat === mySeat;
    const winnerName = state.players[reveal.winnerSeat]?.name ?? '';
    resultEl.textContent = iWonRound
      ? '🎉 Tu remportes la manche !'
      : `💥 ${winnerName} remporte la manche !`;
    holdMs = 1800;
  }

  setTimeout(() => {
    animating = false;
    if (!reveal.gameOver) {
      arena.classList.add('hidden');
      if (!reveal.tie) resultEl.textContent = '';
    }
    if (pendingRender) pendingRender = false;
    render();
  }, holdMs);
}

// ---------- Actions ----------

$('hands').addEventListener('click', (e) => {
  const btn = e.target.closest('.hand');
  if (!btn || btn.disabled || !ws || ws.readyState !== 1) return;
  ws.send(JSON.stringify({ type: 'choose', choice: btn.dataset.choice }));
  // Retour visuel immédiat, confirmé par le prochain état serveur.
  for (const b of document.querySelectorAll('.hand')) {
    b.classList.toggle('selected', b === btn);
  }
  const prompt = $('prompt');
  prompt.textContent = `${EMOJI[btn.dataset.choice]} Choix posé !`;
  prompt.classList.remove('go');
});

$('rematch-btn').addEventListener('click', () => {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type: 'rematch' }));
});

// Partage du lien
$('share-url').value = location.href;
$('copy-btn').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(location.href);
    $('copy-feedback').textContent = 'Lien copié ✅';
  } catch {
    $('share-url').select();
    document.execCommand('copy');
    $('copy-feedback').textContent = 'Lien copié ✅';
  }
  setTimeout(() => ($('copy-feedback').textContent = ''), 2500);
});
if (navigator.share) {
  $('share-btn').classList.remove('hidden');
  $('share-btn').addEventListener('click', () => {
    navigator.share({ title: 'Chifoumi', text: 'Je te défie en duel !', url: location.href }).catch(() => {});
  });
}

// ---------- Démarrage ----------

const savedToken = storageGet(TOKEN_KEY);
const savedPseudo = storageGet(PSEUDO_KEY) || '';

if (savedToken) {
  // Créateur ou joueur qui revient : reprise directe du siège.
  token = savedToken;
  connect(savedPseudo || undefined);
} else {
  // Visiteur sans siège : on regarde d'abord l'état de la salle pour
  // afficher le bon écran (« duel complet » pour un troisième visiteur).
  fetch(`/api/rooms/${roomId}`)
    .then((res) => {
      if (res.status === 404) throw new Error('notfound');
      if (!res.ok) throw new Error('erreur');
      return res.json();
    })
    .then((info) => {
      if (info.seats >= 2) {
        dead = true;
        show('full');
        return;
      }
      setStake(info.stake);
      show('join');
      $('join-pseudo').value = savedPseudo;
      if (info.names[0]) $('join-title').textContent = `${info.names[0]} te défie !`;
      $('join-details').textContent =
        info.bestOf === 1 ? 'Un seul coup, pas de rattrapage.' : `Meilleur des ${info.bestOf}.`;
    })
    .catch(() => {
      dead = true;
      show('notfound');
    });

  $('screen-join').addEventListener('submit', (e) => {
    e.preventDefault();
    const name = $('join-pseudo').value.trim();
    if (!name) return;
    storageSet(PSEUDO_KEY, name);
    token = randomToken();
    storageSet(TOKEN_KEY, token);
    show('game');
    connect(name);
  });
}
