# ---------------------------------------------------------------------------
# Coolify Web Directory – standalone Docker image
# ---------------------------------------------------------------------------
# Use the official Node.js LTS Alpine image for a small footprint
FROM node:20-alpine

# Set the working directory inside the container
WORKDIR /app

# ---------------------------------------------------------------------------
# 1. Install production dependencies
# ---------------------------------------------------------------------------
# Copy only the package files first so Docker can cache the npm layer
COPY package*.json ./
RUN npm install --omit=dev

# ---------------------------------------------------------------------------
# 2. Copy the application source and default manual-link overrides
# ---------------------------------------------------------------------------
COPY server.js ./
COPY custom_links.json ./data/

# ---------------------------------------------------------------------------
# 3. Runtime configuration
# ---------------------------------------------------------------------------
# Credentials are injected at runtime (COOLIFY_INSTANCE_URL / COOLIFY_API_TOKEN).
# Do not bake .env into the image.
EXPOSE 3000
ENV NODE_ENV=production
CMD ["node", "server.js"]