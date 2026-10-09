/*
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

/**
 * The two forges' workflows, and the one path from a tag to npm.
 *
 * Gitea is the primary forge and reads `.gitea/workflows/`; GitHub is its push
 * mirror and reads `.github/workflows/`. Every mirror push reaches GitHub, so a
 * GitHub workflow triggered by a branch push would run on each one. The only
 * push GitHub acts on is a `v*` tag, which `release.yml` publishes to npm.
 *
 * npm's trusted publisher is bound to this repository and the file name
 * `release.yml` with no environment, so the publish stays in that file, on
 * GitHub, and nowhere else.
 *
 * Derived from the directories rather than from a list of names, so a workflow
 * added to either one is held to the same rules the day it lands.
 */

import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

type Workflow = {
    on?: Record<string, unknown> | string | string[];
    permissions?: Record<string, string>;
    jobs?: Record<
        string,
        {
            if?: string;
            environment?: unknown;
            "runs-on"?: string;
            steps?: Record<string, unknown>[];
        }
    >;
};

/** Every workflow file in a directory, parsed, by file name. */
function workflows(dir: string): Map<string, { source: string; parsed: Workflow }> {
    const found = new Map<string, { source: string; parsed: Workflow }>();
    const abs = path.join(ROOT, dir);
    for (const entry of fs.readdirSync(abs).sort()) {
        if (!/\.ya?ml$/.test(entry)) continue;
        const source = fs.readFileSync(path.join(abs, entry), "utf8");
        found.set(entry, { source, parsed: YAML.parse(source) as Workflow });
    }
    return found;
}

/** A workflow's triggers as an object, whatever shorthand it is written in. */
function triggers(workflow: Workflow): Record<string, unknown> {
    const on = workflow.on;
    if (typeof on === "string") return { [on]: null };
    if (Array.isArray(on)) return Object.fromEntries(on.map((name) => [name, null]));
    return on ?? {};
}

