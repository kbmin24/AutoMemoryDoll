import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Client } from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createAiQuotaRepository } from '../src/ai/ai-quota.repository.js';
import { createApp } from '../src/app.js';
import { cookieName, issueSession } from '../src/auth/auth.service.js';
import { createPrismaClient } from '../src/db/prisma.js';

const baseUrl = process.env.TEST_DATABASE_URL;
const defaults = { appMonthlyTokens: 5_000_000, userMonthlyTokens: 100_000 };
const route = '/api/admin/ai/quotas';
const config = {
  jwtSecret: 'test-secret-at-least-32-characters-long',
  cookieHours: 1,
};

async function session(role: string) {
  const user = {
    id: randomUUID(),
    username: role,
    role,
    disabled: false,
    tokenVersion: 0,
  };
  const { token, csrfToken } = await issueSession(config, user);
  return { user, cookie: `${cookieName}=${token}`, csrfToken };
}

describe('AI quota routes', () => {
  async function fixture(role: string, used = 0n, limit = 100_000) {
    const auth = await session(role);
    const db = {
      aiAppMonthlyUsage: {
        findUnique: async () => (used === 0n ? null : { usedTokens: used }),
      },
      aiUserMonthlyUsage: {
        findUnique: async ({
          where,
        }: {
          where: { month_userId: { userId: string } };
        }) => {
          expect(where.month_userId.userId).toBe(auth.user.id);
          return used === 0n ? null : { usedTokens: used };
        },
      },
      user: { findUnique: async () => auth.user },
      setting: {
        findUnique: async () => null,
        findMany: async () => [
          { key: 'ai.appMonthlyTokens', value: 5_000_000 },
          { key: 'ai.userMonthlyTokens', value: limit },
        ],
      },
    } as unknown as ReturnType<typeof createPrismaClient>;
    return { ...auth, http: request(createApp(db, config)) };
  }

  it.each(['owner', 'admin'])('allows %s to read quotas', async (role) => {
    const { http, cookie } = await fixture(role);
    await http.get(route).set('Cookie', cookie).expect(200, defaults);
  });

  it.each([
    [42_999n, 100_000, 42],
    [100_001n, 100_000, 100],
    [0n, 100_000, 0],
    [0n, 0, null],
  ])(
    'returns only the personal usage percentage',
    async (used, limit, percentUsed) => {
      const { http, cookie } = await fixture('user', used, limit);
      const usageRoute = '/api/auth/ai-usage';
      await http.get(usageRoute).expect(401);
      await http
        .get(usageRoute)
        .query({ userId: randomUUID() })
        .set('Cookie', cookie)
        .expect(400);
      await http
        .get(usageRoute)
        .set('Cookie', cookie)
        .expect('Cache-Control', 'private, no-store')
        .expect(200, { percentUsed });
    },
  );

  it('limits exact application usage to admins and owners', async () => {
    const path = '/api/admin/ai/usage';
    const member = await fixture('user', 9_007_199_254_740_993n);
    await member.http.get(path).expect(401);
    await member.http.get(path).set('Cookie', member.cookie).expect(403);

    for (const role of ['admin', 'owner']) {
      const { http, cookie } = await fixture(role, 9_007_199_254_740_993n);
      await http
        .get(path)
        .set('Cookie', cookie)
        .expect('Cache-Control', 'private, no-store')
        .expect(200)
        .expect(({ body }) => {
          expect(body).toEqual({
            usedTokens: '9007199254740993',
            quotaTokens: 5_000_000,
            userQuotaTokens: 100_000,
            enabled: true,
            resetsAt: expect.stringMatching(/^\d{4}-\d{2}-01T00:00:00\.000Z$/),
          });
        });
    }

    const empty = await fixture('admin');
    await empty.http
      .get(path)
      .set('Cookie', empty.cookie)
      .expect(200)
      .expect(({ body }) => expect(body.usedTokens).toBe('0'));
  });

  it('rejects anonymous and regular users for both methods', async () => {
    const { http, cookie, csrfToken } = await fixture('user');
    for (const method of ['get', 'patch'] as const) {
      await http[method](route).expect(401);
      await http[method](route)
        .set('Cookie', cookie)
        .set('X-CSRF-Token', csrfToken)
        .expect(403);
    }
  });

  it('requires CSRF and rejects invalid updates', async () => {
    const { http, cookie, csrfToken } = await fixture('owner');
    await http
      .patch(route)
      .set('Cookie', cookie)
      .send({ appMonthlyTokens: 0 })
      .expect(403);
    for (const body of [
      {},
      [],
      { extra: 1 },
      { appMonthlyTokens: 1, extra: 1 },
      { userMonthlyTokens: '1' },
      { userMonthlyTokens: null },
      { userMonthlyTokens: -1 },
      { userMonthlyTokens: 0.5 },
      { appMonthlyTokens: Number.MAX_SAFE_INTEGER + 1 },
    ]) {
      await http
        .patch(route)
        .set('Cookie', cookie)
        .set('X-CSRF-Token', csrfToken)
        .send(body)
        .expect(400);
    }
  });
});

