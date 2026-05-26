# Apify Actor base image with Node 24 LTS
FROM apify/actor-node:24

# Enable corepack-managed pnpm (version pinned via packageManager in package.json)
RUN corepack enable

# Copy manifest + lockfile + workspace config first for better Docker layer caching.
# pnpm-workspace.yaml is REQUIRED here — pnpm 11 reads `allowBuilds` from it,
# which is what permits esbuild's postinstall script to run (tsx pulls esbuild).
COPY --chown=myuser package.json pnpm-lock.yaml pnpm-workspace.yaml ./

# Install ALL deps (devDeps needed for the TypeScript build step below)
RUN pnpm install --frozen-lockfile

# Copy source + tsconfig + .actor metadata
COPY --chown=myuser . ./

# Compile TypeScript → dist/
RUN pnpm build

# Prune devDeps from node_modules to slim the runtime image
RUN pnpm prune --prod

CMD ["pnpm", "start", "--silent"]
