#!/usr/bin/env python3
"""Generate README.md from .github/docs-config.yml plus CONTENT.md.

Usage: python3 generate-readme.py --repository Slimefun5/SlimeTinker

Reads from CWD:
  .github/docs-config.yml -> kind + every setting below
  gradle.properties       -> display_name, description fallbacks
  CONTENT.md              -> the repository's own prose
  LICENSE*                -> license name, unless configured

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

COMMON_DEFAULTS = {
    "kind": "addon",
    "logo": "",
    "description": "",
    "description_fallback": "",
    "license": "",
    "license_default": "GNU General Public License v3.0",
    "license_badge": "",
    "content_intro": "",
    "tag_filter": "",
    "tag_fallback": "v1.0.0",
    "releases_text": "Archives containing JAR files are available as "
                     "[releases](https://github.com/{org}/{repo}/releases).",
    "java": "25",
    "paper": "1.16.* - 26.1.*",
    "core_repos": "slimefun5,slimefun",
    "core_requirement": "[Slimefun 5](https://github.com/Slimefun5/Slimefun5)",
    "builds_host": "Slimefun5.github.io/builds",
    "builds_branch": "stable",
    "bstats": "",
    "bstats_name": "",
    "gradle_plugin": "1.8.2.1",
    "gradle_plugin_id": "io.github.intisy.github-gradle",
    "gradle_plugin_url": "https://github.com/intisy/github-gradle",
    "wiki_base": "https://github.com/Slimefun5/Wiki/wiki",
    "discord": "https://discord.gg/CbBYZBEWdR",
    "discord_guild": "738626600539160576",
    "discord_text": "You can find Slimefun's community on Discord! Click the badge below to join "
                    "the server for suggestions/questions or other discussions about this plugin.",
    "plugin_namespace": "io.github.{org}",
    "maven_group": "io.github.{org}",
    "dependency_plugin_version": "1.3.7",
}

NUMERIC_TAG_FILTER = r"^[0-9]+(\.[0-9]+)*$"


class Kind:
    def __init__(self, sections, title_source, defaults=None):
        self.sections = sections
        self.title_source = title_source
        self.defaults = defaults or {}


KINDS = {
    "addon": Kind(
        sections=["logo", "title", "badges", "description", "requirements", "content",
                  "developer-api", "wiki", "discord", "license-prose"],
        title_source="repo",
        defaults={"description_fallback": "A Slimefun 5 Addon."},
    ),
    "gradle-plugin": Kind(
        sections=["title", "releases", "about", "plugin-usage", "content", "license-badge"],
        title_source="display_name",
        defaults={
            "license_default": "Apache License 2.0",
            "tag_filter": NUMERIC_TAG_FILTER,
            "tag_fallback": "1.0.0",
            "content_intro": "Once you have the plugin installed you can use it like so:",
        },
    ),
    "java-library": Kind(
        sections=["title", "releases", "about", "library-usage-private", "library-usage-public",
                  "modules", "content", "license-badge"],
        title_source="display_name",
        defaults={
            "license_default": "Apache License 2.0",
            "tag_filter": NUMERIC_TAG_FILTER,
            "tag_fallback": "1.0.0",
            "content_intro": "Once you have it installed you can use it like so:",
        },
    ),
    "workflows": Kind(
        sections=["title", "description", "content", "license-badge"],
        title_source="repo",
        defaults={"license_default": "Apache License 2.0"},
    ),
}


def parse_config(path):
    """Parse flat key-value YAML without requiring pyyaml."""
    config = {}
    if not os.path.exists(path):
        return config
    with open(path, encoding="utf-8") as handle:
        for line in handle:
            line = line.strip()
            if not line or line.startswith("#"):
                continue
            if ":" in line:
                key, _, value = line.partition(":")
                key = key.strip()
                value = value.strip().strip('"').strip("'")
                if value:
                    config[key] = value
    return config


def read_properties_value(path, key):
    if not os.path.exists(path):
        return ""
    with open(path, encoding="utf-8") as handle:
        for line in handle:
            line = line.strip().replace("\r", "")
            if line.startswith(key + "="):
                return line.split("=", 1)[1]
    return ""


def read_file(path):
    if not os.path.exists(path):
        return ""
    with open(path, encoding="utf-8") as handle:
        return handle.read().strip()


def detect_license(config):
    """Explicit ``license`` key, else the checked-out LICENSE file, else the kind's default."""
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

    return config["license_default"]


