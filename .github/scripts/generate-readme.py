#!/usr/bin/env python3
"""Generate README.md from .github/docs-config.yml plus CONTENT.md.

Usage: python3 generate-readme.py --repository owner/name
       python3 generate-readme.py --repository owner/name --placeholders

Reads from CWD:
  .github/docs-config.yml  -> kind, section order, and every setting below
  gradle.properties        -> title, description, group, version fallbacks
  package.json             -> title, description, license, version fallbacks
  CONTENT.md               -> the repository's own prose
  LICENSE*                 -> license name, unless configured

Every value the generator knows is exposed to CONTENT.md and to the prose settings as a
``{{ placeholder }}``; ``--placeholders`` prints the table for the current repository.

Deliberately dependency-free (no pyyaml, no requests) so it runs in any
checkout and in any workflow without an install step.
"""

import argparse
import json
import os
import re
import sys
import urllib.parse
import urllib.request

CONFIG_PATH = os.path.join(".github", "docs-config.yml")

LICENSE_BADGE_SLUGS = {
    "Apache License 2.0": "Apache_2.0",
    "MIT License": "MIT",
    "GNU General Public License v3.0": "GPLv3",
    "GNU General Public License": "GPL",
}

SPDX_LICENSE_NAMES = {
    "MIT": "MIT License",
    "APACHE-2.0": "Apache License 2.0",
    "GPL-3.0": "GNU General Public License v3.0",
    "GPL-3.0-ONLY": "GNU General Public License v3.0",
    "GPL-3.0-OR-LATER": "GNU General Public License v3.0",
    "LGPL-3.0": "GNU Lesser General Public License v3.0",
    "BSD-3-CLAUSE": "BSD 3-Clause License",
    "BSD-2-CLAUSE": "BSD 2-Clause License",
    "ISC": "ISC License",
    "MPL-2.0": "Mozilla Public License 2.0",
    "UNLICENSE": "The Unlicense",
}

COMMON_DEFAULTS = {
    "logo": "",
    "title": "",
    "description": "",
    "description_fallback": "",
    "license": "",
    "license_default": "",
    "license_badge": "",
    "content_intro": "",
    "tag_filter": "",
    "tag_fallback": "1.0.0",
    "default_branch": "",
    "sections": [],
    "badges": [],
    "modules": [],
    "requirements": [],
    "about_heading": "What is {{ repo }}?",
    "releases_text": "Archives containing JAR files are available as "
                     "[releases](https://github.com/{org}/{repo}/releases).",
}

GRADLE_DEFAULTS = {
    "gradle_plugin": "1.8.2.1",
    "gradle_plugin_id": "io.github.intisy.github-gradle",
    "gradle_plugin_url": "https://github.com/intisy/github-gradle",
    "dependency_plugin_version": "1.3.7",
    "developer_api_text": "",
    "artifact": "",
    "maven_group": "",
    "plugin_namespace": "io.github.{org}",
    "plugin_id": "",
}

MINECRAFT_DEFAULTS = {
    "java": "25",
    "paper": "1.16.* - 26.1.*",
    "core_requirement": "[Slimefun 5](https://github.com/Slimefun5/Slimefun5)",
    "builds_host": "Slimefun5.github.io/builds",
    "builds_branch": "stable",
    "bstats": "",
    "bstats_name": "",
    "wiki_base": "https://github.com/Slimefun5/Wiki/wiki",
    "wiki_text": "[Read more on the Slimefun Wiki...]({{ wiki_base }}/{{ repo }})",
    "discord": "https://discord.gg/CbBYZBEWdR",
    "discord_guild": "738626600539160576",
    "discord_text": "You can find Slimefun's community on Discord! Click the badge below to join "
                    "the server for suggestions/questions or other discussions about this plugin.",
}

NUMERIC_TAG_FILTER = r"^[0-9]+(\.[0-9]+)*$"


def warn(message):
    sys.stderr.write("generate-readme: %s\n" % message)


