import { randomUUID } from 'node:crypto';
import { expect, it, vi } from 'vitest';
const storage = {
  withTemplateFileLock: async <T>(_id: string, action: () => Promise<T>) =>
    action(),
};
import { withTemplateLock } from '../src/templates/template-lock.js';
it('validates ownership after acquiring the cross-process row lock and settles work before returning failure', async () => {
  const id = randomUUID();
  const order: string[] = [];
  const tx = {
    $executeRaw: vi.fn(async () => {
      order.push('timeout');
    }),
    $queryRaw: vi.fn(async () => {
      order.push('lock');
      return [];
    }),
    template: {
      findFirst: vi.fn(async () => {
        order.push('read');
        return {
          id,
          ownedBy: 'self',
          manifest: { version: 1, shape: null },
          deletedAt: null,
        };
      }),
    },
  };
  const db = { $transaction: async (fn: any) => fn(tx) } as any;
  await expect(
    withTemplateLock(db, storage, id, 'self', async () => {
      order.push('copy');
      return 42;
    }),
  ).resolves.toBe(42);
  expect(order).toEqual(['timeout', 'lock', 'read', 'copy']);
  tx.template.findFirst.mockResolvedValueOnce(null as any);
  const action = vi.fn();
  await expect(
    withTemplateLock(db, storage, id, 'other', action),
  ).rejects.toThrow('Template not found');
  expect(action).not.toHaveBeenCalled();
});

it('waits for in-flight filesystem work to settle when its transaction has already expired', async () => {
  let enter!: () => void;
  let release!: () => void;
  const entered = new Promise<void>((r) => {
    enter = r;
  });
  const finish = new Promise<void>((r) => {
    release = r;
  });
  const tx = {
    $executeRaw: async () => 0,
    $queryRaw: async () => [],
    template: {
      findFirst: async () => ({
        id: randomUUID(),
        ownedBy: 'self',
        manifest: { version: 1, shape: null },
      }),
    },
  };
  const db = {
    $transaction: async (action: any) => {
      void action(tx).catch(() => {});
      await entered;
      throw new Error('expired');
    },
  } as any;
  let returned = false;
  const operation = withTemplateLock(
    db,
    storage,
    randomUUID(),
    null,
    async () => {
      enter();
      await finish;
      return 1;
    },
  ).catch((error) => {
    returned = true;
    return error;
  });
  await entered;
  await Promise.resolve();
  expect(returned).toBe(false);
  release();
  expect((await operation).message).toBe('expired');
});

it('does not run destructive post-commit work when committing a transaction fails', async () => {
  const tx = {
    $executeRaw: async () => 0,
    $queryRaw: async () => [],
    template: {
      findFirst: async () => ({
        id: randomUUID(),
        ownedBy: 'self',
        manifest: { version: 1, shape: null },
      }),
    },
  };
  const db = {
    $transaction: async (action: any) => {
      await action(tx);
      throw new Error('commit failed');
    },
  } as any;
  const afterCommit = vi.fn();
  const storage = {
    withTemplateFileLock: async (_id: string, action: any) => action(),
  } as any;
  await expect(
    withTemplateLock(
      db,
      storage,
      randomUUID(),
      null,
      async () => 42,
      afterCommit,
    ),
  ).rejects.toThrow('commit failed');
  expect(afterCommit).not.toHaveBeenCalled();
});
