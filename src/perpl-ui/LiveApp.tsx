import { useState } from "react";
import { isAddress, createWalletClient, custom, type Address } from "viem";
import {
  PrivyProvider,
  usePrivy,
  useWallets,
  useCreateWallet,
  useSendTransaction,
  useExportWallet,
} from "@privy-io/react-auth";
import { testnet } from "../testnet-config";
import { useLiveEngine, type LiveIdentity } from "./engine/live";
import ReferenceView from "./view/ReferenceView";
import "@fontsource/jetbrains-mono/latin-400.css";
import "@fontsource/jetbrains-mono/latin-500.css";
import "@fontsource/inter-tight/latin-800.css";
import "./styles/perpl.css";

function LiveView({ identity }: { identity: LiveIdentity }) {
  const engine = useLiveEngine(identity);
  return <ReferenceView engine={engine} />;
}
function AuthenticatedView() {
  const { ready, authenticated, user, login, logout } = usePrivy();
  const { ready: walletsReady, wallets } = useWallets();
  const { createWallet } = useCreateWallet();
  const { sendTransaction } = useSendTransaction();
  const { exportWallet } = useExportWallet();
  const [selected, setSelected] = useState("");
  // Authenticated linked identity is sufficient for public chain reads. Provider readiness
  // is separate and never confers signing authority in this composition.
  const embedded = (
    ready && authenticated ? (user?.linkedAccounts ?? []) : []
  ).flatMap((account) =>
    account.type === "wallet" &&
    account.chainType === "ethereum" &&
    account.walletClientType === "privy" &&
    isAddress(account.address)
      ? [account.address]
      : [],
  );
  const wallet =
    embedded.length === 1
      ? embedded[0]
      : embedded.find((address) => address === selected);
  const connectedWallet = walletsReady
    ? wallets.find(
        (item) =>
          item.walletClientType === "privy" &&
          item.address.toLowerCase() === wallet?.toLowerCase(),
      )
    : undefined;
  const connected = !!connectedWallet;
  const fundingWallet: LiveIdentity["wallet"] =
    connectedWallet && wallet
      ? {
          prepare: async () => {
            await connectedWallet.switchChain(10143);
            const provider = await connectedWallet.getEthereumProvider();
            const chain = await provider.request({ method: "eth_chainId" });
            const accounts = await provider.request({ method: "eth_accounts" });
            if (
              !Array.isArray(accounts) ||
              !accounts.some(
                (address: unknown) =>
                  typeof address === "string" &&
                  address.toLowerCase() === wallet.toLowerCase(),
              )
            )
              throw Error("Selected wallet is no longer available.");
            return { address: connectedWallet.address, chainId: Number(chain) };
          },
          send: async ({ kind: _kind, ...transaction }, description) =>
            (
              await sendTransaction(transaction, {
                address: connectedWallet.address,
                uiOptions: {
                  showWalletUIs: true,
                  description,
                  successHeader: "Transaction submitted",
                  successDescription: "Return to verify the finalized receipt.",
                },
              })
            ).hash,
        }
      : undefined;
  return (
    <LiveView
      identity={{
        user: wallet
          ? {
              method: "Privy",
              label: "Wallet",
              addr: wallet,
              embedded: true,
            }
          : null,
        login: () => {
          if (ready && !authenticated) login();
        },
        logout,
        wallet: fundingWallet,
        selectWallets: embedded.length > 1 ? embedded : undefined,
        selectWallet: setSelected,
        sign:
          fundingWallet && connectedWallet && wallet
            ? async (data) => {
                const current = await fundingWallet.prepare();
                if (
                  current.chainId !== 10143 ||
                  current.address.toLowerCase() !== wallet.toLowerCase()
                )
                  throw Error(
                    "Wallet must match the reviewed Monad testnet owner.",
                  );
                const provider = await connectedWallet.getEthereumProvider();
                return createWalletClient({
                  account: wallet as Address,
                  chain: testnet.chain,
                  transport: custom(provider),
                }).signTypedData(data);
              }
            : undefined,
        setup:
          ready && authenticated && !embedded.length && walletsReady
            ? async () => {
                await createWallet();
              }
            : undefined,
        export:
          wallet && connected
            ? async () => {
                await exportWallet({ address: wallet });
              }
            : undefined,
        reason: !ready
          ? "Restoring wallet identity…"
          : authenticated && !wallet
            ? "Select one linked embedded wallet before account reads. Wallet setup is not available yet."
            : wallet && !connected
              ? "Wallet connection is unavailable. Account balances use public chain reads; trading is unavailable."
              : undefined,
      }}
    />
  );
}
export default function PerplLiveApp() {
  const appId = import.meta.env.VITE_PRIVY_APP_ID as string | undefined;
  return appId ? (
    <PrivyProvider
      appId={appId}
      config={{
        loginMethods: ["email", "google", "wallet"],
        defaultChain: testnet.chain,
        supportedChains: [testnet.chain],
        externalWallets: { walletConnect: { enabled: false } },
        embeddedWallets: {
          ethereum: { createOnLogin: "off" },
          showWalletUIs: true,
        },
      }}
    >
      <AuthenticatedView />
    </PrivyProvider>
  ) : (
    <LiveView
      identity={{
        user: null,
        login: () => {},
        logout: async () => {},
        reason:
          "Wallet login is not configured. Log in for account details requires Privy configuration.",
      }}
    />
  );
}
