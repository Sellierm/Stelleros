FROM node:20-alpine

WORKDIR /usr/src/app

COPY server/package*.json ./
RUN npm ci --omit=dev

COPY server/ .
COPY client/dist ../client/dist

EXPOSE 3000
CMD ["node", "index.js"]
