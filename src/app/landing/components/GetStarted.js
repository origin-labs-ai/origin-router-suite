"use client";
import { useCopyToClipboard } from "@/shared/hooks/useCopyToClipboard";
import { UPDATER_CONFIG } from "@/shared/constants/config";

// No package registry: the product is installed from the GitHub release or the
// one-line install script, never from npm. Pick the line that matches the reader.
function installCommand() {
  const ua = typeof navigator === "undefined" ? "" : navigator.userAgent;
  return /Windows/i.test(ua)
    ? UPDATER_CONFIG.installScriptCmdWin
    : UPDATER_CONFIG.installScriptCmdPosix;
}
const INSTALL_CMD = installCommand();

export default function GetStarted() {
  const { copied, copy } = useCopyToClipboard();

  const handleCopy = (text) => {
    copy(text, "landing");
  };

  return (
    <section className="py-24 px-6 bg-[#120f0d]">
      <div className="max-w-7xl mx-auto">
        <div className="flex flex-col lg:flex-row gap-16 items-start">
          {/* Left: Steps */}
          <div className="flex-1">
            <h2 className="text-3xl md:text-4xl font-bold mb-6">Get Started in 30 Seconds</h2>
            <p className="text-gray-400 text-lg mb-8">
              Install OriginRouter, configure your providers via web dashboard, and start routing AI requests.
            </p>
            
            <div className="flex flex-col gap-6">
              <div className="flex gap-4">
                <div className="flex-none w-8 h-8 rounded-full bg-[#2B7FFF]/20 text-[#2B7FFF] flex items-center justify-center font-bold">1</div>
                <div>
                  <h4 className="font-bold text-lg">Install OriginRouter</h4>
                  <p className="text-sm text-gray-500 mt-1">Download the installer, or run the one-line install script</p>
                </div>
              </div>
              
              <div className="flex gap-4">
                <div className="flex-none w-8 h-8 rounded-full bg-[#2B7FFF]/20 text-[#2B7FFF] flex items-center justify-center font-bold">2</div>
                <div>
                  <h4 className="font-bold text-lg">Open Dashboard</h4>
                  <p className="text-sm text-gray-500 mt-1">Configure providers and API keys via web interface</p>
                </div>
              </div>
              
              <div className="flex gap-4">
                <div className="flex-none w-8 h-8 rounded-full bg-[#2B7FFF]/20 text-[#2B7FFF] flex items-center justify-center font-bold">3</div>
                <div>
                  <h4 className="font-bold text-lg">Route Requests</h4>
                  <p className="text-sm text-gray-500 mt-1">Point your CLI tools to http://localhost:20128</p>
                </div>
              </div>
            </div>
          </div>

          {/* Right: Code block */}
          <div className="flex-1 w-full">
            <div className="rounded-xl overflow-hidden bg-[#1e1e1e] border border-[#3a3a3a] shadow-2xl">
              {/* Terminal header */}
              <div className="flex items-center gap-2 px-4 py-3 bg-[#252526] border-b border-gray-700">
                <div className="w-3 h-3 rounded-full bg-red-500"></div>
                <div className="w-3 h-3 rounded-full bg-yellow-500"></div>
                <div className="w-3 h-3 rounded-full bg-green-500"></div>
                <div className="ml-2 text-xs text-gray-500 font-mono">terminal</div>
              </div>
              
              {/* Terminal content */}
              <div className="p-6 font-mono text-sm leading-relaxed overflow-x-auto">
                <div 
                  className="flex items-center gap-2 mb-4 group cursor-pointer"
                  onClick={() => handleCopy(INSTALL_CMD)}
                >
                  <span className="text-green-400">$</span>
                  <span className="text-white">{INSTALL_CMD}</span>
                  <span className="ml-auto text-gray-500 text-xs opacity-0 group-hover:opacity-100">
                    {copied === "landing" ? "✓ Copied" : "Copy"}
                  </span>
                </div>
                
                <div className="text-gray-400 mb-6">
                  <span className="text-[#2B7FFF]">&gt;</span> Downloading the latest release...<br/>
                  <span className="text-[#2B7FFF]">&gt;</span> Verifying SHA256...<br/>
                  <span className="text-[#2B7FFF]">&gt;</span> Starting OriginRouter...<br/>
                  <span className="text-[#2B7FFF]">&gt;</span> Server running on <span className="text-[#2B7FFF]">http://localhost:20128</span><br/>
                  <span className="text-[#2B7FFF]">&gt;</span> Dashboard: <span className="text-[#2B7FFF]">http://localhost:20128/dashboard</span><br/>
                  <span className="text-green-400">&gt;</span> Ready to route! ✓
                </div>
                
                <div className="text-xs text-gray-500 mb-2 border-t border-gray-700 pt-4">
                  📝 Configure providers in dashboard or use environment variables
                </div>
                
                <div className="text-gray-400 text-xs">
                  <span className="text-purple-400">Data Location:</span><br/>
                  <span className="text-gray-500">  macOS / Linux / Windows:</span> ~/.or/db/data.sqlite
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

