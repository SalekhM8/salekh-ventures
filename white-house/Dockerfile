# Build context is white-house/ and nothing else:
#   docker build -t white-house-runner white-house/
# Nothing from the website sits above /white-house in the image, so no
# parent CLAUDE.md can load into an agent run (BRIEF.md section 7).

FROM node:22-slim AS build
WORKDIR /white-house/runner
COPY runner/package.json runner/package-lock.json ./
RUN npm ci
COPY runner/tsconfig.json ./
COPY runner/src ./src
RUN npm run build && npm prune --omit=dev

FROM node:22-slim
ENV NODE_ENV=production
# The runner binds 127.0.0.1 unless told otherwise. In a container it must listen on all interfaces.
ENV HOST=0.0.0.0
WORKDIR /white-house
COPY CLAUDE.md ./CLAUDE.md
COPY agents ./agents
COPY skills ./skills
COPY businesses ./businesses
COPY --from=build /white-house/runner/package.json ./runner/package.json
COPY --from=build /white-house/runner/node_modules ./runner/node_modules
COPY --from=build /white-house/runner/dist ./runner/dist

# The migrations, for the database setup at start. They sit OUTSIDE /white-house, belong to root and can be read
# by root alone. The setup runs as root, once, before the server; the server and every agent it starts run as
# the ordinary user and cannot open them.
COPY db/migrations /opt/white-house-db/migrations
RUN chown -R root:root /opt/white-house-db && chmod -R go-rwx /opt/white-house-db
ENV MIGRATIONS_DIR=/opt/white-house-db/migrations

# No USER line on purpose. dist/start.js runs as root only long enough to set the database up (when
# DATABASE_URL_ADMIN is given), then starts the server as uid 1000 (node) with the owner's URL taken out of its
# environment. The server never runs as root.
WORKDIR /white-house/runner
EXPOSE 8080
CMD ["node", "dist/start.js"]
