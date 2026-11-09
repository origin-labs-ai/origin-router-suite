"use client";

// macOS-style window controls: one red close dot and two inert dots.
//
// The close dot is a plain red circle with no glyph until the cursor is over
// it, when the cross fades in — that is exactly how macOS behaves. The two
// inactive dots carry no fill: only a boundary ring, so they read as "not
// available" without adding a colour that competes with the red.
//
// The red is `--color-danger`, so it follows the active theme instead of
// being hard-coded (macOS red looks washed out on the dark surface).
import PropTypes from "prop-types";
import Tooltip from "./Tooltip";

export default function TrafficLights({ onClose, label = "Close", className = "" }) {
  return (
    <div className={`flex shrink-0 items-center gap-2 ${className}`.trim()}>
      <Tooltip text={label} position="bottom" color="#FF5F56">
        <button
          type="button"
          onClick={onClose}
          aria-label={label}
          title={label}
          className="group/dot flex size-3.5 items-center justify-center rounded-full bg-[var(--color-danger)] ring-1 ring-black/10 transition-[filter,transform] duration-150 hover:brightness-90 active:scale-95"
        >
          <span className="text-[9px] font-bold leading-none text-white opacity-0 transition-opacity duration-150 group-hover/dot:opacity-100">
            ✕
          </span>
        </button>
      </Tooltip>
      <span
        aria-hidden="true"
        className="size-3.5 rounded-full border border-[var(--color-border)] bg-transparent"
      />
      <span
        aria-hidden="true"
        className="size-3.5 rounded-full border border-[var(--color-border)] bg-transparent"
      />
    </div>
  );
}

TrafficLights.propTypes = {
  onClose: PropTypes.func.isRequired,
  label: PropTypes.string,
  className: PropTypes.string,
};
