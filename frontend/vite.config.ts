import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Peel the large *static* libraries into their own chunks so the entry bundle
// stays under Vite's 500 kB warning threshold. RainbowKit / WalletConnect /
// Reown keep their built-in per-wallet, per-locale dynamic splitting, so they
// are deliberately left ungrouped.
export default defineConfig({
  base: "./",
  plugins: [react()],
  build: {
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (!id.includes("node_modules")) return;
          if (id.includes("/react-dom/") || id.includes("/scheduler/")) return "react-dom";
          if (id.includes("/react/")) return "react";
          if (id.includes("/genlayer-js/")) return "genlayer";
          if (
            id.includes("/viem/") ||
            id.includes("/abitype/") ||
            id.includes("/ox/") ||
            id.includes("/@noble/") ||
            id.includes("/@scure/") ||
            id.includes("/@adraffy/")
          ) {
            return "crypto";
          }
          if (id.includes("/wagmi/") || id.includes("/@wagmi/")) return "wagmi";
          if (id.includes("/@tanstack/")) return "tanstack";
        },
      },
    },
  },
});
