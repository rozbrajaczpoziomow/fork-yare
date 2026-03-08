// ============================================================
//  Clowder Bot — each cat has its own mind (and name)
// ============================================================

const PEW_RANGE = 200;
const MOVE_SPEED = 20;
const PEW_RANGE_NEXT_TICK = PEW_RANGE + MOVE_SPEED;  // 220 — can pew after 1 tick of movement
const POTENTIAL_THREAT_RANGE = PEW_RANGE_NEXT_TICK + MOVE_SPEED;  // 240 — enemies within this could move into pew range next tick
const SURROUND_RADIUS = 270;   // hold >260 during setup
const SURROUND_STRIKE_RANGE = 220;  // within 220 → can cross pew (200) in 1 tick
const SURROUND_SAFE_FROM_OTHERS = 250;  // keep 250+ from non-target enemies when positioning
const STALL_WINDOW = 10;       // ticks to observe — trigger spread sooner
const STALL_THRESHOLD = 60;    // max centroid drift — detect standoffs earlier

// ----- Geometry helpers -----

function dist(a, b) {
    const dx = a[0] - b[0];
    const dy = a[1] - b[1];
    return Math.sqrt(dx * dx + dy * dy);
}

function distSq(a, b) {
    const dx = a[0] - b[0];
    const dy = a[1] - b[1];
    return dx * dx + dy * dy;
}

function towards(from, to, amount) {
    const d = dist(from, to);
    if (d <= amount) return to;
    const ratio = amount / d;
    return [
        from[0] + (to[0] - from[0]) * ratio,
        from[1] + (to[1] - from[1]) * ratio,
    ];
}

function away(from, threat, amount) {
    const d = dist(from, threat);
    if (d === 0) return [from[0] + amount, from[1]];
    const ratio = amount / d;
    return [
        from[0] + (from[0] - threat[0]) * ratio,
        from[1] + (from[1] - threat[1]) * ratio,
    ];
}

const MAX_RETREAT_FROM_TEAM = 400;

function safeRetreat(cat, threatPos, amount) {
    const amt = amount ?? 25;
    const ours = aliveOf(my_cats);
    if (ours.length <= 1) return away(cat.position, threatPos, amt);
    const teamCenter = centroid(ours.filter(c => c.id !== cat.id).map(c => c.position));
    const distFromTeam = dist(cat.position, teamCenter);
    if (distFromTeam > MAX_RETREAT_FROM_TEAM) {
        return towards(cat.position, teamCenter, Math.min(amt, 50));
    }
    return away(cat.position, threatPos, amt);
}

function centroid(positions) {
    let sx = 0, sy = 0;
    for (const p of positions) { sx += p[0]; sy += p[1]; }
    return [sx / positions.length, sy / positions.length];
}

// ----- Entity query helpers -----

function aliveOf(list) {
    return list.filter(c => c.hp > 0);
}

function livingEnemies() {
    const out = [];
    for (const id in cats) {
        const c = cats[id];
        if (c.player_id !== this_player_id && c.hp > 0) out.push(c);
    }
    return out;
}

function energyDiff() {
    let ours = 0, theirs = 0;
    for (const id in cats) {
        const c = cats[id];
        if (c.hp === 0) continue;
        if (c.player_id === this_player_id) ours += c.energy;
        else theirs += c.energy;
    }
    return ours - theirs;
}

function energyAdvantageRatio() {
    let ours = 0, theirs = 0;
    for (const id in cats) {
        const c = cats[id];
        if (c.hp === 0) continue;
        if (c.player_id === this_player_id) ours += c.energy;
        else theirs += c.energy;
    }
    const total = ours + theirs;
    if (total === 0) return 0;
    return (ours - theirs) / total;
}

function endgameState() {
    let ours = 0, theirs = 0;
    for (const id in cats) {
        const c = cats[id];
        if (c.hp === 0) continue;
        if (c.player_id === this_player_id) ours++;
        else theirs++;
    }
    if (ours <= 2 && theirs >= ours + 2) return 'losing';
    if (theirs <= 2 && ours >= theirs + 2) return 'winning';
    const diff = energyDiff();
    if (diff <= -50) return 'losing';
    if (diff >= 50) return 'winning';
    return null;
}

function enemiesInRange(pos, range) {
    let count = 0;
    for (const e of livingEnemies()) {
        if (dist(pos, e.position) <= range) count++;
    }
    return count;
}

function friendsInRange(pos, range) {
    let count = 0;
    for (const c of aliveOf(my_cats)) {
        if (dist(pos, c.position) <= range) count++;
    }
    return count;
}

function aggressionMod() {
    const diff = energyDiff();
    if (diff > 30) return -25;
    if (diff > 15) return -15;
    if (diff > 0)  return -5;
    if (diff > -15) return 5;
    if (diff > -30) return 15;
    return 25;
}

function closestTo(pos, list) {
    let best = null, bestD = Infinity;
    for (const c of list) {
        const d = distSq(pos, c.position);
        if (d < bestD) { bestD = d; best = c; }
    }
    return best;
}

function weakestOf(list) {
    let best = null, bestE = Infinity;
    for (const c of list) {
        if (c.energy < bestE) { bestE = c.energy; best = c; }
    }
    return best;
}

function pewableEnemies(cat) {
    return (cat.sight.enemies_pewable || []).map(id => cats[id]).filter(c => c && c.hp > 0);
}

function pewableFriends(cat) {
    return (cat.sight.friends_pewable || []).map(id => cats[id]).filter(c => c && c.hp > 0);
}

// ----- Map helpers -----

function nearestPod(pos) {
    let best = pods[0], bestD = distSq(pos, pods[0]);
    for (let i = 1; i < pods.length; i++) {
        const d = distSq(pos, pods[i]);
        if (d < bestD) { bestD = d; best = pods[i]; }
    }
    return best;
}

function isOnPod(pos) {
    for (const p of pods) {
        if (Math.abs(pos[0] - p[0]) <= 20 && Math.abs(pos[1] - p[1]) <= 20) return true;
    }
    return false;
}

function nearestSafePod(pos, safeRange) {
    const range = safeRange ?? 200;
    let best = null, bestD = Infinity;
    for (const p of pods) {
        if (enemiesInRange(p, range) > 0) continue;
        const d = distSq(pos, p);
        if (d < bestD) { bestD = d; best = p; }
    }
    return best;
}

function isOutsideCircle(pos) {
    return dist(pos, [0, 0]) > death_circle;
}

// ============================================================
//  Cat identities & roles
// ============================================================

const ROLES = {
    'Shadow':   'support',
    'Luna':     'aggro',
    'Pouncer':  'aggro',
    'Fikyou':   'aggro',
    'Ziggy':    'crazy',
    'Hilli':    'healer',
    'Whiskers': 'healer',
    'Claw':     'connector',
    'Scar':     'connector',
};

const CAT_NAMES = [
    'Whiskers', 'Shadow', 'Luna', 'Hilli', 'Pouncer',
    'Ziggy', 'Fikyou', 'Scar', 'Claw',
];

if (!memory.initialized) {
    memory.initialized = true;
    memory.cats = {};
    memory.mourning = {};
    memory.stallHistory = { our: [], theirs: [] };
    memory.surround = null;
    for (let i = 0; i < my_cats.length; i++) {
        const name = CAT_NAMES[i] || ('Cat' + i);
        memory.cats[my_cats[i].id] = {
            name: name,
            index: i,
            role: ROLES[name] || 'default',
        };
    }
}

