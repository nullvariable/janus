FROM node:22-slim

# Install tmux, Bun, Playwright/Chromium system deps, and other runtime tools.
# - playwright deps (libnss3 etc.) are required by Chromium binaries that
#   scrapling uses for stealth browsing
# - python3 is needed by the bind-mounted yt-transcript-safe wrapper script
#   (stdlib only — no pip install required, the planka venv's Python 3.13 is
#   at a non-standard path so we want a system /usr/bin/python3 in PATH)
RUN apt-get update && apt-get install -y --no-install-recommends \
        tmux curl unzip ca-certificates git python3 poppler-utils \
        libnss3 libnspr4 libdbus-1-3 libatk1.0-0 libatk-bridge2.0-0 \
        libcups2 libxkbcommon0 libatspi2.0-0 libxcomposite1 libxdamage1 \
        libxfixes3 libxrandr2 libgbm1 libpango-1.0-0 libcairo2 libasound2 \
        libx11-6 libxcb1 libxext6 libxi6 libxtst6 fonts-liberation \
    && apt-get clean && rm -rf /var/lib/apt/lists/*

# Install Claude Code globally
RUN npm install -g @anthropic-ai/claude-code

# Symlink the host-side home path to the container's node home so absolute
# paths stored in ~/.claude/plugins/*.json (which reference /home/${HOST_USER}
# from the host) resolve correctly inside the container. Override HOST_USER
# at build time: `docker compose build --build-arg HOST_USER=$(whoami)`.
ARG HOST_USER=hostuser
RUN ln -sf /home/node /home/${HOST_USER}

# Install Bun and uv as the node user (UID 1000, matches typical host file ownership)
USER node
RUN curl -fsSL https://bun.sh/install | bash
RUN curl -LsSf https://astral.sh/uv/install.sh | sh
ENV PATH="/home/node/.bun/bin:/home/node/.local/bin:/home/node/planka-venv/bin:$PATH"

# qmd wrapper at the path the user-level mcp config in ~/.claude.json
# expects (resolved via /home/${HOST_USER} -> /home/node symlink).
# We can't use the package's own shim because (a) it looks for bun.lock
# inside the package dir to detect bun mode (the lock is one level up at
# /opt/bun-global/), and (b) falling back to node fails because better-
# sqlite3's native binding was compiled against the host's newer Node ABI.
# Force bun directly against the dist entry.
RUN printf '%s\n' '#!/bin/sh' \
    'exec /home/node/.bun/bin/bun /opt/bun-global/node_modules/@tobilu/qmd/dist/cli/qmd.js "$@"' \
    > /home/node/.bun/bin/qmd && chmod +x /home/node/.bun/bin/qmd

# Create empty venv for planka-cli with Python 3.13 (uv downloads if needed).
# planka-cli is installed into this venv at runtime from bind-mounted source.
RUN /home/node/.local/bin/uv venv --python 3.13 /home/node/planka-venv

# Copy MCP servers and install dependencies (layer-cached)
WORKDIR /app
COPY --chown=node:node mattermost-channel/package.json mattermost-channel/bun.lock* ./mattermost-channel/
RUN cd mattermost-channel && bun install --frozen-lockfile || bun install

COPY --chown=node:node heartbeat/package.json heartbeat/bun.lock* ./heartbeat/
RUN cd heartbeat && bun install --frozen-lockfile || bun install

COPY --chown=node:node mattermost-channel/ ./mattermost-channel/
COPY --chown=node:node heartbeat/ ./heartbeat/

# Copy agent configs, hooks, and entrypoint
COPY --chown=node:node agents/ ./agents/
COPY --chown=node:node hooks/ ./hooks/
COPY --chown=node:node entrypoint.sh ./
RUN chmod +x entrypoint.sh hooks/*.sh
# Symlink hooks at the host-style path so settings.local.json can use one path
# that works both on the host and inside the container (via the existing
# /home/${HOST_USER} -> /home/node symlink).
RUN mkdir -p /home/node/projects/janus && ln -sf /app/hooks /home/node/projects/janus/hooks

ENTRYPOINT ["./entrypoint.sh"]
