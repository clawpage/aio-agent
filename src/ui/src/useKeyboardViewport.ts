import { useEffect, type MouseEvent } from "react";

/**
 * On the composer's attachment button (pointerdown and mousedown; Chromium moves focus on the latter): a tap keeps the message box focused, so a phone keyboard stays up.
 * Taking the focus closed the keyboard mid-tap, the composer slid back down, and the attachment menu the
 * phone opened was left where the button had been.
 */
export function keepTyping(e: MouseEvent<HTMLElement>) {
    const typing = document.activeElement;
    if (typing instanceof HTMLTextAreaElement && e.currentTarget.closest(".composer")?.contains(typing)) e.preventDefault();
}

/** The iOS app takes the keyboard from WebKit and reports it (`aioKeyboard`, DeviceBrowser.swift). */
const appKeyboardBridge = () => (window as { webkit?: { messageHandlers?: { aioKeyboard?: { postMessage(body: string): void } } } }).webkit?.messageHandlers?.aioKeyboard;
const appKeyboard = () => !!appKeyboardBridge();

/** The iOS keyboard's own motion (UIKit's curve 7), sampled frame by frame in the simulator: its progress over KEYBOARD_MS. */
const KEYBOARD_MS = 500;
const KEYBOARD_CURVE = "linear(0, 0.112 3.3%, 0.297 6.7%, 0.408 10%, 0.504 13.3%, 0.593 16.7%, 0.668 20%, 0.732 23.3%, 0.786 26.7%, 0.829 30%, 0.865 33.3%, 0.892 36.7%, 0.915 40%, 0.933 43.3%, 0.948 46.7%, 0.958 50%, 0.967 53.3%, 0.974 56.7%, 0.979 60%, 0.983 63.3%, 0.987 66.7%, 0.99 70%, 0.993 80%, 0.997 90%, 1)";
/** Before iOS 17.2 (no linear()): the nearest curve. */
const KEYBOARD_FALLBACK = "cubic-bezier(0.17, 0.84, 0.3, 1)";

/**
 * In the iOS app the page is never scrolled or resized by the system for the keyboard: the app tells the
 * page, as the keyboard starts to move, the height it will end at and whether it animates (`aio-keyboard`
 * with `height` and `duration`), and the page gives up that much at the bottom. The bottom safe-area
 * padding is part of what the keyboard covers (no step when it goes), and chat feeds keep their distance
 * from the bottom.
 *
 * The motion itself never lays the page out frame by frame (a long conversation could not keep up):
 * what lies below each chat header (the feed's messages, banners, the composer) moves on the compositor,
 * with the keyboard's curve, to where the new layout will put it. Rising, it slides first and the layout
 * follows in the frame it arrives, so nothing near the bottom is cut off on the way; falling, the layout
 * changes first and everything glides down from where it was. Where each part ends up is found by
 * laying the page out at the new height and back again before anything is painted.
 *
 * App builds from before this sent the height on every frame without a duration; those are laid out as
 * they arrive.
 */
let following = false;

