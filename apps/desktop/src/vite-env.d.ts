/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_OPENKT_API?: 'mock' | 'http';
  readonly VITE_OPENKT_BASE_URL?: string;
  readonly VITE_OPENKT_TOKEN?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