def api_json(url, token=None):
    headers = {"User-Agent": "readme-generator"}
    if token:
        headers["Authorization"] = "token " + token
    request = urllib.request.Request(url, headers=headers)
    with urllib.request.urlopen(request, timeout=10) as response:
        return json.loads(response.read())


def version_key(tag):
    return [int(part) for part in tag.split(".")]


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


def fetch_modules(repository, repo, tag, token=None):
    """Classifier names of a multi-module release, sources/javadoc excluded."""
    try:
        data = api_json(
            "https://api.github.com/repos/%s/releases/tags/%s" % (repository, urllib.parse.quote(tag)),
            token,
        )
    except Exception:
        return []
    assets = data.get("assets") if isinstance(data, dict) else None
    if not isinstance(assets, list):
        return []
    pattern = re.compile(r"^%s-(.+)\.jar$" % re.escape(repo))
    modules = set()
    for asset in assets:
        match = pattern.match(str(asset.get("name", "")))
        if match and match.group(1) not in ("sources", "javadoc"):
            modules.add(match.group(1))
    return sorted(modules)


class Context:
    def __init__(self, org, repo, kind, config, content, tag, modules):
        self.org = org
        self.repo = repo
        self.kind = kind
        self.config = config
        self.content = content
        self.tag = tag
        self.modules = modules

    def get(self, key):
        value = str(self.config.get(key, ""))
        return value.replace("{org}", self.org).replace("{repo}", self.repo)

    @property
    def description(self):
        return (self.get("description")
                or read_properties_value("gradle.properties", "description")
                or read_properties_value("gradle.properties", "artifact_description")
                or self.get("description_fallback"))

    @property
    def title(self):
        if self.config.get("title"):
            return self.get("title")
        if self.kind.title_source == "display_name":
            return read_properties_value("gradle.properties", "display_name") or self.repo
        return self.repo


def render_logo(ctx):
    logo = ctx.get("logo")
    if not logo:
        return None
    return '<p align="center">\n<img width="800" src="%s"><br><br>\n</p>' % logo


def render_title(ctx):
    return "# " + ctx.title


def render_badges(ctx):
    host = ctx.get("builds_host")
    branch = ctx.get("builds_branch")
    badges = (
        "[![Build Status](https://{host}/{org}/{repo}/{branch}/badge.svg)]"
        "(https://{host}/{org}/{repo}/{branch})\n"
        "![GitHub Downloads (all assets, all releases)]"
        "(https://img.shields.io/github/downloads/{org}/{repo}/total)\n"
        "[![GitHub Followers](https://img.shields.io/github/followers/{org}?style=social)]"
        "(https://github.com/{org})\n"
        "[![GitHub Stars](https://img.shields.io/github/stars/{org}/{repo}?style=social)]"
        "(https://github.com/{org}/{repo})"
    ).format(host=host, org=ctx.org, repo=ctx.repo, branch=branch)

    bstats_id = ctx.get("bstats")
    if bstats_id:
        # The signature SVG is keyed by the bStats plugin name, which may contain spaces and may
        # differ from the repo name; an unencoded space breaks the badge and a wrong name resolves
        # to a different plugin's graph.
        name = urllib.parse.quote(ctx.get("bstats_name") or ctx.repo)
        badges += (
            "\n[![bStats](https://bStats.org/signatures/bukkit/%s.svg)]"
            "(https://bStats.org/plugin/bukkit/%s/%s)" % (name, name, bstats_id)
        )
    return badges


def render_description(ctx):
    return ctx.description or None


def render_requirements(ctx):
    lines = "## Requirements\n- Java %s\n- Paper %s" % (ctx.get("java"), ctx.get("paper"))
    core_repos = [name.strip().lower() for name in ctx.get("core_repos").split(",") if name.strip()]
    if ctx.repo.lower() not in core_repos:
        lines += "\n- " + ctx.get("core_requirement")
    return lines


def render_content(ctx):
    if not ctx.content:
        return None
    intro = ctx.get("content_intro")
    return (intro + "\n\n" + ctx.content) if intro else ctx.content


def render_developer_api(ctx):
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
         ctx.org, ctx.repo, ctx.tag)


def render_wiki(ctx):
    return "## Wiki\n\n[Read more on the Slimefun Wiki...](%s/%s)" % (ctx.get("wiki_base"), ctx.repo)


