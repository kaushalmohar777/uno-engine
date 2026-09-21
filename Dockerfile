# Placeholder — no application code exists yet. To be filled in once
# src/server.js is actually implemented.
FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev
COPY . .
CMD ["node", "src/server.js"]