class Kind:
    def __init__(self, sections, title_sources, defaults=None):
        self.sections = sections
        self.title_sources = title_sources
        self.defaults = defaults or {}


def merged(*layers):
    result = {}
    for layer in layers:
        result.update(layer)
    return result


KINDS = {
    "addon": Kind(
        sections=["logo", "title", "badges", "description", "requirements", "content",
                  "developer-api", "wiki", "discord", "license-prose"],
        title_sources=["repo"],
        defaults=merged(GRADLE_DEFAULTS, MINECRAFT_DEFAULTS, {
            "description_fallback": "A Slimefun 5 Addon.",
            "license_default": "GNU General Public License v3.0",
            "tag_fallback": "v1.0.0",
            "badges": ["build", "downloads", "followers", "stars", "bstats"],
            "requirements": ["Java {{ java }}", "Paper {{ paper }}", "{{ core_requirement }}"],
        }),
    ),
    "gradle-plugin": Kind(
        sections=["title", "releases", "about", "plugin-usage", "content", "license-badge"],
        title_sources=["gradle.display_name", "package.name", "repo"],
        defaults=merged(GRADLE_DEFAULTS, {
            "license_default": "Apache License 2.0",
            "tag_filter": NUMERIC_TAG_FILTER,
            "content_intro": "Once you have the plugin installed you can use it like so:",
        }),
    ),
    "java-library": Kind(
        sections=["title", "releases", "about", "library-usage-private", "library-usage-public",
                  "modules", "content", "license-badge"],
        title_sources=["gradle.display_name", "package.name", "repo"],
        defaults=merged(GRADLE_DEFAULTS, {
            "license_default": "Apache License 2.0",
            "tag_filter": NUMERIC_TAG_FILTER,
            "content_intro": "Once you have it installed you can use it like so:",
        }),
    ),
    "npm-package": Kind(
        sections=["title", "badges", "description", "npm-install", "content", "license-badge"],
        title_sources=["package.name", "repo"],
        defaults={
            "badges": ["npm-version", "npm-downloads", "stars"],
            "content_intro": "Once you have it installed you can use it like so:",
        },
    ),
    "generic": Kind(
        sections=["logo", "title", "badges", "description", "content", "license-badge"],
        title_sources=["repo"],
        defaults={},
    ),
}


def unquote(value):
    value = value.strip()
    for quote in ('"', "'"):
        if len(value) >= 2 and value.startswith(quote) and value.endswith(quote):
            return value[1:-1]
    return value


def parse_config(path):
    """Parse the flat key/value and key/list YAML subset without requiring pyyaml."""
    config = {}
    pending = None
    if not os.path.exists(path):
        return config
    with open(path, encoding="utf-8") as handle:
        for raw in handle:
            line = raw.strip()
            if not line or line.startswith("#"):
                continue
            if line.startswith("-") and pending:
                item = unquote(line[1:])
                if item:
                    config.setdefault(pending, [])
                    config[pending].append(item)
                continue
            if ":" in line:
                key, _, value = line.partition(":")
                key = key.strip()
                value = unquote(value)
                pending = key if not value else None
                if value:
                    config[key] = value
    return config


def read_properties(path):
    properties = {}
    if not os.path.exists(path):
        return properties
    with open(path, encoding="utf-8") as handle:
        for raw in handle:
            line = raw.strip().replace("\r", "")
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, _, value = line.partition("=")
            properties[key.strip()] = value.strip()
    return properties


def read_json(path):
    if not os.path.exists(path):
        return {}
    try:
        with open(path, encoding="utf-8") as handle:
            data = json.load(handle)
    except (ValueError, OSError):
        return {}
    return data if isinstance(data, dict) else {}


def read_file(path):
    if not os.path.exists(path):
        return ""
    with open(path, encoding="utf-8") as handle:
        return handle.read().strip()


