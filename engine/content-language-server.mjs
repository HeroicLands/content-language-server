/*
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import YAML from "yaml";
import { parseAddress, renderAddress } from "@heroiclands/package-build/engine/address";
import { addressPositions } from "@heroiclands/package-build/engine/note-addresses";
import { parseWikilink, WIKILINK } from "@heroiclands/package-build/engine/wikilink-syntax";
import {
    CONFIG_FILENAMES,
    configFromData,
    loadPackConfig,
} from "@heroiclands/package-build/engine/pack-config";
import { noteFile } from "@heroiclands/package-build/engine/index-records";
import { asciiName } from "@heroiclands/package-build/engine/content-index";
import { NOTE_VOCABULARY } from "@heroiclands/package-build/engine/note-vocabulary";
import {
    languageIndexDirectory,
    readLanguageIndex,
    rebuildLanguageIndex,
} from "./content-language-index.mjs";
import { codeRegions, matchAllOutsideCode } from "@heroiclands/package-build/engine/code-fences";
import { embedsIn, EMBED_DEFAULT_TYPE } from "@heroiclands/package-build/engine/content-embeds";

const EMPTY_RANGE = { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } };
const require = createRequire(import.meta.url);

/** Load an explicitly selected project's configuration with this server's toolchain. */
function loadForeignConfig(root) {
    const files = CONFIG_FILENAMES.map((name) => path.join(root, name)).filter((file) =>
        fs.existsSync(file),
    );
    if (files.length !== 1)
        throw new Error(root + " must contain exactly one package-build configuration");
    const file = files[0];
    if (file.endsWith(".mjs")) {
        const module = require(file);
        return module.default ?? module;
    }
    return configFromData(YAML.parse(fs.readFileSync(file, "utf8")), file);
}

/** Return an LSP position for a UTF-16 offset in TEXT. */
function positionAt(text, offset) {
    const before = text.slice(0, offset);
    const line = before.split("\n").length - 1;
    const lastNewline = before.lastIndexOf("\n");
    return { line, character: offset - lastNewline - 1 };
}

/** Return a UTF-16 offset for an LSP position in TEXT. */
function offsetAt(text, position) {
    const lines = text.split("\n");
    if (position.line < 0 || position.line >= lines.length) return -1;
    let offset = 0;
    for (let i = 0; i < position.line; i++) offset += lines[i].length + 1;
    return offset + Math.min(position.character, lines[position.line].length);
}

function location(file, text, start, end) {
    return {
        uri: pathToFileURL(file).href,
        range: { start: positionAt(text, start), end: positionAt(text, end) },
    };
}

function noteName(record) {
    return typeof record.name === "string" ? record.name : (record.name?.full ?? record.shortcode);
}

/** Use the index generator's transliteration for both saved fields and typed queries. */
function searchKey(value) {
    return typeof value === "string" ? (asciiName(value) ?? "").toLowerCase() : "";
}

/** A completion item changes the Address text while its label remains readable. */
function completionItem(label, detail, inserted, text, from, to, filterText) {
    return {
        label,
        kind: 18,
        detail,
        filterText,
        textEdit: {
            range: { start: positionAt(text, from), end: positionAt(text, to) },
            newText: inserted,
        },
    };
}

/** Ignore ordinary prose completion before loading any foreign project. */
function mayCompleteAddress(text, offset) {
    if (text == null || offset < 0) return false;
    const bodyStart = text.match(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/)?.[0].length ?? 0;
    if (offset < bodyStart) return true;
    const lineStart = text.lastIndexOf("\n", offset - 1) + 1;
    const lineEnd = text.indexOf("\n", offset);
    const before = text.slice(lineStart, offset);
    const open = before.lastIndexOf("[[");
    return (
        open >= 0 &&
        !before.slice(open + 2).includes("]]") &&
        !text.slice(offset, lineEnd < 0 ? text.length : lineEnd).includes("]]")
    );
}

