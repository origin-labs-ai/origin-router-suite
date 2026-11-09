import { redirect } from "next/navigation";
import { getMachineId } from "@/shared/utils/machine";
import { getSettings } from "@/lib/localDb";
import EndpointPageClient from "./endpoint/EndpointPageClient";

// The onboarding flag changes at runtime (the wizard's Finish writes it), so
// this page must be rendered per request. Without this, a build-time render
// can pin the redirect and send an already-onboarded user back to /welcome.
export const dynamic = "force-dynamic";

export default async function DashboardPage() {
  // First launch after an install: the wizard asks whether an existing setup
  // should come along, or whether to start from scratch. It is shown once.
  const settings = await getSettings();
  const onboarded =
    settings?.onboardingComplete === true || settings?.onboardingComplete === "true";
  if (!onboarded) {
    redirect("/dashboard/welcome");
  }

  const machineId = await getMachineId();
  return <EndpointPageClient machineId={machineId} />;
}
