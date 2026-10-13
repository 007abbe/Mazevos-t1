/**
 * Account goals and prop-firm rules: where an account stands against them.
 *
 * The rules are stored on the account (see the account_goals migration); every
 * number here is derived from the trades on it, so nothing can drift out of
 * date. Pure: no Supabase, no DOM.
 *
 * Measured on realised P&L, by trading day, which is what the journal knows. A
 * firm measures intraday drawdown on *open* P&L as well, so "breached" here
 * means the closed trades alone crossed the floor — a real account can breach
 * earlier, never later. The panel says so.
 */

export const DRAWDOWN_TYPES = [
  { value: 'eod', label: 'EOD trailing' },
  { value: 'intraday', label: 'Intraday trailing' },
  { value: 'static', label: 'Static' },
]

/** What the trader sets by hand. Null in the column reads as active. */
export const ACCOUNT_STATUSES = ['active', 'passed', 'failed', 'retired']

export const STATUS_LABELS = {
  active: 'Active',
  passed: 'Passed',
  failed: 'Failed',
  retired: 'Retired',
}

/** The numeric rule columns, in form order. `firm`, `drawdown_type` and `status` are text. */
export const GOAL_NUMBERS = [
  'account_size',
  'profit_target',
  'max_drawdown',
  'drawdown_lock',
  'daily_loss_limit',
  'consistency_pct',
  'min_days',
  'monthly_goal',
]

/**
 * Presets fill the form; every field stays editable afterwards, and nothing
 * remembers which preset was used. Firms change these often — they are the
 * published rules as of October 2026, to check against your dashboard.
 *
 * `drawdown_lock` is the balance the trailing floor stops at: Topstep's stops
 * at the starting balance, Lucid's at starting balance + $100.
 */
export const PROP_PRESETS = [
  {
    id: 'lucid-flex-25k',
    label: 'Lucid Flex 25K',
    firm: 'Lucid',
    account_size: 25000,
    profit_target: 1250,
    max_drawdown: 1000,
    drawdown_type: 'eod',
    drawdown_lock: 25100,
    daily_loss_limit: null,
    consistency_pct: 50,
    min_days: null,
  },
  {
    id: 'lucid-pro-25k',
    label: 'Lucid Pro 25K',
    firm: 'Lucid',
    account_size: 25000,
    profit_target: 1250,
    max_drawdown: 1000,
    drawdown_type: 'eod',
    drawdown_lock: 25100,
    daily_loss_limit: null,
    consistency_pct: null,
    min_days: null,
  },
  ...[
    [50000, 3000, 2000],
    [100000, 6000, 3000],
    [150000, 9000, 4500],
  ].map(([size, target, dd]) => ({
    id: `topstep-${size / 1000}k`,
    label: `Topstep ${size / 1000}K Combine`,
    firm: 'Topstep',
    account_size: size,
    profit_target: target,
    max_drawdown: dd,
    drawdown_type: 'eod',
    drawdown_lock: size,
    // None on TopstepX accounts since Aug 2024; legacy platforms still have one.
    daily_loss_limit: null,
    consistency_pct: 50,
    min_days: null,
  })),
]

