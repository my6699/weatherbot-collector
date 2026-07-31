const CONNECT_MS = 5000;
const BODY_MS = 10000;

import { execSync } from "child_process";
import { fetch as undiciFetch, ProxyAgent, type Dispatcher } from "undici";

/**
 * Discover a usable HTTP(S) proxy.
 * Order: HTTPS_PROXY/HTTP_PROXY env -> wininet registry (system proxy) -> common local ports.
 */
function detectProxy(): string | null {
  for (const key of ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy"]) {
    const v = process.env[key];
    if (v && v.length > 0) return v;
  }
  try {
    const reg = execSync(
      `reg query "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings" /v ProxyEnable`,
      { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] },
    );
    if (/0x1/.test(reg)) {
      const server = execSync(
        `reg query "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings" /v ProxyServer`,
        { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] },
      );
      const m = server.match(/ProxyServer\s+REG_SZ\s+(\S+)/);
      if (m?.[1]) {
        const p = m[1]!.trim();
        if (p.startsWith("http://") || p.startsWith("https://") || p.startsWith("socks")) return p;
        return `http://${p}`;
      }
    }
  } catch {
    /* no registry proxy */
  }
  return null;
}

let proxyAgent: Dispatcher | null = null;

function getProxyAgent(): Dispatcher | null {
  const proxy = detectProxy();
  if (!proxy) return null;
  if (proxyAgent) return proxyAgent;
  try {
    proxyAgent = new ProxyAgent(proxy);
    return proxyAgent;
  } catch {
    return null;
  }
}

export async function fetchJson<T>(url: string): Promise<T> {
  const ac = new AbortController();
  const connectTimer = setTimeout(() => ac.abort(), CONNECT_MS + BODY_MS);
  try {
    const opts: Record<string, unknown> = {
      signal: ac.signal,
      headers: { Accept: "application/json" },
    };
    const agent = getProxyAgent();
    if (agent) opts.dispatcher = agent;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const res = await (undiciFetch as any)(url, opts);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return (await res.json()) as T;
  } finally {
    clearTimeout(connectTimer);
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