function identity(cat) {
    return memory.cats[cat.id];
}

function catByName(name) {
    for (const c of my_cats) {
        const me = identity(c);
        if (me && me.name === name && c.hp > 0) return c;
    }
    return null;
}

function catsByRole(role) {
    return my_cats.filter(c => {
        const me = identity(c);
        return me && me.role === role && c.hp > 0;
    });
}

// ============================================================
//  Smart Pew Ledger — coordinate fire, avoid overkill
//
//  Each tick we snapshot every enemy's energy into pewLedger.
//  When a cat claims a pew, the ledger decrements by 2 (the
//  damage dealt).  Cats skip enemies whose projected energy is
//  already ≤ −1 so no extra shots are wasted.  Sorting by
//  projected energy focuses fire on the weakest targets first.
// ============================================================

const pewLedger = {};

function initLedger() {
    for (const e of livingEnemies()) {
        pewLedger[e.id] = e.energy;
    }
}

function aoeNeighbors(target) {
    let count = 0;
    for (const e of livingEnemies()) {
        if (e.id !== target.id && dist(e.position, target.position) <= 20) count++;
    }
    return count;
}

function pickPewTarget(cat) {
    const targets = pewableEnemies(cat);
    if (targets.length === 0 || cat.energy <= 0) return null;

    let best = null, bestAoe = -1, bestProj = Infinity;
    for (const t of targets) {
        const projected = pewLedger[t.id];
        if (projected === undefined || projected <= -1) continue;
        const aoe = aoeNeighbors(t);
        if (aoe > bestAoe || (aoe === bestAoe && projected < bestProj)) {
            best = t;
            bestAoe = aoe;
            bestProj = projected;
        }
    }
    return best;
}

function commitPew(cat, target) {
    cat.pew(target);
    if (pewLedger[target.id] !== undefined) {
        pewLedger[target.id] -= 2;
    }
    const tid = String(target.id);
    for (const id in pewLedger) {
        if (id === tid) continue;
        const e = cats[id];
        if (e && e.hp > 0 && dist(e.position, target.position) <= 20) {
            pewLedger[id] -= 2;
        }
    }
}

// ============================================================
//  Aggro trio coordination
// ============================================================

function aggroSharedTarget() {
    const trio = catsByRole('aggro');
    const enemies = livingEnemies();
    if (trio.length === 0 || enemies.length === 0) return null;
    const center = centroid(trio.map(c => c.position));

    // Prefer isolated targets (surgical strike) — enemy with fewest nearby allies
    let best = null, bestScore = -Infinity;
    for (const e of enemies) {
        const nearbyAllies = enemies.filter(o => o.id !== e.id && dist(o.position, e.position) <= 80).length;
        const isolation = 10 - nearbyAllies;  // higher = more isolated
        const distFromUs = -dist(center, e.position) / 100;  // prefer closer
        const score = isolation * 2 + distFromUs;
        if (score > bestScore) { bestScore = score; best = e; }
    }
    return best || closestTo(center, enemies);
}

// Engagement analysis: count cats that can participate in a fight (this or next tick).
// Pew range 200, move 20/tick → within 220 can pew after at most 1 tick.
function engagementCounts(target) {
    if (!target) return { ours: 0, theirs: 0, safeToStrike: false };
    const friends = aliveOf(my_cats);
    const enemies = livingEnemies();

    const ourEngagers = friends.filter(f => dist(f.position, target.position) <= PEW_RANGE_NEXT_TICK);
    const enemyInZone = enemies.filter(e => dist(e.position, target.position) <= PEW_RANGE_NEXT_TICK);

    const ours = ourEngagers.length;
    const theirs = enemyInZone.length;

    // Don't strike if outnumbered or even
    if (ours <= theirs) return { ours, theirs, safeToStrike: false };

    // Check "under fire next tick": when we advance, would our cats get focus-fired?
    // For each engager, count enemies that could pew them (within 220 of that cat).
    // If any cat would have more enemies on them than allies nearby, don't risk it.
    let safeToStrike = true;
    for (const f of ourEngagers) {
        const enemiesOnMe = enemies.filter(e => dist(e.position, f.position) <= PEW_RANGE_NEXT_TICK);
        const alliesOnMe = friends.filter(a => a.id !== f.id && dist(a.position, f.position) <= PEW_RANGE_NEXT_TICK);
        if (enemiesOnMe.length > alliesOnMe.length) {
            safeToStrike = false;
            break;
        }
    }

    return { ours, theirs, safeToStrike };
}

function hasEnergyAdvantage() {
    const ours = aliveOf(my_cats);
    const theirs = livingEnemies();
    const ourEnergy = ours.reduce((s, c) => s + c.energy, 0);
    const theirEnergy = theirs.reduce((s, e) => s + e.energy, 0);
    return ourEnergy > theirEnergy;
}

/** True when we have numbers (>= theirs) and more total energy — go for it! */
function hasMajorityAdvantage() {
    const ours = aliveOf(my_cats);
    const theirs = livingEnemies();
    return ours.length >= theirs.length && hasEnergyAdvantage();
}

function teamCanEngage(target) {
    if (!target) return false;
    const { ours, theirs, safeToStrike } = engagementCounts(target);
    if (ours > theirs && safeToStrike) return true;
    if (ours >= theirs && hasEnergyAdvantage()) return true;
    return false;
}

// ============================================================
//  Surround plan — break stalls by circling a target, then striking
// ============================================================

function updateStallHistory() {
    const ours = aliveOf(my_cats);
    const theirs = livingEnemies();
    if (ours.length === 0 || theirs.length === 0) return;
    const ourCentroid = centroid(ours.map(c => c.position));
    const theirCentroid = centroid(theirs.map(e => e.position));
    memory.stallHistory.our.push(ourCentroid);
    memory.stallHistory.theirs.push(theirCentroid);
    if (memory.stallHistory.our.length > STALL_WINDOW) {
        memory.stallHistory.our.shift();
        memory.stallHistory.theirs.shift();
    }
}

function isStalling() {
    const our = memory.stallHistory.our;
    const theirs = memory.stallHistory.theirs;
    if (our.length < STALL_WINDOW || theirs.length < STALL_WINDOW) return false;
    let ourMaxDrift = 0, theirMaxDrift = 0;
    for (let i = 0; i < our.length; i++) {
        for (let j = i + 1; j < our.length; j++) {
            ourMaxDrift = Math.max(ourMaxDrift, dist(our[i], our[j]));
            theirMaxDrift = Math.max(theirMaxDrift, dist(theirs[i], theirs[j]));
        }
    }
    return ourMaxDrift < STALL_THRESHOLD && theirMaxDrift < STALL_THRESHOLD;
}

function isPositionSafeFromEnemyFire(pos) {
    for (const e of livingEnemies()) {
        if (dist(pos, e.position) <= PEW_RANGE_NEXT_TICK) return false;
    }
    return true;
}

/** Predict potential focus-fire: enemies that could move into pew range (220) next tick.
 *  Returns { threatCenter } if we should retreat, else null.
 *  Don't retreat when we have majority + energy advantage — go for it! */
