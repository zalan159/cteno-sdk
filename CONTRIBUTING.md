# Contributing

Thanks for your interest in the Cteno SDK.

## How this repository works

This repository is a **published snapshot**. The SDK is developed together with the
Cteno daemon in a private repository, and each release here is an export of the SDK
sources from it (generated wire types included). That means:

- Pull requests are welcome. A maintainer applies an accepted change upstream and it
  comes back in the next export, credited to you (`Co-authored-by`). Your PR is then
  closed with a link to the commit that contains it, rather than merged directly.
- Please keep each PR focused on one change, with tests.
- Do not edit `js/src/generated/` by hand; those files are generated from the daemon's
  Rust types. If a wire type looks wrong, open an issue.

## Development

```bash
# Node
cd js
npm ci
npm test            # tsc build + node:test unit tests against a fake daemon

# Python
cd python
python -m unittest discover -s tests
```

Tests never talk to a real Cteno daemon or a model. To try the examples against your
own running Cteno app, build the package and run `node examples/node/basic-query.mjs`.

## Reporting bugs

Open an issue with the SDK version, your Cteno app version, OS, and a minimal
reproduction. For security issues, follow [SECURITY.md](SECURITY.md) instead.

## License

By contributing you agree that your contributions are licensed under the
[MIT License](LICENSE).
