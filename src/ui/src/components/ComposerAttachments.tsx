import { LoadingMark } from "./Brand";
import { useCallback, useEffect, useRef, useState } from "react";
import type { Attachment } from "../types";
import { primeImage } from "../imageCache";
import { ComposerIcon } from "./ComposerControls";
import { t } from "../i18n";

/** A file picked and still uploading: shown in the tray at once, its picture drawn from the device. */
export interface PendingUpload {
  id: string;
  file: File;
  name: string;
  /** A local object URL of a picture, so it shows before the upload finishes. */
  preview: string | null;
}

let counter = 0;

/**
 * What the composer is about to send, as a tray of thumbnails: pictures as
 * pictures (drawn from the picked file, nothing fetched), other files as small
 * cards, uploads in progress dimmed with a spinner. A picture that uploads is
 * also handed to the image cache, so the sent message shows it at once.
 */
export function useUploadTray() {
  const [pending, setPendingState] = useState<PendingUpload[]>([]);
  // The same list, read synchronously when a message takes the uploads with it.
  const pendingNow = useRef<PendingUpload[]>([]);
  const setPending = (next: (old: PendingUpload[]) => PendingUpload[]) => {
    pendingNow.current = next(pendingNow.current);
    setPendingState(pendingNow.current);
  };
  const [previews, setPreviews] = useState<Record<string, string>>({});
  const owned = useRef(new Set<string>());
  useEffect(() => () => { owned.current.forEach((url) => URL.revokeObjectURL(url)); owned.current.clear(); }, []);
  const release = (url: string | null | undefined) => {
    if (!url) return;
    URL.revokeObjectURL(url);
    owned.current.delete(url);
  };

  const begin = useCallback((files: File[]): PendingUpload[] => {
    const queued = files.map((file) => {
      const preview = file.type.startsWith("image/") ? URL.createObjectURL(file) : null;
      if (preview) owned.current.add(preview);
      return { id: `upload-${++counter}`, file, name: file.name, preview };
    });
    setPending((old) => [...old, ...queued]);
    return queued;
  }, []);

  /** An upload finished (with what was stored) or failed (null). One handed to a sent message is its business now. */
  const settle = useCallback((item: PendingUpload, stored: Attachment | null) => {
    if (stored?.kind === "image") primeImage(stored.path, item.file);
    setPending((old) => old.filter((p) => p.id !== item.id));
    if (!item.preview || !owned.current.has(item.preview)) return;
    if (stored?.kind === "image") setPreviews((old) => ({ ...old, [stored.path]: item.preview! }));
    else release(item.preview);
  }, []);

  /**
   * Uploads still under way go with a message sent before they finish: they leave the tray, and
   * their previews now belong to the caller (revoke them with releasePreviews once done).
   */
  const handOff = useCallback((): PendingUpload[] => {
    const taken = pendingNow.current;
    setPending(() => []);
    for (const item of taken) if (item.preview) owned.current.delete(item.preview);
    return taken;
  }, []);

  const drop = useCallback((path: string) => {
    setPreviews((old) => {
      if (!(path in old)) return old;
      const { [path]: url, ...rest } = old;
      queueMicrotask(() => release(url));
      return rest;
    });
  }, []);

  const clear = useCallback(() => {
    setPreviews((old) => {
      const urls = Object.values(old);
      queueMicrotask(() => urls.forEach(release));
      return {};
    });
  }, []);

  return { pending, previews, begin, settle, drop, clear, handOff };
}

/** Revoke the previews of uploads handed off with a message, once that message no longer shows them. */
export function releasePreviews(items: PendingUpload[]): void {
  for (const item of items) if (item.preview) URL.revokeObjectURL(item.preview);
}

function badge(name: string): string {
  const ext = /\.([a-z0-9]{1,5})$/i.exec(name)?.[1];
  return ext ? ext.slice(0, 4).toUpperCase() : "FILE";
}

function size(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function ComposerAttachments({ items, pending, previews, disabled, onRemove }: {
  items: Attachment[];
  pending: PendingUpload[];
  previews: Record<string, string>;
  disabled?: boolean;
  onRemove: (path: string) => void;
}) {
  if (!items.length && !pending.length) return null;
  return (
    <div className="chips composer-tray" role="list" aria-label={t.app.attachments.tray}>
      {items.map((a) => {
        const picture = a.kind === "image" ? previews[a.path] : undefined;
        return (
          <span role="listitem" className={`chip tray-item ${picture ? "is-image" : "is-file"}`} key={a.path} title={a.name}>
            {picture ? <><img src={picture} alt="" /><span className="tray-hidden-name">{a.name}</span></> : (
              <>
                <span className="tray-badge" aria-hidden="true">{a.kind === "image" ? "IMG" : badge(a.name)}</span>
                <span className="tray-meta"><span className="tray-name">{a.name}</span><span className="tray-size">{size(a.size)}</span></span>
              </>
            )}
            <button type="button" className="tray-remove" aria-label={t.app.attachments.remove} disabled={disabled} onClick={() => onRemove(a.path)}><ComposerIcon kind="close" /></button>
          </span>
        );
      })}
      {pending.map((p) => (
        <span role="listitem" className={`chip tray-item uploading ${p.preview ? "is-image" : "is-file"}`} key={p.id} title={p.name} aria-label={t.app.attachments.uploadingName(p.name)}>
          {p.preview ? <img src={p.preview} alt="" /> : (
            <>
              <span className="tray-badge" aria-hidden="true">{badge(p.name)}</span>
              <span className="tray-meta"><span className="tray-name">{p.name}</span><span className="tray-size">{t.app.attachments.uploading}</span></span>
            </>
          )}
          <span className="tray-spinner" aria-hidden="true"><LoadingMark size={20} /></span>
        </span>
      ))}
    </div>
  );
}