/** An index read from the package's configured content tree. */
export class ContentWorkspace {
    constructor(
        config = loadPackConfig(),
        { cacheBase, onStatus = () => {}, loadProjectConfig = loadForeignConfig } = {},
    ) {
        this.config = config;
        this.cacheBase = cacheBase;
        this.loadProjectConfig = loadProjectConfig;
        this.contentRoot = config.paths.content;
        this.cacheDirectory = languageIndexDirectory(config, cacheBase);
        this.indexFile = path.join(this.cacheDirectory, "metadata.jsonl");
        this.indexState = "";
        this.started = false;
        this.rebuildTimer = null;
        this.onStatus = onStatus;
        this.records = [];
        this.byAddress = new Map();
        this.byFile = new Map();
        this.searchKeys = new Map();
        this.types = new Set(Object.keys(NOTE_VOCABULARY));
        this.documents = new Map();
        this.foreignRoots = [];
        this.foreign = new Map();
    }

    /** Select foreign roots explicitly; a cache directory cannot add a project. */
    configureForeignRoots(roots = []) {
        if (!Array.isArray(roots) || roots.some((root) => typeof root !== "string"))
            throw new Error("initializationOptions.foreignRoots must be an array of paths");
        const ownRoot = fs.realpathSync(this.config.rootDir);
        this.foreignRoots = [
            ...new Set(
                roots.map((root) => {
                    const absolute = path.resolve(root);
                    return fs.existsSync(absolute) ? fs.realpathSync(absolute) : absolute;
                }),
            ),
        ].filter((root) => root !== ownRoot);
        for (const [root, project] of this.foreign)
            if (!this.foreignRoots.includes(root)) {
                project.close();
                this.foreign.delete(root);
            }
    }

    foreignWorkspace(root) {
        if (this.foreign.has(root)) return this.foreign.get(root);
        const config = this.loadProjectConfig(root);
        const project = new ContentWorkspace(config, {
            cacheBase: this.cacheBase,
            onStatus: (message) => {
                if (message) this.onStatus(config.contentPackage + ": " + message);
            },
            loadProjectConfig: this.loadProjectConfig,
        });
        project.documents = this.documents;
        this.foreign.set(root, project);
        return project;
    }

    /** Return usable indexes, reporting one failed root without hiding the others. */
    indexedWorkspaces(includeForeign = false) {
        this.requireIndex();
        const projects = [this];
        if (includeForeign)
            for (const root of this.foreignRoots) {
                try {
                    const project = this.foreignWorkspace(root);
                    project.start(true);
                    project.requireIndex();
                    projects.push(project);
                } catch (error) {
                    this.onStatus("Foreign content project " + root + ": " + error.message);
                }
            }
        return projects;
    }

    /** Find every indexed owner of a written Address for navigation. */
    resolveCandidates(value, defaults = {}, projects = [this]) {
        const packages = new Set(projects.map((project) => project.config.contentPackage));
        const found = [];
        for (const project of projects) {
            const tuple = parseAddress(value, {
                package: project.config.contentPackage,
                system: "none",
                types: project.types,
                packages,
                ...defaults,
            });
            if (tuple.reason) continue;
            const record = project.byAddress.get(renderAddress(tuple));
            if (record) found.push({ record, project });
        }
        return found;
    }

    /** Locate the workspace that owns an open source document. */
    sourceWorkspace(uri, projects) {
        const file = fileURLToPath(uri);
        return (
            projects.find((project) => {
                const relative = path.relative(project.contentRoot, file);
                return (
                    relative &&
                    !path.isAbsolute(relative) &&
                    relative !== ".." &&
                    !relative.startsWith(".." + path.sep)
                );
            }) ?? this
        );
    }

    scheduleRebuildForUri(uri) {
        const file = fileURLToPath(uri);
        const inside = (directory) => {
            const relative = path.relative(directory, file);
            return (
                relative &&
                !path.isAbsolute(relative) &&
                relative !== ".." &&
                !relative.startsWith(".." + path.sep)
            );
        };
        if (inside(this.contentRoot) || inside(this.config.paths.assets)) {
            this.scheduleRebuild();
            return;
        }
        for (const root of this.foreignRoots) {
            if (!inside(root)) continue;
            try {
                const project = this.foreignWorkspace(root);
                if (inside(project.contentRoot) || inside(project.config.paths.assets))
                    project.scheduleRebuild();
            } catch (error) {
                this.onStatus("Foreign content project " + root + ": " + error.message);
            }
        }
    }

