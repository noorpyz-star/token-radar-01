// Token Radar's scoring model: a sealed DefiLlama snapshot in, a ranked board out.
//
// The board ranks pre-token protocols by an implied value that comes only from the
// snapshot's own figures. Nothing here names a protocol: one function scores every row,
// and the dashboard shows the same function, so the page and the board can never disagree.
//
// The model, in plain words:
//
//   multiple   = the median market-cap-to-TVL ratio of the live-token protocols in this
//                very snapshot (market cap and TVL both positive, exchanges left out).
//                It is the market's own answer to "what is a protocol like this worth
//                per dollar of TVL", read off the protocols that already trade.
//   base       = tvl_usd x multiple
//   growth     = change_7d clamped to [-50, +100] per cent
//   growth x   = 1 + growth / 100 x 0.55
//   maturity   = 0.70 + 0.50 x min(age_days, 1460) / 1460
//                age_days is the days from listed_at to the snapshot's as_of date:
//                the longer a protocol has run with no token on record, the more its
//                launch, if it comes, has had time to matter. A missing listed_at
//                counts as 365 days.
//   implied    = round(base x growth x maturity), at least $1
//
// Two rows that round to the same dollar are separated by a $1 step so the board is a
// strict ranking: each rank's value sits at least $1 below the rank above it. The
// dashboard applies the same step, so its recompute matches board.json exactly.
//
// A protocol "records no token" when its DefiLlama record carries no market cap, no
// CoinGecko id and no symbol. That is all the snapshot can say: it never proves a
// protocol has no token, only that none is recorded for it.

export interface SnapshotProtocol {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
}

export interface Snapshot {
  as_of: string;
  source: string;
  floor_usd: number;
  protocols: SnapshotProtocol[];
  watchlist: string[];
}

/** The model's tunables, stated in the dashboard and fixed for this snapshot. */
export interface ModelSettings {
  growth_weight: number;
  growth_floor: number;
  growth_cap: number;
  maturity_floor: number;
  maturity_range: number;
  maturity_days: number;
  unknown_age_days: number;
  multiple_floor: number;
  multiple_cap: number;
}

export const SETTINGS: ModelSettings = {
  growth_weight: 0.55,
  growth_floor: -50,
  growth_cap: 100,
  maturity_floor: 0.7,
  maturity_range: 0.5,
  maturity_days: 1460,
  unknown_age_days: 365,
  multiple_floor: 0.1,
  multiple_cap: 1.0,
};

export const MODEL_VERSION = 'radar-median-1';

/** Early rows: pre-token protocols below the watchlist floor, by TVL. */
export const EARLY_ROWS = 160;

/** Live-token protocols shown apart from the ranking, by market cap. */
export const LIVE_ROWS = 24;

export interface BoardRow {
  rank: number;
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
  token_status: 'pre-token';
  age_days: number | null;
  implied_value_usd: number;
  model: {
    multiple: number;
    growth_pct: number;
    growth_multiplier: number;
    maturity_multiplier: number;
    age_days: number | null;
  };
  farm_steps: string[];
}

export interface DashboardRow {
  rank: number;
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  age_days: number | null;
  implied_value_usd: number;
  growth_multiplier: number;
  maturity_multiplier: number;
  farm_steps: string[];
}

export interface LiveRow {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  mcap_usd: number | null;
  change_7d: number | null;
}

export interface RadarData {
  as_of: string;
  source: string;
  floor_usd: number;
  model: ModelSettings;
  model_version: string;
  multiple: number;
  multiple_sample: number;
  watchlist_size: number;
  board_size: number;
  early_size: number;
  live_size: number;
  rows: DashboardRow[];
  live: LiveRow[];
}

export class SnapshotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SnapshotError';
  }
}

const DAY_MS = 86_400_000;

function finiteNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function round4(n: number): number {
  return Math.round(n * 1e4) / 1e4;
}

