"use client";

import { useState } from "react";
import PropTypes from "prop-types";
import {
  getProviderIconCandidates,
  resolveProviderIconId,
} from "@/shared/utils/providerIcon";
import { providerGlyph, providerAccentColor } from "@/shared/utils/providerGlyph";

export default function ProviderIcon({
  src,
  providerId,
  alt,
  size = 32,
  className = "",
  fallbackText,
  fallbackColor,
}) {
  // Providers are addressed by id; the legacy `src` prop (/providers/x.png)
  // still resolves through the same manifest so a caller cannot pin an
  // extension that no longer exists.
  const iconId = providerId
    ? resolveProviderIconId(providerId)
    : String(src || "").match(/^\/providers\/([^/.]+)\./i)?.[1] || "";
  const candidates = iconId ? getProviderIconCandidates(iconId) : src ? [src] : [];

  // Failure is keyed by the icon the component is currently asked to show, so
  // a list reusing this instance for a different provider starts clean without
  // an effect (setState inside an effect is a cascading render).
  const [failure, setFailure] = useState({ key: "", step: 0, dead: false });
  const key = candidates[0] || "";
  const forThisIcon = failure.key === key;
  const step = forThisIcon ? failure.step : 0;
  const dead = forThisIcon && failure.dead;

  const baseSrc = candidates[step] || null;

  // Universal icon-less rule: a provider with no asset on disk renders the
  // letter glyph + deterministic accent color (NexAPI → "N",
  // OrcaRouter → "OR"). Callers may override both.
  const glyphText =
    fallbackText != null && fallbackText !== ""
      ? fallbackText
      : providerGlyph(alt || providerId || "");
  const glyphColor = fallbackColor || providerAccentColor(providerId || alt || "");

  if (!baseSrc || dead) {
    return (
      <span
        className={`inline-flex items-center justify-center font-bold rounded-lg ${className}`.trim()}
        style={{
          width: size,
          height: size,
          color: glyphColor,
          fontSize: Math.max(10, Math.floor(size * 0.38)),
        }}
      >
        {glyphText}
      </span>
    );
  }

  return (
    <img
      key={baseSrc}
      src={baseSrc}
      alt={alt}
      width={size}
      height={size}
      className={className}
      loading="lazy"
      decoding="async"
      onError={() => {
        // Walk the ladder only as far as it goes: a stale manifest costs one
        // extra request, a truly absent asset lands on the glyph.
        if (step + 1 < candidates.length) {
          setFailure({ key, step: step + 1, dead: false });
          return;
        }
        setFailure({ key, step, dead: true });
      }}
    />
  );
}

ProviderIcon.propTypes = {
  src: PropTypes.string,
  providerId: PropTypes.string,
  alt: PropTypes.string,
  size: PropTypes.number,
  className: PropTypes.string,
  fallbackText: PropTypes.string,
  fallbackColor: PropTypes.string,
};
