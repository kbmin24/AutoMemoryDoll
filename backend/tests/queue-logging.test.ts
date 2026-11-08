import { Queue } from 'bullmq';
import { expect, it, vi } from 'vitest';
import { createJobQueue } from '../src/jobs/queue.js';
import { captureLogs } from './helpers/logging.js';

it('handles producer Queue errors through the logger without raw BullMQ fallback output', async () => {
  const { logger, events } = captureLogs();
  const output = vi.spyOn(console, 'error').mockImplementation(() => {});
  const handle = createJobQueue('redis://127.0.0.1:1', logger);
  // Exercise the actual Queue event bus, without requiring a Redis server.
  const queue = (handle.publisher as unknown as { queue: Queue }).queue;
  try {
    queue.emit(
      'error',
      Object.assign(new Error('SECRET'), { command: { args: ['SECRET'] } }),
    );
    expect(
      events.find((event) => event.message === 'queue.error'),
    ).toMatchObject({
      level: 'error',
      errorCode: 'unexpected',
    });
    expect(output.mock.calls.flat().map(String).join('')).not.toContain(
      'SECRET',
    );
    expect(
      events.find((event) => event.message === 'queue.error'),
    ).toMatchObject({
      errorMessage: 'SECRET',
      stack: expect.stringContaining('Error: SECRET'),
    });
    expect(JSON.stringify(events)).not.toContain('command');
  } finally {
    await handle.close();
    output.mockRestore();
  }
});
