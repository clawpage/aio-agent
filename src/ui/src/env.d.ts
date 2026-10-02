/** Build-time settings Vite substitutes into the bundle. */
interface ImportMetaEnv {
  /** The control plane's origin when it is not this page's own (a packaged app). */
  readonly VITE_AIO_API_BASE?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