def detect_kind():
    """Pick a kind from what the checkout actually contains."""
    if find_plugin_descriptor():
        return "addon"
    if os.path.exists("gradle.properties") or os.path.exists("settings.gradle") \
            or os.path.exists("settings.gradle.kts") or os.path.exists("pom.xml"):
        return "java-library"
    if os.path.exists("package.json"):
        return "npm-package"
    return "generic"


def find_plugin_descriptor():
    skipped = {".git", "build", "target", "node_modules", "out", "dist", ".gradle"}
    for root, directories, files in os.walk("."):
        directories[:] = [name for name in directories if name not in skipped]
        if root.replace("\\", "/").endswith("src/main/resources"):
            if "plugin.yml" in files or "paper-plugin.yml" in files:
                return os.path.join(root, "plugin.yml")
    return ""


def detect_license(config, package):
    """Explicit ``license`` key, else LICENSE, else package.json, else the kind's default."""
    if config.get("license"):
        return config["license"]

    for name in ("LICENSE", "LICENSE.md", "LICENSE.txt", "COPYING"):
        if os.path.exists(name):
            with open(name, encoding="utf-8", errors="ignore") as handle:
                head = handle.read(4000).upper()
            if "GNU GENERAL PUBLIC LICENSE" in head:
                return "GNU General Public License v3.0" if "VERSION 3" in head else "GNU General Public License"
            if "APACHE LICENSE" in head:
                return "Apache License 2.0"
            if "MIT LICENSE" in head or "PERMISSION IS HEREBY GRANTED, FREE OF CHARGE" in head:
                return "MIT License"
            break

    spdx = str(package.get("license", "")).strip().upper()
    if spdx in SPDX_LICENSE_NAMES:
        return SPDX_LICENSE_NAMES[spdx]

    return config.get("license_default", "")


def api_json(url, token=None):
    headers = {"User-Agent": "readme-generator"}
    if token:
        headers["Authorization"] = "token " + token
    request = urllib.request.Request(url, headers=headers)
    with urllib.request.urlopen(request, timeout=10) as response:
        return json.loads(response.read())


def version_key(tag):
    return [int(part) if part.isdigit() else 0 for part in re.split(r"[._-]", tag)]


def fetch_latest_tag(repository, tag_filter, fallback, token=None):
    try:
        data = api_json("https://api.github.com/repos/%s/tags" % repository, token)
    except Exception:
        return fallback
    if not isinstance(data, list) or not data:
        return fallback
    names = [entry["name"] for entry in data if isinstance(entry, dict) and entry.get("name")]
    if not tag_filter:
        return names[0] if names else fallback
    matching = [name for name in names if re.match(tag_filter, name)]
    if not matching:
        return fallback
    return sorted(matching, key=version_key)[-1]


def fetch_repository(repository, token=None):
    try:
        data = api_json("https://api.github.com/repos/%s" % repository, token)
    except Exception:
        return {}
    return data if isinstance(data, dict) else {}


def fetch_release(repository, tag, token=None):
    try:
        data = api_json(
            "https://api.github.com/repos/%s/releases/tags/%s" % (repository, urllib.parse.quote(tag)),
            token,
        )
    except Exception:
        return {}
    return data if isinstance(data, dict) else {}


def release_modules(release, artifact):
    """Classifier names of a multi-module release, sources/javadoc excluded."""
    assets = release.get("assets")
    if not isinstance(assets, list):
        return []
    pattern = re.compile(r"^%s-(.+)\.jar$" % re.escape(artifact))
    modules = set()
    for asset in assets:
        match = pattern.match(str(asset.get("name", "")))
        if match and match.group(1) not in ("sources", "javadoc"):
            modules.add(match.group(1))
    return sorted(modules)


PLACEHOLDER = re.compile(r"(?<!\$)(?<!\\)\{\{\s*([A-Za-z][A-Za-z0-9_.\-]*)\s*\}\}")
ESCAPED_PLACEHOLDER = re.compile(r"\\(\{\{\s*[A-Za-z][A-Za-z0-9_.\-]*\s*\}\})")


