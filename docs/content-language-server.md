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
| `workspace/symbol`        | Finds notes by name, alias, ASCII name, shortcode, or Address. `tag:myth` searches tags. One result appears per source note. |
| `textDocument/references` | Finds authored wikilinks, embeds, and declared frontmatter Address values or keys. Ordinary prose is excluded.               |

Reference search scans saved Markdown notes in the configured content tree. The server writes only LSP messages to stdout and uses UTF-16 positions.

## Editor integration

The [HeroicLands Emacs package](https://github.com/HeroicLands/heroiclands-emacs) connects the server through Eglot in content Markdown buffers. Set `heroiclands-eglot-server-command` to this package's executable. Eglot maps `M-.` to definition, `C-M-.` to workspace search, `M-?` to references, and `M-,` to the Xref location stack.

An editor other than Emacs starts the executable from the package root and associates it with Markdown notes under the configured content directory. The process handles `initialize`, `shutdown`, `exit`, full and incremental document synchronization, save and file-operation notifications, definition, references, and workspace symbols. It does not advertise completion, diagnostics, rename, or document symbols.
