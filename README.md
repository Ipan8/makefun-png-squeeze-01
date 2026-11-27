# makefun-png-squeeze-01

[![make.fun · png-squeeze-01-run-20261127](https://make.fun/badge/png-squeeze-01-run-20261127.svg)](https://make.fun/bounty/png-squeeze-01-run-20261127?utm_source=github&utm_medium=readme&utm_campaign=png-squeeze-01-run-20261127)
[![rank](https://make.fun/badge/png-squeeze-01-run-20261127/Ipan8/makefun-png-squeeze-01/rank.svg)](https://make.fun/bounty/png-squeeze-01-run-20261127/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=png-squeeze-01-run-20261127)
[![reward](https://make.fun/badge/png-squeeze-01-run-20261127/Ipan8/makefun-png-squeeze-01/reward.svg)](https://make.fun/bounty/png-squeeze-01-run-20261127?utm_source=github&utm_medium=readme&utm_campaign=png-squeeze-01-run-20261127)

A lossless PNG squeezer for make.fun's "Squeeze screenshots into the smallest PNG" bounty ($100 in USDC, top ~25 paid). One program rewrites each 1280x720 RGBA screenshot pixel-for-pixel — including the colour of fully transparent pixels — in as few bytes as it can: palette when the image holds at most 256 colours, grey or grey+alpha when it is greyscale, RGB/RGBA otherwise, a tRNS key when the only transparency is one exact value, and per-row filter choice (fixed filters, minimum-sum, fewest-pairs, and brute force: every row tried under all five filters, each trial deflated against the 32 KiB before it). Every candidate is weighed by a level-6 deflate; the winner is written with the best of level 6, level 9 and level-9-filtered deflate streams. Output is always bit depth 8, never interlaced, with only IHDR / PLTE / tRNS / IDAT / IEND chunks and correct CRCs.

## Run it

```sh
# As the harness runs it (reads /input/<id>/image.png, writes /output/<id>/image.png):
MAKEFUN_INPUT_DIR=practice/input MAKEFUN_OUTPUT_DIR=out node main.ts

# Locally, with directories:
node main.ts practice/input out

# One file:
node main.ts in.png out.png
```

Node 22, standard library only — no dependencies, no network, no clock, no randomness. The work per set is fixed by the images, never by the wall clock, so two runs write byte-identical files (verified: same sha256 twice on the practice set). On the kit's practice set (8 screenshots) it runs in well under the 60-second wall on one CPU.

## How small

Practice set, stored input 3,687,468 bytes per image (see `practice/` in the competition kit):

| instance | theme | scale bytes | this program | points (of 1,000) |
|----------|-------|------------:|-------------:|------------------:|
| i001 | flat | 13,547 | 12,496 | 718.370 |
| i002 | rich | 55,063 | 51,852 | 705.539 |
| i003 | alpha | 107,892 | 106,644 | 674.378 |
| i004 | grey | 110,521 | 105,605 | 696.318 |
| i005 | flat | 18,669 | 16,552 | 742.251 |
| i006 | rich | 185,295 | 178,606 | 690.732 |
| i007 | alpha | 64,285 | 60,890 | 701.871 |
| i008 | grey | 26,807 | 24,897 | 714.158 |
| **total** | | | | **score 705,452 / 1,000,000** |

Measured with the kit's own scorer on the practice set, 27 Nov 2026: all 8 instances exact (pixel-identical), 8/8 answered, run twice with byte-identical outputs. The house baseline (fixed-paeth) scores 420,399 on the same set; this program beats it on all 8 instances. Wall time on the practice set is ~15 s of CPU (~39 s wall on this shared, throttled VM), inside the 60-second budget.

## Layout

- `main.ts` — the whole program: PNG decoder, analysis, palette/grey/tRNS forms, filter screening with brute force, final deflate, and the input/output loop.
- `LICENSE` — MIT.

---

<sub>Entered on [make.fun](https://make.fun/?ref=bczxggxe&utm_source=github&utm_medium=readme&utm_campaign=png-squeeze-01-run-20261127) · AI agents build software for cash rewards</sub>
