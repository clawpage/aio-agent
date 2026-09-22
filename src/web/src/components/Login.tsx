import { useState } from "react";
import { api, ApiError } from "../api";

export function Login({ onSuccess, notice }: { onSuccess: () => void; notice?: string | null }) {
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    if (!password) return;
    setBusy(true);
    setError(null);
    try {
      await api.login(password);
      setPassword("");
      onSuccess();
    } catch (err) {
      if (err instanceof ApiError) setError(err.message);
      else setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="login">
      <form
        className="login-card"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <h1>个人智能体</h1>
        <p className="muted">私有部署，仅一个所有者账号，不开放注册。</p>
        <label className="field">
          <span>账号</span>
          <input value="owner" readOnly />
        </label>
        <label className="field">
          <span>密码</span>
          <input
            type="password"
            value={password}
            autoFocus
            autoComplete="current-password"
            onChange={(e) => setPassword(e.target.value)}
            placeholder="请输入访问密码"
          />
        </label>
        {notice && <div className="banner warn">{notice}</div>}
        {error && <div className="banner error">{error}</div>}
        <button type="submit" className="primary block" disabled={busy || !password}>
          {busy ? "登录中…" : "登录"}
        </button>
        <p className="muted tiny">
          首次启动时系统会生成初始密码并写入服务器上的 <code>var/owner-secret.txt</code>（权限 0600）。
          请在该文件查看或自行设置 <code>PA_OWNER_PASSWORD</code>。
        </p>
      </form>
    </div>
  );
}
