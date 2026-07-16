FROM node:24.16.0-bookworm

RUN npm install --global --no-audit --no-fund --loglevel=error @openai/codex@0.144.1 \
    && npm cache clean --force

ENV CI=true