function predictPotentialFocusFire(cat) {
    if (hasMajorityAdvantage()) return null;
    const enemies = livingEnemies();
    const inPewRange = enemies.filter(e => dist(cat.position, e.position) < PEW_RANGE_NEXT_TICK);
    const potentialThreats = enemies.filter(e => dist(cat.position, e.position) < POTENTIAL_THREAT_RANGE);
    if (inPewRange.length >= 2) {
        return { threatCenter: centroid(inPewRange.map(e => e.position)) };
    }
    if (potentialThreats.length < 2) return null;
    const alliesHere = friendsInRange(cat.position, 280);
    if (alliesHere >= potentialThreats.length) return null;
    return { threatCenter: centroid(potentialThreats.map(e => e.position)) };
}

/** Position is 250+ from all enemies except the surround target (for safe positioning). */
function isPositionSafeFromOtherEnemies(pos, excludeTargetId, minDist) {
    const d = minDist ?? SURROUND_SAFE_FROM_OTHERS;
    for (const e of livingEnemies()) {
        if (e.id === excludeTargetId) continue;
        if (dist(pos, e.position) < d) return false;
    }
    return true;
}

/** Prefer enemies at the EDGE of their formation (weak points), not the center. */
function weakPointTarget() {
    const enemies = livingEnemies();
    if (enemies.length === 0) return null;
    const enemyCenter = centroid(enemies.map(e => e.position));
    let best = null, bestScore = Infinity;
    for (const e of enemies) {
        const nearbyAllies = enemies.filter(o => o.id !== e.id && dist(o.position, e.position) <= 120).length;
        const distFromCenter = dist(e.position, enemyCenter);
        // Prefer fewer nearby allies (edge) and further from formation center (edge)
        const score = nearbyAllies * 100 - distFromCenter;
        if (score < bestScore) { bestScore = score; best = e; }
    }
    return best;
}

function surroundTarget() {
    return weakPointTarget();
}

function getSurroundPositions(target, radius) {
    const [tx, ty] = target.position;
    const r = radius ?? SURROUND_RADIUS;
    return [
        [tx + r, ty],
        [tx, ty + r],
        [tx - r, ty],
        [tx, ty - r],
    ];
}

function getClosingPosition(catPos, targetPos) {
    const d = dist(catPos, targetPos);
    if (d <= SURROUND_STRIKE_RANGE) return catPos;
    const ratio = SURROUND_STRIKE_RANGE / d;
    return [
        targetPos[0] + (catPos[0] - targetPos[0]) * ratio,
        targetPos[1] + (catPos[1] - targetPos[1]) * ratio,
    ];
}

function pickSurroundCats(target) {
    const positions = getSurroundPositions(target);
    const candidates = aliveOf(my_cats).filter(c => {
        const me = identity(c);
        return me && (me.role === 'aggro' || me.role === 'support' || me.role === 'connector'
            || me.name === 'Ziggy');
    });
    if (candidates.length < 4) return [];
    const assigned = [];
    const used = new Set();
    for (let i = 0; i < 4; i++) {
        let best = null, bestDist = Infinity;
        for (let j = 0; j < candidates.length; j++) {
            if (used.has(j)) continue;
            const d = dist(candidates[j].position, positions[i]);
            if (d < bestDist) { bestDist = d; best = j; }
        }
        if (best !== null) {
            used.add(best);
            assigned.push({ catId: candidates[best].id, position: positions[i], slot: i });
        }
    }
    return assigned;
}

function thinkSurround(cat, me) {
    const s = memory.surround;
    if (!s || !s.targetId) return false;
    const target = cats[s.targetId];
    if (!target || target.hp <= 0) {
        memory.surround = null;
        return false;
    }
    const mySlot = s.assignments.find(a => a.catId === cat.id);
    if (!mySlot) return false;

    if (s.phase === 'strike') {
        cat.set_mark('strike!');
        cat.move(target.position);
        return true;
    }

    if (s.phase === 'closing') {
        const closePos = getClosingPosition(cat.position, target.position);
        const safeFromOthers = livingEnemies().every(e => {
            if (e.id === target.id) return true;
            return dist(closePos, e.position) > PEW_RANGE_NEXT_TICK;
        });
        if (!safeFromOthers) {
            const threat = livingEnemies().find(e => e.id !== target.id && dist(closePos, e.position) <= PEW_RANGE_NEXT_TICK);
            if (threat) cat.move(safeRetreat(cat, threat.position, 25));
            else cat.move(mySlot.position);
            return true;
        }
        cat.set_mark('closing');
        cat.move(closePos);
        return true;
    }

    if (!isPositionSafeFromEnemyFire(mySlot.position)) {
        const threat = closestTo(mySlot.position, livingEnemies());
        if (threat) cat.move(safeRetreat(cat, threat.position, 20));
        return true;
    }
    // Keep 250+ from other enemies when moving to surround slot
    if (!isPositionSafeFromOtherEnemies(mySlot.position, target.id)) {
        const threat = livingEnemies().find(e => e.id !== target.id && dist(mySlot.position, e.position) < SURROUND_SAFE_FROM_OTHERS);
        if (threat) cat.move(safeRetreat(cat, threat.position, 25));
        return true;
    }
    cat.set_mark('surround');
    cat.move(mySlot.position);
    return true;
}

/** Move toward weak point to set up surround when we can't strike. Returns true if moved. */
function doSurroundApproach(cat, me) {
    if (!me || (me.role !== 'aggro' && me.role !== 'support' && me.role !== 'connector' && me.name !== 'Ziggy')) return false;
    const lowEnergy = cat.energy < 5 || cat.energy < cat.energy_capacity * 0.3;
    if (lowEnergy) return false;
    const weak = weakPointTarget();
    if (!weak || teamCanEngage(weak)) return false;
    const spreadAngle = me ? (me.index % 3 - 1) * 0.2 : 0;
    const dx = weak.position[0] - cat.position[0];
    const dy = weak.position[1] - cat.position[1];
    const baseAngle = Math.atan2(dy, dx) + spreadAngle;
    const step = 20;
    let approachPos = [
        cat.position[0] + Math.cos(baseAngle) * step,
        cat.position[1] + Math.sin(baseAngle) * step,
    ];
    const others = livingEnemies().filter(e => e.id !== weak.id);
    for (const o of others) {
        if (dist(approachPos, o.position) < SURROUND_SAFE_FROM_OTHERS) {
            const awayDir = [approachPos[0] - o.position[0], approachPos[1] - o.position[1]];
            const len = Math.sqrt(awayDir[0] ** 2 + awayDir[1] ** 2) || 1;
            approachPos = [
                o.position[0] + (awayDir[0] / len) * SURROUND_SAFE_FROM_OTHERS,
                o.position[1] + (awayDir[1] / len) * SURROUND_SAFE_FROM_OTHERS,
            ];
            break;
        }
    }
    cat.move(approachPos);
    return true;
}

function maybeStartSurround() {
    if (memory.surround) return;
    if (endgameState()) return;
    const target = weakPointTarget();
    if (!target || isOnPod(target.position)) return;
    // Only start surround when we can't strike — striking is always the priority
    if (teamCanEngage(target)) return;
    const positions = getSurroundPositions(target, SURROUND_RADIUS);
    if (!positions.every(p => isPositionSafeFromEnemyFire(p))) return;
    // Require pew-safe (220) from others to start; we'll keep 250+ when moving
    if (!positions.every(p => isPositionSafeFromOtherEnemies(p, target.id, PEW_RANGE_NEXT_TICK))) return;
    const assignments = pickSurroundCats(target);
    if (assignments.length < 4) return;
    memory.surround = {
        targetId: target.id,
        phase: 'positioning',
        assignments: assignments,
        readyCount: 0,
    };
}

