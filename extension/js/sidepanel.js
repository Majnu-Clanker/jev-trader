/**
 * Side panel: UI wiring + the trading loop.
 *
 * The loop runs here (setInterval) rather than in the service worker:
 * closing the panel stops the bot — a deliberate fail-safe so it can
 * never trade unattended.
 *
 * Each tick:
 *   1. market-hours + session checks
 *   2. quote + candles + positions from the broker
 *   3. local indicators
 *   4. deterministic exits first (stop-loss / target / max-loss kill switch)
 *   5. build Jev state -> ask Jev -> BUY / SELL / HOLD
 *   6. risk pre-trade checks -> execute (paper ledger or live order)
 */
import {
  EXCHANGE,
  INTERVALS,
  CANDLES_PER_DECISION,
  MARKET_OPEN_MINUTES,
  MARKET_CLOSE_MINUTES,
  KITE_WEB_URL,
} from "./config.js";
import { loadSettings, saveSettings } from "./storage.js";
import { BrokerFactory } from "./brokers/factory.js";
import "./brokers/kite-session.js";
import { ensureInstruments, searchSymbols, tokenForSymbol } from "./instruments.js";
import { sma, ema, rsi, atr, vwap, rangePosition } from "./indicators.js";
import { buildDecisionState, askJev } from "./jev.js";
import { RiskManager } from "./risk.js";
import { PaperLedger } from "./paper.js";

const $ = (id) => document.getElementById(id);
const broker = BrokerFactory.create("kite-session");

let settings = null;
let risk = null;
let paper = new PaperLedger();
/** live-mode stop/target memory: symbol -> {stopPrice, targetPrice} */
let liveStops = new Map();
let running = false;
let timerId = null;
let recentDecisions = [];
let sessionRealized = 0;
let sessionSpend = 0;
let sessionTrades = 0;
let jevTokens = 0;
let lastTickMarketClosed = false;

/* ---------- helpers ---------- */

function istNow() {
  const d = new Date();
  return new Date(d.getTime() + (330 + d.getTimezoneOffset()) * 60000);
}

function istTimeStr(d = istNow()) {
  return d.toTimeString().slice(0, 8);
}

function log(msg, cls = "") {
  const el = document.createElement("div");
  if (cls) el.className = cls;
  el.innerHTML = `<span class="t">${istTimeStr()}</span>${msg}`;
  const box = $("log");
  box.prepend(el);
  while (box.children.length > 200) box.lastChild.remove();
}

function marketStatus() {
  const d = istNow();
  const day = d.getDay(); // 0 Sun … 6 Sat
  const mins = d.getHours() * 60 + d.getMinutes();
  const weekday = day >= 1 && day <= 5;
  const open = weekday && mins >= MARKET_OPEN_MINUTES && mins < MARKET_CLOSE_MINUTES;
  return { open, minutesToClose: MARKET_CLOSE_MINUTES - mins, weekday };
}

