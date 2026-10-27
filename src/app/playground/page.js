import PlaygroundPageClient from "../(dashboard)/dashboard/playground/PlaygroundPageClient";

export const metadata = {
  title: "Playground",
};

// Standalone surface used by the "open in new window" button: same client,
// no sidebar or header, full viewport height.
export default function StandalonePlaygroundPage() {
  return (
    <div className="flex h-[100dvh] min-h-0 w-full flex-col bg-[#212121]">
      <PlaygroundPageClient />
    </div>
  );
}