def substitute(text, table):
    """Resolve ``{{ name }}``; leave anything unresolvable in place and say so on stderr."""
    unknown = set()
    empty = set()

    def resolve(match):
        name = match.group(1)
        if name not in table:
            unknown.add(name)
            return match.group(0)
        value = table[name]
        if not value:
            empty.add(name)
            return match.group(0)
        return value

    result = ESCAPED_PLACEHOLDER.sub(r"\1", PLACEHOLDER.sub(resolve, text))
    for name in sorted(unknown):
        warn("unknown placeholder {{ %s }} left unresolved; --placeholders lists what this "
             "repository offers" % name)
    for name in sorted(empty):
        warn("placeholder {{ %s }} has no value in this repository and was left unresolved" % name)
    return result


class Context:
    def __init__(self, org, repo, kind_name, kind, config, content, tag, release, repository_meta):
        self.org = org
        self.repo = repo
        self.kind_name = kind_name
        self.kind = kind
        self.config = config
        self.content = content
        self.tag = tag
        self.release = release
        self.repository_meta = repository_meta
        self.properties = read_properties("gradle.properties")
        self.package = read_json("package.json")

    def get(self, key):
        value = self.config.get(key, "")
        if isinstance(value, list):
            return ", ".join(value)
        return str(value).replace("{org}", self.org).replace("{repo}", self.repo)

    def get_list(self, key):
        value = self.config.get(key, [])
        if isinstance(value, list):
            items = list(value)
        else:
            items = [part.strip() for part in str(value).split(",")]
        return [item.replace("{org}", self.org).replace("{repo}", self.repo)
                for item in items if item]

    @property
    def repository(self):
        return "%s/%s" % (self.org, self.repo)

    @property
    def description(self):
        return (self.get("description")
                or self.properties.get("description", "")
                or self.properties.get("artifact_description", "")
                or str(self.package.get("description", ""))
                or self.get("description_fallback"))

    @property
    def title(self):
        if self.get("title"):
            return self.get("title")
        for source in self.kind.title_sources:
            if source == "gradle.display_name" and self.properties.get("display_name"):
                return self.properties["display_name"]
            if source == "package.name" and self.package.get("name"):
                return str(self.package["name"])
            if source == "repo":
                return self.repo
        return self.repo

    @property
    def license_name(self):
        return detect_license(self.config, self.package)

    @property
    def license_slug(self):
        name = self.license_name
        return self.get("license_badge") or LICENSE_BADGE_SLUGS.get(name, name.replace(" ", "_"))

    @property
    def artifact(self):
        return self.get("artifact") or self.properties.get("artifact_name", "") or self.repo

    @property
    def maven_group(self):
        return (self.get("maven_group")
                or self.properties.get("artifact_group", "")
                or "io.github." + self.org)

    @property
    def plugin_id(self):
        if self.get("plugin_id"):
            return self.get("plugin_id")
        namespace = self.get("plugin_namespace")
        return "%s.%s" % (namespace, self.repo) if namespace else ""

    @property
    def modules(self):
        configured = self.get_list("modules")
        return configured or release_modules(self.release, self.artifact)

    @property
    def default_branch(self):
        return (self.get("default_branch")
                or str(self.repository_meta.get("default_branch", ""))
                or "")

    @property
    def version(self):
        return self.tag[1:] if re.match(r"^v[0-9]", self.tag) else self.tag

    @property
    def release_date(self):
        return str(self.release.get("published_at", ""))[:10]

    def placeholders(self):
        table = {}
        for key in self.config:
            table[key] = self.get(key)
        table.update({
            "org": self.org,
            "repo": self.repo,
            "repository": self.repository,
            "repo_url": "https://github.com/%s" % self.repository,
            "releases_url": "https://github.com/%s/releases" % self.repository,
            "release_url": "https://github.com/%s/releases/tag/%s" % (self.repository, self.tag),
            "release_date": self.release_date,
            "default_branch": self.default_branch,
            "kind": self.kind_name,
            "tag": self.tag,
            "version": self.version,
            "title": self.title,
            "description": self.description,
            "license": self.license_name,
            "license_slug": self.license_slug,
            "artifact": self.artifact,
            "group": self.maven_group,
            "plugin_id": self.plugin_id,
            "modules": ", ".join(self.modules),
            "module_count": str(len(self.modules)) if self.modules else "",
            "package_name": str(self.package.get("name", "")),
            "package_version": str(self.package.get("version", "")),
            "package_bin": ", ".join(sorted(self.package.get("bin", {})))
                           if isinstance(self.package.get("bin"), dict)
                           else str(self.package.get("bin", "")),
            "dependencies": ", ".join(sorted(self.package.get("dependencies", {})))
                            if isinstance(self.package.get("dependencies"), dict) else "",
        })
        return table


