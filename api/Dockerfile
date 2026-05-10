FROM node:20-alpine

WORKDIR /app

# Copie des dépendances en premier pour bénéficier du cache Docker
COPY package.json ./
RUN npm install --omit=dev

# Copie du code source
COPY server.js ./

# Port exposé (doit correspondre à Docker Compose)
EXPOSE 3000

CMD ["node", "server.js"]
