#!/usr/bin/env node
/*
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { ContentWorkspace, runLanguageServer } from "../engine/content-language-server.mjs";

if (process.argv[2] === "--print-index-path") {
    console.log(new ContentWorkspace().indexFile);
} else if (process.argv[2] === "--rebuild-index") {
    const workspace = new ContentWorkspace(undefined, {
        onStatus: (status) => {
            if (status) console.error(status);
        },
    });
    if (!workspace.rebuild()) process.exitCode = 1;
    else console.log(workspace.indexFile);
} else if (process.argv.length === 2) {
    runLanguageServer();
} else {
    console.error(
        "Usage: heroiclands-content-language-server [--print-index-path | --rebuild-index]",
    );
    process.exitCode = 2;
}
