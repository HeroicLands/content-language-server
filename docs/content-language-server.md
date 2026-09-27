# Content language server

`heroiclands-content-language-server` provides editor navigation and reference diagnostics for Markdown notes in a HeroicLands content project. It is a stdio Language Server Protocol process. Start it from the project root so it can read `package-build.config.yaml` and the saved content tree.

The server builds a private JSONL index during initialization, before answering navigation requests. It rebuilds after nearby save notifications settle. Unsaved buffer text identifies an Address under the cursor, but workspace search uses saved metadata. A new, renamed, or deleted note enters the index when the editor sends a save or file-operation notification. A successful rebuild replaces the complete snapshot; a failed rebuild reports an editor message and keeps the last complete snapshot available with a stale-results warning.

The index belongs to the editor, outside the project. On macOS it is `~/Library/Caches/HeroicLands/content-language-server/<project-root-hash>/metadata.jsonl`. Linux uses `$XDG_CACHE_HOME` or `~/.cache`; Windows uses `%LOCALAPPDATA%` or the user's `AppData/Local` directory. The hash comes from the canonical project root and stays the same across server versions. `metadata.json` records the package identity, generator version, and checksum. Startup rebuilds even when a cache exists, and an older server cannot replace an index from a newer generator. Cache files are disposable.

Install an exact `@heroiclands/content-language-server` version in an editor-managed directory and launch its executable. This package declares an exact `@heroiclands/package-build` dependency, so the server and index generator come from the same installation. The project supplies its configuration and saved notes. The build's `content-build content-index` command writes its own artifact under `build/` for build consumers; the language server does not read that artifact.

Run these commands from the project root using the editor-managed executable:

```sh
heroiclands-content-language-server --print-index-path
heroiclands-content-language-server --rebuild-index
```

The first prints the private JSONL path. The second is manual recovery when a file operation did not trigger a rebuild; it prints the path on success and exits nonzero on failure. Restarting the server also rebuilds from saved source. A failed rebuild leaves the complete prior snapshot in place. If there is no valid prior snapshot, navigation reports that no index is available.

| LSP request                       | Behavior                                                                                                                                              |
| --------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `textDocument/definition`         | Follows an Address or wikilink to the indexed note. An anchor lands on its indexed line.                                                              |
| `textDocument/completion`         | Completes unfinished wikilinks, anchors, and declared frontmatter Address values or keys.                                                             |
| `workspace/symbol`                | Finds notes by name, alias, ASCII name, shortcode, or Address. Field and project prefixes narrow the saved index. One result appears per source note. |
| `textDocument/references`         | Finds authored wikilinks, embeds, and declared frontmatter Address values or keys. Ordinary prose is excluded.                                        |
| `textDocument/publishDiagnostics` | Reports invalid complete links, embeds, anchors, and declared frontmatter Address targets in open notes.                                              |

Reference search uses indexed frontmatter to select candidates and reads saved Markdown source for exact ranges and body links. Unsaved edits identify the target under the cursor but do not enter workspace search. The server writes only LSP messages to stdout and uses UTF-16 positions.

### Reference diagnostics

The server checks a complete `[[Address|Text]]` link, `![[Address|Text]]` embed, or declared frontmatter Address against the saved private index. It checks section anchors against indexed headings and accepts only icon, image, or audio assets in embeds. A missing label, unresolved target, wrong target type, or missing anchor produces a finding at the written Address. Fenced code and unfinished links produce no reference finding. Ordinary prose and frontmatter fields that are not declared as Addresses are outside this check.

Open buffer text supplies the exact source positions, including UTF-16 offsets for non-ASCII text. The index supplies target metadata; unsaved edits in another note do not change resolution. The server waits 300 milliseconds after the latest edit before publishing diagnostics, then checks again after a save or index rebuild. Closing a document clears its findings.

