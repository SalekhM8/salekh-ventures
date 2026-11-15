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
USER node
WORKDIR /white-house/runner
EXPOSE 8080
CMD ["node", "dist/index.js"]
