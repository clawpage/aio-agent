import { useEffect, useRef, useState } from "react";
import { api } from "../api";

/**
 * In-conversation preview for a sandbox workspace image.
 *
 * The download endpoint replies with `application/octet-stream` and an
 * attachment disposition (the AIO sandbox does not inline PNGs), so the image is
 * fetched as a same-origin blob and shown through a typed object URL. The object
 * URL is revoked when the dialog closes or the path changes. Only the explicit
 * 下载 link performs the real attachment download.
 */

const IMAGE_MIME: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
  avif: "image/avif",
};

function fileName(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1) || path;
}

function imageMime(path: string): string {
  const name = fileName(path).toLowerCase();
  const ext = name.includes(".") ? name.slice(name.lastIndexOf(".") + 1) : "";
  return IMAGE_MIME[ext] ?? "application/octet-stream";
}

export function FilePreview({ path, onClose }: { path: string; onClose: () => void }) {
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const closeRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    let objectUrl: string | null = null;
    setStatus("loading");
    setError(null);
    setUrl(null);
    void (async () => {
      try {
        const res = await fetch(api.downloadUrl(path), { credentials: "same-origin", signal: controller.signal });
        if (!res.ok) throw new Error(`无法加载文件（HTTP ${res.status}）`);
        const buffer = await res.arrayBuffer();
        if (controller.signal.aborted) return;
        objectUrl = URL.createObjectURL(new Blob([buffer], { type: imageMime(path) }));
        setUrl(objectUrl);
        setStatus("ready");
      } catch (err) {
        if (controller.signal.aborted) return;
        setError(err instanceof Error ? err.message : String(err));
        setStatus("error");
      }
    })();
    return () => {
      controller.abort();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [path]);

  useEffect(() => {
    closeRef.current?.focus();
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        onClose();
      }
    };
    // Capture so Escape closes the lightbox before any other handler runs.
    document.addEventListener("keydown", onKeyDown, true);
    return () => document.removeEventListener("keydown", onKeyDown, true);
  }, [onClose]);

  return (
    <div
      className="file-preview-overlay"
      role="presentation"
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="file-preview" role="dialog" aria-modal="true" aria-label={`预览 ${fileName(path)}`}>
        <header className="file-preview-head">
          <span className="file-preview-name" title={path}>
            {fileName(path)}
          </span>
          <button type="button" className="ghost" onClick={onClose} ref={closeRef} aria-label="关闭预览">
            关闭
          </button>
        </header>
        <div className="file-preview-body">
          {status === "loading" && (
            <p className="muted" role="status">
              正在加载…
            </p>
          )}
          {status === "error" && (
            <p className="banner error" role="alert">
              {error}
            </p>
          )}
          {status === "ready" && url && <img src={url} alt={fileName(path)} data-testid="file-preview-image" />}
        </div>
        <footer className="file-preview-foot">
          <a className="primary" href={api.downloadUrl(path)} download={fileName(path)} data-testid="file-preview-download">
            下载
          </a>
        </footer>
      </div>
    </div>
  );
}
