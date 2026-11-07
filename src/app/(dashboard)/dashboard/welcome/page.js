"use client";

// The first-run wizard.
//
// It is shown once, on the first launch after an install. The wizard itself
// lives in GetStartedWizard: theme first, then the migration, then a
// provider, a combo, the tuning, Claude Code and the summary.

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import GetStartedWizard from "@/shared/components/GetStartedWizard";

export default function WelcomePage() {
  const router = useRouter();
  const [onboarded, setOnboarded] = useState(null);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/migrations")
      .then((res) => res.json())
      .then((data) => {
        if (!cancelled) setOnboarded(data?.onboarded === true);
      })
      .catch(() => {
        if (!cancelled) setOnboarded(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const finish = useCallback(() => {
    router.push("/dashboard");
  }, [router]);

  // Closing the wizard (X button, backdrop click, any non-finish exit) still
  // marks onboarding complete: a macOS-style close never traps the user into
  // seeing the same first-run dialog on every navigation. Whatever the user
  // configured stays; "scratch" only records that the wizard was seen.
  const closeAndMark = useCallback(() => {
    fetch("/api/migrations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sourceId: "scratch" }),
    })
      .catch(() => {})
      .finally(() => router.push("/dashboard"));
  }, [router]);

  if (onboarded === null) {
    return (
      <div className="flex min-h-[60vh] items-center justify-center">
        <span className="material-symbols-rounded animate-spin text-2xl text-text-muted">
          progress_activity
        </span>
      </div>
    );
  }

  return (
    <GetStartedWizard
      isOpen
      firstRun={!onboarded}
      onClose={onboarded ? finish : closeAndMark}
      onFinished={finish}
    />
  );
}