def render_discord(ctx):
    return (
        "## Discord\n\n%s\n\n"
        '<p align="center">\n'
        '  <a href="%s">\n'
        '    <img src="https://discordapp.com/api/guilds/%s/widget.png?style=banner2" alt="Discord"/>\n'
        "  </a>\n"
        "</p>"
    ) % (ctx.get("discord_text"), ctx.get("discord"), ctx.get("discord_guild"))


def render_license_prose(ctx):
    return "## License\n\nThis project is open-source and licensed under the %s." % detect_license(ctx.config)


def render_license_badge(ctx):
    name = detect_license(ctx.config)
    slug = ctx.get("license_badge") or LICENSE_BADGE_SLUGS.get(name, name.replace(" ", "_"))
    return ("## License\n\n[![%s](https://img.shields.io/badge/License-%s-blue.svg)](LICENSE)"
            % (name, slug))


def render_releases(ctx):
    return ctx.get("releases_text")


def render_about(ctx):
    if not ctx.description:
        return None
    return "## What is %s?\n\n%s" % (ctx.repo, ctx.description)


def render_plugin_usage(ctx):
    plugin_id = "%s.%s" % (ctx.get("plugin_namespace"), ctx.repo)
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
    group = ctx.get("maven_group")
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
    ) % (ctx.org, ctx.repo, group, ctx.repo, ctx.tag, ctx.org, ctx.repo, group, ctx.repo, ctx.tag)


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
         ctx.org, ctx.repo, ctx.tag)


def render_modules(ctx):
    if len(ctx.modules) < 2:
        return None
    lines = [
        "## Modules",
        "",
        "`%s` is published as separate modules. Pull every module at once with the `all` classifier:"
        % ctx.repo,
        "",
        "```groovy",
        "dependencies {",
        '    githubImplementation "%s:%s:%s:all"' % (ctx.org, ctx.repo, ctx.tag),
        "}",
        "```",
        "",
        "Or depend on individual modules:",
        "",
        "```groovy",
        "dependencies {",
    ]
    for module in ctx.modules:
        lines.append('    githubImplementation "%s:%s:%s:%s"' % (ctx.org, ctx.repo, ctx.tag, module))
    lines += ["}", "```"]
    return "\n".join(lines)


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


def build_config(kind):
    config = dict(COMMON_DEFAULTS)
    config.update(kind.defaults)
    config.update(parse_config(CONFIG_PATH))
    return config


def generate(repository, tag=None, offline=False, token=None, modules=None):
    org, repo = repository.split("/")
    kind_name = parse_config(CONFIG_PATH).get("kind", COMMON_DEFAULTS["kind"])
    if kind_name not in KINDS:
        raise SystemExit("unknown kind %r in %s (known: %s)"
                         % (kind_name, CONFIG_PATH, ", ".join(sorted(KINDS))))
    kind = KINDS[kind_name]
    config = build_config(kind)

    if not tag:
        tag = (config["tag_fallback"] if offline
               else fetch_latest_tag(repository, config["tag_filter"], config["tag_fallback"], token))
    if modules is None:
        modules = [] if offline else fetch_modules(repository, repo, tag, token)

    ctx = Context(org, repo, kind, config, read_file("CONTENT.md"), tag, modules)

    parts = []
    for section_id in kind.sections:
        rendered = renderer_for(section_id)(ctx)
        if rendered and rendered.strip():
            parts.append(rendered.strip())
    return "\n\n".join(parts) + "\n", tag


def main():
    parser = argparse.ArgumentParser(description="Generate README.md")
    parser.add_argument("--repository", required=True)
    parser.add_argument("--tag", default=os.environ.get("README_TAG", ""),
                        help="release tag to document; skips the GitHub API lookup")
    parser.add_argument("--offline", action="store_true",
                        default=bool(os.environ.get("README_OFFLINE")),
                        help="never reach the GitHub API; use the configured tag fallback")
    parser.add_argument("--output", default="README.md")
    parser.add_argument("--stdout", action="store_true")
    args = parser.parse_args()

    if not os.path.exists(CONFIG_PATH):
        raise SystemExit("%s is missing: this repository has no README spec" % CONFIG_PATH)

    readme, tag = generate(args.repository, args.tag, args.offline, os.environ.get("GITHUB_TOKEN"))

    if args.stdout:
        sys.stdout.write(readme)
        return
    with open(args.output, "w", encoding="utf-8", newline="\n") as handle:
        handle.write(readme)
    print("Generated %s for %s (tag: %s)" % (args.output, args.repository, tag))


if __name__ == "__main__":
    main()
