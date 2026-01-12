const WIDTH = 640;
const HEIGHT = 320;
const CACHE_TTL_SECONDS = 60 * 60;

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const username = url.pathname.replace(/^\/+|\/+$/g, "");

    if (!username) {
      return svgResponse(renderInfoSvg());
    }

    if (isDemoRequest(username, url)) {
      const svg = renderCardSvg(getMockStats(username));
      return svgResponse(svg);
    }

    const cacheKey = new Request(url.toString(), request);
    const cache = caches.default;
    const cached = await cache.match(cacheKey);
    if (cached) {
      return cached;
    }

    const token = env.GITHUB_TOKEN;
    if (!token) {
      return svgResponse(
        renderErrorSvg(
          "Missing GITHUB_TOKEN. Use /test to preview or add a GitHub token."
        ),
        500
      );
    }

    try {
      const stats = await fetchUserStats(username, token);
      if (!stats) {
        return svgResponse(renderErrorSvg("GitHub user not found."), 404);
      }
      const svg = renderCardSvg(stats);
      const response = svgResponse(svg);
      response.headers.set(
        "Cache-Control",
        `public, max-age=${CACHE_TTL_SECONDS}`
      );
      ctx.waitUntil(cache.put(cacheKey, response.clone()));
      return response;
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      return svgResponse(renderErrorSvg(message), 500);
    }
  },
};

function isDemoRequest(username, url) {
  const name = username.toLowerCase();
  if (name === "test" || name === "demo") return true;
  return url.searchParams.get("demo") === "1";
}

function getMockStats(username) {
  const now = new Date();
  const from = new Date(now);
  from.setFullYear(now.getFullYear() - 1);
  const createdAt = "2017-06-18T00:00:00Z";

  return {
    name: "Octavia Chen",
    login: username,
    avatarUrl:
      "https://avatars.githubusercontent.com/u/9919?s=128&v=4",
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
  const reviews =
    contributions?.totalPullRequestReviewContributions ?? 0;
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
    periodLabel: `${from.getFullYear()}-${String(from.getMonth() + 1).padStart(2, "0")} to ${to.getFullYear()}-${String(to.getMonth() + 1).padStart(2, "0")}`,
  };
}

function renderCardSvg(stats) {
  const rank = calculateRank(stats);
  const subtitle = `@${stats.login} · ${stats.totalRepos} repos`;
  const subtitle2 = `Last year: ${stats.periodLabel} · Joined ${stats.joined}`;
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
          <rect width="${width}" height="44" rx="14" fill="rgba(255,255,255,0.08)" />
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
      <stop offset="0%" stop-color="#0f172a" />
      <stop offset="100%" stop-color="#1f2937" />
    </linearGradient>
    <linearGradient id="accent" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0%" stop-color="#38bdf8" />
      <stop offset="100%" stop-color="#f59e0b" />
    </linearGradient>
    <clipPath id="avatarClip">
      <circle cx="60" cy="64" r="36" />
    </clipPath>
    <filter id="softGlow" x="-20%" y="-20%" width="140%" height="140%">
      <feGaussianBlur stdDeviation="8" result="blur" />
      <feColorMatrix type="matrix" values="0 0 0 0 0.4  0 0 0 0 0.7  0 0 0 0 1  0 0 0 0.3 0" />
      <feBlend in="SourceGraphic" in2="blur" mode="screen" />
    </filter>
    <style>
      .title { font: 600 22px 'Space Grotesk', 'Segoe UI', sans-serif; fill: #f8fafc; }
      .subtitle { font: 400 13px 'Space Grotesk', 'Segoe UI', sans-serif; fill: #94a3b8; }
      .label { font: 500 11px 'Space Grotesk', 'Segoe UI', sans-serif; fill: #cbd5f5; letter-spacing: 0.4px; text-transform: uppercase; }
      .value { font: 600 16px 'Space Grotesk', 'Segoe UI', sans-serif; fill: #f1f5f9; }
      .grade { font: 700 22px 'Space Grotesk', 'Segoe UI', sans-serif; fill: #0f172a; }
      .score { font: 500 11px 'Space Grotesk', 'Segoe UI', sans-serif; fill: #0f172a; text-transform: uppercase; letter-spacing: 1px; }
    </style>
  </defs>

  <rect width="${WIDTH}" height="${HEIGHT}" rx="28" fill="url(#bg)" />
  <rect x="18" y="18" width="${WIDTH - 36}" height="${HEIGHT - 36}" rx="22" fill="rgba(15,23,42,0.45)" stroke="rgba(148,163,184,0.15)" />

  <circle cx="540" cy="80" r="70" fill="url(#accent)" opacity="0.14" filter="url(#softGlow)" />
  <circle cx="560" cy="260" r="90" fill="#f97316" opacity="0.08" />

  <g>
    <image href="${escapeXml(stats.avatarUrl)}" x="24" y="28" width="72" height="72" clip-path="url(#avatarClip)" />
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

function renderInfoSvg() {
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg width="${WIDTH}" height="${HEIGHT}" viewBox="0 0 ${WIDTH} ${HEIGHT}" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="GitHub card usage">
  <rect width="${WIDTH}" height="${HEIGHT}" rx="28" fill="#0f172a" />
  <text x="32" y="70" font-family="'Space Grotesk', 'Segoe UI', sans-serif" font-size="22" fill="#f8fafc">GitHubCard Worker</text>
  <text x="32" y="110" font-family="'Space Grotesk', 'Segoe UI', sans-serif" font-size="14" fill="#94a3b8">Usage: https://your-domain.com/username</text>
  <text x="32" y="140" font-family="'Space Grotesk', 'Segoe UI', sans-serif" font-size="14" fill="#94a3b8">Set GITHUB_TOKEN to enable GitHub API access.</text>
</svg>`;
}

function renderErrorSvg(message) {
  const safe = escapeXml(message);
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg width="${WIDTH}" height="${HEIGHT}" viewBox="0 0 ${WIDTH} ${HEIGHT}" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="GitHub card error">
  <rect width="${WIDTH}" height="${HEIGHT}" rx="28" fill="#0f172a" />
  <text x="32" y="70" font-family="'Space Grotesk', 'Segoe UI', sans-serif" font-size="20" fill="#f8fafc">GitHubCard Error</text>
  <text x="32" y="110" font-family="'Space Grotesk', 'Segoe UI', sans-serif" font-size="14" fill="#fca5a5">${safe}</text>
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

function exponentialCdf(x) {
  return 1 - 2 ** -x;
}

function logNormalCdf(x) {
  return x / (1 + x);
}

function calculateRank(stats) {
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
    color: getRankColor(level),
  };
}

function getRankColor(level) {
  switch (level) {
    case "S":
      return "#fde68a";
    case "A+":
      return "#bae6fd";
    case "A":
      return "#93c5fd";
    case "A-":
      return "#a7f3d0";
    case "B+":
      return "#86efac";
    case "B":
      return "#bbf7d0";
    case "B-":
      return "#fef08a";
    case "C+":
      return "#fecaca";
    default:
      return "#e2e8f0";
  }
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
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
