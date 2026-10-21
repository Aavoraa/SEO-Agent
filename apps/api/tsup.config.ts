import { defineConfig } from 'tsup';

// Bundles the API + CLI with the workspace packages inlined; third-party deps stay in node_modules.
export default defineConfig({
  entry: { index: 'src/index.ts', vercel: 'src/vercel.ts', cli: 'src/cli/index.ts', migrate: 'src/cli/migrate.ts', 'seed-demo': 'src/cli/seed-demo.ts' },
  format: ['esm'],
  platform: 'node',
  target: 'node20',
  outDir: 'dist',
  clean: true,
  sourcemap: true,
  splitting: true,
  noExternal: [/^@phoenixx\//],
  // Everything that is not a workspace package stays external (PGlite ships WASM assets next to its JS).
  external: [/^(?!@phoenixx\/)[^./]/],
});