def badge_build(ctx):
    host = ctx.get("builds_host")
    if not host:
        return None
    return ("[![Build Status](https://{host}/{org}/{repo}/{branch}/badge.svg)]"
            "(https://{host}/{org}/{repo}/{branch})").format(
        host=host, org=ctx.org, repo=ctx.repo, branch=ctx.get("builds_branch"))


def badge_downloads(ctx):
    return ("![GitHub Downloads (all assets, all releases)]"
            "(https://img.shields.io/github/downloads/%s/%s/total)" % (ctx.org, ctx.repo))


def badge_followers(ctx):
    return ("[![GitHub Followers](https://img.shields.io/github/followers/%s?style=social)]"
            "(https://github.com/%s)" % (ctx.org, ctx.org))


def badge_stars(ctx):
    return ("[![GitHub Stars](https://img.shields.io/github/stars/%s/%s?style=social)]"
            "(https://github.com/%s/%s)" % (ctx.org, ctx.repo, ctx.org, ctx.repo))


def badge_bstats(ctx):
    bstats_id = ctx.get("bstats")
    if not bstats_id:
        return None
    # The signature SVG is keyed by the bStats plugin name, which may contain spaces and may
    # differ from the repo name; an unencoded space breaks the badge and a wrong name resolves
    # to a different plugin's graph.
    name = urllib.parse.quote(ctx.get("bstats_name") or ctx.repo)
    return ("[![bStats](https://bStats.org/signatures/bukkit/%s.svg)]"
            "(https://bStats.org/plugin/bukkit/%s/%s)" % (name, name, bstats_id))


def badge_license(ctx):
    if not ctx.license_name:
        return None
    return ("[![%s](https://img.shields.io/badge/License-%s-blue.svg)](LICENSE)"
            % (ctx.license_name, ctx.license_slug))


def badge_release(ctx):
    return ("[![Latest Release](https://img.shields.io/github/v/release/%s/%s)]"
            "(https://github.com/%s/%s/releases/latest)" % (ctx.org, ctx.repo, ctx.org, ctx.repo))


def badge_npm_version(ctx):
    name = ctx.package.get("name")
    if not name:
        return None
    slug = urllib.parse.quote(str(name), safe="")
    return ("[![npm version](https://img.shields.io/npm/v/%s)](https://www.npmjs.com/package/%s)"
            % (slug, slug))


def badge_npm_downloads(ctx):
    name = ctx.package.get("name")
    if not name:
        return None
    slug = urllib.parse.quote(str(name), safe="")
    return ("[![npm downloads](https://img.shields.io/npm/dm/%s)](https://www.npmjs.com/package/%s)"
            % (slug, slug))


BADGES = {
    "build": badge_build,
    "downloads": badge_downloads,
    "followers": badge_followers,
    "stars": badge_stars,
    "bstats": badge_bstats,
    "license": badge_license,
    "release": badge_release,
    "npm-version": badge_npm_version,
    "npm-downloads": badge_npm_downloads,
}


def render_logo(ctx):
    logo = ctx.get("logo")
    if not logo:
        return None
    return '<p align="center">\n<img width="800" src="%s"><br><br>\n</p>' % logo


def render_title(ctx):
    return "# " + ctx.title


