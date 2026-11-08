import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import argon2 from 'argon2';
import { SignJWT, jwtVerify } from 'jose';
import type { Database } from '../users/users.repository.js';
import {
  findUserById,
  findUserByUsername,
  publicUser,
} from '../users/users.repository.js';
import { AccountError, validatePassword } from '../users/users.service.js';

export type AuthConfig = {
  jwtSecret: string;
  cookieHours: number;
  cookieSecure?: boolean;
};
export const cookieName = 'amd_session';

const encoder = new TextEncoder();

function key(config: AuthConfig) {
  return encoder.encode(config.jwtSecret);
}

export function csrfToken(config: AuthConfig, jti: string) {
  return createHmac('sha256', config.jwtSecret)
    .update('csrf:' + jti)
    .digest('base64url');
}

export function validCsrf(config: AuthConfig, jti: string, supplied: unknown) {
  if (typeof supplied !== 'string') {
    return false;
  }

  const expected = Buffer.from(csrfToken(config, jti));
  const actual = Buffer.from(supplied);

  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

export async function issueSession(
  config: AuthConfig,
  user: { id: string; tokenVersion: number },
) {
  const jti = randomUUID();
  const token = await new SignJWT({ version: user.tokenVersion })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(user.id)
    .setJti(jti)
    .setIssuedAt()
    .setExpirationTime(`${config.cookieHours}h`)
    .sign(key(config));

  return { token, csrfToken: csrfToken(config, jti) };
}

export async function verifySession(
  db: Database,
  config: AuthConfig,
  token: string,
) {
  try {
    const { payload } = await jwtVerify(token, key(config), {
      algorithms: ['HS256'],
    });
    if (!payload.sub || !payload.jti || typeof payload.version !== 'number') {
      return null;
    }

    const user = await findUserById(db, payload.sub);
    if (!user || user.disabled || user.tokenVersion !== payload.version) {
      return null;
    }

    return { user: publicUser(user), jti: payload.jti };
  } catch {
    return null;
  }
}

export async function authenticate(
  db: Database,
  username: unknown,
  password: unknown,
) {
  if (typeof username !== 'string' || typeof password !== 'string') {
    throw new AccountError('Invalid credentials', 401);
  }

  const user = await findUserByUsername(db, username);
  if (
    !user ||
    user.disabled ||
    !(await argon2.verify(user.passwordHash, password))
  ) {
    throw new AccountError('Invalid credentials', 401);
  }

  const changed = await db.user.updateMany({
    where: { id: user.id, tokenVersion: user.tokenVersion, disabled: false },
    data: { tokenVersion: { increment: 1 } },
  });
  if (!changed.count) {
    throw new AccountError('Invalid credentials', 401);
  }

  return db.user.findUniqueOrThrow({ where: { id: user.id } });
}

export async function changePassword(
  db: Database,
  userId: string,
  current: unknown,
  next: unknown,
) {
  if (typeof current !== 'string') {
    throw new AccountError('Current password is incorrect', 401);
  }

  const user = await findUserById(db, userId);
  if (!user || !(await argon2.verify(user.passwordHash, current))) {
    throw new AccountError('Current password is incorrect', 401);
  }

  const hash = await argon2.hash(validatePassword(next), {
    type: argon2.argon2id,
  });
  await db.user.update({
    where: { id: userId },
    data: { passwordHash: hash, tokenVersion: { increment: 1 } },
  });
}