describe.skipIf(!baseUrl)('PostgreSQL AI quotas', () => {
  const schema = `ai_quota_${randomUUID().replaceAll('-', '')}`;
  let postgres: Client;
  let db: ReturnType<typeof createPrismaClient>;
  let quota: ReturnType<typeof createAiQuotaRepository>;
  let now: Date;

  beforeAll(async () => {
    postgres = new Client({ connectionString: baseUrl });
    await postgres.connect();
    const url = new URL(baseUrl!);
    url.searchParams.set('schema', schema);
    execFileSync(
      'npm',
      ['--workspace', 'backend', 'run', 'db:migrate:deploy'],
      {
        cwd: new URL('../../', import.meta.url),
        env: { ...process.env, DATABASE_URL: url.toString() },
        stdio: 'pipe',
      },
    );
    db = createPrismaClient(url.toString());
    expect(await createAiQuotaRepository(db).getLimits()).toEqual(defaults);
  }, 30_000);

  afterAll(async () => {
    await db?.$disconnect();
    if (postgres) {
      await postgres.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await postgres.end();
    }
  });

  beforeEach(async () => {
    now = new Date('2026-11-30T23:59:59.999Z');
    quota = createAiQuotaRepository(db, () => now);
    await db.aiQuotaReservation.deleteMany();
    await db.aiUserMonthlyUsage.deleteMany();
    await db.aiAppMonthlyUsage.deleteMany();
    await quota.setLimits({ appMonthlyTokens: 10, userMonthlyTokens: 6 });
  });

  it('backfills both totals from settled and outstanding legacy reservations', async () => {
    const legacySchema = `${schema}_legacy`;
    const migrationSql = (name: string) =>
      readFileSync(
        new URL(`../prisma/migrations/${name}/migration.sql`, import.meta.url),
        'utf8',
      );
    await postgres.query(`CREATE SCHEMA "${legacySchema}"`);
    try {
      await postgres.query(`SET search_path TO "${legacySchema}"`);
      await postgres.query(migrationSql('20261121000000_ai_quotas'));
      const first = randomUUID();
      const second = randomUUID();
      await postgres.query(
        `INSERT INTO ai_quota_reservations VALUES
         ($1, $2, '2026-11-01', 8, 3),
         ($3, $2, '2026-11-01', 5, NULL),
         ($4, $5, '2026-11-01', 6, 0),
         ($6, $5, '2026-12-01', 7, 4)`,
        [randomUUID(), first, randomUUID(), randomUUID(), second, randomUUID()],
      );
      await postgres.query(migrationSql('20261122000000_ai_monthly_usage'));
      const app = await postgres.query(
        'SELECT used_tokens FROM ai_app_monthly_usage ORDER BY month',
      );
      expect(app.rows).toEqual([{ used_tokens: '8' }, { used_tokens: '4' }]);
      const users = await postgres.query(
        'SELECT user_id, used_tokens FROM ai_user_monthly_usage ORDER BY month, used_tokens DESC',
      );
      expect(users.rows).toEqual([
        { user_id: first, used_tokens: '8' },
        { user_id: second, used_tokens: '0' },
        { user_id: second, used_tokens: '4' },
      ]);
    } finally {
      await postgres.query('ROLLBACK');
      await postgres.query('RESET search_path');
      await postgres.query(`DROP SCHEMA "${legacySchema}" CASCADE`);
    }
  });

  it('records actual usage above the reservation and blocks further admission', async () => {
    const user = randomUUID();
    const id = await quota.reserve(user, 3);
    expect(await quota.getUserUsagePercent(user)).toBe(50);
    await quota.settle(id, 11);
    expect(await quota.getUserUsagePercent(user)).toBe(100);
    await expect(quota.reserve(randomUUID(), 1)).rejects.toMatchObject({
      scope: 'app',
    });
  });

  it('denies reservations against each quota independently', async () => {
    const user = randomUUID();
    await quota.reserve(user, 6);
    await expect(quota.reserve(user, 1)).rejects.toMatchObject({
      scope: 'user',
    });
    await expect(quota.reserve(randomUUID(), 5)).rejects.toMatchObject({
      scope: 'app',
    });
    await quota.reserve(randomUUID(), 4);
  });

  it.each(['app', 'user'])(
    'serializes concurrent reservations against the %s quota',
    async (scope) => {
      const user = randomUUID();
      const other = scope === 'app' ? randomUUID() : user;
      if (scope === 'user') await quota.setLimits({ appMonthlyTokens: 12 });
      const results = await Promise.allSettled([
        quota.reserve(user, 6),
        quota.reserve(other, 6),
      ]);
      expect(
        results.filter(({ status }) => status === 'fulfilled'),
      ).toHaveLength(1);
      expect(results).toContainEqual(
        expect.objectContaining({
          status: 'rejected',
          reason: expect.objectContaining({ scope }),
        }),
      );
    },
  );

  it('settles in the admission month exactly once and retains unknown usage', async () => {
    const user = randomUUID();
    const november = now;
    const id = await quota.reserve(user, 6);
    expect((await quota.getAppUsage()).resetsAt).toEqual(
      new Date('2026-12-01T00:00:00Z'),
    );
    await expect(quota.reserve(user, 1)).rejects.toMatchObject({
      scope: 'user',
    });
    now = new Date('2026-12-01T00:00:00Z');
    await quota.reserve(user, 6);
    await quota.settle(id, 2);
    await quota.settle(id, 0);
    await expect(quota.reserve(user, 1)).rejects.toMatchObject({
      scope: 'user',
    });
    now = november;
    await expect(quota.reserve(user, 5)).rejects.toMatchObject({
      scope: 'user',
    });
    await quota.reserve(user, 4);
  });

  it('stores quota limits alongside unrelated settings and merges concurrent updates', async () => {
    await db.setting.create({
      data: { key: 'test.unrelated', value: { enabled: true } },
    });
    await Promise.all([
      quota.setLimits({ appMonthlyTokens: 20 }),
      quota.setLimits({ userMonthlyTokens: 8 }),
    ]);
    expect(await quota.getLimits()).toEqual({
      appMonthlyTokens: 20,
      userMonthlyTokens: 8,
    });
    expect(
      await db.setting.findUnique({ where: { key: 'test.unrelated' } }),
    ).toMatchObject({ value: { enabled: true } });
  });

  it('persists the kill switch without changing usage or quotas', async () => {
    const auth = await session('admin');
    await db.user.create({
      data: {
        ...auth.user,
        username: 'switch-admin',
        displayId: 'switch-admin',
        passwordHash: 'unused',
      },
    });
    const member = await session('user');
    await db.user.create({
      data: {
        ...member.user,
        displayId: member.user.username,
        passwordHash: 'unused',
      },
    });
    const http = request(createApp(db, config));
    const path = '/api/admin/ai/enabled';
    const patch = (enabled: unknown) =>
      http
        .patch(path)
        .set('Cookie', auth.cookie)
        .set('X-CSRF-Token', auth.csrfToken)
        .send({ enabled });
    await http.patch(path).send({ enabled: false }).expect(401);
    await http
      .patch(path)
      .set('Cookie', member.cookie)
      .set('X-CSRF-Token', member.csrfToken)
      .send({ enabled: false })
      .expect(403);
    await http
      .patch(path)
      .set('Cookie', auth.cookie)
      .send({ enabled: false })
      .expect(403);
    await patch('false').expect(400);
    const userId = randomUUID();
    const pending = await quota.reserve(userId, 5);
    await patch(false).expect(200, { enabled: false });
    expect(await createAiQuotaRepository(db).isEnabled()).toBe(false);
    await expect(quota.reserve(userId, 1)).rejects.toThrow(
      'AI features are disabled.',
    );
    await quota.settle(pending, 3);
    expect((await quota.getAppUsage()).usedTokens).toBe(3n);
    expect(await quota.getLimits()).toEqual({
      appMonthlyTokens: 10,
      userMonthlyTokens: 6,
    });
    await patch(true).expect(200, { enabled: true });
    await expect(quota.reserve(userId, 1)).resolves.toBeTypeOf('string');
  });

  it('fails closed when a stored quota is invalid', async () => {
    await db.setting.update({
      where: { key: 'ai.userMonthlyTokens' },
      data: { value: '6' },
    });
    await expect(quota.reserve(randomUUID(), 1)).rejects.toThrow(
      'Invalid AI quota setting',
    );
  });

  it('preserves usage when an owner or admin changes a limit', async () => {
    const user = randomUUID();
    await quota.reserve(user, 5);
    const http = request(createApp(db, config));
    for (const role of ['owner', 'admin']) {
      const auth = await session(role);
      await db.user.create({
        data: {
          ...auth.user,
          displayId: auth.user.username,
          passwordHash: 'unused',
        },
      });
      const limit = role === 'owner' ? 4 : 0;
      await http
        .patch(route)
        .set('Cookie', auth.cookie)
        .set('X-CSRF-Token', auth.csrfToken)
        .send({ userMonthlyTokens: limit })
        .expect(200, { appMonthlyTokens: 10, userMonthlyTokens: limit });
      await expect(quota.reserve(user, 1)).rejects.toMatchObject({
        scope: 'user',
      });
    }
    await quota.setLimits({ userMonthlyTokens: 6 });
    await expect(quota.reserve(user, 2)).rejects.toMatchObject({
      scope: 'user',
    });
  });
});
