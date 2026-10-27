import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

/**
 * Funnel runs on its own HTTPS port (443, 8443 and 10000 are allowed). Funnel is switched on per
 * port, so a dedicated port keeps whatever else this machine serves on 443 off the internet.
 * Not 8443: Slack's servers can't reach it (its URL check times out), while 10000 works.
 */
export const FUNNEL_PORT = 10000;

async function tailscale(...args: string[]) {
  const { stdout } = await run(process.env.TAILSCALE_BIN ?? "tailscale", args);
  return stdout;
}

/** https://<machine>.<tailnet>.ts.net:<port>, the public base URL Funnel serves. */
export async function funnelBaseUrl(port = FUNNEL_PORT): Promise<string> {
  const status = JSON.parse(await tailscale("status", "--json"));
  if (status.BackendState !== "Running") throw new Error(`Tailscale is ${status.BackendState}; connect it first.`);
  const host = String(status.Self.DNSName).replace(/\.$/, "");
  return port === 443 ? `https://${host}` : `https://${host}:${port}`;
}

/** Publishes only /hooks on the Funnel port; /messages and /health stay local. */
export async function enableFunnel(localPort: number, port = FUNNEL_PORT) {
  await tailscale("funnel", "--bg", "--yes", `--https=${port}`, "--set-path=/hooks", `http://127.0.0.1:${localPort}/hooks`);
  return `${await funnelBaseUrl(port)}/hooks`;
}

export async function disableFunnel(port = FUNNEL_PORT) {
  await tailscale("funnel", `--https=${port}`, "off");
}
