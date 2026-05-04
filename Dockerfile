FROM node:22-slim

# Install tmux, Bun, Playwright/Chromium system deps, and other runtime tools.
# - playwright deps (libnss3 etc.) are required by Chromium binaries that
#   scrapling uses for stealth browsing
# - python3 is needed by the bind-mounted yt-transcript-safe wrapper script
#   (stdlib only — no pip install required, the planka venv's Python 3.13 is
#   at a non-standard path so we want a system /usr/bin/python3 in PATH)
RUN apt-get update && apt-get install -y --no-install-recommends \
        tmux curl unzip ca-certificates git python3 poppler-utils \
        ripgrep ffmpeg \
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

# GitHub CLI from the official GitHub apt repo (Debian's gh is too old for
# agents that query PRs/issues). Installed as root before the USER node switch.
RUN curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
        | dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg \
    && chmod 644 /usr/share/keyrings/githubcli-archive-keyring.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
        > /etc/apt/sources.list.d/github-cli.list \
    && apt-get update && apt-get install -y --no-install-recommends gh \
    && apt-get clean && rm -rf /var/lib/apt/lists/*

# Install Bun and uv as the node user (UID 1000, matches typical host file ownership)
USER node
RUN curl -fsSL https://bun.sh/install | bash
RUN curl -LsSf https://astral.sh/uv/install.sh | sh
ENV PATH="/home/node/.bun/bin:/home/node/.local/bin:/home/node/planka-venv/bin:$PATH"

# Install Hermes (Nous Research's autonomous agent runtime). The installer
# drops code at /home/node/.hermes/hermes-agent/ and a CLI symlink at
# /home/node/.local/bin/hermes (already on PATH). --skip-setup avoids the
# post-install wizard — config is provided per-agent via mcp_servers in
# agents/<name>/config.yaml.
#
# Download to a file before executing so curl failures fail the RUN cleanly
# (avoids the curl|bash pipefail trap). The install path is kept at the
# default /home/node/.hermes/hermes-agent/ because the installer bakes that
# absolute path into the venv's python shebangs — moving the directory would
# break every entry point. Per-agent HERMES_HOMEs (set by entrypoint.sh)
# bind-mount under /agents/<name>/.hermes and symlink hermes-agent back to
# /home/node/.hermes/hermes-agent for runtime code resolution.
RUN set -eux; \
    curl -fsSL https://raw.githubusercontent.com/NousResearch/hermes-agent/main/scripts/install.sh \
         -o /tmp/hermes-install.sh; \
    bash /tmp/hermes-install.sh --skip-setup; \
    rm /tmp/hermes-install.sh

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
