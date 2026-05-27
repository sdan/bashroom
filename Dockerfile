FROM docker.io/cloudflare/sandbox:0.10.2

# Agent CLI toolkit on top of the stock cloudflare/sandbox base.
# Base image already provides: bash, git, jq, curl, wget, node, bun,
# zip, unzip, openssl, file. We add the search/edit/view/process tools
# agents reach for when working over /rooms (FUSE-mounted from R2).
#
# Keep this layer thin — cold start scales with image size.
RUN apt-get update && apt-get install -y --no-install-recommends \
      ripgrep \
      less \
      tree \
      vim-tiny \
      fd-find \
      rsync \
      diffutils \
      procps \
      psmisc \
      ca-certificates \
      xz-utils \
    && ln -s /usr/bin/fdfind /usr/local/bin/fd \
    && rm -rf /var/lib/apt/lists/*

COPY bin/sandbox-bashroom.js /usr/local/bin/bashroom
RUN chmod +x /usr/local/bin/bashroom
ENV BASHROOM_URL=http://bashroom.internal
