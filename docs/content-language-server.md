# Content language server

`heroiclands-content-language-server` provides editor navigation for Markdown notes in a HeroicLands content project. It is a stdio Language Server Protocol process. Start it from the project root so it can read `package-build.config.yaml` and the saved content tree.

The server builds a private JSONL index during initialization, before answering navigation requests. It rebuilds after nearby save notifications settle. Unsaved buffer text identifies an Address under the cursor, but workspace search uses saved metadata. A new, renamed, or deleted note enters the index when the editor sends a save or file-operation notification. A successful rebuild replaces the complete snapshot; a failed rebuild reports an editor message and keeps the last complete snapshot available with a stale-results warning.

The index belongs to the editor, outside the project. On macOS it is `~/Library/Caches/HeroicLands/content-language-server/<project-root-hash>/metadata.jsonl`. Linux uses `$XDG_CACHE_HOME` or `~/.cache`; Windows uses `%LOCALAPPDATA%` or the user's `AppData/Local` directory. The hash comes from the canonical project root and stays the same across server versions. `metadata.json` records the package identity, generator version, and checksum. Startup rebuilds even when a cache exists, and an older server cannot replace an index from a newer generator. Cache files are disposable.

Install an exact `@heroiclands/content-language-server` version in an editor-managed directory and launch its executable. This package declares an exact `@heroiclands/package-build` dependency, so the server and index generator come from the same installation. The project supplies its configuration and saved notes. The build's `content-build content-index` command writes its own artifact under `build/` for build consumers; the language server does not read that artifact.

Run these commands from the project root using the editor-managed executable:

```sh
heroiclands-content-language-server --print-index-path
heroiclands-content-language-server --rebuild-index
```

The first prints the private JSONL path. The second is manual recovery when a file operation did not trigger a rebuild; it prints the path on success and exits nonzero on failure. Restarting the server also rebuilds from saved source. A failed rebuild leaves the complete prior snapshot in place. If there is no valid prior snapshot, navigation reports that no index is available.

| LSP request               | Behavior                                                                                                                     |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `textDocument/definition` | Follows an Address or wikilink to the indexed note. An anchor lands on its indexed line.                                     |
| `textDocument/completion` | Completes unfinished wikilinks, anchors, and declared frontmatter Address values or keys.                                    |
| `workspace/symbol`        | Finds notes by name, alias, ASCII name, shortcode, or Address. `tag:myth` searches tags. One result appears per source note. |
| `textDocument/references` | Finds authored wikilinks, embeds, and declared frontmatter Address values or keys. Ordinary prose is excluded.               |

Reference search uses indexed frontmatter to select candidates and reads saved Markdown source for exact ranges and body links. Unsaved edits identify the target under the cursor but do not enter workspace search. The server writes only LSP messages to stdout and uses UTF-16 positions.

### Address completion

Completion inside an unfinished `[[...` link searches the selected projects' saved indexes. The query matches anywhere in a note's full name, aliases, shortcode, short Address, or canonical Address. The existing `nameAscii` and `aliasesAscii` fields supply typeable forms of names with non-ASCII characters. The server builds lowercase search keys in memory when it loads an index and transliterates the query with the same rule. The JSONL format carries no separate search field.

Each result identifies its owning package and canonical Address. Separate system documents and documentation journals stay selectable even when they share a Markdown file. The result's text edit inserts the shortest Address that parses to the selected target in the citing note: a local system document can require `sohl-being-bctrncml`, while a target in another package requires a fully qualified Address. A `[[...#` query completes anchors from the selected note. Completion in a declared frontmatter Address field uses that field's type and system defaults, and can insert a shorter Address when those defaults identify the target.

The server reads open buffer text to locate the cursor and replacement range. Candidate metadata comes from the saved JSONL index; unsaved frontmatter changes do not add candidates. Completion leaves existing display text and closed wikilinks alone. A missing foreign index is reported through the usual LSP status message while other indexed projects remain available.

## Foreign content projects

An LSP client selects foreign project roots through `initialize`:

```json
{
  "initializationOptions": {
    "foreignRoots": ["/absolute/path/to/another/content/project"]
  }
}
```

The paths name repositories containing their own `package-build.config.yaml`, `.yml`, or `.mjs`. They are editor search configuration, independent of a package's build dependencies. The server validates each foreign project's private index when first used and rebuilds it from saved source if missing or incompatible. A valid complete cache is reusable. An unconfigured cache never adds a project to search. A failed foreign root produces an LSP status message while available projects remain searchable. Save and file-operation notifications refresh the affected project. Clients can update the root list with `workspace/didChangeConfiguration` using `settings.heroiclands.foreignRoots`.

Plain `workspace/symbol` queries search the current project. Prefix the query with `all:` to include configured foreign projects; `all:tag:myth` searches tags in that scope. Results name the owning package and open its source note. Package-qualified definitions open a note or asset from its owning root. A bare Address with matches in multiple configured projects returns all destinations for the client to present. `textDocument/references` searches the current and configured foreign projects and reports exact saved source ranges.

## Editor integration

An LSP client starts the executable with the content project as its working directory and associates it with Markdown notes under the configured content directory. The process handles `initialize`, `shutdown`, `exit`, full and incremental document synchronization, save and file-operation notifications, configuration changes, definition, completion, references, and workspace symbols. It does not advertise diagnostics, rename, or document symbols. An editor integration supplies its own installation, project discovery, and UI commands.
