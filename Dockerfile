# One image for both the API and the worker; docker-compose picks the
# process with `command`. Multi-stage keeps devDependencies (vitest) out.
FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

FROM node:22-alpine
ENV NODE_ENV=production
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY migrations ./migrations
COPY src ./src
# Run as the unprivileged user shipped with the node image.
USER node
# Node is PID 1 and handles SIGTERM itself (see src/worker.js shutdown()),
# so `docker stop` triggers graceful shutdown instead of a SIGKILL after 10s.
CMD ["node", "src/api.js"]
