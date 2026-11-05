/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_ENGINE?: 'browser' | 'server';
  readonly VITE_ARBITRO_URL?: string;
}
