const WIDTH = 640;
const HEIGHT = 320;
const CACHE_TTL_SECONDS = 60 * 60;

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const username = url.pathname.replace(/^\/+|\/+$/g, "");
    const theme = getTheme(url);

    if (!username) {
      return svgResponse(renderInfoSvg(theme));
    }

    if (isDemoRequest(username, url)) {
      const inlineAvatar = shouldInlineAvatar(url);
      const demoStats = getMockStats(username);
      const avatarHref = await resolveAvatarHref(
        demoStats.avatarUrl,
        inlineAvatar
      );
      const svg = renderCardSvg({ ...demoStats, avatarHref }, theme);
      return svgResponse(svg);
    }

    const shouldRefresh =
      url.searchParams.get("refresh") === "1" ||
      url.searchParams.get("refresh") === "true";

    const cacheKey = new Request(url.toString(), request);
    const cache = caches.default;
    if (!shouldRefresh) {
      const cached = await cache.match(cacheKey);
      if (cached) {
        return cached;
      }
    }

    const token = env.GITHUB_TOKEN;
    if (!token) {
      return svgResponse(
        renderErrorSvg(
          "Missing GITHUB_TOKEN. Use /test to preview or add a GitHub token.",
          theme
        ),
        500
      );
    }

    try {
      const stats = await fetchUserStats(username, token);
      if (!stats) {
        return svgResponse(renderErrorSvg("GitHub user not found.", theme), 404);
      }
      const inlineAvatar = shouldInlineAvatar(url);
      const avatarHref = await resolveAvatarHref(stats.avatarUrl, inlineAvatar);
      const svg = renderCardSvg({ ...stats, avatarHref }, theme);
      const response = svgResponse(svg);
      response.headers.set(
        "Cache-Control",
        `public, max-age=${CACHE_TTL_SECONDS}`
      );
      ctx.waitUntil(cache.put(cacheKey, response.clone()));
      return response;
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      return svgResponse(renderErrorSvg(message, theme), 500);
    }
  },
};

function isDemoRequest(username, url) {
  const name = username.toLowerCase();
  if (name === "test" || name === "demo") return true;
  return url.searchParams.get("demo") === "1";
}

function getTheme(url) {
  const theme = (url.searchParams.get("theme") || "").toLowerCase();
  if (theme === "light") return "light";
  if (theme === "matrix") return "matrix";
  return "dark";
}

function getMockStats(username) {
  const now = new Date();
  const from = new Date(now);
  from.setFullYear(now.getFullYear() - 1);
  const createdAt = "2017-06-18T00:00:00Z";

  return {
    name: "Octavia Chen",
    login: username,
    avatarUrl: "https://avatars.githubusercontent.com/u/9919?s=128&v=4",
    createdAt,
    totalStars: 1480,
    totalRepos: 42,
    commits: 1327,
    prs: 96,
    reviews: 28,
    issues: 34,
    contributed: 18,
    followers: 512,
    totalContributions: 1638,
    joined: formatYearMonth(createdAt),
    periodLabel: `${from.getFullYear()}-${String(
      from.getMonth() + 1
    ).padStart(2, "0")} to ${now.getFullYear()}-${String(
      now.getMonth() + 1
    ).padStart(2, "0")}`,
  };
}

