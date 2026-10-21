/**
 * `npm run demo` – cross-platform: enables DEMO_MODE (separate demo database + mock AI),
 * seeds sample data on first run, then starts the API.
 */
process.env.DEMO_MODE = 'true';

const { createContext } = await import('../context.js');
const { seedDemo } = await import('./seed.js');
const ctx = await createContext();
await seedDemo(ctx, { log: (m) => console.log(`[demo] ${m}`) });
await ctx.close();
await import('../index.js');

export {};
