# syntax=docker/dockerfile:1.7
# opencode-agent sandbox runner. API key based providers (Anthropic, OpenAI,
# OpenRouter, Groq). Auth keys come from the manager bootstrap response.

FROM public.ecr.aws/docker/library/node:20-bookworm-slim AS build
WORKDIR /app
COPY package.json tsconfig.json ./
RUN npm install --omit=dev=false
COPY src ./src
RUN npx tsc -b

FROM public.ecr.aws/docker/library/node:20-bookworm-slim AS runner
ARG OPENCODE_VERSION=1.14.30
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates \
  && rm -rf /var/lib/apt/lists/* \
  && npm install -g --no-audit --no-fund "opencode-ai@${OPENCODE_VERSION}" \
  && opencode --version
WORKDIR /app
COPY --from=build /app/dist ./dist
COPY --from=build /app/node_modules ./node_modules
COPY package.json ./
ENV NODE_ENV=production
ENTRYPOINT ["node", "dist/runner.js"]