function kiteDateStr(d) {
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/* ---------- connection ---------- */

async function refreshConnection() {
  $("connDot").className = "dot idle";
  $("connText").textContent = "Checking Kite session…";
  $("loginBtn").classList.add("hidden");
  try {
    const ok = await broker.isAuthenticated();
    if (ok) {
      const p = await broker.getProfile();
      $("connDot").className = "dot ok";
      $("connText").textContent = `Connected as ${p.userName || p.userId}`;
      log(`Kite session OK (${p.userId})`, "ok");
    } else {
      $("connDot").className = "dot bad";
      $("connText").textContent = "Not logged in to Kite";
      $("loginBtn").classList.remove("hidden");
    }
  } catch (e) {
    $("connDot").className = "dot bad";
    $("connText").textContent = `Connection check failed: ${e.message}`;
  }
}

/* ---------- positions (paper vs live) ---------- */

async function getOpenPosition(symbol, ltp) {
  if (settings.paperMode) {
    const p = paper.getPosition(symbol);
    if (!p) return null;
    return {
      side: "LONG",
      qty: p.qty,
      avgPrice: p.avgPrice,
      unrealizedPnl: (ltp - p.avgPrice) * p.qty,
      stopPrice: p.stopPrice,
      targetPrice: p.targetPrice,
    };
  }
  const positions = await broker.getPositions();
  const p = positions.find((x) => x.symbol === symbol && x.exchange === EXCHANGE);
  if (!p) return null;
  const stops = liveStops.get(symbol) || {};
  return {
    side: p.quantity > 0 ? "LONG" : "SHORT",
    qty: Math.abs(p.quantity),
    avgPrice: p.averagePrice,
    unrealizedPnl: p.unrealizedPnl,
    stopPrice: stops.stopPrice ?? null,
    targetPrice: stops.targetPrice ?? null,
  };
}

async function executeOrder({ side, qty, price, stopPrice = null, targetPrice = null }) {
  const symbol = settings.symbol;
  if (settings.paperMode) {
    const r = paper.execute({ symbol, side, qty, price, stopPrice, targetPrice });
    sessionTrades++;
    sessionRealized = paper.realizedPnl;
    sessionSpend = paper.spendUsed;
    log(`PAPER ${side} ${qty} ${symbol} @ ₹${price.toFixed(2)}`, "ok");
    return r;
  }
  const r = await broker.placeOrder({
    exchange: EXCHANGE,
    symbol,
    transactionType: side,
    quantity: qty,
    product: "MIS",
    orderType: "MARKET",
  });
  sessionTrades++;
  if (side === "BUY") {
    sessionSpend += price * qty;
    liveStops.set(symbol, { stopPrice, targetPrice });
  } else {
    // approximate realized P&L at LTP for session accounting
    const pos = await getOpenPosition(symbol, price).catch(() => null);
    liveStops.delete(symbol);
    void pos;
  }
  log(`LIVE ${side} ${qty} ${symbol} — order ${r.orderId}`, "ok");
  return r;
}

/* ---------- one decision tick ---------- */

async function tick() {
  if (!running) return;
  const m = marketStatus();
  if (!m.open) {
    if (!lastTickMarketClosed) log("Market closed — waiting for 09:15 IST");
    lastTickMarketClosed = true;
    return;
  }
  lastTickMarketClosed = false;

  const symbol = settings.symbol;
  const instrumentKey = `${EXCHANGE}:${symbol}`;
  try {
    if (!(await broker.isAuthenticated())) {
      halt("Kite session expired — stopped. Log in and press Start again.");
      return;
    }

    const token = tokenForSymbol(symbol);
    if (!token) throw new Error(`No instrument token for ${symbol} — refresh instruments`);

    const [quote, candles] = await Promise.all([
      broker.getQuote(instrumentKey),
      (async () => {
        const to = istNow();
        const from = new Date(to.getTime() - 2 * 24 * 60 * 60000);
        const iv = INTERVALS[settings.interval].kite;
        const all = await broker.getCandles(token, iv, kiteDateStr(from), kiteDateStr(to));
        return all.slice(-Math.max(30, CANDLES_PER_DECISION + 10));
      })(),
    ]);

    const closes = candles.map((c) => c.close);
    const ind = {
      sma20: sma(closes, 20),
      ema9: ema(closes, 9),
      ema21: ema(closes, 21),
      rsi: rsi(candles, 14),
      atr: atr(candles, 14),
      vwap: vwap(candles),
      rangePos: rangePosition(quote.lastPrice, quote.low, quote.high),
    };

    const position = await getOpenPosition(symbol, quote.lastPrice);
    const hasPosition = !!position && position.side === "LONG";

    // 1) deterministic exits before Jev
    if (hasPosition) {
      const hard = risk.checkHardExit({
        ltp: quote.lastPrice,
        stopPrice: position.stopPrice,
        targetPrice: position.targetPrice,
      });
      if (hard) {
        await executeOrder({ side: "SELL", qty: position.qty, price: quote.lastPrice });
        log(`${hard === "STOP_LOSS" ? "Stop-loss" : "Target"} hit — sold ${position.qty} @ ₹${quote.lastPrice.toFixed(2)}`, "err");
        updateStatus(quote, null);
        return;
      }
      if (risk.checkKillSwitch({ realizedPnl: sessionRealized, unrealizedPnl: position.unrealizedPnl })) {
        await executeOrder({ side: "SELL", qty: position.qty, price: quote.lastPrice });
        halt(`Max-loss kill switch tripped (₹${settings.maxLoss}). Position squared off.`);
        return;
      }
    } else if (risk.checkKillSwitch({ realizedPnl: sessionRealized, unrealizedPnl: 0 })) {
      halt(`Max-loss kill switch tripped (₹${settings.maxLoss}).`);
      return;
    }

    // 2) ask Jev
    const state = buildDecisionState({
      symbol,
      exchange: EXCHANGE,
      instrumentToken: token,
      intervalLabel: INTERVALS[settings.interval].label,
      istTime: istTimeStr(),
      minutesToClose: m.minutesToClose,
      quote,
      candles,
      ind,
      position: position
        ? { side: position.side, qty: position.qty, avgPrice: position.avgPrice, unrealizedPnl: position.unrealizedPnl, stopPrice: position.stopPrice, targetPrice: position.targetPrice }
        : { side: "FLAT", qty: 0, avgPrice: 0, unrealizedPnl: 0, stopPrice: null, targetPrice: null },
      session: {
        trades: sessionTrades,
        realizedPnl: sessionRealized,
        spendUsed: sessionSpend,
        spendLimit: settings.spendLimit,
        maxLoss: settings.maxLoss,
      },
      risk: { level: settings.riskLevel, ...risk.describe() },
      mode: settings.paperMode ? "PAPER" : "LIVE",
      recentDecisions,
    });

    const decision = await askJev({ apiKey: settings.jevApiKey, state, hasPosition });
    if (!decision) {
      log("Jev unreachable/indecisive — HOLD", "jev");
      pushDecision("HOLD", null, hasPosition ? "long" : "flat");
      updateStatus(quote, position);
      return;
    }
    jevTokens += decision.inputTokens || 0;
    log(
      `Jev: <b>${decision.action}</b> (conf ${(decision.confidence * 100).toFixed(0)}%, ${(decision.inputTokens || 0).toLocaleString()} tokens)`,
      "jev"
    );

    // 3) act
    if (decision.action === "BUY" && !hasPosition) {
      const qty = risk.sizeQuantity(quote.lastPrice);
      const blocked = risk.checkPreTrade({ trades: sessionTrades, spendUsed: sessionSpend, qty, ltp: quote.lastPrice });
      if (blocked) {
        log(`BUY blocked by risk: ${blocked}`, "err");
      } else {
        await executeOrder({
          side: "BUY",
          qty,
          price: quote.lastPrice,
          stopPrice: risk.stopPrice(quote.lastPrice),
          targetPrice: risk.targetPrice(quote.lastPrice),
        });
      }
    } else if (decision.action === "SELL" && hasPosition) {
      await executeOrder({ side: "SELL", qty: position.qty, price: quote.lastPrice });
    }

    pushDecision(decision.action, decision.confidence, hasPosition ? "long" : "flat");
    updateStatus(quote, await getOpenPosition(symbol, quote.lastPrice));
  } catch (e) {
    if (e.code === "NOT_AUTHENTICATED") {
      halt("Kite session expired — stopped. Log in and press Start again.");
    } else {
      log(`Tick error: ${e.message} — will retry next interval`, "err");
    }
  }
}

function pushDecision(action, conf, pos) {
  const label = `${istTimeStr().slice(0, 5)} ${action} (${pos}${conf !== null ? `, conf ${conf.toFixed(2)}` : ""})`;
  recentDecisions.push(label);
  if (recentDecisions.length > 10) recentDecisions.shift();
  const d = $("lastDecision");
  d.classList.remove("hidden");
  d.innerHTML = `<b>Last decision:</b> ${label}`;
  $("stJev").textContent = conf !== null ? `${action} ${(conf * 100).toFixed(0)}%` : `${action}`;
}

/* ---------- status UI ---------- */

function fmtPnl(n) {
  const s = `${n >= 0 ? "+" : ""}₹${n.toFixed(2)}`;
  return { s, cls: n >= 0 ? "pos" : "neg" };
}

async function updateStatus(quote, position) {
  $("pickedLtp").textContent = quote ? `@ ₹${quote.lastPrice.toFixed(2)}` : "";
  const pos = position ?? (await getOpenPosition(settings.symbol, quote?.lastPrice ?? 0).catch(() => null));
  if (pos) {
    $("stPosition").textContent = `LONG ${pos.qty} @ ₹${pos.avgPrice.toFixed(2)}`;
    const u = fmtPnl(pos.unrealizedPnl);
    $("stUnreal").innerHTML = `<span class="${u.cls}">${u.s}</span>`;
  } else {
    $("stPosition").textContent = "FLAT";
    $("stUnreal").textContent = "—";
  }
  const s = fmtPnl(sessionRealized);
  $("stSession").innerHTML = `<span class="${s.cls}">${s.s}</span>`;
  $("stTrades").textContent = String(sessionTrades);
  $("stSpend").textContent = `₹${Math.round(sessionSpend).toLocaleString("en-IN")} / ₹${settings.spendLimit.toLocaleString("en-IN")}`;
}

/* ---------- start / stop ---------- */

async function start() {
  if (!settings.jevApiKey) {
    log("Set your TypeSafe API key first", "err");
    return;
  }
  if (!(await broker.isAuthenticated())) {
    log("Log in to Kite first", "err");
    return;
  }
  try {
    await ensureInstruments();
  } catch (e) {
    log(`Instruments load failed: ${e.message}`, "err");
    return;
  }
  risk = new RiskManager({
    spendLimit: settings.spendLimit,
    maxLoss: settings.maxLoss,
    riskLevel: settings.riskLevel,
  });
  paper.reset();
  liveStops = new Map();
  recentDecisions = [];
  sessionRealized = 0;
  sessionSpend = 0;
  sessionTrades = 0;
  jevTokens = 0;

  running = true;
  $("startBtn").disabled = true;
  $("stopBtn").disabled = false;
  setControlsEnabled(false);
  log(
    `Started — ${settings.symbol} @ ${INTERVALS[settings.interval].label}, risk ${settings.riskLevel}, ` +
      `${settings.paperMode ? "PAPER" : "LIVE"} mode`,
    "ok"
  );
  tick(); // immediate first decision
  timerId = setInterval(tick, INTERVALS[settings.interval].minutes * 60000);
}

function halt(reason) {
  running = false;
  if (timerId) clearInterval(timerId);
  timerId = null;
  $("startBtn").disabled = false;
  $("stopBtn").disabled = true;
  setControlsEnabled(true);
  log(`STOPPED: ${reason}`, "err");
}

function stop() {
  halt("Stopped by user.");
}

function setControlsEnabled(on) {
  for (const id of ["jevKey", "saveKeyBtn", "symbolInput", "spendLimit", "maxLoss", "intervalSel", "riskSel", "paperToggle"]) {
    $(id).disabled = !on;
  }
}

/* ---------- init / wiring ---------- */

async function init() {
  settings = await loadSettings();
  $("jevKey").value = settings.jevApiKey || "";
  $("spendLimit").value = settings.spendLimit;
  $("maxLoss").value = settings.maxLoss;
  $("intervalSel").value = settings.interval;
  $("riskSel").value = settings.riskLevel;
  $("paperToggle").checked = settings.paperMode;
  $("pickedSymbol").textContent = settings.symbol;
  updateModeBadge();

  refreshConnection();

  $("loginBtn").onclick = () => chrome.tabs.create({ url: KITE_WEB_URL });

  $("saveKeyBtn").onclick = async () => {
    settings = await saveSettings({ jevApiKey: $("jevKey").value.trim() });
    log("TypeSafe API key saved", "ok");
  };

  for (const [id, key, parse] of [
    ["spendLimit", "spendLimit", Number],
    ["maxLoss", "maxLoss", Number],
    ["intervalSel", "interval", (v) => v],
    ["riskSel", "riskLevel", (v) => v],
  ]) {
    $(id).onchange = async () => {
      settings = await saveSettings({ [key]: parse($(id).value) });
    };
  }
  $("paperToggle").onchange = async () => {
    settings = await saveSettings({ paperMode: $("paperToggle").checked });
    updateModeBadge();
  };

  // symbol search
  let searchTimer = null;
  $("symbolInput").oninput = () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(async () => {
      const q = $("symbolInput").value;
      const box = $("symbolResults");
      if (q.trim().length < 2) {
        box.classList.add("hidden");
        return;
      }
      try {
        await ensureInstruments();
        const hits = searchSymbols(q);
        box.innerHTML = "";
        if (hits.length === 0) {
          box.innerHTML = "<div>No matches</div>";
        } else {
          for (const h of hits) {
            const d = document.createElement("div");
            d.textContent = h.symbol;
            d.onclick = async () => {
              settings = await saveSettings({ symbol: h.symbol });
              $("pickedSymbol").textContent = h.symbol;
              $("symbolInput").value = "";
              box.classList.add("hidden");
              log(`Symbol set to ${h.symbol}`);
            };
            box.appendChild(d);
          }
        }
        box.classList.remove("hidden");
      } catch (e) {
        log(`Symbol search failed: ${e.message}`, "err");
      }
    }, 250);
  };

  $("startBtn").onclick = start;
  $("stopBtn").onclick = stop;
  window.addEventListener("beforeunload", () => {
    if (running) {
      running = false;
      if (timerId) clearInterval(timerId);
    }
  });

  log("Jev Trader ready. Log in to Kite, set your API key, pick a stock, press Start.");
}

function updateModeBadge() {
  const b = $("modeBadge");
  b.textContent = settings.paperMode ? "PAPER" : "LIVE";
  b.className = `badge ${settings.paperMode ? "paper" : "live"}`;
}

init();
