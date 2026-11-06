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
      onClose={onboarded ? finish : undefined}
      onFinished={finish}
    />
  );
}
