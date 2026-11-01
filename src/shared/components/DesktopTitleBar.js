"use client";

import { useEffect, useRef, useState, useSyncExternalStore } from "react";

const HIDE_DELAY_MS = 700;
const REVEAL_EDGE_PX = 10;
const subscribeDesktop = () => () => {};
const getDesktopSnapshot = () => (typeof window !== "undefined" ? window.originRouterDesktop || null : null);
const getServerDesktopSnapshot = () => null;

// Chromix-style window chrome: an 8px framed gutter around the whole app, and
// a 32px caption strip that stays hidden until the pointer reaches the top
// edge. The strip contains only the three window controls — no title text and
// no app icon, so it can never cover page content with duplicate branding.
export default function DesktopTitleBar() {
  const api = useSyncExternalStore(subscribeDesktop, getDesktopSnapshot, getServerDesktopSnapshot);
  const [maximized, setMaximized] = useState(false);
  const [visible, setVisible] = useState(true);
  const hideTimer = useRef(null);
  const hovering = useRef(false);

  useEffect(() => {
    if (!api?.isDesktop) return;
    document.documentElement.classList.add("or-desktop");

    api.isMaximized?.().then((value) => setMaximized(Boolean(value))).catch(() => {});
    const off = api.onMaximizedChange?.((value) => setMaximized(Boolean(value)));
    return () => {
      document.documentElement.classList.remove("or-desktop");
      off?.();
    };
  }, [api]);

  useEffect(() => {
    document.documentElement.style.setProperty(
      "--or-titlebar-offset",
      visible ? "32px" : "0px",
    );
  }, [visible]);

  useEffect(() => {
    if (!api) return;
    const clear = () => {
      if (hideTimer.current) clearTimeout(hideTimer.current);
      hideTimer.current = null;
    };
    const schedule = () => {
      clear();
      if (hovering.current) return;
      hideTimer.current = setTimeout(() => setVisible(false), HIDE_DELAY_MS);
    };
    const onMove = (event) => {
      if (event.clientY > REVEAL_EDGE_PX) {
        if (!hovering.current) schedule();
        return;
      }
      setVisible(true);
      clear();
      schedule();
    };
    const onLeave = () => schedule();

    const showAndSchedule = () => {
      setVisible(true);
      clear();
      schedule();
    };
    const onFocus = () => showAndSchedule();
    const onVisibility = () => {
      if (document.visibilityState === "visible") showAndSchedule();
    };

    window.addEventListener("mousemove", onMove, { passive: true });
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisibility);
    document.addEventListener("mouseleave", onLeave);
    schedule();
    return () => {
      clear();
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisibility);
      document.removeEventListener("mouseleave", onLeave);
      document.documentElement.style.removeProperty("--or-titlebar-offset");
    };
  }, [api]);

  if (!api) return null;

  const show = () => {
    setVisible(true);
    if (hideTimer.current) clearTimeout(hideTimer.current);
    hideTimer.current = null;
  };
  const hideSoon = () => {
    hovering.current = false;
    if (hideTimer.current) clearTimeout(hideTimer.current);
    hideTimer.current = setTimeout(() => setVisible(false), HIDE_DELAY_MS);
  };

  return (
    <>
      <div className="or-titlebar-reveal" onMouseEnter={show} aria-hidden="true" />
      <div
        className={`or-titlebar ${visible ? "or-titlebar-visible" : "or-titlebar-hidden"}`}
        onMouseEnter={() => {
          hovering.current = true;
          show();
        }}
        onMouseLeave={hideSoon}
        onDoubleClick={() => api.toggleMaximize?.()}
      >
        <div className="or-titlebar-brand">
          <img src="/brand/origin-mark-256.png" alt="" className="or-titlebar-mark" />
          <span>OriginRouter</span>
        </div>
        <div className="or-titlebar-controls" onDoubleClick={(event) => event.stopPropagation()}>
          <button
            type="button"
            className="or-titlebar-btn"
            onClick={() => api.minimize?.()}
            aria-label="Minimize"
            title="Minimize"
          >
            <svg width="13" height="13" viewBox="0 0 13 13" aria-hidden="true">
              <path d="M2 6.5h9" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" fill="none" />
            </svg>
          </button>
          <button
            type="button"
            className="or-titlebar-btn"
            onClick={() => api.toggleMaximize?.()}
            aria-label={maximized ? "Restore" : "Maximize"}
            title={maximized ? "Restore" : "Maximize"}
          >
            {maximized ? (
              <svg width="11" height="11" viewBox="0 0 11 11" aria-hidden="true">
                <path d="M3.5 3.5h5v5h-5zM1.5 6.5h2M1.5 6.5v3h3" stroke="currentColor" strokeWidth="1.1" strokeLinejoin="round" fill="none" />
              </svg>
            ) : (
              <svg width="11" height="11" viewBox="0 0 11 11" aria-hidden="true">
                <rect x="1.5" y="1.5" width="8" height="8" rx="0.6" stroke="currentColor" strokeWidth="1.1" fill="none" />
              </svg>
            )}
          </button>
          <button
            type="button"
            className="or-titlebar-btn or-titlebar-close"
            onClick={() => api.close?.()}
            aria-label="Close"
            title="Close"
          >
            <svg width="13" height="13" viewBox="0 0 13 13" aria-hidden="true">
              <path d="M2.2 2.2l8.6 8.6M10.8 2.2l-8.6 8.6" stroke="currentColor" strokeWidth="1.15" strokeLinecap="round" fill="none" />
            </svg>
          </button>
        </div>
      </div>
    </>
  );
}
