FROM oven/bun:1.4.2

WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production
COPY src ./src

EXPOSE 3000
CMD ["bun", "--bun", "fastify", "start", "--address", "0.0.0.0", "--log-level=info", "--options", "src/app.ts"]
