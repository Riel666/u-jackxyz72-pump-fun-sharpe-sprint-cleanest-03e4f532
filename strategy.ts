// Clean Sharpe bot for the pump.fun bonding-curve replay (agent-fun/replay/v2).
//
// The final window is only 6 hours and places go by hourly Sharpe ratio, so
// this bot optimises for many small, similar, quickly-closed trades instead
// of a few big swings: one small entry per coin, a tight stop, a modest take
// profit, a trailing stop that locks in gains, and a short maximum hold. A
// coin only qualifies when its launch looks genuinely crowded — double-digit
// SOL of buys from at least 3 distinct non-creator buyers in its create slot —
// because the average launch bleeds after its first spike and buying it loses
// money. Coins whose creator sold before entry are skipped outright.
//
// Guardrails the entry must meet: a round trip of at least 0.01 SOL on at
// least 20 distinct mints, and a maximum drawdown of 50%. Small stakes
// (0.25 SOL per coin, at most 2 SOL of cost exposed at once) and the short
// hold keep the equity curve smooth, which is what the hourly Sharpe ratio
// rewards; a single moonshot cannot carry the score and a single rug cannot
// sink it.
//
// Every decision is a pure function of the batches the harness sends: no
// clock, no randomness, no I/O, no environment reads, so the two graded
// executions produce byte-identical action logs.

import type { Batch, Bot, BotState, OrderInput, Pubkey } from './vendor/makefun-bot.ts';

export interface Params {
  /** SOL bought in a coin's create slot before an entry is allowed. */
  minBuyVol0: number;
  /** Distinct non-creator buyers in the create slot before entry. */
  minBuyers0: number;
  /** Real SOL reserve (SOL) a coin must hold before an entry is allowed. */
  minRqSol: number;
  /** ...and at most this much: never chase a coin that already ran far. */
  maxRqSol: number;
  /** Price now must be at most this far above the creation price (fraction).
      Set high on purpose: the create-slot price already reflects the launch
      burst (median +78% on the dev window), so any real cap blocks every
      launch; the real-reserve cap is the anti-chase guard. */
  maxRunup: number;
  /** Entry only within this many slots of the CreateEvent. */
  maxAge: number;
  /** Total SOL to put into one position (single buy, no pyramiding). */
  stakeSol: number;
  /** Take profit: sell when the position's close value reaches cost * (1 + tp). */
  takeProfit: number;
  /** Stop loss: sell when it falls to cost * (1 - sl). */
  stopLoss: number;
  /** Trailing stop: sell when the close value falls this far below its peak
      (0 = off). Arms once the peak reaches cost * (1 + trailArm). */
  trail: number;
  trailArm: number;
  /** Exit after holding this many slots regardless. */
  maxHold: number;
  /** Slots to wait after an exit before the same coin may be bought again. */
  cooldown: number;
  /** Most entries per coin over the run. */
  maxEntries: number;
  /** Slippage allowed on buys (bps); sells always go out at 10000. */
  buySlipBps: number;
  /** Most SOL at cost across all positions at once (a drawdown guard). */
  maxExposureSol: number;
  /** Skip a coin whose creator sold before entry. */
  skipDevSold: boolean;
}

// Sharpe-tuned settings: small stakes, tight stop, modest take profit, a
// trailing stop, and a short hold, so each trade is a similar small bet and
// the equity curve stays smooth. The launch bar is set so the bot still
// reaches 20+ distinct coins inside a 6-hour window.
export const DEFAULT_PARAMS: Params = {
  minBuyVol0: 11,
  minBuyers0: 3,
  minRqSol: 0.5,
  maxRqSol: 40,
  maxRunup: 10,
  maxAge: 5,
  stakeSol: 0.25,
  takeProfit: 0.06,
  stopLoss: 0.04,
  trail: 0.02,
  trailArm: 0.04,
  maxHold: 150,
  cooldown: 600,
  maxEntries: 1,
  buySlipBps: 1000,
  maxExposureSol: 2,
  skipDevSold: true,
};

const LAMPORTS = 1e9;
const CURVE_FEE = 0.0125;

interface Tape {
  created: number | null;
  createPrice: number;
  creator: string;
  devSold: boolean;
  entries: number;
  lastExit: number;
  /** Create-slot totals: buy SOL and distinct non-creator buyers. */
  buyVol0: number;
  buyers0: Set<string>;
}

interface Held {
  opened: number;
  invested: number;
  exiting: boolean;
  filled: boolean;
  peakValue: number;
}