An explicitly configured foreign project can be searched even when it is not a declared build dependency. A reference to that project's content is diagnosed until the citing package declares the dependency in `package-build.config.yaml`. When a declared foreign package's index is unavailable, the diagnostic says the index is unavailable; it does not claim the target is missing. A dependency with `contentIndex: false` cannot provide content targets.

### Address completion

Completion inside a `[[...` link searches the selected projects' saved indexes, including when an editor inserts the closing `]]` after the cursor. The query matches anywhere in a note's full name, aliases, shortcode, short Address, or canonical Address. The existing `nameAscii` and `aliasesAscii` fields supply typeable forms of names with non-ASCII characters. The server builds lowercase search keys in memory when it loads an index and transliterates the query with the same rule. The JSONL format carries no separate search field.

Each result identifies its owning package and canonical Address. Address completion items also carry `data.address` with that canonical Address, `data.display` with the authored name or exactly matched alias, and `data.exact` to distinguish a full name or alias match from a substring match. Editors can use these fields when completing a link's display text without merging targets that share a file or name. Readable `note` content, systemless `none` targets, and game system documents stay selectable even when they share a Markdown file. An ordinary `[[link|text]]` defaults to `note`, while an embedded `![[link|text]]` defaults to `none` and uses `image` as the type of a bare shortcode. Stating a system selects that exact target: `[[macro-autoattack|Text]]` reaches the readable note, and `[[none-macro-autoattack|Text]]` reaches the Macro. An embed offers asset targets and can reach an icon with `![[icon-anvil|Anvil]]`.

The text edit inserts the shortest Address that parses to the selected target at the cursor. A local game system document can require `sohl-being-bctrncml`, while a target in another package requires a fully qualified Address. A `[[...#` query completes anchors from the selected note. Completion in a declared frontmatter Address field uses that field's type and system defaults: image, icon, and folder fields use `none`; other fields use their game system block or `note` outside one. Explicit system segments keep their stated meaning. Input `doc<type>` aliases select readable note records; generated records and completion candidates use the authored type.

The server reads open buffer text to locate the cursor and replacement range. Candidate metadata comes from the saved JSONL index; unsaved frontmatter changes do not add candidates. Completion preserves closing brackets immediately after the cursor and ignores positions within existing display text. A missing foreign index is reported through the usual LSP status message while other indexed projects remain available.

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

Plain `workspace/symbol` queries search names, aliases, shortcodes, and Addresses in the current project. The query prefixes below narrow matches using saved JSONL records. Searches do not read unsaved frontmatter or scan Markdown files.

| Query                         | Matches                                                         |
| ----------------------------- | --------------------------------------------------------------- |
| `name:alyra`                  | Full names and aliases, including their ASCII forms             |
| `shortcode:alpha`             | Shortcodes                                                      |
| `type:lore`                   | Note types                                                      |
| `tag:myth`                    | Tags                                                            |
| `all:camel`                   | Ordinary matches in the current and configured foreign projects |
| `all:type:lore`               | A field filter across those projects                            |
| `package:thalorna`            | All indexed notes in that configured package                    |
| `package:thalorna name:camel` | A field filter within that package                              |

`package:` selects the current project or an explicitly configured foreign project by its exact package name. It does not discover other caches or add a build dependency. A missing package or an unknown prefix returns no results. An empty unqualified query lists the current project's notes; an incomplete `name:`, `shortcode:`, `type:`, or `package:` query returns no results. Results name the owning package and open its source note. Package-qualified definitions open a note or asset from its owning root. A bare Address uses the citing project's package default. `textDocument/references` searches the current and configured foreign projects and reports exact saved source ranges.

## Editor integration

An LSP client starts the executable with the content project as its working directory and associates it with Markdown notes under the configured content directory. The process handles `initialize`, `shutdown`, `exit`, full and incremental document synchronization, save and file-operation notifications, configuration changes, definition, completion, references, diagnostics, and workspace symbols. It does not advertise rename or document symbols. An editor integration supplies its own installation, project discovery, and UI commands.