async function fetchUserStats(login, token) {
  const to = new Date();
  const from = new Date(to);
  from.setFullYear(to.getFullYear() - 1);

  let after = null;
  let totalStars = 0;
  let totalRepos = 0;
  let profile = null;
  let contributions = null;
  let followers = 0;

  while (true) {
    const payload = {
      query: `
        query($login: String!, $from: DateTime!, $to: DateTime!, $after: String) {
          user(login: $login) {
            name
            login
            avatarUrl(size: 128)
            createdAt
            followers { totalCount }
            contributionsCollection(from: $from, to: $to) {
              totalCommitContributions
              totalPullRequestContributions
              totalPullRequestReviewContributions
              totalIssueContributions
              totalRepositoryContributions
              contributionCalendar { totalContributions }
            }
            repositories(ownerAffiliations: OWNER, isFork: false, first: 100, after: $after) {
              nodes { stargazerCount }
              totalCount
              pageInfo { hasNextPage endCursor }
            }
          }
        }
      `,
      variables: {
        login,
        from: from.toISOString(),
        to: to.toISOString(),
        after,
      },
    };

    const response = await fetch("https://api.github.com/graphql", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `bearer ${token}`,
        "User-Agent": "githubcard-worker",
      },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`GitHub API error: ${response.status} ${text}`);
    }

    const data = await response.json();
    if (data.errors?.length) {
      throw new Error(data.errors[0].message || "GitHub API error");
    }

    const user = data.data.user;
    if (!user) {
      return null;
    }

    if (!profile) {
      profile = {
        name: user.name || user.login,
        login: user.login,
        avatarUrl: user.avatarUrl,
        createdAt: user.createdAt,
      };
      contributions = user.contributionsCollection;
      followers = user.followers?.totalCount ?? 0;
      totalRepos = user.repositories.totalCount;
    }

    for (const repo of user.repositories.nodes) {
      totalStars += repo.stargazerCount || 0;
    }

    if (!user.repositories.pageInfo.hasNextPage) {
      break;
    }

    after = user.repositories.pageInfo.endCursor;
  }

  const commits = contributions?.totalCommitContributions ?? 0;
  const prs = contributions?.totalPullRequestContributions ?? 0;
  const reviews = contributions?.totalPullRequestReviewContributions ?? 0;
  const issues = contributions?.totalIssueContributions ?? 0;
  const contributed = contributions?.totalRepositoryContributions ?? 0;
  const totalContributions =
    contributions?.contributionCalendar?.totalContributions ?? 0;

  return {
    ...profile,
    totalStars,
    totalRepos,
    commits,
    prs,
    reviews,
    issues,
    contributed,
    followers,
    totalContributions,
    joined: formatYearMonth(profile?.createdAt),
    periodLabel: `${from.getFullYear()}-${String(from.getMonth() + 1).padStart(
      2,
      "0"
    )} to ${to.getFullYear()}-${String(to.getMonth() + 1).padStart(2, "0")}`,
  };
}

