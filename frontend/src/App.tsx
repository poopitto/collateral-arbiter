import { useEffect, useMemo, useRef, useState, useCallback } from "react";
import { ConnectButton } from "@rainbow-me/rainbowkit";
import { useAccount } from "wagmi";
import { formatEther } from "viem";
import {
  Stack, GridFour, Warning, Pulse, CaretRight, Gauge, Lightning,
} from "@phosphor-icons/react";
import {
  openPosition, assessHealth, evolveEpoch, cascadeCheck, closePosition,
  advanceEpoch, setAdmin,
  getPosition, getGlobalState, getCounts, listAll, estimateDensity, requiredStakeWei,
  STATUS_LABEL,
  PositionView, PositionRow, GlobalState, Counts,
} from "./contractService";

type Hex = `0x${string}`;
type Tab = "ledger" | "exposure" | "clusters";
type NetworkStatus = "live" | "degraded" | "rate-limited" | "offline";

const CASCADE_HEALTH_FLOOR = 350;
const CASCADE_THRESHOLD = 3;
const REFRESH_TIMEOUT_MS = 30_000;
const POLL_INTERVAL_MS = 30_000;
const RATE_LIMIT_BACKOFF_MS = 60_000;

async function withTimeout<T>(promise: Promise<T>, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`${label} timed out after ${REFRESH_TIMEOUT_MS / 1000}s`)),
      REFRESH_TIMEOUT_MS
    );
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function isRateLimitError(reason: unknown): boolean {
  const message = reason instanceof Error
    ? `${reason.message} ${String((reason as Error & { cause?: unknown }).cause ?? "")}`
    : String(reason);
  return /(?:\b429\b|-32429|server busy|rate.?limit|too many requests)/i.test(message);
}

function shortAddr(a: string): string {
  return a && a.length > 12 ? `${a.slice(0, 6)}\u2026${a.slice(-4)}` : a || "\u2014";
}
function rulingClass(r: string): string {
  switch (r) {
    case "RESILIENT": return "r-res";
    case "STRESSED": return "r-str";
    case "FRAGILE": return "r-fra";
    case "LIQUIDATABLE": return "r-liq";
    default: return "r-non";
  }
}
function fmtGen(wei: bigint): string {
  const s = formatEther(wei);
  const n = Number(s);
  return n < 0.0001 ? s : n.toFixed(4).replace(/0+$/, "").replace(/\.$/, "");
}

// ── Composition parser: largest segment = the concentration cluster ──────────
function parseAlloc(text: string): { label: string; pct: number }[] {
  if (!text) return [];
  const out: { label: string; pct: number }[] = [];
  const re = /(\d{1,3})\s*%\s*([A-Za-z][A-Za-z0-9.\-]{0,11})|([A-Za-z][A-Za-z0-9.\-]{0,11})\s*[:=]?\s*(\d{1,3})\s*%/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const pct = Number(m[1] ?? m[4]);
    const label = (m[2] ?? m[3] ?? "").toUpperCase();
    if (pct > 0 && pct <= 100 && label) out.push({ label, pct });
  }
  return out.slice(0, 8);
}

// ── Sparkline: 1px stroke, no fill, no axis. T2 ticks annotated. ─────────────
function Sparkline({
  values, tiers, max = 1000, w = 132, h = 30, stroke = "currentColor",
}: { values: number[]; tiers?: string[]; max?: number; w?: number; h?: number; stroke?: string }) {
  if (!values || values.length === 0) {
    return <svg width={w} height={h} className="spark" aria-hidden />;
  }
  const n = values.length;
  const dx = n > 1 ? w / (n - 1) : 0;
  const pts = values.map((v, i) => {
    const x = i * dx;
    const y = h - (Math.max(0, Math.min(max, v)) / max) * h;
    return [x, y] as const;
  });
  const d = pts.map((p, i) => `${i === 0 ? "M" : "L"}${p[0].toFixed(1)} ${p[1].toFixed(1)}`).join(" ");
  return (
    <svg width={w} height={h} className="spark" viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" role="img" aria-label={`history, ${n} points`}>
      <path d={d} fill="none" stroke={stroke} strokeWidth={1} vectorEffect="non-scaling-stroke" />
      {tiers && pts.map((p, i) => (tiers[i] === "T2" ? (
        <line key={i} x1={p[0]} y1={0} x2={p[0]} y2={h} stroke="var(--amber)" strokeWidth={1} strokeDasharray="2 2" vectorEffect="non-scaling-stroke" />
      ) : null))}
    </svg>
  );
}

