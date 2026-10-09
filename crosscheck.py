#!/usr/bin/env python3
"""Independent cross-check of surcharge.mjs.

Generates random cases (fixed seed, so the run is repeatable), sends them through the
JavaScript code, recomputes every result here with different tools (fractions.Fraction and
decimal.Decimal, plus datetime for the Mondays) and compares. Exits 1 on any mismatch.

Run:  python3 -I crosscheck.py
"""
import json
import math
import random
import subprocess
import sys
from datetime import date, timedelta
from decimal import ROUND_HALF_UP, Decimal, getcontext
from fractions import Fraction
from pathlib import Path

getcontext().prec = 60
HERE = Path(__file__).resolve().parent
SEED = 20261009


def round_fraction(x: Fraction) -> int:
    """Half away from zero via floor(|x| + 1/2)."""
    sign = -1 if x < 0 else 1
    return sign * math.floor(abs(x) + Fraction(1, 2))


def round_decimal(num: int, den: int) -> int:
    """Half away from zero via the decimal module's ROUND_HALF_UP (ties away from zero)."""
    return int((Decimal(num) / Decimal(den)).quantize(Decimal(1), rounding=ROUND_HALF_UP))


def rounded(num: int, den: int) -> int:
    a = round_fraction(Fraction(num, den))
    b = round_decimal(num, den)
    assert a == b, f"python's own two methods disagree on {num}/{den}: {a} vs {b}"
    return a


def is_tie(num: int, den: int) -> bool:
    return Fraction(num, den).denominator == 2


def expected_surcharge(c):
    base, cur = c["baseCents"], c["currentCents"]
    share, thr, floor, rate = c["fuelShareBp"], c["thresholdBp"], c["floorAtZero"], c["rateCents"]
    diff = cur - base
    change_bp = rounded(10000 * diff, base)
    below = thr > 0 and abs(Fraction(diff, base)) * 10000 < thr
    surcharge_bp = 0 if below else rounded(share * diff, base)
    reason = "BELOW_THRESHOLD" if below else "APPLIED"
    if floor and surcharge_bp < 0:
        surcharge_bp, reason = 0, "FLOORED_AT_ZERO"
    surcharge_cents = rounded(rate * surcharge_bp, 10000)
    return {
        "changeBp": change_bp,
        "surchargeBp": surcharge_bp,
        "reason": reason,
        "surchargeCents": surcharge_cents,
        "totalCents": rate + surcharge_cents,
    }


def surcharge_case(rng, base, cur, share, thr, floor, rate):
    return {
        "kind": "surcharge",
        "baseCents": base,
        "currentCents": cur,
        "fuelShareBp": share,
        "thresholdBp": thr,
        "floorAtZero": floor,
        "rateCents": rate,
    }


def build_cases(rng):
    cases = []
    # 1) realistic: base 500.00 to 4000.00 per 1000 L, current within +-40 %
    for _ in range(12000):
        base = rng.randint(50000, 400000)
        cur = max(1, round(base * rng.uniform(0.6, 1.4)))
        thr = 0 if rng.random() < 0.5 else rng.randint(1, 3000)
        cases.append(surcharge_case(rng, base, cur, rng.randint(0, 10000), thr, rng.random() < 0.3, rng.randint(0, 10_000_000)))
    # 2) tiny bases, so exact .5 ties occur often
    for _ in range(6000):
        base = rng.randint(2, 400)
        cur = rng.randint(1, 800)
        share = rng.choice([500, 1000, 1250, 2000, 2500, 5000, rng.randint(0, 10000)])
        cases.append(surcharge_case(rng, base, cur, share, 0, rng.random() < 0.3, rng.randint(0, 5000)))
    # 3) threshold boundary: base = 10000 k, threshold 500 bp, so 5.00 % is exactly 500 k
    for _ in range(3000):
        k = rng.randint(5, 30)
        base = 10000 * k
        off = rng.choice([-2, -1, 0, 1, 2])
        sign = rng.choice([-1, 1])
        cur = base + sign * (500 * k) + off
        cases.append(surcharge_case(rng, base, cur, rng.randint(0, 10000), 500, False, rng.randint(0, 1_000_000)))
    # 4) money ties: surcharge in bp that makes rate x bp / 10000 end in .5
    for _ in range(2000):
        rate = rng.randint(0, 2000)
        bp_target = rng.choice([50, 100, 150, 250, 500])
        base = 150000
        diff = bp_target * base // 2000  # share 2000 bp
        cur = base + rng.choice([-1, 1]) * diff
        cases.append(surcharge_case(rng, base, cur, 2000, 0, False, rate))
    return cases


def build_date_cases(rng):
    start, span = date(2020, 1, 1), (date(2035, 12, 31) - date(2020, 1, 1)).days
    return [
        {"kind": "monday", "serviceDate": (start + timedelta(days=rng.randint(0, span))).isoformat(), "lagDays": rng.randint(0, 14)}
        for _ in range(6000)
    ]


def main() -> int:
    rng = random.Random(SEED)
    surcharge_cases = build_cases(rng)
    date_cases = build_date_cases(rng)
    cases = surcharge_cases + date_cases

    proc = subprocess.run(
        ["node", str(HERE / "crosscheck-runner.mjs")],
        input=json.dumps(cases), capture_output=True, text=True, check=False,
    )
    if proc.returncode != 0:
        print("node failed:\n" + proc.stderr, file=sys.stderr)
        return 1
    got = json.loads(proc.stdout)
    assert len(got) == len(cases)

    mismatches = []
    ties_bp = ties_cents = below = floored = negative = 0
    for c, g in zip(cases, got):
        if c["kind"] == "monday":
            d = date.fromisoformat(c["serviceDate"]) - timedelta(days=c["lagDays"])
            want = {"referenceDate": (d - timedelta(days=d.weekday())).isoformat()}
        else:
            want = expected_surcharge(c)
            diff = c["currentCents"] - c["baseCents"]
            ties_bp += is_tie(c["fuelShareBp"] * diff, c["baseCents"]) and want["reason"] == "APPLIED"
            ties_cents += is_tie(c["rateCents"] * want["surchargeBp"], 10000)
            below += want["reason"] == "BELOW_THRESHOLD"
            floored += want["reason"] == "FLOORED_AT_ZERO"
            negative += want["surchargeBp"] < 0
        if g != want:
            mismatches.append((c, g, want))

    print(f"seed                        {SEED}")
    print(f"surcharge cases             {len(surcharge_cases)}")
    print(f"  exact ties in surchargeBp {ties_bp}")
    print(f"  exact ties in cents       {ties_cents}")
    print(f"  below threshold           {below}")
    print(f"  floored at zero           {floored}")
    print(f"  negative surcharge        {negative}")
    print(f"Monday cases                {len(date_cases)} (datetime.weekday(), lag 0 to 14 days)")
    print(f"mismatches                  {len(mismatches)}")
    for c, g, want in mismatches[:5]:
        print("  case:", c, "\n   js: ", g, "\n   py: ", want)
    print("RESULT:", "ALL MATCH" if not mismatches else "MISMATCH")
    return 0 if not mismatches else 1


if __name__ == "__main__":
    sys.exit(main())
