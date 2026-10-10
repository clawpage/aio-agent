import { PopupPresence, PopupSurface } from "./PopupMotion";
import { openNativeBrowser } from "../deviceBrowser";
import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { mapLinks, platformOf, tilesFor, type MapPlace } from "../mapBlocks";
import { apiUrl, API_CREDENTIALS } from "../api";
import { t } from "../i18n";

/** Tiles around a point, drawn from the console's own tile proxy; no map library. */
function MapView({ place, zoom, height }: { place: MapPlace; zoom: number; height: number }) {
  const box = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    setWidth(el.clientWidth);
    if (typeof ResizeObserver !== "function") return;
    const observer = new ResizeObserver(() => setWidth(el.clientWidth));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  const tiles = width && place.lat !== null && place.lng !== null ? tilesFor(place.lat, place.lng, zoom, width, height) : [];
  return (
    <div ref={box} className="map-view" style={{ height }}>
      {tiles.map((t) => (
        <img key={t.key} src={apiUrl(`/api/map/tiles/${t.z}/${t.x}/${t.y}`)} alt="" loading="lazy" draggable={false} style={{ left: t.left, top: t.top }} />
      ))}
      <svg className="map-pin" width="28" height="38" viewBox="0 0 28 38" aria-hidden="true">
        <path d="M14 1C6.8 1 1 6.7 1 13.8 1 23.5 14 37 14 37s13-13.5 13-23.2C27 6.7 21.2 1 14 1Z" />
        <circle cx="14" cy="13.8" r="5" />
      </svg>
      <span className="map-attribution">© OpenStreetMap</span>
    </div>
  );
}

/**
 * The map app this device opens places in, once the person picked one. Kept in
 * this browser only: the installed apps differ per device, and a page cannot
 * see them.
 */
const APP_KEY = "aio.mapApp";
const APP_EVENT = "aio-map-app";
function savedApp(): string | null {
  try { return localStorage.getItem(APP_KEY); } catch { return null; }
}
function saveApp(id: string) {
  try { localStorage.setItem(APP_KEY, id); } catch { /* not remembered: the next tap asks again */ }
  window.dispatchEvent(new Event(APP_EVENT));
}
function useSavedApp(): string | null {
  const [app, setApp] = useState(savedApp);
  useEffect(() => {
    const update = () => setApp(savedApp());
    window.addEventListener(APP_EVENT, update);
    return () => window.removeEventListener(APP_EVENT, update);
  }, []);
  return app;
}

/** Universal links and app schemes only open apps from a real link the person taps. */
const linkProps = (href: string) => (href.startsWith("https:") ? { href, target: "_blank", rel: "noopener noreferrer" } : { href });

/** The app chooser: a larger map when located, and the map apps to show the place in. */
function MapSheet({ place, current, onClose }: { place: MapPlace; current: string | null; onClose: () => void }) {
  const [zoom, setZoom] = useState(Math.min(place.zoom + 1, 18));
  const close = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    close.current?.focus();
    const key = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    document.addEventListener("keydown", key);
    return () => document.removeEventListener("keydown", key);
  }, [onClose]);
  const located = place.lat !== null && place.lng !== null;
  const links = mapLinks(place, platformOf(navigator.userAgent));
  return createPortal(
    <PopupSurface className="map-sheet-backdrop" onClick={onClose}>
      <div className="map-sheet" role="dialog" aria-modal="true" aria-label={t.cards.map.sheet(place.name)} onClick={(e) => e.stopPropagation()}>
        <header className="map-sheet-head">
          <div>
            <h3>{place.name}</h3>
            {place.address && <p className="muted tiny">{place.address}</p>}
          </div>
          <button ref={close} type="button" className="ghost" onClick={onClose} aria-label={t.cards.map.close}>✕</button>
        </header>
        {located && (
          <div className="map-sheet-map">
            <MapView place={place} zoom={zoom} height={260} />
            <div className="map-zoom">
              <button type="button" aria-label={t.cards.map.zoomIn} disabled={zoom >= 18} onClick={() => setZoom((z) => Math.min(18, z + 1))}>＋</button>
              <button type="button" aria-label={t.cards.map.zoomOut} disabled={zoom <= 3} onClick={() => setZoom((z) => Math.max(3, z - 1))}>－</button>
            </div>
          </div>
        )}
        <p className="map-sheet-label">{t.cards.map.chooseApp}</p>
        <ul className="map-nav-list">
          {links.map((link) => (
            <li key={link.id}>
              <a {...linkProps(link.href)} data-nav={link.id} onClick={event => { if (openNativeBrowser(link.href)) event.preventDefault(); saveApp(link.id); onClose(); }}>
                <span>{link.label}</span>
                <span aria-hidden="true">{link.id === current ? t.cards.map.current : "›"}</span>
              </a>
            </li>
          ))}
        </ul>
        <p className="muted tiny map-sheet-note">{t.cards.map.note}</p>
      </div>
    </PopupSurface>,
    document.body,
  );
}

