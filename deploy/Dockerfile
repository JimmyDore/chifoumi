# Chifoumi : un seul conteneur qui sert le front statique ET la WebSocket.
FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY server ./server
COPY public ./public
ENV PORT=8787
EXPOSE 8787
CMD ["node", "server/index.mjs"]
