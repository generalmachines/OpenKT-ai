/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_OPENKT_API?: 'mock' | 'http';
  /** Build-time default server (see src/api/config.ts). */
  readonly VITE_OPENKT_SERVER_URL?: string;
  /** Older name for the same thing; still honoured. */
  readonly VITE_OPENKT_BASE_URL?: string;
  readonly VITE_OPENKT_TOKEN?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
