#!/usr/bin/env python3
"""Offline tests for generate-readme.py.

Run from the repository root: python3 -m unittest discover -s .github/scripts -v
"""

import contextlib
import importlib.util
import io
import os
import tempfile
import unittest

SCRIPT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "generate-readme.py")
SPEC = importlib.util.spec_from_file_location("generate_readme", SCRIPT)
generator = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(generator)

APACHE = "Apache License 2.0\nVersion 2.0, January 2004\n"
GPL3 = "GNU GENERAL PUBLIC LICENSE\nVersion 3, 29 June 2007\n"


@contextlib.contextmanager
def repository(files):
    previous = os.getcwd()
    with tempfile.TemporaryDirectory() as directory:
        for name, body in files.items():
            path = os.path.join(directory, name)
            parent = os.path.dirname(path)
            if parent:
                os.makedirs(parent, exist_ok=True)
            with open(path, "w", encoding="utf-8", newline="\n") as handle:
                handle.write(body)
        os.chdir(directory)
        try:
            yield directory
        finally:
            os.chdir(previous)


def build(files, repo="owner/name", tag=None):
    errors = io.StringIO()
    with repository(files):
        with contextlib.redirect_stderr(errors):
            readme, resolved = generator.generate(repo, tag=tag, offline=True)
    return readme, resolved, errors.getvalue()


def config(**pairs):
    return "\n".join("%s: %s" % (key, value) for key, value in pairs.items()) + "\n"


class ConfigParsingTest(unittest.TestCase):
    def parse(self, body):
        with repository({".github/docs-config.yml": body}):
            return generator.parse_config(generator.CONFIG_PATH)

    def test_scalars_comments_and_quotes(self):
        parsed = self.parse('# a comment\nkind: "addon"\njava: \'25\'\n\nempty:\n')
        self.assertEqual({"kind": "addon", "java": "25"}, parsed)

    def test_value_keeps_everything_after_the_first_colon(self):
        parsed = self.parse("description: A library: for things\n")
        self.assertEqual("A library: for things", parsed["description"])

    def test_list_values(self):
        parsed = self.parse("badges:\n  - stars\n  - downloads\nkind: generic\n")
        self.assertEqual(["stars", "downloads"], parsed["badges"])
        self.assertEqual("generic", parsed["kind"])

    def test_empty_key_without_items_stays_absent(self):
        self.assertEqual({}, self.parse("badges:\n"))


class KindDetectionTest(unittest.TestCase):
    def detect(self, files):
        with repository(files):
            return generator.detect_kind()

    def test_plugin_descriptor_means_addon(self):
        self.assertEqual("addon", self.detect({"src/main/resources/plugin.yml": "name: X\n"}))

    def test_nested_module_plugin_descriptor_means_addon(self):
        self.assertEqual("addon", self.detect({"core/src/main/resources/plugin.yml": "name: X\n"}))

    def test_build_output_is_not_searched(self):
        self.assertEqual("generic", self.detect({"build/src/main/resources/plugin.yml": "name: X\n"}))

    def test_gradle_project_means_java_library(self):
        self.assertEqual("java-library", self.detect({"gradle.properties": "display_name=X\n"}))

    def test_package_json_means_npm_package(self):
        self.assertEqual("npm-package", self.detect({"package.json": '{"name": "x"}'}))

    def test_nothing_recognisable_means_generic(self):
        self.assertEqual("generic", self.detect({"CONTENT.md": "hi\n"}))


