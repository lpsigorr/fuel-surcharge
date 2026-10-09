# fuel-surcharge

Step 1 of a fuel surcharge and quoting system for Belgian road transport: the formula, written down, coded and tested before anything else is built.

**Status:** Step 1 approved on 2026-10-09. Nothing here is connected to a database, a website or a real customer yet.

## The rule

```
change    = (current diesel price - base diesel price) / base diesel price
surcharge = fuel share x change
total     = rate x (1 + surcharge)
```

- The diesel price used for a service date is the price of the latest Monday that is on or before (service date - 7 days). Later Mondays are never used.
- A missing price is an error, never a guess.
- Everything is integer arithmetic: prices in hundredths of EUR per 1000 L, shares in basis points (1 bp = 0.01 %), money in euro cents. Every division rounds half away from zero.

## Worked examples (check them with a calculator)

**Real, Febetra, March 2022.** Diesel went from 1.2446 to 1.5347 EUR/L excl. VAT.
(1.5347 - 1.2446) / 1.2446 = 23.31 %. With a fuel share of 21.1 %, the surcharge is 23.31 % x 21.1 % = 4.92 %, the published figure. The 21.1 % is back-solved from the 4.92 %. Febetra itself says "about 20 %".

**Illustrative (made-up numbers).** Diesel goes from EUR 1,500.00 to EUR 1,650.00 per 1000 L, so +10.00 %. With a 20 % share the surcharge is +2.00 %, and a EUR 1,000.00 rate becomes EUR 1,020.00.

**Which Monday.** A transport on Friday 9 Oct 2026 uses the price of Monday 28 Sep 2026.

## Approved decisions (2026-10-09)

| # | Decision | Choice | Evidence |
|---|---|---|---|
| 1 | Fuel share | Required field per carrier, suggested start 20 % | Febetra "about 20 %"; TLV via trans.info 20 to 25 %; Cargoson assumes about 30 %; the Evofenedex template leaves it blank |
| 2 | Diesel index | EU Weekly Oil Bulletin, Belgium diesel, "with taxes" series | The percentage change is the same with or without a constant VAT rate |
| 3 | Lag before a Monday price is used | 7 days, adjustable | National data is submitted on Wednesday and the bulletin is emailed on Thursday, but the website can post later |
| 4 | Price falls | Symmetric by default (a fall gives a credit); "increase only" switch per contract | The Evofenedex template is symmetric; KNV is increase-only (seen in a search excerpt only) |
| 5 | Threshold | None by default; optional "at least X %", applied to the whole change | The Evofenedex template has a threshold but leaves X blank |
| 6 | Rounding | Surcharge % to 2 decimals, then applied to the rate, then rounded to the cent | No source specifies rounding; this lets a customer recompute from the printed percentage |
| 7 | Missing Monday price | Refuse to quote | A guess on an invoice is worse than an error |
| 8 | Diesel excise refund | Not modelled, absorbed in the fuel share | The Evofenedex clause (sub f) passes it through separately, so this is an approximation |

## Run it

Needs Node.js 20 or higher. The cross-check also needs Python 3.

```
npm test                          # 119 unit tests
python3 -I crosscheck.py          # independent recomputation (on Windows: python or py)
node try-it.mjs                   # playground: edit the numbers at the top of the file
```

No `npm install` is needed; there are no dependencies.

## Files

| File | What it is |
|---|---|
| `surcharge.mjs` | The calculation. The comment block at the top is the rule in words. |
| `surcharge.test.mjs` | 119 tests with the hand arithmetic in comments, each case labelled real or illustrative |
| `crosscheck.py`, `crosscheck-runner.mjs` | Independent Python recomputation of random cases against the JavaScript |
| `try-it.mjs` | Playground that prints a readable quote |
| `package.json` | Defines `npm test` |

## What is verified, and what is not

Verified:
- 119 of 119 unit tests pass.
- The Python check recomputed 23,000 surcharge cases and 6,000 date cases (fixed seed) with 0 mismatches. The cases include exact rounding ties, below-threshold cases and floored cases.
- Four deliberately broken copies of the code (ties rounded the wrong way, weeks starting on Sunday, share applied to the rounded change, threshold using <= instead of <) were each caught by both the unit tests and the Python check.

Not verified:
- No real Oil Bulletin price series has been used yet (the download was blocked), so the Febetra figures are the only real test data.
- The tests prove the code follows the rules above. They do not prove the rules match a real carrier's contract. That is for the carrier interviews.
- The KNV clause was seen as a search excerpt only, and the Evofenedex template mixes two index sources.

## Sources

- [VRT NWS / Febetra, 8 Mar 2022](https://www.vrt.be/vrtnws/nl/2022/03/08/van-1300-naar-2000-euro-voor-een-volle-dieseltank-in-een-vrachtw/)
- [Evofenedex fuel clause template (PDF)](https://www.evofenedex.nl/api/v1/sharepoint/file/Shared%20Documents/Download%20Vervoer/Brandstofclausule.pdf)
- [EU Weekly Oil Bulletin](https://energy.ec.europa.eu/data-and-analysis/weekly-oil-bulletin_en)
- [trans.info, Jan 2026](https://trans.info/en/belgium-hauliersbankrupt-448556) (the TLV 20 to 25 % figure)
- [Cargoson Belgium fuel surcharge page](https://www.cargoson.com/fr/tools/fuel-surcharges/belgium)
- [KNV fuel clause (docx, excerpt only)](https://www.knv.nl/wp-content/uploads/2022/06/Brandstofclausule-290622.docx)
