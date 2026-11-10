# syntax=docker/dockerfile:1.7
# One image: the Go server plus the built PWA it serves.
# VERSION (git describe of the checkout, from scripts/common.sh) and WEB
# (the interface's own version, a hash of web/) go into both: /healthz
# reports the server's, the page knows its own and offers a reload when its
# WEB differs.
ARG VERSION=dev
ARG WEB=dev

FROM node:22.15.0-alpine AS web
WORKDIR /src/web
COPY web/package.json web/package-lock.json ./
RUN --mount=type=cache,target=/root/.npm npm ci
COPY web/ ./
ARG VERSION
ARG WEB
RUN VITE_VERSION=$VERSION VITE_WEB=$WEB npm run build

FROM golang:1.27.0-alpine AS server
WORKDIR /src
COPY go.mod go.sum ./
RUN --mount=type=cache,target=/go/pkg/mod go mod download
COPY cmd/ cmd/
COPY internal/ internal/
ARG VERSION
ARG WEB
RUN --mount=type=cache,target=/go/pkg/mod --mount=type=cache,target=/root/.cache/go-build \
    CGO_ENABLED=0 go build -trimpath -ldflags "-s -w -X main.version=$VERSION -X main.web=$WEB" -o /out/thread ./cmd/thread
# Empty data dir owned by the distroless "nonroot" user, so a fresh named
# volume mounted at /data starts writable.
RUN mkdir -p /out/data && chown 65532:65532 /out/data

FROM gcr.io/distroless/static-debian12:nonroot@sha256:afa5c872c891853ca7fcf1f12c3edb23f7eeef36189728842dd51042ff57f7ab
COPY --from=server /out/thread /app/thread
COPY --from=web /src/web/dist /app/web
COPY --from=server --chown=65532:65532 /out/data /data
ENV ADDR=:8080 DATA_DIR=/data STATIC_DIR=/app/web
EXPOSE 8080
VOLUME /data
ENTRYPOINT ["/app/thread"]
