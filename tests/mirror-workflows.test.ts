/*
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

/**
 * The two forges' workflows, and the one path from a tag to npm.
 *
 * Gitea is the primary forge and reads `.gitea/workflows/`, where every check
 * runs; GitHub is its push mirror and reads `.github/workflows/`. Every mirror
 * push reaches GitHub, so the one GitHub workflow, `release.yml`, runs only for
 * a `v*` tag and publishes it to npm.
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
    it("are release.yml alone", () => {
        expect([...github.keys()]).toEqual(["release.yml"]);
    });

    it("run on a v* tag push and nothing else", () => {
        expect(triggers(github.get("release.yml")!.parsed)).toEqual({ push: { tags: ["v*"] } });
    });
});

describe("release.yml on GitHub", () => {
    const { source, parsed } = github.get("release.yml")!;
    const jobs = Object.entries(parsed.jobs ?? {});
    const [, job] = jobs[0];
    const steps = job.steps ?? [];

    it("is one job with no environment and only the permissions publishing needs", () => {
        expect(jobs).toHaveLength(1);
        // The trusted publisher on npm names no environment; one here would
        // stop the OIDC token matching it.
        expect(job).not.toHaveProperty("environment");
        expect(parsed.permissions).toEqual({ contents: "write", "id-token": "write" });
    });

    it("pins its actions to a full commit SHA", () => {
        const uses = steps.map((s) => s.uses).filter((u): u is string => typeof u === "string");
        expect(uses.length).toBeGreaterThan(0);
        for (const u of uses) expect(u).toMatch(/^[^@]+@[0-9a-f]{40}$/);
    });

    it("publishes with provenance, then creates the Release", () => {
        const runs = steps.map((s) => s.run).filter((r): r is string => typeof r === "string");
        const publish = runs.findIndex((r) => r === "npm publish --provenance");
        const release = runs.findIndex((r) => /gh release create "\$GITHUB_REF_NAME"/.test(r));
        expect(publish).toBeGreaterThanOrEqual(0);
        expect(release).toBeGreaterThan(publish);
    });

    it("says why its file name is bound to npm", () => {
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
                uses: expect.stringMatching(
                    /^HeroicLands\/\.github\/\.gitea\/workflows\/release-npm-package\.yml@[0-9a-f]{40}$/,
                ),
                secrets: { RELEASE_BOT_TOKEN: "${{ secrets.RELEASE_BOT_TOKEN }}" },
            },
        });
    });
});
