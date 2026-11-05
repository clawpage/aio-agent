/** Build-time settings Vite substitutes into the bundle. */
interface ImportMetaEnv {
  /** The control plane's origin when it is not this page's own (a packaged app). */
  readonly VITE_AIO_API_BASE?: string;
  /** This build's release (package.json), stamped by vite.config.ts; absent under tests. */
  readonly VITE_AIO_UI_VERSION?: string;
  /** True in a production build (`vite build`), false under the dev server. */
  readonly PROD: boolean;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
