import { runStandaloneCLI } from './cli.ts';

try {
  await runStandaloneCLI(Deno.args);
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  Deno.exit(1);
}
