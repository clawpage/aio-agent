import { useCallback, useEffect, useState } from "react";
import { api, ApiError } from "../api";
import type { ClawpageSsoPage } from "../types";
import { BrandMark, PageLoading } from "./Brand";
import { Login } from "./Login";
import { t } from "../i18n";

/**
 * `/clawpage-sso`: signing in to a clawpage. A page (any account's) sends its visitor here when they
 * press its sign-in button; after signing in to the console if needed, they are asked once whether the
 * page may know who they are, keep data as them and use their AI, then go back to the page signed in.
 */
export function ClawpageSignIn() {
  const [query] = useState(() => {
    const params = new URLSearchParams(location.search);
    return { owner: params.get("owner") ?? "", page: params.get("page") ?? "", return: params.get("return") ?? "" };
  });
  const [state, setState] = useState<"loading" | "login" | "ask" | "busy" | "missing" | "failed">("loading");
  const [info, setInfo] = useState<ClawpageSsoPage | null>(null);

  const load = useCallback(async () => {
    setState("loading");
    try {
      const found = await api.clawpageSsoPage(query);
      setInfo(found);
      setState(found.account ? "ask" : "login");
    } catch (err) {
      setState(err instanceof ApiError && err.status === 404 ? "missing" : "failed");
    }
  }, [query]);
  useEffect(() => { void load(); }, [load]);

  const allow = async () => {
    setState("busy");
    try {
      location.replace((await api.clawpageSsoGrant(query)).url);
    } catch {
      setState("failed");
    }
  };

  if (state === "loading") return <PageLoading label={t.common.loading}/>;
  if (state === "login") return <Login onSuccess={load}/>;
  const words = t.clawpages.sso;
  const who = info?.account ? info.account.email ?? info.account.name : "";
  return (
    <div className="login">
      <div className="login-card clawpage-sso" data-testid="clawpage-sso">
        <div className="login-brand"><BrandMark size={36}/><span>{t.auth.brand}</span></div>
        {state === "missing" || !info ? <p role="alert">{state === "missing" ? words.missing : words.failed}</p> : <>
          <header className="login-heading">
            <h1>{words.heading(info.title)}</h1>
            <p>{words.madeBy(info.owner)}</p>
          </header>
          <p className="clawpage-sso-intro">{words.intro}</p>
          <ul className="clawpage-sso-list">
            <li>{words.identity(who)}</li>
            <li>{words.data}</li>
            <li>{words.ai}</li>
          </ul>
          <p className="muted tiny">{words.remember}</p>
          {state === "failed" && <p className="banner error" role="alert">{words.failed}</p>}
          <button type="button" className="primary block" disabled={state === "busy"} onClick={() => void allow()}>{state === "busy" ? words.allowing : words.allow}</button>
          <button type="button" className="ghost block" disabled={state === "busy"} onClick={() => location.replace(info.cancelUrl)}>{words.deny}</button>
        </>}
        {state === "failed" && !info && <button type="button" className="primary block" onClick={() => void load()}>{words.retry}</button>}
      </div>
    </div>
  );
}
