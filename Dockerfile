# --- build stage ---
FROM node:22.23.4-alpine AS deps

WORKDIR /app

# Enable pnpm via Corepack — version pinned by package.json `packageManager`.
RUN corepack enable

COPY package.json pnpm-lock.yaml .npmrc ./
RUN pnpm install --prod --frozen-lockfile

# --- runtime stage ---
FROM node:22.23.4-alpine AS runtime

ENV NODE_ENV=production
ENV PORT=8080
WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY package.json tsconfig.json ./
COPY src ./src

# Node 22 can execute TypeScript directly via --experimental-strip-types, so
# we skip a separate tsc build step. Swap to a tsc build if you'd rather run
# emitted JS in production.
EXPOSE 8080
USER node
CMD ["node", "--experimental-strip-types", "src/index.ts"]