    refresh() {
        let stat;
        try {
            stat = fs.statSync(path.join(this.cacheDirectory, "metadata.json"));
        } catch {
            return false;
        }
        const state = `${stat.mtimeMs}:${stat.size}`;
        if (state === this.indexState) return true;
        const records = readLanguageIndex(this.cacheDirectory, this.config.contentPackage);
        this.loadRecords(records);
        this.indexState = state;
        return true;
    }

    loadRecords(records) {
        const byAddress = new Map();
        const byFile = new Map();
        const searchKeys = new Map();
        const types = new Set(Object.keys(NOTE_VOCABULARY));
        for (const record of records) {
            if (record.type) types.add(record.type);
            if (record.address?.canonical)
                byAddress.set(record.address.canonical.toLowerCase(), record);
            if (record.file?.path) {
                const file = noteFile(this.contentRoot, record);
                if (!byFile.has(file)) byFile.set(file, record);
            }
            searchKeys.set(record, [
                ...new Set(
                    [
                        noteName(record),
                        record.nameAscii,
                        ...(record.name?.aliases ?? []),
                        ...(record.aliasesAscii ?? []),
                        record.shortcode,
                        record.address?.slug,
                        record.address?.canonical,
                    ]
                        .map(searchKey)
                        .filter(Boolean),
                ),
            ]);
        }
        this.records = records;
        this.byAddress = byAddress;
        this.byFile = byFile;
        this.searchKeys = searchKeys;
        this.types = types;
    }

    rebuild() {
        try {
            const records = rebuildLanguageIndex(this.config, this.cacheDirectory);
            this.loadRecords(records);
            const stat = fs.statSync(path.join(this.cacheDirectory, "metadata.json"));
            this.indexState = `${stat.mtimeMs}:${stat.size}`;
            this.onStatus(null);
            return true;
        } catch (error) {
            let stale = this.records.length > 0;
            if (!stale) {
                try {
                    stale = this.refresh();
                } catch {
                    stale = false;
                }
            }
            this.onStatus(
                `Editor index rebuild failed: ${error.message}. ${stale ? "Results use the last complete snapshot." : "No index is available."}`,
            );
            return false;
        }
    }

    start(acceptCompleteCache = false) {
        if (this.started) return;
        this.started = true;
        if (acceptCompleteCache)
            try {
                if (this.refresh()) return;
            } catch {
                // A corrupt or incompatible snapshot is rebuilt from saved notes.
            }
        this.rebuild();
    }

    scheduleRebuild() {
        if (this.rebuildTimer) clearTimeout(this.rebuildTimer);
        this.rebuildTimer = setTimeout(() => {
            this.rebuildTimer = null;
            this.rebuild();
        }, 300);
    }

    close() {
        if (this.rebuildTimer) clearTimeout(this.rebuildTimer);
        this.rebuildTimer = null;
        for (const project of this.foreign.values()) project.close();
    }

    requireIndex() {
        if (!this.started) this.start();
        try {
            this.refresh();
        } catch (error) {
            this.onStatus(
                `Editor index could not be read: ${error.message}. Results use the last complete snapshot.`,
            );
        }
        if (this.records.length === 0)
            throw new Error(`No editor index at ${this.indexFile}; save a note to retry`);
    }

    fileFor(record) {
        if (record.file?.path) return noteFile(this.contentRoot, record);
        if (record.asset?.path)
            return path.join(this.config.paths.assets, ...record.asset.path.split("/"));
        return null;
    }

    text(uri) {
        if (this.documents.has(uri)) return this.documents.get(uri);
        try {
            return fs.readFileSync(fileURLToPath(uri), "utf8");
        } catch {
            return null;
        }
    }

    /** Resolve a written Address using the same tuple grammar as the build. */
    resolve(value, defaults = {}, projects = [this]) {
        const tuple = parseAddress(value, {
            package: this.config.contentPackage,
            system: "none",
            types: new Set(projects.flatMap((project) => [...project.types])),
            packages: new Set(projects.map((project) => project.config.contentPackage)),
            ...defaults,
        });
        if (tuple.reason) return null;
        for (const project of projects)
            if (project.config.contentPackage === tuple.package) {
                const record = project.byAddress.get(renderAddress(tuple));
                if (record) return record;
            }
        return null;
    }

