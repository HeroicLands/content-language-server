# HeroicLands content language server

`@heroiclands/content-language-server` provides definition, reference, and workspace search for Markdown notes in HeroicLands content projects. It reads authored notes and project configuration through one exact `@heroiclands/package-build` dependency.

Start its `heroiclands-content-language-server` executable from the content project root. The server builds a private index when it starts and after saves. The index lives in the platform cache outside the project's `build/` directory, so a clean or package build does not replace editor navigation data.

Install an exact released package version in a directory managed by your editor integration. Configure an LSP client to launch that installation's `node_modules/.bin/heroiclands-content-language-server` executable with the content project as its working directory and Markdown notes as its document scope. The package does not depend on any particular editor.

See the [language server guide](docs/content-language-server.md) for LSP requests, cache locations, error handling, and manual recovery commands.
