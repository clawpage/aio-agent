import { useEffect, useState } from "react";
import { api } from "../api";
import type { Profile } from "../types";
import { BrandMark } from "./Brand";
import { AuthIcon, useRevealTypedBox } from "./Login";
import { EMPTY, LIMITS } from "./ProfileSettings";
import { t } from "../i18n";

/**
 * The page a new account starts on, in place of the console: four questions, all optional, or skip
 * them. One name answers both what the assistant calls the person and the nickname a clawpage sees;
 * where they are and which language they use are not asked: the control plane fills them from this
 * browser's time zone and the console's language, where the profile has none yet. It shows once (the
 * control plane remembers it was done). Meanwhile the console loads underneath and the account's
 * sandbox gets ready, which nothing here mentions.
 */
export function ProfileOnboarding({ onDone }: { onDone: (profile: Profile | null) => void }) {
  const [draft, setDraft] = useState<Profile>(EMPTY);
  const [busy, setBusy] = useState<"save" | "skip" | null>(null);
  const [error, setError] = useState<string | null>(null);
  useRevealTypedBox();
  useEffect(() => {
    const controller = new AbortController();
    // Whatever the person already typed stays.
    api.profile(controller.signal).then(({ profile }) => setDraft((d) => (Object.keys(EMPTY) as Array<keyof Profile>).some((k) => d[k]) ? d : profile), () => undefined);
    return () => controller.abort();
  }, []);
  const name = draft.preferredName || draft.nickname;
  const finish = async (how: "save" | "skip") => {
    setBusy(how); setError(null);
    try {
      if (how === "save") onDone((await api.saveProfile({ ...draft, nickname: name, preferredName: name }, { language: t.settings.language.name })).profile);
      else { await api.skipProfile(); onDone(null); }
    } catch (err) { setError(err instanceof Error ? err.message : t.profile.failed); setBusy(null); }
  };
  const O = t.profile.onboarding, F = t.profile.fields;
  const set = (key: "occupation" | "interests" | "notes") => (e: { target: { value: string } }) => setDraft({ ...draft, [key]: e.target.value });
  return <div className="login onboarding">
    <form className="login-card onboarding-card" aria-labelledby="onboarding-title" onSubmit={(e) => { e.preventDefault(); if (!busy) void finish("save"); }}>
      {/* Skipping sits at the top, in reach without scrolling on a phone. */}
      <div className="login-brand"><BrandMark size={36}/><span>{t.auth.brand}</span>
        <button type="button" className="link onboarding-skip" disabled={!!busy} onClick={() => void finish("skip")}>{O.skip}</button></div>
      <header className="login-heading">
        <span className="onboarding-step">{O.step}</span>
        <h1 id="onboarding-title">{O.title}</h1>
        <p>{O.body}</p>
      </header>
      <div className="field">
        <label htmlFor="onboarding-name">{O.name.label}</label>
        <input id="onboarding-name" name="name" value={name} maxLength={Math.min(LIMITS.nickname, LIMITS.preferredName)} disabled={!!busy}
          onChange={(e) => setDraft({ ...draft, nickname: e.target.value, preferredName: e.target.value })}
          placeholder={O.name.placeholder} autoComplete="nickname" aria-describedby="onboarding-name-hint"/>
        <small id="onboarding-name-hint" className="onboarding-hint">{O.name.hint}</small>
      </div>
      <label className="field"><span>{F.occupation.label}</span>
        <input name="occupation" value={draft.occupation} onChange={set("occupation")} placeholder={F.occupation.placeholder} maxLength={LIMITS.occupation} disabled={!!busy} autoComplete="off"/></label>
      <label className="field"><span>{F.interests.label}</span>
        <input name="interests" value={draft.interests} onChange={set("interests")} placeholder={F.interests.placeholder} maxLength={LIMITS.interests} disabled={!!busy} autoComplete="off"/></label>
      <label className="field"><span>{F.notes.label}</span>
        <textarea name="notes" value={draft.notes} onChange={set("notes")} placeholder={F.notes.placeholder} maxLength={LIMITS.notes} rows={3} disabled={!!busy}/></label>
      {error && <div className="banner error" role="alert">{error}</div>}
      <button type="submit" className="primary block" disabled={!!busy}><span>{busy === "save" ? t.profile.saving : O.done}</span>{busy !== "save" && <AuthIcon name="arrow" size={18}/>}</button>
    </form>
  </div>;
}