    /** Spell TARGET with the shortest suffix that resolves to that exact indexed owner. */
    shortestAddress(target, owner, defaults, projects) {
        const canonical = target.address?.canonical?.toLowerCase();
        if (!canonical) return null;
        const parts = canonical.split("-");
        if (parts.length !== 4) return null;
        const suffixes = [
            ...(defaults.type ? [parts[3]] : []),
            parts.slice(2).join("-"),
            parts.slice(1).join("-"),
            canonical,
        ];
        const vocabulary = {
            package: this.config.contentPackage,
            system: defaults.system ?? "none",
            type: defaults.type,
            types: new Set(projects.flatMap((project) => [...project.types])),
            packages: new Set(projects.map((project) => project.config.contentPackage)),
        };
        for (const written of suffixes) {
            const tuple = parseAddress(written, vocabulary);
            if (tuple.reason || renderAddress(tuple) !== canonical) continue;
            const owners = projects.filter((project) => project.byAddress.has(canonical));
            if (owners.length === 1 && owners[0] === owner) return written;
        }
        return null;
    }

    /** Complete an unfinished wikilink using saved metadata and open-buffer context. */
    linkCompletion(text, offset, projects) {
        const bodyStart = text.match(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/)?.[0].length ?? 0;
        if (offset < bodyStart) return null;
        const body = text.slice(bodyStart);
        const bodyOffset = offset - bodyStart;
        if (
            codeRegions(body).some(
                (region) => region.start <= bodyOffset && bodyOffset <= region.end,
            )
        )
            return null;
        const lineStart = text.lastIndexOf("\n", offset - 1) + 1;
        const lineEnd = text.indexOf("\n", offset);
        const before = text.slice(lineStart, offset);
        const open = before.lastIndexOf("[[");
        if (open < 0 || before.slice(open + 2).includes("]]")) return null;
        if (text.slice(offset, lineEnd < 0 ? text.length : lineEnd).includes("]]")) return null;
        const from = lineStart + open + 2;
        const written = text.slice(from, offset);
        if (written.includes("|") || written.includes("[") || written.includes("]")) return null;
        const hash = written.indexOf("#");
        if (hash < 0) return { kind: "address", from, to: offset, query: written, defaults: {} };
        const target = this.resolve(written.slice(0, hash), {}, projects);
        if (!target) return null;
        return {
            kind: "anchor",
            target,
            from: from + hash + 1,
            to: offset,
            query: written.slice(hash + 1),
        };
    }

    /** Find the declared Address scalar or key containing the cursor. */
    frontmatterCompletion(text, offset) {
        const header = /^---\r?\n/.exec(text)?.[0];
        if (!header) return null;
        const closing = /\r?\n---(?:\r?\n|$)/g;
        closing.lastIndex = header.length;
        const end = closing.exec(text)?.index;
        if (end == null || offset < header.length || offset > end) return null;
        const yamlText = text.slice(header.length, end);
        let document;
        let frontmatter;
        try {
            document = YAML.parseDocument(yamlText);
            frontmatter = document.toJS();
        } catch {
            return null;
        }
        if (!frontmatter || typeof frontmatter !== "object") return null;
        const cursor = offset - header.length;
        let found = null;
        const scalar = (node, position) => {
            if (!YAML.isScalar(node) || !node.range || found) return;
            let [start, finish] = node.range;
            const raw = yamlText.slice(start, finish);
            if (
                (raw.startsWith('"') && raw.endsWith('"')) ||
                (raw.startsWith("'") && raw.endsWith("'"))
            ) {
                start += 1;
                finish -= 1;
            }
            if (cursor < start || cursor > finish) return;
            found = {
                kind: "address",
                from: header.length + start,
                to: header.length + finish,
                query: yamlText.slice(start, cursor),
                defaults: { system: position.system ?? "none", type: position.type },
                accepts: position.accepts ?? (position.type ? [position.type] : null),
            };
        };
        const visit = (node, segments, position) => {
            if (!node || found) return;
            if (segments.length) {
                const [head, ...tail] = segments;
                if (YAML.isMap(node))
                    for (const pair of node.items)
                        if (head === "*" || String(pair.key?.value) === String(head))
                            visit(pair.value, tail, position);
                if (YAML.isSeq(node))
                    node.items.forEach((child, index) => {
                        if (head === "*" || String(index) === String(head))
                            visit(child, tail, position);
                    });
                return;
            }
            if (position.shape === "keys" && YAML.isMap(node))
                for (const pair of node.items) scalar(pair.key, position);
            else if (position.shape === "list" && YAML.isSeq(node))
                for (const child of node.items) scalar(child, position);
            else if (position.shape === "scalar-or-map" && YAML.isMap(node))
                for (const pair of node.items) scalar(pair.value, position);
            else scalar(node, position);
        };
        for (const position of addressPositions(frontmatter, this.config)) {
            visit(document.contents, position.path, position);
            if (found) break;
        }
        return found;
    }

