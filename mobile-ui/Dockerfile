FROM node:20-alpine

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci --production 2>/dev/null || npm install --production

COPY . .

EXPOSE 8080

ENV NODE_ENV=production

CMD ["node", "server.js"]
