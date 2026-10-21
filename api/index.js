// Vercel Node function: all /api/* requests are rewritten here (see vercel.json).
// The API is bundled during `vercel build` (npm run build → apps/api/dist/vercel.js).
export { default } from '../apps/api/dist/vercel.js';