const num = (v) => {
  if (v === null || v === undefined || v === '') return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

/**
 * Form values -> column values. Blank is null, never 0: a 0 daily loss limit
 * would breach on the first red day, and a 0 target would read as passed.
 */
export function normaliseGoals(draft = {}) {
  const out = {}
  for (const key of GOAL_NUMBERS) out[key] = num(draft[key])
  if (out.min_days !== null) out.min_days = Math.round(out.min_days)
  out.firm = String(draft.firm ?? '').trim() || null
  out.drawdown_type = DRAWDOWN_TYPES.some((d) => d.value === draft.drawdown_type) ? draft.drawdown_type : null
  out.status = ACCOUNT_STATUSES.includes(draft.status) && draft.status !== 'active' ? draft.status : null
  return out
}

/** An error message for the form, or null when the goals are saveable. */
export function validateGoals(draft = {}) {
  const g = normaliseGoals(draft)
  for (const key of GOAL_NUMBERS) {
    if (g[key] !== null && g[key] < 0) return 'Rules cannot be negative'
  }
  if (g.consistency_pct !== null && (g.consistency_pct <= 0 || g.consistency_pct > 100)) {
    return 'Consistency is a percent between 1 and 100'
  }
  if (g.max_drawdown !== null && g.account_size === null) {
    return 'A drawdown needs a starting balance to measure from'
  }
  if (g.max_drawdown !== null && g.max_drawdown > 0 && !g.drawdown_type) return 'Pick how the drawdown moves'
  return null
}

/** True when an account carries any rule worth showing progress for. */
export const hasGoals = (account) =>
  !!account && GOAL_NUMBERS.some((k) => num(account[k]) !== null && num(account[k]) > 0)

const dayOf = (t) => String(t.date ?? '').slice(0, 10)

/**
 * Where an account stands.
 *
 * @param {object} account with the rule columns
 * @param {object[]} trades that account's executed trades (no vetoes)
 * @param {string} [thisMonth] `YYYY-MM`, for the personal monthly goal
 */
export function accountProgress(account = {}, trades = [], thisMonth = null) {
  const size = num(account.account_size)
  const target = num(account.profit_target)
  const dd = num(account.max_drawdown)
  const lock = num(account.drawdown_lock)
  const dll = num(account.daily_loss_limit)
  const pct = num(account.consistency_pct)
  const minDays = num(account.min_days)
  const monthlyGoal = num(account.monthly_goal)
  const ddType = account.drawdown_type || 'eod'

  const closed = trades
    .filter((t) => num(t.pnl) !== null && dayOf(t))
    .sort((a, b) => String(a.date).localeCompare(String(b.date)))

  // Per-day P&L, in day order.
  const dayPnl = new Map()
  for (const t of closed) dayPnl.set(dayOf(t), (dayPnl.get(dayOf(t)) ?? 0) + num(t.pnl))
  const days = [...dayPnl.entries()]

  const net = closed.reduce((a, t) => a + num(t.pnl), 0)
  const balance = size === null ? null : size + net

  // ---- Drawdown: walk the balance, trailing the floor behind its peak. ----
  let floor = null
  let breachedOn = null
  let lowestBuffer = null
  const curve = []

  if (size !== null) {
    const floorFor = (peak) => {
      if (dd === null) return null
      if (ddType === 'static') return size - dd
      const trailing = peak - dd
      return lock === null ? trailing : Math.min(trailing, lock)
    }

    let peak = size
    let running = size
    floor = floorFor(peak)

    // Intraday trails every closed trade; EOD and static only look at the close.
    const steps =
      ddType === 'intraday'
        ? closed.map((t) => ({ day: dayOf(t), pnl: num(t.pnl) }))
        : days.map(([day, pnl]) => ({ day, pnl }))

    for (const { day, pnl } of steps) {
      running += pnl
      if (floor !== null) {
        const buffer = running - floor
        if (lowestBuffer === null || buffer < lowestBuffer) lowestBuffer = buffer
        if (breachedOn === null && running <= floor) breachedOn = day
      }
      peak = Math.max(peak, running)
      floor = floorFor(peak)
      const last = curve[curve.length - 1]
      if (last?.day === day) Object.assign(last, { balance: running, floor })
      else curve.push({ day, balance: running, floor })
    }
  }

  // ---- Daily loss limit ----
  const worstDay = days.length ? Math.min(...days.map(([, p]) => p)) : null
  const bestDay = days.length ? Math.max(...days.map(([, p]) => p)) : null
  const dllHits = dll ? days.filter(([, p]) => p <= -dll).map(([d]) => d) : []

  // ---- Consistency: the best day may be at most pct% of total profit. ----
  // Exceeding it does not fail the account, it raises the target to what the
  // best day would need to be pct% of — Topstep's wording and Lucid's.
  const consistency = pct && net > 0 && bestDay > 0 ? (bestDay / net) * 100 : null
  const consistent = pct === null || consistency === null || consistency <= pct
  const requiredTarget =
    target === null ? null : pct && bestDay > 0 ? Math.max(target, bestDay / (pct / 100)) : target

  const tradingDays = days.length
  const daysMet = minDays === null || tradingDays >= minDays
  const targetHit = requiredTarget !== null && net >= requiredTarget

  const monthPnl = thisMonth ? days.filter(([d]) => d.startsWith(thisMonth)).reduce((a, [, p]) => a + p, 0) : null

  let state = 'tracking'
  if (breachedOn) state = 'breached'
  else if (targetHit && daysMet) state = 'target-hit'

  return {
    state,
    size,
    net,
    balance,
    target,
    requiredTarget,
    toTarget: requiredTarget === null ? null : Math.max(0, requiredTarget - net),
    targetProgress: requiredTarget ? Math.max(0, Math.min(1, net / requiredTarget)) : null,
    floor,
    buffer: balance !== null && floor !== null ? balance - floor : null,
    drawdownUsed: dd && balance !== null && floor !== null ? Math.max(0, Math.min(1, 1 - (balance - floor) / dd)) : null,
    floorLocked: lock !== null && floor !== null && ddType !== 'static' && floor >= lock,
    lowestBuffer,
    breachedOn,
    dailyLossLimit: dll,
    dllHits,
    worstDay,
    bestDay,
    consistencyPct: pct,
    consistency,
    consistent,
    tradingDays,
    minDays,
    daysMet,
    monthlyGoal,
    monthPnl,
    curve,
  }
}

/** The status to badge an account with: a hand-set lifecycle wins over the computed state. */
export function accountBadgeState(account, progress) {
  if (account?.status && account.status !== 'active') return account.status
  if (progress?.state === 'breached') return 'breached'
  if (progress?.state === 'target-hit') return 'target-hit'
  return 'active'
}

export const BADGE_LABELS = {
  active: 'Active',
  passed: 'Passed',
  failed: 'Failed',
  retired: 'Retired',
  breached: 'Breached',
  'target-hit': 'Target hit',
}
