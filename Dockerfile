FROM node:22-alpine

WORKDIR /app

# Dependencies installieren
COPY package.json package-lock.json* ./
RUN npm ci --include=dev

# Client-Dependencies installieren
COPY client/package.json client/package-lock.json* ./client/
RUN cd client && npm ci

# Source kopieren (.dockerignore hält node_modules, dist und .env heraus)
COPY . .

# Client bauen — ohne THEMA das Atelier-Thema (client/thema.config.js)
ARG THEMA=
RUN THEMA="$THEMA" npm run build:client

# Server bauen
RUN npm run build:server

# Uploads-Ordner erstellen
RUN mkdir -p /app/uploads

# Im Container auf allen Schnittstellen lauschen, sonst kommt der veröffentlichte Port nicht an.
# Nach außen veröffentlicht docker-compose.yml nur auf 127.0.0.1.
ENV BIND_ADDRESS=0.0.0.0
EXPOSE 3006

# Beim Start: Schema (wiederholbar), dann die Füllung aus seeds/$SEED (Vorgabe: demo; SEED leer = keine), dann der Server.
ENV SEED=demo
CMD ["sh", "-c", "node dist/db/migrate.js && if [ -n \"$SEED\" ]; then node dist/db/seed.js $SEED; fi && exec node dist/server.js"]
