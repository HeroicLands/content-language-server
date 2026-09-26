# HeroicLands content language server

`@heroiclands/content-language-server` provides definition, reference, completion, diagnostics, and workspace search for Markdown notes in HeroicLands content projects. It reads authored notes and project configuration through one exact `@heroiclands/package-build` dependency.

Start its `heroiclands-content-language-server` executable from the content project root. The server builds a private index when it starts and after saves. The index lives in the platform cache outside the project's `build/` directory, so a clean or package build does not replace editor navigation data.

Install an exact released package version in a directory managed by your editor integration. Configure an LSP client to launch that installation's `node_modules/.bin/heroiclands-content-language-server` executable with the content project as its working directory and Markdown notes as its document scope. The package does not depend on any particular editor.

See the [language server guide](docs/content-language-server.md) for LSP requests, cache locations, error handling, and manual recovery commands.

Editors can pass explicit foreign content roots in LSP initialization options. A normal workspace-symbol query stays in the current project; an `all:` query searches the configured roots as well. The server returns standard LSP symbols and locations, so the editor controls how results are presented.

Workspace-symbol queries accept `name:`, `shortcode:`, `type:`, `tag:`, and `package:` filters. For example, `all:type:lore` searches every configured project, while `package:thalorna name:camel` searches names in one configured package.

Completion searches anywhere in indexed names, aliases, and Addresses. It inserts the shortest Address that identifies the selected target in the current note, including its system or package when needed. Ordinary `[[...]]` links default to readable `note` content; `![[...]]` embeds default to systemless `none` assets. Clients receive standard LSP completion items with exact text edits.

Open notes receive diagnostics for complete links, embeds, and declared Address fields. The server reads live text for ranges and checks targets against saved indexes and declared content dependencies. It waits briefly after typing before publishing findings.

Maintainers use the [publishing guide](docs/publishing.md) for the first npm release and trusted publisher configuration.
