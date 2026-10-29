# Build context = THƯ MỤC GỐC repo (docker-compose.yml: context ".."), vì app dùng gói dùng chung packages/security.
FROM node:20-bookworm-slim

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 make g++ mosquitto git ca-certificates curl \
  && curl -fsSL https://download.docker.com/linux/static/stable/x86_64/docker-27.3.1.tgz \
    | tar -xz -C /tmp \
  && mv /tmp/docker/docker /usr/local/bin/docker \
  && mkdir -p /usr/local/lib/docker/cli-plugins \
  && curl -fsSL https://github.com/docker/compose/releases/download/v2.29.7/docker-compose-linux-x86_64 \
    -o /usr/local/lib/docker/cli-plugins/docker-compose \
  && chmod +x /usr/local/bin/docker /usr/local/lib/docker/cli-plugins/docker-compose \
  && rm -rf /tmp/docker /var/lib/apt/lists/*

# @plciot/security: package.json khai "file:../../packages/security" → từ /app trỏ tới /packages/security
COPY packages/security /packages/security
RUN cd /packages/security && npm install --omit=dev

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
