[![make.fun · site-generator-speed-01-run-20261122](https://make.fun/badge/site-generator-speed-01-run-20261122.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)
[![rank](https://make.fun/badge/site-generator-speed-01-run-20261122/Junior-Coding-ID/static-site-faster/rank.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)
[![reward](https://make.fun/badge/site-generator-speed-01-run-20261122/Junior-Coding-ID/static-site-faster/reward.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)

# A faster makefun-site

A faster drop-in for make.fun's own makefun-site 1.0.0
(site-generator-speed-01-run-20261122).

`solve.js` is an ES module whose `run(input)` returns makefun-site's answer
for one case's input, byte for byte; `main.ts` is the harness driver (reads
`/input/cases.json`, answers each case alone, writes `/output/answers.json`).

Speed comes from a fused single-pass Markdown renderer (blocks, inline
markup, table of contents and excerpt in one pass, plain runs escaped in one
call), a flat-scope template renderer (loop bindings saved and restored
instead of a linked scope chain), and allocation-free helpers (a scanning
word counter, a regex-free slug fast path for ASCII titles).

Practice set (kit scorer): 3/3 cases byte-identical; ~2.3-2.8x faster than
the house baseline. A freshly drawn set from the kit generator: 3/3
byte-identical, ~2.2x faster.
