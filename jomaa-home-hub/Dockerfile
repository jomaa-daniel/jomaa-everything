FROM node:22-bookworm-slim AS build
WORKDIR /src
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev && find dist -name '*.test.js*' -delete

FROM node:22-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /src/package.json ./
COPY --from=build /src/node_modules ./node_modules
COPY --from=build /src/dist ./dist
# The node user (uid 1000) owns the Matter data in /data.
USER node
ENTRYPOINT ["node", "dist/main.js", "--config", "/etc/jomaa-home-hub/config.json", "--matter-storage", "/data"]