function updateSurroundPhase() {
    const s = memory.surround;
    if (!s) return;
    const target = cats[s.targetId];
    if (!target || target.hp <= 0) {
        memory.surround = null;
        return;
    }
    let aliveCount = 0;
    for (const a of s.assignments) {
        const c = cats[a.catId];
        if (c && c.hp > 0) aliveCount++;
    }
    if (aliveCount < 3) {
        memory.surround = null;
        return;
    }
    if (s.phase === 'strike') return;

    if (s.phase === 'positioning') {
        let ready = 0;
        for (const a of s.assignments) {
            const c = cats[a.catId];
            if (!c || c.hp <= 0) continue;
            if (dist(c.position, a.position) <= 40) ready++;
        }
        if (ready >= aliveCount) {
            s.phase = 'closing';
        }
        return;
    }

    if (s.phase === 'closing') {
        let allCanStrike = true;
        for (const a of s.assignments) {
            const c = cats[a.catId];
            if (!c || c.hp <= 0) continue;
            if (dist(c.position, target.position) > SURROUND_STRIKE_RANGE) {
                allCanStrike = false;
                break;
            }
        }
        if (allCanStrike) {
            s.phase = 'strike';
        }
    }
}

// ============================================================
//  Role behaviours
// ============================================================

// --- Shadow: Luna's bodyguard ---

function thinkShadow(cat) {
    const luna = catByName('Luna');
    if (!luna) { thinkDefault(cat); return; }

    const enemies = livingEnemies();
    const adj = aggressionMod();
    const closestEnemy = closestTo(cat.position, enemies);
    const podBonus = (closestEnemy && isOnPod(closestEnemy.position)) ? 20 : 0;
    const nearbyEnemies = enemiesInRange(cat.position, 225 + adj + podBonus);
    const alliesHere = friendsInRange(cat.position, 265);

    if (nearbyEnemies >= 2 && alliesHere <= nearbyEnemies) {
        const healers = catsByRole('healer');
        const retreatPoint = healers.length > 0
            ? centroid(healers.map(c => c.position))
            : nearestPod(cat.position);
        cat.move(retreatPoint);
        return;
    }

    if (enemies.length > 0) {
        const threat = closestTo(luna.position, enemies);
        if (threat) {
            const behindDist = Math.max(25, 50 + adj + podBonus);
            cat.move(away(luna.position, threat.position, behindDist));
            return;
        }
    }
    cat.move(luna.position);
}

// --- Aggro trio: Luna, Pouncer, Fikyou ---

function thinkAggro(cat) {
    const enemies = livingEnemies();
    if (enemies.length === 0) { cat.move([0, 0]); return; }

    const closest = closestTo(cat.position, enemies);
    const closestDist = closest ? dist(cat.position, closest.position) : Infinity;

    const inKillZone   = enemiesInRange(cat.position, 200);
    const inDangerZone = enemiesInRange(cat.position, 260);
    const alliesHere   = friendsInRange(cat.position, 280);
    const adj = aggressionMod();

    // How many nearby enemies are clustered (AOE-vulnerable)?
    const nearby = enemies.filter(e => dist(cat.position, e.position) < 260);
    let clustered = 0;
    for (const e of nearby) {
        for (const other of nearby) {
            if (other.id !== e.id && dist(e.position, other.position) <= 20) {
                clustered++;
                break;
            }
        }
    }
    const effectiveThreats = Math.max(1, inDangerZone - Math.floor(clustered / 2));

    // RETREAT when in pew range and engagement is unfavorable (unless we have majority + energy advantage)
    if (inKillZone >= 2 && clustered === 0 && closest && !teamCanEngage(closest) && !hasMajorityAdvantage()) {
        const healers = catsByRole('healer');
        const retreatPoint = healers.length > 0
            ? centroid(healers.map(c => c.position))
            : nearestPod(cat.position);
        cat.move(retreatPoint);
        return;
    }

    // FLEE only when outnumbered AND enemies are spread out (unless we have majority + energy advantage)
    if (!hasMajorityAdvantage() && effectiveThreats >= 3 && alliesHere < effectiveThreats) {
        const threatCenter = centroid(nearby.map(e => e.position));
        cat.move(safeRetreat(cat, threatCenter, 100));
        return;
    }

    // TEAM ENGAGE: if the team has converged and has numbers, strike
    // (skip if target is camping a pod — let the circle flush them out)
    const sharedTarget = aggroSharedTarget();
    if (sharedTarget && (teamCanEngage(sharedTarget) || hasMajorityAdvantage()) && !isOnPod(sharedTarget.position)) {
        const d = dist(cat.position, sharedTarget.position);
        if (d > PEW_RANGE) {
            cat.move(sharedTarget.position);
        } else {
            const pred = predictPotentialFocusFire(cat);
            if (pred) {
                cat.move(safeRetreat(cat, pred.threatCenter, 35));
            } else {
                cat.move(away(cat.position, sharedTarget.position, 20));
            }
        }
        return;
    }

    // STALK MODE — use effectiveThreats for distance decisions
    const myTarget = closestTo(cat.position, enemies);
    if (!myTarget) return;

    const podBonus = isOnPod(myTarget.position) ? 20 : 0;
    let minSafe, maxSafe;
    if (alliesHere > effectiveThreats) {
        minSafe = 205 + adj + podBonus; maxSafe = 235 + adj + podBonus;
    } else if (alliesHere >= effectiveThreats) {
        minSafe = 225 + adj + podBonus; maxSafe = 255 + adj + podBonus;
    } else {
        minSafe = 250 + adj + podBonus; maxSafe = 280 + adj + podBonus;
    }

    if (closestDist < minSafe) {
        if (hasMajorityAdvantage()) {
            const target = (sharedTarget && !isOnPod(sharedTarget.position)) ? sharedTarget : myTarget;
            cat.move(target.position);
        } else {
            cat.move(safeRetreat(cat, closest.position, 100));
        }
    } else if (dist(cat.position, myTarget.position) > maxSafe) {
        const { safeToStrike } = engagementCounts(myTarget);
        if (safeToStrike || hasMajorityAdvantage()) {
            const me = identity(cat);
            const spreadAngle = me ? (me.index % 3 - 1) * 0.15 : 0;
            const dx = myTarget.position[0] - cat.position[0];
            const dy = myTarget.position[1] - cat.position[1];
            const baseAngle = Math.atan2(dy, dx) + spreadAngle;
            const step = 25;
            const approachPos = [
                cat.position[0] + Math.cos(baseAngle) * step,
                cat.position[1] + Math.sin(baseAngle) * step,
            ];
            cat.move(approachPos);
        } else {
            if (!doSurroundApproach(cat, identity(cat))) {
                const lowEnergy = cat.energy < 5 || cat.energy < cat.energy_capacity * 0.3;
                if (lowEnergy && closest) cat.move(safeRetreat(cat, closest.position, 30));
            }
        }
    } else {
        // Between minSafe and maxSafe — advance when we outnumber, else surround approach
        const d = dist(cat.position, myTarget.position);
        if (d > PEW_RANGE) {
            const { ours, theirs, safeToStrike } = engagementCounts(myTarget);
            if ((safeToStrike && ours > theirs) || hasMajorityAdvantage()) {
                const me = identity(cat);
                const spreadAngle = me ? (me.index % 3 - 1) * 0.12 : 0;
                const dx = myTarget.position[0] - cat.position[0];
                const dy = myTarget.position[1] - cat.position[1];
                const baseAngle = Math.atan2(dy, dx) + spreadAngle;
                const step = 25;
                cat.move([
                    cat.position[0] + Math.cos(baseAngle) * step,
                    cat.position[1] + Math.sin(baseAngle) * step,
                ]);
            } else {
                const lowEnergy = cat.energy < 5 || cat.energy < cat.energy_capacity * 0.3;
                if (lowEnergy && closest) {
                    cat.move(safeRetreat(cat, closest.position, 30));
                } else {
                const weak = weakPointTarget();
                if (weak && !teamCanEngage(weak)) {
                    const me = identity(cat);
                    const spreadAngle = me ? (me.index % 3 - 1) * 0.2 : 0;
                    const dx = weak.position[0] - cat.position[0];
                    const dy = weak.position[1] - cat.position[1];
                    const baseAngle = Math.atan2(dy, dx) + spreadAngle;
                    const step = 18;
                    let approachPos = [
                        cat.position[0] + Math.cos(baseAngle) * step,
                        cat.position[1] + Math.sin(baseAngle) * step,
                    ];
                    // Avoid moving within 250 of other enemies
                    const others = livingEnemies().filter(e => e.id !== weak.id);
                    for (const o of others) {
                        if (dist(approachPos, o.position) < SURROUND_SAFE_FROM_OTHERS) {
                            const awayDir = [
                                approachPos[0] - o.position[0],
                                approachPos[1] - o.position[1],
                            ];
                            const len = Math.sqrt(awayDir[0] ** 2 + awayDir[1] ** 2) || 1;
                            approachPos = [
                                o.position[0] + (awayDir[0] / len) * SURROUND_SAFE_FROM_OTHERS,
                                o.position[1] + (awayDir[1] / len) * SURROUND_SAFE_FROM_OTHERS,
                            ];
                            break;
                        }
                    }
                    cat.move(approachPos);
                }
                }
            }
        }
    }
}

