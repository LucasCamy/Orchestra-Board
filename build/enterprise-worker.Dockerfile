FROM node:22-bookworm

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl git util-linux \
    && rm -rf /var/lib/apt/lists/*

RUN npm install --global @openai/codex@0.170.0 @anthropic-ai/claude-code@2.1.328
