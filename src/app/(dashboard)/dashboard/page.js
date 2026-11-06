import { redirect } from "next/navigation";
import { getMachineId } from "@/shared/utils/machine";
import { getSettings } from "@/lib/localDb";
import EndpointPageClient from "./endpoint/EndpointPageClient";

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
