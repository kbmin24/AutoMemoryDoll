import { loadEnvFile } from 'node:process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export function loadEnvironment(
  directory = fileURLToPath(new URL('../', import.meta.url)),
): void {
  // Node preserves existing variables, so load the higher-priority file first.
  for (const filename of ['.env.local', '.env']) {
    try {
      loadEnvFile(join(directory, filename));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
}
