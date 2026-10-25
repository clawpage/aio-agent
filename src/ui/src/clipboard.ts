/**
 * Put text on the clipboard. The async Clipboard API first; where it is missing
 * or refused (an insecure origin, a web view without the permission), a hidden
 * textarea and `execCommand("copy")`, which still works inside the tap that
 * called this. Resolves false when neither copied, so the caller can say so.
 */
export async function writeClipboard(text: string): Promise<boolean> {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // Refused: try the selection route below.
    }
  }
  const area = document.createElement("textarea");
  area.value = text;
  area.readOnly = true;
  // Fixed at the corner and 16px so selecting it neither scrolls the page nor zooms iOS.
  area.style.position = "fixed";
  area.style.top = "0";
  area.style.left = "0";
  area.style.opacity = "0";
  area.style.fontSize = "16px";
  const previous = document.activeElement;
  document.body.appendChild(area);
  area.select();
  area.setSelectionRange(0, text.length);
  let ok = false;
  try {
    ok = document.execCommand("copy");
  } catch {
    ok = false;
  }
  area.remove();
  if (previous instanceof HTMLElement) previous.focus({ preventScroll: true });
  return ok;
}
