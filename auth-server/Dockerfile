FROM node:22-bookworm-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY auth-server ./auth-server
EXPOSE 8790
CMD ["node", "auth-server/index.js"]
