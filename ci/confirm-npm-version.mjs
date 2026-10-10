/*
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

/**
 * Asserts that npm serves an exact package version.
 *
 * `npm publish` returns before the registry serves the new version, and a
 * version that is accepted but never served is indistinguishable from success
 * by the publish alone. This polls `npm view <name>@<version> version` until
 * it prints the version, then exits 0. When the time budget runs out it exits 1
 * with an `::error::` annotation naming the package, the version and the last
 * registry answer.
 *
 * Usage: `node ci/confirm-npm-version.mjs <name> <version> [--interval <s>]
 * [--timeout <s>]`. The defaults are 15 seconds between queries and 600 seconds
 * overall.
 */

import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

/** Seconds between registry queries. */
export const DEFAULT_INTERVAL_SECONDS = 15;
/** Seconds the registry has to serve the version. */
export const DEFAULT_TIMEOUT_SECONDS = 600;

/**
 * Ask the registry which version `name@version` resolves to.
 *
 * @param {string} spec - `<name>@<version>`.
 * @returns {string} The version npm printed, or its error text when the query
 *   fails (an unpublished version answers E404).
 */
export function queryNpm(spec) {
    const result = spawnSync("npm", ["view", spec, "version"], { encoding: "utf8" });
    if (result.error) return result.error.message;
    const out = (result.stdout ?? "").trim();
    if (result.status === 0) return out;
    const err = (result.stderr ?? "").trim().replace(/\s*\n\s*/g, " | ");
    return err || out || `npm exited ${result.status}`;
}

/**
 * Poll until the registry serves `version` of `name`.
 *
 * @param {object} options
 * @param {string} options.name - Package name.
 * @param {string} options.version - Exact version expected.
 * @param {(spec: string) => string} [options.query] - Registry query; returns
 *   the registry's answer for `<name>@<version>`.
 * @param {(ms: number) => Promise<void>} [options.sleep] - Waits between queries.
 * @param {number} [options.intervalSeconds] - Seconds between queries.
 * @param {number} [options.timeoutSeconds] - Seconds before giving up.
 * @param {(line: string) => void} [options.log] - Progress output.
 * @returns {Promise<{ok: true, attempts: number} | {ok: false, attempts: number, last: string}>}
 */
export async function confirmNpmVersion({
    name,
    version,
    query = queryNpm,
    sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    intervalSeconds = DEFAULT_INTERVAL_SECONDS,
    timeoutSeconds = DEFAULT_TIMEOUT_SECONDS,
    log = () => {},
}) {
    const spec = `${name}@${version}`;
    const attemptLimit = Math.floor(timeoutSeconds / intervalSeconds) + 1;
    let last = "";
    for (let attempts = 1; attempts <= attemptLimit; attempts++) {
        last = query(spec);
        if (last === version) {
            log(`${spec} is served by npm.`);
            return { ok: true, attempts };
        }
        log(`${spec} is not served yet (${last || "empty answer"}).`);
        if (attempts < attemptLimit) await sleep(intervalSeconds * 1000);
    }
    return { ok: false, attempts: attemptLimit, last };
}

function parseArguments(argv) {
    const positional = [];
    const options = {};
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === "--interval" || arg === "--timeout") {
            const value = Number(argv[++i]);
            if (!Number.isFinite(value) || value <= 0) {
                throw new Error(`${arg} takes a positive number of seconds.`);
            }
            options[arg === "--interval" ? "intervalSeconds" : "timeoutSeconds"] = value;
        } else if (arg.startsWith("--")) {
            throw new Error(`Unknown option ${arg}.`);
        } else {
            positional.push(arg);
        }
    }
    if (positional.length !== 2) {
        throw new Error(
            "Usage: confirm-npm-version.mjs <name> <version> [--interval <s>] [--timeout <s>]",
        );
    }
    return { name: positional[0], version: positional[1], ...options };
}

async function main(argv) {
    let options;
    try {
        options = parseArguments(argv);
    } catch (error) {
        console.error(`::error::${error.message}`);
        return 2;
    }
    const outcome = await confirmNpmVersion({ ...options, log: (line) => console.log(line) });
    if (outcome.ok) return 0;
    const timeout = options.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS;
    console.error(
        `::error::npm does not serve ${options.name}@${options.version} after ${timeout}s and ${outcome.attempts} queries. Last registry answer: ${outcome.last || "(empty)"}`,
    );
    return 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
    process.exitCode = await main(process.argv.slice(2));
}
