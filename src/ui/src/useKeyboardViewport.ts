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
    let settle: (() => void) | null = null;
    const feeds = () => Array.from(document.querySelectorAll<HTMLElement>(".chat-scroll"));
    /** Lay the page out giving up `r` px; feeds keep their distance from the bottom. */
    const layout = (r: number) => {
        const pinned = feeds().map((el) => [el, el.scrollHeight - el.scrollTop - el.clientHeight] as const);
        if (r > 0) root.style.setProperty("--keyboard-viewport", `${Math.round(root.clientHeight - r)}px`);
        else root.style.removeProperty("--keyboard-viewport");
        for (const [el, gap] of pinned) el.scrollTop = el.scrollHeight - el.clientHeight - gap;
        reserved = r;
    };
    /** What moves with the keyboard, and the point of it to follow: a feed's last message, anything else itself. */
    const movers = () => Array.from(document.querySelectorAll<HTMLElement>(".chat > :not(.chat-head)"), (el) => {
        const anchor = el.classList.contains("chat-scroll") ? (el.lastElementChild as HTMLElement | null) : el;
        return { el, top: () => anchor?.getBoundingClientRect().top ?? 0 };
    });
    /** How far each mover's content goes when the layout changes from `from` to `to` (measured, then undone). */
    const travel = (from: number, to: number) => {
        const parts = movers();
        const scrolls = feeds().map((el) => [el, el.scrollTop] as const);
        const before = parts.map((p) => p.top());
        layout(to);
        const after = parts.map((p) => p.top());
        layout(from);
        for (const [el, top] of scrolls) el.scrollTop = top;
        return parts.map((p, i) => ({ el: p.el, by: after[i]! - before[i]! })).filter((m) => Math.abs(m.by) >= 0.5);
    };
    const onKeyboard = (e: Event) => {
        const detail = (e as CustomEvent<{ height?: number; duration?: number }>).detail ?? {};
        const height = Math.max(0, Number(detail.height) || 0);
        const target = Math.max(0, height - (parseFloat(getComputedStyle(probe).paddingBottom) || 0));
        if (detail.duration === undefined) return layout(target);
        settle?.();
        if (target === reserved) return;
        if (!(Number(detail.duration) > 0) || matchMedia("(prefers-reduced-motion: reduce)").matches) return layout(target);
        const from = reserved;
        const moves = travel(from, target);
        const timing = { id: "keyboard", duration: KEYBOARD_MS, easing: curve };
        root.classList.add("keyboard-moving");
        let animations: Animation[];
        if (target > from) {
            animations = moves.map((m) => m.el.animate([{ transform: "none" }, { transform: `translateY(${m.by}px)` }], { ...timing, fill: "forwards" }));
        } else {
            layout(target);
            animations = moves.map((m) => m.el.animate([{ transform: `translateY(${-m.by}px)` }, { transform: "none" }], timing));
        }
        const done = () => {
            if (settle !== done) return;
            settle = null;
            if (reserved !== target) layout(target);
            for (const a of animations) a.cancel();
            root.classList.remove("keyboard-moving");
        };
        settle = done;
        if (!animations.length) return done();
        void Promise.all(animations.map((a) => a.finished)).then(done, () => undefined);
    };
    window.addEventListener("aio-keyboard", onKeyboard);
    return () => {
        settle?.();
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
