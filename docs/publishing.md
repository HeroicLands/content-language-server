# Publishing

The package releases through `.github/workflows/release.yml`. Merged changesets open a version pull request; merging that pull request publishes the version to npm. The GitHub Actions workflow uses npm trusted publishing with OIDC.

## First publication

A new package name has no npm package settings for a trusted publisher. The maintainer publishes the first version from a clean `main` checkout with an npm account that can create packages under `@heroiclands`:

```sh
npm ci
npm test
npm publish --access public --provenance=false
```

The initial local publish has no CI provenance attestation. The repository's release workflow recognizes an absent package and leaves the first publication to the maintainer.

On npmjs.com, open the package's settings and add a GitHub Actions trusted publisher with organization `HeroicLands`, repository `content-language-server`, workflow filename `release.yml`, and direct `npm publish` permitted. The workflow uses GitHub-hosted runners and `id-token: write`. Subsequent releases use that connection and receive automatic provenance.
