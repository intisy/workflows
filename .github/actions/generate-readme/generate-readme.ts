/**
 * Generate README.md from .github/docs-config.yml plus CONTENT.md.
 *
 * Usage: node generate-readme.ts --repository owner/name
 *        node generate-readme.ts --repository owner/name --placeholders
 *
 * Reads from CWD:
 *   .github/docs-config.yml  -> kind, section order, and every setting below
 *   gradle.properties        -> title, description, group, version fallbacks
 *   package.json             -> title, description, license, version fallbacks
 *   CONTENT.md               -> the repository's own prose
 *   LICENSE*                 -> license name, unless configured
 *
 * Every value the generator knows is exposed to CONTENT.md and to the prose settings as a
 * `{{ placeholder }}`; --placeholders prints the table for the current repository.
 *
 * Deliberately dependency-free so it runs in any checkout and in any workflow without an
 * install step. Node runs this file directly; there is no build.
 */

import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const CONFIG_PATH = join(".github", "docs-config.yml");

const LICENSE_BADGE_SLUGS: Record<string, string> = {
  "Apache License 2.0": "Apache_2.0",
  "MIT License": "MIT",
  "GNU General Public License v3.0": "GPLv3",
  "GNU General Public License": "GPL",
};

const SPDX_LICENSE_NAMES: Record<string, string> = {
  MIT: "MIT License",
  "APACHE-2.0": "Apache License 2.0",
  "GPL-3.0": "GNU General Public License v3.0",
  "GPL-3.0-ONLY": "GNU General Public License v3.0",
  "GPL-3.0-OR-LATER": "GNU General Public License v3.0",
  "LGPL-3.0": "GNU Lesser General Public License v3.0",
  "BSD-3-CLAUSE": "BSD 3-Clause License",
  "BSD-2-CLAUSE": "BSD 2-Clause License",
  ISC: "ISC License",
  "MPL-2.0": "Mozilla Public License 2.0",
  UNLICENSE: "The Unlicense",
};

export type ConfigValue = string | string[];
export type Config = Record<string, ConfigValue>;

const COMMON_DEFAULTS: Config = {
  logo: "",
  title: "",
  description: "",
  description_fallback: "",
  license: "",
  license_default: "",
  license_badge: "",
  content_intro: "",
  tag_filter: "",
  tag_fallback: "1.0.0",
  default_branch: "",
  sections: [],
  badges: [],
  modules: [],
  requirements: [],
  about_heading: "What is {{ repo }}?",
  releases_text:
    "Archives containing JAR files are available as " +
    "[releases](https://github.com/{org}/{repo}/releases).",
};

const GRADLE_DEFAULTS: Config = {
  gradle_plugin: "1.8.2.1",
  gradle_plugin_id: "io.github.intisy.github-gradle",
  gradle_plugin_url: "https://github.com/intisy/github-gradle",
  dependency_plugin_version: "1.3.7",
  developer_api_text: "",
  artifact: "",
  maven_group: "",
  plugin_namespace: "io.github.{org}",
  plugin_id: "",
};

const MINECRAFT_DEFAULTS: Config = {
  java: "25",
  paper: "1.16.* - 26.1.*",
  core_requirement: "[Slimefun 5](https://github.com/Slimefun5/Slimefun5)",
  builds_host: "Slimefun5.github.io/builds",
  builds_branch: "stable",
  bstats: "",
  bstats_name: "",
  wiki_base: "https://github.com/Slimefun5/Wiki/wiki",
  wiki_text: "[Read more on the Slimefun Wiki...]({{ wiki_base }}/{{ repo }})",
  discord: "https://discord.gg/CbBYZBEWdR",
  discord_guild: "738626600539160576",
  discord_text:
    "You can find Slimefun's community on Discord! Click the badge below to join " +
    "the server for suggestions/questions or other discussions about this plugin.",
};

const NUMERIC_TAG_FILTER = "^[0-9]+(\\.[0-9]+)*$";

export function warn(message: string): void {
  process.stderr.write(`generate-readme: ${message}\n`);
}

export interface Kind {
  sections: string[];
  titleSources: string[];
  defaults: Config;
}

function kind(sections: string[], titleSources: string[], ...defaults: Config[]): Kind {
  return { sections, titleSources, defaults: Object.assign({}, ...defaults) };
}

