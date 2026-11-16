# 运行时不依赖任何第三方包（Node 内置 sqlite/crypto/fetch），镜像很小
FROM node:24-alpine
WORKDIR /app
COPY package.json ./
COPY src ./src
COPY scripts ./scripts
ENV NODE_ENV=production
ENV HOST=0.0.0.0
EXPOSE 8787
VOLUME ["/app/data"]
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://127.0.0.1:8787/api/health || exit 1
CMD ["node", "src/index.js"]
