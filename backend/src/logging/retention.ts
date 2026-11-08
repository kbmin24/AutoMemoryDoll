import { lstat, readdir, unlink } from 'node:fs/promises';
import { basename, join } from 'node:path';

const logPattern = /^application-(\d{4}-\d{2}-\d{2})\.log(?:\.(\d+))?$/;

export async function cleanupLogs(
  directory: string,
  retentionDays: number,
  maxTotalBytes: number | undefined,
  activeFile: string,
): Promise<void> {
  const cutoff = Date.now() - retentionDays * 86_400_000;
  const files = [];
  for (const name of await readdir(directory)) {
    const match = logPattern.exec(name);
    if (!match) continue;
    const date = Date.parse(match[1]);
    if (!Number.isFinite(date) || new Date(date).toISOString().slice(0, 10) !== match[1])
      continue;
    let info;
    try {
      info = await lstat(join(directory, name));
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') continue;
      throw error;
    }
    if (!info.isFile()) continue;
    files.push({
      name,
      size: info.size,
      date,
      modified: info.mtimeMs,
    });
  }
  files.sort((a, b) => a.date - b.date || a.modified - b.modified);
  let total = files.reduce((sum, file) => sum + file.size, 0);
  for (const file of files) {
    if (file.name === basename(activeFile)) continue;
    if (file.date >= cutoff && (maxTotalBytes === undefined || total <= maxTotalBytes))
      continue;
    try {
      await unlink(join(directory, file.name));
      total -= file.size;
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT'))
        throw error;
    }
  }
}