// --- Healers: Hilli, Whiskers ---

function thinkHealer(cat) {
    const friends = aliveOf(my_cats);
    const nonHealers = friends.filter(c => {
        const fid = identity(c);
        return fid && fid.role !== 'healer';
    });

    const teamCenter = nonHealers.length > 0
        ? centroid(nonHealers.map(c => c.position))
        : cat.position;
    const targetPod = nearestPod(teamCenter);

    if (!isOnPod(cat.position) || dist(cat.position, targetPod) > 30) {
        cat.move(targetPod);
    }
}

// --- Connectors: Claw & Scar ---
//     Form a two-link energy bridge between healers and aggressors.
//     Scar sits at 1/3 (healer side), Claw at 2/3 (aggro side).

function thinkConnector(cat) {
    const aggroCats = catsByRole('aggro');
    const healerCats = catsByRole('healer');

    if (aggroCats.length === 0 || healerCats.length === 0) {
        thinkDefault(cat);
        return;
    }

    const aggroCenter = centroid(aggroCats.map(c => c.position));
    const healerCenter = centroid(healerCats.map(c => c.position));
    const enemies = livingEnemies();
    const distToEnemies = enemies.length > 0
        ? Math.min(...enemies.map(e => dist(cat.position, e.position)))
        : 400;

    const me = identity(cat);
    let t = me.name === 'Claw' ? 2 / 3 : 1 / 3;
    if (distToEnemies > 300) {
        t = me.name === 'Claw' ? 0.85 : 0.35;
    }
    const bridgePoint = [
        healerCenter[0] + (aggroCenter[0] - healerCenter[0]) * t,
        healerCenter[1] + (aggroCenter[1] - healerCenter[1]) * t,
    ];

    if (dist(cat.position, bridgePoint) > 20) {
        cat.move(bridgePoint);
    }
}

// --- Ziggy: the crazy flanker ---
//     Targets the furthest enemy and navigates toward it while
//     keeping at least 230 units from every other enemy.  Uses
//     angle-sweeping (±90° in 10° increments) to find a safe
//     step each tick.  If cornered, retreats from the nearest
//     non-target enemy.

function thinkCrazy(cat) {
    const enemies = livingEnemies();
    if (enemies.length === 0) { cat.move([0, 0]); return; }

    let target = null, maxD = -1;
    for (const e of enemies) {
        const d = dist(cat.position, e.position);
        if (d > maxD) { maxD = d; target = e; }
    }
    if (!target) return;

    const others = enemies.filter(e => e.id !== target.id);

    if (others.length > 0) {
        const closestOther = closestTo(cat.position, others);
        if (closestOther && dist(cat.position, closestOther.position) < 235) {
            const ours = aliveOf(my_cats);
            if (ours.length > 1) {
                const teamCenter = centroid(ours.filter(c => c.id !== cat.id).map(c => c.position));
                cat.move(towards(cat.position, teamCenter, 25));
            } else {
                cat.move(safeRetreat(cat, closestOther.position, 25));
            }
            return;
        }
    }

    if (maxD <= 200) return;

    if (!teamCanEngage(target)) {
        const ours = aliveOf(my_cats);
        if (ours.length > 1) {
            const teamCenter = centroid(ours.filter(c => c.id !== cat.id).map(c => c.position));
            cat.move(towards(cat.position, teamCenter, 30));
        } else {
            const closestEnemy = closestTo(cat.position, enemies);
            if (closestEnemy) cat.move(safeRetreat(cat, closestEnemy.position, 30));
        }
        return;
    }

    if (others.length === 0) {
        cat.move(target.position);
        return;
    }

    const dx = target.position[0] - cat.position[0];
    const dy = target.position[1] - cat.position[1];
    const baseAngle = Math.atan2(dy, dx);

    function isSafe(pos) {
        for (const e of others) {
            if (dist(pos, e.position) < 235) return false;
        }
        return true;
    }

    const directStep = [
        cat.position[0] + Math.cos(baseAngle) * 20,
        cat.position[1] + Math.sin(baseAngle) * 20,
    ];
    if (isSafe(directStep)) {
        cat.move(directStep);
        return;
    }

    for (let offset = 10; offset <= 90; offset += 10) {
        for (const sign of [1, -1]) {
            const angle = baseAngle + offset * sign * Math.PI / 180;
            const step = [
                cat.position[0] + Math.cos(angle) * 20,
                cat.position[1] + Math.sin(angle) * 20,
            ];
            if (isSafe(step)) {
                cat.move(step);
                return;
            }
        }
    }

    const threat = closestTo(cat.position, others);
    if (threat) {
        const ours = aliveOf(my_cats);
        if (ours.length > 1) {
            const teamCenter = centroid(ours.filter(c => c.id !== cat.id).map(c => c.position));
            cat.move(towards(cat.position, teamCenter, 20));
        } else {
            cat.move(safeRetreat(cat, threat.position, 20));
        }
    }
}

// --- Default fallback (used by any unnamed cats) ---

function thinkDefault(cat) {
    const enemies = livingEnemies();
    if (enemies.length === 0) { cat.move([0, 0]); return; }

    const target = closestTo(cat.position, enemies);
    if (target && dist(cat.position, target.position) > 210) {
        cat.move(target.position);
    }
}

// ============================================================
//  Centralized friendly pew (heal / relay)
// ============================================================

