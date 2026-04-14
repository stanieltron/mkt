FROM node:22-bookworm

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
    build-essential \
    pkg-config \
    libssl-dev \
    libatomic1 \
  && rm -rf /var/lib/apt/lists/*

RUN curl https://sh.rustup.rs -sSf | sh -s -- -y --profile minimal \
  && ln -s /root/.cargo/bin/cargo /usr/local/bin/cargo \
  && ln -s /root/.cargo/bin/rustc /usr/local/bin/rustc

WORKDIR /app

COPY package*.json ./
COPY frontend/package*.json ./frontend/

RUN npm ci \
  && npm --prefix frontend ci

COPY . .

RUN npm run build

EXPOSE 3000

CMD ["npm", "run", "start"]