export const KINDS: Record<string, Kind> = {
  addon: kind(
    ["logo", "title", "badges", "description", "requirements", "content",
      "developer-api", "wiki", "discord", "license-prose"],
    ["repo"],
    GRADLE_DEFAULTS, MINECRAFT_DEFAULTS, {
      description_fallback: "A Slimefun 5 Addon.",
      license_default: "GNU General Public License v3.0",
      tag_fallback: "v1.0.0",
      badges: ["build", "downloads", "followers", "stars", "bstats"],
      requirements: ["Java {{ java }}", "Paper {{ paper }}", "{{ core_requirement }}"],
    },
  ),
  "gradle-plugin": kind(
    ["title", "releases", "about", "plugin-usage", "content", "license-badge"],
    ["gradle.display_name", "package.name", "repo"],
    GRADLE_DEFAULTS, {
      license_default: "Apache License 2.0",
      tag_filter: NUMERIC_TAG_FILTER,
      content_intro: "Once you have the plugin installed you can use it like so:",
    },
  ),
  "java-library": kind(
    ["title", "releases", "about", "library-usage-private", "library-usage-public",
      "modules", "content", "license-badge"],
    ["gradle.display_name", "package.name", "repo"],
    GRADLE_DEFAULTS, {
      license_default: "Apache License 2.0",
      tag_filter: NUMERIC_TAG_FILTER,
      content_intro: "Once you have it installed you can use it like so:",
    },
  ),
  "npm-package": kind(
    ["title", "badges", "description", "npm-install", "content", "license-badge"],
    ["package.name", "repo"],
    {
      badges: ["npm-version", "npm-downloads", "stars"],
      content_intro: "Once you have it installed you can use it like so:",
    },
  ),
  generic: kind(
    ["logo", "title", "badges", "description", "content", "license-badge"],
    ["repo"],
  ),
};

function unquote(value: string): string {
  const trimmed = value.trim();
  for (const quoteChar of ['"', "'"]) {
    if (trimmed.length >= 2 && trimmed.startsWith(quoteChar) && trimmed.endsWith(quoteChar)) {
      return trimmed.slice(1, -1);
    }
  }
  return trimmed;
}

