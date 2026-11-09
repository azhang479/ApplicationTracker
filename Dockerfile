FROM node:20-slim@sha256:2cf067cfed83d5ea958367df9f966191a942351a2df77d6f0193e162b5febfc0 AS build
WORKDIR /app
COPY package*.json ./
COPY server/package.json server/
COPY web/package.json web/
COPY extension/package.json extension/
RUN npm ci
COPY . .
RUN npm run build && npm prune --omit=dev

FROM node:20-slim@sha256:2cf067cfed83d5ea958367df9f966191a942351a2df77d6f0193e162b5febfc0
ENV NODE_ENV=production
ENV XDG_CACHE_HOME=/home/node/.cache
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl fontconfig \
    && curl -fL --retry 3 https://github.com/tectonic-typesetting/tectonic/releases/download/tectonic%400.15.0/tectonic-0.15.0-x86_64-unknown-linux-musl.tar.gz -o /tmp/tectonic.tar.gz \
    && echo 'dfb82876f2986862996e564fa507a9e576e0c1e3bee63c2c1bd677c2543e6407  /tmp/tectonic.tar.gz' | sha256sum -c - \
    && tar -xzf /tmp/tectonic.tar.gz -C /usr/local/bin tectonic \
    && rm /tmp/tectonic.tar.gz \
    && apt-get purge -y curl && apt-get autoremove -y && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/package.json ./
COPY --from=build --chown=node:node /app/server ./server
COPY --from=build --chown=node:node /app/web/dist ./web/dist
USER node
RUN mkdir -p /home/node/.cache/warmup \
    && tectonic --untrusted --outdir /home/node/.cache/warmup server/fixtures/sample-resume.tex \
    && rm -rf /home/node/.cache/warmup
EXPOSE 8080
CMD ["node", "server/dist/index.js"]
