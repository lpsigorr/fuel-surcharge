# fuel-surcharge

A fuel surcharge and quoting system for Belgian road transport, built in small approved steps. Step 1 is the formula, written down, coded and tested. Step 2 is the database, applied to Supabase and tested. Step 3 is the function that makes and saves a quote. Step 4 is entering the weekly diesel price.

**Status:** Steps 1, 2 and 3 approved on 2026-10-09. The database and the create-quote function are deployed to a Supabase project, which holds no real data. Step 4 (entering the weekly diesel price) is built and tested on a local copy of Supabase, but it is not approved or deployed yet. No website or real customer is connected.

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
npm test                          # 178 tests: 119 for the formula (Step 1) and 59 for the Step 3 function logic
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
| `supabase/migrations/20261009120000_core_schema.sql` | Step 2: the database (tables, rules, access control). Applied to Supabase as `core_schema`. |
| `supabase/tests/` | Step 2: database tests. `run-local.sh` runs everything on a throwaway local Postgres. `live_check.sql` is the safe check for the real project. |
| `supabase/functions/create-quote/index.ts` | Step 3: the web endpoint (runs on Deno). Plumbing only. |
| `supabase/functions/_shared/` | Step 3: `create-quote.mjs` (the rules), `supabase-deps.mjs` (the database calls), `surcharge.mjs` (a copy of the Step 1 formula) |
| `supabase/tests/functions/`, `supabase/tests/run-function-tests.sh` | Step 3: tests for the function, including a local copy of Supabase to run it against |
| `supabase/migrations/20261009150000_diesel_price_entry.sql` | Step 4: the diesel price function and its audit trail. NOT applied to Supabase yet. |
| `admin/diesel-prices.html` | Step 4: the admin page for entering the weekly price. One file, double-click to use. |
| `supabase/tests/run-entry-local.sh`, `diesel_price_entry.test.sql`, `entry_crosscheck.mjs`, `entry-api.e2e.mjs`, `admin-page.e2e.mjs` | Step 4: tests (see the Step 4 section) |

## What is verified, and what is not

Verified:
- 119 of 119 unit tests pass.
- The Python check recomputed 23,000 surcharge cases and 6,000 date cases (fixed seed) with 0 mismatches. The cases include exact rounding ties, below-threshold cases and floored cases.
- Four deliberately broken copies of the code (ties rounded the wrong way, weeks starting on Sunday, share applied to the rounded change, threshold using <= instead of <) were each caught by both the unit tests and the Python check.

Not verified:
- No real Oil Bulletin price series has been used yet (the download was blocked), so the Febetra figures are the only real test data.
- The tests prove the code follows the rules above. They do not prove the rules match a real carrier's contract. That is for the carrier interviews.
- The KNV clause was seen as a search excerpt only, and the Evofenedex template mixes two index sources.

## Step 2: the database

Lives in `supabase/`. One shared Supabase project holds every carrier, and row level security keeps carriers apart.

| Table | What it holds |
|---|---|
| `organizations` | A carrier |
| `memberships` | Which user belongs to which carrier, as `owner` or `staff` |
| `platform_admins` | People allowed to publish diesel prices. Not readable through the API. |
| `fuel_prices` | One diesel price per Monday, the same for every carrier |
| `surcharge_settings` | Per carrier: fuel share, lag days, threshold, credits on or off, base diesel price |
| `zones`, `vehicle_types` | Defined by each carrier |
| `rates` | One base rate per zone and vehicle type |
| `quotes` | Saved quotes with every input and result frozen. Written only by server code, never editable. |

| Who | Can do |
|---|---|
| Not signed in | Nothing |
| Staff | Read their own carrier's data |
| Owner | Everything staff can, plus edit rates, zones, vehicle types, settings and the carrier name |
| Platform admin | Publish and correct diesel prices. No view into any carrier's data. |
| Server code (secret key) | Save quotes. This key bypasses every rule, so it must never reach a browser. |

### Approved decisions (2026-10-09)