    completion(uri, position, projects = [this]) {
        const text = this.text(uri);
        if (text == null) return [];
        const offset = offsetAt(text, position);
        if (offset < 0) return [];
        const context =
            this.linkCompletion(text, offset, projects) ?? this.frontmatterCompletion(text, offset);
        if (!context) return [];
        const needle = searchKey(context.query);
        if (context.kind === "anchor")
            return (context.target.anchors ?? [])
                .filter((anchor) => searchKey(`${anchor.slug} ${anchor.name}`).includes(needle))
                .map((anchor) =>
                    completionItem(
                        anchor.slug,
                        anchor.name,
                        anchor.slug,
                        text,
                        context.from,
                        context.to,
                        context.query,
                    ),
                );
        const items = [];
        const seen = new Set();
        for (const project of projects)
            for (const record of project.records) {
                const canonical = record.address?.canonical?.toLowerCase();
                if (!canonical || project.byAddress.get(canonical) !== record) continue;
                if (seen.has(canonical)) continue;
                if (
                    context.accepts &&
                    !context.accepts.some(
                        (accepted) => record.type === accepted || record.type === `doc${accepted}`,
                    )
                )
                    continue;
                if (!(project.searchKeys.get(record) ?? []).some((key) => key.includes(needle)))
                    continue;
                const inserted = this.shortestAddress(record, project, context.defaults, projects);
                if (!inserted) continue;
                seen.add(canonical);
                items.push(
                    completionItem(
                        `${noteName(record)} — ${canonical}`,
                        `${record.package} · ${canonical}`,
                        inserted,
                        text,
                        context.from,
                        context.to,
                        context.query,
                    ),
                );
            }
        return items.sort((a, b) => a.label.localeCompare(b.label));
    }