// ── Landing: explains the whole desk; CTA enters the dashboard ───────────────
function Landing({ counts, gstate, onEnter }: { counts: Counts; gstate: GlobalState | null; onEnter: () => void }) {
  const steps: { n: string; t: string; d: string }[] = [
    { n: "01", t: "OPEN", d: "Register a collateral basket \u2014 a name, the CoinGecko ids, and the composition (assets + weights). The required GEN stake scales with asset-cluster density, so crowding into one correlated cluster costs more." },
    { n: "02", t: "ASSESS", d: "A fast T1 LLM reads live CoinGecko data and scores the concentration of the single largest correlated cluster, then derives a 0\u20131000 health score and the first LTV cap." },
    { n: "03", t: "EVOLVE", d: "Every epoch the keeper re-evaluates the position. A large concentration shift escalates to a T2 deep stress test on the correlation matrix. The LTV cap auto-drifts: +4 RESILIENT, flat STRESSED, \u22128 FRAGILE." },
    { n: "04", t: "CASCADE", d: "When \u22653 positions in the same asset cluster all log health < 350 in one epoch, the whole cluster is FLAGGED \u2014 correlated systemic risk cannot hide behind individually \u2018fine\u2019 baskets." },
  ];
  const faqs: { q: string; a: string }[] = [
    { q: "Do I need to deposit real money?", a: "No. The GEN stake is a small anti-spam bond on Studionet (a testnet). Backbasket settles information plus a non-monetary LTV cap \u2014 it never custodies, lends, or liquidates your assets." },
    { q: "What exactly is the health score?", a: "A 0\u20131000 reading of basket resilience: 1000 = well diversified with low correlation, 0 = one fully-correlated cluster. It is the inverse of fragility and drives both the ruling and the LTV drift." },
    { q: "When does the deep T2 stress test fire?", a: "Every epoch a fast T1 LLM scans concentration. If the epoch-over-epoch shift is large (\u226514 points), it escalates to a T2 deep test that returns a signed health delta from the correlation matrix. Those moments are the amber ticks on each sparkline." },
    { q: "Why did my LTV cap move on its own?", a: "It auto-drifts each epoch from the ruling: +4 if RESILIENT, unchanged if STRESSED, \u22128 if FRAGILE \u2014 floored at 20% and capped at 85%." },
    { q: "What is a cascade flag?", a: "If \u22653 positions sharing the same asset cluster all log health < 350 in the same epoch, every member is FLAGGED. Correlated systemic risk cannot hide behind baskets that each look individually \u2018fine\u2019." },
    { q: "Who can do what?", a: "Anyone can open/assess/evolve their own position and run a cascade check. Only the contract admin (the keeper) can advance the epoch or rotate the admin." },
  ];
  const [openFaq, setOpenFaq] = useState<number | null>(0);
  return (
    <div className="bb landing">
      <header className="masthead">
        <div className="mh-l">
          <span className="ticker">BACKBASKET</span>
          <span className="mh-sub">COLLATERAL TELEMETRY DESK / STUDIONET</span>
        </div>
        <div className="mh-r">
          <span className="epoch-tag">EPOCH<b>{String(counts.epoch).padStart(4, "0")}</b></span>
          <ConnectButton showBalance={false} chainStatus="none" accountStatus="address" />
        </div>
      </header>

      <section className="ld-hero">
        <h1>A lending position is only as safe<br />as the basket behind it.</h1>
        <p className="ld-lede">
          Backbasket is a collateral-basket telemetry desk. Every position lives on an epoch clock and is
          re-evaluated against fresh CoinGecko market data by a two-tier LLM running under GenLayer validator
          consensus. The on-chain LTV ceiling decays when fragility persists and recovers when diversification
          improves \u2014 and a cross-position cascade detector flags whole clusters that degrade together.
        </p>
        <div className="ld-cta">
          <button className="enter-btn" onClick={onEnter}>OPEN POSITION <span aria-hidden>&rarr;</span></button>
          <span className="ld-cta-note">Enter the desk \u00b7 connect a wallet to open, assess and evolve positions.</span>
        </div>
      </section>

      <section className="ld-stats">
        <div className="ld-stat"><span>TOTAL POSITIONS</span><b>{counts.next}</b></div>
        <div className="ld-stat"><span>ACTIVE</span><b>{counts.active}</b></div>
        <div className="ld-stat warn"><span>FLAGGED</span><b>{counts.flagged}</b></div>
        <div className="ld-stat bad"><span>LIQUIDATED</span><b>{counts.liquidated}</b></div>
        <div className="ld-stat"><span>NETWORK HEALTH \u03bc</span><b>{counts.mean}<i>/1000</i></b></div>
      </section>

      <section className="ld-how">
        <div className="ld-how-h">HOW THE DESK WORKS</div>
        <div className="ld-steps">
          {steps.map((s) => (
            <div className="ld-step" key={s.n}>
              <span className="ld-num">{s.n}</span>
              <div className="ld-step-b"><b>{s.t}</b><p>{s.d}</p></div>
            </div>
          ))}
        </div>
      </section>

      <section className="ld-faq">
        <div className="ld-how-h">QUESTIONS</div>
        <div className="faq-list">
          {faqs.map((f, i) => (
            <div className={`faq-item ${openFaq === i ? "open" : ""}`} key={i}>
              <button className="faq-q" onClick={() => setOpenFaq(openFaq === i ? null : i)} aria-expanded={openFaq === i}>
                <span>{f.q}</span><span className="faq-sign">{openFaq === i ? "\u2212" : "+"}</span>
              </button>
              {openFaq === i && <div className="faq-a">{f.a}</div>}
            </div>
          ))}
        </div>
      </section>

      <section className="ld-bands">
        <div className="ld-band-h">RULINGS</div>
        <div className="ld-band-grid">
          <div className="lg-row"><span className="rule r-res">RESILIENT</span> health \u2265720, concentration \u226440%</div>
          <div className="lg-row"><span className="rule r-str">STRESSED</span> health \u2265420, concentration \u226470%</div>
          <div className="lg-row"><span className="rule r-fra">FRAGILE</span> below the stressed band</div>
          <div className="lg-row"><span className="rule r-liq">LIQUIDATABLE</span> 3 consecutive epochs &lt; 200</div>
        </div>
        <p className="ld-foot">
          Contract {gstate ? "live" : "loading"} on GenLayer Studionet \u00b7 reads CoinGecko via gl.nondet.web.get \u00b7
          leader + independent-validator consensus via gl.vm.run_nondet_unsafe.
        </p>
        <div className="ld-cta sub">
          <button className="enter-btn" onClick={onEnter}>OPEN POSITION <span aria-hidden>&rarr;</span></button>
        </div>
      </section>
    </div>
  );
}