function renderCardSvg(stats, theme) {
  const palette = getThemePalette(theme);
  const rank = calculateRank(stats, theme);
  const subtitle = `@${stats.login} - ${stats.totalRepos} repos`;
  const subtitle2 = `Last year: ${stats.periodLabel} - Joined ${stats.joined}`;
  const avatarHref = stats.avatarHref || "";
  const metrics = [
    { label: "Total Stars Earned", value: formatNumber(stats.totalStars) },
    {
      label: "Total Commits (last year)",
      value: formatNumber(stats.commits),
    },
    { label: "Total PRs", value: formatNumber(stats.prs) },
    { label: "Total Issues", value: formatNumber(stats.issues) },
    {
      label: "Contributed to (last year)",
      value: formatNumber(stats.contributed),
    },
  ];

  const metricBlocks = metrics
    .map((metric, index) => {
      const isLast = index === metrics.length - 1;
      const col = index % 2;
      const row = Math.floor(index / 2);
      const x = isLast ? 24 : col === 0 ? 24 : 336;
      const y = 146 + row * 54;
      const width = isLast ? 592 : 280;

      return `
        <g transform="translate(${x} ${y})">
          <rect width="${width}" height="44" rx="14" fill="${palette.metricFill}" stroke="${palette.metricStroke}" />
          <text class="label" x="16" y="18">${escapeXml(metric.label)}</text>
          <text class="value" x="16" y="34">${escapeXml(metric.value)}</text>
        </g>
      `;
    })
    .join("");

  const aria = `${stats.name} GitHub stats card. ${metrics
    .map((m) => `${m.label} ${m.value}`)
    .join(", ")}. Grade ${rank.level}.`;

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg width="${WIDTH}" height="${HEIGHT}" viewBox="0 0 ${WIDTH} ${HEIGHT}" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="${escapeXml(aria)}">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="${palette.bgStart}" />
      <stop offset="45%" stop-color="${palette.bgMid}" />
      <stop offset="100%" stop-color="${palette.bgEnd}" />
    </linearGradient>
    <radialGradient id="glow1" cx="0.2" cy="0.1" r="0.6">
      <stop offset="0%" stop-color="${palette.glow1}" stop-opacity="${palette.glow1Opacity}" />
      <stop offset="100%" stop-color="${palette.glow1}" stop-opacity="0" />
    </radialGradient>
    <radialGradient id="glow2" cx="0.9" cy="0.8" r="0.7">
      <stop offset="0%" stop-color="${palette.glow2}" stop-opacity="${palette.glow2Opacity}" />
      <stop offset="100%" stop-color="${palette.glow2}" stop-opacity="0" />
    </radialGradient>
    <linearGradient id="accent" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0%" stop-color="${palette.accentStart}" />
      <stop offset="100%" stop-color="${palette.accentEnd}" />
    </linearGradient>
    <linearGradient id="glass" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="${palette.glassFrom}" />
      <stop offset="100%" stop-color="${palette.glassTo}" />
    </linearGradient>
    <pattern id="grid" width="24" height="24" patternUnits="userSpaceOnUse">
      <path d="M 24 0 L 0 0 0 24" fill="none" stroke="${palette.gridStroke}" stroke-width="1" />
    </pattern>
    <clipPath id="avatarClip">
      <circle cx="60" cy="64" r="36" />
    </clipPath>
    <symbol id="githubIcon" viewBox="0 0 496 512">
      <path fill="currentColor" d="M165.9 397.4c0 2-2.3 3.5-5.2 3.5-3.3.3-5.6-1.3-5.6-3.5 0-2 2.3-3.5 5.2-3.5 3.3-.3 5.6 1.3 5.6 3.5zm-31.1-4.5c-.7 2 1.3 4.3 4.3 4.9 2.6.7 5.6-.3 6.2-2.3.7-2-1.3-4.3-4.3-5.2-2.6-.6-5.6.4-6.2 2.6zm44.2-1.7c-2.9.7-4.9 3-4.6 5.3.3 2.3 2.9 3.6 5.9 3 2.9-.7 4.9-3 4.6-5.3-.3-2.3-3-3.6-5.9-3zm73.5 6.3c-1 2.3 1.3 5.2 4.9 6.5 3.6 1.3 7.5.3 8.5-2 1-2.3-1.3-5.2-4.9-6.5-3.6-1.3-7.5-.3-8.5 2zm-36-7c-3.3.7-5.6 3.6-5.2 6.2.3 2.6 3.3 4.3 6.6 3.6 3.3-.7 5.6-3.6 5.2-6.2-.3-2.6-3.2-4.3-6.6-3.6zM248 8C111 8 0 119 0 256c0 110.2 71.4 203.8 170.7 236.9 12.5 2.3 17.1-5.4 17.1-12 0-6-0.2-21.7-0.3-42.7-69.5 15.1-84.1-33.5-84.1-33.5-11.4-29-27.9-36.7-27.9-36.7-22.8-15.6 1.7-15.3 1.7-15.3 25.2 1.8 38.5 25.8 38.5 25.8 22.4 38.4 58.8 27.3 73.1 20.9 2.3-16.2 8.8-27.3 16-33.6-55.5-6.3-113.8-27.8-113.8-123.6 0-27.3 9.8-49.6 25.8-67.1-2.6-6.3-11.2-31.8 2.4-66.1 0 0 21-6.7 68.8 25.6 20-5.6 41.5-8.4 62.8-8.5 21.3.1 42.8 2.9 62.8 8.5 47.8-32.3 68.8-25.6 68.8-25.6 13.6 34.3 5 59.8 2.4 66.1 16 17.5 25.8 39.8 25.8 67.1 0 96.1-58.4 117.2-114 123.4 9 7.8 17.1 23.1 17.1 46.6 0 33.6-.3 60.7-.3 69 0 6.6 4.5 14.4 17.2 12C424.6 459.8 496 366.2 496 256 496 119 385 8 248 8z" />
    </symbol>
    <filter id="softGlow" x="-20%" y="-20%" width="140%" height="140%">
      <feGaussianBlur stdDeviation="10" result="blur" />
      <feColorMatrix type="matrix" values="0 0 0 0 0.1  0 0 0 0 0.6  0 0 0 0 1  0 0 0 0.4 0" />
      <feBlend in="SourceGraphic" in2="blur" mode="screen" />
    </filter>
    <filter id="cardShadow" x="-20%" y="-20%" width="140%" height="140%">
      <feDropShadow dx="0" dy="12" stdDeviation="16" flood-color="${palette.shadowColor}" flood-opacity="${palette.shadowOpacity}" />
    </filter>
    <style>
      .title { font: 600 22px 'Space Grotesk', 'Segoe UI', sans-serif; fill: ${palette.textPrimary}; letter-spacing: 0.2px; }
      .subtitle { font: 400 12.5px 'Space Grotesk', 'Segoe UI', sans-serif; fill: ${palette.textSecondary}; }
      .label { font: 500 10.5px 'Space Grotesk', 'Segoe UI', sans-serif; fill: ${palette.label}; letter-spacing: 0.6px; text-transform: uppercase; }
      .value { font: 600 16px 'Space Grotesk', 'Segoe UI', sans-serif; fill: ${palette.value}; }
      .grade { font: 700 22px 'Space Grotesk', 'Segoe UI', sans-serif; fill: ${palette.gradeText}; }
      .score { font: 500 11px 'Space Grotesk', 'Segoe UI', sans-serif; fill: ${palette.scoreText}; text-transform: uppercase; letter-spacing: 0.9px; }
    </style>
  </defs>

  <rect width="${WIDTH}" height="${HEIGHT}" rx="28" fill="url(#bg)" />
  <rect width="${WIDTH}" height="${HEIGHT}" rx="28" fill="url(#grid)" opacity="0.5" />
  <rect width="${WIDTH}" height="${HEIGHT}" rx="28" fill="url(#glow1)" />
  <rect width="${WIDTH}" height="${HEIGHT}" rx="28" fill="url(#glow2)" />
  <rect x="18" y="18" width="${WIDTH - 36}" height="${HEIGHT - 36}" rx="22" fill="url(#glass)" stroke="${palette.glassStroke}" filter="url(#cardShadow)" />

  <circle cx="528" cy="70" r="78" fill="url(#accent)" opacity="0.18" filter="url(#softGlow)" />
  <circle cx="560" cy="260" r="96" fill="${palette.accentOrb}" opacity="${palette.accentOrbOpacity}" />

  <g>
    <circle cx="60" cy="64" r="36" fill="${palette.avatarBg}" stroke="${palette.avatarStroke}" />
    <use href="#githubIcon" x="38" y="42" width="44" height="44" style="color:${palette.iconColor}" opacity="${palette.iconOpacity}" />
    ${avatarHref ? `<image href="${escapeXml(avatarHref)}" x="24" y="28" width="72" height="72" clip-path="url(#avatarClip)" />` : ""}
    <text class="title" x="112" y="56">${escapeXml(stats.name)}</text>
    <text class="subtitle" x="112" y="78">${escapeXml(subtitle)}</text>
    <text class="subtitle" x="112" y="96">${escapeXml(subtitle2)}</text>
  </g>

  <g transform="translate(468 36)">
    <rect width="148" height="72" rx="18" fill="${rank.color}" />
    <text class="grade" x="18" y="40">${rank.level}</text>
    <text class="score" x="18" y="58">Percentile ${rank.percentile}</text>
  </g>

  ${metricBlocks}
</svg>`;
}

function renderInfoSvg(theme) {
  const palette = getThemePalette(theme);
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg width="${WIDTH}" height="${HEIGHT}" viewBox="0 0 ${WIDTH} ${HEIGHT}" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="GitHub card usage">
  <rect width="${WIDTH}" height="${HEIGHT}" rx="28" fill="${palette.infoBg}" />
  <text x="32" y="70" font-family="'Space Grotesk', 'Segoe UI', sans-serif" font-size="22" fill="${palette.textPrimary}">GitHubCard Worker</text>
  <text x="32" y="110" font-family="'Space Grotesk', 'Segoe UI', sans-serif" font-size="14" fill="${palette.textSecondary}">Usage: https://your-domain.com/username</text>
  <text x="32" y="140" font-family="'Space Grotesk', 'Segoe UI', sans-serif" font-size="14" fill="${palette.textSecondary}">Set GITHUB_TOKEN to enable GitHub API access.</text>
</svg>`;
}

