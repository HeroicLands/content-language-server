# Issue reporting

## 1. Scope

File language-server implementation and protocol behavior here. File content generation and Address-rule defects in `package-build`; file editor integration defects in the repository for that editor's client.

## 2. Work shape

Use the organization issue type: bug, feature, epic, task, or spike. Labels describe subject matter, not work shape.

## 3. Labels

Labels are defined once for the whole organization, in `labels.yml` of
`HeroicLands/.github`. This repository keeps no registry of its own and never
creates a label here; a gap in the set is raised in `HeroicLands/.github`.

| Group         | Labels                                                                                                                       |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `type/`       | `type/bug`, `type/feature`, `type/epic`, `type/task`, `type/spike` (exactly one per issue)                                   |
| `area/`       | `area/documentation`, `area/devops`, `area/tests`, `area/content`, `area/system`, `area/site`, `area/layout`, `area/styling` |
| `flag/`       | `flag/breaking-change`, `flag/security`, `flag/regression`, `flag/tech-debt`                                                 |
| `status/`     | `status/blocked`, `status/question`                                                                                          |
| `resolution/` | `resolution/duplicate`, `resolution/wontfix`                                                                                 |
| `ci/`         | `ci/e2e`                                                                                                                     |

When to use them here:

- `area/documentation`—documentation and runtime help.
- `area/devops`—CI, release, and repository configuration.
- `area/tests`—protocol and filesystem tests.
- `flag/security`—untrusted content and subprocess handling.
- `flag/tech-debt`—working-code restructuring.
- `flag/regression`—behavior that stopped working.
- `flag/breaking-change`—LSP, CLI, or installation contract.
- `status/blocked`—external dependency or decision.

## 9. Routing

File a defect in the repository whose code must change. This repository owns the server executable, private index, protocol handlers, and server documentation. `package-build` owns the shared JSONL generator, content parser, and Address rules. Each editor client owns its installation, commands, keybindings, and help.