| # | Decision |
|---|---|
| 1 | One shared Supabase project for all carriers. Supabase's pricing page lists Free as 2 active projects and Pro from $25/month with extra projects from $10/mo. The risk is a mistake in the rules leaking data between carriers, so most tests target exactly that. |
| 2 | Two carrier roles, owner and staff. The platform admin sits outside them. |
| 3 | Quotes are saved only by server code, never directly from the browser. A saved quote cannot be changed. A correction is a new quote. |
| 4 | Each quote freezes all its inputs and results. |
| 5 | The database re-checks the maths on every quote and refuses anything that does not follow the formula. The rule now exists in two places, and the cross-check detects drift between them. |
| 6 | Rate card v1 is one flat price per zone and vehicle type. No rate-card history yet. |
| 7 | The base diesel price is a number each carrier enters in their settings. Weekly diesel prices are entered by hand for now. |

### Run the tests

```
bash supabase/tests/run-local.sh     # throwaway local Postgres: 124 checks plus the maths cross-check
```

Needs the Postgres server programs (`initdb`, `pg_ctl`, `psql`, version 15 or newer) and Node.js. It never touches Supabase.

`supabase/tests/live_check.sql` is for the real project. Run it as the `postgres` role in the Supabase SQL editor. It runs 30 checks and ends with an intentional error called `LIVE_CHECK_RESULTS` that lists every PASS or FAIL, so all its test data is rolled back. Run it only on an empty project (the comment at the top of the file explains why).

### What is verified, and what is not

Verified:
- 124 of 124 database checks pass on Postgres 16 with a stand-in for Supabase's login system.
- 23,000 quotes computed by the Step 1 engine were all accepted by the database. The same 23,000, each altered in one of six ways (one cent off, one wrong percentage digit, and so on), were all refused. 6,000 reference Mondays matched.
- 12 deliberately broken copies of the migration (one carrier reading all carriers, staff editing settings, the browser writing quotes, quotes being editable, rounding changed, a threshold off by one, and others) were all caught.
- On the real Supabase project (applied 2026-10-09 as migration `core_schema`, region eu-west-1): a fingerprint of the live structure (columns, constraints, indexes, triggers, policies, privileges, comments) is identical to the tested local one, and 30 of 30 live checks pass. The project was empty again afterwards.

Not verified:
- No real Supabase sign-in was used. The tests simulate signed-in users inside the database (role and user id). Real logins come with the login screens.
- The design is not tested with real carriers. That is for the carrier interviews.
- Not built yet: the server code that saves quotes, login screens, the embeddable widget, and the screen for entering diesel prices.
- Supabase recorded the migration as version `20261009124941`. The file here is named `20261009120000`. The SQL is the same, only the timestamp differs. Keep this in mind before syncing with the Supabase command line tool.

Notes from Supabase's own checkers (2026-10-09):
- Security, info: `platform_admins` has row level security and no policy. That is intended, nobody can read it through the API.
- Security, 2 warnings: Supabase's own helper `public.rls_auto_enable()` can be called by signed-in and signed-out users. It is not part of this migration. It exists to switch on row level security for new tables.
- Performance, info: 4 foreign keys without an index (`rates` x2, `quotes.created_by`, `fuel_prices.entered_by`) and 2 indexes never used yet. Neither matters at this size. Indexes can be added later as a new migration.

The connection between Claude and Supabase currently reaches the whole Supabase account. Supabase's [MCP docs](https://supabase.com/docs/guides/getting-started/mcp) recommend limiting it to one project, and to read-only, once real customer data exists.

## Step 3: the create-quote function

**Status:** approved on 2026-10-09, deployed to the Supabase project as version 1 (JWT check on) and live-tested the same day.

A signed-in member of a carrier sends a zone, a vehicle type and a service date. The function looks up the carrier's settings and rate, finds the diesel price for the reference Monday, runs the Step 1 formula and saves the frozen quote. The database then re-checks the maths before accepting it. This version is for staff quotes only. The website widget comes later.

Request: `POST` with the header `Authorization: Bearer <user token>` and this JSON body.

```
{ "organizationId": "<uuid>", "zoneId": "<uuid>", "vehicleTypeId": "<uuid>", "serviceDate": "2026-10-09", "customerReference": "PO-1234" }
```

`customerReference` is optional (up to 200 characters). Any other field is refused. On success the answer is `201` with the saved quote (every number frozen, in integer cents and basis points) and the same amounts written the Belgian way.

