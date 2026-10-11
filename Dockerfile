# Hosts the web game and the online match server together.
FROM node:22-slim AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci --ignore-scripts
COPY . .
RUN npm run build

FROM node:22-slim
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev --ignore-scripts
COPY server ./server
COPY --from=build /app/dist ./dist
ENV PORT=8787
EXPOSE 8787
CMD ["node", "server/index.mjs"]
