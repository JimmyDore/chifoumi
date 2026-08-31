# Chifoumi

Pierre, feuille, ciseaux à distance, pour trancher les petites décisions du
quotidien (« celui qui perd fait la vaisselle »). On crée un duel, on envoie
le lien, chacun joue sur son téléphone : compte à rebours, révélation
simultanée, égalités rejouées, meilleur des 3 ou des 5, revanche. Aucun
compte, tout vit en mémoire (les duels expirent après 1 h d'inactivité).

## Dev

```bash
npm install
npm test        # tests de la logique de jeu (node --test)
npm start       # serveur sur http://localhost:8787
```

Un seul processus Fastify sert le front statique (`public/`) et la
WebSocket ; la logique de jeu pure vit dans `server/game.mjs`.

## Déploiement

Push sur `main` → GitHub Actions (tests puis SSH vers le serveur) →
`docker compose up -d --build` (conteneur unique `chifoumi-web`, réseau
partagé `ravetycoon_default`, TLS via le Caddy de la stack ravetycoon) →
health check sur https://chifoumi.jimmydore.fr/health.
