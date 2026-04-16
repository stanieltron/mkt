# Local node standalone image (Anvil + local contract deployment)
FROM node:22-bookworm

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl git unzip \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

COPY . .

EXPOSE 8545
CMD ["npm", "run", "start"]