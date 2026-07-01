import { config } from "./config.js";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

const TOKEN_CACHE_PATH = path.join(os.tmpdir(), "oncall-mcp-token.json");

/** Parse the exp field from a base64url JWT payload; fallback = 23 h from now */
function parseExpiry(token: string): number {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) throw new Error("bad token format");
    const decoded = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")) as {
      exp?: number;
    };
    // Accept only if exp is meaningfully in the future (> 60 s)
    if (decoded.exp && decoded.exp > Math.floor(Date.now() / 1000) + 60) {
      return decoded.exp;
    }
  } catch {
    // Ignore — fall through to fallback
  }
  // Backend issues 24-hour tokens; use 23 h as conservative fallback
  return Math.floor(Date.now() / 1000) + 23 * 3600;
}

/** Persist token to /tmp so repeated test runs skip re-login */
function saveCachedToken(token: string, expiresAt: number): void {
  try {
    fs.writeFileSync(TOKEN_CACHE_PATH, JSON.stringify({ token, expiresAt }), "utf8");
  } catch {
    // Best-effort — ignore write errors
  }
}

/** Load a previously cached token; returns null if missing or expired */
function loadCachedToken(): { token: string; expiresAt: number } | null {
  try {
    const raw = fs.readFileSync(TOKEN_CACHE_PATH, "utf8");
    const cached = JSON.parse(raw) as { token: string; expiresAt: number };
    // Require at least 5 minutes of validity remaining
    if (cached.token && cached.expiresAt > Math.floor(Date.now() / 1000) + 300) {
      return cached;
    }
  } catch {
    // Missing file or parse error — fall through
  }
  return null;
}

class TokenManager {
  private token = "";
  private expiresAt = 0;
  /** In-flight refresh promise — deduplicates concurrent callers */
  private refreshPromise: Promise<void> | null = null;

  constructor() {
    // Restore from disk cache so repeated test runs skip re-login
    const cached = loadCachedToken();
    if (cached) {
      this.token = cached.token;
      this.expiresAt = cached.expiresAt;
      process.stderr.write(
        `[token-manager] restored cached token, expires at ${new Date(cached.expiresAt * 1000).toISOString()}\n`
      );
    }
  }

  async getToken(): Promise<string> {
    // Refresh only when no token or expiring within 5 minutes
    if (!this.token || Math.floor(Date.now() / 1000) > this.expiresAt - 300) {
      // Deduplicate: all concurrent callers share the same refresh promise
      if (!this.refreshPromise) {
        this.refreshPromise = this.refresh().finally(() => {
          this.refreshPromise = null;
        });
      }
      await this.refreshPromise;
    }
    return this.token;
  }

  private async refresh(): Promise<void> {
    const res = await fetch(`${config.baseUrl}/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ phone: config.adminPhone }),
    });

    if (!res.ok) {
      throw new Error(`Admin login failed (${res.status}): ${await res.text()}`);
    }

    const data = (await res.json()) as { success: boolean; token: string };
    if (!data.success || !data.token) {
      throw new Error("Admin login response missing token");
    }

    this.token = data.token;
    this.expiresAt = parseExpiry(this.token);
    saveCachedToken(this.token, this.expiresAt);
    process.stderr.write(
      `[token-manager] token refreshed, expires at ${new Date(this.expiresAt * 1000).toISOString()}\n`
    );
  }
}

export const tokenManager = new TokenManager();
