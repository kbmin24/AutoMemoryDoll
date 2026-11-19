import { expect, it, vi } from 'vitest';
import argon2 from 'argon2';
import { bootstrapOwner } from '../src/cli/bootstrap-owner.js';

it('keeps an existing owner and password when deployment is repeated', async () => {
  const create = vi.fn();
  const db = {
    user: { findFirst: async () => ({ id: 'existing-owner' }), create },
  };
  expect(await bootstrapOwner(db as any, {})).toBeNull();
  expect(create).not.toHaveBeenCalled();
});

it('requires valid initial credentials before creating any account', async () => {
  const create = vi.fn();
  const db = { user: { findFirst: async () => null, create } };
  await expect(bootstrapOwner(db as any, {})).rejects.toThrow();
  await expect(
    bootstrapOwner(db as any, {
      OWNER_USERNAME: 'owner',
      OWNER_PASSWORD: 'short',
    }),
  ).rejects.toThrow();
  expect(create).not.toHaveBeenCalled();
});

it('creates the initial owner with a hashed password using the existing account service', async () => {
  let stored: any;
  const db = {
    user: {
      findFirst: async () => null,
      create: async ({ data }: any) => {
        stored = { id: 'new-owner', ...data };
        return stored;
      },
    },
  };
  const user = await bootstrapOwner(db as any, {
    OWNER_USERNAME: 'owner',
    OWNER_PASSWORD: 'initial-owner-password',
  });
  expect(user).toMatchObject({
    id: 'new-owner',
    username: 'owner',
    role: 'owner',
  });
  expect(user).not.toHaveProperty('passwordHash');
  expect(stored.passwordHash).not.toBe('initial-owner-password');
  expect(
    await argon2.verify(stored.passwordHash, 'initial-owner-password'),
  ).toBe(true);
});
