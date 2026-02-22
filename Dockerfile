# Warehouse Dock Board - Docker Image
# Multi-stage build for smaller final image

FROM node:18-alpine

# Set working directory
WORKDIR /app

# Install dependencies
COPY package*.json ./
RUN npm install --omit=dev && npm cache clean --force

# Copy application files
COPY src/ ./src/
COPY public/ ./public/

# Create data directory for persistent storage
RUN mkdir -p /app/data

# Set environment variables
ENV NODE_ENV=production
ENV PORT=3456

# Expose the application port
EXPOSE 3456

# Health check
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "require('http').get('http://localhost:3456/api/state', (r) => r.statusCode === 200 ? process.exit(0) : process.exit(1))"

# Run the application
CMD ["node", "src/server.js"]
