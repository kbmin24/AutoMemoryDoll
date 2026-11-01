import type { PrismaClient } from '../generated/prisma/client.js';

export type Database = PrismaClient;

export function findUserByUsername(db: Database, username: string) {
  return db.user.findUnique({ where: { username } });
}

export function findUserById(db: Database, id: string) {
  return db.user.findUnique({ where: { id } });
}

export function listUsers(db: Database) {
  return db.user.findMany({ orderBy: { username: 'asc' }, select: { id: true, username: true, role: true, disabled: true } });
}

export function publicUser(user: { id: string; username: string; role: string; disabled: boolean }) {
  return { id: user.id, username: user.username, role: user.role, disabled: user.disabled };
}
