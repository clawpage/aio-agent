import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { navLinks, platformOf, tilesFor, type MapPlace } from "../mapBlocks";
import { apiUrl, API_CREDENTIALS } from "../api";

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
        <img key={t.key} src={apiUrl(`/api/map/tiles/${t.z}/${t.x}/${t.y}`)} alt="" draggable={false} style={{ left: t.left, top: t.top }} />
      ))}
      <svg className="map-pin" width="28" height="38" viewBox="0 0 28 38" aria-hidden="true">
        <path d="M14 1C6.8 1 1 6.7 1 13.8 1 23.5 14 37 14 37s13-13.5 13-23.2C27 6.7 21.2 1 14 1Z" />
        <circle cx="14" cy="13.8" r="5" />
      </svg>
      <span className="map-attribution">© OpenStreetMap</span>
    </div>
  );
}

/** The expanded card: a larger map, the address, and the navigation apps to hand it to. */
function MapSheet({ place, onClose }: { place: MapPlace; onClose: () => void }) {
  const [zoom, setZoom] = useState(Math.min(place.zoom + 1, 18));
  const close = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    close.current?.focus();
    const key = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    document.addEventListener("keydown", key);
    return () => document.removeEventListener("keydown", key);
  }, [onClose]);
  const located = place.lat !== null && place.lng !== null;
  const links = navLinks(place, platformOf(navigator.userAgent));
  return createPortal(
    <div className="map-sheet-backdrop" onClick={onClose}>
      <div className="map-sheet" role="dialog" aria-modal="true" aria-label={`导航到 ${place.name}`} onClick={(e) => e.stopPropagation()}>
        <header className="map-sheet-head">
          <div>
            <h3>{place.name}</h3>
            {place.address && <p className="muted tiny">{place.address}</p>}
          </div>
          <button ref={close} type="button" className="ghost" onClick={onClose} aria-label="关闭地图">✕</button>
        </header>
        {located ? (
          <div className="map-sheet-map">
            <MapView place={place} zoom={zoom} height={260} />
            <div className="map-zoom">
              <button type="button" aria-label="放大" disabled={zoom >= 18} onClick={() => setZoom((z) => Math.min(18, z + 1))}>＋</button>
              <button type="button" aria-label="缩小" disabled={zoom <= 3} onClick={() => setZoom((z) => Math.max(3, z - 1))}>－</button>
            </div>
          </div>
        ) : (
          <p className="map-unlocated muted">没能在地图上定位这个地址，仍可交给导航应用按地址搜索。</p>
        )}
        <p className="map-sheet-label">用以下应用导航</p>
        <ul className="map-nav-list">
          {links.map((link) => (
            <li key={link.id}>
              {/* A real link the person taps: universal links and app schemes only open apps from a tap. */}
              <a href={link.href} {...(link.href.startsWith("https:") ? { target: "_blank", rel: "noopener noreferrer" } : {})} data-nav={link.id}>
                <span>{link.label}</span>
                <span aria-hidden="true">›</span>
              </a>
            </li>
          ))}
        </ul>
        <p className="muted tiny map-sheet-note">未安装的应用会打开网页版或没有反应，请选择手机里已有的导航软件。</p>
      </div>
    </div>,
    document.body,
  );
}

/** A place in a message: a small map that expands into navigation choices. */
export function MapCard({ place: given }: { place: MapPlace }) {
  const [place, setPlace] = useState(given);
  const [locating, setLocating] = useState(given.lat === null);
  const [open, setOpen] = useState(false);
  const card = useRef<HTMLButtonElement>(null);
  // Back to the card itself: a tap does not focus a button in Safari, so there is no "previous focus" to restore.
  const closeSheet = useCallback(() => { setOpen(false); card.current?.focus(); }, []);
  useEffect(() => {
    if (given.lat !== null) return;
    const controller = new AbortController();
    void (async () => {
      try {
        const res = await fetch(apiUrl(`/api/map/geocode?q=${encodeURIComponent(given.address ?? given.name)}`), { credentials: API_CREDENTIALS, signal: controller.signal });
        const body = (await res.json()) as { place?: { lat: number; lng: number } | null };
        if (res.ok && body.place) setPlace({ ...given, lat: body.place.lat, lng: body.place.lng });
      } catch {
        /* stays unlocated: the address still goes to the navigation apps */
      } finally {
        if (!controller.signal.aborted) setLocating(false);
      }
    })();
    return () => controller.abort();
  }, [given]);
  const located = place.lat !== null && place.lng !== null;
  return (
    <>
      <button ref={card} type="button" className="map-card" onClick={() => setOpen(true)} aria-label={`地图：${place.name}，点开选择导航应用`}>
        {located ? <MapView place={place} zoom={place.zoom} height={150} /> : (
          <div className="map-view map-view-empty" style={{ height: 150 }}><span className="muted tiny">{locating ? "正在定位…" : "未能在地图上定位"}</span></div>
        )}
        <span className="map-card-info">
          <span className="map-card-text">
            <strong>{place.name}</strong>
            {place.address && <span className="muted tiny">{place.address}</span>}
          </span>
          <span className="map-card-action">导航</span>
        </span>
      </button>
      {open && <MapSheet place={place} onClose={closeSheet} />}
    </>
  );
}
