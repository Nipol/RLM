FROM denoland/deno:bin-2.7.7 AS deno
FROM mcr.microsoft.com/devcontainers/rust:1-1-bullseye
COPY --from=deno /deno /usr/local/bin/deno

USER root
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl gnupg \
  && apt-get update \
  && apt-get clean \
  && rm -rf /var/lib/apt/lists/*

USER vscode
