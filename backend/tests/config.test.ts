import { expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';

it('loads database configuration for the owner setup command without Redis', () => {
  const config = loadConfig({
    DATABASE_URL: 'postgresql://localhost/test',
    JWT_SECRET: 'test-secret-at-least-32-characters-long',
  });
  expect(config.databaseUrl).toBe('postgresql://localhost/test');
});

it.each([
  ['development', false],
  ['production', true],
  ['test', true],
  [undefined, true],
])('sets cookie security for NODE_ENV=%s', (nodeEnv, expected) => {
  const config = loadConfig({
    DATABASE_URL: 'postgresql://localhost/test',
    JWT_SECRET: 'test-secret-at-least-32-characters-long',
    NODE_ENV: nodeEnv,
  });
  expect(config.cookieSecure).toBe(expected);
});
