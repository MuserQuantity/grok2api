import type { GrokSettings } from "../settings";

const DEFAULT_BROWSER = "chrome136";
const DEFAULT_USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36";

function extractMajorVersion(browser: string, userAgent: string): string | null {
  if (browser) {
    const m = browser.match(/(\d{2,3})/);
    if (m) return m[1]!;
  }
  for (const pattern of [/Edg\/(\d+)/, /Chrome\/(\d+)/, /Chromium\/(\d+)/]) {
    const m = userAgent.match(pattern);
    if (m) return m[1]!;
  }
  return null;
}

function detectPlatform(userAgent: string): string | null {
  const ua = userAgent.toLowerCase();
  if (ua.includes("windows")) return "Windows";
  if (ua.includes("mac os x") || ua.includes("macintosh")) return "macOS";
  if (ua.includes("android")) return "Android";
  if (ua.includes("iphone") || ua.includes("ipad")) return "iOS";
  if (ua.includes("linux")) return "Linux";
  return null;
}

function detectArch(userAgent: string): string | null {
  const ua = userAgent.toLowerCase();
  if (ua.includes("aarch64") || ua.includes("arm")) return "arm";
  if (ua.includes("x86_64") || ua.includes("x64") || ua.includes("win64") || ua.includes("intel")) return "x86";
  return null;
}

function buildClientHints(browser: string, userAgent: string): Record<string, string> {
  const b = browser.toLowerCase();
  const ua = userAgent.toLowerCase();

  const isEdge = b.includes("edge") || ua.includes("edg");
  const isBrave = b.includes("brave");
  const isChromium =
    ["chrome", "chromium", "edge", "brave"].some((k) => b.includes(k)) ||
    ua.includes("chrome") ||
    ua.includes("chromium") ||
    ua.includes("edg");

  if (!isChromium) return {};

  const version = extractMajorVersion(browser, userAgent);
  if (!version) return {};

  let brand: string;
  if (isEdge) brand = "Microsoft Edge";
  else if (b.includes("chromium")) brand = "Chromium";
  else if (isBrave) brand = "Brave";
  else brand = "Google Chrome";

  const secChUa = `"${brand}";v="${version}", "Chromium";v="${version}", "Not(A:Brand";v="24"`;

  const platform = detectPlatform(userAgent);
  const arch = detectArch(userAgent);
  const mobile = ua.includes("mobile") || platform === "Android" || platform === "iOS" ? "?1" : "?0";

  const hints: Record<string, string> = {
    "Sec-Ch-Ua": secChUa,
    "Sec-Ch-Ua-Mobile": mobile,
  };
  if (platform) hints["Sec-Ch-Ua-Platform"] = `"${platform}"`;
  if (arch) {
    hints["Sec-Ch-Ua-Arch"] = arch;
    hints["Sec-Ch-Ua-Bitness"] = "64";
  }
  hints["Sec-Ch-Ua-Model"] = "";
  return hints;
}

function randomString(length: number, lettersOnly = true): string {
  const letters = "abcdefghijklmnopqrstuvwxyz";
  const digits = "0123456789";
  const chars = lettersOnly ? letters : letters + digits;
  let out = "";
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  for (let i = 0; i < length; i++) out += chars[bytes[i]! % chars.length]!;
  return out;
}

function generateStatsigId(): string {
  let msg: string;
  if (Math.random() < 0.5) {
    const rand = randomString(5, false);
    msg = `e:TypeError: Cannot read properties of null (reading 'children['${rand}']')`;
  } else {
    const rand = randomString(10, true);
    msg = `e:TypeError: Cannot read properties of undefined (reading '${rand}')`;
  }
  return btoa(msg);
}

export function getDynamicHeaders(settings: GrokSettings, pathname: string): Record<string, string> {
  const dynamic = settings.dynamic_statsig !== false;
  const statsigId = dynamic ? generateStatsigId() : (settings.x_statsig_id ?? "").trim();
  if (!dynamic && !statsigId) throw new Error("配置缺少 x_statsig_id（且未启用 dynamic_statsig）");

  const browser = (settings.browser ?? DEFAULT_BROWSER).trim();
  const userAgent = (settings.user_agent ?? DEFAULT_USER_AGENT).trim();

  const headers: Record<string, string> = {
    Accept: "*/*",
    "Accept-Encoding": "gzip, deflate, br, zstd",
    "Accept-Language": "zh-CN,zh;q=0.9",
    Origin: "https://grok.com",
    Referer: "https://grok.com/",
    "User-Agent": userAgent,
    "Sec-Fetch-Dest": "empty",
    "Sec-Fetch-Mode": "cors",
    "Sec-Fetch-Site": "same-origin",
    Baggage: "sentry-environment=production,sentry-release=d6add6fb0460641fd482d767a335ef72b9b6abb8,sentry-public_key=b311e0f2690c81f25e2c4cf6d4f7ce1c",
    "Cache-Control": "no-cache",
    Pragma: "no-cache",
    Priority: "u=1, i",
  };

  // Dynamic Client Hints
  const hints = buildClientHints(browser, userAgent);
  Object.assign(headers, hints);

  headers["x-statsig-id"] = statsigId;
  headers["x-xai-request-id"] = crypto.randomUUID();
  headers["Content-Type"] = pathname.includes("upload-file") ? "text/plain;charset=UTF-8" : "application/json";
  return headers;
}