| Status | Code | When |
|---|---|---|
| 400 | `INVALID_JSON`, `INVALID_REQUEST` | The body is not valid. The answer names the field. |
| 401 | `UNAUTHENTICATED` | No token, or Supabase Auth does not accept it |
| 403 | `NOT_A_MEMBER` | The caller does not belong to that carrier, or it does not exist |
| 404 | `ZONE_NOT_FOUND`, `VEHICLE_TYPE_NOT_FOUND`, `RATE_NOT_FOUND` | Not found for that carrier |
| 405 | `METHOD_NOT_ALLOWED` | Anything but `POST` |
| 409 | `SETTINGS_MISSING` | The carrier has no fuel surcharge settings yet |
| 409 | `DIESEL_PRICE_MISSING` | No published price for the reference Monday. The function never guesses. |
| 413 | `PAYLOAD_TOO_LARGE` | The body is over 2048 bytes |
| 500 | `INTERNAL_ERROR` | Something broke. The message says whether the quote may have been saved. |

How it is built:
- Every read (membership, settings, zone, vehicle type, rate, diesel price) is made with the caller's own token, so the database's row level security applies to each one. The secret server key is used for one thing only: inserting the quote.
- Each saved quote carries `engine_version`, which is `surcharge.mjs sha256:` plus the first 12 digits of the formula file's fingerprint. If the formula file changes, a test fails until the version is updated on purpose.
- The function uses its own copy of the formula at `supabase/functions/_shared/surcharge.mjs`. A test fails if it differs from the Step 1 `surcharge.mjs` by even one byte.

### Run the tests

```
npm test                                      # includes the 59 function logic tests (fake database, Node only)
bash supabase/tests/run-function-tests.sh     # those 59, plus 30 end-to-end tests
```

The end-to-end tests build a small copy of Supabase on your computer: the real function code running on Deno with the real supabase-js, the PostgREST program that Supabase uses to serve tables, and Postgres with our migration. They need the Postgres server programs, the PostgREST program (`POSTGREST_BIN=/path/to/postgrest`) and Deno (`DENO_BIN`). They have only been run in my workspace, not on your Mac.

### What is verified, and what is not

Verified:
- 59 of 59 logic tests pass, on my workspace (Node 22.22.0) and in your folder (Node 22.23.2). 178 of 178 pass for the whole `npm test`.
- 30 of 30 end-to-end tests pass. They include: members of two carriers cannot quote for each other; forged, expired and empty tokens are refused; the server key used as a user token is refused; a removed member is refused on the next call; the browser cannot write quotes directly; a missing diesel price refuses the quote; CORS works; the server key never appears in a response or the log.
- 250 random carriers (random settings, rates, dates) were quoted through the whole chain. The 235 quotes with a price matched an independent calculation to the cent, and the 15 without a price were refused.
- 24 deliberately broken copies of the code (skipped membership check, guessed price, wrong rounding, server key used for reads, keys swapped, and others) were all caught.
- `deno check` accepts `index.ts`.

Verified live (2026-10-09, on the deployed function, with a throwaway carrier and a throwaway user that were deleted afterwards; all 13 tables were counted at 0 rows):
- A real Supabase sign-in, then one quote with the Febetra figures: diesel +23.31 %, surcharge 4.92 %, surcharge EUR 16.40, total EUR 349.73 (rate 333.33, base 1,244.60, current 1,534.70, fuel share 21.1 %, lag 7 days, service date 2026-10-09, reference Monday 2026-09-28). The saved row matched.
- Refused, and nothing saved: a missing diesel price, a carrier the user does not belong to, an unknown field, a bad date, a zone that does not exist.
- Through the database API, that same signed-in user could not insert or edit quotes, read the platform admin list, or publish diesel prices.
- The platform refused a request whose bearer value was not a valid token (401, `UNAUTHORIZED_INVALID_JWT_FORMAT`). Its logs mark a request that carries only the publishable key in the `apikey` header as `sb_api_key_compatibility: minted`: the gateway turns that key into an anonymous token. So the platform's JWT check alone does not prove who the caller is, and the function's own check of the user (`auth.getUser`) is the gate that decides.
- The browser preflight (CORS) answers with `allow-origin: *` and the headers a website needs.

Not verified:
- Local PostgREST is version 12.2.3. The version Supabase runs may differ.
- Sending the same request twice saves two quotes. There is no duplicate protection yet.
- No rate limiting, and no website widget mode.