class SectionSelectionTest(unittest.TestCase):
    def test_addon_sections(self):
        readme, _, _ = build({
            ".github/docs-config.yml": config(kind="addon", bstats="42"),
            "CONTENT.md": "Addon prose.\n",
            "LICENSE": GPL3,
        }, tag="v1.2.3")
        for expected in ("# name", "bStats", "## Requirements", "- Java",
                         "Addon prose.", "## Developer API", "## Wiki", "## Discord",
                         "licensed under the GNU General Public License v3.0"):
            self.assertIn(expected, readme)

    def test_gradle_plugin_sections(self):
        readme, _, _ = build({
            ".github/docs-config.yml": config(kind="gradle-plugin", description="A plugin."),
            "CONTENT.md": "Plugin prose.\n",
        }, tag="1.2.3")
        self.assertIn("## What is name?", readme)
        self.assertIn('id "io.github.owner.name" version "1.2.3"', readme)
        self.assertIn("Once you have the plugin installed", readme)
        self.assertNotIn("## Requirements", readme)
        self.assertNotIn("## Discord", readme)

    def test_java_library_sections(self):
        readme, _, _ = build({
            ".github/docs-config.yml": config(kind="java-library", description="A library."),
        }, tag="1.2.3")
        self.assertIn("## Usage in private projects", readme)
        self.assertIn("## Usage in public projects", readme)
        self.assertIn("<artifactId>name</artifactId>", readme)
        self.assertNotIn("## Modules", readme)

    def test_npm_package_sections(self):
        readme, _, _ = build({
            ".github/docs-config.yml": config(kind="npm-package"),
            "package.json": '{"name": "@scope/tool", "description": "A tool.",'
                            ' "license": "MIT", "bin": {"tool": "dist/cli.js"}}',
        }, tag="1.0.0")
        self.assertIn("# @scope/tool", readme)
        self.assertIn("npm install @scope/tool", readme)
        self.assertIn("It installs the `tool` command.", readme)
        self.assertIn("img.shields.io/npm/v/%40scope%2Ftool", readme)
        self.assertIn("License-MIT-blue", readme)

    def test_generic_sections(self):
        readme, _, _ = build({
            ".github/docs-config.yml": config(kind="generic", title="Thing", description="Does things."),
            "CONTENT.md": "Generic prose.\n",
            "LICENSE": APACHE,
        })
        self.assertEqual("# Thing\n\nDoes things.\n\nGeneric prose.\n\n## License\n\n"
                         "[![Apache License 2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)]"
                         "(LICENSE)\n", readme)

    def test_config_overrides_the_section_order(self):
        readme, _, _ = build({
            ".github/docs-config.yml": "kind: addon\nsections:\n  - title\n  - content\n",
            "CONTENT.md": "Only this.\n",
        })
        self.assertEqual("# name\n\nOnly this.\n", readme)

    def test_unknown_kind_is_rejected(self):
        with self.assertRaises(SystemExit):
            build({".github/docs-config.yml": config(kind="nonsense")})

    def test_unknown_section_is_rejected(self):
        with self.assertRaises(KeyError):
            build({".github/docs-config.yml": "sections:\n  - nonsense\n"})


class RequirementsTest(unittest.TestCase):
    def test_addon_default_requires_the_core_plugin(self):
        readme, _, _ = build({".github/docs-config.yml": config(kind="addon", java="21")})
        self.assertIn("- Java 21", readme)
        self.assertIn("- [Slimefun 5](https://github.com/Slimefun5/Slimefun5)", readme)

    def test_configured_requirements_replace_the_defaults(self):
        readme, _, _ = build({
            ".github/docs-config.yml": "kind: addon\njava: \"21\"\nrequirements:\n"
                                       "  - Java {{ java }}\n  - Paper {{ paper }}\n",
        })
        self.assertIn("## Requirements\n- Java 21\n- Paper 1.16.* - 26.1.*", readme)
        self.assertNotIn("Slimefun 5](", readme)

    def test_a_kind_without_requirements_renders_no_heading(self):
        readme, _, _ = build({".github/docs-config.yml": "kind: generic\n"
                                                         "sections:\n  - title\n  - requirements\n"})
        self.assertEqual("# name\n", readme)


