import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const target = env.VITE_API_PROXY || process.env.VITE_API_PROXY || 'http://localhost:4000';
  return {
    plugins: [react(), tailwindcss()],
    server: {
      port: 5173,
      strictPort: true,
      proxy: { '/api': { target, changeOrigin: true } },
    },
    preview: { port: 5173, proxy: { '/api': { target, changeOrigin: true } } },
    build: { outDir: 'dist', sourcemap: false, chunkSizeWarningLimit: 1200 },
  };
});
