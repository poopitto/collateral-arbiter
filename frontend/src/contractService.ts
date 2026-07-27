import { createClient, createAccount } from "genlayer-js";
import { studionet } from "genlayer-js/chains";
import { TransactionStatus } from "genlayer-js/types";
import { CONTRACT_ADDRESS } from "./chain";

type Hex = `0x${string}`;
const TIMEOUT_MS = 240_000;
const POSITION_READ_CONCURRENCY = 4;
const positionCache = new Map<number, PositionRow>();

// ── Domain types ────────────────────────────────────────────────────────────
export type Ruling = "RESILIENT" | "STRESSED" | "FRAGILE" | "LIQUIDATABLE" | "";

// status: 0 OPEN, 1 ACTIVE, 2 FLAGGED, 3 LIQUIDATED, 4 CLOSED
export const STATUS_LABEL = ["OPEN", "ACTIVE", "FLAGGED", "LIQUIDATED", "CLOSED"] as const;

export interface PositionView {
  positionId: number;
  owner: string;
  name: string;
  coinIds: string;
  composition: string;
  status: number;
  ruling: Ruling;
  concentrationPct: number;
  healthScore: number; // 0..1000
  ltvCap: number; // 0..100
  rationale: string;
  createdEpoch: number;
  lastEvalEpoch: number;
  evalCount: number;
  decayStreak: number;
  clusterKey: string;
  cascadeFlag: boolean;
  concentrationHistory: number[];
  healthHistory: number[];
  ltvHistory: number[];
  tierLog: string[]; // "T1" | "T2" | "FORCED"
}
export interface PositionRow extends PositionView { id: number; }

export interface GlobalState {
  admin: string;
  currentEpoch: number;
  totalPositions: number;
  activeCount: number;
  flaggedCount: number;
  liquidatedCount: number;
  networkHealthMean: number;
}

export interface Counts {
  next: number;
  active: number;
  flagged: number;
  liquidated: number;
  epoch: number;
  mean: number;
}

// ── Clients ───────────────────────────────────────────────────────────────--
function readClient() { return createClient({ chain: studionet, account: createAccount() }); }
function writeClient(account: Hex) { return createClient({ chain: studionet, account }); }

async function waitAccepted(client: any, hash: Hex) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("Transaction timed out")), TIMEOUT_MS);
  });
  try {
    await Promise.race([
      client.waitForTransactionReceipt({ hash: hash as never, status: TransactionStatus.ACCEPTED, interval: 5000, retries: 64 }),
      timeout,
    ]);
  } finally { if (timer) clearTimeout(timer); }
}

function pick(obj: any, key: string, idx: number): any {
  if (obj == null) return undefined;
  if (Array.isArray(obj)) return obj[idx];
  if (typeof obj === "object" && key in obj) return obj[key];
  return undefined;
}
function numArr(v: any): number[] {
  if (!Array.isArray(v)) return [];
  return v.map((x) => Number(x) || 0);
}
function strArr(v: any): string[] {
  if (!Array.isArray(v)) return [];
  return v.map((x) => String(x));
}

// ── Stake estimation (mirrors the contract's density formula) ────────────────
// required = MIN_STAKE_WEI * (10 + density*12) / 10
export const MIN_STAKE_WEI = 5_000_000_000_000_000n; // 0.005 GEN
export function requiredStakeWei(density: number): bigint {
  const d = BigInt(Math.max(0, Math.floor(density)));
  return (MIN_STAKE_WEI * (10n + d * 12n)) / 10n;
}

// ── Writes ───────────────────────────────────────────────────────────────--
export async function openPosition(
  account: Hex,
  f: { name: string; coinIds: string; composition: string; stakeWei: bigint }
): Promise<number> {
  const wc = writeClient(account);
  const h = (await wc.writeContract({
    address: CONTRACT_ADDRESS as Hex,
    functionName: "open_position",
    args: [f.name.trim(), f.coinIds.trim(), f.composition.trim()],
    value: f.stakeWei,
  })) as Hex;
  await waitAccepted(wc, h);
  const c = await getCounts();
  return c.next - 1;
}

