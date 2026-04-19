FROM node:20-slim

WORKDIR /app

# Install build tools for better-sqlite3's native binding, then prune.
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

COPY package.json ./
RUN npm install --omit=dev

COPY . .

ENV NODE_ENV=production
ENV DB_PATH=/data/food.db
ENV PORT=8080

EXPOSE 8080
CMD ["node", "server.js"]