/** The source without its comment lines, so prose about a rule does not trip it. */
const code = (source: string) =>
    source
        .split("\n")
        .filter((line) => !/^\s*#/.test(line))
        .join("\n");

const NPM_PUBLISH =
    /npm\s+publish|deploy:npm|changeset\s+publish|NPM_TOKEN|NODE_AUTH_TOKEN|id-token/;

const github = workflows(".github/workflows");
const gitea = workflows(".gitea/workflows");

describe("the GitHub mirror's workflows", () => {
    it("are found at all, so the cases below are not vacuous", () => {
        expect([...github.keys()]).toContain("release.yml");
        expect(github.size).toBeGreaterThan(1);
    });

    it("run on no branch push; only release.yml runs on a push, and only for a v* tag", () => {
        for (const [name, { parsed }] of github) {
            const on = triggers(parsed);
            for (const event of [
                "push",
                "pull_request_target",
                "workflow_run",
                "schedule",
                "create",
            ]) {
                if (name === "release.yml" && event === "push") continue;
                expect(on, `${name} runs on ${event}`).not.toHaveProperty(event);
            }
        }
        expect(triggers(github.get("release.yml")!.parsed).push).toEqual({ tags: ["v*"] });
    });

    it("publish to npm from release.yml alone", () => {
        for (const [name, { source }] of github) {
            if (name === "release.yml") continue;
            expect(code(source), `${name} reaches npm`).not.toMatch(NPM_PUBLISH);
        }
    });
});

describe("release.yml on GitHub", () => {
    const { source, parsed } = github.get("release.yml")!;
    const jobs = Object.entries(parsed.jobs ?? {});
    const [, job] = jobs[0];
    const steps = job.steps ?? [];
    const named = (name: string) => {
        const step = steps.find((s) => s.name === name);
        expect(step, `no step named "${name}"`).toBeDefined();
        return step as { if?: string; run?: string; env?: Record<string, string> };
    };

    it("is one job, guarded to GitHub and to a v* tag, with no environment", () => {
        expect(jobs).toHaveLength(1);
        expect(job.if).toBe(
            "${{ github.server_url == 'https://github.com' && startsWith(github.ref, 'refs/tags/v') }}",
        );
        // The trusted publisher on npm names no environment; one here would
        // stop the OIDC token matching it.
        expect(job).not.toHaveProperty("environment");
        expect(parsed.permissions).toEqual({ contents: "write", "id-token": "write" });
    });

    it("checks the tag before installing anything: its commit, its version, and main", () => {
        const check = named("Check the tag");
        expect(steps.indexOf(check)).toBeLessThan(steps.findIndex((s) => s.run === "npm ci"));
        expect(check.run).toMatch(/\[ "\$TAG" != "v\$VERSION" \]/);
        expect(check.run).toMatch(
            /git merge-base --is-ancestor "\$COMMIT" refs\/remotes\/origin\/main/,
        );
        expect(check.run).toMatch(/git rev-parse "refs\/tags\/\$TAG\^\{commit\}"/);
        expect(steps[0]).toMatchObject({ uses: "actions/checkout@v7", with: { "fetch-depth": 0 } });
    });

    it("never publishes a version npm already has, and stops when the registry cannot say", () => {
        const registry = named("Is this version on npm?");
        expect(registry.run).toMatch(/200\)[\s\S]*published=true/);
        expect(registry.run).toMatch(/404\)[\s\S]*published=false/);
        expect(registry.run).toMatch(/\*\)[\s\S]*exit 1/);
        const publish = named("Publish");
        expect(publish.run).toBe("npm publish --provenance");
        expect(publish.if).toBe("steps.registry.outputs.published == 'false'");
        for (const name of [
            "Install dependencies",
            "Tests",
            "Package contents",
            "Confirm npm can use OIDC",
        ]) {
            expect(named(name).if, name).toBe("steps.registry.outputs.published == 'false'");
        }
        expect(steps.indexOf(registry)).toBeLessThan(steps.indexOf(publish));
    });

    it("creates the Release after the publish, and only when none exists", () => {
        const release = named("Create the GitHub Release");
        expect(steps.indexOf(release)).toBeGreaterThan(steps.indexOf(named("Publish")));
        expect(release.run).toMatch(/gh release view "\$TAG"[\s\S]*exit 0/);
        expect(release.run).toMatch(/gh release create "\$TAG" --verify-tag/);
    });

    it("says why its file name and job shape are bound to npm", () => {
        expect(source).toMatch(/The file name is load-bearing/);
        expect(code(source)).not.toMatch(
            /changesets\/action|create-github-app-token|RELEASE_APP|secrets\.NPM/,
        );
    });
});

describe("the Gitea workflows", () => {
    it("never reach npm", () => {
        expect(gitea.size).toBeGreaterThan(0);
        for (const [name, { source }] of gitea) {
            expect(code(source), `${name} reaches npm`).not.toMatch(NPM_PUBLISH);
        }
    });

    it("version and tag through the shared npm release workflow", () => {
        const release = gitea.get("release.yml")!.parsed;
        expect(triggers(release)).toHaveProperty("push", { branches: ["main"] });
        expect(release.jobs).toEqual({
            release: {
                uses: "HeroicLands/.github/.gitea/workflows/release-npm-package.yml@main",
                secrets: { RELEASE_BOT_TOKEN: "${{ secrets.RELEASE_BOT_TOKEN }}" },
            },
        });
    });

    it("run the same Build & Test steps as the GitHub copy", () => {
        const a = github.get("build.yml")!.parsed.jobs!;
        const b = gitea.get("build.yml")!.parsed.jobs!;
        expect(Object.keys(b)).toEqual(Object.keys(a));
        for (const name of Object.keys(a)) {
            expect(b[name].steps, name).toEqual(a[name].steps);
        }
        expect(triggers(gitea.get("build.yml")!.parsed)).toHaveProperty("push", {
            branches: ["main"],
        });
    });

    it("carry the same no-attribution check as the GitHub copy", () => {
        expect(gitea.get("no-attribution.yml")!.parsed).toEqual(
            github.get("no-attribution.yml")!.parsed,
        );
    });
});
