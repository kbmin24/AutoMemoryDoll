import argon2 from 'argon2';
import type { Database } from './users.repository.js';
import { findUserByUsername, publicUser } from './users.repository.js';

export class AccountError extends Error {
  constructor(message: string, public status = 400) { super(message); }
}

export function validateUsername(username: unknown): string {
  if (typeof username !== 'string' || !/^[A-Za-z0-9_][A-Za-z0-9_-]{2,63}$/.test(username)) {
    throw new AccountError('Username must be 3–64 letters, digits, underscores, or hyphens');
  }
  return username;
}

export function validatePassword(password: unknown): string {
  if (typeof password !== 'string' || password.length < 12 || password.length > 1024) {
    throw new AccountError('Password must be 12–1024 characters');
  }
  return password;
}

export async function createOwner(db: Database, username: string, password: string) {
  const name = validateUsername(username);
  const hash = await argon2.hash(validatePassword(password), { type: argon2.argon2id });
  if (await db.user.findFirst({ where: { role: 'owner' } })) throw new AccountError('Owner already exists', 409);
  try {
    const user = await db.user.create({ data: { username: name, passwordHash: hash, role: 'owner' } });
    return publicUser(user);
  } catch (error) {
    if (await db.user.findFirst({ where: { role: 'owner' } })) throw new AccountError('Owner already exists', 409);
    throw error;
  }
}

export async function createRegularUser(db: Database, username: unknown, password: unknown) {
  const name = validateUsername(username);
  const hash = await argon2.hash(validatePassword(password), { type: argon2.argon2id });
  if (await findUserByUsername(db, name)) throw new AccountError('Username already exists', 409);
  try {
    return publicUser(await db.user.create({ data: { username: name, passwordHash: hash, role: 'user' } }));
  } catch {
    throw new AccountError('Username already exists', 409);
  }
}

function validateAccountId(id: string) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
    throw new AccountError('User not found', 404);
  }
}

export async function setDisabled(db: Database, id: string, disabled: unknown) {
  validateAccountId(id);
  if (typeof disabled !== 'boolean') throw new AccountError('disabled must be a boolean');
  const changed = await db.user.updateMany({
    where: {
      id,
      role: { not: 'owner' }
    },
    data: {
      disabled,
      tokenVersion: { increment: 1 }
    }
  });
  if (!changed.count) throw new AccountError('User not found', 404);
  return publicUser((await db.user.findUniqueOrThrow({ where: { id } })));
}

export async function setRole(db: Database, id: string, role: unknown) {
  validateAccountId(id);
  if (role !== 'user' && role !== 'admin') throw new AccountError('Role must be user or admin');
  const changed = await db.user.updateMany({ 
    where: {
      id,
      role: { not: 'owner' }
    }, data: {
      role,
      tokenVersion: { increment: 1 }
    } });
  if (!changed.count) throw new AccountError('User not found', 404);
  return publicUser((await db.user.findUniqueOrThrow({ where: { id } })));
}
