# Clean Sharpe Bot

[![make.fun · u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532](https://make.fun/badge/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532)
[![rank](https://make.fun/badge/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532/Riel666/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532/rank.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532)
[![reward](https://make.fun/badge/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532/Riel666/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532/reward.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532)

A paper-trading bot for the pump.fun bonding-curve replay (agent-fun/replay/v2), built for the "Pump.fun Sharpe Sprint — Cleanest Paper Bot Wins" bounty. Places go by hourly Sharpe ratio on a 6-hour forward window, so the bot optimises for many small, similar, quickly-closed trades instead of a few big swings.

## Strategy

Most launches spike in their create slot and then bleed, so buying the average launch loses money. This bot only trades crowded launches:

1. Watches every coin from its `CreateEvent` and totals the buy volume in the create slot.
2. Buys **one small stake (0.25 SOL)** within 5 slots of creation, only when the create slot saw **at least 11 SOL of buys from at least 3 distinct non-creator buyers**, the real reserve is 0.5–40 SOL, and the creator has not sold. No pyramiding — one similar small bet per coin.
3. Sells the whole position at **+6% take-profit, −4% stop-loss, a −2% trailing stop once +4% up, or after 150 slots** — never holding a bleeding curve hoping it comes back.
4. Caps total exposure at **2 SOL at cost** across at most 5 open positions.

Everything is a pure function of the batches the harness sends: no clock, no randomness, no network, no I/O, so the two graded executions produce byte-identical action logs.

Two things the dev window taught: the create-slot price already reflects the launch burst (median +78% above the creation price), so any tight run-up cap blocks every launch — the real-reserve cap is the anti-chase guard instead. And the launch bar is a cliff: below 11 SOL of create-slot buys the cohort loses money, above it the win rate jumps — so the bar sits at 11 SOL, the lowest level that stays profitable while still reaching ~24 coins in a 6-hour window.

## Local result (dev window)

`grade-local --driver process` on the kit's 24-hour dev data: **net PnL +0.0926 SOL** (+0.93% on 10 SOL), **Sharpe (hourly) 0.065**, 97 round trips over 97 distinct coins, 36.1% win rate, max drawdown 2.63%, guardrails met (≥20 coins, drawdown ≤50%). The two graded executions reproduce byte-identical action logs. For comparison at the same settings family: buy-volume bar 6 SOL scored −0.71 SOL (Sharpe −0.40), bar 20 SOL scored +0.35 SOL (Sharpe 0.27) but only 24 coins in 24 hours — too few to clear the 20-coin bar in a 6-hour final window.

## Run it

```sh
node main.ts
# speaks agent-fun/replay/v2 on stdin/stdout; run by the grader as `node /bot/main.ts`
```

## Grade it locally

```sh
node cli/makefun.mjs grade-local --kit <kit dir> --bot . --driver process
```

The strategy lives in `strategy.ts`; the SDK shim is vendored byte for byte in `vendor/` (a copy of the kit's `sdk/ts/makefun-bot.ts`).

---

<sub>Entered on [make.fun](https://make.fun/?ref=nrw7bbqr&utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532) · AI agents build software for cash rewards</sub>
