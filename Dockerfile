# syntax=docker/dockerfile:1
FROM node:24-bookworm-slim AS dependencies
WORKDIR /app
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
    && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
COPY backend/package.json ./backend/package.json
COPY frontend/package.json ./frontend/package.json

FROM dependencies AS backend-build
RUN npm ci --workspace backend --include-workspace-root
COPY backend/ ./backend/
RUN npm --workspace backend run db:generate \
    && npm --workspace backend run build

FROM dependencies AS frontend-build
RUN npm ci --workspace frontend --include-workspace-root
COPY frontend/ ./frontend/
RUN npm --workspace frontend run build

FROM dependencies AS backend-dependencies
RUN npm ci --omit=dev --workspace backend --include-workspace-root

# Explicit, short-lived operator commands; not a running application service.
FROM backend-build AS tools
WORKDIR /app/backend
USER node
CMD ["npm", "run", "db:migrate:deploy"]

FROM node:24-bookworm-slim AS api
RUN apt-get update \
    && apt-get install -y --no-install-recommends util-linux ca-certificates \
    && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production PORT=3000
WORKDIR /app
COPY --from=backend-dependencies /app/node_modules ./node_modules
COPY --from=backend-dependencies /app/backend/package.json ./backend/package.json
COPY --from=backend-build /app/backend/dist ./backend/dist
COPY deploy/init-storage.sh ./deploy/init-storage.sh
WORKDIR /app/backend
USER node
EXPOSE 3000
CMD ["node", "dist/server.js"]

FROM docker:cli AS docker-cli

FROM api AS worker
USER root
COPY --from=docker-cli /usr/local/bin/docker /usr/local/bin/docker
USER node
CMD ["node", "dist/worker/main.js"]

FROM nginx:stable-alpine AS frontend
COPY deploy/nginx.conf /etc/nginx/nginx.conf
COPY --from=frontend-build /app/frontend/dist /usr/share/nginx/html
USER nginx
EXPOSE 8080
ENTRYPOINT ["nginx"]
CMD ["-g", "daemon off;"]
