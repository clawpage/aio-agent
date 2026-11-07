import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../api";
import type { Profile } from "../types";
import { InlineLoading } from "./Brand";
import { t } from "../i18n";

const EMPTY: Profile = { nickname: "", preferredName: "", location: "", language: "", occupation: "", interests: "", notes: "" };
/** The same limits as the control plane's (src/control/profile.ts). */
const LIMITS: Record<keyof Profile, number> = { nickname: 40, preferredName: 40, location: 80, language: 60, occupation: 80, interests: 300, notes: 400 };
const SHORT: Array<keyof Profile> = ["nickname", "preferredName", "location", "language", "occupation"];

function browserZone(): string {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"; } catch { return "UTC"; }
}

/** The profile's fields: short ones side by side where there is room, the free text below. */
function ProfileFields({ value, onChange, disabled }: { value: Profile; onChange: (next: Profile) => void; disabled?: boolean }) {
  const F = t.profile.fields;
  const set = (key: keyof Profile) => (e: { target: { value: string } }) => onChange({ ...value, [key]: e.target.value });
  const placeholder = (key: keyof Profile) => { const p = F[key].placeholder; return typeof p === "function" ? p(browserZone()) : p; };
  return <div className="profile-fields">
    {SHORT.map((key) => <div key={key} className="profile-field">
      <label className="field">
        <span>{F[key].label}</span>
        <input name={key} value={value[key]} onChange={set(key)} placeholder={placeholder(key)} maxLength={LIMITS[key]} disabled={disabled}
          autoComplete={key === "nickname" ? "nickname" : "off"} aria-describedby={key === "nickname" ? "profile-nickname-hint" : undefined}/>
      </label>
      {key === "nickname" && <small id="profile-nickname-hint" className="muted tiny">{F.nickname.hint}</small>}
    </div>)}
    <label className="field profile-wide"><span>{F.interests.label}</span>
      <input name="interests" value={value.interests} onChange={set("interests")} placeholder={placeholder("interests")} maxLength={LIMITS.interests} disabled={disabled} autoComplete="off"/></label>
    <label className="field profile-wide"><span>{F.notes.label}</span>
      <textarea name="notes" value={value.notes} onChange={set("notes")} placeholder={placeholder("notes")} maxLength={LIMITS.notes} rows={3} disabled={disabled}/></label>
  </div>;
}

/** Settings → Profile: every account's, editable at any time. */
export function ProfileSettings({ onSaved }: { onSaved?: (profile: Profile) => void }) {
  const [saved, setSaved] = useState<Profile | null>(null);
  const [draft, setDraft] = useState<Profile>(EMPTY);
  const [state, setState] = useState<"loading" | "failed" | "ready" | "saving" | "saved">("loading");
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    setState("loading");
    try { const { profile } = await api.profile(); setSaved(profile); setDraft(profile); setState("ready"); }
    catch { setState("failed"); }
  }, []);
  useEffect(() => { void load(); }, [load]);
  const save = async () => {
    setState("saving"); setError(null);
    try { const { profile } = await api.saveProfile(draft); setSaved(profile); setDraft(profile); setState("saved"); onSaved?.(profile); }
    catch (err) { setError(err instanceof Error ? err.message : t.profile.failed); setState("ready"); }
  };
  const changed = !!saved && (Object.keys(EMPTY) as Array<keyof Profile>).some((k) => draft[k] !== saved[k]);
  return <section className="settings-card profile-settings" aria-label={t.profile.title}>
    <div className="settings-section-head"><h3>{t.profile.title}</h3><p>{t.profile.intro}</p></div>
    {state === "loading" ? <InlineLoading label={t.common.loading}/> : state === "failed" ? <>
      <p className="banner error" role="alert">{t.profile.loadFailed}</p>
      <div className="settings-actions"><button type="button" className="ghost" onClick={() => void load()}>{t.profile.retry}</button></div>
    </> : <form onSubmit={(e) => { e.preventDefault(); if (changed && state !== "saving") void save(); }}>
      <ProfileFields value={draft} onChange={(next) => { setDraft(next); if (state === "saved") setState("ready"); }} disabled={state === "saving"}/>
      {error && <p className="banner error" role="alert">{error}</p>}
      {state === "saved" && !changed && <p className="banner ok" role="status">{t.profile.saved}</p>}
      <div className="settings-actions"><span className="spacer"/><button type="submit" className="primary" disabled={!changed || state === "saving"}>{state === "saving" ? t.profile.saving : t.profile.save}</button></div>
    </form>}
  </section>;
}

/**
 * The step a new account starts with, over the main session: the profile, all optional, or skip it.
 * It shows once (the control plane remembers it was done). Meanwhile the account's sandbox is getting
 * ready behind it, which nothing here mentions.
 */
export function ProfileOnboarding({ onDone }: { onDone: (profile: Profile | null) => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [draft, setDraft] = useState<Profile>(EMPTY);
  const [busy, setBusy] = useState<"save" | "skip" | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { dialog.current?.showModal(); }, []);
  useEffect(() => {
    const controller = new AbortController();
    // Whatever the person already typed stays.
    api.profile(controller.signal).then(({ profile }) => setDraft((d) => (Object.keys(EMPTY) as Array<keyof Profile>).some((k) => d[k]) ? d : profile), () => undefined);
    return () => controller.abort();
  }, []);
  const finish = async (how: "save" | "skip") => {
    setBusy(how); setError(null);
    try {
      if (how === "save") onDone((await api.saveProfile(draft)).profile);
      else { await api.skipProfile(); onDone(null); }
    } catch (err) { setError(err instanceof Error ? err.message : t.profile.failed); setBusy(null); }
  };
  const O = t.profile.onboarding;
  return <dialog ref={dialog} className="support-dialog profile-onboarding" aria-labelledby="profile-onboarding-title" onCancel={(e) => e.preventDefault()}>
    <form onSubmit={(e) => { e.preventDefault(); if (!busy) void finish("save"); }}>
      <h2 id="profile-onboarding-title">{O.title}</h2>
      <p className="muted">{O.body}</p>
      <ProfileFields value={draft} onChange={setDraft} disabled={!!busy}/>
      {error && <p role="alert" className="error">{error}</p>}
      <div className="support-actions">
        <button type="button" className="ghost" disabled={!!busy} onClick={() => void finish("skip")}>{O.skip}</button>
        <button type="submit" className="primary" disabled={!!busy}>{busy === "save" ? t.profile.saving : O.done}</button>
      </div>
    </form>
  </dialog>;
}
