# Frontend standalone image (build + gateway proxy)
FROM node:22-bookworm

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY . .
RUN npm run build

EXPOSE 3000
CMD ["npm", "run", "start"]