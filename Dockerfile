FROM node:24-slim
WORKDIR /app
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile --prod
COPY src ./src
COPY public ./public
ENV NODE_ENV=production
USER node
EXPOSE 8787
CMD ["node", "src/server.ts"]