function supportPew(cat, me) {
    if (cat.energy <= 0) return;
    const nearby = pewableFriends(cat);

    switch (me.role) {
        case 'support': {
            const luna = catByName('Luna');
            if (luna && luna.energy < 10
                && dist(cat.position, luna.position) <= 200) {
                cat.pew(luna);
            }
            break;
        }
        case 'healer': {
            if (cat.energy < 3) break;
            if (cat.energy >= 6) {
                const connectors = nearby.filter(f => {
                    const fid = identity(f);
                    return fid && fid.role === 'connector'
                        && f.energy < f.energy_capacity && f.id !== cat.id;
                });
                if (connectors.length > 0) {
                    cat.pew(weakestOf(connectors));
                    break;
                }
                const wounded = nearby.filter(f => f.energy < 8 && f.id !== cat.id);
                if (wounded.length > 0) {
                    cat.pew(weakestOf(wounded));
                    break;
                }
            }
            const critical = nearby.filter(f => f.energy <= 2 && f.id !== cat.id);
            if (critical.length > 0) cat.pew(weakestOf(critical));
            break;
        }
        case 'connector': {
            if (cat.energy <= 2) break;
            const recipients = nearby.filter(f => {
                const fid = identity(f);
                if (!fid || f.id === cat.id) return false;
                if (fid.role === 'healer') return false;
                return f.energy < f.energy_capacity;
            });
            if (recipients.length > 0) cat.pew(weakestOf(recipients));
            break;
        }
    }
}

// ============================================================
//  Shouts — endgame, mourning & banter
// ============================================================

const ENDGAME_WINNING = [
    // --- emojis ---
    '😹', '😹😹', '😹😹😹', '🤣', '😂', '💀', '👑', '🏆',
    '😎', '💅', '😏', '🫡', '👋', '✌️', '😼', '🥱', '😴',
    '🐔', '🔪', '🐱', '🎉', '🥇', '🪦', '⚰️', '🤡',
    // --- short ---
    'GG', 'gg ez', 'lol', 'lmao', 'HAHA', 'hahaha',
    'ez', 'free', 'L', 'big L', 'huge L', 'LLLL',
    'owned', 'rekt', 'bozo', 'noob', 'ratio', 'diff',
    'gap', 'yawn', 'zzz', 'F', 'RIP', 'cya', 'bye',
    'gn', 'purr', 'meow', 'clean', 'crispy',
    // --- taunts ---
    'too easy', 'get rekt', 'bye bye', 'sit down',
    'stay down', 'gg no re', 'outplayed', 'skill diff',
    'skill issue', 'mad?', 'cry more', 'is that it?',
    'snoozefest', 'boring', 'next!', 'free win',
    'ez game', 'ez clap', 'hold this L', 'take the L',
    'go next', 'rip bozo', 'just ff', 'ff go next',
    'give up yet?', 'surrender?', 'no mercy',
    'scared?', 'where u going?', 'come back!',
    'dont run!', 'running?', 'chicken',
    'dance for me', 'kneel', 'bow down',
    // --- sarcastic / patronizing ---
    'nice try ig', 'A for effort', 'cute attempt',
    'adorable', 'aww', 'poor thing', 'so sad',
    'u tried', 'good effort!', 'almost! jk',
    'not even close', 'wow.', 'yikes', 'tragic',
    'unlucky!', 'sadge', 'oof for u',
    '*pats head*', '*slow clap*', '*claps*',
    // --- cocky ---
    'built different', 'just better', 'simply better',
    'flawless', 'calculated', 'as expected',
    'all planned', 'too ez', 'surgical',
    'perfection', 'masterpiece', 'like butter',
    '*chefs kiss*', 'beautiful', 'poetry',
    // --- cat-themed ---
    'meow diff', 'cat gap', '*purrs loudly*',
    'meow meow 😼', 'paws > yours', 'hiss',
    'cat supremacy', '*licks paw*', 'purr purr',
    // --- questions / teasing ---
    'first time?', 'new here?', 'need tips?',
    'tutorial?', 'is this ranked?', 'git gud',
    'try harder', 'practice more', 'that all?',
    'want advice?', 'need a hug?', 'u ok?',
    'having fun?', 'warm up done?',
    // --- actions ---
    '*dances*', '*yawns*', '*naps*', '*stretches*',
    '*does a flip*', '*moonwalks*', 'nap time 😴',
    // --- dismissive ---
    'whatever', 'who?', 'boring!', 'next pls',
    'thanks!', 'fun!', 'again?', 'or not lol',
    'moving on', 'anyways', 'so anyway',
    'where was i', 'oh right', 'as i was saying',
    // --- savage ---
    'pathetic', 'weak', 'so weak', 'embarrassing',
    'cringe', 'pain to watch', 'yikes forever',
    'delete ur code', 'alt+f4', 'ctrl+z urself',
    'refund pls', 'ur code is mid', 'mid',
    'imagine losing', 'couldnt be me', 'skill gap',
    'levels above', 'not the same', 'different breed',
    'elite', 'top diff', 'massive gap',
];

const ENDGAME_LOSING = [
    // --- emojis ---
    '😭', '😭😭😭', '💀', '😤', '😡', '🤬', '😢', '😿',
    '💔', '🥺', '🫠', '🔥🔥🔥', '☠️', '🪦', '😵',
    '🥀', '🖤', '💢', '👊', '🤡',
    // --- angry / profane ---
    'fuck', 'fuck you', 'fuck you!', 'fuck off',
    'fk u', 'screw this', 'bullshit', 'bs', 'wtf',
    'go to hell', 'eat shit', 'bite me', 'kiss my ass',
    'eat my dust', 'shove it', 'drop dead',
    // --- pleading ---
    'pls', 'please', 'pls stop', 'stop it', 'enough',
    'mercy', 'mercy!', 'have mercy', 'spare me',
    'no more', 'i beg', 'let me live', 'dont do this',
    'ill do anything', 'take my lunch', 'be gentle',
    // --- resignation ---
    'im done', 'done.', 'over it', 'nope.', 'cant.',
    'gg', 'gg i guess', 'gg...', 'welp', 'well then',
    'ok then', 'sure.', 'cool.', 'nice.', 'great.',
    'fantastic.', 'wonderful.', 'lovely.', 'perfect.',
    'just perfect', 'ofc', 'of course', 'typical',
    'every time', 'always', 'knew it', 'figures',
    'as usual', 'why not', 'add it to the list',
    'im not even mad', 'just disappointed', 'wow ok',
    // --- sarcasm ---
    'proud of yourself?', 'happy now?', 'feel good?',
    'worth it?', 'wow so cool', 'so brave',
    'real original', 'creative.', 'so honorable',
    'very fair', 'totally fair', 'much skill',
    'wow skill', 'so talent', 'such honor',
    'clap clap', '👏👏', '*slow clap*', 'bravo.',
    'real impressive', 'groundbreaking', 'genius.',
    'wow big brain', 'so strategic', '10/10',
    // --- screaming ---
    '*screams*', '*cries*', '*dies inside*',
    'aaaaaaa', 'AAAA', 'AAAAHHH', 'nooo', 'NOOO',
    'noooooo', 'HELP', 'halp', 'SOS', 'mayday',
    'send help', '911', 'hello??', 'anyone??',
    '*panics*', '*flails*', 'CODE RED',
    // --- defiant ---
    'never give up', 'never!', 'NEVER',
    'ill be back', 'revenge.', 'mark my words',
    'remember me', 'witness me', 'YOLO',
    'for glory!', 'not like this', 'not today',
    'you wish', '1v1 me', '1v1 coward',
    'cowards', 'fight fair', 'all of you??',
    'gang up more', 'real brave btw', 'scared 1v1?',
    'come 1 by 1', 'at least i tried', 'i tried',
    'no regrets', 'worth it', 'id do it again',
    // --- excuses ---
    'lucky', 'so lucky', 'pure luck', 'lag',
    'i lagged', 'its lag', 'cheater', 'hacker',
    'broken', 'so broken', 'unfair', 'nerf pls',
    'balanced btw', 'wasnt trying', 'not even trying',
    'that was warmup', 'round 2?', 'bad rng',
    'my cat walked on', 'sun in my eyes', 'dog ate my code',
    'keyboard broke', 'mouse died', 'wifi pls',
    // --- pain ---
    'pain.', 'suffering.', 'agony', 'this hurts',
    'why', 'WHYYY', 'whyyy', 'fml', 'hate it here',
    'i hate this', 'this is bs', 'end me',
    'just end it', 'kill me', 'make it stop',
    'this is fine 🔥', 'fine.', 'all good',
    'totally fine', 'everything is fine',
    'im fine really', 'its fine', '*nervous laugh*',
    // --- quitting ---
    'i quit', 'im out', 'thats it', 'flips table',
    'rage quit', 'uninstall', 'bye', 'peace out',
    'nvm', 'forget this', 'im leaving', 'adios',
    'sayonara', 'au revoir', 'tschuss',
    // --- misc ---
    'bruh', 'bruhhh', 'bro.', 'come on', 'cmon',
    'really?', 'seriously?', 'rly?', '*sigh*', 'sigh',
    'rip me', 'rip', 'press F', 'big F', 'oof',
    'ow', 'ouch', 'that hurt', 'mom pick me up',
    'want my mom', 'dad help', 'not again',
    'here we go again', 'deja vu', 'oh no', 'oh no no',
    'nonono', 'nah', 'nah nah nah', 'smh', 'facepalm',
    'unbelievable', 'are u serious', 'are u kidding',
    'give me a break', 'what even', 'how even',
    'explain.', 'logic?', 'physics??', 'rigged',
    'this game man', 'i s2g', 'on god', 'bro please',
];

