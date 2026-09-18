/**
 * PaperLedger — simulated trading used when paperMode is ON (the default).
 *
 * Fills instantly at the requested LTP, tracks one open position per
 * symbol, and keeps session totals. Mirrors the broker's Position shape so
 * the trading loop treats paper and live identically.
 */
export class PaperLedger {
  constructor() {
    this.reset();
  }

  reset() {
    /** @type {Map<string, {symbol:string, qty:number, avgPrice:number, stopPrice:number|null, targetPrice:number|null}>} */
    this.positions = new Map();
    this.trades = []; // {time, symbol, side, qty, price}
    this.realizedPnl = 0;
    this.spendUsed = 0;
  }

  /** @returns {import("./brokers/broker.js").Position[]} */
  getPositions(ltpBySymbol = {}) {
    return [...this.positions.values()].map((p) => ({
      symbol: p.symbol,
      exchange: "NSE",
      quantity: p.qty,
      averagePrice: p.avgPrice,
      unrealizedPnl: (ltpBySymbol[p.symbol] ?? p.avgPrice) * p.qty - p.avgPrice * p.qty,
    }));
  }

  getPosition(symbol) {
    return this.positions.get(symbol) || null;
  }

  /**
   * @param {{symbol:string, side:"BUY"|"SELL", qty:number, price:number, stopPrice?:number|null, targetPrice?:number|null}} fill
   */
  execute({ symbol, side, qty, price, stopPrice = null, targetPrice = null }) {
    const time = new Date().toISOString();
    if (side === "BUY") {
      const cur = this.positions.get(symbol);
      const newQty = (cur?.qty ?? 0) + qty;
      const newAvg = cur ? (cur.avgPrice * cur.qty + price * qty) / newQty : price;
      this.positions.set(symbol, {
        symbol,
        qty: newQty,
        avgPrice: newAvg,
        stopPrice: stopPrice ?? cur?.stopPrice ?? null,
        targetPrice: targetPrice ?? cur?.targetPrice ?? null,
      });
      this.spendUsed += price * qty;
    } else {
      const cur = this.positions.get(symbol);
      if (!cur || cur.qty < qty) throw new Error("Paper ledger: insufficient position to sell");
      this.realizedPnl += (price - cur.avgPrice) * qty;
      const remaining = cur.qty - qty;
      if (remaining === 0) this.positions.delete(symbol);
      else this.positions.set(symbol, { ...cur, qty: remaining });
    }
    const trade = { time, symbol, side, qty, price };
    this.trades.push(trade);
    return { orderId: `PAPER-${Date.now()}`, status: "filled", trade };
  }

  summary() {
    return {
      trades: this.trades.length,
      realizedPnl: this.realizedPnl,
      spendUsed: this.spendUsed,
      openPositions: this.positions.size,
    };
  }
}
