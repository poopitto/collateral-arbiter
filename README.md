# Backbasket

Collateral-basket health telemetry on [GenLayer](https://genlayer.com). An owner registers a basket of CoinGecko-listed assets; each epoch a two-tier LLM reads live market data under validator consensus, scores the basket's concentration and 0–1000 health, and drifts an on-chain LTV ceiling that decays while fragility persists.

## How it works

1. Open a position: submit a name, the CoinGecko coin ids, and the composition. The required GEN stake scales with how many existing positions already crowd the same assets.
2. Assess: a fast T1 pass scores the weight of the largest correlated cluster and sets the baseline health score and LTV cap.
3. Evolve each epoch: the position is re-scored against fresh market data. A large concentration shift escalates to a T2 deep stress test that returns a signed health delta; the LTV cap drifts +4 when resilient, −8 when fragile.
4. Cascade check: when three or more positions sharing a cluster all fall below 350 health in one epoch, every member is flagged as correlated systemic risk.

## Architecture

```
backend/collateral-arbiter.py   GenLayer Intelligent Contract (Python, runs on the GenVM)
frontend/                       React + Vite + TypeScript dashboard (genlayer-js)
```

Health is the inverse of fragility, so one 0–1000 score drives both the ruling and the automatic LTV drift, and the contract stores the full per-epoch history on-chain for the dashboard to read.

## Live deployment

- **Network**: GenLayer Studionet (chain id 61999)
- **Contract**: `0x0974437d2d718aedaAf249d844Ad60f4f22Edf01`
- **App**: https://poopitto.github.io/collateral-arbiter/

## Run locally

```bash
cd frontend
npm install
npm run dev
npm run build
```

The committed `.env` holds the public Studionet config; no secrets are required. Copy `.env.example` to `.env.local` only to override.

## Environment variables

| Name | Required | Description |
|------|----------|-------------|
| `VITE_CONTRACT_ADDRESS` | yes | Deployed CollateralArbiter contract on Studionet |
| `VITE_CHAIN_ID` | yes | GenLayer chain id (61999) |
| `VITE_RPC_URL` | yes | Studionet JSON-RPC endpoint |

## Deploy the contract

```bash
npx genlayer deploy --contract backend/collateral-arbiter.py
```

## Contract methods (`CollateralArbiter`)

| Method | Type | Description |
|--------|------|-------------|
| `open_position` | payable | Register a basket; stake scales with asset-cluster density. |
| `assess_health` | write | First T1 pass; sets the baseline health score and LTV cap. |
| `evolve_position_epoch` | write | Re-score against fresh data; escalate to T2 on a large shift. |
| `cascade_check` | write | Flag a cluster when ≥3 members drop below 350 health in one epoch. |
| `close_position` | write | Owner exits a position and releases its asset exposure. |
| `advance_epoch` | write | Admin advances the epoch clock. |
| `set_admin` | write | Rotate the admin/keeper address. |
| `get_position` | view | Full position dossier with concentration, health and LTV history. |
| `get_global_state` | view | Admin, current epoch, and aggregate counts. |
| `list_positions` | view | All position ids. |
| `get_positions_of` | view | Position ids owned by an address. |
| `get_cluster_members` | view | Position ids in a cluster. |
| `get_asset_exposure` | view | Position ids exposed to a coin id. |
| `get_counts` | view | Compact counter string for the dashboard. |

## License

MIT
