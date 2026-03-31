const OUTPUT_DIR = new URL('../dist/core/', import.meta.url);
const OUTPUT_FILE = new URL('./index.mjs', OUTPUT_DIR);
const ENTRY_FILE = new URL('../core.ts', import.meta.url);

/**
 * Builds the browser-safe core library bundle as one ESM artifact.
 *
 * The generated file intentionally excludes standalone and provider-specific entrypoints.
 */
async function buildCoreBundle(): Promise<void> {
  await Deno.mkdir(OUTPUT_DIR, { recursive: true });

  const command = new Deno.Command(Deno.execPath(), {
    args: [
      'bundle',
      '--platform=browser',
      '--output',
      OUTPUT_FILE.pathname,
      ENTRY_FILE.pathname,
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

await buildCoreBundle();
