interface BundleTarget {
  entryFile: URL;
  outputDir: URL;
  outputFile: URL;
}

const BUNDLE_TARGETS: BundleTarget[] = [
  {
    entryFile: new URL('../core.ts', import.meta.url),
    outputDir: new URL('../dist/core/', import.meta.url),
    outputFile: new URL('./index.mjs', new URL('../dist/core/', import.meta.url)),
  },
  {
    entryFile: new URL('../openai.ts', import.meta.url),
    outputDir: new URL('../dist/providers/openai/', import.meta.url),
    outputFile: new URL('./index.mjs', new URL('../dist/providers/openai/', import.meta.url)),
  },
  {
    entryFile: new URL('../ollama.ts', import.meta.url),
    outputDir: new URL('../dist/providers/ollama/', import.meta.url),
    outputFile: new URL('./index.mjs', new URL('../dist/providers/ollama/', import.meta.url)),
  },
  {
    entryFile: new URL('../plugin/aot/mod.ts', import.meta.url),
    outputDir: new URL('../dist/plugin/aot/', import.meta.url),
    outputFile: new URL('./index.mjs', new URL('../dist/plugin/aot/', import.meta.url)),
  },
  {
    entryFile: new URL('../plugin/pingpong/mod.ts', import.meta.url),
    outputDir: new URL('../dist/plugin/pingpong/', import.meta.url),
    outputFile: new URL('./index.mjs', new URL('../dist/plugin/pingpong/', import.meta.url)),
  },
];

/**
 * Builds the browser-safe public bundles as ESM artifacts.
 *
 * The generated files intentionally exclude standalone-only paths and keep
 * the browser-consumable entrypoints importable without local file access.
 */
async function buildBrowserBundles(): Promise<void> {
  for (const target of BUNDLE_TARGETS) {
    await Deno.mkdir(target.outputDir, { recursive: true });

    const command = new Deno.Command(Deno.execPath(), {
      args: [
        'bundle',
        '--platform=browser',
        '--output',
        target.outputFile.pathname,
        target.entryFile.pathname,
      ],
      cwd: new URL('..', import.meta.url).pathname,
      stderr: 'inherit',
      stdout: 'inherit',
    });

    const result = await command.output();
    if (!result.success) {
      Deno.exit(result.code);
    }
  }
}

await buildBrowserBundles();
