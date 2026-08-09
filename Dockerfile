FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install
COPY . .
RUN npm run build

FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install --omit=dev
COPY --from=build /app/dist-server ./dist-server
COPY --from=build /app/dist-web ./dist-web
COPY --from=build /app/db/migrations ./db/migrations
EXPOSE 4100
CMD ["node", "dist-server/apps/api/src/index.js"]
