import { defineChain } from "viem";

// Public GenLayer Studionet configuration. Values come from the committed
// .env (see .env.example); the fallbacks keep the deployed address fixed if a
// build runs without an env file.
export const GENLAYER_CHAIN_ID = Number(import.meta.env.VITE_CHAIN_ID ?? 61999);
export const GENLAYER_RPC_URL =
  import.meta.env.VITE_RPC_URL ?? "https://studio.genlayer.com/api";
export const CONTRACT_ADDRESS = (import.meta.env.VITE_CONTRACT_ADDRESS ??
  "0x0974437d2d718aedaAf249d844Ad60f4f22Edf01") as `0x${string}`;

export const genLayerStudionet = defineChain({
  id: GENLAYER_CHAIN_ID,
  name: "GenLayer Studionet",
  nativeCurrency: { name: "GEN", symbol: "GEN", decimals: 18 },
  rpcUrls: {
    default: { http: [GENLAYER_RPC_URL] },
    public: { http: [GENLAYER_RPC_URL] },
  },
  testnet: true,
});