function followAppKeyboard(root: HTMLElement) {
    const probe = document.createElement("div");
    probe.style.cssText = "position:fixed;visibility:hidden;pointer-events:none;padding-bottom:env(safe-area-inset-bottom,0px)";
    document.body.appendChild(probe);
    const curve = typeof CSS !== "undefined" && CSS.supports?.("animation-timing-function", KEYBOARD_CURVE) ? KEYBOARD_CURVE : KEYBOARD_FALLBACK;
    // The page never scrolls as a document: the app keeps it at the top even before a keyboard is announced.
    appKeyboardBridge()?.postMessage("hold");
    /** What the page gives up at the bottom beyond the safe area, as laid out now. */
    let reserved = 0;
    /** The keyboard motion under way, and the layout it ends in (rising lays the page out at the end). */
    let running: { animations: Animation[]; commit: number | null } | null = null;
    const feeds = () => Array.from(document.querySelectorAll<HTMLElement>(".chat-scroll"));
    /** Run a layout change with chat feeds keeping their distance from the bottom. */
    const pinned = (change: () => void) => {
        const gaps = feeds().map((el) => [el, el.scrollHeight - el.scrollTop - el.clientHeight] as const);
        change();
        for (const [el, gap] of gaps) el.scrollTop = el.scrollHeight - el.clientHeight - gap;
    };
    /** Lay the page out giving up `r` px. */
    const layout = (r: number) => pinned(() => {
        if (r > 0) root.style.setProperty("--keyboard-viewport", `${Math.round(root.clientHeight - r)}px`);
        else root.style.removeProperty("--keyboard-viewport");
        reserved = r;
    });
    /** What moves, and the point of it to follow: a feed's last message, anything else itself. Tops are as seen, motion included. */
    const movers = () => Array.from(document.querySelectorAll<HTMLElement>(".chat > :not(.chat-head)"), (el) => {
        const anchor = el.classList.contains("chat-scroll") ? (el.lastElementChild as HTMLElement | null) : el;
        return { el, top: () => anchor?.getBoundingClientRect().top ?? 0 };
    });
    /** Stop the motion under way where it is: the page is laid out as its end wants, with nothing moved. */
    const stop = () => {
        if (!running) return;
        const { animations, commit } = running;
        running = null;
        if (commit !== null) layout(commit);
        for (const a of animations) a.cancel();
        root.classList.remove("keyboard-moving");
    };
    /** How far a feed's content goes when the feed is `d` px shorter with its distance from the bottom kept (feeds are top-aligned). */
    const feedShift = (el: HTMLElement, d: number) => {
        const last = el.lastElementChild;
        const content = el.scrollHeight > el.clientHeight + 1 || !last
            ? el.scrollHeight
            : last.getBoundingClientRect().bottom - el.getBoundingClientRect().top + el.scrollTop + (parseFloat(getComputedStyle(el).paddingBottom) || 0);
        const most = Math.max(0, content - (el.clientHeight - d));
        return Math.min(Math.max(0, el.scrollTop + d), most) - el.scrollTop;
    };
    /**
     * Glide from what is on screen now to a new layout. Rising (`rise`, the keyboard layout to end in), the
     * page is laid out only once the motion arrives, so nothing near the bottom is cut off on the way; where
     * things go is worked out from the feeds' scroll sizes rather than by laying the page out, so the motion
     * starts at once. Otherwise `change` lays the page out at once and everything starts from where it was
     * seen. `late` is how long ago the motion began (the keyboard's start, as the app reports it).
     */
    const glide = (change: () => void, rise: number | null, late = 0) => {
        const parts = movers();
        const seen = parts.map((p) => p.top());
        stop();
        const now = parts.map((p) => p.top());
        let to: number[];
        if (rise !== null) {
            const d = rise - reserved;
            to = parts.map((p) => -(p.el.classList.contains("chat-scroll") ? feedShift(p.el, d) : d));
        } else {
            change();
            const after = parts.map((p) => p.top());
            for (let i = 0; i < now.length; i += 1) now[i] = after[i]!;
            to = parts.map(() => 0);
        }
        const moves = parts.map((p, i) => ({ el: p.el, from: seen[i]! - now[i]!, to: to[i]! })).filter((m) => Math.abs(m.from) >= 0.5 || Math.abs(m.to) >= 0.5);
        if (!moves.length) {
            if (rise !== null) layout(rise);
            return;
        }
        root.classList.add("keyboard-moving");
        const timing = { id: "keyboard", duration: KEYBOARD_MS, easing: curve, fill: "forwards" as const };
        const animations = moves.map((m) => m.el.animate([{ transform: `translateY(${m.from}px)` }, { transform: `translateY(${m.to}px)` }], timing));
        const ahead = Math.min(Math.max(0, late), KEYBOARD_MS - 50);
        if (ahead > 0) for (const a of animations) a.currentTime = ahead;
        const mine = { animations, commit: rise };
        running = mine;
        void Promise.all(animations.map((a) => a.finished)).then(() => { if (running === mine) stop(); }, () => undefined);
    };
    const still = () => matchMedia("(prefers-reduced-motion: reduce)").matches;
    const onKeyboard = (e: Event) => {
        const detail = (e as CustomEvent<{ height?: number; duration?: number; start?: number }>).detail ?? {};
        const height = Math.max(0, Number(detail.height) || 0);
        const target = Math.max(0, height - (parseFloat(getComputedStyle(probe).paddingBottom) || 0));
        if (detail.duration === undefined) return layout(target);
        const ending = running?.commit ?? reserved;
        if (target === ending) return;
        if (!(Number(detail.duration) > 0) || still()) {
            stop();
            return layout(target);
        }
        // How late this is (the app's clock is the page's); a start out of reach (another clock, a stale event) counts as now.
        const late = Number(detail.start) > 0 ? Date.now() - Number(detail.start) : 0;
        glide(() => layout(target), target > ending ? target : null, late >= 0 && late < 1000 ? late : 0);
    };
    // The composer grows when its box is focused and shrinks when it is left, a few frames before the
    // keyboard moves: that change glides too, from the composer as it was (held for one measurement).
    const onFocus = (e: FocusEvent) => {
        const box = e.target;
        if (!(box instanceof HTMLTextAreaElement) || still()) return;
        const composer = box.closest<HTMLElement>(".chat .composer");
        if (!composer || composer.classList.contains("has-content")) return;
        const hold = e.type === "focusin" ? "hold-collapsed" : "hold-expanded";
        composer.classList.add(hold);
        glide(() => pinned(() => composer.classList.remove(hold)), null);
    };
    window.addEventListener("aio-keyboard", onKeyboard);
    document.addEventListener("focusin", onFocus);
    document.addEventListener("focusout", onFocus);
    return () => {
        stop();
        document.removeEventListener("focusin", onFocus);
        document.removeEventListener("focusout", onFocus);
        appKeyboardBridge()?.postMessage("release");
        window.removeEventListener("aio-keyboard", onKeyboard);
        probe.remove();
        root.style.removeProperty("--keyboard-viewport");
    };
}

/** Keep both console modes above a phone keyboard without moving the page header. */
export function useKeyboardViewport() {
    // iOS does not shrink 100dvh for its keyboard; it scrolls the whole page instead, so the header
    // slides off (under the status bar in the app). While a keyboard is up, the app is sized to the
    // area above it and the page stays at the top. Android resizes the page itself.
    // What a keyboard leaves visible: the visual viewport, or, when only a hardware keyboard's bar
    // shows and the visual viewport keeps its size, the part the page was scrolled away from.
    useEffect(() => {
        const root = document.documentElement;
        // App and MainApp both use this hook; one of them follows the app's keyboard.
        if (appKeyboard()) {
            if (following) return;
            following = true;
            const stop = followAppKeyboard(root);
            return () => { stop(); following = false; };
        }
        const vv = window.visualViewport;
        if (!vv) return;
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
