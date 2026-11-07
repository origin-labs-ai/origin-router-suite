"use client";

import { useEffect, useState } from "react";
import PropTypes from "prop-types";
import { getProviderIconSrc } from "@/shared/utils/providerIcon";
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
  const baseSrc = resolveSrc(src, providerId);
  const [errored, setErrored] = useState(false);
  // One retry with a cache-buster before a miss is treated as real. While the
  // gateway restarts under an open tab, icons 404 once — the old behaviour let
  // that single miss stick for the whole browser session and painted healthy
  // providers as letter glyphs. The retry lets a transient miss recover on its
  // own; the cache-buster then stays so a browser-cached 404 cannot bounce the
  // component into an error/retry loop.
  const [retry, setRetry] = useState(0);

  // Reused instances (a list re-rendering a card for a different provider)
  // must forget the previous image's failure.
  useEffect(() => {
    setErrored(false);
    setRetry(0);
  }, [baseSrc]);

  const effectiveSrc =
    retry > 0 && baseSrc && !baseSrc.startsWith("data:") && baseSrc.includes("/")
      ? `${baseSrc}${baseSrc.includes("?") ? "&" : "?"}r=${retry}`
      : baseSrc;

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
        if (retry < 1) {
          setRetry(retry + 1);
          return;
        }
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
