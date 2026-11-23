// Always redirect to the newest published Windows Companion installer.
// GitHub prereleases are supported while LocalForge is in release-candidate stage.
import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

const RELEASES_API = 'https://api.github.com/repos/kayock/Kayocks-Local-Forge/releases?per_page=30';
const ASSET_URL_PREFIX = 'https://github.com/kayock/Kayocks-Local-Forge/releases/download/';
const FALLBACK_INSTALLER =
  'https://github.com/kayock/Kayocks-Local-Forge/releases/download/v0.5.0-rc4/LocalForge-Companion-Setup-0.5.0.exe';

interface GitHubRelease {
  draft?: boolean;
  published_at?: string | null;
  assets?: Array<{ name: string; browser_download_url: string }>;
}

function newestWindowsInstaller(releases: GitHubRelease[]): string | null {
  const published = releases
    .filter((release) => !release.draft)
    .sort((a, b) => Date.parse(b.published_at || '') - Date.parse(a.published_at || ''));

  for (const release of published) {
    const installer = release.assets?.find(
      (asset) =>
        /^LocalForge-Companion-Setup-[\w.-]+\.exe$/i.test(asset.name) &&
        asset.browser_download_url.startsWith(ASSET_URL_PREFIX),
    );
    if (installer) return installer.browser_download_url;
  }
  return null;
}

export async function GET() {
  let installerUrl = FALLBACK_INSTALLER;

  try {
    const response = await fetch(RELEASES_API, {
      headers: {
        Accept: 'application/vnd.github+json',
        'User-Agent': 'LocalForge-Companion-Download',
      },
      next: { revalidate: 900 },
      signal: AbortSignal.timeout(5000),
    });

    if (response.ok) {
      const releases = (await response.json()) as GitHubRelease[];
      if (Array.isArray(releases)) {
        installerUrl = newestWindowsInstaller(releases) || FALLBACK_INSTALLER;
      }
    }
  } catch {
    // Offline, rate-limited, or unavailable: use the known published installer.
  }

  return NextResponse.redirect(installerUrl, {
    status: 307,
    headers: { 'Cache-Control': 'no-store' },
  });
}
