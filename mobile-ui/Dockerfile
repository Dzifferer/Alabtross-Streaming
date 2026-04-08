FROM node:20-alpine

# Install FFmpeg for MKV→MP4 remuxing (container-level copy, no re-encoding)
# Note: For local device discovery (casting via VPN), the container should be
# run with --net=host so SSDP multicast can reach LAN devices.
RUN apk add --no-cache ffmpeg

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci --production 2>/dev/null || npm install --production && \
    npm cache clean --force

COPY . .

# Create library directory for downloaded content
RUN mkdir -p /app/library

# Run as non-root user
RUN addgroup -g 1001 -S nodejs && \
    adduser -S nodejs -u 1001 && \
    chown -R nodejs:nodejs /app

USER nodejs

EXPOSE 8080

ENV NODE_ENV=production

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "require('http').get('http://localhost:8080/health', (r) => { r.resume(); r.statusCode === 200 ? process.exit(0) : process.exit(1); }).on('error', () => process.exit(1))"

CMD ["node", "server.js"]