def render_badges(ctx):
    lines = []
    for badge_id in ctx.get_list("badges"):
        if badge_id not in BADGES:
            warn("unknown badge %r in %s (known: %s)"
                 % (badge_id, CONFIG_PATH, ", ".join(sorted(BADGES))))
            continue
        rendered = BADGES[badge_id](ctx)
        if rendered:
            lines.append(rendered)
    return "\n".join(lines) if lines else None


def render_description(ctx):
    return ctx.description or None


def render_requirements(ctx):
    items = ctx.get_list("requirements")
    if not items:
        return None
    return "## Requirements\n" + "\n".join("- " + item for item in items)


def render_content(ctx):
    if not ctx.content:
        return None
    intro = ctx.get("content_intro")
    return (intro + "\n\n" + ctx.content) if intro else ctx.content


def render_developer_api(ctx):
    if ctx.get("developer_api_text"):
        return "## Developer API\n\n" + ctx.get("developer_api_text")
    return (
        "## Developer API\n\n"
        "You can easily depend on this project using [github-gradle](%s).\n\n"
        "In your `build.gradle.kts`:\n\n"
        "```kotlin\n"
        "plugins {\n"
        '    id("%s") version "%s"\n'
        "}\n\n"
        "dependencies {\n"
        '    "githubCompileOnly"("%s:%s:%s")\n'
        "}\n"
        "```"
    ) % (ctx.get("gradle_plugin_url"), ctx.get("gradle_plugin_id"), ctx.get("gradle_plugin"),
         ctx.org, ctx.artifact, ctx.tag)


def render_wiki(ctx):
    text = ctx.get("wiki_text")
    if not text or not ctx.get("wiki_base"):
        return None
    return "## Wiki\n\n" + text


def render_discord(ctx):
    invite = ctx.get("discord")
    guild = ctx.get("discord_guild")
    if not invite or not guild:
        return None
    return (
        "## Discord\n\n%s\n\n"
        '<p align="center">\n'
        '  <a href="%s">\n'
        '    <img src="https://discordapp.com/api/guilds/%s/widget.png?style=banner2" alt="Discord"/>\n'
        "  </a>\n"
        "</p>"
    ) % (ctx.get("discord_text"), invite, guild)


def render_license_prose(ctx):
    if not ctx.license_name:
        return None
    return "## License\n\nThis project is open-source and licensed under the %s." % ctx.license_name


def render_license_badge(ctx):
    badge = badge_license(ctx)
    return ("## License\n\n" + badge) if badge else None


def render_releases(ctx):
    return ctx.get("releases_text")


def render_about(ctx):
    if not ctx.description:
        return None
    return "## %s\n\n%s" % (ctx.get("about_heading"), ctx.description)


def render_plugin_usage(ctx):
    plugin_id = ctx.plugin_id
    return (
        "## Usage\n\n"
        "Using the plugins DSL:\n\n"
        "```groovy\n"
        "plugins {\n"
        '    id "%s" version "%s"\n'
        "}\n"
        "```\n\n"
        "Using legacy plugin application:\n\n"
        "```groovy\n"
        "buildscript {\n"
        "    repositories {\n"
        "        maven {\n"
        '            url "https://plugins.gradle.org/m2/"\n'
        "        }\n"
        "    }\n"
        "    dependencies {\n"
        '        classpath "%s:%s"\n'
        "    }\n"
        "}\n\n"
        'apply plugin: "%s"\n'
        "```"
    ) % (plugin_id, ctx.tag, plugin_id, ctx.tag, plugin_id)


