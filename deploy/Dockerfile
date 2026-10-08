FROM node:22.19.0-bookworm-slim
RUN corepack enable && corepack prepare pnpm@10.15.0 --activate
WORKDIR /app
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm verify:demo && mkdir ui && tar -xzf demo-ui/copus-ui.tar.gz -C ui
RUN pnpm compile
ENV NODE_ENV=production POE_WEB_ROOT=/app/ui POE_DEMO_HOST=0.0.0.0 POE_DEMO_PORT=8792 POE_DEMO_DATA=/data POE_DEMO_NETWORK=testnet POE_DEMO_MINT_TEST_TOKEN=1
USER node
EXPOSE 8792
HEALTHCHECK --interval=20s --timeout=5s --start-period=90s CMD node -e "fetch('http://127.0.0.1:8792/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "services/product-demo.js"]
