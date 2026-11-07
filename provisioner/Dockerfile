FROM node:22-alpine
# openssl: membuat CA & sertifikat TLS; tar/unzip: membongkar rilis node_exporter & Alloy
RUN apk add --no-cache openssl tar unzip
WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev
COPY src ./src
# /secrets: kunci SSH, CA, kata sandi exporter. /cache: binary yang sudah diunduh & diverifikasi
RUN mkdir -p /secrets /cache && chown node:node /secrets /cache
USER node
EXPOSE 4000
HEALTHCHECK --interval=10s --retries=30 CMD test -f /secrets/ready
CMD ["node", "src/index.js"]
