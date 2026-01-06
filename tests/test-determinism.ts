/**
 * Cell Eater Determinism Tests
 *
 * Tests that multiple game instances produce identical state
 * when given the same inputs in the same order.
 */

// Import engine directly
import {
    World,
    Transform2D,
    Body2D,
    Player,
    Sprite,
    BODY_KINEMATIC,
    BODY_STATIC,
    SHAPE_CIRCLE,
    dRandom,
    dSqrt,
    fpMul,
    fpDiv,
    saveRandomState,
    loadRandomState,
} from '../../../engine/src/index';

// Helper to seed the RNG by loading a state derived from a seed number
function seedRandom(seed: number): void {
    // Mix the seed into two state values (same algorithm as engine's internal setSeed)
    seed = seed >>> 0;
    if (seed === 0) seed = 1;

    let s = seed;
    s = ((s >>> 16) ^ s) * 0x45d9f3b >>> 0;
    s = ((s >>> 16) ^ s) * 0x45d9f3b >>> 0;
    const s0 = ((s >>> 16) ^ s) >>> 0;

    s = (seed * 0x9e3779b9) >>> 0;
    s = ((s >>> 16) ^ s) * 0x45d9f3b >>> 0;
    s = ((s >>> 16) ^ s) * 0x45d9f3b >>> 0;
    let s1 = ((s >>> 16) ^ s) >>> 0;

    if (s0 === 0 && s1 === 0) {
        loadRandomState({ s0: 1, s1: 2 });
    } else {
        loadRandomState({ s0, s1 });
    }
}

// ============================================
// Constants (same as game.ts)
// ============================================

const WORLD_WIDTH = 6000;
const WORLD_HEIGHT = 6000;
const SPEED = 5;
const INITIAL_RADIUS = 20;
const MAX_RADIUS = 200;
const EAT_RATIO = 1.2;
const FOOD_GROW = 0.05;
const PLAYER_GROW = 0.3;
const FOOD_COUNT = 100; // Reduced for tests
const MIN_SPLIT_RADIUS = 15;
const SPLIT_VELOCITY = 15;
const MAX_CELLS_PER_PLAYER = 16;
const MERGE_DELAY_FRAMES = 600;

const COLORS = [
    '#ff6b6b', '#ff8e72', '#ffa94d', '#ffd43b', '#a9e34b', '#69db7c',
    '#38d9a9', '#3bc9db', '#4dabf7', '#748ffc', '#9775fa', '#da77f2',
];

// ============================================
// Test Harness
// ============================================

interface TestWorld {
    world: World;
    cellMergeFrame: Map<number, number>;
}

function createTestWorld(seed: number): TestWorld {
    seedRandom(seed);

    const world = new World();
    const cellMergeFrame = new Map<number, number>();

    // Define entity types
    world.defineEntity('cell')
        .with(Transform2D)
        .with(Sprite, { shape: SHAPE_CIRCLE, radius: INITIAL_RADIUS, layer: 1 })
        .with(Body2D, { shapeType: SHAPE_CIRCLE, radius: INITIAL_RADIUS, bodyType: BODY_KINEMATIC })
        .with(Player)
        .register();

    world.defineEntity('food')
        .with(Transform2D)
        .with(Sprite, { shape: SHAPE_CIRCLE, radius: 8, layer: 0 })
        .with(Body2D, { shapeType: SHAPE_CIRCLE, radius: 8, bodyType: BODY_STATIC })
        .register();

    return { world, cellMergeFrame };
}

function spawnFood(tw: TestWorld): number {
    const colorIndex = (dRandom() * COLORS.length) | 0;
    const color = tw.world.internString('color', COLORS[colorIndex]);
    const x = 50 + (dRandom() * (WORLD_WIDTH - 100)) | 0;
    const y = 50 + (dRandom() * (WORLD_HEIGHT - 100)) | 0;

    return tw.world.spawn('food', { x, y, color });
}

// Simple clientId interning for tests
const clientIdMap = new Map<string, number>();
let nextClientNum = 1;