const SHOUT_TIERS = [
    ['GG 🏆', '😹', 'bow down', 'flawless', '💀 rip',
     'get rekt', 'gg no re', '👑', 'too easy', 'lmao'],
    ['💅', 'gg?', 'is that all?', 'yawn 🥱', '😏',
     'ez', '*yawns*', 'snoozefest'],
    ['heh', '😼', 'not bad', '*purrs*', '🐱',
     'nyeh heh', 'we vibin'],
    ['hmm.', '😤', 'watch me', 'just wait', '🙄',
     'ok ok ok', 'bruh'],
    ['this is fine 🔥', 'ow ow ow', 'help??', '😿',
     'rude.', 'not like this', 'oof'],
    ['pls stop 😭', 'mercy!', '😭😭😭', 'whyyy',
     'no no no', 'have mercy', '💀', 'i surrender'],
];

function handleShouts(cat, me) {
    // --- Endgame: ALL cats shout when it's hopeless ---
    const endgame = endgameState();
    if (endgame) {
        if (tick % 3 !== me.index % 3) return;
        const pool = endgame === 'winning' ? ENDGAME_WINNING : ENDGAME_LOSING;
        const idx = ((tick * 31 + me.index * 17) >>> 0) % pool.length;
        cat.shout(pool[idx]);
        return;
    }

    // --- Mourning: Shadow ↔ Luna (5-tick window) ---
    if (me.name === 'Shadow') {
        if (!memory.mourning.luna && !catByName('Luna')) {
            memory.mourning.luna = tick;
        }
        if (memory.mourning.luna && tick - memory.mourning.luna < 5) {
            cat.shout('Nooo! Luna!');
            return;
        }
    }
    if (me.name === 'Luna') {
        if (!memory.mourning.shadow && !catByName('Shadow')) {
            memory.mourning.shadow = tick;
        }
        if (memory.mourning.shadow && tick - memory.mourning.shadow < 5) {
            cat.shout('Noo! Shadow!');
            return;
        }
    }

    // --- Banter: Hilli & Pouncer shout every ~6 ticks, staggered ---
    if (me.name !== 'Hilli' && me.name !== 'Pouncer') return;

    const offset = me.name === 'Hilli' ? 0 : 3;
    if ((tick + offset) % 6 !== 0) return;

    const diff = energyDiff();
    let tier;
    if (diff > 30)       tier = 0;
    else if (diff > 15)  tier = 1;
    else if (diff > 0)   tier = 2;
    else if (diff > -15) tier = 3;
    else if (diff > -30) tier = 4;
    else                 tier = 5;

    const pool = SHOUT_TIERS[tier];
    const idx = (tick * 7 + me.index * 13) % pool.length;
    cat.shout(pool[idx]);
}

// ============================================================
//  All-In Mode — 12%+ energy advantage: press the kill
// ============================================================

function allInTarget() {
    const enemies = livingEnemies();
    if (enemies.length === 0) return null;

    let bestTarget = null, bestScore = -Infinity;
    for (const e of enemies) {
        const projected = pewLedger[e.id] !== undefined ? pewLedger[e.id] : e.energy;
        if (projected <= -1) continue;
        const aoe = aoeNeighbors(e);
        const score = (10 - projected) * 3 + aoe * 8;
        if (score > bestScore) { bestScore = score; bestTarget = e; }
    }
    return bestTarget || weakestOf(enemies);
}

function thinkAllInCombat(cat) {
    const target = allInTarget();
    if (!target) { cat.move([0, 0]); return; }

    const pred = predictPotentialFocusFire(cat);
    if (pred) {
        cat.move(safeRetreat(cat, pred.threatCenter, 35));
        return;
    }
    const d = dist(cat.position, target.position);
    if (d > 185) {
        cat.move(target.position);
    } else {
        cat.move(away(cat.position, target.position, 20));
    }
}

function thinkAllInConnector(cat) {
    const aggroCats = catsByRole('aggro');
    const healerCats = catsByRole('healer');
    if (aggroCats.length === 0 || healerCats.length === 0) {
        thinkAllInCombat(cat);
        return;
    }
    const aggroCenter = centroid(aggroCats.map(c => c.position));
    const healerCenter = centroid(healerCats.map(c => c.position));
    const me = identity(cat);
    const t = me.name === 'Claw' ? 0.8 : 0.5;
    const bridgePoint = [
        healerCenter[0] + (aggroCenter[0] - healerCenter[0]) * t,
        healerCenter[1] + (aggroCenter[1] - healerCenter[1]) * t,
    ];
    if (dist(cat.position, bridgePoint) > 15) cat.move(bridgePoint);
}

function thinkAllInHealer(cat) {
    const aggroCats = catsByRole('aggro');
    if (aggroCats.length === 0) return;
    const aggroCenter = centroid(aggroCats.map(c => c.position));
    const bestPod = nearestPod(aggroCenter);
    if (!isOnPod(cat.position) || dist(cat.position, bestPod) > 30) {
        cat.move(bestPod);
    }
}

// ============================================================
//  The Mind — pew → evade → charge → role movement
// ============================================================

