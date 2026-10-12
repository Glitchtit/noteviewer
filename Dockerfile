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
# chromium renders note PDFs (Share → email / download); noto covers ÅÄÖ and emoji callouts
RUN apk add --no-cache chromium-headless-shell font-noto font-noto-emoji
ENV NODE_ENV=production VAULT_PATH=/vault DATA_PATH=/data PORT=8080 PUBLIC_PORT=8081 \
    CHROMIUM_PATH=/usr/bin/chromium-headless-shell
COPY package.json package-lock.json ./
COPY shared/package.json shared/
COPY server/package.json server/
COPY web/package.json web/
# server deps only: the web bundle is prebuilt, so mermaid/codemirror/etc. stay out of the image
RUN npm ci --omit=dev --workspace=server
COPY shared shared
COPY server server
COPY --from=build /app/web/dist web/dist
VOLUME /data
# 8080: private app (behind Cloudflare Access) · 8081: public share links only
EXPOSE 8080 8081
CMD ["npx", "tsx", "server/src/main.ts"]
