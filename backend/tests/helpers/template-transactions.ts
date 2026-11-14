// This unit-test double models rollback, not cross-process PostgreSQL locking.
export function addTemplateTransactions(db: any) {
  db.$transaction = async (action: any) => {
    const before = new Map<string, any>();
    const template = {
      ...db.template,
      findFirst: async (args: any) => {
        const row = await db.template.findFirst(args);
        if (row && !before.has(row.id))
          before.set(row.id, structuredClone(row));
        return row;
      },
    };
    try {
      return await action({
        ...db,
        template,
        $executeRaw: async () => 0,
        $queryRaw: async () => [],
      });
    } catch (error) {
      for (const row of before.values()) {
        await db.template.updateMany?.({
          where: { id: row.id, ownedBy: row.ownedBy },
          data: row,
        });
      }
      throw error;
    }
  };
  return db;
}
