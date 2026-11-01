import type { Request, RequestHandler } from 'express';
import type { Database } from '../users/users.repository.js';
import { cookieName, validCsrf, verifySession, type AuthConfig } from './auth.service.js';
import { AccountError } from '../users/users.service.js';

export type CurrentUser = { id: string; username: string; role: string; disabled: boolean };
export type AuthRequest = Request & { currentUser?: CurrentUser; sessionJti?: string };

function readCookie(header: string | undefined, name: string) {
  const pair = header?.split(';').map(value => value.trim()).find(value => value.startsWith(name + '='));
  return pair?.slice(name.length + 1);
}

export function requireUser(db: Database, config: AuthConfig): RequestHandler {
  return async (request, _response, next) => {
    const token = readCookie(request.headers.cookie, cookieName);
    const session = token && await verifySession(db, config, token);
    if (!session) return next(new AccountError('Authentication required', 401));
    (request as AuthRequest).currentUser = session.user;
    (request as AuthRequest).sessionJti = session.jti;
    next();
  };
}

export function requireAdmin(): RequestHandler {
  return (request, _response, next) => {
    if (!['admin', 'owner'].includes((request as AuthRequest).currentUser?.role ?? ''))
      return next(new AccountError('Forbidden', 403));
    next();
  };
}

export function requireOwner(): RequestHandler {
  return (request, _response, next) => {
    if ((request as AuthRequest).currentUser?.role !== 'owner')
      return next(new AccountError('Forbidden', 403));
    next();
  };
}

export function requireCsrf(config: AuthConfig): RequestHandler {
  return (request, _response, next) => {
    const jti = (request as AuthRequest).sessionJti;
    if (!jti || !validCsrf(config, jti, request.header('X-CSRF-Token')))
      return next(new AccountError('CSRF token required', 403));
    next();
  };
}
