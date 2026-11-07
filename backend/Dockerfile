FROM node:22-alpine
WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev
COPY src ./src
COPY db ./db
# Folder untuk nodes.json; volume Docker mewarisi pemilik ini, jadi user node bisa menulis
RUN mkdir -p /targets && chown node:node /targets
USER node
EXPOSE 3000
CMD ["node", "src/server.js"]