function internClientId(clientId: string): number {
    let num = clientIdMap.get(clientId);
    if (num === undefined) {
        num = nextClientNum++;
        clientIdMap.set(clientId, num);
    }
    return num;
}

function resetClientIds(): void {
    clientIdMap.clear();
    nextClientNum = 1;
}

function spawnCell(tw: TestWorld, clientId: string, x?: number, y?: number): number {
    const colorIndex = (dRandom() * COLORS.length) | 0;
    const color = tw.world.internString('color', COLORS[colorIndex]);
    const numericClientId = internClientId(clientId);

    return tw.world.spawn('cell', {
        x: x ?? (100 + (dRandom() * (WORLD_WIDTH - 200)) | 0),
        y: y ?? (100 + (dRandom() * (WORLD_HEIGHT - 200)) | 0),
        clientId: numericClientId,
        color
    });
}

function compareStrings(a: string, b: string): number {
    if (a < b) return -1;
    if (a > b) return 1;
    return 0;
}

function movementSystem(tw: TestWorld): void {
    const { world, cellMergeFrame } = tw;

    // Group cells by player
    const playerCells = new Map<number, number[]>();
    const allCells = [...world.query('cell')].sort((a, b) => a - b);

    for (const eid of allCells) {
        const entity = world.getEntity(eid);
        if (!entity || entity.destroyed) continue;

        const clientId = entity.get(Player).clientId;
        if (clientId === undefined || clientId === null) continue;

        if (!playerCells.has(clientId)) playerCells.set(clientId, []);
        playerCells.get(clientId)!.push(eid);
    }

    // Process in deterministic order
    const sortedPlayers = [...playerCells.entries()].sort((a, b) => {
        const strA = world.getClientIdString(a[0]) || '';
        const strB = world.getClientIdString(b[0]) || '';
        return compareStrings(strA, strB);
    });

    // Compute repulsion forces
    const repulsion = new Map<number, { vx: number; vy: number }>();

    for (const [, siblings] of sortedPlayers) {
        for (const eid of siblings) {
            repulsion.set(eid, { vx: 0, vy: 0 });
        }

        if (siblings.length < 2) continue;

        for (let i = 0; i < siblings.length; i++) {
            const eidA = siblings[i];
            const entityA = world.getEntity(eidA)!;
            const tA = entityA.get(Transform2D);
            const sA = entityA.get(Sprite);

            for (let j = i + 1; j < siblings.length; j++) {
                const eidB = siblings[j];
                const entityB = world.getEntity(eidB)!;
                const tB = entityB.get(Transform2D);
                const sB = entityB.get(Sprite);

                const dx = tA.x - tB.x;
                const dy = tA.y - tB.y;
                const distSq = fpMul(dx, dx) + fpMul(dy, dy);
                const minDist = sA.radius + sB.radius;
                const minDistSq = fpMul(minDist, minDist);

                if (distSq < minDistSq && distSq > 1) {
                    const dist = dSqrt(distSq) || 1;
                    const overlap = minDist - dist;
                    const pushForce = fpMul(overlap, 0.3) + 1;
                    const nx = fpDiv(dx, dist);
                    const ny = fpDiv(dy, dist);

                    const repA = repulsion.get(eidA)!;
                    const repB = repulsion.get(eidB)!;
                    repA.vx += fpMul(nx, pushForce);
                    repA.vy += fpMul(ny, pushForce);
                    repB.vx -= fpMul(nx, pushForce);
                    repB.vy -= fpMul(ny, pushForce);
                }
            }
        }
    }

    // Apply movement
    for (const [clientId, cells] of sortedPlayers) {
        const playerInput = world.getInput(clientId);

        for (const eid of cells) {
            const entity = world.getEntity(eid)!;
            const sprite = entity.get(Sprite);
            const transform = entity.get(Transform2D);
            const body = entity.get(Body2D);

            let vx = 0, vy = 0;

            if (playerInput?.target) {
                const dx = playerInput.target.x - transform.x;
                const dy = playerInput.target.y - transform.y;
                const distSq = fpMul(dx, dx) + fpMul(dy, dy);
                const dist = dSqrt(distSq) || 1;

                const speedMultiplier = Math.min(1, fpDiv(dist, sprite.radius));
                const speed = fpMul(SPEED, speedMultiplier);

                if (speed > 0.1) {
                    vx = fpMul(fpDiv(dx, dist), speed);
                    vy = fpMul(fpDiv(dy, dist), speed);
                }
            }

            const rep = repulsion.get(eid);
            if (rep) {
                vx += rep.vx;
                vy += rep.vy;
            }

            body.vx = vx;
            body.vy = vy;

            // Apply velocity to position (simple integration)
            transform.x += body.vx;
            transform.y += body.vy;

            // Clamp to world bounds
            const r = sprite.radius;
            transform.x = Math.max(r, Math.min(WORLD_WIDTH - r, transform.x));
            transform.y = Math.max(r, Math.min(WORLD_HEIGHT - r, transform.y));
        }
    }
}

