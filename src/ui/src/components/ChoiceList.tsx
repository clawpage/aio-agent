import { t } from "../i18n";

/**
 * A question's answers as a list to tap. The one already sent is checked and the
 * list is then closed; without `onChoose` it only shows the answers.
 */
export function ChoiceList({ options, chosen = null, disabled = false, onChoose }: {
  options: string[];
  chosen?: string | null;
  disabled?: boolean;
  onChoose?: (option: string) => void;
}) {
  const closed = disabled || chosen !== null || !onChoose;
  return (
    <div className="choice-list" role="group" aria-label={t.chat.choices.label}>
      {options.map((option) => {
        const picked = option === chosen;
        return (
          <button
            key={option}
            type="button"
            className={`choice ${picked ? "picked" : ""}`}
            aria-pressed={picked}
            disabled={closed}
            onClick={() => onChoose?.(option)}
          >
            <span>{option}</span>
            {picked && <span className="choice-check" aria-hidden="true">✓</span>}
          </button>
        );
      })}
    </div>
  );
}
