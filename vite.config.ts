import { defineConfig, loadEnv, type UserConfig } from "vite";
import react from "@vitejs/plugin-react";

// This frontend does not install Node types. Describe only the proxy hook we use.
interface PublicProxyRequest {
  getHeaderNames(): string[];
  removeHeader(name: string): void;
}
interface PublicProxyEvents {
  on(event: "proxyReq", listener: (request: PublicProxyRequest) => void): void;
}
const publicRoute =
  /^\/perpl-public\/v1\/(pub\/context|market-data\/[1-9]\d*\/(ticker|book\?levels=100))$/;

// Optional local read-only bridge; never a production server or bundle feature.
export default defineConfig(({ mode }) => {
  const enabled = loadEnv(mode, ".", "VITE_").VITE_PERPL_DEV_PROXY === "1";
  return {
    plugins: [
      react(),
      {
        name: "perpl-public-routes",
        configureServer(server: {
          middlewares: {
            use: (
              fn: (
                req: { url?: string; method?: string },
                res: { statusCode: number; end(): void },
                next: () => void,
              ) => void,
            ) => void;
          };
        }) {
          if (!enabled) return;
          server.middlewares.use((req, res, next) => {
            if (
              req.url?.startsWith("/perpl-public") &&
              (req.method !== "GET" || !publicRoute.test(req.url))
            ) {
              res.statusCode = 404;
              res.end();
              return;
            }
            next();
          });
        },
      },
    ],
    server: enabled
      ? {
          proxy: {
            "/perpl-public": {
              target: "https://testnet.perpl.xyz",
              changeOrigin: true,
              rewrite: (path) => path.replace(/^\/perpl-public/, "/api"),
              configure(proxy) {
                const publicProxy = proxy as unknown as PublicProxyEvents;
                publicProxy.on("proxyReq", (request) => {
                  for (const header of request.getHeaderNames()) {
                    if (
                      [
                        "cookie",
                        "authorization",
                        "proxy-authorization",
                      ].includes(header) ||
                      header.startsWith("x-api-")
                    )
                      request.removeHeader(header);
                  }
                });
              },
            },
          },
        }
      : undefined,
    test: { environment: "node", include: ["src/**/*.test.ts"] },
  } as UserConfig;
});
