// Page d'accueil : création d'un duel.
const PSEUDO_KEY = 'chifoumi:pseudo';

const form = document.getElementById('create-form');
const pseudoInput = document.getElementById('pseudo');
const stakeInput = document.getElementById('stake');
const createBtn = document.getElementById('create-btn');
const errorEl = document.getElementById('create-error');

// Pseudo pré-rempli depuis localStorage.
try {
  const saved = localStorage.getItem(PSEUDO_KEY);
  if (saved) pseudoInput.value = saved;
} catch {
  /* localStorage indisponible : tant pis */
}

function randomToken() {
  if (crypto.randomUUID) return crypto.randomUUID();
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) =>
    b.toString(16).padStart(2, '0')
  ).join('');
}

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const name = pseudoInput.value.trim();
  if (!name) return;

  try {
    localStorage.setItem(PSEUDO_KEY, name);
  } catch {
    /* ignore */
  }

  const token = randomToken();
  createBtn.disabled = true;
  errorEl.textContent = '';

  try {
    const res = await fetch('/api/rooms', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name,
        token,
        stake: stakeInput.value.trim() || null,
        bestOf: Number(new FormData(form).get('bestOf')),
      }),
    });
    if (!res.ok) throw new Error('création impossible');
    const { roomId } = await res.json();
    try {
      localStorage.setItem(`chifoumi:token:${roomId}`, token);
    } catch {
      /* ignore */
    }
    location.href = `/r/${roomId}`;
  } catch {
    errorEl.textContent = 'Oups, impossible de créer le duel. Réessaie ?';
    createBtn.disabled = false;
  }
});