export function createStrategy(p: Params = DEFAULT_PARAMS): Bot {
  const tapes = new Map<Pubkey, Tape>();
  const held = new Map<Pubkey, Held>();

  const tapeOf = (mint: Pubkey): Tape => {
    let t = tapes.get(mint);
    if (t === undefined) {
      t = { created: null, createPrice: 0, creator: '', devSold: false, entries: 0, lastExit: -1e12, buyVol0: 0, buyers0: new Set() };
      tapes.set(mint, t);
    }
    return t;
  };

  /** Close value of `tokens` on this curve now, curve + tx fees deducted (SOL). */
  const closeValue = (tokens: bigint, vq: number, vt: number, tx: number): number => {
    const n = Number(tokens);
    return ((n * vq) / (vt + n) / LAMPORTS) * (1 - CURVE_FEE) - tx;
  };

  return {
    onBatch(state: BotState, batch: Batch): OrderInput[] {
      const now = batch.slot;
      const traded = new Set<Pubkey>();
      for (const e of batch.events) {
        if (e.event === 'CreateEvent') {
          const t = tapeOf(e.mint);
          t.created = e.slot;
          t.createPrice = Number(e.virtual_quote_reserves) / Number(e.virtual_token_reserves);
          t.creator = e.creator;
        } else if (e.event === 'TradeEvent') {
          const t = tapeOf(e.mint);
          const sol = Number(e.sol_amount) / LAMPORTS;
          if (t.created !== null && e.slot === t.created && e.is_buy) {
            t.buyVol0 += sol;
            if (e.user !== t.creator) t.buyers0.add(e.user);
          }
          if (!e.is_buy && e.user === t.creator) t.devSold = true;
          traded.add(e.mint);
        }
      }

      const marks = new Map(batch.marks.map((m) => [m.mint, m] as const));
      const pendingByMint = new Map<Pubkey, number>();
      for (const po of state.pending.values()) {
        pendingByMint.set(po.order.mint, (pendingByMint.get(po.order.mint) ?? 0) + 1);
      }

      const orders: OrderInput[] = [];
      const cap = state.hello.caps.max_orders_per_batch;
      const tx = Number(state.txFeeLamports()) / LAMPORTS;

      // Exits first: take profit, stop loss, trailing stop, or time limit, on
      // the whole position.
      for (const [mint, h] of held) {
        const pos = state.positions.get(mint);
        const curve = state.curves.get(mint);
        if (pos === undefined) {
          if (!pendingByMint.has(mint)) {
            held.delete(mint);
            const t = tapeOf(mint);
            if (h.filled) t.lastExit = now;
            else t.entries--;
          }
          continue;
        }
        h.filled = true;
        if (curve === undefined || curve.complete) continue;
        const mk = marks.get(mint);
        const vq = mk ? Number(mk.virtual_quote_reserves) : Number(curve.virtual_quote_reserves);
        const vt = mk ? Number(mk.virtual_token_reserves) : Number(curve.virtual_token_reserves);
        const value = closeValue(pos.token_amount, vq, vt, tx);
        const cost = Number(pos.cost_lamports) / LAMPORTS;
        if (cost <= 0) continue;
        if (value > h.peakValue) h.peakValue = value;
        let exit = h.exiting;
        if (!exit && value >= cost * (1 + p.takeProfit)) exit = true;
        if (!exit && value <= cost * (1 - p.stopLoss)) exit = true;
        if (!exit && p.trail > 0 && h.peakValue >= cost * (1 + p.trailArm) && value <= h.peakValue * (1 - p.trail)) exit = true;
        if (!exit && now - h.opened > p.maxHold) exit = true;
        if (!exit) continue;
        h.exiting = true;
        let sellPending = false;
        for (const po of state.pending.values()) {
          if (po.order.mint === mint && po.order.side === 'sell') sellPending = true;
        }
        if (sellPending) continue;
        if (orders.length >= cap) break;
        orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: 10_000 });
      }

      // Then entries: one small buy per qualifying launch, never more.
      let free = Number(state.freeCashLamports()) / LAMPORTS;
      let slotsLeft = state.hello.caps.max_open_positions - state.committedPositionCount();
      let exposure = 0;
      for (const [mint, h] of held) {
        exposure += Math.max(h.invested, Number(state.positions.get(mint)?.cost_lamports ?? 0n) / LAMPORTS);
      }
      for (const mint of traded) {
        if (orders.length >= cap) break;
        const curve = state.curves.get(mint);
        if (curve === undefined || curve.complete) continue;
        if (pendingByMint.has(mint)) continue;
        if (held.has(mint)) continue;
        const t = tapes.get(mint)!;
        if (slotsLeft <= 0) continue;
        if (t.entries >= p.maxEntries || now - t.lastExit < p.cooldown) continue;
        if (t.created === null || t.createPrice <= 0) continue;
        if (p.maxAge > 0 && now - t.created > p.maxAge) continue;
        if (t.buyVol0 < p.minBuyVol0) continue;
        if (t.buyers0.size < p.minBuyers0) continue;
        if (p.skipDevSold && t.devSold) continue;
        const price = Number(curve.virtual_quote_reserves) / Number(curve.virtual_token_reserves);
        const rqSol = Number(curve.real_quote_reserves) / LAMPORTS;
        if (rqSol < p.minRqSol || rqSol > p.maxRqSol) continue;
        if (price < t.createPrice || price > t.createPrice * (1 + p.maxRunup)) continue;
        const capSol = Number(state.maxBuyLamports(mint)) / LAMPORTS;
        let amount = Math.min(capSol, p.stakeSol, p.maxExposureSol - exposure);
        if (amount > free - tx) amount = free - tx;
        if (amount < 0.01) continue;
        const lamports = BigInt(Math.floor(amount * LAMPORTS));
        if (lamports < 10_000_000n) continue;
        orders.push({ side: 'buy', mint, quote_lamports: lamports, max_slippage_bps: p.buySlipBps });
        free -= amount + tx;
        exposure += amount;
        held.set(mint, { opened: now, invested: amount, exiting: false, filled: false, peakValue: 0 });
        t.entries++;
        slotsLeft--;
      }
      return orders;
    },
  };
}
