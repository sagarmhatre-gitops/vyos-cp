# Multi-stage build: frontend -> embedded in Go binary -> scratch image.

# ---- 1. Build the React frontend ----
FROM node:20-alpine AS frontend
WORKDIR /ui
COPY frontend/package.json frontend/package-lock.json* ./
RUN npm install --no-audit --no-fund
COPY frontend/ ./
RUN npx vite build --outDir /ui/dist --emptyOutDir

# ---- 2. Build the Go backend with the frontend embedded ----
FROM golang:1.22-alpine AS backend
RUN apk add --no-cache git ca-certificates
WORKDIR /src
COPY backend/ ./
RUN rm -rf cmd/vyos-cp/static && mkdir -p cmd/vyos-cp/static
COPY --from=frontend /ui/dist/ ./cmd/vyos-cp/static/
RUN go mod tidy
RUN CGO_ENABLED=0 GOOS=linux go build \
      -ldflags="-s -w -X main.version=$(git describe --tags --always 2>/dev/null || echo dev)" \
      -o /out/vyos-cp ./cmd/vyos-cp

# ---- 3. Runtime image ----
FROM gcr.io/distroless/static-debian12:nonroot
COPY --from=backend /out/vyos-cp /vyos-cp
EXPOSE 8080
USER nonroot:nonroot
ENTRYPOINT ["/vyos-cp"]
