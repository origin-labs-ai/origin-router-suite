import ClaudeApp from "@/shared/components/claude/ClaudeApp";

export const metadata = {
  title: "Claude by Origin",
};

// Native desktop surface. Rendered without the dashboard chrome so the Electron
// shell can point straight at it.
export default function ClaudePage() {
  return <ClaudeApp />;
}