def render_library_usage_private(ctx):
    group = ctx.maven_group
    return (
        "## Usage in private projects\n\n"
        " * Maven (inside the `pom.xml` file)\n"
        "```xml\n"
        "  <repository>\n"
        "      <id>github</id>\n"
        "      <url>https://maven.pkg.github.com/%s/%s</url>\n"
        "      <snapshots><enabled>true</enabled></snapshots>\n"
        "  </repository>\n"
        "  <dependency>\n"
        "      <groupId>%s</groupId>\n"
        "      <artifactId>%s</artifactId>\n"
        "      <version>%s</version>\n"
        "  </dependency>\n"
        "```\n\n"
        " * Maven (inside the `settings.xml` file)\n"
        "```xml\n"
        "  <servers>\n"
        "      <server>\n"
        "          <id>github</id>\n"
        "          <username>your-username</username>\n"
        "          <password>your-access-token</password>\n"
        "      </server>\n"
        "  </servers>\n"
        "```\n\n"
        " * Gradle (inside the `build.gradle.kts` or `build.gradle` file)\n"
        "```groovy\n"
        "  repositories {\n"
        "      maven {\n"
        '          url "https://maven.pkg.github.com/%s/%s"\n'
        "          credentials {\n"
        '              username = "<your-username>"\n'
        '              password = "<your-access-token>"\n'
        "          }\n"
        "      }\n"
        "  }\n"
        "  dependencies {\n"
        "      implementation '%s:%s:%s'\n"
        "  }\n"
        "```"
    ) % (ctx.org, ctx.repo, group, ctx.artifact, ctx.tag,
         ctx.org, ctx.repo, group, ctx.artifact, ctx.tag)


def render_library_usage_public(ctx):
    return (
        "## Usage in public projects\n\n"
        " * Gradle (inside the `build.gradle.kts` or `build.gradle` file)\n"
        "```groovy\n"
        "  plugins {\n"
        '      id "%s" version "%s"\n'
        "  }\n"
        "  dependencies {\n"
        '      githubImplementation "%s:%s:%s"\n'
        "  }\n"
        "```"
    ) % (ctx.get("gradle_plugin_id"), ctx.get("dependency_plugin_version"),
         ctx.org, ctx.artifact, ctx.tag)


def render_modules(ctx):
    modules = ctx.modules
    if len(modules) < 2:
        return None
    lines = [
        "## Modules",
        "",
        "`%s` is published as separate modules. Pull every module at once with the `all` classifier:"
        % ctx.artifact,
        "",
        "```groovy",
        "dependencies {",
        '    githubImplementation "%s:%s:%s:all"' % (ctx.org, ctx.artifact, ctx.tag),
        "}",
        "```",
        "",
        "Or depend on individual modules:",
        "",
        "```groovy",
        "dependencies {",
    ]
    for module in modules:
        lines.append('    githubImplementation "%s:%s:%s:%s"' % (ctx.org, ctx.artifact, ctx.tag, module))
    lines += ["}", "```"]
    return "\n".join(lines)


def render_npm_install(ctx):
    name = ctx.package.get("name")
    if not name:
        return None
    body = ["## Installation", "", "```bash", "npm install %s" % name, "```"]
    binaries = ctx.package.get("bin")
    if isinstance(binaries, dict) and binaries:
        body += ["", "It installs the `%s` command." % "`, `".join(sorted(binaries))]
    elif isinstance(binaries, str) and binaries:
        body += ["", "It installs the `%s` command." % name]
    return "\n".join(body)


SECTIONS = [
    ("logo", render_logo),
    ("title", render_title),
    ("badges", render_badges),
    ("description", render_description),
    ("requirements", render_requirements),
    ("releases", render_releases),
    ("about", render_about),
    ("plugin-usage", render_plugin_usage),
    ("library-usage-private", render_library_usage_private),
    ("library-usage-public", render_library_usage_public),
    ("modules", render_modules),
    ("npm-install", render_npm_install),
    ("content", render_content),
    ("developer-api", render_developer_api),
    ("wiki", render_wiki),
    ("discord", render_discord),
    ("license-prose", render_license_prose),
    ("license-badge", render_license_badge),
]


def register_section(section_id, renderer, after=None):
    """Insert a renderer into the registry, immediately after ``after`` when given."""
    if any(existing == section_id for existing, _ in SECTIONS):
        raise ValueError("section %r is already registered" % section_id)
    index = len(SECTIONS)
    if after:
        for position, (existing, _) in enumerate(SECTIONS):
            if existing == after:
                index = position + 1
                break
    SECTIONS.insert(index, (section_id, renderer))


