import Link from "next/link";
import { APP_CONFIG, GITHUB_CONFIG } from "@/shared/constants/config";

export const metadata = {
  title: `About ${APP_CONFIG.name}`,
};

const LINKS = [
  { label: "GitHub", href: GITHUB_CONFIG.repoUrl, icon: "code" },
  { label: "Releases", href: `${GITHUB_CONFIG.repoUrl}/releases`, icon: "new_releases" },
  { label: "Issues", href: `${GITHUB_CONFIG.repoUrl}/issues`, icon: "bug_report" },
];

const HIGHLIGHTS = [
  { icon: "layers", title: "Combos", text: "Group models behind one id with fallback, round-robin, smart or fusion routing." },
  { icon: "savings", title: "Token saver", text: "Compress tool output and pick cheaper models before your quota runs dry." },
  { icon: "data_usage", title: "Quota tracking", text: "See every account's remaining window in one place." },
  { icon: "chat_bubble", title: "Playground", text: "Chat with any model or combo straight from the dashboard." },
];

export default function AboutPage() {
  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-6">
      <div className="or-panel flex flex-col items-center gap-4 px-6 py-10 text-center">
        <img
          src="/brand/origin-wordmark-1200.png"
          alt="OriginRouter"
          className="w-full max-w-[560px] rounded-md"
        />
        <p className="max-w-2xl text-sm leading-6 text-text-muted">
          {APP_CONFIG.description}. One local endpoint for every provider you already pay for —
          every key, every quota, every model behind a single OpenAI-compatible API.
        </p>
        <div className="flex flex-wrap items-center justify-center gap-2">
          <span className="or-chip font-mono">v{APP_CONFIG.version}</span>
          <span className="or-chip">localhost:20128</span>
          <span className="or-chip">MIT</span>
        </div>
        <div className="mt-2 flex flex-wrap items-center justify-center gap-2">
          {LINKS.map((link) => (
            <a
              key={link.label}
              href={link.href}
              target="_blank"
              rel="noreferrer"
              className="or-action"
            >
              <span className="material-symbols-outlined text-[16px]">{link.icon}</span>
              {link.label}
            </a>
          ))}
        </div>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        {HIGHLIGHTS.map((item) => (
          <div key={item.title} className="or-panel p-4">
            <div className="mb-2 flex items-center gap-2">
              <span className="material-symbols-outlined text-[18px] text-primary">{item.icon}</span>
              <h2 className="text-sm font-semibold text-text-main">{item.title}</h2>
            </div>
            <p className="text-xs leading-5 text-text-muted">{item.text}</p>
          </div>
        ))}
      </div>

      <div className="or-panel flex flex-col gap-3 p-4 text-xs text-text-muted">
        <p>
          Data lives on this machine only. Providers, keys, combos and usage stay in
          your local database — nothing is uploaded by the dashboard.
        </p>
        <p>
          Built on Next.js and Node, shipped as a single CLI.{" "}
          <Link href="/dashboard/endpoint" className="font-medium text-primary hover:underline">
            Point a client at the endpoint
          </Link>{" "}
          to start routing.
        </p>
      </div>
    </div>
  );
}
