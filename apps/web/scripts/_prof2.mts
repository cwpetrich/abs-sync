import 'dotenv/config';
import { diffAgainstTarget, DEFAULT_DIFF_OPTIONS } from '@abs-sync/core';
import { prisma } from '../lib/db.js';
import { rowToRecord } from '../lib/records.js';
const target = (await prisma.server.findFirst({ where: { isTarget: true } }))!;
const sources = await prisma.server.findMany({ where: { enabled: true, id: { not: target.id } } });
const tRec = (await prisma.indexedItem.findMany({ where: { serverId: target.id, library: { included: true } } })).map(rowToRecord);
const sRec = (await prisma.indexedItem.findMany({ where: { serverId: { in: sources.map(s => s.id) }, library: { included: true } } })).map(rowToRecord);
for (let i = 0; i < 3; i++) {
  const t = performance.now();
  const d = diffAgainstTarget(sRec, tRec, DEFAULT_DIFF_OPTIONS);
  console.log(`run ${i+1}: ${(performance.now() - t).toFixed(0)}ms · present ${d.stats.present} missing ${d.stats.missing} uncertain ${d.stats.uncertain} bytes ${(d.stats.missingBytes / 1099511627776).toFixed(2)} TiB`);
}
await prisma.$disconnect();