class PlaceholderTest(unittest.TestCase):
    def test_known_placeholders_resolve(self):
        readme, _, errors = build({
            ".github/docs-config.yml": config(kind="generic", description="d"),
            "CONTENT.md": "v{{ version }} of {{ repository }} under {{ license }}.\n",
            "LICENSE": APACHE,
        }, tag="v2.1.0")
        self.assertIn("v2.1.0 of owner/name under Apache License 2.0.", readme)
        self.assertEqual("", errors)

    def test_unknown_placeholder_stays_visible_and_is_reported(self):
        readme, _, errors = build({
            ".github/docs-config.yml": config(kind="generic"),
            "CONTENT.md": "See {{ nonsense }}.\n",
        })
        self.assertIn("See {{ nonsense }}.", readme)
        self.assertIn("unknown placeholder {{ nonsense }}", errors)

    def test_known_but_empty_placeholder_stays_visible_and_is_reported(self):
        readme, _, errors = build({
            ".github/docs-config.yml": config(kind="generic"),
            "CONTENT.md": "Logo: {{ logo }}.\n",
        })
        self.assertIn("Logo: {{ logo }}.", readme)
        self.assertIn("placeholder {{ logo }} has no value", errors)

    def test_actions_expressions_are_left_alone(self):
        readme, _, errors = build({
            ".github/docs-config.yml": config(kind="generic"),
            "CONTENT.md": "uses: ${{ github.repository }}\n",
        })
        self.assertIn("${{ github.repository }}", readme)
        self.assertEqual("", errors)

    def test_backslash_escapes_a_placeholder(self):
        readme, _, errors = build({
            ".github/docs-config.yml": config(kind="generic"),
            "CONTENT.md": "Write \\{{ version }} to interpolate.\n",
        })
        self.assertIn("Write {{ version }} to interpolate.", readme)
        self.assertEqual("", errors)

    def test_config_settings_are_placeholders_too(self):
        readme, _, _ = build({
            ".github/docs-config.yml": config(kind="generic", paper="1.21", description="d"),
            "CONTENT.md": "Targets Paper {{ paper }}.\n",
        })
        self.assertIn("Targets Paper 1.21.", readme)

    def test_placeholder_table_covers_the_documented_names(self):
        with repository({".github/docs-config.yml": config(kind="java-library")}):
            table = generator.build_context("owner/name", tag="1.0.0", offline=True).placeholders()
        for name in ("org", "repo", "repository", "tag", "version", "title", "description",
                     "license", "license_slug", "artifact", "group", "plugin_id", "modules",
                     "default_branch", "repo_url", "releases_url", "release_url", "release_date",
                     "kind", "package_name", "package_version", "package_bin", "dependencies"):
            self.assertIn(name, table)


class MetadataFallbackTest(unittest.TestCase):
    def test_gradle_properties_supply_title_description_and_group(self):
        readme, _, _ = build({
            ".github/docs-config.yml": config(kind="java-library"),
            "gradle.properties": "display_name=Nice Name\nartifact_description=Does things.\n"
                                 "artifact_group=io.github.other\n",
        }, tag="1.0.0")
        self.assertIn("# Nice Name", readme)
        self.assertIn("## What is name?\n\nDoes things.", readme)
        self.assertIn("<groupId>io.github.other</groupId>", readme)

    def test_missing_gradle_properties_falls_back_to_the_repository_name(self):
        readme, _, _ = build({".github/docs-config.yml": config(kind="java-library")}, tag="1.0.0")
        self.assertIn("# name", readme)
        self.assertIn("<groupId>io.github.owner</groupId>", readme)
        self.assertNotIn("## What is", readme)

    def test_package_json_supplies_the_description(self):
        readme, _, _ = build({
            ".github/docs-config.yml": config(kind="generic"),
            "package.json": '{"name": "tool", "description": "From npm."}',
        })
        self.assertIn("From npm.", readme)

    def test_addon_description_falls_back_to_the_kind_default(self):
        readme, _, _ = build({".github/docs-config.yml": config(kind="addon")})
        self.assertIn("A Slimefun 5 Addon.", readme)

    def test_offline_tag_falls_back_to_the_declared_version(self):
        _, tag, _ = build({
            ".github/docs-config.yml": config(kind="java-library"),
            "gradle.properties": "artifact_version=3.4.5\n",
        })
        self.assertEqual("3.4.5", tag)

    def test_offline_tag_falls_back_to_the_kind_default_without_a_version(self):
        _, tag, _ = build({".github/docs-config.yml": config(kind="addon")})
        self.assertEqual("v1.0.0", tag)


