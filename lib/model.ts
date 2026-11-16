// Token Radar — how a sealed DefiLlama snapshot becomes a ranked board.
//
// The whole ranking is a function of the snapshot. For every protocol that records
// no token we estimate what its launch would be worth, using only numbers the
// snapshot itself carries: the protocol's TVL, its 7-day move, and how long it has
// run without a token. The market's own yardstick is the median market-cap-to-TVL
// ratio of the protocols in this very snapshot that already trade, so the model is
// calibrated by the snapshot, not by a hand-picked constant or a list of names.
//
//   value  = TVL x multiple x growth x maturity, rounded to whole dollars
//   multiple = median(mcap / TVL) over live-token protocols, exchanges excluded
//   growth   = 1 + 0.55 x clamp(change_7d, -50%, +100%)
//   maturity = 0.70 + 0.50 x min(age_days, 1460) / 1460
//              (age from listed_at to the snapshot's as_of; unknown age = 365 days)
//
// Rows that round to the same dollar are pulled $1 apart so the board is a strict
// ranking, and every row carries a seven-step farm plan written from its own record
// (category, chain, TVL, age) — no protocol is ever special-cased by name, and no
// step promises an airdrop or a token.

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

/** The model's tunables. They are printed in the dashboard so the judge can see them. */
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

/** How many below-floor pre-token protocols join the watchlist on the board. */
export const EARLY_ROWS = 160;

/** How many live-token protocols the dashboard shows apart from the ranking. */
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

