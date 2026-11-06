#!/usr/bin/env node
// Rendu du README de profil : profile.json + données GitHub → template.html → PNG par bloc.
//
//   node render.mjs            rend les PNG dans profile/out/
//   node render.mjs --readme   rend les PNG puis réécrit ../README.md
//
// Variables d'environnement (toutes optionnelles) :
//   PROFILE_TOKEN / GITHUB_TOKEN  jeton pour l'API GraphQL (PROFILE_TOKEN prioritaire)
//   GITFUT_FILE                   PNG GitFut local (sinon téléchargé depuis la branche gitfut)
//   CONTRIBUTIONS_FILE            réponse GraphQL en JSON, pour travailler hors ligne
//   CHROMIUM_PATH                 binaire Chromium à utiliser à la place de celui de Playwright
//   OUT_DIR                       dossier de sortie (défaut : profile/out)

import { readFile, writeFile, mkdir, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
import { chromium } from "playwright";
import sharp from "sharp";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.resolve(process.env.OUT_DIR || path.join(HERE, "out"));
const REPO = "FireDroX/FireDroX";
const BRANCH = "output";
const RAW = `https://raw.githubusercontent.com/${REPO}/${BRANCH}`;
const MARGIN = 12; // marge --void uniforme autour de chaque bloc capturé (px CSS)
const MAX_BYTES = 300 * 1024;

const warnings = [];
function warn(msg) {
  warnings.push(msg);
  console.log(`::warning::${msg}`);
}

async function fetchWithTimeout(url, opts = {}, ms = 20000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    const res = await fetch(url, { ...opts, signal: ctrl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res;
  } finally {
    clearTimeout(t);
  }
}

// ---------------------------------------------------------------- données

function buildStamp() {
  // en-CA formate en AAAA-MM-JJ
  const d = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Paris", year: "numeric", month: "2-digit", day: "2-digit",
  }).format(new Date());
  return d.replaceAll("-", ".");
}

const LEVELS = { NONE: 0, FIRST_QUARTILE: 1, SECOND_QUARTILE: 2, THIRD_QUARTILE: 3, FOURTH_QUARTILE: 4 };

async function getContributions(login) {
  try {
    let json;
    if (process.env.CONTRIBUTIONS_FILE) {
      json = JSON.parse(await readFile(process.env.CONTRIBUTIONS_FILE, "utf8"));
    } else {
      const token = process.env.PROFILE_TOKEN || process.env.GITHUB_TOKEN;
      if (!token) throw new Error("aucun jeton (PROFILE_TOKEN ou GITHUB_TOKEN)");
      const query = `query($login: String!) { user(login: $login) { contributionsCollection { contributionCalendar {
        totalContributions weeks { contributionDays { date weekday contributionCount contributionLevel color } } } } } }`;
      const res = await fetchWithTimeout("https://api.github.com/graphql", {
        method: "POST",
        headers: { Authorization: `bearer ${token}`, "Content-Type": "application/json", "User-Agent": "firedrox-profile-render" },
        body: JSON.stringify({ query, variables: { login } }),
      });
      json = await res.json();
      if (json.errors) throw new Error(json.errors.map((e) => e.message).join("; "));
    }
    const cal = json.data.user.contributionsCollection.contributionCalendar;
    const weeks = cal.weeks.map((w) => ({
      days: w.contributionDays.map((d) => ({
        date: d.date,
        weekday: d.weekday ?? new Date(`${d.date}T00:00:00Z`).getUTCDay(),
        count: d.contributionCount,
        level: LEVELS[d.contributionLevel] ?? 0,
      })),
    }));
    if (!weeks.length) throw new Error("calendrier vide");
    console.log(`contributions : ${cal.totalContributions} sur ${weeks.length} semaines`);
    return { total: cal.totalContributions, weeks };
  } catch (e) {
    warn(`Contributions indisponibles (${e.message}) : grille d'exemple de la maquette utilisée.`);
    return null;
  }
}

async function getGitfut(login) {
  try {
    let buf;
    if (process.env.GITFUT_FILE) {
      buf = await readFile(process.env.GITFUT_FILE);
    } else {
      const url = `https://raw.githubusercontent.com/${REPO}/gitfut/${login}.png`;
      buf = Buffer.from(await (await fetchWithTimeout(url)).arrayBuffer());
    }
    // l'emplacement fait ~190 px de large : on réduit à 2× (Retina) pour alléger la capture
    const png = await sharp(buf).resize({ height: 560, withoutEnlargement: true }).png({ compressionLevel: 9 }).toBuffer();
    console.log(`gitfut : ${Math.round(buf.length / 1024)} Ko → ${Math.round(png.length / 1024)} Ko`);
    return `data:image/png;base64,${png.toString("base64")}`;
  } catch (e) {
    warn(`Carte GitFut indisponible (${e.message}) : placeholder « FD » utilisé.`);
    return null;
  }
}