## Step 4: entering the weekly diesel price

**Status:** built and tested on a local copy of Supabase. Not approved. Nothing is deployed: the migration is not applied to the real project and the page is not in use.

A platform admin publishes one price per Monday: the EU Weekly Oil Bulletin figure for Belgium, diesel, with taxes, in EUR per 1000 litres. Every carrier's quotes read it. There are two pieces. A database function makes every decision. A one-file admin page only sends the numbers and shows the answer.

### The function

`public.publish_diesel_price(p_monday, p_eur_per_1000l, p_replace, p_accept_big_move)` runs with the caller's own rights, not the database owner's. Only signed-in users may call it, and inside it only platform admins pass. The checks run in this order and the first failure stops everything:

| # | Check | If it fails (HTTP, code) |
|---|---|---|
| 1 | The caller is a platform admin | 403 `NOT_ALLOWED` |
| 2 | The date is a Monday | 422 `INVALID_MONDAY` |
| 3 | The Monday is not after today's date in Brussels | 422 `MONDAY_IN_FUTURE` |
| 4 | The price is above 0 and has at most 2 decimals. It is never rounded for you. | 422 `INVALID_PRICE` |
| 5 | The price is between EUR 500.00 and 5,000.00 per 1000 L | 422 `PRICE_OUT_OF_RANGE` |
| 6 | That Monday has no different price already. The same price again changes nothing and answers `unchanged`. | 409 `PRICE_EXISTS`, unless `p_replace` is true |
| 7 | The price is at most 5 % away from the closest other stored Monday (a tie goes to the earlier one). Exactly 5.00 % passes. | 409 `BIG_MOVE`, unless `p_accept_big_move` is true |

Every refusal carries a code, a plain sentence and a next step. On success the answer says `created`, `replaced` or `unchanged`, and what the price was compared with.

**Audit trail.** `private.fuel_price_changes` is not reachable through the API (row level security on, no policy, no grant). A trigger on `fuel_prices` records every insert, update and delete from any path, with who and when. Changing the Monday of a price is logged as a delete plus an insert.

### The admin page

`admin/diesel-prices.html`. Save the file on your computer and double-click it. Sign in with a platform admin account. It shows the latest 10 prices with the change from the week before, and has a form: Monday, price, Review, Publish. The price may be typed `1534.70`, `1534,70` or `1 534,70`. The Review step repeats the number back in words before anything is sent.

- No password is stored. The sign-in token lives in the page's memory and disappears when the page is closed.
- Nothing is written to browser storage or cookies, and nothing is loaded from any other website.
- Server messages are shown as text only, never as HTML.
- The page makes no decisions. It cannot be tricked into publishing something the function would refuse.
- The only two configured values are the project address and the publishable key. Both are public by design.

### Decisions to approve

| # | Decision | Choice | Why |
|---|---|---|---|
| 1 | Where the rules live | A database function plus an audit trigger, not an Edge Function | The rules sit next to the data. The audit trigger catches every change, also one made some other way. One thing fewer to deploy. |
| 2 | Typo guards | At most 5 % away from the closest stored week, and EUR 500 to 5,000 per 1000 L | **Chosen by me, not sourced.** They stop a slipped decimal point or the wrong unit. They do not stop a careful wrong entry or a transposed digit. To be tuned against the real bulletin history. |
| 3 | Overrides | Replacing a stored price and accepting a big move are separate, deliberate confirmations. Both can be needed for one entry. | A correction should never happen by accident |
| 4 | Corrections | Allowed with `p_replace`, and logged. Nobody can delete a price (a Step 2 rule). | History stays traceable |
| 5 | The page | A local file, not a hosted page | It handles a sign-in, so it is better not to put it on the internet |
| 6 | First platform admin | Needs a real Supabase user and one row in `platform_admins`. Not done. | Until then nobody can publish |
| 7 | Entry method | By hand, as decided in Step 2. An automatic import from the Oil Bulletin file comes later. | |

### Run the tests

```
bash supabase/tests/run-entry-local.sh                       # Step 2 tests again (124), Step 4 tests (82), maths cross-check (10,500 price pairs)
node --test supabase/tests/entry-api.e2e.mjs                 # 14 tests over real HTTP
node --test supabase/tests/admin-page.e2e.mjs                # 18 tests in a real browser
```

