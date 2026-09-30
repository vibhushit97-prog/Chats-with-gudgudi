/// <reference types="vite/client" />

interface ImportMetaEnv {
  /**
   * Cloudflare Turnstile site key. When set, the landing page runs an invisible
   * Turnstile challenge before creating a room. Leave unset for local dev.
   */
  readonly VITE_TURNSTILE_SITE_KEY?: string;

  /**
   * Origin of the Cloudflare Worker backend for direct WebSocket connections.
   * In production (e.g. on Vercel), set to https://elm-chat.elm-chat-vibhu97.workers.dev.
   * If unset, defaults to window.location.origin.
   */
  readonly VITE_CLOUDFLARE_WORKER_ORIGIN?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

interface Window {
  turnstile?: {
    render: (container: string | HTMLElement, options: Record<string, unknown>) => string;
    execute: (widgetId: string, options?: Record<string, unknown>) => void;
    reset: (widgetId?: string) => void;
    remove: (widgetId: string) => void;
  };
}