function renderErrorSvg(message, theme) {
  const palette = getThemePalette(theme);
  const safe = escapeXml(message);
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg width="${WIDTH}" height="${HEIGHT}" viewBox="0 0 ${WIDTH} ${HEIGHT}" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="GitHub card error">
  <rect width="${WIDTH}" height="${HEIGHT}" rx="28" fill="${palette.infoBg}" />
  <text x="32" y="70" font-family="'Space Grotesk', 'Segoe UI', sans-serif" font-size="20" fill="${palette.textPrimary}">GitHubCard Error</text>
  <text x="32" y="110" font-family="'Space Grotesk', 'Segoe UI', sans-serif" font-size="14" fill="${palette.errorText}">${safe}</text>
</svg>`;
}

function svgResponse(svg, status = 200) {
  return new Response(svg, {
    status,
    headers: {
      "Content-Type": "image/svg+xml; charset=utf-8",
    },
  });
}

function shouldInlineAvatar(url) {
  const mode = url.searchParams.get("avatar");
  if (!mode) return true;
  return mode !== "external";
}

async function resolveAvatarHref(url, inline) {
  if (!url) return "";
  if (!inline) return url;

  try {
    const response = await fetch(url);
    if (!response.ok) {
      return "";
    }
    const contentType = response.headers.get("content-type") || "image/png";
    if (!contentType.startsWith("image/")) {
      return "";
    }
    const buffer = await response.arrayBuffer();
    const base64 = arrayBufferToBase64(buffer);
    return `data:${contentType};base64,${base64}`;
  } catch {
    return "";
  }
}

function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

function getThemePalette(theme) {
  if (theme === "light") {
    return {
      bgStart: "#f8fafc",
      bgMid: "#eef2ff",
      bgEnd: "#e2e8f0",
      glow1: "#60a5fa",
      glow1Opacity: "0.3",
      glow2: "#f59e0b",
      glow2Opacity: "0.22",
      accentStart: "#2563eb",
      accentEnd: "#0ea5e9",
      glassFrom: "rgba(255,255,255,0.95)",
      glassTo: "rgba(255,255,255,0.7)",
      gridStroke: "rgba(100,116,139,0.25)",
      glassStroke: "rgba(15,23,42,0.12)",
      shadowColor: "#94a3b8",
      shadowOpacity: "0.4",
      textPrimary: "#0f172a",
      textSecondary: "#475569",
      label: "#334155",
      value: "#0f172a",
      gradeText: "#0f172a",
      scoreText: "#0f172a",
      accentOrb: "#38bdf8",
      accentOrbOpacity: "0.12",
      avatarBg: "rgba(226,232,240,0.9)",
      avatarStroke: "rgba(100,116,139,0.35)",
      iconColor: "#64748b",
      iconOpacity: "0.9",
      metricFill: "rgba(255,255,255,0.85)",
      metricStroke: "rgba(15,23,42,0.08)",
      infoBg: "#f8fafc",
      errorText: "#b91c1c",
    };
  }

  if (theme === "matrix") {
    return {
      bgStart: "#020a05",
      bgMid: "#04130a",
      bgEnd: "#031008",
      glow1: "#00ff9d",
      glow1Opacity: "0.45",
      glow2: "#34d399",
      glow2Opacity: "0.28",
      accentStart: "#22c55e",
      accentEnd: "#16a34a",
      glassFrom: "rgba(6, 28, 12, 0.7)",
      glassTo: "rgba(3, 16, 8, 0.35)",
      gridStroke: "rgba(34, 197, 94, 0.22)",
      glassStroke: "rgba(34, 197, 94, 0.25)",
      shadowColor: "#021008",
      shadowOpacity: "0.7",
      textPrimary: "#b7ffd9",
      textSecondary: "#6ee7b7",
      label: "#86efac",
      value: "#d1fae5",
      gradeText: "#052914",
      scoreText: "#052914",
      accentOrb: "#00ff9d",
      accentOrbOpacity: "0.18",
      avatarBg: "rgba(3, 18, 8, 0.8)",
      avatarStroke: "rgba(34, 197, 94, 0.35)",
      iconColor: "#86efac",
      iconOpacity: "0.9",
      metricFill: "rgba(3, 18, 8, 0.65)",
      metricStroke: "rgba(34, 197, 94, 0.25)",
      infoBg: "#020a05",
      errorText: "#f87171",
    };
  }

  return {
    bgStart: "#0b1020",
    bgMid: "#111827",
    bgEnd: "#1a2338",
    glow1: "#22d3ee",
    glow1Opacity: "0.35",
    glow2: "#f97316",
    glow2Opacity: "0.25",
    accentStart: "#38bdf8",
    accentEnd: "#a855f7",
    glassFrom: "rgba(255,255,255,0.18)",
    glassTo: "rgba(255,255,255,0.04)",
    gridStroke: "rgba(148,163,184,0.08)",
    glassStroke: "rgba(148,163,184,0.2)",
    shadowColor: "#0b1020",
    shadowOpacity: "0.55",
    textPrimary: "#f8fafc",
    textSecondary: "#94a3b8",
    label: "#b6c2e2",
    value: "#f1f5f9",
    gradeText: "#0b1020",
    scoreText: "#0b1020",
    accentOrb: "#60a5fa",
    accentOrbOpacity: "0.08",
    avatarBg: "rgba(15,23,42,0.65)",
    avatarStroke: "rgba(148,163,184,0.25)",
    iconColor: "#94a3b8",
    iconOpacity: "0.85",
    metricFill: "rgba(15,23,42,0.55)",
    metricStroke: "rgba(148,163,184,0.18)",
    infoBg: "#0f172a",
    errorText: "#fca5a5",
  };
}

function exponentialCdf(x) {
  return 1 - 2 ** -x;
}

function logNormalCdf(x) {
  return x / (1 + x);
}

function calculateRank(stats, theme) {
  const COMMITS_MEDIAN = 250;
  const COMMITS_WEIGHT = 2;
  const PRS_MEDIAN = 50;
  const PRS_WEIGHT = 3;
  const ISSUES_MEDIAN = 25;
  const ISSUES_WEIGHT = 1;
  const REVIEWS_MEDIAN = 2;
  const REVIEWS_WEIGHT = 1;
  const STARS_MEDIAN = 50;
  const STARS_WEIGHT = 4;
  const FOLLOWERS_MEDIAN = 10;
  const FOLLOWERS_WEIGHT = 1;

  const TOTAL_WEIGHT =
    COMMITS_WEIGHT +
    PRS_WEIGHT +
    ISSUES_WEIGHT +
    REVIEWS_WEIGHT +
    STARS_WEIGHT +
    FOLLOWERS_WEIGHT;

  const THRESHOLDS = [1, 12.5, 25, 37.5, 50, 62.5, 75, 87.5, 100];
  const LEVELS = ["S", "A+", "A", "A-", "B+", "B", "B-", "C+", "C"];

  const rank =
    1 -
    (COMMITS_WEIGHT * exponentialCdf(stats.commits / COMMITS_MEDIAN) +
      PRS_WEIGHT * exponentialCdf(stats.prs / PRS_MEDIAN) +
      ISSUES_WEIGHT * exponentialCdf(stats.issues / ISSUES_MEDIAN) +
      REVIEWS_WEIGHT * exponentialCdf(stats.reviews / REVIEWS_MEDIAN) +
      STARS_WEIGHT * logNormalCdf(stats.totalStars / STARS_MEDIAN) +
      FOLLOWERS_WEIGHT *
        logNormalCdf(stats.followers / FOLLOWERS_MEDIAN)) /
      TOTAL_WEIGHT;

  const percentile = rank * 100;
  const level = LEVELS[THRESHOLDS.findIndex((t) => percentile <= t)];

  return {
    level,
    percentile: percentile.toFixed(1),
    color: getRankColor(level, theme),
  };
}

function getRankColor(level, theme) {
  if (theme === "light") {
    const lightColors = {
      S: "#f59e0b",
      "A+": "#38bdf8",
      A: "#60a5fa",
      "A-": "#34d399",
      "B+": "#22c55e",
      B: "#4ade80",
      "B-": "#facc15",
      "C+": "#fb7185",
      C: "#e2e8f0",
      default: "#e2e8f0",
    };
    return lightColors[level] || lightColors.default;
  }

  if (theme === "matrix") {
    const matrixColors = {
      S: "#00ff9d",
      "A+": "#4ade80",
      A: "#22c55e",
      "A-": "#16a34a",
      "B+": "#10b981",
      B: "#34d399",
      "B-": "#86efac",
      "C+": "#a7f3d0",
      C: "#d1fae5",
      default: "#a7f3d0",
    };
    return matrixColors[level] || matrixColors.default;
  }

  const darkColors = {
    S: "#fde68a",
    "A+": "#bae6fd",
    A: "#93c5fd",
    "A-": "#a7f3d0",
    "B+": "#86efac",
    B: "#bbf7d0",
    "B-": "#fef08a",
    "C+": "#fecaca",
    C: "#e2e8f0",
    default: "#e2e8f0",
  };

  return darkColors[level] || darkColors.default;
}

function formatNumber(value) {
  return new Intl.NumberFormat("en-US").format(value || 0);
}

function formatYearMonth(value) {
  if (!value) return "N/A";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "N/A";
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
}

function escapeXml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
