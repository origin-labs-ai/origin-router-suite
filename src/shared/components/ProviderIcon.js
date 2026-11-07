"use client";

import { useState } from "react";
import PropTypes from "prop-types";
import { getProviderIconSrc, markProviderIconMissing } from "@/shared/utils/providerIcon";
import { providerGlyph, providerAccentColor } from "@/shared/utils/providerGlyph";

function resolveSrc(src, providerId) {
  if (providerId) return getProviderIconSrc(providerId);
  if (!src) return null;
  const m = String(src).match(/^\/providers\/([^/]+)\.png$/i);
  if (m) return getProviderIconSrc(m[1]);
  return src;
}

export default function ProviderIcon({
  src,
  providerId,
  alt,
  size = 32,
  className = "",
  fallbackText,
  fallbackColor,
}) {
  const effectiveSrc = resolveSrc(src, providerId);
  const [errored, setErrored] = useState(false);

  // Universal icon-less rule: any provider without an icon asset — Hand Picked
  // OpenAI Compatible endpoints, imports from other routers, anything new —
  // renders the letter glyph + deterministic accent color from its name/id
  // (NexAPI → "N", OrcaRouter → "OR"). Callers may still override both.
  const glyphText = fallbackText != null && fallbackText !== "" ? fallbackText : providerGlyph(alt || providerId || "");
  const glyphColor = fallbackColor || providerAccentColor(providerId || alt || "");

  if (!effectiveSrc || errored) {
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
      src={effectiveSrc}
      alt={alt}
      width={size}
      height={size}
      className={className}
      loading="lazy"
      decoding="async"
      onError={() => {
        const m = effectiveSrc.match(/^\/providers\/([^/]+)\.png$/i);
        if (m) markProviderIconMissing(m[1]);
        if (providerId) markProviderIconMissing(providerId);
        setErrored(true);
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
