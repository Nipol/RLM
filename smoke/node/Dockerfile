FROM node:22-bookworm-slim

WORKDIR /workspace

COPY smoke/package.json /workspace/smoke/package.json
RUN cd /workspace/smoke && npm install --no-package-lock

COPY . /workspace

CMD ["node", "smoke/node/run.mjs"]
