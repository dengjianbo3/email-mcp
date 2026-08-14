# email-mcp 多阶段构建（远程 HTTP 模式容器化）
FROM node:22-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci --no-audit --no-fund
COPY . .
RUN npm run build && npm prune --omit=dev

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
ENV EMAIL_MCP_HOME=/data
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/docs ./docs
VOLUME ["/data"]
EXPOSE 8788
# 用法示例:
#   docker run -d --name email-mcp-gmail -p 127.0.0.1:8788:8788 \
#     -v ~/.email-mcp:/data email-mcp gmail --transport http --port 8788
ENTRYPOINT ["node", "dist/cli.js"]
CMD ["gmail", "--transport", "http", "--port", "8788"]
