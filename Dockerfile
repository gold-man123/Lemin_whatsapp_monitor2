FROM node:18-alpine

# Install required system dependencies
RUN apk add --no-cache python3 make g++ sqlite git curl

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm ci

# Copy application code
COPY . .

# Build TypeScript
RUN npm run build

# Create directories for data persistence
RUN mkdir -p auth_info views public

# Expose port
EXPOSE 3000

# Health check
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD curl -f http://localhost:3000/api/stats || exit 1

# Start application
CMD ["node", "dist/index.js"]