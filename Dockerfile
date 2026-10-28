# NodeCast TV Docker Image
#
# Hardware acceleration:
#   - VAAPI (Intel/AMD): Mount /dev/dri and add video/render groups
#   - NVIDIA NVENC: Requires nvidia-container-toolkit on host + --gpus flag
#   - Intel QSV: Mount /dev/dri
#
# Build: docker compose build
# Run with VAAPI: docker run --device /dev/dri:/dev/dri --group-add video ...

FROM ubuntu:24.04

# Install Node.js, FFmpeg, and hardware acceleration drivers
ARG TARGETARCH
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl \
    ca-certificates \
    gnupg \
    && curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
    && if [ "$TARGETARCH" = "amd64" ]; then \
        DRIVERS="mesa-va-drivers intel-media-va-driver vainfo libmfx1 libmfx-gen1.2"; \
    else \
        DRIVERS=""; \
    fi \
    && apt-get update && apt-get install -y --no-install-recommends \
    nodejs \
    ffmpeg \
    pciutils \
    python3 \
    make \
    g++ \
    $DRIVERS \
    && rm -rf /var/lib/apt/lists/*

# Verify FFmpeg installed
RUN ffmpeg -version && ffmpeg -encoders 2>/dev/null | grep -E "vaapi|nvenc|qsv|libx264" | head -10

# MediaMTX serves canvas playback over WebRTC (the "Enhanced" engine). Pinned and checksummed;
# a version bump needs the matching hashes from the release's checksums.sha256.
ARG MEDIAMTX_VERSION=1.21.3
RUN ARCH="$(dpkg --print-architecture)" \
    && case "$ARCH" in \
        amd64) MTX_SHA=0a2ea7eba96023631efa1bea7804823a9145b043b6646a8a05798d4ac24ed635 ;; \
        arm64) MTX_SHA=27f038237cb5f77a724f6afc58eca2798f2bc4edf9989895631a80eeb41a4fe2 ;; \
        *) echo "No MediaMTX build for $ARCH: WebRTC playback disabled"; exit 0 ;; \
    esac \
    && curl -fsSL -o /tmp/mediamtx.tar.gz \
        "https://github.com/bluenviron/mediamtx/releases/download/v${MEDIAMTX_VERSION}/mediamtx_v${MEDIAMTX_VERSION}_linux_${ARCH}.tar.gz" \
    && echo "${MTX_SHA}  /tmp/mediamtx.tar.gz" | sha256sum -c - \
    && tar -xzf /tmp/mediamtx.tar.gz -C /usr/local/bin mediamtx \
    && rm /tmp/mediamtx.tar.gz \
    && mediamtx --version

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies (better-sqlite3 will build from source using g++ installed above)
RUN npm ci --only=production

# Copy application files
COPY . .

# Create data and cache directories
RUN mkdir -p /app/data /app/transcode-cache && chmod 777 /app/transcode-cache

# Expose port
EXPOSE 3000
# WebRTC media for canvas playback (WEBRTC_PORT)
EXPOSE 8189/udp 8189/tcp

HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
    CMD ["node", "scripts/healthcheck.cjs"]

# Start server
CMD ["node", "server/index.js"]