function collisionSystem(tw: TestWorld): void {
    const { world, cellMergeFrame } = tw;

    // Cell eats food
    const cells = [...world.query('cell')].sort((a, b) => a - b);
    const foods = [...world.query('food')].sort((a, b) => a - b);

    for (const cellEid of cells) {
        const cell = world.getEntity(cellEid);
        if (!cell || cell.destroyed) continue;

        const cellT = cell.get(Transform2D);
        const cellS = cell.get(Sprite);

        for (const foodEid of foods) {
            const food = world.getEntity(foodEid);
            if (!food || food.destroyed) continue;

            const foodT = food.get(Transform2D);
            const foodS = food.get(Sprite);

            const dx = cellT.x - foodT.x;
            const dy = cellT.y - foodT.y;
            const distSq = fpMul(dx, dx) + fpMul(dy, dy);
            const minDist = cellS.radius + foodS.radius;

            if (distSq < fpMul(minDist, minDist)) {
                cellS.radius = Math.min(cellS.radius + fpMul(foodS.radius, FOOD_GROW), MAX_RADIUS);
                cell.get(Body2D).radius = cellS.radius;
                food.destroy();
            }
        }
    }

    // Cell eats smaller cell (different players)
    for (let i = 0; i < cells.length; i++) {
        const eidA = cells[i];
        const cellA = world.getEntity(eidA);
        if (!cellA || cellA.destroyed) continue;

        for (let j = i + 1; j < cells.length; j++) {
            const eidB = cells[j];
            const cellB = world.getEntity(eidB);
            if (!cellB || cellB.destroyed) continue;

            // Skip same player
            if (cellA.get(Player).clientId === cellB.get(Player).clientId) continue;

            const tA = cellA.get(Transform2D);
            const tB = cellB.get(Transform2D);
            const sA = cellA.get(Sprite);
            const sB = cellB.get(Sprite);

            const dx = tA.x - tB.x;
            const dy = tA.y - tB.y;
            const distSq = fpMul(dx, dx) + fpMul(dy, dy);
            const minDist = sA.radius + sB.radius;

            if (distSq < fpMul(minDist, minDist)) {
                // Bigger eats smaller
                if (sA.radius > fpMul(sB.radius, EAT_RATIO)) {
                    sA.radius = Math.min(sA.radius + fpMul(sB.radius, PLAYER_GROW), MAX_RADIUS);
                    cellA.get(Body2D).radius = sA.radius;
                    cellB.destroy();
                    cellMergeFrame.delete(eidB);
                } else if (sB.radius > fpMul(sA.radius, EAT_RATIO)) {
                    sB.radius = Math.min(sB.radius + fpMul(sA.radius, PLAYER_GROW), MAX_RADIUS);
                    cellB.get(Body2D).radius = sB.radius;
                    cellA.destroy();
                    cellMergeFrame.delete(eidA);
                }
            }
        }
    }
}

function stepWorld(tw: TestWorld): void {
    movementSystem(tw);
    collisionSystem(tw);
    tw.world.frame++;
}

// ============================================
// Test Functions
// ============================================