export function App() {
  const { address, isConnected } = useAccount();
  const acct = address as Hex | undefined;
  const [entered, setEntered] = useState(false);
  const [tab, setTab] = useState<Tab>("ledger");

  const [rows, setRows] = useState<PositionRow[]>([]);
  const [counts, setCounts] = useState<Counts>({ next: 0, active: 0, flagged: 0, liquidated: 0, epoch: 0, mean: 0 });
  const [gstate, setGstate] = useState<GlobalState | null>(null);
  const [loading, setLoading] = useState(true);
  const [networkStatus, setNetworkStatus] = useState<NetworkStatus>("live");
  const refreshInFlight = useRef(false);
  const rateLimitUntil = useRef(0);

  const [selId, setSelId] = useState<number | null>(null);
  const [sel, setSel] = useState<PositionView | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState("");

  // open-position form
  const [name, setName] = useState("");
  const [coinIds, setCoinIds] = useState("");
  const [composition, setComposition] = useState("");
  const [density, setDensity] = useState(0);

  const [adminOpen, setAdminOpen] = useState(false);
  const [newAdmin, setNewAdmin] = useState("");
  const closeRef = useRef<HTMLButtonElement>(null);

  const isAdmin = useMemo(
    () => !!(gstate && acct && gstate.admin.toLowerCase() === acct.toLowerCase()),
    [gstate, acct]
  );
  const stakeWei = useMemo(() => requiredStakeWei(density), [density]);

  const refreshAll = useCallback(async (ignoreBackoff = false) => {
    if (typeof document !== "undefined" && document.hidden) return;
    if (refreshInFlight.current) return;
    if (!ignoreBackoff && Date.now() < rateLimitUntil.current) return;

    refreshInFlight.current = true;
    try {
      const results = await Promise.allSettled([
        withTimeout(getCounts(), "Counts read"),
        withTimeout(getGlobalState(), "Global state read"),
        withTimeout(listAll(120), "Position list read"),
      ] as const);

      let successfulReads = 0;
      if (results[0].status === "fulfilled") {
        setCounts(results[0].value);
        successfulReads += 1;
      }
      if (results[1].status === "fulfilled") {
        setGstate(results[1].value);
        successfulReads += 1;
      }
      if (results[2].status === "fulfilled") {
        setRows(results[2].value);
        successfulReads += 1;
      }

      const failures = results.flatMap((result) =>
        result.status === "rejected" ? [result.reason] : []
      );
      if (failures.some(isRateLimitError)) {
        rateLimitUntil.current = Date.now() + RATE_LIMIT_BACKOFF_MS;
        setNetworkStatus("rate-limited");
      } else if (successfulReads === 0) {
        setNetworkStatus("offline");
      } else if (failures.length > 0) {
        setNetworkStatus("degraded");
      } else {
        rateLimitUntil.current = 0;
        setNetworkStatus("live");
      }
    } finally {
      refreshInFlight.current = false;
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refreshAll();
    const t = setInterval(() => { void refreshAll(); }, POLL_INTERVAL_MS);
    const onVis = () => { if (!document.hidden) void refreshAll(); };
    document.addEventListener("visibilitychange", onVis);
    return () => { clearInterval(t); document.removeEventListener("visibilitychange", onVis); };
  }, [refreshAll]);

  // refresh selected detail when selId changes or after polling
  useEffect(() => {
    if (selId == null) { setSel(null); return; }
    let alive = true;
    getPosition(selId).then((p) => { if (alive) setSel(p); }).catch(() => {});
    return () => { alive = false; };
  }, [selId, counts.epoch, rows.length]);

  // debounce density lookup for the stake calculator
  useEffect(() => {
    if (coinIds.trim().length < 2) { setDensity(0); return; }
    const t = setTimeout(() => { estimateDensity(coinIds).then(setDensity).catch(() => setDensity(0)); }, 500);
    return () => clearTimeout(t);
  }, [coinIds]);

  useEffect(() => {
    if (!adminOpen) return;
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setAdminOpen(false); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [adminOpen]);

  function pick(id: number) { setSelId(id); }

  async function run<T>(label: string, fn: () => Promise<T>): Promise<T | undefined> {
    setBusy(label); setNote("");
    try { return await fn(); }
    catch (e) { setNote(String((e as Error).message || e).slice(0, 240)); return undefined; }
    finally { setBusy(null); void refreshAll(true); }
  }

  async function onOpen() {
    if (!acct) return;
    if (name.trim().length < 2) return setNote("Position name is required.");
    if (coinIds.trim().length < 2) return setNote("CoinGecko ids are required.");
    if (composition.trim().length < 30) return setNote("Composition must be at least 30 characters.");
    const id = await run("OPEN_POSITION", () => openPosition(acct, { name, coinIds, composition, stakeWei }));
    if (id != null) {
      setSelId(id); setName(""); setCoinIds(""); setComposition(""); setDensity(0);
      setNote(`Position #${id} opened. Run ASSESS to establish a baseline.`); setTab("ledger");
    }
  }
  async function onAssess() { if (acct && selId != null) await run("ASSESS_HEALTH", () => assessHealth(acct, selId)); }
  async function onEvolve() { if (acct && selId != null) await run("EVOLVE_EPOCH", () => evolveEpoch(acct, selId)); }
  async function onClose() { if (acct && selId != null) await run("CLOSE_POSITION", () => closePosition(acct, selId)); }
  async function onCascade(clusterKey: string) { if (acct) await run("CASCADE_CHECK", () => cascadeCheck(acct, clusterKey)); }
  async function onAdvance() { if (acct) await run("ADVANCE_EPOCH", () => advanceEpoch(acct)); }
  async function onSetAdmin() { if (acct && /^0x[0-9a-fA-F]{40}$/.test(newAdmin)) await run("SET_ADMIN", () => setAdmin(acct, newAdmin)); }

  // ── Clusters: group rows by clusterKey ────────────────────────────────────
  const clusters = useMemo(() => {
    const m = new Map<string, PositionRow[]>();
    rows.forEach((r) => { const a = m.get(r.clusterKey) || []; a.push(r); m.set(r.clusterKey, a); });
    return Array.from(m.entries()).map(([key, members]) => {
      const live = members.filter((p) => p.status !== 3 && p.status !== 4);
      const fragileNow = live.filter((p) => p.lastEvalEpoch === counts.epoch && p.healthScore < CASCADE_HEALTH_FLOOR).length;
      return { key, members, live, fragileNow, wouldCascade: fragileNow >= CASCADE_THRESHOLD };
    }).sort((a, b) => b.fragileNow - a.fragileNow);
  }, [rows, counts.epoch]);

  const cascadeAlerts = clusters.filter((c) => c.wouldCascade || c.members.some((m) => m.cascadeFlag));

  // ── Asset exposure: coin_id -> position ids ──────────────────────────────--
  const exposure = useMemo(() => {
    const m = new Map<string, PositionRow[]>();
    rows.forEach((r) => {
      r.coinIds.split(",").map((s) => s.trim()).filter(Boolean).forEach((cid) => {
        const a = m.get(cid) || []; a.push(r); m.set(cid, a);
      });
    });
    return Array.from(m.entries()).sort((a, b) => b[1].length - a[1].length);
  }, [rows]);

  const formValid = isConnected && name.trim().length >= 2 && coinIds.trim().length >= 2 && composition.trim().length >= 30;

  const selSegs = sel ? parseAlloc(sel.composition) : [];
  const selMaxPct = selSegs.length ? Math.max(...selSegs.map((s) => s.pct)) : 0;

  if (!entered) return <Landing counts={counts} gstate={gstate} onEnter={() => setEntered(true)} />;

  return (
    <div className="bb">
      {/* ── masthead ───────────────────────────────────────────────────── */}
      <header className="masthead">
        <div className="mh-l">
          <button className="back-btn" onClick={() => setEntered(false)} title="Back to overview" aria-label="Back to overview"><span aria-hidden>&larr;</span> OVERVIEW</button>
          <span className="ticker">BACKBASKET</span>
          <span className="mh-sub">COLLATERAL TELEMETRY DESK / STUDIONET</span>
        </div>
        <div className="mh-r">
          <span className="epoch-tag">EPOCH<b>{String(counts.epoch).padStart(4, "0")}</b></span>
          <span className={`net ${networkStatus !== "live" ? "net-err" : ""}`}>
            {networkStatus === "live" ? "RPC LIVE"
              : networkStatus === "rate-limited" ? "RPC THROTTLED"
                : networkStatus === "degraded" ? "RPC DEGRADED"
                  : "RPC RECONNECT"}
          </span>
          <ConnectButton showBalance={false} chainStatus="none" accountStatus="address" />
        </div>
      </header>

      {/* ── tape: global counters ──────────────────────────────────────── */}
      <div className="tape">
        <div className="tcell"><span>TOTAL</span><b>{counts.next}</b></div>
        <div className="tcell"><span>ACTIVE</span><b>{counts.active}</b></div>
        <div className="tcell warn"><span>FLAGGED</span><b>{counts.flagged}</b></div>
        <div className="tcell bad"><span>LIQUIDATED</span><b>{counts.liquidated}</b></div>
        <div className="tcell"><span>NET HEALTH μ</span><b>{counts.mean}<i>/1000</i></b></div>
        <div className="tcell">
          <span>HEALTH BAND</span>
          <div className="band"><i style={{ width: `${(counts.mean / 1000) * 100}%` }} className={counts.mean >= 720 ? "good" : counts.mean >= 420 ? "amber" : "red"} /></div>
        </div>
      </div>

      {networkStatus !== "live" && (
        <div className="net-strip">
          <Warning size={13} weight="bold" />
          {networkStatus === "rate-limited"
            ? "Studionet is rate-limiting reads. Showing cached on-chain data; polling resumes after a short cooldown."
            : networkStatus === "degraded"
              ? "Some Studionet reads timed out. Available data was refreshed and previous values were preserved."
              : "Lost Studionet RPC. Showing the last on-chain read; retrying automatically."}
        </div>
      )}

      {/* ── cascade alert strip ────────────────────────────────────────── */}
      {cascadeAlerts.length > 0 && (
        <div className="cascade-rail">
          {cascadeAlerts.map((c) => (
            <div key={c.key} className={`cascade ${c.wouldCascade ? "live" : "armed"}`}>
              <Lightning size={14} weight="fill" />
              <code className="ck">{c.key}</code>
              <span className="cmsg">
                {c.fragileNow}/{c.live.length} members &lt; {CASCADE_HEALTH_FLOOR} health this epoch
                {c.members.some((m) => m.cascadeFlag) ? " \u00b7 FLAGGED" : ""}
              </span>
              <span className="cids">{c.members.map((m) => `#${m.id}`).join(" ")}</span>
              <button className="run-cascade" disabled={!isConnected || !!busy} onClick={() => onCascade(c.key)}>RUN CASCADE CHECK</button>
            </div>
          ))}
        </div>
      )}

      <div className="grid">
        {/* ── left: panels ─────────────────────────────────────────────── */}
        <main className="col-main">
          <nav className="tabs">
            <button className={tab === "ledger" ? "on" : ""} onClick={() => setTab("ledger")}><Stack size={13} weight="bold" /> POSITION LEDGER</button>
            <button className={tab === "exposure" ? "on" : ""} onClick={() => setTab("exposure")}><GridFour size={13} weight="bold" /> ASSET EXPOSURE</button>
            <button className={tab === "clusters" ? "on" : ""} onClick={() => setTab("clusters")}><Pulse size={13} weight="bold" /> CLUSTERS</button>
          </nav>

          {tab === "ledger" && (
            <section className="panel">
              {loading ? (
                <div className="skel">{[0, 1, 2, 3, 4].map((i) => <div key={i} className="skel-row" />)}</div>
              ) : rows.length === 0 ? (
                <p className="empty">NO POSITIONS. Open the first basket from the desk on the right.</p>
              ) : (
                <table className="ledger">
                  <thead>
                    <tr>
                      <th>ID</th><th>NAME</th><th>STATUS</th><th>RULING</th>
                      <th className="num">HEALTH</th><th>TIMELINE</th><th className="num">LTV</th>
                      <th>CLUSTER</th><th className="num">EVAL</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((r) => (
                      <tr key={r.id} className={selId === r.id ? "sel" : ""} onClick={() => pick(r.id)} tabIndex={0}
                        onKeyDown={(e) => { if (e.key === "Enter") pick(r.id); }}>
                        <td><code>#{r.id}</code></td>
                        <td className="nm">{r.name || "\u2014"}{r.decayStreak >= 1 && <span className="decay" title={`decay streak ${r.decayStreak}`}>DECAY {r.decayStreak}</span>}</td>
                        <td><span className={`st st${r.status}`}>{STATUS_LABEL[r.status]}</span></td>
                        <td><span className={`rule ${rulingClass(r.ruling)}`}>{r.ruling || "\u2014"}</span></td>
                        <td className="num"><code>{r.healthScore || 0}</code></td>
                        <td className={`tl ${rulingClass(r.ruling)}`}><Sparkline values={r.healthHistory} tiers={r.tierLog} /></td>
                        <td className="num"><code>{r.ltvCap}%</code></td>
                        <td><code className="ck sm">{r.clusterKey}</code></td>
                        <td className="num"><code>{r.lastEvalEpoch}</code></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </section>
          )}

          {tab === "exposure" && (
            <section className="panel">
              {exposure.length === 0 ? <p className="empty">NO ASSET EXPOSURE RECORDED.</p> : (
                <div className="exposure">
                  {exposure.map(([cid, ps]) => (
                    <div key={cid} className="exp-row">
                      <code className="exp-coin">{cid}</code>
                      <div className="exp-bar"><i style={{ width: `${Math.min(100, ps.length * 14)}%` }} /></div>
                      <span className="exp-count">{ps.length}</span>
                      <div className="exp-ids">{ps.map((p) => (
                        <button key={p.id} className={`exp-id ${rulingClass(p.ruling)}`} onClick={() => pick(p.id)}>#{p.id}</button>
                      ))}</div>
                    </div>
                  ))}
                </div>
              )}
              <p className="note-line">Exposure is the input to cascade detection: when \u2265{CASCADE_THRESHOLD} positions sharing a cluster all log health &lt; {CASCADE_HEALTH_FLOOR} in one epoch, the whole cluster is flagged.</p>
            </section>
          )}

          {tab === "clusters" && (
            <section className="panel">
              {clusters.length === 0 ? <p className="empty">NO CLUSTERS.</p> : (
                <div className="clusters">
                  {clusters.map((c) => (
                    <div key={c.key} className={`cluster ${c.wouldCascade ? "casc" : ""}`}>
                      <div className="cl-head">
                        <code className="ck">{c.key}</code>
                        <span className="cl-meta">{c.members.length} members \u00b7 {c.fragileNow} fragile now</span>
                        <button className="run-cascade sm" disabled={!isConnected || !!busy} onClick={() => onCascade(c.key)}>CHECK</button>
                      </div>
                      <div className="cl-members">
                        {c.members.map((m) => (
                          <button key={m.id} className={`cl-mem ${rulingClass(m.ruling)} ${selId === m.id ? "sel" : ""}`} onClick={() => pick(m.id)}>
                            <code>#{m.id}</code><b>{m.healthScore}</b>
                          </button>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </section>
          )}

          {/* ── detail rail ───────────────────────────────────────────── */}
          {sel && selId != null && (
            <section className="panel detail">
              <div className="det-head">
                <h2>POSITION <code>#{selId}</code></h2>
                <span className={`rule ${rulingClass(sel.ruling)}`}>{sel.ruling || "UNASSESSED"}</span>
              </div>
              <div className="det-grid">
                <div className="dk"><span>NAME</span><code>{sel.name}</code></div>
                <div className="dk"><span>OWNER</span><code>{shortAddr(sel.owner)}</code></div>
                <div className="dk"><span>STATUS</span><code>{STATUS_LABEL[sel.status]}</code></div>
                <div className="dk"><span>HEALTH</span><code>{sel.healthScore}/1000</code></div>
                <div className="dk"><span>CONCENTRATION</span><code>{sel.concentrationPct}%</code></div>
                <div className="dk"><span>LTV CAP</span><code>{sel.ltvCap}%</code></div>
                <div className="dk"><span>DECAY STREAK</span><code>{sel.decayStreak}</code></div>
                <div className="dk"><span>EVALS</span><code>{sel.evalCount}</code></div>
                <div className="dk"><span>CREATED</span><code>e{sel.createdEpoch}</code></div>
                <div className="dk"><span>LAST EVAL</span><code>e{sel.lastEvalEpoch}</code></div>
              </div>

              {/* composition bar: widest = concentration cluster */}
              {selSegs.length > 0 && (
                <div className="comp">
                  <div className="comp-label">COMPOSITION</div>
                  <div className="comp-bar">
                    {selSegs.map((s, i) => (
                      <span key={i} className={`comp-seg ${s.pct === selMaxPct ? "lead" : ""}`} style={{ width: `${s.pct}%` }} title={`${s.label} ${s.pct}%`}>
                        <span className="comp-l">{s.label}</span>
                      </span>
                    ))}
                  </div>
                </div>
              )}

              {/* triple sparklines */}
              <div className="triple">
                <div className="tri"><span>HEALTH 0\u20131000</span><Sparkline values={sel.healthHistory} tiers={sel.tierLog} stroke="var(--ink)" /></div>
                <div className="tri"><span>CONCENTRATION %</span><Sparkline values={sel.concentrationHistory} max={100} stroke="var(--ink)" /></div>
                <div className="tri"><span>LTV CAP %</span><Sparkline values={sel.ltvHistory} max={100} stroke="var(--ink)" /></div>
              </div>

              {sel.rationale && <p className="rationale">{sel.rationale}</p>}

              {/* tier log timeline */}
              {sel.tierLog.length > 0 && (
                <div className="tierlog">
                  <div className="comp-label">EVALUATION TIERS</div>
                  <ol>
                    {sel.tierLog.map((t, i) => (
                      <li key={i} className={`tier t-${t.toLowerCase()}`}>
                        <span className="ti-i">{i}</span><code>{t}</code>
                        <span className="ti-h">h={sel.healthHistory[i] ?? "\u2014"}</span>
                      </li>
                    ))}
                  </ol>
                </div>
              )}

              <div className="det-actions">
                {sel.status === 0 && <button className="act" disabled={!isConnected || !!busy} onClick={onAssess}><Gauge size={14} weight="bold" /> ASSESS HEALTH (T1)</button>}
                {(sel.status === 1 || sel.status === 2) && sel.lastEvalEpoch < counts.epoch &&
                  <button className="act" disabled={!isConnected || !!busy} onClick={onEvolve}><Pulse size={14} weight="bold" /> EVOLVE EPOCH</button>}
                {(sel.status === 1 || sel.status === 2) && sel.lastEvalEpoch >= counts.epoch &&
                  <span className="act-hint">Already evaluated in epoch {counts.epoch}. {isAdmin ? "Advance the epoch to re-evaluate." : "Wait for the keeper to advance the epoch."}</span>}
                {sel.status !== 3 && sel.status !== 4 && acct && sel.owner.toLowerCase() === acct.toLowerCase() &&
                  <button className="act ghost" disabled={!isConnected || !!busy} onClick={onClose}>CLOSE POSITION</button>}
                {sel.status === 3 && <span className="act-hint bad">LIQUIDATED after {sel.decayStreak}+ epochs below the decay floor.</span>}
                {sel.status === 4 && <span className="act-hint">CLOSED by owner.</span>}
              </div>
            </section>
          )}
        </main>

        {/* ── right: open-position desk ────────────────────────────────── */}
        <aside className="col-desk">
          <div className="desk">
            <h3>OPEN POSITION</h3>
            <label>NAME</label>
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Stablecoin + blue-chip mix" />
            <label>COINGECKO IDS</label>
            <input value={coinIds} onChange={(e) => setCoinIds(e.target.value)} placeholder="bitcoin,ethereum,usd-coin" />
            <label>COMPOSITION (\u226530 CHARS)</label>
            <textarea value={composition} onChange={(e) => setComposition(e.target.value)} placeholder="40% BTC, 25% ETH, 20% USDC, 15% LST" />
            <div className="stake-calc">
              <div className="sc-row"><span>CLUSTER DENSITY</span><code>{density}</code></div>
              <div className="sc-row"><span>REQUIRED STAKE</span><code>{fmtGen(stakeWei)} GEN</code></div>
            </div>
            <button className="open-btn" disabled={!formValid || !!busy} onClick={onOpen}>
              {isConnected ? `OPEN \u00b7 ${fmtGen(stakeWei)} GEN` : "CONNECT WALLET"}
            </button>
            {!formValid && isConnected && <p className="hint">Name, CoinGecko ids, and a composition of \u226530 characters are required.</p>}
          </div>

          {isAdmin && (
            <div className="desk admin">
              <h3>ADMIN \u00b7 KEEPER</h3>
              <p className="admin-note">You are the contract admin. Advancing the epoch lets every active position be re-evaluated.</p>
              <button className="open-btn" disabled={!!busy} onClick={onAdvance}>ADVANCE EPOCH \u2192 {counts.epoch + 1}</button>
              <button className="how-btn" onClick={() => setAdminOpen(true)}>Rotate admin <CaretRight size={12} weight="bold" /></button>
            </div>
          )}

          <div className="legend">
            <div className="lg-row"><span className="rule r-res">RESILIENT</span> health \u2265720, conc \u226440%</div>
            <div className="lg-row"><span className="rule r-str">STRESSED</span> health \u2265420, conc \u226470%</div>
            <div className="lg-row"><span className="rule r-fra">FRAGILE</span> below stressed band</div>
            <div className="lg-row"><span className="rule r-liq">LIQUIDATABLE</span> 3 epochs &lt;200</div>
            <div className="lg-row spark-leg"><Sparkline values={[200, 600, 400, 800]} tiers={["T1", "T2", "T1", "T2"]} w={60} h={16} stroke="var(--ink)" /> amber tick = T2 deep stress test</div>
          </div>
        </aside>
      </div>

      {adminOpen && (
        <div className="ov" onClick={() => setAdminOpen(false)}>
          <div className="ov-modal" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
            <div className="ov-head"><h2>ROTATE ADMIN</h2><button ref={closeRef} className="ov-close" onClick={() => setAdminOpen(false)}>\u00d7</button></div>
            <p className="admin-note">Transfers admin + keeper rights to a new address. This cannot be undone from this UI.</p>
            <input value={newAdmin} onChange={(e) => setNewAdmin(e.target.value)} placeholder="0x\u2026 new admin address" />
            <button className="open-btn" disabled={!!busy || !/^0x[0-9a-fA-F]{40}$/.test(newAdmin)} onClick={onSetAdmin}>SET ADMIN</button>
          </div>
        </div>
      )}

      {(busy || note) && <div className="toast">{busy ? `${busy}\u2026` : note}</div>}
    </div>
  );
}
