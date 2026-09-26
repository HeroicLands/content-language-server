/*
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import {
    indexRecordsFor,
    serializeContentIndex,
} from "@heroiclands/package-build/engine/content-index";
import packageBuild from "@heroiclands/package-build/package.json" with { type: "json" };

/** Version of the server package that generates editor index records. */
export const generatorVersion = packageBuild.version;

function defaultCacheBase() {
    if (process.platform === "darwin") return path.join(os.homedir(), "Library", "Caches");
    if (process.platform === "win32")
        return process.env.LOCALAPPDATA ?? path.join(os.homedir(), "AppData", "Local");
    return process.env.XDG_CACHE_HOME ?? path.join(os.homedir(), ".cache");
}

/** Keep one cache directory for each canonical project root across server versions. */
export function languageIndexDirectory(config, cacheBase = defaultCacheBase()) {
    const root = fs.realpathSync(config.rootDir ?? path.dirname(config.paths.assets));
    const hash = crypto.createHash("sha256").update(root).digest("hex");
    return path.join(cacheBase, "HeroicLands", "content-language-server", hash);
}

function checksum(text) {
    return crypto.createHash("sha256").update(text).digest("hex");
}

function compareVersions(left, right) {
    const a = left.split(".").map(Number);
    const b = right.split(".").map(Number);
    for (let i = 0; i < 3; i++) {
        if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) - (b[i] ?? 0);
    }
    return 0;
}

function withProjectLock(directory, action) {
    fs.mkdirSync(directory, { recursive: true });
    const lock = path.join(directory, ".rebuild-lock");
    const deadline = Date.now() + 30000;
    while (true) {
        try {
            fs.mkdirSync(lock);
            break;
        } catch (error) {
            if (error.code !== "EEXIST") throw error;
            const stat = fs.statSync(lock, { throwIfNoEntry: false });
            if (!stat) continue;
            if (Date.now() - stat.mtimeMs > 300000) {
                fs.rmSync(lock, { recursive: true, force: true });
                continue;
            }
            if (Date.now() >= deadline)
                throw new Error(`Timed out waiting for index lock at ${lock}`);
            Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
        }
    }
    try {
        return action();
    } finally {
        fs.rmdirSync(lock);
    }
}

function readPair(indexFile, manifestFile, contentPackage) {
    const manifest = JSON.parse(fs.readFileSync(manifestFile, "utf8"));
    if (manifest.package !== contentPackage || manifest.generatorVersion !== generatorVersion)
        throw new Error(`Incompatible editor index at ${indexFile}`);
    const text = fs.readFileSync(indexFile, "utf8");
    if (checksum(text) !== manifest.sha256) throw new Error(`Corrupt editor index at ${indexFile}`);
    return text
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line));
}

/** Read only a complete snapshot produced by this generator and package. */
export function readLanguageIndex(directory, contentPackage) {
    const indexFile = path.join(directory, "metadata.jsonl");
    const manifestFile = path.join(directory, "metadata.json");
    try {
        return readPair(indexFile, manifestFile, contentPackage);
    } catch (error) {
        try {
            return readPair(`${indexFile}.previous`, `${manifestFile}.previous`, contentPackage);
        } catch {
            throw error;
        }
    }
}

/** Rebuild from saved inputs, publishing complete files while holding the project lock. */
export function rebuildLanguageIndex(config, directory) {
    return withProjectLock(directory, () => {
        let existing;
        try {
            existing = JSON.parse(fs.readFileSync(path.join(directory, "metadata.json"), "utf8"));
        } catch {
            existing = null;
        }
        if (
            existing?.generatorVersion &&
            compareVersions(existing.generatorVersion, generatorVersion) > 0
        )
            throw new Error(
                `Editor index uses newer generator ${existing.generatorVersion}; upgrade this language server`,
            );
        const records = indexRecordsFor({ config });
        if (records.length === 0)
            throw new Error(`${config.paths.content} yielded no index records`);
        const text = serializeContentIndex(records);
        const manifest = JSON.stringify({
            package: config.contentPackage,
            generatorVersion,
            sha256: checksum(text),
        });
        const suffix = `${process.pid}-${crypto.randomUUID()}`;
        const indexTemp = path.join(directory, `metadata.jsonl.${suffix}.tmp`);
        const manifestTemp = path.join(directory, `metadata.json.${suffix}.tmp`);
        const indexFile = path.join(directory, "metadata.jsonl");
        const manifestFile = path.join(directory, "metadata.json");
        const priorIndex = `${indexFile}.previous`;
        const priorManifest = `${manifestFile}.previous`;
        try {
            fs.writeFileSync(indexTemp, text);
            fs.writeFileSync(manifestTemp, manifest);
            try {
                readPair(indexFile, manifestFile, config.contentPackage);
                fs.copyFileSync(indexFile, priorIndex);
                fs.copyFileSync(manifestFile, priorManifest);
            } catch {
                // A recovery snapshot, if present, stays available during publication.
            }
            fs.renameSync(indexTemp, indexFile);
            fs.renameSync(manifestTemp, manifestFile);
            fs.rmSync(priorIndex, { force: true });
            fs.rmSync(priorManifest, { force: true });
        } finally {
            fs.rmSync(indexTemp, { force: true });
            fs.rmSync(manifestTemp, { force: true });
        }
        return text
            .split("\n")
            .filter(Boolean)
            .map((line) => JSON.parse(line));
    });
}
