import { PrismaClient } from '@prisma/client';
const p = new PrismaClient();
try {
  const rs = await p.$queryRawUnsafe(
    'SELECT name, country, state, "taxRateBps", "taxComponents" FROM restaurants ORDER BY "createdAt" DESC LIMIT 10'
  );
  for (const r of rs) {
    console.log(`- ${r.name} | ${r.country}/${r.state} | taxRateBps=${r.taxRateBps} | components=${JSON.stringify(r.taxComponents)}`);
  }
} catch (e) { console.error('ERR', e.message); }
finally { await p.$disconnect(); }
