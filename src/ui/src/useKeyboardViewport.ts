import { useEffect } from "react";

/** Keep both console modes above a phone keyboard without moving the page header. */
export function useKeyboardViewport() {
    // iOS does not shrink 100dvh for its keyboard; it scrolls the whole page instead, so the header
    // slides off (under the status bar in the app). While a keyboard is up, the app is sized to the
    // area above it and the page stays at the top. Android resizes the page itself.
    // What a keyboard leaves visible: the visual viewport, or, when only a hardware keyboard's bar
    // shows and the visual viewport keeps its size, the part the page was scrolled away from.
    useEffect(() => {
        const vv = window.visualViewport;
        if (!vv) return;
        const root = document.documentElement;
        const typing = () => { const el = document.activeElement; return !!el && (el.tagName === "TEXTAREA" || (el.tagName === "INPUT" && !["button", "checkbox", "radio", "submit", "file", "range"].includes((el as HTMLInputElement).type)) || (el as HTMLElement).isContentEditable); };
        let held: number | null = null;
        const fit = () => {
            const full = root.clientHeight;
            const scrolled = Math.max(window.scrollY, vv.offsetTop);
            const zoomed = Math.abs(vv.scale - 1) > 0.01;
            const byScroll = full - scrolled;
            let visible = Math.min(vv.height, byScroll);
            // Once the page is put back at the top a bar no longer shows as scroll: keep what was measured while typing.
            if (typing() && held !== null) visible = Math.min(visible, held);
            const keyboard = !zoomed && full - visible > 30 && (typing() || full - vv.height > 30);
            // Only a measurement that came from the scroll is held. The visual viewport is read again each time:
            // the Android app's web view reports a passing size while it shrinks for the keyboard (136px of 508),
            // and holding that squeezed the page off screen.
            held = keyboard && typing() ? (byScroll < vv.height ? visible : held) : null;
            if (keyboard) root.style.setProperty("--keyboard-viewport", `${Math.round(visible)}px`);
            else root.style.removeProperty("--keyboard-viewport");
            root.classList.toggle("keyboard-open", keyboard);
            if (keyboard && scrolled > 0) window.scrollTo(0, 0);
        };
        let scheduled: number | undefined;
        const later = () => { clearTimeout(scheduled); scheduled = window.setTimeout(fit, 50); };
        vv.addEventListener("resize", fit);
        vv.addEventListener("scroll", fit);
        window.addEventListener("scroll", fit);
        document.addEventListener("focusin", later);
        document.addEventListener("focusout", later);
        fit();
        return () => {
            clearTimeout(scheduled);
            vv.removeEventListener("resize", fit); vv.removeEventListener("scroll", fit); window.removeEventListener("scroll", fit);
            document.removeEventListener("focusin", later); document.removeEventListener("focusout", later);
            root.style.removeProperty("--keyboard-viewport"); root.classList.remove("keyboard-open");
        };
    }, []);
}
