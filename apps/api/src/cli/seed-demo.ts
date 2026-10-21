#!/usr/bin/env node
/** Seeds the SEPARATE demo database with clearly-labelled sample data. Usage: npm run db:seed:demo */
import { createContext } from '../context.js';
import { seedDemo } from '../demo/seed.js';

const ctx = await createContext({ DEMO_MODE: true });
try {
  const res = await seedDemo(ctx, { log: (m) => console.log(`[demo] ${m}`) });
  console.log(res.created ? `\nDemo seeded. Start the API with DEMO_MODE=true and click "Explore demo" on the login page.` : '\nDemo already present.');
} finally {
  await ctx.close();
}
