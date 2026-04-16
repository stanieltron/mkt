# Backend standalone image (Rust API + optional local relay)
FROM node:22-bookworm

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
    git \
    build-essential \
    pkg-config \
    libssl-dev \
    libatomic1 \
  && rm -rf /var/lib/apt/lists/*

RUN curl https://sh.rustup.rs -sSf | sh -s -- -y --profile minimal
ENV PATH="/root/.cargo/bin:${PATH}"

WORKDIR /app

COPY package.json ./
COPY Cargo.toml Cargo.lock ./
COPY abi ./abi
COPY migrations ./migrations
COPY src ./src
COPY local-relay ./local-relay
COPY scripts ./scripts

RUN npm ci
RUN cargo fetch
RUN cargo build --release

EXPOSE 8787
EXPOSE 8788

CMD ["npm", "run", "start"]