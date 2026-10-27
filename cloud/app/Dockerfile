# Build context = THƯ MỤC GỐC repo (docker-compose.yml: context ".."), vì app dùng gói dùng chung packages/security.
FROM node:20-bookworm-slim

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 make g++ mosquitto \
  && rm -rf /var/lib/apt/lists/*

# @plciot/security: package.json khai "file:../../packages/security" → từ /app trỏ tới /packages/security
COPY packages/security /packages/security

COPY cloud/app/package.json ./
RUN npm install --omit=dev

COPY cloud/app/src ./src
COPY cloud/app/scripts ./scripts

ENV PORT=3080
ENV DATA_DIR=/app/data
ENV SHELL_DIR=/app/shell
ENV WEBAPP_SRC=/app/shell

EXPOSE 3080
CMD ["node", "src/server.js"]
