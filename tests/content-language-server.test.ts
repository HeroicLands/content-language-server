/*
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { pathToFileURL } from "node:url";
import {
    ContentWorkspace,
    respond,
    runLanguageServer,
} from "../engine/content-language-server.mjs";
import { generatorVersion } from "../engine/content-language-index.mjs";

let root: string;
let workspace: ContentWorkspace;

function note(file: string, text: string): string {
    const full = path.join(root, "assets/content", file);
    fs.writeFileSync(full, text);
    return pathToFileURL(full).href;
}

function index(records: object[]): void {
    fs.mkdirSync(workspace.cacheDirectory, { recursive: true });
    const text = records.map((record) => JSON.stringify(record)).join("\n") + "\n";
    fs.writeFileSync(workspace.indexFile, text);
    fs.writeFileSync(
        path.join(workspace.cacheDirectory, "metadata.json"),
        JSON.stringify({
            package: "test",
            generatorVersion,
            sha256: crypto.createHash("sha256").update(text).digest("hex"),
        }),
    );
    workspace.started = true;
    workspace.indexState = "";
}

const alpha = {
    package: "test",
    type: "lore",
    shortcode: "alpha",
    name: { full: "Ályra", aliases: ["First Light"] },
    nameAscii: "Alyra",
    aliasesAscii: ["First Light"],
    tags: ["myth"],
    address: { slug: "lore-alpha", canonical: "test-none-lore-alpha" },
    anchors: [{ slug: "history", line: 7, name: "History" }],
    file: { path: "Alpha.md" },
};

beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "heroiclands-lsp-"));
    fs.mkdirSync(path.join(root, "assets/content"), { recursive: true });
    fs.mkdirSync(path.join(root, "build/content-index"), { recursive: true });
    workspace = new ContentWorkspace(
        {
            rootDir: root,
            contentPackage: "test",
            packs: [],
            skipDirectories: [],
            paths: {
                content: path.join(root, "assets/content"),
                assets: path.join(root, "assets"),
                contentIndex: path.join(root, "build/content-index"),
            },
        } as any,
        { cacheBase: path.join(root, "cache") },
    );
});

afterEach(() => {
    workspace.close();
    vi.useRealTimers();
    fs.rmSync(root, { recursive: true, force: true });
});

function savedLore(file: string, shortcode: string, name: string): string {
    return note(
        file,
        `---\ntype: lore\nshortcode: ${shortcode}\nname:\n  full: ${name}\n---\nBody.\n`,
    );
}

describe("content language server", () => {
    it("builds its private index from saved notes on initialization", () => {
        savedLore("Alpha.md", "alpha", "Alpha");
        const result = respond(workspace, { method: "initialize" });
        expect(result?.capabilities.workspaceSymbolProvider).toBe(true);
        expect(workspace.indexFile).not.toContain("build/content-index");
        expect(fs.existsSync(workspace.indexFile)).toBe(true);
        expect(workspace.symbols("Alpha")).toHaveLength(1);
    });

    it("regenerates stale, corrupt, and wrong-version caches before answering", () => {
        savedLore("Alpha.md", "alpha", "Fresh");
        for (const corrupt of ["stale", "corrupt", "wrong-version"]) {
            index([{ ...alpha, name: { full: "Stale" } }]);
            if (corrupt === "corrupt") fs.writeFileSync(workspace.indexFile, "partial");
            if (corrupt === "wrong-version") {
                const file = path.join(workspace.cacheDirectory, "metadata.json");
                const metadata = JSON.parse(fs.readFileSync(file, "utf8"));
                metadata.generatorVersion = "0.0.0";
                fs.writeFileSync(file, JSON.stringify(metadata));
            }
            workspace.started = false;
            respond(workspace, { method: "initialize" });
            expect(workspace.symbols("Fresh")).toHaveLength(1);
            expect(workspace.symbols("Stale")).toHaveLength(0);
        }
    });

    it("coalesces saves and reflects additions, changes, moves, and deletions", () => {
        vi.useFakeTimers();
        const first = savedLore("Alpha.md", "alpha", "First");
        respond(workspace, { method: "initialize" });
        const rebuild = vi.spyOn(workspace, "rebuild");
        savedLore("Beta.md", "beta", "Second");
        for (let i = 0; i < 3; i++) {
            respond(workspace, {
                method: "textDocument/didSave",
                params: { textDocument: { uri: first } },
            });
            vi.advanceTimersByTime(100);
        }
        expect(rebuild).not.toHaveBeenCalled();
        vi.advanceTimersByTime(300);
        expect(rebuild).toHaveBeenCalledTimes(1);
        expect(workspace.symbols("Second")).toHaveLength(1);
        fs.renameSync(
            path.join(root, "assets/content/Beta.md"),
            path.join(root, "assets/content/Gamma.md"),
        );
        fs.rmSync(path.join(root, "assets/content/Alpha.md"));
        respond(workspace, { method: "workspace/didRenameFiles" });
        vi.advanceTimersByTime(300);
        expect(workspace.symbols("First")).toHaveLength(0);
        expect(workspace.symbols("Second")[0].location.uri).toContain("Gamma.md");
    });

    it("updates indexed names, aliases, tags, shortcodes, and addresses after save", () => {
        vi.useFakeTimers();
        const target = savedLore("Alpha.md", "alpha", "First");
        const source = note("Source.md", "See [[lore-beta|Second]].\n");
        respond(workspace, { method: "initialize" });
        note(
            "Alpha.md",
            "---\ntype: lore\nshortcode: beta\nname:\n  full: Second\n  aliases:\n    - Other Name\ntags:\n  - myth\n---\nBody.\n",
        );
        respond(workspace, {
            method: "textDocument/didSave",
            params: { textDocument: { uri: target } },
        });
        vi.advanceTimersByTime(300);
        expect(workspace.symbols("First")).toHaveLength(0);
        expect(workspace.symbols("Second")).toHaveLength(1);
        expect(workspace.symbols("Other Name")).toHaveLength(1);
        expect(workspace.symbols("tag:myth")).toHaveLength(1);
        expect(workspace.symbols("lore-beta")).toHaveLength(1);
        expect(workspace.symbols("lore-alpha")).toHaveLength(0);
        expect(workspace.definition(source, { line: 0, character: 8 })?.uri).toBe(target);
    });

    it("keeps the last complete snapshot on failure and recovers after a save", () => {
        savedLore("Alpha.md", "alpha", "First");
        const status: string[] = [];
        workspace.onStatus = (message: string | null) => {
            if (message) status.push(message);
        };
        respond(workspace, { method: "initialize" });
        const old = fs.readFileSync(workspace.indexFile, "utf8");
        fs.rmSync(path.join(root, "assets/content/Alpha.md"));
        expect(workspace.rebuild()).toBe(false);
        expect(fs.readFileSync(workspace.indexFile, "utf8")).toBe(old);
        expect(workspace.symbols("First")).toHaveLength(1);
        expect(status.at(-1)).toContain("last complete snapshot");
        savedLore("Beta.md", "beta", "Second");
        expect(workspace.rebuild()).toBe(true);
        expect(workspace.symbols("Second")).toHaveLength(1);
        expect(workspace.symbols("First")).toHaveLength(0);
    });

    it("refuses to replace a snapshot from a newer generator", () => {
        savedLore("Alpha.md", "alpha", "First");
        respond(workspace, { method: "initialize" });
        const file = path.join(workspace.cacheDirectory, "metadata.json");
        const metadata = JSON.parse(fs.readFileSync(file, "utf8"));
        metadata.generatorVersion = "999.0.0";
        fs.writeFileSync(file, JSON.stringify(metadata));
        const old = fs.readFileSync(workspace.indexFile, "utf8");
        savedLore("Beta.md", "beta", "Second");
        const status: string[] = [];
        workspace.onStatus = (message: string | null) => {
            if (message) status.push(message);
        };
        expect(workspace.rebuild()).toBe(false);
        expect(fs.readFileSync(workspace.indexFile, "utf8")).toBe(old);
        expect(status.at(-1)).toContain("newer generator");
    });

    it("recovers the last complete pair after interrupted publication", () => {
        savedLore("Alpha.md", "alpha", "First");
        respond(workspace, { method: "initialize" });
        const manifest = path.join(workspace.cacheDirectory, "metadata.json");
        fs.copyFileSync(workspace.indexFile, `${workspace.indexFile}.previous`);
        fs.copyFileSync(manifest, `${manifest}.previous`);
        fs.writeFileSync(workspace.indexFile, "incomplete\n");
        workspace.records = [];
        workspace.indexState = "";
        expect(workspace.refresh()).toBe(true);
        expect(workspace.symbols("First")).toHaveLength(1);
    });

    it("does not read or replace the project's build index", () => {
        savedLore("Alpha.md", "alpha", "Private");
        index([{ ...alpha, name: { full: "Build Output" } }]);
        const buildFile = path.join(root, "build/content-index/test-metadata.jsonl");
        fs.writeFileSync(buildFile, "build-only\n");
        workspace.started = false;
        respond(workspace, { method: "initialize" });
        expect(workspace.symbols("Private")).toHaveLength(1);
        expect(workspace.symbols("Build Output")).toHaveLength(0);
        expect(fs.readFileSync(buildFile, "utf8")).toBe("build-only\n");
        fs.rmSync(path.join(root, "build"), { recursive: true });
        expect(workspace.symbols("Private")).toHaveLength(1);
    });

    it("searches indexed names, aliases, shortcodes, and tags once per note", () => {
        note("Alpha.md", "---\ntype: lore\nshortcode: alpha\n---\nÁlyra\n");
        index([alpha, { ...alpha, type: "doclore" }]);
        expect(workspace.symbols("alyra")).toHaveLength(1);
        expect(workspace.symbols("first light")).toHaveLength(1);
        expect(workspace.symbols("lore-alpha")).toHaveLength(1);
        expect(workspace.symbols("tag:myth")).toHaveLength(1);
        expect(workspace.symbols("tag:other")).toHaveLength(0);
    });

    it("finds indexed draft and stub notes without published addresses", () => {
        note("Stub.md", "---\ntype: lore\nshortcode: stub\n---\n");
        index([
            {
                ...alpha,
                name: { full: "Unwritten Legend" },
                address: null,
                file: { path: "Stub.md" },
            },
        ]);
        expect(workspace.symbols("unwritten")).toHaveLength(1);
    });

    it("follows an indexed anchor from an unsaved buffer", () => {
        note("Alpha.md", "One\nTwo\nThree\nFour\nFive\nSix\nHistory\n");
        const source = note("Source.md", "See [[lore-alpha#history|Ályra]].\n");
        index([alpha]);
        respond(workspace, {
            method: "textDocument/didOpen",
            params: {
                textDocument: { uri: source, text: "See [[lore-alpha#history|Ályra]] and more.\n" },
            },
        });
        expect(workspace.definition(source, { line: 0, character: 10 })?.range.start).toEqual({
            line: 6,
            character: 0,
        });
    });

    it("follows a same-note anchor", () => {
        const source = note(
            "Alpha.md",
            "See [[#history|History]].\n\nOne\nTwo\nThree\nFour\nHistory\n",
        );
        index([alpha]);
        expect(workspace.definition(source, { line: 0, character: 9 })?.range.start).toEqual({
            line: 6,
            character: 0,
        });
    });

    it("finds actual links, excluding prose and unrelated frontmatter", () => {
        const target = note("Alpha.md", "---\ntype: lore\nshortcode: alpha\n---\nÁlyra\n");
        note(
            "Source.md",
            "---\ntype: lore\nshortcode: source\n---\nSee [[lore-alpha|Ályra]]. lore-alpha is prose.\n",
        );
        index([alpha]);
        expect(workspace.references(target, { line: 2, character: 12 })).toEqual([
            expect.objectContaining({
                range: { start: { line: 4, character: 6 }, end: { line: 4, character: 16 } },
            }),
        ]);
    });

    it("counts embeds but excludes links written as code examples", () => {
        const target = note("Icon.md", "---\ntype: icon\nshortcode: sun\n---\n");
        note(
            "Source.md",
            "![[icon-sun|Sun]]\n\n```markdown\n![[icon-sun|Example]]\n[[icon-sun|Example]]\n```\n",
        );
        index([
            {
                ...alpha,
                type: "icon",
                shortcode: "sun",
                name: { full: "Sun" },
                address: { slug: "icon-sun", canonical: "test-none-icon-sun" },
                file: { path: "Icon.md" },
            },
        ]);
        expect(workspace.references(target, { line: 2, character: 13 })).toEqual([
            expect.objectContaining({
                range: { start: { line: 0, character: 3 }, end: { line: 0, character: 11 } },
            }),
        ]);
    });

    it("opens indexed assets from the asset root", () => {
        const source = note("Source.md", "![[icon-sun|Sun]]\n");
        const asset = path.join(root, "assets/icons/sun.webp");
        fs.mkdirSync(path.dirname(asset), { recursive: true });
        fs.writeFileSync(asset, "image bytes");
        index([
            {
                package: "test",
                type: "icon",
                shortcode: "sun",
                address: { canonical: "test-none-icon-sun" },
                asset: { path: "icons/sun.webp" },
            },
        ]);
        expect(workspace.definition(source, { line: 0, character: 7 })?.uri).toBe(
            pathToFileURL(asset).href,
        );
    });

    it("finds declared Address keys in frontmatter", () => {
        const target = note("Guild.md", "---\ntype: affiliation\nshortcode: guild\n---\nGuild.\n");
        note(
            "Ally.md",
            "---\ntype: affiliation\nshortcode: ally\ndata:\n  relations:\n    guild: ally\n---\nThe guild is nearby.\n",
        );
        index([
            {
                ...alpha,
                type: "docaffiliation",
                shortcode: "guild",
                address: { slug: "affiliation-guild", canonical: "test-none-docaffiliation-guild" },
                file: { path: "Guild.md" },
            },
        ]);
        expect(workspace.references(target, { line: 2, character: 13 })).toEqual([
            expect.objectContaining({
                range: { start: { line: 5, character: 4 }, end: { line: 5, character: 9 } },
            }),
        ]);
    });

    it("reloads the index after a completed rebuild", () => {
        note("Alpha.md", "---\ntype: lore\nshortcode: alpha\n---\nÁlyra\n");
        index([alpha]);
        expect(workspace.symbols("alpha")).toHaveLength(1);
        index([{ ...alpha, name: { full: "Changed" } }, alpha]);
        expect(workspace.symbols("changed")).toHaveLength(1);
    });

    it("reports a missing index and a save recovery action", () => {
        expect(() => workspace.symbols("alpha")).toThrow("save a note to retry");
    });

    it("accepts framed JSON-RPC requests split across input chunks", () => {
        note("Alpha.md", "---\ntype: lore\nshortcode: alpha\n---\nÁlyra\n");
        index([alpha]);
        const input = new PassThrough();
        const output = new PassThrough();
        let reply = "";
        output.on("data", (chunk) => {
            reply += chunk.toString();
        });
        runLanguageServer(input, output, workspace);
        const body = JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "workspace/symbol",
            params: { query: "Alyra" },
        });
        const frame = `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`;
        input.write(frame.slice(0, 9));
        input.write(frame.slice(9));
        expect(reply).toContain('"id":1');
        expect(reply).toContain('"name":"Ályra"');
    });
});