let passed = 0;
let failed = 0;

function test(name: string, fn: () => boolean) {
    try {
        if (fn()) {
            console.log(`  PASS: ${name}`);
            passed++;
        } else {
            console.log(`  FAIL: ${name}`);
            failed++;
        }
    } catch (e) {
        console.log(`  FAIL: ${name} - ${e}`);
        failed++;
    }
}

// ============================================
// Test Suite
// ============================================

console.log('=== Cell Eater Determinism Tests ===\n');

// Test 1: Empty world determinism
console.log('Test 1: Empty World');

test('Two empty worlds have same hash', () => {
    const tw1 = createTestWorld(12345);
    const tw2 = createTestWorld(12345);

    return tw1.world.getStateHash() === tw2.world.getStateHash();
});

// Test 2: Food spawning determinism
console.log('\nTest 2: Food Spawning');

test('Food spawns deterministically', () => {
    const tw1 = createTestWorld(12345);
    const tw2 = createTestWorld(12345);

    // Spawn food in both worlds
    for (let i = 0; i < 10; i++) {
        spawnFood(tw1);
        spawnFood(tw2);
    }

    return tw1.world.getStateHash() === tw2.world.getStateHash();
});

test('Different seeds produce different results', () => {
    // First world with seed 12345
    seedRandom(12345);
    const tw1 = createTestWorld(12345);
    for (let i = 0; i < 10; i++) {
        spawnFood(tw1);
    }
    const hash1 = tw1.world.getStateHash();

    // Second world with different seed
    seedRandom(54321);
    const tw2 = createTestWorld(54321);
    for (let i = 0; i < 10; i++) {
        spawnFood(tw2);
    }
    const hash2 = tw2.world.getStateHash();

    return hash1 !== hash2;
});

// Test 3: Cell spawning determinism
console.log('\nTest 3: Cell Spawning');

test('Cell spawns deterministically', () => {
    const tw1 = createTestWorld(12345);
    const tw2 = createTestWorld(12345);

    spawnCell(tw1, 'player1');
    spawnCell(tw2, 'player1');

    return tw1.world.getStateHash() === tw2.world.getStateHash();
});

test('Multiple cells spawn deterministically', () => {
    const tw1 = createTestWorld(12345);
    const tw2 = createTestWorld(12345);

    spawnCell(tw1, 'player1');
    spawnCell(tw1, 'player2');
    spawnCell(tw2, 'player1');
    spawnCell(tw2, 'player2');

    return tw1.world.getStateHash() === tw2.world.getStateHash();
});

// Test 4: Movement determinism
console.log('\nTest 4: Movement');

test('Movement without input is deterministic', () => {
    const tw1 = createTestWorld(12345);
    const tw2 = createTestWorld(12345);

    spawnCell(tw1, 'player1', 100, 100);
    spawnCell(tw2, 'player1', 100, 100);

    for (let i = 0; i < 60; i++) {
        stepWorld(tw1);
        stepWorld(tw2);
    }

    return tw1.world.getStateHash() === tw2.world.getStateHash();
});

test('Movement with input is deterministic', () => {
    resetClientIds();
    const tw1 = createTestWorld(12345);
    const tw2 = createTestWorld(12345);

    spawnCell(tw1, 'player1', 100, 100);
    resetClientIds(); // Reset for tw2 to get same clientId
    spawnCell(tw2, 'player1', 100, 100);

    const clientId = internClientId('player1');

    // Apply same input
    const input = { target: { x: 500, y: 500 } };

    for (let i = 0; i < 60; i++) {
        tw1.world.setInput(clientId, input);
        tw2.world.setInput(clientId, input);
        stepWorld(tw1);
        stepWorld(tw2);
    }

    const hash1 = tw1.world.getStateHash();
    const hash2 = tw2.world.getStateHash();

    if (hash1 !== hash2) {
        console.log(`    Hash mismatch: ${hash1} vs ${hash2}`);
    }

    return hash1 === hash2;
});

// Test 5: Collision determinism
console.log('\nTest 5: Collisions');