    /** Link and declared frontmatter targets, with exact source ranges. */
    referencesInText(text, file, projects = [this], includeFrontmatter = true) {
        const found = [];
        const bodyStart = text.match(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/)?.[0].length ?? 0;
        const linkText = text.slice(bodyStart);
        for (const match of matchAllOutsideCode(linkText, new RegExp(WIKILINK.source, "g"))) {
            const parsed = parseWikilink(match[1]);
            const record =
                parsed.target ? this.resolve(parsed.target, {}, projects) : this.byFile.get(file);
            if (!record) continue;
            const start = bodyStart + match.index + (parsed.target ? 2 : 3);
            found.push({
                record,
                anchor: parsed.anchor,
                written: parsed.target,
                defaults: {},
                location: location(
                    file,
                    text,
                    start,
                    start + (parsed.target || parsed.anchor).length,
                ),
            });
        }
        for (const embed of embedsIn(linkText)) {
            const defaults = { type: EMBED_DEFAULT_TYPE };
            const record = this.resolve(embed.written, defaults, projects);
            if (!record) continue;
            const start = bodyStart + embed.index + 3;
            found.push({
                record,
                anchor: "",
                written: embed.written,
                defaults,
                location: location(file, text, start, start + embed.written.length),
            });
        }
        if (!bodyStart || !includeFrontmatter) return found;
        const yamlStart = text.indexOf("\n") + 1;
        const yamlText = text.slice(yamlStart, bodyStart).replace(/\r?\n---(?:\r?\n)?$/, "");
        let document;
        try {
            document = YAML.parseDocument(yamlText);
        } catch {
            return found;
        }
        if (document.errors.length) return found;
        const frontmatter = document.toJS();
        if (!frontmatter || typeof frontmatter !== "object") return found;
        const visit = (node, segments, position) => {
            if (!node) return;
            if (segments.length) {
                const [head, ...tail] = segments;
                if (YAML.isMap(node)) {
                    for (const pair of node.items) {
                        if (head === "*" || String(pair.key?.value) === String(head))
                            visit(pair.value, tail, position);
                    }
                } else if (YAML.isSeq(node)) {
                    node.items.forEach((child, index) => {
                        if (head === "*" || String(index) === String(head))
                            visit(child, tail, position);
                    });
                }
                return;
            }
            const scalar = (part, value) => {
                if (!YAML.isScalar(part) || typeof value !== "string" || !part.range) return;
                const defaults = {
                    system: position.system ?? "none",
                    type: position.type,
                };
                const record = this.resolve(value, defaults, projects);
                if (!record) return;
                const start = yamlStart + part.range[0];
                found.push({
                    record,
                    anchor: "",
                    written: value,
                    defaults,
                    location: location(file, text, start, yamlStart + part.range[1]),
                });
            };
            if (position.shape === "keys" && YAML.isMap(node)) {
                for (const pair of node.items) scalar(pair.key, pair.key?.value);
            } else if (position.shape === "list" && YAML.isSeq(node)) {
                for (const child of node.items) scalar(child, child?.value);
            } else if (position.shape === "scalar-or-map" && YAML.isMap(node)) {
                for (const pair of node.items) scalar(pair.value, pair.value?.value);
            } else {
                scalar(node, node.value);
            }
        };
        for (const position of addressPositions(frontmatter))
            visit(document.contents, position.path, position);
        return found;
    }

    targetAt(uri, position, projects = [this]) {
        const text = this.text(uri);
        if (text == null) return null;
        const offset = offsetAt(text, position);
        if (offset < 0) return null;
        const file = fileURLToPath(uri);
        const reference = this.referencesInText(text, file, projects).find(
            ({ location: source }) => {
                const start = offsetAt(text, source.range.start);
                const end = offsetAt(text, source.range.end);
                return start <= offset && offset <= end;
            },
        );
        if (reference) return reference;
        const own = this.byFile.get(file);
        if (own && /^shortcode:\s*/.test(text.split("\n")[position.line] ?? ""))
            return { record: own, anchor: "", written: own.address?.canonical, defaults: {} };
        const start = text.slice(0, offset).search(/[A-Za-z0-9./-]+$/);
        if (start < 0) return null;
        const end = offset + (text.slice(offset).match(/^[A-Za-z0-9./-]+/)?.[0].length ?? 0);
        const written = text.slice(start, end);
        const record = this.resolve(written, {}, projects);
        return { record, anchor: "", written, defaults: {} };
    }

    definition(uri, position) {
        const projects = this.indexedWorkspaces(true);
        const source = this.sourceWorkspace(uri, projects);
        const target = source.targetAt(uri, position, projects);
        if (!target) return null;
        const candidates =
            target.written ?
                source.resolveCandidates(target.written, target.defaults, projects)
            :   [{ record: target.record, project: source }];
        const locations = [];
        for (const { record, project } of candidates) {
            const file = project.fileFor(record);
            if (!file) continue;
            if (record.asset) {
                locations.push({ uri: pathToFileURL(file).href, range: EMPTY_RANGE });
                continue;
            }
            const line =
                target.anchor ?
                    record.anchors?.find(
                        (entry) => entry.slug.toLowerCase() === target.anchor.toLowerCase(),
                    )?.line
                :   null;
            if (target.anchor && !line) continue;
            const targetText = fs.readFileSync(file, "utf8");
            const offset = line ? offsetAt(targetText, { line: line - 1, character: 0 }) : 0;
            locations.push(location(file, targetText, offset, offset));
        }
        return (
            locations.length === 1 ? locations[0]
            : locations.length ? locations
            : null
        );
    }