The first needs the Postgres server programs and Node.js. The other two also need PostgREST (`POSTGREST_BIN`), `PGBIN`, and for the page test Playwright with Chromium (`PLAYWRIGHT_MODULE`). They only ever touch a throwaway local copy, never Supabase. Run the end-to-end tests one at a time: they use fixed ports.

### What is verified, and what is not

Verified (on my workspace, Postgres 16, PostgREST 12.2.3, Chromium via Playwright 1.56):
- 124 of 124 Step 2 database checks still pass with the Step 4 migration applied.
- 82 of 82 Step 4 database checks pass: access (admin, non-admin, signed-in without admin rights, signed out), every refusal and its code, the whole life of a price list, the exact 5 % boundaries (1,470.00 passes and 1,470.01 is refused when the neighbour is 1,400.00; 1,330.00 passes and 1,329.99 is refused), choice of the closest week, the audit trail, privileges, a simulated race between two admins, and the Brussels date.
- 10,500 random price pairs (6,000 random, 3,000 on the 5 % line, 1,500 exact rounding ties) gave 0 differences between the database and an independent calculation of the percentage, the 5 % rule and the exact refusal sentence.
- 14 of 14 HTTP tests on real PostgREST: 200 for success, 409 and 422 for refusals, 403 for a non-admin, 401 when signed out, 405 for a GET, 404 for a mistyped parameter name. A price with floating-point noise is refused, not rounded.
- 18 of 18 page tests in a real Chromium, including a wrong password, mistyped prices, the comma price, Cancel, both confirmations, a non-admin, a token that runs out while reviewing, and checks that nothing is stored in the browser and that every request carries the project key. The page tests passed 11 runs in a row on the final files.
- 42 deliberately broken copies of the migration (admin check skipped, Monday check removed, 5 % turned into 10 %, replace ignored, wrong rounding, function run as its owner, signed-out users allowed, audit trail missing a delete, and others) were all caught.
- 30 deliberately broken copies of the page (price sent as a number, flags always on, token saved in the browser, sign-out doing nothing, review skipped, wrong sign on a fall, and others) were all caught. The first round found 5 gaps in the page tests. They were closed and the round was repeated.

Not verified:
- Nothing has run on the real Supabase. The migration is not applied there.
- The 5 % limit and the EUR 500 to 5,000 range are my choice. I could not open the real Oil Bulletin history (the download tool was blocked), so I could not check how often a real week moves more than 5 %.
- The guards catch gross typos. A careful wrong entry, or two digits swapped inside the range, passes.
- The sign-in is a stand-in locally, so the page has not signed in against real Supabase Auth. It uses the standard password sign-in address.
- The local PostgREST accepts a token for 30 seconds after it expires (measured). The version Supabase runs may differ.
- No platform admin exists yet in the real project.

## Sources

- [VRT NWS / Febetra, 8 Mar 2022](https://www.vrt.be/vrtnws/nl/2022/03/08/van-1300-naar-2000-euro-voor-een-volle-dieseltank-in-een-vrachtw/)
- [Evofenedex fuel clause template (PDF)](https://www.evofenedex.nl/api/v1/sharepoint/file/Shared%20Documents/Download%20Vervoer/Brandstofclausule.pdf)
- [EU Weekly Oil Bulletin](https://energy.ec.europa.eu/data-and-analysis/weekly-oil-bulletin_en)
- [trans.info, Jan 2026](https://trans.info/en/belgium-hauliersbankrupt-448556) (the TLV 20 to 25 % figure)
- [Cargoson Belgium fuel surcharge page](https://www.cargoson.com/fr/tools/fuel-surcharges/belgium)
- [KNV fuel clause (docx, excerpt only)](https://www.knv.nl/wp-content/uploads/2022/06/Brandstofclausule-290622.docx)
- [Supabase pricing](https://supabase.com/pricing)
- [Supabase MCP guide](https://supabase.com/docs/guides/getting-started/mcp)
- [Supabase Edge Functions](https://supabase.com/docs/guides/functions)
- [Edge Functions: authorization headers](https://supabase.com/docs/guides/functions/auth-headers)
- [Edge Functions: environment variables](https://supabase.com/docs/guides/functions/secrets)
- [Edge Functions: limits](https://supabase.com/docs/guides/functions/limits)
