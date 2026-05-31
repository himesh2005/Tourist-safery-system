FROM node:18-alpine
WORKDIR /app
# Build context is the server/ directory (set Railway "Root Directory" to server)
COPY package*.json ./
RUN npm install
COPY . .
EXPOSE 5000
CMD ["node", "index.cjs"]
