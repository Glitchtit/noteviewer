FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY shared/package.json shared/
COPY server/package.json server/
COPY web/package.json web/
RUN npm ci
COPY . .
RUN npm run build -w web

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production VAULT_PATH=/vault PORT=8080
COPY package.json package-lock.json ./
COPY shared/package.json shared/
COPY server/package.json server/
COPY web/package.json web/
RUN npm ci --omit=dev
COPY shared shared
COPY server server
COPY --from=build /app/web/dist web/dist
EXPOSE 8080
CMD ["npx", "tsx", "server/src/main.ts"]
