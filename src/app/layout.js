import { Inter } from "next/font/google";
import { GoogleAnalytics } from "@next/third-parties/google";
import "material-symbols/outlined.css";
import "./globals.css";
import { ThemeProvider } from "@/shared/components/ThemeProvider";
import "@/lib/network/initOutboundProxy"; // Auto-initialize outbound proxy env
import "@/shared/services/bootstrap"; // Auto-run initializeApp (watchdog, auto-resume tunnel)
import { initConsoleLogCapture } from "@/lib/consoleLogBuffer";
import { RuntimeI18nProvider } from "@/i18n/RuntimeI18nProvider";
import DesktopTitleBar from "@/shared/components/DesktopTitleBar";

// Hook console immediately at module load time (server-side only, runs once)
initConsoleLogCapture();

const inter = Inter({
  subsets: ["latin"],
  variable: "--font-inter",
});

export const metadata = {
  title: "OriginRouter",
  description: "One endpoint for every AI provider. Route, fall back, and monitor usage from a single local dashboard.",
  icons: {
    icon: [
      { url: "/brand/origin-mark-256.png", type: "image/png", sizes: "256x256" },
      { url: "/favicon.ico", type: "image/x-icon", sizes: "any" },
    ],
    shortcut: "/favicon.ico",
    apple: "/brand/origin-mark-256.png",
  },
  // A bare link in a chat, a forum or a feed used to preview as nothing. The
  // card is rendered from the real dashboard by scripts/make-og-image.js.
  openGraph: {
    title: "OriginRouter - one endpoint for every AI provider",
    description:
      "Route across 90+ providers, fall back before an error reaches your code, and cut 60-90% of tool-output tokens. Local-first, one port, MIT.",
    url: "https://github.com/origin-labs-ai/origin-router-suite",
    siteName: "OriginRouter",
    images: [{ url: "/og-image.png", width: 1200, height: 630, alt: "OriginRouter dashboard" }],
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
    title: "OriginRouter - one endpoint for every AI provider",
    description:
      "Route across 90+ providers, fall back before an error reaches your code, and cut 60-90% of tool-output tokens.",
    images: ["/og-image.png"],
  },
};

export const viewport = {
  themeColor: "#0a0a0a",
};

export default function RootLayout({ children }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        {/* Apply persisted theme before first paint so a reload does not flash the
            default (light) theme before the client store hydrates. Mirrors the
            zustand-persist "theme" key and the `dark` class applyTheme() sets. */}
        <script
          dangerouslySetInnerHTML={{
            __html: `(function(){try{var s=localStorage.getItem('theme');var t=s?(JSON.parse(s).state||{}).theme:'system';t=t||'system';var m=window.matchMedia('(prefers-color-scheme: dark)').matches;if(t==='dark'||(t==='system'&&m)){document.documentElement.classList.add('dark')}}catch(e){}})();`,
          }}
        />
        <script
          dangerouslySetInnerHTML={{
            __html: `var d=document,r=d.documentElement,f=function(){r.classList.add('fonts-loaded')};if(d.fonts&&d.fonts.load){d.fonts.load('24px "Material Symbols Outlined"').then(f).catch(f);setTimeout(f,3000)}else{f()}`,
          }}
        />
      </head>
      <body className={`${inter.variable} font-sans antialiased`}>
        <DesktopTitleBar />
        <ThemeProvider>
          <RuntimeI18nProvider>
            {children}
          </RuntimeI18nProvider>
        </ThemeProvider>
        <GoogleAnalytics gaId={"G-LC959F603F"} />
      </body>
    </html>
  );
}
