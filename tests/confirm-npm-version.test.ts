/*
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { confirmNpmVersion } from "../ci/confirm-npm-version.mjs";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const script = path.join(root, "ci", "confirm-npm-version.mjs");

const NAME = "@example/pkg";
const VERSION = "2.0.1";

function scripted(answers: string[]) {
    const asked: string[] = [];
    const waits: number[] = [];
    return {
        asked,
        waits,
        query: (spec: string) => {
            asked.push(spec);
            return answers[Math.min(asked.length - 1, answers.length - 1)];
        },
        sleep: async (ms: number) => {
            waits.push(ms);
        },
    };
}

describe("the release confirms that npm serves the published version", () => {
    it("succeeds as soon as the registry prints the version", async () => {
        const stub = scripted(["npm error code E404", "2.0.0", VERSION]);
        const outcome = await confirmNpmVersion({ name: NAME, version: VERSION, ...stub });
        expect(outcome).toEqual({ ok: true, attempts: 3 });
        expect(stub.asked).toEqual(Array(3).fill(`${NAME}@${VERSION}`));
        expect(stub.waits).toEqual([15000, 15000]);
    });

    it("fails with the last answer when the registry keeps serving another version", async () => {
        const stub = scripted(["2.0.0"]);
        const outcome = await confirmNpmVersion({
            name: NAME,
            version: VERSION,
            ...stub,
            intervalSeconds: 10,
            timeoutSeconds: 30,
        });
        expect(outcome).toEqual({ ok: false, attempts: 4, last: "2.0.0" });
    });

    it("fails when the registry keeps answering E404", async () => {
        const stub = scripted(["npm error code E404 | npm error 404 Not Found"]);
        const outcome = await confirmNpmVersion({ name: NAME, version: VERSION, ...stub });
        expect(outcome.ok).toBe(false);
        expect(stub.asked).toHaveLength(41);
    });

    describe("as a command with a stubbed npm", () => {
        function run(npmBody: string, extra: string[] = []) {
            const bin = fs.mkdtempSync(path.join(os.tmpdir(), "confirm-npm-"));
            try {
                const npm = path.join(bin, "npm");
                fs.writeFileSync(npm, `#!/bin/sh\n${npmBody}\n`, { mode: 0o755 });
                return spawnSync(
                    process.execPath,
                    [script, NAME, VERSION, "--interval", "0.01", "--timeout", "0.05", ...extra],
                    {
                        encoding: "utf8",
                        env: { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}` },
                    },
                );
            } finally {
                fs.rmSync(bin, { recursive: true, force: true });
            }
        }

        it("exits 0 once npm prints the version", () => {
            const result = run(`echo ${VERSION}`);
            expect(result.status).toBe(0);
            expect(result.stdout).toContain(`${NAME}@${VERSION} is served by npm.`);
        });

        it("exits 1 naming the package, the version and the last answer", () => {
            const result = run("echo 'npm error code E404' >&2; exit 1");
            expect(result.status).toBe(1);
            expect(result.stderr).toContain(
                `::error::npm does not serve ${NAME}@${VERSION} after 0.05s`,
            );
            expect(result.stderr).toContain("Last registry answer: npm error code E404");
        });

        it("exits 1 naming another version the registry serves", () => {
            const result = run("echo 2.0.0");
            expect(result.status).toBe(1);
            expect(result.stderr).toContain("Last registry answer: 2.0.0");
        });
    });
});