// noms skillicons.dev → fichiers du dépôt source de skillicons (secours si le site ne répond pas)
const ICON_FALLBACK = {
  react: "React-Dark", js: "JavaScript", ts: "TypeScript", html: "HTML", css: "CSS",
  nodejs: "NodeJS-Dark", nestjs: "NestJS-Dark", express: "ExpressJS-Dark", php: "PHP-Dark",
  mysql: "MySQL-Dark", postgres: "PostgreSQL-Dark", c: "C", docker: "Docker", git: "Git", github: "Github-Dark",
};

async function getIcons(profile) {
  const names = [...new Set(profile.stack.groups.flatMap((g) => g.items.map((i) => i.icon)).filter(Boolean))];
  const icons = {};
  await Promise.all(names.map(async (name) => {
    const urls = [`https://skillicons.dev/icons?i=${encodeURIComponent(name)}&theme=dark`];
    if (ICON_FALLBACK[name]) urls.push(`https://raw.githubusercontent.com/tandpfun/skill-icons/main/icons/${ICON_FALLBACK[name]}.svg`);
    for (const url of urls) {
      try {
        const svg = await (await fetchWithTimeout(url, {}, 10000)).text();
        if (!svg.includes("<svg")) throw new Error("réponse non SVG");
        icons[name] = `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;
        return;
      } catch { /* source suivante */ }
    }
    warn(`Logo « ${name} » indisponible : puce sans logo.`);
  }));
  return icons;
}

// ---------------------------------------------------------------- rendu

function inject(template, profile, data) {
  // JSON dans un <script> : on neutralise « < » pour qu'aucun texte ne puisse fermer la balise
  const safe = (v) => JSON.stringify(v).replace(/</g, "\\u003c");
  const tag = `<script>window.__PROFILE__ = ${safe(profile)};\nwindow.__DATA__ = ${safe(data)};</script>`;
  if (!template.includes("<!--INJECT-->")) throw new Error("marqueur <!--INJECT--> absent de template.html");
  return template.replace("<!--INJECT-->", () => tag);
}

async function compress(buf) {
  let out = await sharp(buf).png({ compressionLevel: 9, adaptiveFiltering: true }).toBuffer();
  if (out.length > MAX_BYTES) {
    // quantification en palette : invisible sur ce design (aplats + dégradés courts)
    out = await sharp(buf).png({ compressionLevel: 9, palette: true, quality: 95, effort: 10, dither: 0.6 }).toBuffer();
  }
  return out;
}

async function capture(page, selector, file) {
  const box = await page.locator(selector).boundingBox();
  if (!box) throw new Error(`bloc introuvable : ${selector}`);
  const clip = {
    x: Math.floor(box.x - MARGIN), y: Math.floor(box.y - MARGIN),
    width: Math.ceil(box.width + 2 * MARGIN), height: Math.ceil(box.height + 2 * MARGIN),
  };
  const raw = await page.screenshot({ clip, animations: "disabled" });
  const png = await compress(raw);
  await writeFile(path.join(OUT, file), png);
  const kb = Math.round(png.length / 1024);
  console.log(`  ${file.padEnd(28)} ${clip.width}×${clip.height}  ${kb} Ko`);
  if (png.length > MAX_BYTES) warn(`${file} pèse ${kb} Ko (> 300 Ko).`);
  return { file, width: clip.width, height: clip.height };
}

async function render(html, profile) {
  const htmlPath = path.join(OUT, "index.html");
  await writeFile(htmlPath, html);

  const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
  try {
    const context = await browser.newContext({
      viewport: { width: 880, height: 1200 },
      deviceScaleFactor: 2,
      colorScheme: "dark",
      reducedMotion: "reduce",
    });
    const page = await context.newPage();
    page.on("pageerror", (e) => { throw e; });
    await page.goto(pathToFileURL(htmlPath).href, { waitUntil: "networkidle" });
    await page.evaluate(() => document.documentElement.classList.add("capture"));

    // polices Google Fonts obligatoires : sans elles le rendu est faux, donc échec du build
    const missing = await page.evaluate(async () => {
      await document.fonts.ready;
      const need = ['900 40px "Tektur"', '700 16px "Tektur"', '600 15px "Chakra Petch"', '400 15px "Chakra Petch"', '600 11px "JetBrains Mono"'];
      await Promise.all(need.map((f) => document.fonts.load(f)));
      return need.filter((f) => !document.fonts.check(f) || ![...document.fonts].some((ff) => f.includes(ff.family.replace(/"/g, "")) && ff.status === "loaded"));
    });
    if (missing.length) throw new Error(`polices non chargées : ${missing.join(", ")}`);
    await page.evaluate(() => Promise.all([...document.images].map((i) => i.decode().catch(() => {}))));

    const height = await page.evaluate(() => Math.ceil(document.documentElement.scrollHeight));
    await page.setViewportSize({ width: 880, height });

    console.log("captures :");
    const shots = {};
    shots.hero = await capture(page, "#block-hero", "hero.png");
    shots.about = await capture(page, "#block-about", "about.png");
    shots.stack = await capture(page, "#block-stack", "stack.png");
    shots.projects = [];
    for (const p of profile.projects) shots.projects.push(await capture(page, `#block-project-${p.slug}`, `project-${p.slug}.png`));
    shots.activity = await capture(page, "#block-activity", "activity.png");
    shots.links = [];
    for (const l of profile.links.items) shots.links.push(await capture(page, `#port-${l.id}`, `link-${l.id}.png`));
    // aperçu pleine page (utile en local, publié aussi pour débogage)
    await writeFile(path.join(OUT, "full.png"), await compress(await page.screenshot({ fullPage: true })));
    return shots;
  } finally {
    await browser.close();
  }
}

// ---------------------------------------------------------------- README

const plain = (s) => s.replace(/\*\*(.+?)\*\*/g, "$1").replace(/`(.+?)`/g, "$1");
const attr = (s) => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function readme(profile, shots, version) {
  const heroW = shots.hero.width;
  const pct = (s) => `${((s.width / heroW) * 100).toFixed(1)}%`;
  const img = (s, alt) => `<img src="${RAW}/${s.file}?v=${version}" width="${pct(s)}" alt="${attr(alt)}">`;
  const link = (href, inner) => (href ? `<a href="${attr(href)}">${inner}</a>` : inner);
  const block = (...inner) => `<p align="center">${inner.join("")}</p>`;

  const P = profile;
  const about = `${P.about.title} — ` + P.about.items.map((i) => `${i.k} : ${plain(i.text)}`).join(" · ") + ` (carte GitFut de ${P.login})`;
  const stack = `${P.stack.title} — ` + P.stack.groups.map((g) => `${g.name} : ${g.items.map((i) => i.label).join(", ")}`).join(" · ");

  // projets par lignes de deux : images collées (aucun espace entre les <a>) pour qu'elles tiennent sur une ligne
  const projectRows = [];
  P.projects.forEach((p, i) => {
    const alt = `Projet ${plain(p.title)} (github.com/${p.repo}) — ${plain(p.description)} Fonctionnalités : ${p.features.map(plain).join(" ; ")}. Technologies : ${p.tags.join(", ")}.`;
    const html = link(`https://github.com/${p.repo}`, img(shots.projects[i], alt));
    if (i % 2 === 0) projectRows.push([html]); else projectRows[projectRows.length - 1].push(html);
  });

  return [
    "<!-- Généré par .github/workflows/profile.yml — modifier profile/profile.json -->",
    "<!-- Ce fichier est réécrit par `node profile/render.mjs --readme` : ne pas l'éditer à la main. -->",
    "",
    block(link(P.hero.link, img(shots.hero, P.hero.alt))),
    block(link(P.about.link, img(shots.about, about))),
    block(img(shots.stack, stack)),
    ...projectRows.map((r) => block(...r)),
    block(link(P.activity.link, img(shots.activity, `${P.activity.title} — grille des contributions GitHub de ${P.login} sur 12 mois, avec le serpent`))),
    block(...P.links.items.map((l, i) => link(l.url, img(shots.links[i], `${l.label} — ${l.display}`)))),
    "",
  ].join("\n\n").replace(/\n{3,}/g, "\n\n");
}

// ---------------------------------------------------------------- main

async function main() {
  const profile = JSON.parse(await readFile(path.join(HERE, "profile.json"), "utf8"));
  const template = await readFile(path.join(HERE, "template.html"), "utf8");
  for (const p of profile.projects) {
    if (!/^[a-z0-9-]+$/.test(p.slug)) throw new Error(`slug de projet invalide : « ${p.slug} » (a-z, 0-9, -)`);
  }

  await rm(OUT, { recursive: true, force: true });
  await mkdir(OUT, { recursive: true });

  const [contributions, gitfut, icons] = await Promise.all([
    getContributions(profile.login), getGitfut(profile.login), getIcons(profile),
  ]);
  const data = { stamp: buildStamp(), contributions, gitfut, icons };
  console.log(`build : ${data.stamp}`);

  const shots = await render(inject(template, profile, data), profile);

  // ?v= ne dépend que du contenu éditable : le README ne change que si profile.json ou le template changent
  const version = createHash("sha256").update(template).update(JSON.stringify(profile)).digest("hex").slice(0, 10);
  const md = readme(profile, shots, version);
  await writeFile(path.join(OUT, "README.md"), md);

  const target = path.join(HERE, "..", "README.md");
  if (process.argv.includes("--readme")) {
    await writeFile(target, md);
    console.log("README.md mis à jour.");
  } else {
    const current = await readFile(target, "utf8").catch(() => "");
    if (current !== md) warn("README.md n'est plus à jour avec profile.json : lancer `node render.mjs --readme` et committer.");
  }
  if (warnings.length) console.log(`${warnings.length} avertissement(s).`);
}

main().catch((e) => {
  console.error(`::error::${e.stack || e.message}`);
  process.exit(1);
});