/**
 * A place in a message: a small map and the address. A tap shows the place in
 * the map app this device uses; the first time (except on Android, where the
 * system asks) it asks which app that is.
 */
export function MapCard({ place: given }: { place: MapPlace }) {
  const [place, setPlace] = useState(given);
  const [locating, setLocating] = useState(given.lat === null);
  const [open, setOpen] = useState(false);
  const saved = useSavedApp();
  const focusBack = useRef<HTMLButtonElement | HTMLAnchorElement | null>(null);
  // Back to the card itself: a tap does not focus a button in Safari, so there is no "previous focus" to restore.
  const closeSheet = useCallback(() => { setOpen(false); }, []);
  useEffect(() => {
    if (given.lat !== null) return;
    const controller = new AbortController();
    void (async () => {
      try {
        const res = await fetch(apiUrl(`/api/map/geocode?q=${encodeURIComponent(given.address ?? given.name)}`), { credentials: API_CREDENTIALS, signal: controller.signal });
        const body = (await res.json()) as { place?: { lat: number; lng: number } | null };
        if (res.ok && body.place) setPlace({ ...given, lat: body.place.lat, lng: body.place.lng });
      } catch {
        /* stays unlocated: the address still goes to the map apps */
      } finally {
        if (!controller.signal.aborted) setLocating(false);
      }
    })();
    return () => controller.abort();
  }, [given]);
  const located = place.lat !== null && place.lng !== null;
  const platform = platformOf(navigator.userAgent);
  const links = mapLinks(place, platform);
  const app = links.find((l) => l.id === (saved ?? (platform === "android" ? "system" : null))) ?? null;
  const pill = app ? (app.id === "system" ? t.cards.map.openMap : app.label) : t.cards.map.viewMap;
  const map = located ? <MapView place={place} zoom={place.zoom} height={150} />
    : locating ? <div className="map-view map-view-empty" style={{ height: 150 }}><span className="muted tiny">{t.cards.map.locating}</span></div>
    : null;
  const text = (
    <>
      <span className="map-card-text">
        <strong>{place.name}</strong>
        {place.address && <span className="muted tiny">{place.address}</span>}
      </span>
      <span className="map-card-action">{pill}</span>
    </>
  );
  return (
    <>
      <div className="map-card">
        {app ? (
          <>
            {map && <a {...linkProps(app.href)} className="map-card-map" onClick={event => { if (openNativeBrowser(app.href)) event.preventDefault(); }} tabIndex={-1} aria-hidden="true">{map}</a>}
            <div className="map-card-info">
              <a {...linkProps(app.href)} ref={(el) => { focusBack.current = el; }} className="map-card-open" onClick={event => { if (openNativeBrowser(app.href)) event.preventDefault(); }} aria-label={t.cards.map.openIn(app.id === "system" ? t.cards.map.systemApp : app.label, place.name)}>{text}</a>
              <button type="button" className="map-card-switch ghost tiny" onClick={() => setOpen(true)} aria-label={t.cards.map.switchApp}>{t.cards.map.switch}</button>
            </div>
          </>
        ) : (
          <button ref={(el) => { focusBack.current = el; }} type="button" className="map-card-main" onClick={() => setOpen(true)} aria-label={t.cards.map.main(place.name)}>
            {map}
            <span className="map-card-info">{text}</span>
          </button>
        )}
      </div>
      <PopupPresence onExited={() => focusBack.current?.focus()}>{open && <MapSheet place={place} current={app?.id ?? null} onClose={closeSheet} />}</PopupPresence>
    </>
  );
}