test('Food eating is deterministic', () => {
    resetClientIds();
    const tw1 = createTestWorld(12345);
    const tw2 = createTestWorld(12345);

    // Spawn cell and food at same position
    const cell1 = spawnCell(tw1, 'player1', 100, 100);
    resetClientIds();
    const cell2 = spawnCell(tw2, 'player1', 100, 100);

    // Spawn food nearby
    tw1.world.spawn('food', { x: 110, y: 100, color: tw1.world.internString('color', '#ff0000') });
    tw2.world.spawn('food', { x: 110, y: 100, color: tw2.world.internString('color', '#ff0000') });

    const clientId = internClientId('player1');

    // Move towards food
    for (let i = 0; i < 30; i++) {
        tw1.world.setInput(clientId, { target: { x: 200, y: 100 } });
        tw2.world.setInput(clientId, { target: { x: 200, y: 100 } });
        stepWorld(tw1);
        stepWorld(tw2);
    }

    return tw1.world.getStateHash() === tw2.world.getStateHash();
});

test('Cell eating is deterministic', () => {
    resetClientIds();
    seedRandom(12345);

    const p1_id = internClientId('player1');
    const p2_id = internClientId('player2');

    const tw1 = createTestWorld(12345);

    // Big cell (player1) and small cell (player2) in tw1
    const big1 = tw1.world.spawn('cell', {
        x: 100, y: 100,
        clientId: p1_id,
        color: tw1.world.internString('color', '#ff0000')
    });
    tw1.world.spawn('cell', {
        x: 150, y: 100,
        clientId: p2_id,
        color: tw1.world.internString('color', '#00ff00')
    });

    // Make big1 bigger
    const entity1 = tw1.world.getEntity(big1);
    if (entity1) {
        entity1.get(Sprite).radius = 50;
        entity1.get(Body2D).radius = 50;
    }

    // Now create tw2 with same setup
    resetClientIds();
    internClientId('player1');
    internClientId('player2');
    seedRandom(12345);

    const tw2 = createTestWorld(12345);

    const big2 = tw2.world.spawn('cell', {
        x: 100, y: 100,
        clientId: p1_id,
        color: tw2.world.internString('color', '#ff0000')
    });
    tw2.world.spawn('cell', {
        x: 150, y: 100,
        clientId: p2_id,
        color: tw2.world.internString('color', '#00ff00')
    });

    const entity2 = tw2.world.getEntity(big2);
    if (entity2) {
        entity2.get(Sprite).radius = 50;
        entity2.get(Body2D).radius = 50;
    }

    // Move big cell towards small
    for (let i = 0; i < 60; i++) {
        tw1.world.setInput(p1_id, { target: { x: 200, y: 100 } });
        tw2.world.setInput(p1_id, { target: { x: 200, y: 100 } });
        stepWorld(tw1);
        stepWorld(tw2);
    }

    return tw1.world.getStateHash() === tw2.world.getStateHash();
});

// Test 6: Multi-client determinism
console.log('\nTest 6: Multi-Client');

test('Two clients moving simultaneously is deterministic', () => {
    resetClientIds();
    const tw1 = createTestWorld(12345);
    const tw2 = createTestWorld(12345);

    const p1 = internClientId('player1');
    const p2 = internClientId('player2');

    spawnCell(tw1, 'player1', 100, 100);
    spawnCell(tw1, 'player2', 500, 500);
    resetClientIds();
    internClientId('player1'); // Re-intern to get same IDs
    internClientId('player2');
    spawnCell(tw2, 'player1', 100, 100);
    spawnCell(tw2, 'player2', 500, 500);

    for (let i = 0; i < 120; i++) {
        // Both players move towards center
        tw1.world.setInput(p1, { target: { x: 300, y: 300 } });
        tw1.world.setInput(p2, { target: { x: 300, y: 300 } });
        tw2.world.setInput(p1, { target: { x: 300, y: 300 } });
        tw2.world.setInput(p2, { target: { x: 300, y: 300 } });

        stepWorld(tw1);
        stepWorld(tw2);
    }

    return tw1.world.getStateHash() === tw2.world.getStateHash();
});