export async function assessHealth(account: Hex, positionId: number): Promise<void> {
  const wc = writeClient(account);
  const h = (await wc.writeContract({
    address: CONTRACT_ADDRESS as Hex, functionName: "assess_health", args: [positionId], value: 0n,
  })) as Hex;
  await waitAccepted(wc, h);
}

export async function evolveEpoch(account: Hex, positionId: number): Promise<void> {
  const wc = writeClient(account);
  const h = (await wc.writeContract({
    address: CONTRACT_ADDRESS as Hex, functionName: "evolve_position_epoch", args: [positionId], value: 0n,
  })) as Hex;
  await waitAccepted(wc, h);
}

export async function cascadeCheck(account: Hex, clusterKey: string): Promise<void> {
  const wc = writeClient(account);
  const h = (await wc.writeContract({
    address: CONTRACT_ADDRESS as Hex, functionName: "cascade_check", args: [clusterKey], value: 0n,
  })) as Hex;
  await waitAccepted(wc, h);
}

export async function closePosition(account: Hex, positionId: number): Promise<void> {
  const wc = writeClient(account);
  const h = (await wc.writeContract({
    address: CONTRACT_ADDRESS as Hex, functionName: "close_position", args: [positionId], value: 0n,
  })) as Hex;
  await waitAccepted(wc, h);
}

export async function advanceEpoch(account: Hex): Promise<void> {
  const wc = writeClient(account);
  const h = (await wc.writeContract({
    address: CONTRACT_ADDRESS as Hex, functionName: "advance_epoch", args: [], value: 0n,
  })) as Hex;
  await waitAccepted(wc, h);
}

export async function setAdmin(account: Hex, newAdmin: string): Promise<void> {
  const wc = writeClient(account);
  const h = (await wc.writeContract({
    address: CONTRACT_ADDRESS as Hex, functionName: "set_admin", args: [newAdmin], value: 0n,
  })) as Hex;
  await waitAccepted(wc, h);
}

// ── Views ────────────────────────────────────────────────────────────────--
export async function getPosition(positionId: number): Promise<PositionView> {
  const r: any = await readClient().readContract({
    address: CONTRACT_ADDRESS as Hex, functionName: "get_position", args: [positionId],
  });
  return {
    positionId: Number(pick(r, "position_id", 0) ?? positionId),
    owner: String(pick(r, "owner", 1) ?? ""),
    name: String(pick(r, "name", 2) ?? ""),
    coinIds: String(pick(r, "coin_ids", 3) ?? ""),
    composition: String(pick(r, "composition", 4) ?? ""),
    status: Number(pick(r, "status", 5) ?? 0),
    ruling: String(pick(r, "ruling", 6) ?? "") as Ruling,
    concentrationPct: Number(pick(r, "concentration_pct", 7) ?? 0),
    healthScore: Number(pick(r, "health_score", 8) ?? 0),
    ltvCap: Number(pick(r, "ltv_cap", 9) ?? 0),
    rationale: String(pick(r, "rationale", 10) ?? ""),
    createdEpoch: Number(pick(r, "created_epoch", 11) ?? 0),
    lastEvalEpoch: Number(pick(r, "last_eval_epoch", 12) ?? 0),
    evalCount: Number(pick(r, "eval_count", 13) ?? 0),
    decayStreak: Number(pick(r, "decay_streak", 14) ?? 0),
    clusterKey: String(pick(r, "cluster_key", 15) ?? ""),
    cascadeFlag: Boolean(pick(r, "cascade_flag", 16) ?? false),
    concentrationHistory: numArr(pick(r, "concentration_history", 17)),
    healthHistory: numArr(pick(r, "health_history", 18)),
    ltvHistory: numArr(pick(r, "ltv_history", 19)),
    tierLog: strArr(pick(r, "tier_log", 20)),
  };
}

