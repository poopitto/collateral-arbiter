import { connectorsForWallets } from "@rainbow-me/rainbowkit";
import { injectedWallet } from "@rainbow-me/rainbowkit/wallets";
import { createConfig, http } from "wagmi";
import { genLayerStudionet, GENLAYER_RPC_URL } from "./chain";

const connectors = connectorsForWallets(
  [{ groupName: "Installed", wallets: [injectedWallet] }],
  { appName: "BACKBASKET", projectId: "collateral-arbiter" }
);

export const config = createConfig({
  connectors,
  chains: [genLayerStudionet],
  transports: { [genLayerStudionet.id]: http(GENLAYER_RPC_URL) },
  ssr: false,
});

declare module "wagmi" {
  interface Register {
    config: typeof config;
  }
}
