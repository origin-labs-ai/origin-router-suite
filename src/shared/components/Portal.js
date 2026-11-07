"use client";

// One shared escape hatch for raw position:fixed popups. Rendered inline, a
// fixed overlay becomes relative to any ancestor carrying a transform,
// filter or backdrop-blur — and hover states toggling those styles made
// popups teleport around the page as the cursor moved. Wrapping the overlay
// in <Portal> mounts it under document.body instead, where no such ancestor
// exists. SSR-safe: renders nothing until the client has mounted.
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";

export default function Portal({ children }) {
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  if (!mounted) return null;
  return createPortal(children, document.body);
}
