"use client";

import PropTypes from "prop-types";
import { useModelCaps } from "@/shared/hooks/useModelCaps";
import { prettyModelName } from "@/shared/utils/modelDisplayName";
import { modelTier } from "@/shared/utils/modelTier";

/**
 * A seat's readable name, everywhere the same way.
 *
 * A seat string carries the provider alias, sometimes a vendor namespace and often a
 * deployment suffix, and some providers ship an opaque id with the real model name
 * beside it (`qd/qfmodel` is named "Qwen3.8-Flash"). Reading only the id made models
 * unfindable and put a flash model in the heavy class. This component asks the
 * catalog for the name, applies the shared display rules, and reports the class
 * (Pro / Flash, with the family subcategory) in the tooltip.
 */
export default function SeatName({ seat, showTier = false, className = "", title: titleOverride }) {
  const { getModelName } = useModelCaps();
  const name = getModelName(seat);
  const label = prettyModelName(name || seat);
  const tier = modelTier(seat, name);

  return (
    <span className={className} title={titleOverride || `${seat} · ${tier.subcategory}`}>
      {label}
      {showTier ? (
        <span
          className={`ml-1 rounded px-1 py-0.5 text-[9px] uppercase tracking-wide ${tier.tier === "pro"
            ? "bg-violet-500/10 text-violet-500"
            : "bg-sky-500/10 text-sky-500"}`}
        >
          {tier.tier}
        </span>
      ) : null}
    </span>
  );
}

SeatName.propTypes = {
  seat: PropTypes.string.isRequired,
  showTier: PropTypes.bool,
  className: PropTypes.string,
  title: PropTypes.string,
};
