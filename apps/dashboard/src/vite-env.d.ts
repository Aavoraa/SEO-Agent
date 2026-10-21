// Local declarations instead of `vite/client` types, so type-checking never depends on resolving the
// vite package's type definitions (this failed in Vercel's build with TS2688).
interface ImportMetaEnv {
  readonly VITE_API_URL?: string;
  readonly VITE_API_PROXY?: string;
  readonly MODE: string;
  readonly DEV: boolean;
  readonly PROD: boolean;
}
interface ImportMeta {
  readonly env: ImportMetaEnv;
}
declare module '*.css';
