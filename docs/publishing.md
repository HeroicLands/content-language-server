# Publishing

The repository's primary forge is Gitea, and GitHub is its push mirror. A release runs in two halves, one on each.

1. **Version, on Gitea.** Merging a changeset to `main` runs `.gitea/workflows/release.yml`, which opens or updates the Version Packages pull request. Merging that pull request runs the same workflow again, which pushes the tag `v<version>` at the merged version commit. Releasing from Gitea is switched on by the repository variable `HL_RELEASE_ENABLED`.
2. **Publish, on GitHub.** The push mirror carries the tag to GitHub, where it starts `.github/workflows/release.yml`. The workflow refuses a tag that names a commit outside `main` or that is not `v<version>` of the tagged `package.json`. When npm does not have the version yet, it runs the tests and publishes with npm trusted publishing and provenance. It then creates the GitHub Release from the version's changelog section, unless one exists.

Nothing on Gitea publishes to npm, and nothing on GitHub runs for a branch push. Every step of the GitHub half is safe to repeat: re-running it, or dispatching it with the tag as its ref, finishes a release whose publish or Release step failed and changes nothing for one that completed.

## Trusted publisher

The package's npm settings name a GitHub Actions trusted publisher with organization `HeroicLands`, repository `content-language-server`, workflow filename `release.yml`, and no environment. The publisher does not constrain the ref, so the tag-triggered run publishes under it. Renaming the workflow file or giving its job an `environment:` stops publishing until the trusted publisher is changed to match.

## First publication

A new package name has no npm package settings for a trusted publisher. The maintainer publishes the first version from a clean `main` checkout with an npm account that can create packages under `@heroiclands`:

```sh
npm ci
npm test
npm publish --access public --provenance=false
```

The initial local publish has no CI provenance attestation. Then add the trusted publisher above on npmjs.com; every later version publishes through it.