/** Parse the flat key/value and key/list YAML subset, without a YAML dependency. */
export function parseConfig(path: string): Config {
  const config: Config = {};
  let pending: string | null = null;
  if (!existsSync(path)) return config;

  for (const raw of readFileSync(path, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;

    if (line.startsWith("-") && pending) {
      const item = unquote(line.slice(1));
      if (item) {
        if (!Array.isArray(config[pending])) config[pending] = [];
        (config[pending] as string[]).push(item);
      }
      continue;
    }

    if (line.includes(":")) {
      const index = line.indexOf(":");
      const key = line.slice(0, index).trim();
      const value = unquote(line.slice(index + 1));
      pending = value ? null : key;
      if (value) config[key] = value;
    }
  }
  return config;
}

export function readProperties(path: string): Record<string, string> {
  const properties: Record<string, string> = {};
  if (!existsSync(path)) return properties;
  for (const raw of readFileSync(path, "utf8").split("\n")) {
    const line = raw.trim().replace(/\r/g, "");
    if (!line || line.startsWith("#") || !line.includes("=")) continue;
    const index = line.indexOf("=");
    properties[line.slice(0, index).trim()] = line.slice(index + 1).trim();
  }
  return properties;
}

export function readJson(path: string): Record<string, unknown> {
  if (!existsSync(path)) return {};
  try {
    const data: unknown = JSON.parse(readFileSync(path, "utf8"));
    return data && typeof data === "object" && !Array.isArray(data)
      ? (data as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

export function readTextFile(path: string): string {
  return existsSync(path) ? readFileSync(path, "utf8").trim() : "";
}

const SKIPPED_DIRECTORIES = new Set([".git", "build", "target", "node_modules", "out", "dist", ".gradle"]);

export function findPluginDescriptor(root = "."): string {
  const stack = [root];
  while (stack.length > 0) {
    const current = stack.pop() as string;
    let entries: string[];
    try {
      entries = readdirSync(current);
    } catch {
      continue;
    }
    const files: string[] = [];
    for (const entry of entries) {
      const path = join(current, entry);
      let isDirectory: boolean;
      try {
        isDirectory = statSync(path).isDirectory();
      } catch {
        continue;
      }
      if (isDirectory) {
        if (!SKIPPED_DIRECTORIES.has(entry)) stack.push(path);
      } else {
        files.push(entry);
      }
    }
    if (current.replace(/\\/g, "/").endsWith("src/main/resources")) {
      if (files.includes("plugin.yml") || files.includes("paper-plugin.yml")) {
        return join(current, "plugin.yml");
      }
    }
  }
  return "";
}

/** Pick a kind from what the checkout actually contains. */
export function detectKind(): string {
  if (findPluginDescriptor()) return "addon";
  if (existsSync("gradle.properties") || existsSync("settings.gradle")
    || existsSync("settings.gradle.kts") || existsSync("pom.xml")) {
    return "java-library";
  }
  if (existsSync("package.json")) return "npm-package";
  return "generic";
}

/** Explicit `license` key, else LICENSE, else package.json, else the kind's default. */
export function detectLicense(config: Config, pkg: Record<string, unknown>): string {
  const configured = config.license;
  if (typeof configured === "string" && configured) return configured;

  for (const name of ["LICENSE", "LICENSE.md", "LICENSE.txt", "COPYING"]) {
    if (existsSync(name)) {
      const head = readFileSync(name, "utf8").slice(0, 4000).toUpperCase();
      if (head.includes("GNU GENERAL PUBLIC LICENSE")) {
        return head.includes("VERSION 3")
          ? "GNU General Public License v3.0"
          : "GNU General Public License";
      }
      if (head.includes("APACHE LICENSE")) return "Apache License 2.0";
      if (head.includes("MIT LICENSE") || head.includes("PERMISSION IS HEREBY GRANTED, FREE OF CHARGE")) {
        return "MIT License";
      }
      // Only the first license file present is inspected, matching the original.
      break;
    }
  }

  const spdx = String(pkg.license ?? "").trim().toUpperCase();
  if (spdx in SPDX_LICENSE_NAMES) return SPDX_LICENSE_NAMES[spdx];

  const fallback = config.license_default;
  return typeof fallback === "string" ? fallback : "";
}

/** Percent-encode like Python's urllib.parse.quote, whose default safe set is "/". */
export function quote(value: string, safe = "/"): string {
  let out = "";
  for (const character of value) {
    if (/^[A-Za-z0-9_.\-~]$/.test(character) || safe.includes(character)) {
      out += character;
      continue;
    }
    for (const byte of new TextEncoder().encode(character)) {
      out += "%" + byte.toString(16).toUpperCase().padStart(2, "0");
    }
  }
  return out;
}

async function apiJson(url: string, token?: string): Promise<unknown> {
  const headers: Record<string, string> = { "User-Agent": "readme-generator" };
  if (token) headers.Authorization = "token " + token;
  const response = await fetch(url, { headers, signal: AbortSignal.timeout(10000) });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

export function versionKey(tag: string): number[] {
  return tag.split(/[._-]/).map((part) => (/^[0-9]+$/.test(part) ? Number(part) : 0));
}

function compareVersions(left: string, right: string): number {
  const a = versionKey(left);
  const b = versionKey(right);
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    if (index >= a.length) return -1;
    if (index >= b.length) return 1;
    if (a[index] !== b[index]) return a[index] - b[index];
  }
  return 0;
}

async function fetchLatestTag(
  repository: string, tagFilter: string, fallback: string, token?: string,
): Promise<string> {
  let data: unknown;
  try {
    data = await apiJson(`https://api.github.com/repos/${repository}/tags`, token);
  } catch {
    return fallback;
  }
  if (!Array.isArray(data) || data.length === 0) return fallback;
  const names = data
    .filter((entry): entry is Record<string, unknown> => !!entry && typeof entry === "object")
    .map((entry) => String(entry.name ?? ""))
    .filter(Boolean);
  if (!tagFilter) return names.length > 0 ? names[0] : fallback;
  const pattern = new RegExp(tagFilter);
  // Python's re.match anchors at the start only, which a bare RegExp test does not.
  const matching = names.filter((name) => {
    const found = pattern.exec(name);
    return found !== null && found.index === 0;
  });
  if (matching.length === 0) return fallback;
  return matching.sort(compareVersions)[matching.length - 1];
}

async function fetchRepository(repository: string, token?: string): Promise<Record<string, unknown>> {
  try {
    const data = await apiJson(`https://api.github.com/repos/${repository}`, token);
    return data && typeof data === "object" && !Array.isArray(data)
      ? (data as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

async function fetchRelease(
  repository: string, tag: string, token?: string,
): Promise<Record<string, unknown>> {
  try {
    const data = await apiJson(
      `https://api.github.com/repos/${repository}/releases/tags/${quote(tag)}`, token,
    );
    return data && typeof data === "object" && !Array.isArray(data)
      ? (data as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Classifier names of a multi-module release, sources/javadoc excluded. */
export function releaseModules(release: Record<string, unknown>, artifact: string): string[] {
  const assets = release.assets;
  if (!Array.isArray(assets)) return [];
  const pattern = new RegExp(`^${escapeRegExp(artifact)}-(.+)\\.jar$`);
  const modules = new Set<string>();
  for (const asset of assets) {
    const name = String((asset as Record<string, unknown>)?.name ?? "");
    const match = pattern.exec(name);
    if (match && match[1] !== "sources" && match[1] !== "javadoc") modules.add(match[1]);
  }
  return [...modules].sort();
}

const PLACEHOLDER = /(?<!\$)(?<!\\)\{\{\s*([A-Za-z][A-Za-z0-9_.\-]*)\s*\}\}/g;
const ESCAPED_PLACEHOLDER = /\\(\{\{\s*[A-Za-z][A-Za-z0-9_.\-]*\s*\}\})/g;

/** Resolve `{{ name }}`; leave anything unresolvable in place and say so on stderr. */
export function substitute(text: string, table: Record<string, string>): string {
  const unknown = new Set<string>();
  const empty = new Set<string>();

  const resolved = text.replace(PLACEHOLDER, (whole, name: string) => {
    if (!(name in table)) {
      unknown.add(name);
      return whole;
    }
    const value = table[name];
    if (!value) {
      empty.add(name);
      return whole;
    }
    return value;
  });

  const result = resolved.replace(ESCAPED_PLACEHOLDER, "$1");
  for (const name of [...unknown].sort()) {
    warn(`unknown placeholder {{ ${name} }} left unresolved; --placeholders lists what this `
      + "repository offers");
  }
  for (const name of [...empty].sort()) {
    warn(`placeholder {{ ${name} }} has no value in this repository and was left unresolved`);
  }
  return result;
}

export class Context {
  readonly org: string;
  readonly repo: string;
  readonly kindName: string;
  readonly kind: Kind;
  readonly config: Config;
  readonly content: string;
  readonly tag: string;
  readonly release: Record<string, unknown>;
  readonly repositoryMeta: Record<string, unknown>;
  readonly properties: Record<string, string>;
  readonly package: Record<string, unknown>;

  constructor(
    org: string,
    repo: string,
    kindName: string,
    kindSpec: Kind,
    config: Config,
    content: string,
    tag: string,
    release: Record<string, unknown>,
    repositoryMeta: Record<string, unknown>,
  ) {
    this.org = org;
    this.repo = repo;
    this.kindName = kindName;
    this.kind = kindSpec;
    this.config = config;
    this.content = content;
    this.tag = tag;
    this.release = release;
    this.repositoryMeta = repositoryMeta;
    this.properties = readProperties("gradle.properties");
    this.package = readJson("package.json");
  }

  expand(value: string): string {
    return value.split("{org}").join(this.org).split("{repo}").join(this.repo);
  }

  get(key: string): string {
    const value = this.config[key] ?? "";
    if (Array.isArray(value)) return value.join(", ");
    return this.expand(String(value));
  }

  getList(key: string): string[] {
    const value = this.config[key] ?? [];
    const items = Array.isArray(value)
      ? [...value]
      : String(value).split(",").map((part) => part.trim());
    return items.filter(Boolean).map((item) => this.expand(item));
  }

  get repository(): string {
    return `${this.org}/${this.repo}`;
  }

  get description(): string {
    return this.get("description")
      || this.properties.description
      || this.properties.artifact_description
      || String(this.package.description ?? "")
      || this.get("description_fallback");
  }

  get title(): string {
    if (this.get("title")) return this.get("title");
    for (const source of this.kind.titleSources) {
      if (source === "gradle.display_name" && this.properties.display_name) {
        return this.properties.display_name;
      }
      if (source === "package.name" && this.package.name) return String(this.package.name);
      if (source === "repo") return this.repo;
    }
    return this.repo;
  }

  get licenseName(): string {
    return detectLicense(this.config, this.package);
  }

  get licenseSlug(): string {
    const name = this.licenseName;
    return this.get("license_badge")
      || LICENSE_BADGE_SLUGS[name]
      || name.split(" ").join("_");
  }

  get artifact(): string {
    return this.get("artifact") || this.properties.artifact_name || this.repo;
  }

  get mavenGroup(): string {
    return this.get("maven_group") || this.properties.artifact_group || "io.github." + this.org;
  }

  get pluginId(): string {
    if (this.get("plugin_id")) return this.get("plugin_id");
    const namespace = this.get("plugin_namespace");
    return namespace ? `${namespace}.${this.repo}` : "";
  }

  get modules(): string[] {
    const configured = this.getList("modules");
    return configured.length > 0 ? configured : releaseModules(this.release, this.artifact);
  }

  get defaultBranch(): string {
    return this.get("default_branch") || String(this.repositoryMeta.default_branch ?? "");
  }

  get version(): string {
    return /^v[0-9]/.test(this.tag) ? this.tag.slice(1) : this.tag;
  }

  get releaseDate(): string {
    return String(this.release.published_at ?? "").slice(0, 10);
  }

  placeholders(): Record<string, string> {
    const table: Record<string, string> = {};
    for (const key of Object.keys(this.config)) table[key] = this.get(key);

    const bin = this.package.bin;
    const dependencies = this.package.dependencies;
    const modules = this.modules;

    return Object.assign(table, {
      org: this.org,
      repo: this.repo,
      repository: this.repository,
      repo_url: `https://github.com/${this.repository}`,
      releases_url: `https://github.com/${this.repository}/releases`,
      release_url: `https://github.com/${this.repository}/releases/tag/${this.tag}`,
      release_date: this.releaseDate,
      default_branch: this.defaultBranch,
      kind: this.kindName,
      tag: this.tag,
      version: this.version,
      title: this.title,
      description: this.description,
      license: this.licenseName,
      license_slug: this.licenseSlug,
      artifact: this.artifact,
      group: this.mavenGroup,
      plugin_id: this.pluginId,
      modules: modules.join(", "),
      module_count: modules.length > 0 ? String(modules.length) : "",
      package_name: String(this.package.name ?? ""),
      package_version: String(this.package.version ?? ""),
      package_bin: bin && typeof bin === "object" && !Array.isArray(bin)
        ? Object.keys(bin).sort().join(", ")
        : String(bin ?? ""),
      dependencies: dependencies && typeof dependencies === "object" && !Array.isArray(dependencies)
        ? Object.keys(dependencies).sort().join(", ")
        : "",
    });
  }
}

type Renderer = (ctx: Context) => string | null;

function badgeBuild(ctx: Context): string | null {
  const host = ctx.get("builds_host");
  if (!host) return null;
  const branch = ctx.get("builds_branch");
  return `[![Build Status](https://${host}/${ctx.org}/${ctx.repo}/${branch}/badge.svg)]`
    + `(https://${host}/${ctx.org}/${ctx.repo}/${branch})`;
}

function badgeDownloads(ctx: Context): string {
  return "![GitHub Downloads (all assets, all releases)]"
    + `(https://img.shields.io/github/downloads/${ctx.org}/${ctx.repo}/total)`;
}

function badgeFollowers(ctx: Context): string {
  return `[![GitHub Followers](https://img.shields.io/github/followers/${ctx.org}?style=social)]`
    + `(https://github.com/${ctx.org})`;
}

function badgeStars(ctx: Context): string {
  return `[![GitHub Stars](https://img.shields.io/github/stars/${ctx.org}/${ctx.repo}?style=social)]`
    + `(https://github.com/${ctx.org}/${ctx.repo})`;
}

function badgeBstats(ctx: Context): string | null {
  const bstatsId = ctx.get("bstats");
  if (!bstatsId) return null;
  // The signature SVG is keyed by the bStats plugin name, which may contain spaces and may
  // differ from the repo name; an unencoded space breaks the badge and a wrong name resolves
  // to a different plugin's graph.
  const name = quote(ctx.get("bstats_name") || ctx.repo);
  return `[![bStats](https://bStats.org/signatures/bukkit/${name}.svg)]`
    + `(https://bStats.org/plugin/bukkit/${name}/${bstatsId})`;
}

function badgeLicense(ctx: Context): string | null {
  if (!ctx.licenseName) return null;
  return `[![${ctx.licenseName}](https://img.shields.io/badge/License-${ctx.licenseSlug}-blue.svg)](LICENSE)`;
}

function badgeRelease(ctx: Context): string {
  return `[![Latest Release](https://img.shields.io/github/v/release/${ctx.org}/${ctx.repo})]`
    + `(https://github.com/${ctx.org}/${ctx.repo}/releases/latest)`;
}

function badgeNpmVersion(ctx: Context): string | null {
  const name = ctx.package.name;
  if (!name) return null;
  const slug = quote(String(name), "");
  return `[![npm version](https://img.shields.io/npm/v/${slug})](https://www.npmjs.com/package/${slug})`;
}

function badgeNpmDownloads(ctx: Context): string | null {
  const name = ctx.package.name;
  if (!name) return null;
  const slug = quote(String(name), "");
  return `[![npm downloads](https://img.shields.io/npm/dm/${slug})](https://www.npmjs.com/package/${slug})`;
}

const BADGES: Record<string, (ctx: Context) => string | null> = {
  build: badgeBuild,
  downloads: badgeDownloads,
  followers: badgeFollowers,
  stars: badgeStars,
  bstats: badgeBstats,
  license: badgeLicense,
  release: badgeRelease,
  "npm-version": badgeNpmVersion,
  "npm-downloads": badgeNpmDownloads,
};

function renderLogo(ctx: Context): string | null {
  const logo = ctx.get("logo");
  if (!logo) return null;
  return `<p align="center">\n<img width="800" src="${logo}"><br><br>\n</p>`;
}

function renderTitle(ctx: Context): string {
  return "# " + ctx.title;
}

function renderBadges(ctx: Context): string | null {
  const lines: string[] = [];
  for (const badgeId of ctx.getList("badges")) {
    if (!(badgeId in BADGES)) {
      warn(`unknown badge '${badgeId}' in ${CONFIG_PATH} (known: ${Object.keys(BADGES).sort().join(", ")})`);
      continue;
    }
    const rendered = BADGES[badgeId](ctx);
    if (rendered) lines.push(rendered);
  }
  return lines.length > 0 ? lines.join("\n") : null;
}

function renderDescription(ctx: Context): string | null {
  return ctx.description || null;
}

function renderRequirements(ctx: Context): string | null {
  const items = ctx.getList("requirements");
  if (items.length === 0) return null;
  return "## Requirements\n" + items.map((item) => "- " + item).join("\n");
}

function renderContent(ctx: Context): string | null {
  if (!ctx.content) return null;
  const intro = ctx.get("content_intro");
  return intro ? intro + "\n\n" + ctx.content : ctx.content;
}

function renderDeveloperApi(ctx: Context): string {
  if (ctx.get("developer_api_text")) {
    return "## Developer API\n\n" + ctx.get("developer_api_text");
  }
  return "## Developer API\n\n"
    + `You can easily depend on this project using [github-gradle](${ctx.get("gradle_plugin_url")}).\n\n`
    + "In your `build.gradle.kts`:\n\n"
    + "```kotlin\n"
    + "plugins {\n"
    + `    id("${ctx.get("gradle_plugin_id")}") version "${ctx.get("gradle_plugin")}"\n`
    + "}\n\n"
    + "dependencies {\n"
    + `    "githubCompileOnly"("${ctx.org}:${ctx.artifact}:${ctx.tag}")\n`
    + "}\n"
    + "```";
}

function renderWiki(ctx: Context): string | null {
  const text = ctx.get("wiki_text");
  if (!text || !ctx.get("wiki_base")) return null;
  return "## Wiki\n\n" + text;
}

function renderDiscord(ctx: Context): string | null {
  const invite = ctx.get("discord");
  const guild = ctx.get("discord_guild");
  if (!invite || !guild) return null;
  return `## Discord\n\n${ctx.get("discord_text")}\n\n`
    + '<p align="center">\n'
    + `  <a href="${invite}">\n`
    + `    <img src="https://discordapp.com/api/guilds/${guild}/widget.png?style=banner2" alt="Discord"/>\n`
    + "  </a>\n"
    + "</p>";
}

function renderLicenseProse(ctx: Context): string | null {
  if (!ctx.licenseName) return null;
  return `## License\n\nThis project is open-source and licensed under the ${ctx.licenseName}.`;
}

function renderLicenseBadge(ctx: Context): string | null {
  const badge = badgeLicense(ctx);
  return badge ? "## License\n\n" + badge : null;
}

function renderReleases(ctx: Context): string {
  return ctx.get("releases_text");
}

function renderAbout(ctx: Context): string | null {
  if (!ctx.description) return null;
  return `## ${ctx.get("about_heading")}\n\n${ctx.description}`;
}

function renderPluginUsage(ctx: Context): string {
  const pluginId = ctx.pluginId;
  return "## Usage\n\n"
    + "Using the plugins DSL:\n\n"
    + "```groovy\n"
    + "plugins {\n"
    + `    id "${pluginId}" version "${ctx.tag}"\n`
    + "}\n"
    + "```\n\n"
    + "Using legacy plugin application:\n\n"
    + "```groovy\n"
    + "buildscript {\n"
    + "    repositories {\n"
    + "        maven {\n"
    + '            url "https://plugins.gradle.org/m2/"\n'
    + "        }\n"
    + "    }\n"
    + "    dependencies {\n"
    + `        classpath "${pluginId}:${ctx.tag}"\n`
    + "    }\n"
    + "}\n\n"
    + `apply plugin: "${pluginId}"\n`
    + "```";
}

function renderLibraryUsagePrivate(ctx: Context): string {
  const group = ctx.mavenGroup;
  return "## Usage in private projects\n\n"
    + " * Maven (inside the `pom.xml` file)\n"
    + "```xml\n"
    + "  <repository>\n"
    + "      <id>github</id>\n"
    + `      <url>https://maven.pkg.github.com/${ctx.org}/${ctx.repo}</url>\n`
    + "      <snapshots><enabled>true</enabled></snapshots>\n"
    + "  </repository>\n"
    + "  <dependency>\n"
    + `      <groupId>${group}</groupId>\n`
    + `      <artifactId>${ctx.artifact}</artifactId>\n`
    + `      <version>${ctx.tag}</version>\n`
    + "  </dependency>\n"
    + "```\n\n"
    + " * Maven (inside the `settings.xml` file)\n"
    + "```xml\n"
    + "  <servers>\n"
    + "      <server>\n"
    + "          <id>github</id>\n"
    + "          <username>your-username</username>\n"
    + "          <password>your-access-token</password>\n"
    + "      </server>\n"
    + "  </servers>\n"
    + "```\n\n"
    + " * Gradle (inside the `build.gradle.kts` or `build.gradle` file)\n"
    + "```groovy\n"
    + "  repositories {\n"
    + "      maven {\n"
    + `          url "https://maven.pkg.github.com/${ctx.org}/${ctx.repo}"\n`
    + "          credentials {\n"
    + '              username = "<your-username>"\n'
    + '              password = "<your-access-token>"\n'
    + "          }\n"
    + "      }\n"
    + "  }\n"
    + "  dependencies {\n"
    + `      implementation '${group}:${ctx.artifact}:${ctx.tag}'\n`
    + "  }\n"
    + "```";
}

function renderLibraryUsagePublic(ctx: Context): string {
  return "## Usage in public projects\n\n"
    + " * Gradle (inside the `build.gradle.kts` or `build.gradle` file)\n"
    + "```groovy\n"
    + "  plugins {\n"
    + `      id "${ctx.get("gradle_plugin_id")}" version "${ctx.get("dependency_plugin_version")}"\n`
    + "  }\n"
    + "  dependencies {\n"
    + `      githubImplementation "${ctx.org}:${ctx.artifact}:${ctx.tag}"\n`
    + "  }\n"
    + "```";
}

function renderModules(ctx: Context): string | null {
  const modules = ctx.modules;
  if (modules.length < 2) return null;
  const lines = [
    "## Modules",
    "",
    `\`${ctx.artifact}\` is published as separate modules. Pull every module at once with the \`all\` classifier:`,
    "",
    "```groovy",
    "dependencies {",
    `    githubImplementation "${ctx.org}:${ctx.artifact}:${ctx.tag}:all"`,
    "}",
    "```",
    "",
    "Or depend on individual modules:",
    "",
    "```groovy",
    "dependencies {",
  ];
  for (const module of modules) {
    lines.push(`    githubImplementation "${ctx.org}:${ctx.artifact}:${ctx.tag}:${module}"`);
  }
  lines.push("}", "```");
  return lines.join("\n");
}

function renderNpmInstall(ctx: Context): string | null {
  const name = ctx.package.name;
  if (!name) return null;
  const body = ["## Installation", "", "```bash", `npm install ${String(name)}`, "```"];
  const binaries = ctx.package.bin;
  if (binaries && typeof binaries === "object" && !Array.isArray(binaries)
    && Object.keys(binaries).length > 0) {
    body.push("", `It installs the \`${Object.keys(binaries).sort().join("`, `")}\` command.`);
  } else if (typeof binaries === "string" && binaries) {
    body.push("", `It installs the \`${String(name)}\` command.`);
  }
  return body.join("\n");
}

export const SECTIONS: [string, Renderer][] = [
  ["logo", renderLogo],
  ["title", renderTitle],
  ["badges", renderBadges],
  ["description", renderDescription],
  ["requirements", renderRequirements],
  ["releases", renderReleases],
  ["about", renderAbout],
  ["plugin-usage", renderPluginUsage],
  ["library-usage-private", renderLibraryUsagePrivate],
  ["library-usage-public", renderLibraryUsagePublic],
  ["modules", renderModules],
  ["npm-install", renderNpmInstall],
  ["content", renderContent],
  ["developer-api", renderDeveloperApi],
  ["wiki", renderWiki],
  ["discord", renderDiscord],
  ["license-prose", renderLicenseProse],
  ["license-badge", renderLicenseBadge],
];

/** Insert a renderer into the registry, immediately after `after` when given. */
export function registerSection(sectionId: string, renderer: Renderer, after?: string): void {
  if (SECTIONS.some(([existing]) => existing === sectionId)) {
    throw new Error(`section '${sectionId}' is already registered`);
  }
  let index = SECTIONS.length;
  if (after) {
    const position = SECTIONS.findIndex(([existing]) => existing === after);
    if (position !== -1) index = position + 1;
  }
  SECTIONS.splice(index, 0, [sectionId, renderer]);
}

export function rendererFor(sectionId: string): Renderer {
  const found = SECTIONS.find(([existing]) => existing === sectionId);
  if (!found) throw new Error(`no renderer registered for section '${sectionId}'`);
  return found[1];
}

function buildConfig(kindSpec: Kind, overrides: Config): Config {
  return { ...COMMON_DEFAULTS, ...kindSpec.defaults, ...overrides };
}

function fallbackTag(config: Config): string {
  return readProperties("gradle.properties").artifact_version
    || String(readJson("package.json").version ?? "")
    || String(config.tag_fallback ?? "");
}

export interface BuildOptions {
  tag?: string;
  offline?: boolean;
  token?: string;
  defaultBranch?: string;
}

export async function buildContext(repository: string, options: BuildOptions = {}): Promise<Context> {
  const { offline = false, token, defaultBranch = "" } = options;
  const [org, repo] = repository.split("/");
  const overrides = parseConfig(CONFIG_PATH);
  const kindName = (typeof overrides.kind === "string" && overrides.kind) || detectKind();
  if (!(kindName in KINDS)) {
    throw new Error(`unknown kind '${kindName}' in ${CONFIG_PATH} `
      + `(known: ${Object.keys(KINDS).sort().join(", ")})`);
  }
  const kindSpec = KINDS[kindName];
  const config = buildConfig(kindSpec, overrides);
  if (defaultBranch) config.default_branch = defaultBranch;

  let tag = options.tag ?? "";
  if (!tag) {
    tag = offline
      ? fallbackTag(config)
      : await fetchLatestTag(repository, String(config.tag_filter ?? ""), fallbackTag(config), token);
  }

  const release = offline ? {} : await fetchRelease(repository, tag, token);
  const knownBranch = offline || config.default_branch;
  const repositoryMeta = knownBranch ? {} : await fetchRepository(repository, token);

  return new Context(org, repo, kindName, kindSpec, config, readTextFile("CONTENT.md"),
    tag, release, repositoryMeta);
}

export function render(ctx: Context): string {
  const parts: string[] = [];
  const sections = ctx.getList("sections");
  for (const sectionId of sections.length > 0 ? sections : ctx.kind.sections) {
    const rendered = rendererFor(sectionId)(ctx);
    if (rendered && rendered.trim()) parts.push(rendered.trim());
  }
  return substitute(parts.join("\n\n"), ctx.placeholders()) + "\n";
}

export async function generate(
  repository: string, options: BuildOptions = {},
): Promise<{ readme: string; tag: string }> {
  const ctx = await buildContext(repository, options);
  return { readme: render(ctx), tag: ctx.tag };
}

function parseArguments(argv: string[]): Record<string, string | boolean> {
  const parsed: Record<string, string | boolean> = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!argument.startsWith("--")) continue;
    const name = argument.slice(2);
    const next = argv[index + 1];
    if (next === undefined || next.startsWith("--")) {
      parsed[name] = true;
    } else {
      parsed[name] = next;
      index += 1;
    }
  }
  return parsed;
}

export async function main(argv: string[]): Promise<number> {
  const args = parseArguments(argv);
  const repository = typeof args.repository === "string" ? args.repository : "";
  if (!repository) {
    process.stderr.write("usage: generate-readme.ts --repository owner/name\n");
    return 2;
  }

  const options: BuildOptions = {
    tag: (typeof args.tag === "string" ? args.tag : "") || process.env.README_TAG || "",
    defaultBranch: (typeof args["default-branch"] === "string" ? args["default-branch"] : "")
      || process.env.README_DEFAULT_BRANCH || "",
    offline: args.offline === true || Boolean(process.env.README_OFFLINE),
    token: process.env.GITHUB_TOKEN,
  };

  if (args.placeholders === true) {
    const ctx = await buildContext(repository, options);
    const table = ctx.placeholders();
    for (const name of Object.keys(table).sort()) {
      process.stdout.write(`{{ ${name} }} = ${table[name] || "(unset)"}\n`);
    }
    return 0;
  }

  if (!existsSync(CONFIG_PATH)) {
    process.stderr.write(`${CONFIG_PATH} is missing: this repository has no README spec\n`);
    return 1;
  }

  const { readme, tag } = await generate(repository, options);

  if (args.stdout === true) {
    process.stdout.write(readme);
    return 0;
  }
  const output = typeof args.output === "string" ? args.output : "README.md";
  writeFileSync(output, readme, "utf8");
  process.stdout.write(`Generated ${output} for ${repository} (tag: ${tag})\n`);
  return 0;
}

const invokedDirectly = process.argv[1]
  && process.argv[1] === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  main(process.argv.slice(2))
    .then((code) => { process.exitCode = code; })
    .catch((error: unknown) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    });
}
