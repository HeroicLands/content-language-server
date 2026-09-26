/*
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
    ContentWorkspace,
    respond,
    runLanguageServer,
} from "../engine/content-language-server.mjs";
import { generatorVersion } from "../engine/content-language-index.mjs";

let root: string;
let workspace: ContentWorkspace;
let foreignDirectories: string[];

function note(file: string, text: string): string {
    const full = path.join(root, "assets/content", file);
    fs.writeFileSync(full, text);
    return pathToFileURL(full).href;
}

function index(records: object[]): void {
    indexFor(workspace, records);
}

function indexFor(project: ContentWorkspace, records: object[]): void {
    fs.mkdirSync(project.cacheDirectory, { recursive: true });
    const text = records.map((record) => JSON.stringify(record)).join("\n") + "\n";
    fs.writeFileSync(project.indexFile, text);
    fs.writeFileSync(
        path.join(project.cacheDirectory, "metadata.json"),
        JSON.stringify({
            package: project.config.contentPackage,
            generatorVersion,
            sha256: crypto.createHash("sha256").update(text).digest("hex"),
        }),
    );
    project.started = true;
    project.indexState = "";
}

const alpha = {
    package: "test",
    type: "lore",
    shortcode: "alpha",
    name: { full: "Ályra", aliases: ["First Light"] },
    nameAscii: "Alyra",
    aliasesAscii: ["First Light"],
    tags: ["myth"],
    address: { slug: "lore-alpha", canonical: "test-note-lore-alpha" },
    anchors: [{ slug: "history", line: 7, name: "History" }],
    file: { path: "Alpha.md" },
};

beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "heroiclands-lsp-"));
    foreignDirectories = [];
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
    for (const directory of foreignDirectories)
        fs.rmSync(directory, { recursive: true, force: true });
});

function savedLore(file: string, shortcode: string, name: string): string {
    return note(
        file,
        `---\ntype: lore\nshortcode: ${shortcode}\nname:\n  full: ${name}\n---\nBody.\n`,
    );
}

function foreignProject(contentPackage = "other") {
    const directory = fs.realpathSync(
        fs.mkdtempSync(path.join(os.tmpdir(), "heroiclands-foreign-")),
    );
    foreignDirectories.push(directory);
    fs.mkdirSync(path.join(directory, "assets/content"), { recursive: true });
    const config = {
        rootDir: directory,
        contentPackage,
        packs: [],
        skipDirectories: [],
        paths: {
            content: path.join(directory, "assets/content"),
            assets: path.join(directory, "assets"),
            contentIndex: path.join(directory, "build/content-index"),
        },
    };
    workspace.loadProjectConfig = (selected: string) => {
        if (selected !== directory) throw new Error("No content configuration at " + selected);
        return config;
    };
    const save = (file: string, text: string) => {
        const full = path.join(config.paths.content, file);
        fs.writeFileSync(full, text);
        return pathToFileURL(full).href;
    };
    return { directory, config, save };
}

describe("content language server", () => {
    it("uses note for wikilinks and none for embedded asset completion", () => {
        const source = note("Source.md", "[[camel");
        index([
            {
                ...alpha,
                type: "macro",
                shortcode: "camel",
                name: { full: "Camel Macro" },
                address: { slug: "macro-camel", canonical: "test-note-macro-camel" },
            },
            {
                ...alpha,
                type: "macro",
                shortcode: "camel",
                name: { full: "Camel Macro" },
                address: { slug: "macro-camel", canonical: "test-none-macro-camel" },
            },
            {
                package: "test",
                type: "image",
                shortcode: "camel",
                name: { full: "Camel Portrait" },
                address: { canonical: "test-none-image-camel" },
                asset: { path: "images/camel.webp" },
            },
        ]);
        const links = respond(workspace, {
            method: "textDocument/completion",
            params: { textDocument: { uri: source }, position: { line: 0, character: 7 } },
        }) as any[];
        expect(
            links.find((item) => item.detail.includes("test-note-macro-camel"))?.textEdit.newText,
        ).toBe("macro-camel");
        expect(
            links.find((item) => item.detail.includes("test-none-macro-camel"))?.textEdit.newText,
        ).toBe("none-macro-camel");
        respond(workspace, {
            method: "textDocument/didChange",
            params: { textDocument: { uri: source }, contentChanges: [{ text: "![[camel" }] },
        });
        const embeds = respond(workspace, {
            method: "textDocument/completion",
            params: { textDocument: { uri: source }, position: { line: 0, character: 8 } },
        }) as any[];
        expect(embeds.map((item) => item.textEdit.newText)).toEqual(["camel"]);
        expect(embeds[0].detail).toContain("test-none-image-camel");
    });

    it("resolves link and embed targets with their own defaults and counts each once", () => {
        const text = "[[macro-camel|note]] [[none-macro-camel|sheet]]\n![[image-camel|picture]]\n";
        const source = note("Source.md", text);
        index([
            {
                ...alpha,
                type: "macro",
                shortcode: "camel",
                address: { canonical: "test-note-macro-camel" },
            },
            {
                ...alpha,
                type: "macro",
                shortcode: "camel",
                address: { canonical: "test-none-macro-camel" },
            },
            {
                package: "test",
                type: "image",
                shortcode: "camel",
                address: { canonical: "test-none-image-camel" },
                asset: { path: "images/camel.webp" },
            },
        ]);
        workspace.requireIndex();
        expect(workspace.resolve("note-macro-camel")?.address.canonical).toBe(
            "test-note-macro-camel",
        );
        expect(workspace.resolve("none-macro-camel")?.address.canonical).toBe(
            "test-none-macro-camel",
        );
        const found = workspace.referencesInText(text, fileURLToPath(source));
        expect(found.map((entry) => entry.record.address.canonical)).toEqual([
            "test-note-macro-camel",
            "test-none-macro-camel",
            "test-none-image-camel",
        ]);
    });

    it("completes an art field against the systemless asset", () => {
        const source = note(
            "Source.md",
            "---\ntype: being\nshortcode: source\ndata:\n  icon: cam\n---\n",
        );
        index([
            {
                package: "test",
                type: "icon",
                shortcode: "camel",
                name: { full: "Camel Icon" },
                address: { canonical: "test-none-icon-camel" },
                asset: { path: "icons/camel.webp" },
            },
        ]);
        const items = respond(workspace, {
            method: "textDocument/completion",
            params: { textDocument: { uri: source }, position: { line: 4, character: 11 } },
        }) as any[];
        expect(items.map((item) => item.textEdit.newText)).toEqual(["camel"]);
    });

    it("completes middle-of-name matches with the shortest unambiguous Address", () => {
        const source = note("Source.md", "See [[camel");
        const localBeing = {
            ...alpha,
            package: "test",
            type: "being",
            shortcode: "bctrncml",
            name: { full: "Xerathian Bactrian Camel" },
            nameAscii: "Xerathian Bactrian Camel",
            address: { slug: "being-bctrncml", canonical: "test-sohl-being-bctrncml" },
            file: { path: "Camel.md" },
        };
        index([
            localBeing,
            {
                ...localBeing,
                type: "being",
                address: { slug: "being-bctrncml", canonical: "test-note-being-bctrncml" },
            },
            {
                ...alpha,
                shortcode: "triceritops",
                name: { full: "Bicamelan Triceritops" },
                nameAscii: "Bicamelan Triceritops",
                address: { slug: "lore-triceritops", canonical: "test-note-lore-triceritops" },
                file: { path: "Triceritops.md" },
            },
        ]);
        const foreign = foreignProject("sohl");
        indexFor(workspace.foreignWorkspace(foreign.directory), [
            {
                ...localBeing,
                package: "sohl",
                name: { full: "Bactrian Camel" },
                nameAscii: "Bactrian Camel",
                address: { slug: "being-bctrncml", canonical: "sohl-sohl-being-bctrncml" },
            },
        ]);
        workspace.configureForeignRoots([foreign.directory]);
        const items = respond(workspace, {
            method: "textDocument/completion",
            params: { textDocument: { uri: source }, position: { line: 0, character: 11 } },
        }) as any[];
        expect(items.some((item) => item.label.startsWith("Bicamelan Triceritops"))).toBe(true);
        expect(items.some((item) => item.label.startsWith("Bactrian Camel"))).toBe(true);
        expect(items.some((item) => item.label.startsWith("Xerathian Bactrian Camel"))).toBe(true);
        expect(
            items.find((item) => item.detail.includes("test-sohl-being-bctrncml"))?.textEdit,
        ).toMatchObject({ newText: "sohl-being-bctrncml" });
        expect(
            items.find((item) => item.detail.includes("sohl-sohl-being-bctrncml"))?.textEdit,
        ).toMatchObject({ newText: "sohl-sohl-being-bctrncml" });
        expect(
            items.filter((item) => item.detail.includes("test-note-being-bctrncml")),
        ).toHaveLength(1);
        expect(items.every((item) => item.filterText === "camel")).toBe(true);
        expect(items.every((item) => item.textEdit.range.start.character === 6)).toBe(true);
    });

    it("completes an empty link and a qualified Address without editing a closed link", () => {
        const source = note("Source.md", "[[");
        index([alpha, alpha]);
        const empty = respond(workspace, {
            method: "textDocument/completion",
            params: { textDocument: { uri: source }, position: { line: 0, character: 2 } },
        }) as any[];
        expect(empty).toHaveLength(1);
        respond(workspace, {
            method: "textDocument/didChange",
            params: {
                textDocument: { uri: source },
                contentChanges: [{ text: "[[test-note-lore-al" }],
            },
        });
        const qualified = respond(workspace, {
            method: "textDocument/completion",
            params: { textDocument: { uri: source }, position: { line: 0, character: 19 } },
        }) as any[];
        expect(qualified).toHaveLength(1);
        expect(qualified[0].textEdit.newText).toBe("lore-alpha");
        respond(workspace, {
            method: "textDocument/didChange",
            params: {
                textDocument: { uri: source },
                contentChanges: [{ text: "[[lore-alpha|Ályra]]" }],
            },
        });
        expect(
            respond(workspace, {
                method: "textDocument/completion",
                params: { textDocument: { uri: source }, position: { line: 0, character: 6 } },
            }),
        ).toEqual([]);
    });

    it("does not load foreign indexes for completion in ordinary prose", () => {
        const source = note("Source.md", "Plain prose.\n");
        index([alpha]);
        const missing = path.join(root, "missing-project");
        const status: string[] = [];
        workspace.onStatus = (message: string | null) => {
            if (message) status.push(message);
        };
        workspace.configureForeignRoots([missing]);
        expect(
            respond(workspace, {
                method: "textDocument/completion",
                params: { textDocument: { uri: source }, position: { line: 0, character: 5 } },
            }),
        ).toEqual([]);
        expect(status).toEqual([]);
    });

    it("completes aliases and anchors with exact UTF-16 edits", () => {
        const source = note("Source.md", "🐪 [[light");
        index([alpha]);
        const named = respond(workspace, {
            method: "textDocument/completion",
            params: { textDocument: { uri: source }, position: { line: 0, character: 10 } },
        }) as any[];
        expect(named).toHaveLength(1);
        expect(named[0].textEdit).toEqual({
            range: {
                start: { line: 0, character: 5 },
                end: { line: 0, character: 10 },
            },
            newText: "lore-alpha",
        });
        respond(workspace, {
            method: "textDocument/didChange",
            params: {
                textDocument: { uri: source },
                contentChanges: [{ text: "See [[lore-alpha#his" }],
            },
        });
        const anchors = respond(workspace, {
            method: "textDocument/completion",
            params: { textDocument: { uri: source }, position: { line: 0, character: 20 } },
        }) as any[];
        expect(anchors).toHaveLength(1);
        expect(anchors[0].textEdit).toMatchObject({ newText: "history" });
    });

    it("completes declared frontmatter Address values from indexed records", () => {
        const text =
            "---\ntype: place\nshortcode: route\ndata:\n  routes:\n    - to: cam\n---\nBody.\n";
        const source = note("Route.md", text);
        index([
            {
                ...alpha,
                type: "place",
                shortcode: "camel",
                name: { full: "Camel Crossing" },
                nameAscii: "Camel Crossing",
                address: { slug: "place-camel", canonical: "test-note-place-camel" },
                file: { path: "Camel.md" },
            },
            alpha,
        ]);
        const items = respond(workspace, {
            method: "textDocument/completion",
            params: { textDocument: { uri: source }, position: { line: 5, character: 13 } },
        }) as any[];
        expect(items).toHaveLength(1);
        expect(items[0].textEdit).toEqual({
            range: {
                start: { line: 5, character: 10 },
                end: { line: 5, character: 13 },
            },
            newText: "camel",
        });
    });

    it("completes declared Address keys while leaving their mapped values intact", () => {
        const text =
            "---\ntype: affiliation\nshortcode: source\ndata:\n  relations:\n    cam: rival\n---\n";
        const source = note("Source.md", text);
        index([
            {
                ...alpha,
                type: "affiliation",
                shortcode: "camel",
                name: { full: "Camel Guild" },
                nameAscii: "Camel Guild",
                address: {
                    slug: "affiliation-camel",
                    canonical: "test-note-affiliation-camel",
                },
            },
        ]);
        const items = respond(workspace, {
            method: "textDocument/completion",
            params: { textDocument: { uri: source }, position: { line: 5, character: 7 } },
        }) as any[];
        expect(items).toHaveLength(1);
        expect(items[0].textEdit).toEqual({
            range: {
                start: { line: 5, character: 4 },
                end: { line: 5, character: 7 },
            },
            newText: "camel",
        });
    });

    it("searches foreign indexes only with an explicit symbol scope", () => {
        savedLore("Alpha.md", "alpha", "Shared Name");
        const foreign = foreignProject();
        const foreignUri = foreign.save(
            "Beta.md",
            "---\ntype: lore\nshortcode: beta\nname:\n  full: Shared Name\n---\n",
        );
        respond(workspace, {
            method: "initialize",
            params: { initializationOptions: { foreignRoots: [foreign.directory] } },
        });
        expect(workspace.symbols("Shared Name")).toHaveLength(1);
        const foreignWorkspace = workspace.foreignWorkspace(foreign.directory);
        expect(fs.existsSync(foreignWorkspace.indexFile)).toBe(false);
        const symbols = workspace.symbols("all:Shared Name");
        expect(symbols).toHaveLength(2);
        expect(symbols.map((symbol) => symbol.containerName)).toEqual([
            expect.stringContaining("test ·"),
            expect.stringContaining("other ·"),
        ]);
        expect(symbols[1].location.uri).toBe(foreignUri);
        expect(fs.existsSync(foreignWorkspace.indexFile)).toBe(true);
        respond(workspace, {
            method: "workspace/didChangeConfiguration",
            params: { settings: { heroiclands: { foreignRoots: [] } } },
        });
        expect(workspace.symbols("all:Shared Name")).toHaveLength(1);
    });

    it("opens foreign canonical notes and assets from their owning roots", () => {
        const sourceText = "See [[other-note-lore-beta|Beta]] and ![[other-none-icon-sun|Sun]].\n";
        const source = note("Source.md", sourceText);
        savedLore("Alpha.md", "alpha", "Local");
        const foreign = foreignProject();
        const target = foreign.save(
            "Beta.md",
            "---\ntype: lore\nshortcode: beta\nname:\n  full: Beta\n---\n",
        );
        const asset = path.join(foreign.directory, "assets/icons/sun.webp");
        fs.mkdirSync(path.dirname(asset), { recursive: true });
        fs.writeFileSync(asset, "image bytes");
        foreign.save("Icon.md", "---\ntype: icon\nshortcode: sun\n---\n");
        respond(workspace, {
            method: "initialize",
            params: { initializationOptions: { foreignRoots: [foreign.directory] } },
        });
        indexFor(workspace.foreignWorkspace(foreign.directory), [
            {
                ...alpha,
                package: "other",
                shortcode: "beta",
                name: { full: "Beta" },
                address: { slug: "lore-beta", canonical: "other-note-lore-beta" },
                file: { path: "Beta.md" },
            },
            {
                package: "other",
                type: "icon",
                shortcode: "sun",
                address: { slug: "icon-sun", canonical: "other-none-icon-sun" },
                asset: { path: "icons/sun.webp" },
            },
        ]);
        expect(workspace.definition(source, { line: 0, character: 16 })?.uri).toBe(target);
        expect(
            workspace.definition(source, {
                line: 0,
                character: sourceText.indexOf("other-none-icon-sun") + 5,
            })?.uri,
        ).toBe(pathToFileURL(asset).href);
    });

    it("uses the citing package for a bare Address across configured projects", () => {
        const source = note("Source.md", "See [[lore-alpha|Shared]].\n");
        savedLore("Alpha.md", "alpha", "Local");
        const foreign = foreignProject();
        foreign.save(
            "Alpha.md",
            "---\ntype: lore\nshortcode: alpha\nname:\n  full: Foreign\n---\n",
        );
        respond(workspace, {
            method: "initialize",
            params: { initializationOptions: { foreignRoots: [foreign.directory] } },
        });
        index([alpha]);
        indexFor(workspace.foreignWorkspace(foreign.directory), [
            {
                ...alpha,
                package: "other",
                file: { path: "Alpha.md" },
                address: {
                    slug: "lore-alpha",
                    canonical: "other-note-lore-alpha",
                },
            },
        ]);
        const result = workspace.definition(source, { line: 0, character: 10 });
        expect(result?.uri).toContain(root);
    });

    it("finds foreign body and indexed frontmatter references with saved ranges", () => {
        const target = note("Guild.md", "---\ntype: place\nshortcode: guild\n---\n");
        const foreign = foreignProject();
        const source = foreign.save(
            "Route.md",
            "---\ntype: place\nshortcode: route\ndata:\n  routes:\n    - to: test-note-place-guild\n---\nSee [[test-note-place-guild|Guild]].\n",
        );
        respond(workspace, {
            method: "initialize",
            params: { initializationOptions: { foreignRoots: [foreign.directory] } },
        });
        index([
            {
                ...alpha,
                type: "place",
                shortcode: "guild",
                address: { slug: "place-guild", canonical: "test-note-place-guild" },
                file: { path: "Guild.md" },
            },
        ]);
        indexFor(workspace.foreignWorkspace(foreign.directory), [
            {
                package: "other",
                type: "place",
                shortcode: "route",
                data: { routes: [{ to: "test-note-place-guild" }] },
                file: { path: "Route.md" },
            },
        ]);
        respond(workspace, {
            method: "textDocument/didOpen",
            params: {
                textDocument: {
                    uri: source,
                    text: "See [[test-note-place-guild|Unsaved]] twice.\n",
                },
            },
        });
        const results = workspace.references(target, { line: 2, character: 14 });
        expect(results).toHaveLength(2);
        expect(results.every((result) => result.uri === source)).toBe(true);
        expect(results.map((result) => result.range.start.line)).toEqual([7, 5]);
    });

    it("reports a missing foreign root while preserving available results", () => {
        savedLore("Alpha.md", "alpha", "Shared Name");
        const foreign = foreignProject();
        foreign.save(
            "Beta.md",
            "---\ntype: lore\nshortcode: beta\nname:\n  full: Shared Name\n---\n",
        );
        const missing = path.join(root, "missing-project");
        const status: string[] = [];
        workspace.onStatus = (message: string | null) => {
            if (message) status.push(message);
        };
        respond(workspace, {
            method: "initialize",
            params: { initializationOptions: { foreignRoots: [missing, foreign.directory] } },
        });
        expect(workspace.symbols("all:Shared Name")).toHaveLength(2);
        expect(status.join("\n")).toContain(missing);
    });

    it("recovers a missing foreign index after a foreign note is saved", () => {
        vi.useFakeTimers();
        savedLore("Alpha.md", "alpha", "Shared Name");
        const foreign = foreignProject();
        const status: string[] = [];
        workspace.onStatus = (message: string | null) => {
            if (message) status.push(message);
        };
        respond(workspace, {
            method: "initialize",
            params: { initializationOptions: { foreignRoots: [foreign.directory] } },
        });
        expect(workspace.symbols("all:Shared Name")).toHaveLength(1);
        expect(status.join("\n")).toContain("No index is available");
        const uri = foreign.save(
            "Beta.md",
            "---\ntype: lore\nshortcode: beta\nname:\n  full: Shared Name\n---\n",
        );
        respond(workspace, { method: "textDocument/didSave", params: { textDocument: { uri } } });
        vi.advanceTimersByTime(300);
        expect(workspace.symbols("all:Shared Name")).toHaveLength(2);
    });

    it("validates a complete foreign cache on first use without rebuilding it", () => {
        savedLore("Alpha.md", "alpha", "Local");
        const foreign = foreignProject();
        foreign.save("Beta.md", "---\ntype: lore\nshortcode: beta\n---\n");
        respond(workspace, {
            method: "initialize",
            params: { initializationOptions: { foreignRoots: [foreign.directory] } },
        });
        const project = workspace.foreignWorkspace(foreign.directory);
        indexFor(project, [
            {
                ...alpha,
                package: "other",
                shortcode: "beta",
                name: { full: "Cached Foreign" },
                file: { path: "Beta.md" },
            },
        ]);
        project.started = false;
        const rebuild = vi.spyOn(project, "rebuild");
        expect(workspace.symbols("all:Cached Foreign")).toHaveLength(1);
        expect(rebuild).not.toHaveBeenCalled();
    });

    it("rebuilds an incompatible foreign cache before searching it", () => {
        savedLore("Alpha.md", "alpha", "Local");
        const foreign = foreignProject();
        foreign.save(
            "Beta.md",
            "---\ntype: lore\nshortcode: beta\nname:\n  full: Fresh Foreign\n---\n",
        );
        respond(workspace, {
            method: "initialize",
            params: { initializationOptions: { foreignRoots: [foreign.directory] } },
        });
        const project = workspace.foreignWorkspace(foreign.directory);
        indexFor(project, [
            {
                ...alpha,
                package: "other",
                name: { full: "Old Foreign" },
                file: { path: "Beta.md" },
            },
        ]);
        const manifest = path.join(project.cacheDirectory, "metadata.json");
        const metadata = JSON.parse(fs.readFileSync(manifest, "utf8"));
        metadata.generatorVersion = "0.0.0";
        fs.writeFileSync(manifest, JSON.stringify(metadata));
        project.started = false;
        expect(workspace.symbols("all:Fresh Foreign")).toHaveLength(1);
        expect(workspace.symbols("all:Old Foreign")).toHaveLength(0);
    });

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
        index([alpha, { ...alpha, type: "lore" }]);
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
                type: "affiliation",
                shortcode: "guild",
                address: { slug: "affiliation-guild", canonical: "test-note-affiliation-guild" },
                file: { path: "Guild.md" },
            },
            {
                package: "test",
                type: "affiliation",
                shortcode: "ally",
                data: { relations: { guild: "ally" } },
                file: { path: "Ally.md" },
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
