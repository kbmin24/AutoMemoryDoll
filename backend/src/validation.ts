import type { RequestHandler } from 'express';
import { validationResult } from 'express-validator';

export const USERNAME_PATTERN = /^[A-Za-z0-9_][A-Za-z0-9_-]{2,63}$/;
export const ACCOUNT_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const validateRequest: RequestHandler = (request, response, next) => {
  if (!validationResult(request).isEmpty()) {
    response.status(400).json({ error: 'Invalid request' });
    return;
  }

  next();
};

export const validateAccountId: RequestHandler = (request, response, next) => {
  if (!validationResult(request).isEmpty()) {
    response.status(404).json({ error: 'User not found' });
    return;
  }

  next();
};
