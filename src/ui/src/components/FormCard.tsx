import { useId, useMemo, useState } from "react";
import { formAnswerText, missingFields, type FormField, type FormSpec } from "../../../common/form";
import { t } from "../i18n";

type Values = Record<string, string | string[]>;

function initial(spec: FormSpec): Values {
  const values: Values = {};
  for (const f of spec.fields) values[f.name] = f.type === "checkbox" ? (Array.isArray(f.default) ? f.default : []) : (typeof f.default === "string" ? f.default : "");
  return values;
}

/**
 * A form the executor asked the person to fill in (```form, or the fields of an
 * ask_user question). Submitting sends the answers as one reply, like tapping a
 * choice. Once sent (`sent` is that reply), the form closes and shows what was
 * sent; without `onSubmit` it only shows the fields.
 */
export function FormCard({ spec, onSubmit, sent = null, disabled = false, embedded = false }: {
  spec: FormSpec;
  onSubmit?: (text: string) => void;
  sent?: string | null;
  disabled?: boolean;
  /** Inside a card that already has its own heading (the waiting card): no frame of its own. */
  embedded?: boolean;
}) {
  const id = useId();
  const [values, setValues] = useState<Values>(() => initial(spec));
  const [tried, setTried] = useState(false);
  const missing = useMemo(() => missingFields(spec, values), [spec, values]);
  const closed = disabled || sent !== null || !onSubmit;
  const set = (name: string, value: string | string[]) => setValues((old) => ({ ...old, [name]: value }));

  if (sent !== null) {
    return (
      <div className={`form-card sent${embedded ? " embedded" : ""}`} role="group" aria-label={t.chat.form.submittedLabel(spec.title ?? t.chat.form.fallbackTitle)}>
        {spec.title && !embedded && <div className="form-card-title">{spec.title}</div>}
        <dl className="form-card-summary">
          {sent.split("\n").filter(Boolean).map((line, i) => {
            const at = line.indexOf("："); // i18n-exempt: parses the "label：value" lines formAnswerText sends
            return at > 0 ? <div key={i}><dt>{line.slice(0, at)}</dt><dd>{line.slice(at + 1)}</dd></div> : <div key={i}><dd>{line}</dd></div>;
          })}
        </dl>
        <span className="form-card-done">{t.chat.form.submitted}</span>
      </div>
    );
  }

  const field = (f: FormField) => {
    const fid = `${id}-${f.name}`;
    const value = values[f.name];
    const bad = tried && missing.includes(f.label);
    const label = <label htmlFor={f.type === "radio" || f.type === "checkbox" ? undefined : fid} className="form-card-label">{f.label}{f.required && <span className="form-card-required" aria-hidden="true">*</span>}</label>;
    if (f.type === "radio" || f.type === "checkbox") {
      const multi = f.type === "checkbox";
      const picked = multi ? (value as string[]) : [value as string];
      return (
        <fieldset key={f.name} className={`form-card-field${bad ? " invalid" : ""}`} disabled={closed}>
          <legend className="form-card-label">{f.label}{f.required && <span className="form-card-required" aria-hidden="true">*</span>}</legend>
          <div className="form-card-options">
            {f.options!.map((o) => {
              const on = picked.includes(o);
              return (
                <button key={o} type="button" className={`form-card-option${on ? " on" : ""}`} role={multi ? "checkbox" : "radio"} aria-checked={on}
                  onClick={() => set(f.name, multi ? (on ? picked.filter((x) => x !== o) : [...picked, o]) : o)}>{o}</button>
              );
            })}
          </div>
        </fieldset>
      );
    }
    const common = { id: fid, disabled: closed, "aria-invalid": bad || undefined, "aria-required": f.required || undefined, placeholder: f.placeholder };
    return (
      <div key={f.name} className={`form-card-field${bad ? " invalid" : ""}`}>
        {label}
        {f.type === "textarea"
          ? <textarea {...common} rows={3} value={value as string} onChange={(e) => set(f.name, e.target.value)} />
          : f.type === "select"
            ? <select {...common} value={value as string} onChange={(e) => set(f.name, e.target.value)}>
                <option value="">{t.chat.form.choose}</option>
                {f.options!.map((o) => <option key={o} value={o}>{o}</option>)}
              </select>
            : <input {...common} type={f.type} inputMode={f.type === "number" ? "decimal" : undefined} min={f.min} max={f.max}
                value={value as string} onChange={(e) => set(f.name, e.target.value)} />}
      </div>
    );
  };

  return (
    <form className={`form-card${embedded ? " embedded" : ""}`} aria-label={spec.title ?? t.chat.form.fallbackTitle} noValidate
      onSubmit={(e) => {
        e.preventDefault();
        setTried(true);
        if (closed || missing.length) return;
        const text = formAnswerText(spec, values);
        if (text) onSubmit!(text);
      }}>
      {spec.title && !embedded && <div className="form-card-title">{spec.title}</div>}
      {spec.fields.map(field)}
      {tried && missing.length > 0 && <p className="form-card-error" role="alert">{t.chat.form.missing(missing)}</p>}
      {onSubmit && <button type="submit" className="primary form-card-submit" disabled={closed}>{spec.submit}</button>}
    </form>
  );
}
