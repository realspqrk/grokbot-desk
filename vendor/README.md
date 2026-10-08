# vendor

Pinned third-party files and required redistribution notices. These are plain
files, not installed packages.

| File | Package | Version | License | SHA-256 |
|---|---|---|---|---|
| `axe.min.js` | axe-core | 4.14.0 | MPL-2.0 (`axe-core.LICENSE`) | `20c09fe157a8a34a30e241aaa1fcdade657734f08ab379ecfbeb7d45cc46e878` |
| `twitter-text.LICENSE` | twitter-text | 3.1.0 | Apache-2.0 | exact upstream license text |
| `twemoji-parser.LICENSE` | twemoji-parser | 13.1.0 | MIT, Copyright (c) 2018 Twitter, Inc. | exact upstream license text |

Source: `https://registry.npmjs.org/axe-core/-/axe-core-4.14.0.tgz`, fetched 2026-10-08. Tarball integrity verified against the npm registry
(`sha512-9WTZxEjsZ7b13TH8JPmbV2z8CHbl80/2hm3XPEG4JgNdQLK81IBRXmSxHfMAOkSqQeRxT/0dwNDz2GOm3zzpcQ==`, shasum `a9819d3932a8198fbe935d8cbd8afcdfecbcf31d`).
Verify with `Get-FileHash vendor\axe.min.js -Algorithm SHA256`. `tools\score.py` refuses to run C13 when the hash differs.

The X counter is derived from pinned upstream sources without installing or
vendoring either package:

- `twitter-text` 3.1.0:
  `https://registry.npmjs.org/twitter-text/-/twitter-text-3.1.0.tgz`.
  `core/static/twitter-text-v3-data.js` combines the literal alternatives
  from `dist/esm/regexp/validGTLD.js` and `validCCTLD.js` into one
  longest-first TLD string. `core/static/count.js` ports the domain,
  preceding-character, ASCII-domain extraction, path/query, t.co, IDNA
  label-length, and maximum-URL-length behavior needed for weighted counting.
  The lightweight IDNA validation is ported from
  `dist/lib/idna.js`, including its per-label RFC 3492 encoded-length check,
  mixed-punycode rule, and unchanged-domain return semantics. These
  twitter-text-derived portions retain the Apache-2.0 notice in
  `vendor/twitter-text.LICENSE`. The implementation is adapted to the
  repository's dependency-free UMD runtime and uses bounded domain,
  path/query, and parenthesis traversal.
- `twemoji-parser` 13.1.0:
  `https://registry.npmjs.org/twemoji-parser/-/twemoji-parser-13.1.0.tgz`.
  `core/static/twitter-text-v3-data.js` stores its generated emoji entity
  regular-expression source as a string for the dependency-free counter.

The conformance fixture at
`tests_js/fixtures/twitter-text-3.1.0.json` is a JSON transformation of
twitter-text 3.1.0 `conformance/extract.yml` (`urls`) and
`conformance/validate.yml`
(`WeightedTweetsWithDiscountedEmojiCounterTest`). The full redistribution
terms are retained in `twitter-text.LICENSE` and
`twemoji-parser.LICENSE`.
