# Issue reporting

## 1. Scope

File language-server implementation and protocol behavior here. File content generation and Address-rule defects in `package-build`; file editor integration defects in the repository for that editor's client.

## 2. Work shape

Use the organization issue type: bug, feature, epic, task, or spike. Labels describe subject matter, not work shape.

## 3. Labels

| Label             | Subject                                   |
| ----------------- | ----------------------------------------- |
| `documentation`   | Documentation and runtime help            |
| `devops`          | CI, release, and repository configuration |
| `tests`           | Protocol and filesystem tests             |
| `security`        | Untrusted content and subprocess handling |
| `tech-debt`       | Working-code restructuring                |
| `regression`      | Behavior that stopped working             |
| `breaking-change` | LSP, CLI, or installation contract        |
| `blocked`         | External dependency or decision           |
| `duplicate`       | Already tracked work                      |
| `question`        | More information needed                   |
| `wontfix`         | Work not pursued                          |

The closed registry in `labels.yml` holds the colors and descriptions. Update both files together.

## 9. Routing

File a defect in the repository whose code must change. This repository owns the server executable, private index, protocol handlers, and server documentation. `package-build` owns the shared JSONL generator, content parser, and Address rules. Each editor client owns its installation, commands, keybindings, and help.
