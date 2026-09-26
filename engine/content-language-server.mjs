/*
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import YAML from "yaml";
import { parseAddress, renderAddress } from "@heroiclands/package-build/engine/address";
import { addressPositions } from "@heroiclands/package-build/engine/note-addresses";
import { parseWikilink, WIKILINK } from "@heroiclands/package-build/engine/wikilink-syntax";
import { loadPackConfig } from "@heroiclands/package-build/engine/pack-config";
import { noteFile } from "@heroiclands/package-build/engine/index-records";
import { NOTE_VOCABULARY } from "@heroiclands/package-build/engine/note-vocabulary";
import {
    languageIndexDirectory,
    readLanguageIndex,
    rebuildLanguageIndex,
} from "./content-language-index.mjs";
import { matchAllOutsideCode } from "@heroiclands/package-build/engine/code-fences";
import { embedsIn, EMBED_DEFAULT_TYPE } from "@heroiclands/package-build/engine/content-embeds";

const EMPTY_RANGE = { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } };

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

/** An index read from the package's configured content tree. */
export class ContentWorkspace {
    constructor(config = loadPackConfig(), { cacheBase, onStatus = () => {} } = {}) {
        this.config = config;
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
        this.types = new Set(Object.keys(NOTE_VOCABULARY));
        this.documents = new Map();
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
        const types = new Set(Object.keys(NOTE_VOCABULARY));
        for (const record of records) {
            if (record.type) types.add(record.type);
            if (record.address?.canonical)
                byAddress.set(record.address.canonical.toLowerCase(), record);
            if (record.file?.path) {
                const file = noteFile(this.contentRoot, record);
                if (!byFile.has(file)) byFile.set(file, record);
            }
        }
        this.records = records;
        this.byAddress = byAddress;
        this.byFile = byFile;
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

    start() {
        if (this.started) return;
        this.started = true;
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
    resolve(value, defaults = {}) {
        const tuple = parseAddress(value, {
            package: this.config.contentPackage,
            system: "none",
            types: this.types,
            packages: new Set([this.config.contentPackage]),
            ...defaults,
        });
        if (tuple.reason) return null;
        return this.byAddress.get(renderAddress(tuple)) ?? null;
    }

    /** Link and declared frontmatter targets, with exact source ranges. */
    referencesInText(text, file) {
        const found = [];
        const bodyStart = text.match(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/)?.[0].length ?? 0;
        const linkText = text.slice(bodyStart);
        for (const match of matchAllOutsideCode(linkText, new RegExp(WIKILINK.source, "g"))) {
            const parsed = parseWikilink(match[1]);
            const record = parsed.target ? this.resolve(parsed.target) : this.byFile.get(file);
            if (!record) continue;
            const start = bodyStart + match.index + (parsed.target ? 2 : 3);
            found.push({
                record,
                anchor: parsed.anchor,
                location: location(
                    file,
                    text,
                    start,
                    start + (parsed.target || parsed.anchor).length,
                ),
            });
        }
        for (const embed of embedsIn(linkText)) {
            const record = this.resolve(embed.written, { type: EMBED_DEFAULT_TYPE });
            if (!record) continue;
            const start = bodyStart + embed.index + 3;
            found.push({
                record,
                anchor: "",
                location: location(file, text, start, start + embed.written.length),
            });
        }
        if (!bodyStart) return found;
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
                const record = this.resolve(value, {
                    system: position.system ?? "none",
                    type: position.type,
                });
                if (!record) return;
                const start = yamlStart + part.range[0];
                found.push({
                    record,
                    anchor: "",
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

    targetAt(uri, position) {
        const text = this.text(uri);
        if (text == null) return null;
        const offset = offsetAt(text, position);
        if (offset < 0) return null;
        const file = fileURLToPath(uri);
        const reference = this.referencesInText(text, file).find(({ location: source }) => {
            const start = offsetAt(text, source.range.start);
            const end = offsetAt(text, source.range.end);
            return start <= offset && offset <= end;
        });
        if (reference) return { record: reference.record, anchor: reference.anchor };
        const own = this.byFile.get(file);
        if (own && /^shortcode:\s*/.test(text.split("\n")[position.line] ?? ""))
            return { record: own, anchor: "" };
        const start = text.slice(0, offset).search(/[A-Za-z0-9./]+$/);
        if (start < 0) return null;
        const end = offset + (text.slice(offset).match(/^[A-Za-z0-9./]+/)?.[0].length ?? 0);
        const record = this.resolve(text.slice(start, end));
        return record ? { record, anchor: "" } : null;
    }

    definition(uri, position) {
        this.requireIndex();
        const target = this.targetAt(uri, position);
        if (!target) return null;
        const { record, anchor } = target;
        const file = this.fileFor(record);
        if (!file) return null;
        if (record.asset) return { uri: pathToFileURL(file).href, range: EMPTY_RANGE };
        const line =
            anchor ?
                record.anchors?.find((entry) => entry.slug.toLowerCase() === anchor.toLowerCase())
                    ?.line
            :   null;
        if (anchor && !line) return null;
        const targetText = fs.readFileSync(file, "utf8");
        const offset = line ? offsetAt(targetText, { line: line - 1, character: 0 }) : 0;
        return location(file, targetText, offset, offset);
    }

    symbols(query) {
        this.requireIndex();
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
                containerName: `${record.address?.slug ?? [record.type, record.shortcode].filter(Boolean).join(" ")} · ${tag ? `tag: ${match}` : match}`,
                location: { uri: pathToFileURL(file).href, range: EMPTY_RANGE },
            });
        }
        return [...found.values()];
    }

    references(uri, position) {
        this.requireIndex();
        const target = this.targetAt(uri, position)?.record;
        if (!target?.address?.canonical) return [];
        const locations = [];
        const needle = target.shortcode.toLowerCase();
        const visit = (directory) => {
            for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
                if (entry.name.startsWith(".")) continue;
                const file = path.join(directory, entry.name);
                if (entry.isDirectory()) {
                    visit(file);
                } else if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) {
                    const savedText = fs.readFileSync(file, "utf8");
                    if (!savedText.toLowerCase().includes(needle)) continue;
                    const text = this.documents.get(pathToFileURL(file).href) ?? savedText;
                    for (const reference of this.referencesInText(text, file)) {
                        if (reference.record.address?.canonical === target.address.canonical)
                            locations.push(reference.location);
                    }
                }
            }
        };
        visit(this.contentRoot);
        return locations;
    }
}

/** Process one JSON-RPC request without writing protocol bytes. */
export function respond(workspace, message) {
    const { method, params = {} } = message;
    switch (method) {
        case "initialize":
            workspace.start();
            return {
                capabilities: {
                    positionEncoding: "utf-16",
                    textDocumentSync: { openClose: true, change: 2, save: true },
                    definitionProvider: true,
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
        case "workspace/didChangeWatchedFiles":
        case "workspace/didCreateFiles":
        case "workspace/didRenameFiles":
        case "workspace/didDeleteFiles":
            workspace.scheduleRebuild();
            return undefined;
        case "textDocument/definition":
            return workspace.definition(params.textDocument.uri, params.position);
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
