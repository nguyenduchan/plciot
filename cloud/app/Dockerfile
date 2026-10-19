FROM node:20-bookworm-slim

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 make g++ mosquitto \
  && rm -rf /var/lib/apt/lists/*

COPY package.json ./
RUN npm install --omit=dev

COPY src ./src
COPY scripts ./scripts

ENV PORT=3080
ENV DATA_DIR=/app/data
ENV SHELL_DIR=/app/shell
ENV WEBAPP_SRC=/app/shell

EXPOSE 3080
CMD ["node", "src/server.js"]