test('Input order affects result deterministically', () => {
    resetClientIds();
    const tw1 = createTestWorld(12345);
    const tw2 = createTestWorld(12345);

    spawnCell(tw1, 'player1', 100, 100);
    resetClientIds();
    spawnCell(tw2, 'player1', 100, 100);

    const clientId = internClientId('player1');

    // Different input sequences
    const inputs = [
        { target: { x: 200, y: 100 } },
        { target: { x: 200, y: 200 } },
        { target: { x: 100, y: 200 } },
        { target: { x: 100, y: 100 } },
    ];

    for (const input of inputs) {
        for (let i = 0; i < 30; i++) {
            tw1.world.setInput(clientId, input);
            tw2.world.setInput(clientId, input);
            stepWorld(tw1);
            stepWorld(tw2);
        }
    }

    return tw1.world.getStateHash() === tw2.world.getStateHash();
});

// Test 7: RNG state save/restore
console.log('\nTest 7: RNG Save/Restore');

test('RNG state can be saved and restored', () => {
    seedRandom(12345);

    // Generate some random numbers
    const val1 = dRandom();
    const val2 = dRandom();

    // Save state
    const savedState = saveRandomState();

    // Generate more
    const val3 = dRandom();
    const val4 = dRandom();

    // Restore and regenerate
    loadRandomState(savedState);
    const val3_restored = dRandom();
    const val4_restored = dRandom();

    return val3 === val3_restored && val4 === val4_restored;
});

// Test 8: Complex scenario
console.log('\nTest 8: Complex Scenario');

test('Full game scenario is deterministic', () => {
    resetClientIds();
    const tw1 = createTestWorld(12345);

    // Spawn initial food (before resetting for tw2)
    for (let i = 0; i < FOOD_COUNT; i++) {
        spawnFood(tw1);
    }

    // Spawn two players
    spawnCell(tw1, 'player1');
    spawnCell(tw1, 'player2');

    // Now create tw2 with same seed and operations
    resetClientIds();
    const tw2 = createTestWorld(12345);

    for (let i = 0; i < FOOD_COUNT; i++) {
        spawnFood(tw2);
    }

    spawnCell(tw2, 'player1');
    spawnCell(tw2, 'player2');

    const p1 = internClientId('player1');
    const p2 = internClientId('player2');

    // Simulate 5 seconds of gameplay
    for (let frame = 0; frame < 300; frame++) {
        // Varying inputs based on frame
        const angle1 = (frame * 0.05);
        const angle2 = (frame * 0.03 + 1);

        const input1 = {
            target: {
                x: 3000 + Math.cos(angle1) * 1000,
                y: 3000 + Math.sin(angle1) * 1000
            }
        };
        const input2 = {
            target: {
                x: 3000 + Math.cos(angle2) * 800,
                y: 3000 + Math.sin(angle2) * 800
            }
        };

        tw1.world.setInput(p1, input1);
        tw1.world.setInput(p2, input2);
        tw2.world.setInput(p1, input1);
        tw2.world.setInput(p2, input2);

        stepWorld(tw1);
        stepWorld(tw2);

        // Check hash every 60 frames
        if (frame % 60 === 0) {
            const hash1 = tw1.world.getStateHash();
            const hash2 = tw2.world.getStateHash();
            if (hash1 !== hash2) {
                console.log(`    Desync at frame ${frame}: ${hash1} vs ${hash2}`);
                return false;
            }
        }
    }

    return tw1.world.getStateHash() === tw2.world.getStateHash();
});

// ============================================
// Summary
// ============================================

console.log('\n=== Results ===');
console.log(`Passed: ${passed}`);
console.log(`Failed: ${failed}`);

if (failed > 0) {
    console.log('\nDETERMINISM ISSUES FOUND!');
    console.log('The game has non-deterministic behavior that will cause desync.');
    process.exit(1);
} else {
    console.log('\nAll determinism tests passed!');
    process.exit(0);
}
