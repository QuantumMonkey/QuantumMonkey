// Self-hosted profile stats — zero third-party services.
// Fetches public GitHub data + your contribution calendar, renders a static SVG
// that gets committed into this repo and served by GitHub itself.
// Run by .github/workflows/profile-stats.yml on a weekly cron.

import { writeFileSync, mkdirSync } from "node:fs";

const USER = process.env.GH_USER || "QuantumMonkey";
const TOKEN = process.env.GITHUB_TOKEN;
if (!TOKEN) {
  console.error("GITHUB_TOKEN missing");
  process.exit(1);
}

const H = {
  "User-Agent": "profile-stats",
  Authorization: `Bearer ${TOKEN}`,
  Accept: "application/vnd.github+json",
};

async function rest(path) {
  const r = await fetch(`https://api.github.com${path}`, { headers: H });
  if (!r.ok) throw new Error(`REST ${path} -> ${r.status}`);
  return r.json();
}

async function graphql(query, variables) {
  const r = await fetch("https://api.github.com/graphql", {
    method: "POST",
    headers: H,
    body: JSON.stringify({ query, variables }),
  });
  const j = await r.json();
  if (j.errors) throw new Error(JSON.stringify(j.errors));
  return j.data;
}

// GitHub Linguist colors for the languages we expect.
const LANG_COLOR = {
  "Jupyter Notebook": "#DA5B0B",
  TypeScript: "#3178C6",
  JavaScript: "#F1E05A",
  Python: "#3572A5",
  HTML: "#E34C26",
  CSS: "#563D7C",
  Java: "#B07219",
  Other: "#8B949E",
};

function esc(s) {
  return String(s).replace(/[<>&]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" }[c]));
}

async function main() {
  const user = await rest(`/users/${USER}`);

  // All repos (paginate).
  let repos = [];
  for (let page = 1; ; page++) {
    const batch = await rest(`/users/${USER}/repos?per_page=100&page=${page}`);
    repos = repos.concat(batch);
    if (batch.length < 100) break;
  }
  const original = repos.filter((r) => !r.fork);

  // Language mix weighted by REPO COUNT, not bytes. Byte-weighting lets Jupyter
  // notebooks (which embed their image/output bytes) swamp everything and bury
  // the real story — repo-count is the honest "what do they actually build" signal.
  const langCount = {};
  for (const r of original) {
    if (!r.language) continue;
    langCount[r.language] = (langCount[r.language] || 0) + 1;
  }
  const totalBytes = Object.values(langCount).reduce((a, b) => a + b, 0) || 1;
  let langs = Object.entries(langCount)
    .sort((a, b) => b[1] - a[1])
    .map(([name, count]) => ({ name, pct: (count / totalBytes) * 100 }));
  // Fold the long tail into "Other".
  const top = langs.slice(0, 5);
  const otherPct = langs.slice(5).reduce((a, l) => a + l.pct, 0);
  if (otherPct > 0) top.push({ name: "Other", pct: otherPct });
  langs = top;

  // Contribution calendar (last 12 months) via GraphQL.
  const data = await graphql(
    `query($login:String!){ user(login:$login){ contributionsCollection{ contributionCalendar{ totalContributions weeks{ contributionDays{ date contributionCount } } } } } }`,
    { login: USER }
  );
  const days = data.user.contributionsCollection.contributionCalendar.weeks
    .flatMap((w) => w.contributionDays)
    .sort((a, b) => a.date.localeCompare(b.date));
  const totalContrib = data.user.contributionsCollection.contributionCalendar.totalContributions;
  // Current streak: consecutive days with activity ending at the most recent active day.
  let streak = 0;
  for (let i = days.length - 1; i >= 0; i--) {
    if (days[i].contributionCount > 0) streak++;
    else if (streak > 0 || i < days.length - 1) break;
  }

  const years = Math.max(1, new Date().getFullYear() - new Date(user.created_at).getFullYear());
  const stats = [
    { label: "years on GitHub", value: years },
    { label: "original repos", value: original.length },
    { label: "followers", value: user.followers },
    { label: "contributions / yr", value: totalContrib },
  ];

  // ---- render SVG ----
  const W = 880, P = 26;
  const barW = W - P * 2;
  let x = P;
  const segs = langs
    .map((l) => {
      const w = (l.pct / 100) * barW;
      const rect = `<rect x="${x.toFixed(1)}" y="128" width="${w.toFixed(1)}" height="10" fill="${LANG_COLOR[l.name] || LANG_COLOR.Other}"/>`;
      x += w;
      return rect;
    })
    .join("");
  const legend = langs
    .map((l, i) => {
      const lx = P + (i % 3) * (barW / 3);
      const ly = 158 + Math.floor(i / 3) * 18;
      const c = LANG_COLOR[l.name] || LANG_COLOR.Other;
      return `<circle cx="${lx + 4}" cy="${ly - 4}" r="4" fill="${c}"/><text x="${lx + 14}" y="${ly}" class="lg">${esc(l.name)} ${l.pct.toFixed(0)}%</text>`;
    })
    .join("");
  const tiles = stats
    .map((s, i) => {
      const tx = P + i * ((barW) / 4);
      return `<text x="${tx}" y="70" class="num">${s.value}</text><text x="${tx}" y="88" class="cap">${esc(s.label)}</text>`;
    })
    .join("");
  const rows = Math.ceil(langs.length / 3);
  const H_ = 150 + 18 * rows + 24;
  const updated = new Date().toISOString().slice(0, 10);

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H_}" viewBox="0 0 ${W} ${H_}" role="img" aria-label="GitHub stats for ${esc(USER)}">
<style>
  .bg{fill:#0d1117;stroke:#30363d;stroke-width:1}
  .title{fill:#e6edf3;font:600 16px 'Segoe UI',Ubuntu,sans-serif}
  .sub{fill:#7d8590;font:400 11px 'Segoe UI',Ubuntu,sans-serif}
  .num{fill:#58a6ff;font:600 22px 'Segoe UI',Ubuntu,sans-serif}
  .cap{fill:#7d8590;font:400 10px 'Segoe UI',Ubuntu,sans-serif}
  .lbl{fill:#e6edf3;font:400 11px 'Segoe UI',Ubuntu,sans-serif}
  .lg{fill:#c9d1d9;font:400 11px 'Segoe UI',Ubuntu,sans-serif}
</style>
<rect class="bg" x="0.5" y="0.5" width="${W - 1}" height="${H_ - 1}" rx="10"/>
<text x="${P}" y="34" class="title">${esc(user.name || USER)} &#183; @${esc(USER)}</text>
<text x="${P}" y="50" class="sub">building privacy-first, on-device apps &#183; ex ML / AI</text>
${tiles}
<text x="${P}" y="118" class="lbl">language journey &#183; ML &#8594; on-device</text>
${segs}
${legend}
<text x="${W - P}" y="${H_ - 12}" text-anchor="end" class="sub">updated ${updated} &#183; current streak ${streak}d</text>
</svg>`;

  mkdirSync("assets", { recursive: true });
  writeFileSync("assets/stats.svg", svg);
  console.log(`Wrote assets/stats.svg (${langs.length} langs, ${totalContrib} contrib, ${streak}d streak)`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
