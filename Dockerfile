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
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh

# ---------------------------------------------------------------------------
# 3. Ensure the data directory is writable
# ---------------------------------------------------------------------------
# Named volumes inherit this directory on first start. The entrypoint also
# re-applies permissions at runtime because a bind mount can replace the
# directory after the image is built.
RUN mkdir -p /app/data \
 && chmod 777 /app/data \
 && chmod 666 /app/data/custom_links.json \
 && sed -i 's/\r$//' /usr/local/bin/docker-entrypoint.sh \
 && chmod 755 /usr/local/bin/docker-entrypoint.sh

# ---------------------------------------------------------------------------
# 4. Runtime configuration
# ---------------------------------------------------------------------------
# Credentials and the editor token are injected at runtime
# (COOLIFY_INSTANCE_URL / COOLIFY_API_TOKEN / ADMIN_TOKEN).
# Do not bake .env into the image.
EXPOSE 3000
ENV NODE_ENV=production
ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
CMD ["node", "server.js"]
