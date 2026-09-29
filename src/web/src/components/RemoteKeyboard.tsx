import { useRef, useState } from "react";
import { api } from "../api";

const KEYS: Array<{ key: string; label: string; aria: string }> = [
  { key: "Enter", label: "⏎", aria: "回车" },
  { key: "Backspace", label: "⌫", aria: "删除" },
  { key: "Tab", label: "Tab", aria: "下一项" },
];

/**
 * A phone cannot raise its keyboard inside the remote browser view (it is a
 * picture of the page, not a real field). This native input bar can: type here
 * and the text goes into the field focused in the tab you took over, with the
 * phone's own keyboard, IME, paste and autofill.
 */
export function RemoteKeyboard({
  onSend = api.browserInput,
  placeholder = "先点网页里的输入框，再在这里输入",
}: {
  onSend?: (input: { text?: string; key?: string }) => Promise<unknown>;
  placeholder?: string;
} = {}) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const field = useRef<HTMLInputElement>(null);

  const send = async (input: { text?: string; key?: string }) => {
    setBusy(true);
    setNotice(null);
    try {
      await onSend(input);
      if (input.text) setText("");
    } catch (err) {
      setNotice(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
      // Keep the phone keyboard up for the next field.
      field.current?.focus();
    }
  };

  return (
    <form
      className="remote-keyboard"
      aria-label="向网页输入"
      onSubmit={(e) => {
        e.preventDefault();
        // The phone's return key only sends the text; ⏎ presses Enter in the page,
        // so a username field never submits a login form by accident.
        if (text) void send({ text });
      }}
    >
      {notice && <p className="remote-keyboard-notice" role="alert">{notice}</p>}
      <div className="remote-keyboard-row">
        <input
          ref={field}
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={placeholder}
          aria-label="要输入到网页的文字"
          enterKeyHint="send"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
        />
        <button type="submit" className="primary" disabled={busy || !text}>发送</button>
        {KEYS.map((k) => (
          <button
            key={k.key}
            type="button"
            className="ghost"
            aria-label={k.aria}
            disabled={busy}
            // Pressing a key must not blur the field and drop the phone keyboard.
            onPointerDown={(e) => e.preventDefault()}
            onClick={() => void send({ key: k.key })}
          >
            {k.label}
          </button>
        ))}
      </div>
    </form>
  );
}
