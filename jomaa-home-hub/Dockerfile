FROM node:22-bookworm-slim AS build
WORKDIR /src/jomaa-home-hub
COPY jomaa-home-hub/package.json jomaa-home-hub/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY jomaa-home-hub/tsconfig.json ./
COPY jomaa-home-hub/src ./src
COPY jomaa-home-hub/web ./web
COPY jomaa-home-hub/scripts/build-web.mjs ./scripts/build-web.mjs
COPY jomaa-static-pages/device-panel /src/jomaa-static-pages/device-panel
RUN npm run build && npm prune --omit=dev && find dist -name '*.test.js*' -delete

FROM node:22-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /src/jomaa-home-hub/package.json ./
COPY --from=build /src/jomaa-home-hub/node_modules ./node_modules
COPY --from=build /src/jomaa-home-hub/dist ./dist
# The node user (uid 1000) owns the Matter data in /data.
USER node
ENTRYPOINT ["node", "dist/main.js", "--config", "/etc/jomaa-home-hub/config.json", "--matter-storage", "/data"]