class LicenseTest(unittest.TestCase):
    def detect(self, files, **overrides):
        with repository(files):
            return generator.detect_license(overrides, generator.read_json("package.json"))

    def test_license_file_wins_over_the_default(self):
        self.assertEqual("Apache License 2.0",
                         self.detect({"LICENSE": APACHE}, license_default="MIT License"))

    def test_explicit_setting_wins_over_the_file(self):
        self.assertEqual("Custom", self.detect({"LICENSE": APACHE}, license="Custom"))

    def test_package_json_spdx_is_used_without_a_license_file(self):
        self.assertEqual("MIT License", self.detect({"package.json": '{"license": "MIT"}'}))

    def test_no_source_at_all_yields_nothing(self):
        self.assertEqual("", self.detect({}))

    def test_a_repository_without_a_license_omits_the_section(self):
        readme, _, _ = build({".github/docs-config.yml": config(kind="generic", description="d")})
        self.assertNotIn("## License", readme)

    def test_an_addon_without_a_license_file_keeps_its_kind_default(self):
        readme, _, _ = build({".github/docs-config.yml": config(kind="addon")})
        self.assertIn("licensed under the GNU General Public License v3.0", readme)


class BadgeTest(unittest.TestCase):
    def test_configured_badge_list_replaces_the_kind_default(self):
        readme, _, _ = build({
            ".github/docs-config.yml": "kind: addon\nbadges:\n  - stars\n",
        })
        self.assertIn("img.shields.io/github/stars/owner/name", readme)
        self.assertNotIn("img.shields.io/github/downloads", readme)

    def test_bstats_badge_appears_only_when_configured(self):
        without, _, _ = build({".github/docs-config.yml": config(kind="addon")})
        self.assertNotIn("bStats", without)
        with_id, _, _ = build({".github/docs-config.yml": config(kind="addon", bstats="7",
                                                                 bstats_name="Nice Name")})
        self.assertIn("https://bStats.org/plugin/bukkit/Nice%20Name/7", with_id)

    def test_npm_badges_need_a_package_json(self):
        readme, _, _ = build({
            ".github/docs-config.yml": "kind: generic\nbadges:\n  - npm-version\n  - stars\n",
        })
        self.assertNotIn("shields.io/npm", readme)
        self.assertIn("shields.io/github/stars", readme)

    def test_unknown_badge_is_reported_and_skipped(self):
        readme, _, errors = build({
            ".github/docs-config.yml": "kind: generic\nbadges:\n  - nonsense\n  - stars\n",
        })
        self.assertIn("unknown badge 'nonsense'", errors)
        self.assertIn("shields.io/github/stars", readme)


class ModulesTest(unittest.TestCase):
    def test_configured_modules_render(self):
        readme, _, _ = build({
            ".github/docs-config.yml": "kind: java-library\nmodules:\n  - api\n  - core\n",
        }, tag="1.0.0")
        self.assertIn('githubImplementation "owner:name:1.0.0:all"', readme)
        self.assertIn('githubImplementation "owner:name:1.0.0:api"', readme)

    def test_a_single_module_is_not_a_module_list(self):
        readme, _, _ = build({
            ".github/docs-config.yml": "kind: java-library\nmodules:\n  - api\n",
        }, tag="1.0.0")
        self.assertNotIn("## Modules", readme)

    def test_release_assets_supply_the_classifiers(self):
        release = {"assets": [{"name": "name-api.jar"}, {"name": "name-core.jar"},
                              {"name": "name-sources.jar"}, {"name": "name.jar"}]}
        self.assertEqual(["api", "core"], generator.release_modules(release, "name"))


class ContentTest(unittest.TestCase):
    def test_missing_content_drops_the_intro(self):
        readme, _, _ = build({
            ".github/docs-config.yml": config(kind="java-library", description="A library."),
        }, tag="1.0.0")
        self.assertNotIn("Once you have it installed", readme)

    def test_content_intro_precedes_the_prose(self):
        readme, _, _ = build({
            ".github/docs-config.yml": config(kind="java-library", description="A library."),
            "CONTENT.md": "```java\nnew Thing();\n```\n",
        }, tag="1.0.0")
        self.assertIn("Once you have it installed you can use it like so:\n\n```java", readme)


class VersionKeyTest(unittest.TestCase):
    def test_non_numeric_parts_do_not_raise(self):
        self.assertEqual([1, 2, 0], generator.version_key("1.2.rc"))

    def test_ordering_is_numeric(self):
        self.assertEqual(["1.9.0", "1.10.0"], sorted(["1.10.0", "1.9.0"], key=generator.version_key))


if __name__ == "__main__":
    unittest.main()
