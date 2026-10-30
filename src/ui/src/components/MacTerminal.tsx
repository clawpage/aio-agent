import { useCallback, useEffect, useState } from "react";
import { api } from "../api";
import { t } from "../i18n";
import type { MacShellStatus } from "../types";
import { hasDeviceLink, listenDeviceLink, setMacShell, type NativeLink } from "../deviceLink";

/** The terminal's state is read again this often while the app is shown. */
const POLL_MS = 4000;

/**
 * The workspace's Mac Terminal: whether the agent may use the terminal on the
 * account's Mac (bin/mac-shell.mjs, aio_mac_native's terminal tools). Only the Mac app on that Mac
 * switches it, so the switch is here only inside the app, on a Mac this account
 * linked; anywhere else the app shows its state.
 */
export function MacTerminal({ active, onLinkMac }: { active: boolean; onLinkMac: () => void }) {
  const inApp = hasDeviceLink();
  const [status, setStatus] = useState<MacShellStatus | null>(null);
  const [native, setNative] = useState<NativeLink | null>(null);
  /** This account's links, to know whether the link this Mac holds is one of them. */
  const [linkIds, setLinkIds] = useState<string[]>([]);
  /** The switch as the person just set it, until the app (restarting its bridge) reports the same. */
  const [wanted, setWanted] = useState<boolean | null>(null);

  const refresh = useCallback(async () => {
    try {
      setStatus(await api.macShellStatus());
    } catch {
      setStatus((current) => current ?? { state: "offline" });
    }
  }, []);
  useEffect(() => {
    if (!active) return;
    void refresh();
    const timer = window.setInterval(() => { if (document.visibilityState === "visible") void refresh(); }, POLL_MS);
    return () => window.clearInterval(timer);
  }, [active, refresh]);
  useEffect(() => {
    if (!inApp || !active) return;
    void api.deviceLinks().then((res) => setLinkIds(res.links.map((l) => l.id)), () => undefined);
    // The app reports its bridge; a restart (the switch) or a reconnect shows in the state too.
    return listenDeviceLink((next) => { setNative(next); void refresh(); });
  }, [inApp, active, refresh]);
  useEffect(() => { if (wanted !== null && native?.shell === wanted) setWanted(null); }, [native?.shell, wanted]);

  // This Mac holds one of the account's links, and its app knows the switch (one from before the terminal does not report it).
  const here = Boolean(native?.linkId && linkIds.includes(native.linkId) && typeof native.shell === "boolean");
  const on = here ? wanted ?? native!.shell! : status?.state === "ready" && status.enabled;
  const stateText = !status ? t.macTerminal.loading
    : here || status.state === "ready" ? (on ? t.macTerminal.on : t.macTerminal.off)
      : t.macTerminal[status.state];

  return (
    <div className="mac-terminal">
      <section className="mac-terminal-card" aria-label={t.macTerminal.title}>
        <p className={`mac-terminal-state ${on ? "on" : ""}`} role="status">{stateText}</p>
        {here && (
          <label className="mac-terminal-toggle">
            <input type="checkbox" checked={on} onChange={(event) => { setWanted(event.target.checked); setMacShell(event.target.checked); }} />
            <span>{t.macTerminal.toggle}</span>
          </label>
        )}
        {!here && status && status.state !== "unlinked" && <p className="muted tiny">{t.macTerminal.onlyInApp}</p>}
        {status?.state === "unlinked" && <button type="button" className="primary" onClick={onLinkMac}>{t.macTerminal.linkMac}</button>}
        {status?.state === "ready" && !status.tmux && <p className="banner warn" role="alert">{t.macTerminal.noTmux}</p>}
        <p className="muted tiny">{t.macTerminal.hint}</p>
        {on && <p className="muted tiny">{t.macTerminal.watch}</p>}
      </section>
    </div>
  );
}
