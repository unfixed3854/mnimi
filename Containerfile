FROM oven/bun:1.3.13-debian AS dependencies

WORKDIR /app

# Copy workspace manifests first so dependency installation stays cached when
# application source changes.
COPY package.json bun.lock bunfig.toml ./
COPY apps/mobile/package.json apps/mobile/package.json
COPY apps/server/package.json apps/server/package.json
COPY libs/shared/package.json libs/shared/package.json

RUN bun install --frozen-lockfile --production \
  --filter @mnimi/server \
  --filter @mnimi/shared

FROM oven/bun:1.3.13-debian

WORKDIR /app
ENV NODE_ENV=production
ENV CODEX_HOME=/data/codex

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates \
  && rm -rf /var/lib/apt/lists/*

COPY --chown=bun:bun package.json bun.lock bunfig.toml ./
COPY --chown=bun:bun --from=dependencies /app/node_modules ./node_modules
COPY --chown=bun:bun apps/server ./apps/server
COPY --chown=bun:bun libs/shared ./libs/shared

# The workspace production installation must include the pinned Codex CLI used
# by the operator-only device-login command and the app-server provider.
RUN test -f ./node_modules/@openai/codex/bin/codex.js
RUN test -s /etc/ssl/certs/ca-certificates.crt

# SQLite, generated images, and generated audio must survive container
# replacement, so deployments mount persistent storage at this path.
RUN mkdir -p /data/codex \
  && chown -R bun:bun /data \
  && chmod 0700 /data/codex

USER bun
EXPOSE 8788

CMD ["bun", "run", "server:start"]