    symbols(query) {
        const includeForeign = /^all:/i.test(query);
        const search = includeForeign ? query.slice(4) : query;
        return this.indexedWorkspaces(includeForeign).flatMap((project) =>
            project.symbolMatches(search),
        );
    }

    symbolMatches(query) {
        const tag = /^tag:(.*)$/i.exec(query);
        const needle = (tag ? tag[1] : query).trim().toLowerCase();
        const found = new Map();
        for (const record of this.records) {
            if (!record.file?.path) continue;
            const values =
                tag ?
                    (record.tags ?? [])
                :   [
                        record.name?.full,
                        record.nameAscii,
                        ...(record.name?.aliases ?? []),
                        ...(record.aliasesAscii ?? []),
                        record.shortcode,
                        record.address?.slug,
                        record.address?.canonical,
                    ];
            const match = values.find(
                (value) => typeof value === "string" && value.toLowerCase().includes(needle),
            );
            if (!match) continue;
            const file = noteFile(this.contentRoot, record);
            if (found.has(file)) continue;
            found.set(file, {
                name: String(noteName(record)),
                kind: 1,
                containerName: `${record.package} · ${record.address?.slug ?? [record.type, record.shortcode].filter(Boolean).join(" ")} · ${tag ? `tag: ${match}` : match}`,
                location: { uri: pathToFileURL(file).href, range: EMPTY_RANGE },
            });
        }
        return [...found.values()];
    }

    references(uri, position) {
        const projects = this.indexedWorkspaces(true);
        const source = this.sourceWorkspace(uri, projects);
        const target = source.targetAt(uri, position, projects);
        if (!target) return [];
        const candidates =
            target.record ?
                [target.record]
            :   source
                    .resolveCandidates(target.written, target.defaults, projects)
                    .map(({ record }) => record);
        const addresses = new Set(
            candidates.map((record) => record.address?.canonical).filter(Boolean),
        );
        if (!addresses.size) return [];
        const locations = [];
        const needles = candidates.map((record) => record.shortcode.toLowerCase());
        const visit = (project, directory, frontmatterCandidates) => {
            for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
                if (entry.name.startsWith(".")) continue;
                const file = path.join(directory, entry.name);
                if (entry.isDirectory()) {
                    visit(project, file, frontmatterCandidates);
                } else if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) {
                    const savedText = fs.readFileSync(file, "utf8");
                    if (!needles.some((needle) => savedText.toLowerCase().includes(needle)))
                        continue;
                    for (const reference of project.referencesInText(
                        savedText,
                        file,
                        projects,
                        frontmatterCandidates.has(file),
                    )) {
                        if (addresses.has(reference.record.address?.canonical))
                            locations.push(reference.location);
                    }
                }
            }
        };
        for (const project of projects) {
            const frontmatterCandidates = new Set(
                project.records
                    .filter((record) =>
                        needles.some((needle) =>
                            JSON.stringify(record).toLowerCase().includes(needle),
                        ),
                    )
                    .filter((record) => record.file?.path)
                    .map((record) => noteFile(project.contentRoot, record)),
            );
            visit(project, project.contentRoot, frontmatterCandidates);
        }
        return locations;
    }
}