def renderer_for(section_id):
    for existing, renderer in SECTIONS:
        if existing == section_id:
            return renderer
    raise KeyError("no renderer registered for section %r" % section_id)


def build_config(kind, overrides):
    config = dict(COMMON_DEFAULTS)
    config.update(kind.defaults)
    config.update(overrides)
    return config


def fallback_tag(config):
    return (read_properties("gradle.properties").get("artifact_version", "")
            or str(read_json("package.json").get("version", ""))
            or config["tag_fallback"])


def build_context(repository, tag=None, offline=False, token=None, default_branch=""):
    org, repo = repository.split("/")
    overrides = parse_config(CONFIG_PATH)
    kind_name = overrides.get("kind") or detect_kind()
    if kind_name not in KINDS:
        raise SystemExit("unknown kind %r in %s (known: %s)"
                         % (kind_name, CONFIG_PATH, ", ".join(sorted(KINDS))))
    kind = KINDS[kind_name]
    config = build_config(kind, overrides)
    if default_branch:
        config["default_branch"] = default_branch

    if not tag:
        tag = (fallback_tag(config) if offline
               else fetch_latest_tag(repository, config["tag_filter"], fallback_tag(config), token))

    release = {} if offline else fetch_release(repository, tag, token)
    known_branch = offline or config["default_branch"]
    repository_meta = {} if known_branch else fetch_repository(repository, token)

    return Context(org, repo, kind_name, kind, config, read_file("CONTENT.md"),
                   tag, release, repository_meta)


def render(ctx):
    parts = []
    for section_id in ctx.get_list("sections") or ctx.kind.sections:
        rendered = renderer_for(section_id)(ctx)
        if rendered and rendered.strip():
            parts.append(rendered.strip())
    return substitute("\n\n".join(parts), ctx.placeholders()) + "\n"


def generate(repository, tag=None, offline=False, token=None, default_branch=""):
    ctx = build_context(repository, tag, offline, token, default_branch)
    return render(ctx), ctx.tag


def main():
    parser = argparse.ArgumentParser(description="Generate README.md")
    parser.add_argument("--repository", required=True)
    parser.add_argument("--tag", default=os.environ.get("README_TAG", ""),
                        help="release tag to document; skips the GitHub API lookup")
    parser.add_argument("--default-branch", default=os.environ.get("README_DEFAULT_BRANCH", ""),
                        help="branch the README is generated on; skips the GitHub API lookup")
    parser.add_argument("--offline", action="store_true",
                        default=bool(os.environ.get("README_OFFLINE")),
                        help="never reach the GitHub API; use the configured tag fallback")
    parser.add_argument("--output", default="README.md")
    parser.add_argument("--stdout", action="store_true")
    parser.add_argument("--placeholders", action="store_true",
                        help="print every {{ placeholder }} this repository resolves, then exit")
    args = parser.parse_args()

    if args.placeholders:
        ctx = build_context(args.repository, args.tag, args.offline,
                            os.environ.get("GITHUB_TOKEN"), args.default_branch)
        for name, value in sorted(ctx.placeholders().items()):
            sys.stdout.write("{{ %s }} = %s\n" % (name, value if value else "(unset)"))
        return

    if not os.path.exists(CONFIG_PATH):
        raise SystemExit("%s is missing: this repository has no README spec" % CONFIG_PATH)

    readme, tag = generate(args.repository, args.tag, args.offline,
                           os.environ.get("GITHUB_TOKEN"), args.default_branch)

    if args.stdout:
        sys.stdout.write(readme)
        return
    with open(args.output, "w", encoding="utf-8", newline="\n") as handle:
        handle.write(readme)
    print("Generated %s for %s (tag: %s)" % (args.output, args.repository, tag))


if __name__ == "__main__":
    main()