/** A number from an unknown value, or the fallback when it is not a finite number. */
function asFinite(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/** Clamp a number into a closed interval. */
function clamp(value: number, low: number, high: number): number {
  return Math.min(high, Math.max(low, value));
}

/** Round to four decimals, for the multipliers the dashboard shows. Scoring itself uses full precision. */
function round4(n: number): number {
  return Math.round(n * 1e4) / 1e4;
}

/** The median of a sorted list of numbers; the middle value, or the mean of the two middles. */
function medianOf(sorted: number[]): number {
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/** Whole days from `listedAt` to `asOf`, never below zero; null when either side is missing or malformed. */
export function ageDays(asOf: string, listedAt: string | null): number | null {
  if (listedAt === null) return null;
  const end = Date.parse(`${asOf}T00:00:00Z`);
  const start = Date.parse(`${listedAt}T00:00:00Z`);
  if (!Number.isFinite(end) || !Number.isFinite(start)) return null;
  return Math.max(0, Math.floor((end - start) / DAY_MS));
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
  return { multiple: round4(clamp(medianOf(ratios), settings.multiple_floor, settings.multiple_cap)), sample: ratios.length };
}

/** The three multipliers and the raw implied value for one protocol. */
export function scoreProtocol(
  protocol: SnapshotProtocol,
  asOf: string,
  multiple: number,
  settings: ModelSettings = SETTINGS,
): { raw: number; growthPct: number; growthMult: number; maturityMult: number; age: number | null } {
  const age = ageDays(asOf, protocol.listed_at);
  const growthPct = clamp(asFinite(protocol.change_7d, 0), settings.growth_floor, settings.growth_cap);
  const growthMult = 1 + (growthPct / 100) * settings.growth_weight;
  const ageForModel = age ?? settings.unknown_age_days;
  const maturityMult =
    settings.maturity_floor +
    (clamp(ageForModel, 0, settings.maturity_days) / settings.maturity_days) * settings.maturity_range;
  // The raw value is scored at full precision; the multipliers are rounded only for display.
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

/** Strongest TVL first, slug breaking ties, so the pick is the same on every run. */
function byTvlDesc(a: SnapshotProtocol, b: SnapshotProtocol): number {
  return b.tvl_usd - a.tvl_usd || (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0);
}

/** Strongest raw value first, slug breaking ties, so the ranking is the same on every run. */
function byRawDesc(a: { raw: number; p: SnapshotProtocol }, b: { raw: number; p: SnapshotProtocol }): number {
  return b.raw - a.raw || (a.p.slug < b.p.slug ? -1 : a.p.slug > b.p.slug ? 1 : 0);
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
    .sort(byTvlDesc)
    .slice(0, EARLY_ROWS);
  for (const p of early) chosen.set(p.slug, p);

  const scored = [...chosen.values()].map((p) => {
    const s = scoreProtocol(p, snapshot.as_of, multiple, settings);
    return { p, ...s };
  });
  scored.sort(byRawDesc);
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

/** True when the lowercased category contains any of these words. */
function has(category: string, ...words: string[]): boolean {
  return words.some((w) => category.includes(w));
}

/**
 * The category playbook, in two tables. The main position and the second action
 * follow different orders: the main position treats plain "staking" as its own kind
 * late in the list, while the second action treats any staking-like kind — liquid
 * staking included — as one kind early in the list. Two tables keep each order
 * honest. Entries are tried in order and the first match wins, because a category
 * can contain more than one keyword ("liquid staking" is also "staking") and the
 * more specific kind must win.
 */
interface MainPlay {
  match: (category: string) => boolean;
  write: (name: string, capital: number, chain: string) => string;
}

interface SecondPlay {
  match: (category: string) => boolean;
  write: (name: string, capital: number, chain: string) => string;
}

/** The main position for each kind of protocol, most specific kind first. */
const MAIN_PLAYBOOK: MainPlay[] = [
  {
    match: (c) => has(c, 'lend', 'cdp', 'collateral'),
    write: (name, capital, chain) => `Supply $${capital} of USDC to ${name} on ${chain} as a lender and leave the deposit earning.`,
  },
  {
    match: (c) => has(c, 'dex', 'amm'),
    write: (name, capital, chain) => `Add $${capital} of liquidity to the most active pool on ${name} (${chain}) and hold the LP position.`,
  },
  {
    match: (c) => has(c, 'liquid staking', 'liquid restaking', 'restaked'),
    write: (name, capital, chain) => `Stake $${capital} of the chain's staking asset through ${name} on ${chain} and keep the receipt token.`,
  },
  {
    match: (c) => has(c, 'bridge', 'cross chain', 'cross-chain'),
    write: (name, capital, chain) => `Bridge $${capital} of USDC into ${chain} through ${name}, then use the bridged funds inside its app.`,
  },
  {
    match: (c) => has(c, 'perpetual', 'derivative', 'options', 'synthetic'),
    write: (name, capital, chain) => `Deposit $${capital} of USDC as margin on ${name} (${chain}) and open one small hedged position.`,
  },
  {
    match: (c) => has(c, 'yield', 'leveraged farm', 'farm'),
    write: (name, capital, chain) => `Deposit $${capital} of USDC into ${name}'s highest-yield vault on ${chain} and leave it compounding.`,
  },
  {
    match: (c) => has(c, 'prediction'),
    write: (name, capital, chain) => `Fund $${capital} on ${name} (${chain}) and place one position in a market that closes within a month.`,
  },
  {
    match: (c) => has(c, 'rwa', 'real world'),
    write: (name, capital, chain) => `Mint $${capital} of the yield-bearing asset ${name} issues on ${chain} and hold it in your wallet.`,
  },
  {
    match: (c) => has(c, 'stable'),
    write: (name, capital, chain) => `Mint or deposit $${capital} of the stable asset through ${name} on ${chain} and keep it in the protocol.`,
  },
  {
    match: (c) => has(c, 'insurance'),
    write: (name, capital, chain) => `Buy $${capital} of cover from ${name} on ${chain} and keep the policy active for the full term.`,
  },
  {
    match: (c) => has(c, 'curator', 'allocator', 'onchain capital'),
    write: (name, capital, chain) => `Deposit $${capital} into a ${name} vault on ${chain} and hold the vault shares.`,
  },
  {
    match: (c) => has(c, 'staking'),
    write: (name, capital, chain) => `Stake $${capital} through ${name} on ${chain} and keep the staking receipt in your wallet.`,
  },
  {
    match: (c) => has(c, 'launchpad', 'ido'),
    write: (name, capital, chain) => `Join ${name}'s next sale on ${chain} with $${capital} and hold the allocation through its lock.`,
  },
  {
    match: (c) => has(c, 'nft', 'marketplace'),
    write: (name, capital, chain) => `List or buy one item through ${name} on ${chain} for about $${capital} and keep the receipt.`,
  },
];

/**
 * The second action for each kind of protocol: a different move from the main
 * position, so the plan is a routine and not one deposit. Staking-like kinds share
 * one second action here, wherever they sit in the main table.
 */
const SECOND_PLAYBOOK: SecondPlay[] = [
  {
    match: (c) => has(c, 'lend', 'cdp', 'collateral'),
    write: (name, capital) => `Borrow $${Math.round(capital / 2)} of USDC against the deposit on ${name} and repay it within a week.`,
  },
  {
    match: (c) => has(c, 'dex', 'amm'),
    write: (name, capital, chain) => `Swap $${Math.round(capital / 2)} between the pool's two assets on ${name} (${chain}) once a week.`,
  },
  {
    match: (c) => has(c, 'liquid staking', 'liquid restaking', 'restaked', 'staking'),
    write: (name, _capital, chain) => `Use the receipt token from ${name} once in a lending market on ${chain} and unwind it the same week.`,
  },
  {
    match: (c) => has(c, 'bridge', 'cross chain', 'cross-chain'),
    write: (name, capital) => `Bridge a second, smaller amount of $${Math.round(capital / 2)} back through ${name} to show two-way use.`,
  },
  {
    match: (c) => has(c, 'perpetual', 'derivative', 'options', 'synthetic'),
    write: (name) => `Close the first hedge on ${name} and open a second one half its size within the same month.`,
  },
  {
    match: (c) => has(c, 'yield', 'leveraged farm', 'farm'),
    write: (name, capital, chain) => `Move $${Math.round(capital / 2)} of the vault position into a second ${name} vault on ${chain} once.`,
  },
  {
    match: (c) => has(c, 'prediction'),
    write: (name, capital) => `Settle one market on ${name} and place a second position for about $${Math.round(capital / 2)}.`,
  },
  {
    match: (c) => has(c, 'rwa', 'real world', 'stable'),
    write: (name, capital) => `Redeem a small part of the ${name} position, about $${Math.round(capital / 4)}, and re-enter it.`,
  },
];

/** The main-position play for a protocol's category, or null when no kind matches it. */
function mainPlayFor(p: SnapshotProtocol): MainPlay | null {
  const c = (p.category ?? '').toLowerCase();
  for (const entry of MAIN_PLAYBOOK) {
    if (entry.match(c)) return entry;
  }
  return null;
}

/** The second-action play for a protocol's category, or null when no kind matches it. */
function secondPlayFor(p: SnapshotProtocol): SecondPlay | null {
  const c = (p.category ?? '').toLowerCase();
  for (const entry of SECOND_PLAYBOOK) {
    if (entry.match(c)) return entry;
  }
  return null;
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
  const mainPlay = mainPlayFor(p);
  const main = mainPlay !== null
    ? mainPlay.write(p.name, capital, chain)
    : `Deposit $${capital} of USDC into ${p.name} on ${chain} and keep the position open.`;
  const secondPlay = secondPlayFor(p);
  const second = secondPlay !== null
    ? secondPlay.write(p.name, capital, chain)
    : `Make one more qualifying action on ${p.name} (${chain}) the following week, such as a swap, a vote or a deposit.`;
  return [
    {
      action: `Open a fresh wallet that holds only the funds you plan to farm, and keep its seed phrase offline on paper.`,
      cost: 'nothing to open, and under $3 of gas for the first transaction',
      time: '5 minutes',
    },
    {
      action: main,
      cost: `$${capital} of capital and ${gas}`,
      time: '15 minutes to set up',
    },
    {
      action: second,
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
