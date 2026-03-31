FROM mcr.microsoft.com/playwright:v1.54.2-jammy

WORKDIR /workspace

COPY smoke/package.json /workspace/smoke/package.json
RUN cd /workspace/smoke && npm install --no-package-lock

COPY . /workspace

CMD ["node", "smoke/browser/run.mjs"]
