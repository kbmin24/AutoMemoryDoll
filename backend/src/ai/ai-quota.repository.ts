import { databaseSchema } from '../db/prisma.js';
import { Prisma, type PrismaClient } from '../generated/prisma/client.js';

export type QuotaLimits = {
  appMonthlyTokens: number;
  userMonthlyTokens: number;
};

export class AiQuotaExceededError extends Error {
  constructor(readonly scope: 'app' | 'user') {
    super(
      scope === 'app'
        ? 'Application AI quota exceeded'
        : 'User AI quota exceeded',
    );
  }
}

export class AiDisabledError extends Error {
  constructor() {
    super('AI features are disabled.');
  }
}

const enabledKey = 'ai.enabled';
const appLimitKey = 'ai.appMonthlyTokens';
const userLimitKey = 'ai.userMonthlyTokens';

export function isTokenLimit(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

async function readEnabled(
  db: Pick<PrismaClient, 'setting'>,
): Promise<boolean> {
  const setting = await db.setting.findUnique({
    where: { key: enabledKey },
    select: { value: true },
  });
  return setting === null || setting.value === true;
}

async function readLimits(
  db: Pick<PrismaClient, 'setting'>,
): Promise<QuotaLimits> {
  const rows = await db.setting.findMany({
    where: { key: { in: [appLimitKey, userLimitKey] } },
  });
  const appMonthlyTokens = rows.find(({ key }) => key === appLimitKey)?.value;
  const userMonthlyTokens = rows.find(({ key }) => key === userLimitKey)?.value;
  if (!isTokenLimit(appMonthlyTokens) || !isTokenLimit(userMonthlyTokens)) {
    throw new Error('Invalid AI quota setting');
  }
  return { appMonthlyTokens, userMonthlyTokens };
}

function quotaMonth(now: Date): Date {
  const month = new Date(now);
  month.setUTCDate(1);
  month.setUTCHours(0, 0, 0, 0);
  return month;
}

export function createAiQuotaRepository(
  db: PrismaClient,
  clock: () => Date = () => new Date(),
) {
  const schema = Prisma.raw(`"${databaseSchema(db).replaceAll('"', '""')}"`);
  const settings = Prisma.sql`${schema}."settings"`;

  function withQuotaLock<T>(
    work: (tx: Prisma.TransactionClient) => Promise<T>,
  ) {
    return db.$transaction(
      async (tx) => {
        // Settings changes and quota writes share this lock.
        const rows = await tx.$queryRaw<Array<{ key: string }>>`
          SELECT key FROM ${settings} WHERE key = ${appLimitKey} FOR UPDATE
        `;
        if (rows.length !== 1) throw new Error('Invalid AI quota setting');
        return work(tx);
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted },
    );
  }

  return {
    async isEnabled(): Promise<boolean> {
      return readEnabled(db);
    },

    async setEnabled(enabled: boolean): Promise<void> {
      await withQuotaLock(async (tx) => {
        await tx.setting.upsert({
          where: { key: enabledKey },
          create: { key: enabledKey, value: enabled },
          update: { value: enabled },
        });
      });
    },

    async getLimits(): Promise<QuotaLimits> {
      return readLimits(db);
    },

    async getAppUsage() {
      const month = quotaMonth(clock());
      const [{ appMonthlyTokens, userMonthlyTokens }, usage, enabled] =
        await Promise.all([
          readLimits(db),
          db.aiAppMonthlyUsage.findUnique({
            where: { month },
            select: { usedTokens: true },
          }),
          readEnabled(db),
        ]);
      const resetsAt = new Date(month);
      resetsAt.setUTCMonth(month.getUTCMonth() + 1);
      return {
        usedTokens: usage?.usedTokens ?? 0n,
        quotaTokens: appMonthlyTokens,
        userQuotaTokens: userMonthlyTokens,
        resetsAt,
        enabled,
      };
    },

    async getUserUsagePercent(userId: string): Promise<number | null> {
      const month = quotaMonth(clock());
      const { userMonthlyTokens } = await readLimits(db);
      if (userMonthlyTokens === 0) return null;

      const usage = await db.aiUserMonthlyUsage.findUnique({
        where: { month_userId: { month, userId } },
        select: { usedTokens: true },
      });
      const percent =
        ((usage?.usedTokens ?? 0n) * 100n) / BigInt(userMonthlyTokens);
      return Number(percent > 100n ? 100n : percent);
    },

    async setLimits(limits: Partial<QuotaLimits>): Promise<QuotaLimits> {
      return withQuotaLock(async (tx) => {
        if (limits.appMonthlyTokens !== undefined) {
          await tx.setting.update({
            where: { key: appLimitKey },
            data: { value: limits.appMonthlyTokens },
          });
        }
        if (limits.userMonthlyTokens !== undefined) {
          await tx.setting.update({
            where: { key: userLimitKey },
            data: { value: limits.userMonthlyTokens },
          });
        }
        return readLimits(tx);
      });
    },

    async reserve(userId: string, tokens: number): Promise<string> {
      if (!Number.isSafeInteger(tokens) || tokens <= 0) {
        throw new RangeError(
          'Reservation requires a positive safe token count',
        );
      }

      return withQuotaLock(async (tx) => {
        if (!(await readEnabled(tx))) throw new AiDisabledError();
        const month = quotaMonth(clock());
        const limits = await readLimits(tx);
        const app = await tx.aiAppMonthlyUsage.findUnique({ where: { month } });
        const userKey = { month_userId: { month, userId } };
        const user = await tx.aiUserMonthlyUsage.findUnique({ where: userKey });
        const reservedTokens = BigInt(tokens);
        const appTotal = (app?.usedTokens ?? 0n) + reservedTokens;
        const userTotal = (user?.usedTokens ?? 0n) + reservedTokens;
        if (appTotal > BigInt(limits.appMonthlyTokens)) {
          throw new AiQuotaExceededError('app');
        }
        if (userTotal > BigInt(limits.userMonthlyTokens)) {
          throw new AiQuotaExceededError('user');
        }

        await tx.aiAppMonthlyUsage.upsert({
          where: { month },
          create: { month, usedTokens: appTotal },
          update: { usedTokens: appTotal },
        });
        await tx.aiUserMonthlyUsage.upsert({
          where: userKey,
          create: { month, userId, usedTokens: userTotal },
          update: { usedTokens: userTotal },
        });
        const { id } = await tx.aiQuotaReservation.create({
          data: { userId, month, reservedTokens },
          select: { id: true },
        });
        return id;
      });
    },

    async settle(reservationId: string, totalTokens: number): Promise<void> {
      if (!Number.isSafeInteger(totalTokens) || totalTokens < 0) {
        throw new RangeError(
          'Settlement requires a nonnegative safe token count',
        );
      }

      await withQuotaLock(async (tx) => {
        const settledTokens = BigInt(totalTokens);
        const [reservation] = await tx.aiQuotaReservation.updateManyAndReturn({
          where: { id: reservationId, settledTokens: null },
          data: { settledTokens },
          select: { month: true, userId: true, reservedTokens: true },
        });
        if (!reservation) return;

        const { month, userId, reservedTokens } = reservation;
        const adjustment = settledTokens - reservedTokens;
        await tx.aiAppMonthlyUsage.update({
          where: { month },
          data: { usedTokens: { increment: adjustment } },
        });
        await tx.aiUserMonthlyUsage.update({
          where: { month_userId: { month, userId } },
          data: { usedTokens: { increment: adjustment } },
        });
      });
    },
  };
}
