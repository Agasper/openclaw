#!/usr/bin/env bash
set -euo pipefail

IMAGE="docker-hosted.gearwap.ru/gg/ai/openclaw-source:latest"
cd "$(dirname "$0")"

echo "Building OpenClaw from source..."
docker build -f Dockerfile.ci -t "$IMAGE" .
echo "Done: $IMAGE (local)"