function mind(cat) {
    const me = identity(cat);
    if (!me || cat.hp === 0) return;

    // ── Death circle guardrail + anti-splash spacing ──
    const safeRadius = death_circle - 10;
    const rawMove = cat.move.bind(cat);
    const inCombat = enemiesInRange(cat.position, 300) > 0;
    cat.move = function(target) {
        let t = target;

        if (inCombat && me.name !== 'Ziggy') {
            let closestAlly = null, closestAllyDist = Infinity;
            for (const f of aliveOf(my_cats)) {
                if (f.id === cat.id) continue;
                const d = dist(cat.position, f.position);
                if (d < closestAllyDist) { closestAllyDist = d; closestAlly = f; }
            }
            if (closestAlly && closestAllyDist < 25) {
                const nudge = away(t, closestAlly.position, 25 - closestAllyDist);
                t = nudge;
            }
        }

        const d = dist(t, [0, 0]);
        if (d > safeRadius) {
            rawMove(towards(t, [0, 0], d - safeRadius));
        } else {
            rawMove(t);
        }
    };

    // If already outside or too close to edge, rush inward immediately
    if (dist(cat.position, [0, 0]) > safeRadius) {
        cat.move(towards(cat.position, [0, 0], 50));
        return;
    }

    cat.set_mark(me.name);

    if (tick <= 3) {
        cat.shout(me.name + '!');
        return;
    }

    handleShouts(cat, me);

    // ── Phase 1: ENEMY PEW (always top priority for every cat) ──
    let pewedEnemy = false;
    const pewTarget = pickPewTarget(cat);
    if (pewTarget) {
        commitPew(cat, pewTarget);
        pewedEnemy = true;
    }

    // ── Phase 2: FRIENDLY PEW (heal / relay, only when no enemy pewed) ──
    if (!pewedEnemy) supportPew(cat, me);

    // ── Phase 2.1: PATIENCE MODE — enemy mass-camping pods ──
    {
        const enemies = livingEnemies();
        let enemiesOnPods = 0;
        for (const e of enemies) if (isOnPod(e.position)) enemiesOnPods++;
        if (enemiesOnPods >= 3) {
            const safeBuffer = enemiesOnPods >= 5 ? 40 : 20;
            const nearest = closestTo(cat.position, enemies);
            if (nearest && dist(cat.position, nearest.position) < 200 + safeBuffer) {
                cat.move(safeRetreat(cat, nearest.position, 30));
            } else if (cat.energy < cat.energy_capacity && !isOnPod(cat.position)) {
                const lowEnergy = cat.energy < 5 || cat.energy < cat.energy_capacity * 0.3;
                const pod = lowEnergy ? nearestSafePod(cat.position, PEW_RANGE_NEXT_TICK) : nearestSafePod(cat.position);
                const closeToPod = pod && dist(cat.position, pod) <= 120;
                if (lowEnergy && closeToPod) {
                    cat.move(pod);
                } else {
                    doSurroundApproach(cat, me);
                }
            } else {
                doSurroundApproach(cat, me);
            }
            return;
        }
    }

    // ── Phase 2.2: LOW ENERGY POD PRIORITY — stay 220+ from enemies, prioritize charging ──
    {
        const lowEnergy = cat.energy < 5 || cat.energy < cat.energy_capacity * 0.3;
        if (lowEnergy && !isOnPod(cat.position) && !hasMajorityAdvantage()) {
            const enemies = livingEnemies();
            const nearestE = closestTo(cat.position, enemies);
            if (nearestE && dist(cat.position, nearestE.position) < PEW_RANGE_NEXT_TICK) {
                cat.move(safeRetreat(cat, nearestE.position, 30));
                return;
            }
            const pod = nearestSafePod(cat.position, PEW_RANGE_NEXT_TICK);
            if (pod) {
                cat.move(pod);
                return;
            }
            if (nearestE && dist(cat.position, nearestE.position) < 250) {
                cat.move(safeRetreat(cat, nearestE.position, 25));
                return;
            }
        }
    }

    // ── Phase 2.3: PREDICT POTENTIAL FOCUS-FIRE — retreat before enemies move into range ──
    {
        const pred = predictPotentialFocusFire(cat);
        if (pred) {
            cat.move(safeRetreat(cat, pred.threatCenter, 35));
            return;
        }
    }

    // ── Phase 2.5: ALL-IN MODE when 12%+ energy advantage ──
    if (energyAdvantageRatio() >= 0.12) {
        switch (me.role) {
            case 'healer':    thinkAllInHealer(cat);    break;
            case 'connector': thinkAllInConnector(cat);  break;
            default:          thinkAllInCombat(cat);     break;
        }
        return;
    }

    // ── Phase 2.7: SURROUND PLAN (stall-breaker: 4 cats circle at 270, then strike) ──
    if (memory.surround && thinkSurround(cat, me)) {
        return;
    }

    // ── Phase 2.8: SURROUND APPROACH — when we can't strike, move toward weak point (no passive wait) ──
    if (doSurroundApproach(cat, me)) {
        return;
    }

    // ── Phase 3: DANGER EVASION (non-frontline cats) ──
    if (me.role !== 'aggro' && me.role !== 'crazy' && me.role !== 'support') {
        if (!hasMajorityAdvantage()) {
            const enemies = livingEnemies();
            const adj = aggressionMod();
            const nearestE = closestTo(cat.position, enemies);
            const podBon = (nearestE && isOnPod(nearestE.position)) ? 20 : 0;
            const fleeRange = 255 + adj + podBon;
            const threats = enemies.filter(e => dist(cat.position, e.position) < fleeRange);
            if (threats.length > 0) {
                const alliesHere = friendsInRange(cat.position, 260);
                if (alliesHere <= threats.length) {
                    const threatCenter = centroid(threats.map(e => e.position));
                    cat.move(safeRetreat(cat, threatCenter, 100));
                    return;
                }
            }
        }
    }

    // ── Phase 4: POD CHARGING (all cats, when safe) ──
    // General rule: low energy → prioritize charging over role behavior
    if (isOnPod(cat.position) && cat.energy < cat.energy_capacity
        && enemiesInRange(cat.position, 200) === 0) {
        return;
    }
    if (cat.energy < cat.energy_capacity && !isOnPod(cat.position)) {
        const lowEnergy = cat.energy < 5 || cat.energy < cat.energy_capacity * 0.3;
        let pod = lowEnergy ? nearestSafePod(cat.position, PEW_RANGE_NEXT_TICK) : nearestSafePod(cat.position);
        if (!pod && (cat.energy < 3 || cat.energy < cat.energy_capacity * 0.2)) {
            pod = nearestSafePod(cat.position, 150);
        }
        if (pod) {
            if (lowEnergy) {
                const nearestE = closestTo(cat.position, livingEnemies());
                if (nearestE && dist(cat.position, nearestE.position) < PEW_RANGE_NEXT_TICK) {
                    cat.move(safeRetreat(cat, nearestE.position, 30));
                } else {
                    cat.move(pod);
                }
                return;
            }
            const d = dist(cat.position, pod);
            if (d <= 100) {
                cat.move(pod);
                return;
            }
        }
    }

    // ── Phase 5: ROLE MOVEMENT ──
    switch (me.role) {
        case 'support':   thinkShadow(cat);   break;
        case 'aggro':     thinkAggro(cat);     break;
        case 'crazy':     thinkCrazy(cat);     break;
        case 'healer':    thinkHealer(cat);    break;
        case 'connector': thinkConnector(cat); break;
        default:          thinkDefault(cat);   break;
    }
}

// ============================================================
//  Main loop
// ============================================================

initLedger();
updateStallHistory();
// Proactively seek surround when we can't strike (replaces passive "wait" phase)
maybeStartSurround();
if (memory.surround) {
    updateSurroundPhase();
}

const alive = aliveOf(my_cats);
for (const cat of alive) {
    mind(cat);
}
