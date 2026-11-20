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
# 2. Copy the application source and the .env credentials
# ---------------------------------------------------------------------------
# Copy the server code
COPY server.js ./
# Copy the .env file that holds COOLIFY_INSTANCE_URL and COOLIFY_API_TOKEN
COPY .env ./

# ---------------------------------------------------------------------------
# 3. Runtime configuration
# ---------------------------------------------------------------------------
# The Express app listens on this port
EXPOSE 3000

# Use production mode
ENV NODE_ENV=production

# Start the server
CMD ["node", "server.js"]
