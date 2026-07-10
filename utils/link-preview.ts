export interface LinkPreviewResponse {
  inline?: {
    title: string;
  };
}

export interface JenkinsReportUrlOptions {
  allowedHosts?: string[];
  jenkinsPublicUrl?: string;
}

const DEFAULT_JENKINS_HOST = 'jenkins.wiac.xyz';
const URL_KEYS = new Set(['url', 'href', 'link', 'preview_url', 'source_url']);

function parseUrl(value: string): URL | null {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

function normalizeHost(host: string): string {
  return host.trim().toLowerCase();
}

function hostFromUrl(value?: string): string | null {
  if (!value) return null;
  return parseUrl(value)?.host.toLowerCase() || null;
}

function getAllowedHosts(options: JenkinsReportUrlOptions): Set<string> {
  const hosts = [
    DEFAULT_JENKINS_HOST,
    ...(options.allowedHosts || []),
    hostFromUrl(options.jenkinsPublicUrl),
    hostFromUrl(process.env.JENKINS_PUBLIC_URL),
    hostFromUrl(process.env.JENKINS_BUILD_URL),
    hostFromUrl(process.env.PLAYWRIGHT_REPORT_URL),
  ]
    .filter((host): host is string => Boolean(host))
    .map(normalizeHost);

  return new Set(hosts);
}

export function isJenkinsReportUrl(
  rawUrl: string,
  options: JenkinsReportUrlOptions = {}
): boolean {
  const url = parseUrl(rawUrl);
  if (!url) return false;

  const allowedHosts = getAllowedHosts(options);
  if (!allowedHosts.has(normalizeHost(url.host))) {
    return false;
  }

  const pathname = url.pathname;
  const isHtmlReport =
    pathname.endsWith('/Playwright_Report') || pathname.includes('/Playwright_Report/');
  const isReportArchive =
    pathname.includes('/artifact/playwright-report/') &&
    pathname.endsWith('/playwright-report.zip');

  return isHtmlReport || isReportArchive;
}

export function buildJenkinsReportPreview(rawUrl?: string): LinkPreviewResponse {
  if (!rawUrl || !isJenkinsReportUrl(rawUrl)) {
    return {};
  }

  return {
    inline: {
      title: 'Playwright 测试报告',
    },
  };
}

export function extractUrlPreviewTarget(payload: unknown): string | undefined {
  return findUrlByKey(payload, 0);
}

function findUrlByKey(value: unknown, depth: number): string | undefined {
  if (!value || depth > 5) return undefined;

  if (typeof value === 'string') {
    return parseUrl(value) ? value : undefined;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findUrlByKey(item, depth + 1);
      if (found) return found;
    }
    return undefined;
  }

  if (typeof value !== 'object') return undefined;

  const record = value as Record<string, unknown>;
  for (const [key, child] of Object.entries(record)) {
    if (URL_KEYS.has(key) && typeof child === 'string' && parseUrl(child)) {
      return child;
    }
  }

  for (const child of Object.values(record)) {
    const found = findUrlByKey(child, depth + 1);
    if (found) return found;
  }

  return undefined;
}
