# syntax=docker/dockerfile:1.7

# ── stage 1: build the Vite frontend ────────────────────────────────────
FROM oven/bun:1.3.14-alpine AS frontend
WORKDIR /app/frontend
COPY frontend/package.json frontend/bun.lock ./
RUN bun install --frozen-lockfile
COPY frontend/ ./
RUN bun run build && ls dist | head

# ── stage 2: runtime image with kubectl, bun, embedded UI ───────────────
FROM oven/bun:1.3.14-alpine

RUN apk add --no-cache curl ca-certificates bash && \
    KUBECTL_VERSION="$(curl -fsSL https://dl.k8s.io/release/stable.txt)" && \
    ARCH="$(uname -m)" && case "$ARCH" in \
      x86_64) KARCH=amd64 ;; \
      aarch64|arm64) KARCH=arm64 ;; \
      *) echo "unsupported arch $ARCH" >&2; exit 1 ;; \
    esac && \
    curl -fsSL "https://dl.k8s.io/release/${KUBECTL_VERSION}/bin/linux/${KARCH}/kubectl" -o /usr/local/bin/kubectl && \
    chmod +x /usr/local/bin/kubectl && \
    kubectl version --client=true --output=yaml | head -3 && \
    apk del curl

WORKDIR /app

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

COPY tsconfig.json ./
COPY scripts/ ./scripts/
COPY src/ ./src/

# Bring in the Vite build output and embed it into src/generated/ui-assets.ts
COPY --from=frontend /app/frontend/dist ./frontend/dist
RUN bun scripts/embed-ui.ts && ls -1 src/generated && head -c 200 src/generated/ui-assets.ts

COPY config.docker.json ./config.docker.json

ENV HYPER_CONFIG=/app/config.docker.json \
    HYPER_STATE_DIR=/data/state \
    HYPER_ENV_FILES_DIR=/data/env \
    HYPER_LISTEN_PORT=8080 \
    LOG_LEVEL=info

VOLUME ["/data"]

EXPOSE 8080

CMD ["bun", "src/index.ts"]
