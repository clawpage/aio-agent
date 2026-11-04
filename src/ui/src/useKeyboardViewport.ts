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
    // What sizes itself by the screen (the composer, a long message's preview) uses the whole screen here, not
    // the part above the keyboard, so nothing changes size as the keyboard moves.
    root.style.setProperty("--screen-height", "calc(100dvh - var(--safe-top) - var(--safe-bottom))");
    /** What the page gives up at the bottom beyond the safe area, as laid out now. */
    let reserved = 0;
    /** The motion under way: what lays the page out when it ends (rising, shrinking), and the keyboard layout it ends in. */
    let running: { animations: Animation[]; commit: (() => void) | null; ends: number | null } | null = null;
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
    /**
     * What moves, and the point of it to follow (as seen, motion included): a feed's last message by its
     * top; the composer by its bottom, so it stays on the keyboard however tall it grows; anything else
     * by its top.
     */
    const movers = () => Array.from(document.querySelectorAll<HTMLElement>(".chat > :not(.chat-head)"), (el) => {
        const anchor = el.classList.contains("chat-scroll") ? (el.lastElementChild as HTMLElement | null) : el;
        const composer = el.classList.contains("composer");
        // How tall it shows: less the part a growing composer has not opened yet.
        const height = () => el.getBoundingClientRect().height - (parseFloat(/^inset\(([\d.]+)px/.exec(getComputedStyle(el).clipPath)?.[1] ?? "0") || 0);
        return { el, composer, top: () => (composer ? anchor?.getBoundingClientRect().bottom : anchor?.getBoundingClientRect().top) ?? 0, height };
    });
    /** Stop the motion under way: the page is laid out as its end wants (unless a motion that takes over will), with nothing moved. */
    const stop = (settle = true) => {
        if (!running) return;
        const { animations, commit } = running;
        running = null;
        if (settle) commit?.();
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
     * Glide from what is on screen now to a new layout, laid out by `change`.
     * - `rise`: the keyboard is coming up to that layout. The page is laid out only once the motion arrives,
     *   so nothing near the bottom is cut off on the way, and where things go is worked out from the feeds'
     *   scroll sizes rather than by laying the page out, so the motion starts at once.
     * - otherwise the page is laid out at once and everything starts from where it was seen; with `then`
     *   (the composer closing), that last step is applied when the motion ends, and the motion runs to
     *   where it will put things (measured by applying it and back): the composer keeps its height until
     *   then and closes downwards, and what is above follows it down by as much.
     * The composer, anchored at its bottom, opens or closes between the height it was seen at and the one
     * it ends with (a clip, as transforms cannot change a height). `late` is how long ago the motion began,
     * as the app reports it; `takeOver` leaves the step the motion under way would apply to this one's `then`.
     */
    const glide = (change: () => void, opts: { rise?: number; then?: { apply: () => void; revert: () => void }; late?: number; takeOver?: boolean } = {}) => {
        const parts = movers();
        const seen = parts.map((p) => p.top());
        const seenHeight = parts.map((p) => p.height());
        stop(!opts.takeOver);
        let now: number[];
        let nowHeight: number[];
        let to: number[];
        let endHeight: number[];
        let commit: (() => void) | null = null;
        if (opts.rise !== undefined) {
            now = parts.map((p) => p.top());
            nowHeight = parts.map((p) => p.height());
            const d = opts.rise - reserved;
            to = parts.map((p) => -(p.el.classList.contains("chat-scroll") ? feedShift(p.el, d) : d));
            endHeight = nowHeight;
            commit = change;
        } else {
            change();
            now = parts.map((p) => p.top());
            nowHeight = parts.map((p) => p.height());
            if (opts.then) {
                const { apply, revert } = opts.then;
                const scrolls = feeds().map((el) => [el, el.scrollTop] as const);
                apply();
                const after = parts.map((p) => p.top());
                endHeight = parts.map((p) => p.height());
                revert();
                for (const [el, top] of scrolls) el.scrollTop = top;
                to = parts.map((p, i) => after[i]! - now[i]!);
                commit = apply;
            } else {
                to = parts.map(() => 0);
                endHeight = nowHeight;
            }
        }
        const moves = parts.map((p, i) => ({ el: p.el, from: seen[i]! - now[i]!, to: to[i]! })).filter((m) => Math.abs(m.from) >= 0.5 || Math.abs(m.to) >= 0.5);
        // The composer shows from the top of its box down, opening or closing between the heights seen and wanted.
        const clips = parts.flatMap((p, i) => {
            if (!p.composer) return [];
            const from = nowHeight[i]! - seenHeight[i]!;
            const end = nowHeight[i]! - endHeight[i]!;
            return (Math.abs(from) >= 1 || Math.abs(end) >= 1) && from >= 0 && end >= 0 ? [{ el: p.el, from, end }] : [];
        });
        if (!moves.length && !clips.length) {
            commit?.();
            return;
        }
        root.classList.add("keyboard-moving");
        const timing = { id: "keyboard", duration: KEYBOARD_MS, easing: curve, fill: "forwards" as const };
        const animations = [
            ...moves.map((m) => m.el.animate([{ transform: `translateY(${m.from}px)` }, { transform: `translateY(${m.to}px)` }], timing)),
            ...clips.map((c) => c.el.animate([{ clipPath: `inset(${c.from}px 0 0 0 round 22px)` }, { clipPath: `inset(${c.end}px 0 0 0 round 22px)` }], timing)),
        ];
        const ahead = Math.min(Math.max(0, opts.late ?? 0), KEYBOARD_MS - 50);
        if (ahead > 0) for (const a of animations) a.currentTime = ahead;
        const mine = { animations, commit, ends: opts.rise ?? null };
        running = mine;
        void Promise.all(animations.map((a) => a.finished)).then(() => {
            if (running !== mine) return;
            // Arrived: lay the page out. Should anything land elsewhere than worked out, it eases over instead of jumping.
            const arrived = parts.map((p) => p.top());
            stop();
            parts.forEach((p, i) => {
                const off = arrived[i]! - p.top();
                if (Math.abs(off) >= 1) p.el.animate([{ transform: `translateY(${off}px)` }, { transform: "none" }], { id: "keyboard", duration: 180, easing: "ease-out" });
            });
        }, () => undefined);
    };
    const still = () => matchMedia("(prefers-reduced-motion: reduce)").matches;
    /** A composer closing after its box was left (while it still has `hold-expanded`): how to finish it, and to put it back while measuring. */
    let shrinking: { apply: () => void; revert: () => void } | null = null;
    const onKeyboard = (e: Event) => {
        const detail = (e as CustomEvent<{ height?: number; duration?: number; start?: number }>).detail ?? {};
        const height = Math.max(0, Number(detail.height) || 0);
        const target = Math.max(0, height - (parseFloat(getComputedStyle(probe).paddingBottom) || 0));
        if (detail.duration === undefined) return layout(target);
        const ending = running?.ends ?? reserved;
        if (target === ending) return;
        if (!(Number(detail.duration) > 0) || still()) {
            stop();
            return layout(target);
        }
        // How late this is (the app's clock is the page's); a start out of reach (another clock, a stale event) counts as now.
        const since = Number(detail.start) > 0 ? Date.now() - Number(detail.start) : 0;
        const late = since >= 0 && since < 1000 ? since : 0;
        if (target > ending) return glide(() => layout(target), { rise: target, late });
        // Falling while the composer is still closing (it was just left): one motion takes both to the end.
        const closing = document.querySelector<HTMLElement>(".chat .composer.hold-expanded");
        if (closing && running && shrinking) {
            const { apply, revert } = shrinking;
            return glide(() => layout(target), { then: { apply, revert }, late, takeOver: true });
        }
        glide(() => layout(target), { late });
    };
    // The composer grows when its box is focused and shrinks when it is left, a few frames before the
    // keyboard moves: that change glides too, from the composer as it was (held for one measurement).
    const onFocus = (e: FocusEvent) => {
        const box = e.target;
        if (!(box instanceof HTMLTextAreaElement) || still()) return;
        const composer = box.closest<HTMLElement>(".chat .composer");
        if (!composer || composer.classList.contains("has-content")) return;
        // Growing: laid out at once, opening upwards from the old height. Shrinking: the page is laid out for
        // the small composer at once, while the composer keeps its height over the feed's bottom edge (a
        // negative margin keeps its place small) and closes downwards; it becomes small when the motion ends,
        // which moves nothing.
        if (e.type === "focusin") {
            shrinking = null;
            composer.classList.add("hold-collapsed");
            return glide(() => pinned(() => composer.classList.remove("hold-collapsed")));
        }
        composer.classList.add("hold-expanded");
        const tall = composer.getBoundingClientRect().height;
        composer.classList.remove("hold-expanded");
        const small = composer.getBoundingClientRect().height;
        const margin = parseFloat(getComputedStyle(composer).marginTop) || 0;
        composer.classList.add("hold-expanded");
        const hold = () => { composer.classList.add("hold-expanded"); composer.style.marginTop = `${margin - (tall - small)}px`; };
        const mine = {
            apply: () => { composer.classList.remove("hold-expanded"); composer.style.marginTop = ""; },
            revert: hold,
        };
        shrinking = mine;
        glide(() => pinned(hold), { then: mine });
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
        root.style.removeProperty("--screen-height");
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