/** Process one JSON-RPC request without writing protocol bytes. */
export function respond(workspace, message) {
    const { method, params = {} } = message;
    switch (method) {
        case "initialize":
            workspace.configureForeignRoots(params.initializationOptions?.foreignRoots ?? []);
            workspace.start();
            return {
                capabilities: {
                    positionEncoding: "utf-16",
                    textDocumentSync: { openClose: true, change: 2, save: true },
                    definitionProvider: true,
                    completionProvider: { triggerCharacters: ["[", "#", "-"] },
                    referencesProvider: true,
                    workspaceSymbolProvider: true,
                    workspace: {
                        fileOperations: {
                            didCreate: [{ scheme: "file", pattern: { glob: "**/*.md" } }],
                            didRename: [{ scheme: "file", pattern: { glob: "**/*.md" } }],
                            didDelete: [{ scheme: "file", pattern: { glob: "**/*.md" } }],
                        },
                    },
                },
                serverInfo: { name: "heroiclands-content" },
            };
        case "shutdown":
            return null;
        case "workspace/didChangeConfiguration":
            if (params.settings?.heroiclands?.foreignRoots)
                workspace.configureForeignRoots(params.settings.heroiclands.foreignRoots);
            return undefined;
        case "textDocument/didOpen":
            workspace.documents.set(params.textDocument.uri, params.textDocument.text);
            return undefined;
        case "textDocument/didChange": {
            const uri = params.textDocument.uri;
            let text = workspace.text(uri) ?? "";
            for (const change of params.contentChanges ?? []) {
                if (!change.range) text = change.text;
                else {
                    const start = offsetAt(text, change.range.start);
                    const end = offsetAt(text, change.range.end);
                    text = text.slice(0, start) + change.text + text.slice(end);
                }
            }
            workspace.documents.set(uri, text);
            return undefined;
        }
        case "textDocument/didClose":
            workspace.documents.delete(params.textDocument.uri);
            return undefined;
        case "textDocument/didSave":
            workspace.scheduleRebuildForUri(params.textDocument.uri);
            return undefined;
        case "workspace/didChangeWatchedFiles":
        case "workspace/didCreateFiles":
        case "workspace/didRenameFiles":
        case "workspace/didDeleteFiles": {
            const files = params.changes ?? params.files ?? [];
            if (!files.length) workspace.scheduleRebuild();
            for (const item of files)
                for (const uri of [item.uri, item.oldUri, item.newUri].filter(Boolean))
                    workspace.scheduleRebuildForUri(uri);
            return undefined;
        }
        case "textDocument/definition":
            return workspace.definition(params.textDocument.uri, params.position);
        case "textDocument/completion": {
            const text = workspace.text(params.textDocument.uri);
            if (!mayCompleteAddress(text, offsetAt(text ?? "", params.position))) return [];
            const projects = workspace.indexedWorkspaces(true);
            const source = workspace.sourceWorkspace(params.textDocument.uri, projects);
            return source.completion(params.textDocument.uri, params.position, projects);
        }
        case "textDocument/references":
            return workspace.references(params.textDocument.uri, params.position);
        case "workspace/symbol":
            return workspace.symbols(params.query ?? "");
        default:
            return undefined;
    }
}

/** Run the stdio language server. */
export function runLanguageServer(
    input = process.stdin,
    output = process.stdout,
    workspace = new ContentWorkspace(),
) {
    let pending = Buffer.alloc(0);
    const send = (message) => {
        const body = Buffer.from(JSON.stringify(message));
        output.write(`Content-Length: ${body.length}\r\n\r\n`);
        output.write(body);
    };
    workspace.onStatus = (status) => {
        if (status)
            send({
                jsonrpc: "2.0",
                method: "window/showMessage",
                params: { type: 1, message: status },
            });
    };
    input.on("data", (chunk) => {
        pending = Buffer.concat([pending, chunk]);
        while (true) {
            const separator = pending.indexOf("\r\n\r\n");
            if (separator < 0) break;
            const header = pending.subarray(0, separator).toString("ascii");
            const length = /^content-length:\s*(\d+)\s*$/im.exec(header)?.[1];
            if (!length) throw new Error("LSP message has no Content-Length");
            const end = separator + 4 + Number(length);
            if (pending.length < end) break;
            const body = pending.subarray(separator + 4, end);
            pending = pending.subarray(end);
            let message;
            try {
                message = JSON.parse(body.toString("utf8"));
            } catch (error) {
                send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: String(error) } });
                continue;
            }
            if (message.method === "exit") {
                process.exitCode = 0;
                workspace.close();
                input.pause();
                return;
            }
            try {
                const result = respond(workspace, message);
                if (message.id !== undefined)
                    send(
                        result === undefined ?
                            {
                                jsonrpc: "2.0",
                                id: message.id,
                                error: { code: -32601, message: "Method not found" },
                            }
                        :   { jsonrpc: "2.0", id: message.id, result },
                    );
            } catch (error) {
                if (message.id !== undefined)
                    send({
                        jsonrpc: "2.0",
                        id: message.id,
                        error: { code: -32603, message: String(error) },
                    });
            }
        }
    });
}
