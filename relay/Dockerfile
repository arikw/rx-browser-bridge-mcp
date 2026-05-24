FROM node:22-alpine AS build
WORKDIR /app
COPY package.json tsconfig.json ./
COPY src ./src
RUN apk add --no-cache python3 make g++ \
 && npm install --no-audit --no-fund \
 && npm run build

FROM node:22-alpine AS runtime
WORKDIR /app
RUN apk add --no-cache tini
COPY --from=build /app/dist ./dist
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./
ENV NODE_ENV=production \
    DATA_DIR=/data \
    PORT=3000 \
    HOST=0.0.0.0
VOLUME ["/data"]
EXPOSE 3000
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "dist/server.js"]
