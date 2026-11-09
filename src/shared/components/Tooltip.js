"use client";

// A hover bubble that is portalled to the body and positioned with `fixed`.
//
// Portalling keeps it out of scroll/clip ancestors; `fixed` keeps it out of
// layout. The one thing it must NOT do is measure once and never again: the
// anchor often sits inside a card or button that lifts on hover (`.or-edge`,
// `.or-press` both translate on :hover with a ~150ms transition). Measuring on
// raw mouseenter catches the anchor mid-transition, so the bubble lands a few
// pixels off and, worse, lands somewhere different on the next hover — the
// "sometimes it shows where the cursor is, sometimes where it belongs"
// flicker. So: re-measure after layout settles, and again on scroll/resize.
import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

export default function Tooltip({ text, children, position = "top", color }) {
  const anchorRef = useRef(null);
  const [style, setStyle] = useState(null);

  const place = useCallback(() => {
    const rect = anchorRef.current?.getBoundingClientRect();
    if (!rect) return;
    const midX = rect.left + rect.width / 2;
    const midY = rect.top + rect.height / 2;
    let pos;
    if (position === "bottom") pos = { top: rect.bottom + 6, left: midX, transform: "translateX(-50%)" };
    else if (position === "left") pos = { right: window.innerWidth - rect.left + 6, top: midY, transform: "translateY(-50%)" };
    else if (position === "right") pos = { left: rect.right + 6, top: midY, transform: "translateY(-50%)" };
    else pos = { bottom: window.innerHeight - rect.top + 6, left: midX, transform: "translateX(-50%)" };
    setStyle({ position: "fixed", ...pos });
  }, [position]);

  const show = useCallback(() => {
    // Two frames: the first lets React commit, the second runs after the
    // hover transition has actually moved the anchor.
    place();
    if (typeof requestAnimationFrame === "function") {
      requestAnimationFrame(() => {
        place();
        requestAnimationFrame(place);
      });
    }
  }, [place]);

  // While visible, follow the anchor through scrolling and resizing instead of
  // freezing at the coordinates captured on hover.
  useEffect(() => {
    if (!style) return undefined;
    const onChange = () => place();
    window.addEventListener("scroll", onChange, true);
    window.addEventListener("resize", onChange);
    return () => {
      window.removeEventListener("scroll", onChange, true);
      window.removeEventListener("resize", onChange);
    };
  }, [style, place]);

  return (
    <div
      ref={anchorRef}
      className="relative inline-flex"
      onMouseEnter={show}
      onFocus={show}
      onBlur={() => setStyle(null)}
      onMouseLeave={() => setStyle(null)}
    >
      {children}
      {style && createPortal(
        <div
          className={`pointer-events-none z-50 w-max max-w-56 rounded px-2 py-1 text-[11px] leading-snug text-white whitespace-normal ${color ? "" : "bg-gray-900"}`}
          style={{ ...style, ...(color ? { backgroundColor: color } : {}) }}
        >
          {text}
        </div>,
        document.body
      )}
    </div>
  );
}
