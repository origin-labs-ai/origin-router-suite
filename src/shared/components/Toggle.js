"use client";

import { cn } from "@/shared/utils/cn";

// Matches the playground switch exactly: 36×20 track, 16px thumb, brand blue
// rgb(43, 127, 255) when on and a grey track when off.
export default function Toggle({
  checked = false,
  onChange,
  label,
  description,
  disabled = false,
  className,
  title,
}) {
  const handleClick = () => {
    if (!disabled && onChange) onChange(!checked);
  };

  return (
    <div
      className={cn(
        "flex items-center gap-3",
        disabled && "opacity-50 cursor-not-allowed",
        className
      )}
    >
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={label || title}
        title={title}
        disabled={disabled}
        onClick={handleClick}
        className={cn(
          "relative inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full",
          "transition-colors duration-200 ease-in-out",
          "focus:outline-none focus:ring-2 focus:ring-[#2B7FFF]/30",
          checked ? "bg-[#2B7FFF]" : "bg-black/15 dark:bg-white/15",
          disabled && "cursor-not-allowed"
        )}
      >
        <span
          className={cn(
            "pointer-events-none absolute top-0.5 inline-block size-4 rounded-full bg-white shadow-sm",
            "transform transition duration-200 ease-in-out",
            checked ? "left-[18px]" : "left-0.5"
          )}
        />
      </button>
      {(label || description) && (
        <div className="flex flex-col">
          {label && (
            <span className="text-sm font-medium text-text-main">{label}</span>
          )}
          {description && (
            <span className="text-xs text-text-muted">{description}</span>
          )}
        </div>
      )}
    </div>
  );
}