/** Whole days from `listedAt` to `asOf`, never below zero; null when either side is missing or malformed. */
export function ageDays(asOf: string, listedAt: string | null): number | null {
  if (listedAt === null) return null;
  const a = Date.parse(`${asOf}T00:00:00Z`);
  const b = Date.parse(`${listedAt}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.max(0, Math.floor((a - b) / DAY_MS));
}

/**
 * The base multiple: the median market-cap-to-TVL ratio of the snapshot's live-token
 * protocols (both figures positive, exchanges excluded), clamped to the settings' band.
 * It is read off the market inside this snapshot, never chosen by hand.
 */
export function baseMultiple(snapshot: Snapshot, settings: ModelSettings = SETTINGS): { multiple: number; sample: number } {
  const ratios = snapshot.protocols
    .filter((p) => p.mcap_usd !== null && p.mcap_usd > 0 && p.tvl_usd > 0 && p.category !== 'CEX')
    .map((p) => (p.mcap_usd as number) / p.tvl_usd)
    .sort((a, b) => a - b);
  if (ratios.length === 0) return { multiple: 0.25, sample: 0 };
  const mid = Math.floor(ratios.length / 2);
  const median = ratios.length % 2 === 1 ? ratios[mid]! : (ratios[mid - 1]! + ratios[mid]!) / 2;
  const clamped = Math.min(settings.multiple_cap, Math.max(settings.multiple_floor, median));
  return { multiple: round4(clamped), sample: ratios.length };
}

/** The three multipliers and the raw implied value for one protocol. */
export function scoreProtocol(
  protocol: SnapshotProtocol,
  asOf: string,
  multiple: number,
  settings: ModelSettings = SETTINGS,
): { raw: number; growthPct: number; growthMult: number; maturityMult: number; age: number | null } {
  const age = ageDays(asOf, protocol.listed_at);
  const growthPct = Math.min(settings.growth_cap, Math.max(settings.growth_floor, finiteNumber(protocol.change_7d, 0)));
  const growthMult = 1 + (growthPct / 100) * settings.growth_weight;
  const ageForModel = age ?? settings.unknown_age_days;
  const maturityMult =
    settings.maturity_floor +
    (Math.min(Math.max(ageForModel, 0), settings.maturity_days) / settings.maturity_days) * settings.maturity_range;
  const raw = Math.max(1, Math.round(protocol.tvl_usd * multiple * growthMult * maturityMult));
  return { raw, growthPct, growthMult: round4(growthMult), maturityMult: round4(maturityMult), age };
}

/**
 * The strict-ranking step: given raw values already sorted strongest first, force each
 * value at least $1 below the one above it. Values are in the millions, so the step is
 * invisible in scale and exact in order.
 */
export function enforceStrict(values: number[]): number[] {
  const out = values.slice();
  for (let i = 1; i < out.length; i++) {
    if (out[i]! >= out[i - 1]!) out[i] = out[i - 1]! - 1;
  }
  return out.map((v) => Math.max(1, v));
}

/** A name ending in a release marker is a versioned pool of another protocol, not its own launch. */
const VERSIONED_NAME = /\s(V\d+(\.\d+)?|v\d+(\.\d+)?|\d+\.\d+)$/;

/** A protocol records no token: no market cap, no CoinGecko id, no symbol. */
export function recordsNoToken(p: SnapshotProtocol): boolean {
  return p.mcap_usd === null && p.gecko_id === null && p.symbol === null;
}

/** An early-row candidate: pre-token, below the floor, not an exchange and not a versioned pool. */
export function isEarlyCandidate(p: SnapshotProtocol): boolean {
  return recordsNoToken(p) && p.category !== 'CEX' && !VERSIONED_NAME.test(p.name);
}

function indexBySlug(protocols: SnapshotProtocol[]): Map<string, SnapshotProtocol> {
  return new Map(protocols.map((p) => [p.slug, p]));
}

/** The board: every watchlist slug, plus the 160 highest-TVL early candidates, ranked by implied value. */
export function buildBoard(snapshot: Snapshot, settings: ModelSettings = SETTINGS): BoardRow[] {
  const { multiple } = baseMultiple(snapshot, settings);
  const index = indexBySlug(snapshot.protocols);
  const chosen = new Map<string, SnapshotProtocol>();
  for (const slug of snapshot.watchlist) {
    const p = index.get(slug);
    if (p !== undefined) chosen.set(slug, p);
  }
  const early = snapshot.protocols
    .filter((p) => !chosen.has(p.slug) && isEarlyCandidate(p) && p.tvl_usd < snapshot.floor_usd)
    .sort((a, b) => b.tvl_usd - a.tvl_usd || (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0))
    .slice(0, EARLY_ROWS);
  for (const p of early) chosen.set(p.slug, p);

  const scored = [...chosen.values()].map((p) => {
    const s = scoreProtocol(p, snapshot.as_of, multiple, settings);
    return { p, ...s };
  });
  scored.sort((a, b) => b.raw - a.raw || (a.p.slug < b.p.slug ? -1 : a.p.slug > b.p.slug ? 1 : 0));
  const finalValues = enforceStrict(scored.map((s) => s.raw));
  return scored.map((s, i) => ({
    rank: i + 1,
    slug: s.p.slug,
    name: s.p.name,
    category: s.p.category,
    chains: s.p.chains,
    tvl_usd: s.p.tvl_usd,
    change_7d: s.p.change_7d,
    mcap_usd: s.p.mcap_usd,
    listed_at: s.p.listed_at,
    gecko_id: s.p.gecko_id,
    symbol: s.p.symbol,
    token_status: 'pre-token',
    age_days: s.age,
    implied_value_usd: finalValues[i]!,
    model: {
      multiple,
      growth_pct: s.growthPct,
      growth_multiplier: s.growthMult,
      maturity_multiplier: s.maturityMult,
      age_days: s.age,
    },
    farm_steps: farmPlan(s.p, s.age).map(renderStep),
  }));
}

/** One farm step before rendering: the action, its cost, and its time. */
export interface FarmStep {
  action: string;
  cost: string;
  time: string;
}

/** A step as one string: action, then cost and time, inside the gate's 20..600 characters. */
export function renderStep(step: FarmStep): string {
  let s = `${step.action} Cost: ${step.cost}. Time: ${step.time}.`;
  if (s.length > 600) s = `${s.slice(0, 596)}...`;
  if (s.length < 20) s = `${s} Keep the position open and check the protocol's own page for updates.`;
  return s;
}

function firstChain(p: SnapshotProtocol): string {
  return p.chains.length > 0 ? p.chains[0]! : 'its main chain';
}

/** Capital for one farm position, from the protocol's own TVL. */
function capitalFor(p: SnapshotProtocol): number {
  if (p.tvl_usd >= 5_000_000_000) return 500;
  if (p.tvl_usd >= 1_000_000_000) return 250;
  if (p.tvl_usd >= 250_000_000) return 150;
  if (p.tvl_usd >= 50_000_000) return 100;
  return 50;
}

/** How long to hold, from the protocol's age: younger protocols get a longer window. */
function holdDaysFor(age: number | null): number {
  if (age === null) return 30;
  if (age < 180) return 60;
  if (age < 365) return 45;
  return 30;
}

/** What one transaction costs on a chain, in the words a farmer budgets by. */
function gasNote(chain: string): string {
  const c = chain.toLowerCase();
  if (c === 'ethereum') return 'about $12 of gas on Ethereum';
  if (c === 'solana') return 'under $0.10 of fees on Solana';
  if (['base', 'arbitrum', 'optimism', 'zksync', 'polygon', 'blast', 'linea', 'scroll', 'mode', 'fraxtal'].includes(c)) {
    return `about $1 of gas on ${chain}`;
  }
  return `about $4 of gas on ${chain}`;
}

/** The main action for a category, written so a farmer can follow it without guessing. */
function mainAction(p: SnapshotProtocol, capital: number, chain: string): string {
  const c = (p.category ?? '').toLowerCase();
  const name = p.name;
  if (c.includes('lend') || c.includes('cdp') || c.includes('collateral')) {
    return `Supply $${capital} of USDC to ${name} on ${chain} as a lender and leave the deposit earning.`;
  }
  if (c.includes('dex') || c.includes('amm')) {
    return `Add $${capital} of liquidity to the most active pool on ${name} (${chain}) and hold the LP position.`;
  }
  if (c.includes('liquid staking') || c.includes('liquid restaking') || c.includes('restaked')) {
    return `Stake $${capital} of the chain's staking asset through ${name} on ${chain} and keep the receipt token.`;
  }
  if (c.includes('bridge') || c.includes('cross chain') || c.includes('cross-chain')) {
    return `Bridge $${capital} of USDC into ${chain} through ${name}, then use the bridged funds inside its app.`;
  }
  if (c.includes('perpetual') || c.includes('derivative') || c.includes('options') || c.includes('synthetic')) {
    return `Deposit $${capital} of USDC as margin on ${name} (${chain}) and open one small hedged position.`;
  }
  if (c.includes('yield') || c.includes('leveraged farm') || c.includes('farm')) {
    return `Deposit $${capital} of USDC into ${name}'s highest-yield vault on ${chain} and leave it compounding.`;
  }
  if (c.includes('prediction')) {
    return `Fund $${capital} on ${name} (${chain}) and place one position in a market that closes within a month.`;
  }
  if (c.includes('rwa') || c.includes('real world')) {
    return `Mint $${capital} of the yield-bearing asset ${name} issues on ${chain} and hold it in your wallet.`;
  }
  if (c.includes('stable')) {
    return `Mint or deposit $${capital} of the stable asset through ${name} on ${chain} and keep it in the protocol.`;
  }
  if (c.includes('insurance')) {
    return `Buy $${capital} of cover from ${name} on ${chain} and keep the policy active for the full term.`;
  }
  if (c.includes('curator') || c.includes('allocator') || c.includes('onchain capital')) {
    return `Deposit $${capital} into a ${name} vault on ${chain} and hold the vault shares.`;
  }
  if (c.includes('staking')) {
    return `Stake $${capital} through ${name} on ${chain} and keep the staking receipt in your wallet.`;
  }
  if (c.includes('launchpad') || c.includes('ido')) {
    return `Join ${name}'s next sale on ${chain} with $${capital} and hold the allocation through its lock.`;
  }
  if (c.includes('nft') || c.includes('marketplace')) {
    return `List or buy one item through ${name} on ${chain} for about $${capital} and keep the receipt.`;
  }
  return `Deposit $${capital} of USDC into ${name} on ${chain} and keep the position open.`;
}

/** A second, different action for the same category, so the plan is a routine and not one deposit. */
function secondAction(p: SnapshotProtocol, capital: number, chain: string): string {
  const c = (p.category ?? '').toLowerCase();
  const name = p.name;
  if (c.includes('lend') || c.includes('cdp') || c.includes('collateral')) {
    return `Borrow $${Math.round(capital / 2)} of USDC against the deposit on ${name} and repay it within a week.`;
  }
  if (c.includes('dex') || c.includes('amm')) {
    return `Swap $${Math.round(capital / 2)} between the pool's two assets on ${name} (${chain}) once a week.`;
  }
  if (c.includes('liquid staking') || c.includes('liquid restaking') || c.includes('restaked') || c.includes('staking')) {
    return `Use the receipt token from ${name} once in a lending market on ${chain} and unwind it the same week.`;
  }
  if (c.includes('bridge') || c.includes('cross chain') || c.includes('cross-chain')) {
    return `Bridge a second, smaller amount of $${Math.round(capital / 2)} back through ${name} to show two-way use.`;
  }
  if (c.includes('perpetual') || c.includes('derivative') || c.includes('options') || c.includes('synthetic')) {
    return `Close the first hedge on ${name} and open a second one half its size within the same month.`;
  }
  if (c.includes('yield') || c.includes('leveraged farm') || c.includes('farm')) {
    return `Move $${Math.round(capital / 2)} of the vault position into a second ${name} vault on ${chain} once.`;
  }
  if (c.includes('prediction')) {
    return `Settle one market on ${name} and place a second position for about $${Math.round(capital / 2)}.`;
  }
  if (c.includes('rwa') || c.includes('real world') || c.includes('stable')) {
    return `Redeem a small part of the ${name} position, about $${Math.round(capital / 4)}, and re-enter it.`;
  }
  return `Make one more qualifying action on ${name} (${chain}) the following week, such as a swap, a vote or a deposit.`;
}

/**
 * A protocol's farm plan: seven steps, each an action with a cost and a time. Every
 * step is derived from the protocol's own record (category, chains, TVL, age); no
 * protocol name is ever special-cased, and no step promises an airdrop or a token.
 */
export function farmPlan(p: SnapshotProtocol, age: number | null): FarmStep[] {
  const chain = firstChain(p);
  const capital = capitalFor(p);
  const hold = holdDaysFor(age);
  const gas = gasNote(chain);
  return [
    {
      action: `Open a fresh wallet that holds only the funds you plan to farm, and keep its seed phrase offline on paper.`,
      cost: 'nothing to open, and under $3 of gas for the first transaction',
      time: '5 minutes',
    },
    {
      action: mainAction(p, capital, chain),
      cost: `$${capital} of capital and ${gas}`,
      time: '15 minutes to set up',
    },
    {
      action: secondAction(p, capital, chain),
      cost: `about $${Math.round(capital / 2)} moved, and ${gas}`,
      time: '10 minutes a week',
    },
    {
      action: `Hold the position for at least ${hold} days so the activity is counted in more than one snapshot.`,
      cost: `the $${capital} stays in the position`,
      time: `${hold} days`,
    },
    {
      action: `Copy the protocol's contract addresses only from its official docs or site, and check them once before the first deposit.`,
      cost: 'nothing, and never trust a contract address from a direct message',
      time: '10 minutes',
    },
    {
      action: `Open the protocol's own points or rewards page and claim only from the link it publishes, never from a link someone sends you.`,
      cost: 'no fee to check, and never pay anyone to claim for you',
      time: '10 minutes',
    },
    {
      action: `Write the wallet, the dates and every transaction in a farm log, and plan the exit: unwind in tranches if the position grows large.`,
      cost: 'nothing but the log',
      time: '5 minutes',
    },
  ];
}

/** The live-token protocols, by market cap, for the dashboard's Live token view. */
export function liveRows(snapshot: Snapshot): LiveRow[] {
  return snapshot.protocols
    .filter((p) => !recordsNoToken(p) && p.category !== 'CEX')
    .sort((a, b) => (b.mcap_usd ?? 0) - (a.mcap_usd ?? 0) || b.tvl_usd - a.tvl_usd)
    .slice(0, LIVE_ROWS)
    .map((p) => ({
      slug: p.slug,
      name: p.name,
      category: p.category,
      chains: p.chains,
      tvl_usd: p.tvl_usd,
      mcap_usd: p.mcap_usd,
      change_7d: p.change_7d,
    }));
}

function dashboardRow(row: BoardRow): DashboardRow {
  return {
    rank: row.rank,
    slug: row.slug,
    name: row.name,
    category: row.category,
    chains: row.chains,
    tvl_usd: row.tvl_usd,
    change_7d: row.change_7d,
    mcap_usd: row.mcap_usd,
    listed_at: row.listed_at,
    age_days: row.age_days,
    implied_value_usd: row.implied_value_usd,
    growth_multiplier: row.model.growth_multiplier,
    maturity_multiplier: row.model.maturity_multiplier,
    farm_steps: row.farm_steps,
  };
}

/** Everything the dashboard renders, from the snapshot. */
export function buildRadar(snapshot: Snapshot, settings: ModelSettings = SETTINGS): { board: BoardRow[]; radar: RadarData } {
  const board = buildBoard(snapshot, settings);
  const { multiple, sample } = baseMultiple(snapshot, settings);
  const live = liveRows(snapshot);
  const early = board.filter((r) => !snapshot.watchlist.includes(r.slug)).length;
  const radar: RadarData = {
    as_of: snapshot.as_of,
    source: snapshot.source,
    floor_usd: snapshot.floor_usd,
    model: settings,
    model_version: MODEL_VERSION,
    multiple,
    multiple_sample: sample,
    watchlist_size: snapshot.watchlist.length,
    board_size: board.length,
    early_size: early,
    live_size: live.length,
    rows: board.map(dashboardRow),
    live,
  };
  return { board, radar };
}

/** The snapshot out of a file's text, refused unless it is the shape the model scores. */
export function parseSnapshot(text: string): Snapshot {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new SnapshotError('snapshot.json is not JSON');
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new SnapshotError('snapshot.json is not a JSON object');
  const o = raw as Record<string, unknown>;
  if (typeof o.as_of !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(o.as_of)) throw new SnapshotError('snapshot.json has no as_of date');
  if (typeof o.source !== 'string') throw new SnapshotError('snapshot.json has no source');
  if (typeof o.floor_usd !== 'number' || !Number.isSafeInteger(o.floor_usd) || o.floor_usd <= 0) {
    throw new SnapshotError('snapshot.json has no floor_usd');
  }
  if (!Array.isArray(o.protocols)) throw new SnapshotError('snapshot.json has no protocols array');
  if (!Array.isArray(o.watchlist) || o.watchlist.some((s) => typeof s !== 'string')) {
    throw new SnapshotError('snapshot.json has no watchlist of slugs');
  }
  const protocols = o.protocols.map((v, i) => {
    if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new SnapshotError(`snapshot.json's protocol ${i} is not an object`);
    const p = v as Record<string, unknown>;
    if (typeof p.slug !== 'string' || typeof p.name !== 'string' || typeof p.tvl_usd !== 'number' || !Number.isFinite(p.tvl_usd)) {
      throw new SnapshotError(`snapshot.json's protocol ${i} lacks a slug, a name or a TVL`);
    }
    return {
      slug: p.slug,
      name: p.name,
      category: typeof p.category === 'string' ? p.category : null,
      chains: Array.isArray(p.chains) ? p.chains.filter((c): c is string => typeof c === 'string') : [],
      tvl_usd: p.tvl_usd,
      change_7d: typeof p.change_7d === 'number' && Number.isFinite(p.change_7d) ? p.change_7d : null,
      mcap_usd: typeof p.mcap_usd === 'number' && Number.isFinite(p.mcap_usd) ? p.mcap_usd : null,
      listed_at: typeof p.listed_at === 'string' ? p.listed_at : null,
      gecko_id: typeof p.gecko_id === 'string' ? p.gecko_id : null,
      symbol: typeof p.symbol === 'string' ? p.symbol : null,
    };
  });
  return {
    as_of: o.as_of,
    source: o.source,
    floor_usd: o.floor_usd,
    protocols,
    watchlist: o.watchlist as string[],
  };
}

/** Why a board is not one the gate will take, or null: coverage, ranks, order, one shared value, farm steps. */
export function boardIssue(board: BoardRow[], snapshot: Snapshot): string | null {
  const slugs = new Set(board.map((r) => r.slug));
  const missing = snapshot.watchlist.filter((s) => !slugs.has(s));
  if (missing.length > 0) return `the board misses ${missing.length} watchlist slug${missing.length === 1 ? '' : 's'}: ${missing.slice(0, 5).join(', ')}`;
  const ranks = board.map((r) => r.rank).sort((a, b) => a - b);
  for (let i = 0; i < ranks.length; i++) if (ranks[i] !== i + 1) return `rank ${i + 1} is ${ranks[i]}`;
  for (let i = 1; i < board.length; i++) {
    if (board[i]!.implied_value_usd >= board[i - 1]!.implied_value_usd) {
      return `row ${i + 1} does not sit below row ${i} on implied value`;
    }
  }
  if (board.length >= 2 && board[0]!.implied_value_usd === board[board.length - 1]!.implied_value_usd) {
    return `all ${board.length} rows share the same implied value $${board[0]!.implied_value_usd}: a board that ranks nothing by value is not a ranking`;
  }
  for (const r of board) {
    if (!Number.isSafeInteger(r.implied_value_usd) || r.implied_value_usd <= 0) {
      return `${r.slug} has implied value ${r.implied_value_usd}`;
    }
    if (r.farm_steps.length < 3 || r.farm_steps.length > 12) return `${r.slug} has ${r.farm_steps.length} farm steps`;
    for (const s of r.farm_steps) {
      if (s.length < 20 || s.length > 600) return `${r.slug} has a farm step of ${s.length} characters`;
    }
  }
  return null;
}

/** The dashboard's whole dataset as one script: window.RADAR, no fetch and no network. */
export function dataScript(radar: RadarData): string {
  return `window.RADAR=${JSON.stringify(radar)};\n`;
}
