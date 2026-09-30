import { PrismaClient } from '@prisma/client';

export const prisma = new PrismaClient();

// WAL lets the dashboard keep reading while an atomic scrape transaction is
// being committed. A busy timeout turns brief write contention into a wait
// instead of a misleading "database is locked" sync failure.
await prisma.$queryRawUnsafe('PRAGMA journal_mode = WAL');
await prisma.$queryRawUnsafe('PRAGMA busy_timeout = 10000');
await prisma.$queryRawUnsafe('PRAGMA foreign_keys = ON');