export async function getGlobalState(): Promise<GlobalState> {
  const r: any = await readClient().readContract({
    address: CONTRACT_ADDRESS as Hex, functionName: "get_global_state", args: [],
  });
  return {
    admin: String(pick(r, "admin", 0) ?? ""),
    currentEpoch: Number(pick(r, "current_epoch", 1) ?? 0),
    totalPositions: Number(pick(r, "total_positions", 2) ?? 0),
    activeCount: Number(pick(r, "active_count", 3) ?? 0),
    flaggedCount: Number(pick(r, "flagged_count", 4) ?? 0),
    liquidatedCount: Number(pick(r, "liquidated_count", 5) ?? 0),
    networkHealthMean: Number(pick(r, "network_health_mean", 6) ?? 0),
  };
}

export async function getCounts(): Promise<Counts> {
  const r: any = await readClient().readContract({
    address: CONTRACT_ADDRESS as Hex, functionName: "get_counts", args: [],
  });
  const p = String(r).split("||").map((x) => Number(x) || 0);
  return { next: p[0] || 0, active: p[1] || 0, flagged: p[2] || 0, liquidated: p[3] || 0, epoch: p[4] || 0, mean: p[5] || 0 };
}

export async function listPositions(): Promise<number[]> {
  const r: any = await readClient().readContract({
    address: CONTRACT_ADDRESS as Hex, functionName: "list_positions", args: [],
  });
  return numArr(r);
}

export async function getPositionsOf(ownerHex: string): Promise<number[]> {
  const r: any = await readClient().readContract({
    address: CONTRACT_ADDRESS as Hex, functionName: "get_positions_of", args: [ownerHex],
  });
  return numArr(r);
}

export async function getClusterMembers(clusterKey: string): Promise<number[]> {
  const r: any = await readClient().readContract({
    address: CONTRACT_ADDRESS as Hex, functionName: "get_cluster_members", args: [clusterKey],
  });
  return numArr(r);
}

export async function getAssetExposure(coinId: string): Promise<number[]> {
  const r: any = await readClient().readContract({
    address: CONTRACT_ADDRESS as Hex, functionName: "get_asset_exposure", args: [coinId],
  });
  return numArr(r);
}

// ── Aggregate loaders ────────────────────────────────────────────────────--
export async function listAll(maxRows = 120): Promise<PositionRow[]> {
  const ids = await listPositions();
  if (ids.length === 0) {
    positionCache.clear();
    return [];
  }
  const slice = ids.slice(-maxRows).reverse();
  const rows: Array<PositionRow | null> = new Array(slice.length).fill(null);
  let nextIndex = 0;
  let successfulReads = 0;
  let firstError: unknown;

  // Keep public Studionet reads in a small pool instead of bursting every
  // get_position request at once. Individual failures reuse the last good row.
  async function worker(): Promise<void> {
    while (nextIndex < slice.length) {
      const index = nextIndex;
      nextIndex += 1;
      const id = slice[index];
      try {
        const position = await getPosition(id);
        const row = { id, ...position };
        positionCache.set(id, row);
        rows[index] = row;
        successfulReads += 1;
      } catch (error) {
        firstError ??= error;
        rows[index] = positionCache.get(id) ?? null;
      }
    }
  }

  await Promise.all(
    Array.from(
      { length: Math.min(POSITION_READ_CONCURRENCY, slice.length) },
      () => worker()
    )
  );
  if (successfulReads === 0 && firstError) throw firstError;

  const visibleIds = new Set(ids);
  for (const id of positionCache.keys()) {
    if (!visibleIds.has(id)) positionCache.delete(id);
  }
  return rows.filter((row): row is PositionRow => row !== null);
}

// Density estimate for the stake calculator: count existing positions exposed
// to any of the requested coin ids.
export async function estimateDensity(coinIds: string): Promise<number> {
  const ids = coinIds
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)
    .slice(0, 6);
  if (ids.length === 0) return 0;
  const counts = await Promise.all(ids.map(async (cid) => (await getAssetExposure(cid)).length));
  return counts.reduce((a, b) => a + b, 0);
}
