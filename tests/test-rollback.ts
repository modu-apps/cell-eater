/**
 * Cell Eater Rollback Tests
 *
 * Simulates network scenarios where clients receive inputs at different times
 * and must rollback/resimulate to stay in sync.
 */

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
    saveRandomState,
    loadRandomState,
    RandomState,
} from '../../../engine/src/index';

// ============================================
// Constants
// ============================================

const WORLD_WIDTH = 6000;
const WORLD_HEIGHT = 6000;
const SPEED = 5;
const INITIAL_RADIUS = 20;

const COLORS = ['#ff6b6b', '#4dabf7', '#69db7c'];

// ============================================
// Helper to seed RNG
// ============================================

function seedRandom(seed: number): void {
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
// Simulation State
// ============================================

interface SimState {
    world: World;
    frame: number;
    rngState: RandomState;
}

interface Snapshot {
    frame: number;
    hash: string;
    rngState: RandomState;
    entityStates: Map<number, { x: number; y: number; radius: number }>;
}

function createSimulation(seed: number): SimState {
    seedRandom(seed);

    const world = new World();

    world.defineEntity('cell')
        .with(Transform2D)
        .with(Sprite, { shape: SHAPE_CIRCLE, radius: INITIAL_RADIUS, layer: 1 })
        .with(Body2D, { shapeType: SHAPE_CIRCLE, radius: INITIAL_RADIUS, bodyType: BODY_KINEMATIC })
        .with(Player)
        .register();

    return {
        world,
        frame: 0,
        rngState: saveRandomState()
    };
}

function saveSnapshot(sim: SimState): Snapshot {
    const entityStates = new Map<number, { x: number; y: number; radius: number }>();

    // query() returns Entity objects, not IDs
    for (const entity of sim.world.query('cell')) {
        if (!entity || entity.destroyed) continue;

        const t = entity.get(Transform2D);
        const s = entity.get(Sprite);
        entityStates.set(entity.id, { x: t.x, y: t.y, radius: s.radius });
    }

    return {
        frame: sim.frame,
        hash: sim.world.getStateHash(),
        rngState: saveRandomState(),
        entityStates
    };
}

function loadSnapshot(sim: SimState, snapshot: Snapshot): void {
    // Restore entity states
    for (const [eid, state] of snapshot.entityStates) {
        const entity = sim.world.getEntity(eid);
        if (!entity) continue;

        const t = entity.get(Transform2D);
        const s = entity.get(Sprite);
        const b = entity.get(Body2D);

        t.x = state.x;
        t.y = state.y;
        s.radius = state.radius;
        b.radius = state.radius;
    }

    sim.frame = snapshot.frame;
    loadRandomState(snapshot.rngState);
}

function spawnCell(sim: SimState, clientId: number, x: number, y: number): number {
    const colorIndex = (dRandom() * COLORS.length) | 0;
    const color = sim.world.internString('color', COLORS[colorIndex]);

    return sim.world.spawn('cell', {
        x, y,
        clientId,
        color
    });
}

function stepSimulation(sim: SimState): void {
    // Simple movement system - using plain math (build process transforms to fixed-point)
    for (const entity of sim.world.query('cell')) {
        if (!entity || entity.destroyed) continue;

        const transform = entity.get(Transform2D);
        const body = entity.get(Body2D);
        const player = entity.get(Player);

        const input = sim.world.getInput(player.clientId);
        if (input?.target) {
            const dx = input.target.x - transform.x;
            const dy = input.target.y - transform.y;
            const distSq = dx * dx + dy * dy;
            const dist = dSqrt(distSq) || 1;

            if (dist > 1) {
                body.vx = (dx / dist) * SPEED;
                body.vy = (dy / dist) * SPEED;
            } else {
                body.vx = 0;
                body.vy = 0;
            }
        }

        transform.x += body.vx;
        transform.y += body.vy;

        // Clamp to bounds
        transform.x = Math.max(INITIAL_RADIUS, Math.min(WORLD_WIDTH - INITIAL_RADIUS, transform.x));
        transform.y = Math.max(INITIAL_RADIUS, Math.min(WORLD_HEIGHT - INITIAL_RADIUS, transform.y));
    }

    sim.frame++;
    sim.rngState = saveRandomState();
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
// Tests
// ============================================

console.log('=== Cell Eater Rollback Tests ===\n');

// Test 1: Basic rollback
console.log('Test 1: Basic Rollback');

test('Can rollback and resimulate to same state', () => {
    const sim = createSimulation(12345);

    spawnCell(sim, 1, 100, 100);
    sim.world.setInput(1, { target: { x: 500, y: 500 } });

    // Step to frame 30 and save
    for (let i = 0; i < 30; i++) {
        stepSimulation(sim);
    }
    const snapshot = saveSnapshot(sim);

    // Continue to frame 60
    for (let i = 0; i < 30; i++) {
        stepSimulation(sim);
    }
    const finalHash1 = sim.world.getStateHash();

    // Rollback to frame 30 and resimulate
    loadSnapshot(sim, snapshot);
    for (let i = 0; i < 30; i++) {
        stepSimulation(sim);
    }
    const finalHash2 = sim.world.getStateHash();

    if (finalHash1 !== finalHash2) {
        console.log(`    Hashes differ: ${finalHash1} vs ${finalHash2}`);
    }

    return finalHash1 === finalHash2;
});

// Test 2: Rollback with input change
console.log('\nTest 2: Rollback with Input Change');

test('Rollback with different input produces different result', () => {
    const sim = createSimulation(12345);

    const cellEid = spawnCell(sim, 1, 100, 100);
    console.log(`    Spawned cell with eid: ${cellEid}`);

    // Check entities right after spawn
    const cellsAfterSpawn = [...sim.world.query('cell')];
    console.log(`    Cells after spawn: ${cellsAfterSpawn.length}, eids: ${cellsAfterSpawn.join(', ')}`);

    sim.world.setInput(1, { target: { x: 500, y: 500 } });

    // Step to frame 30 and save
    for (let i = 0; i < 30; i++) {
        stepSimulation(sim);
    }

    // Check entities at frame 30
    const cellsAt30 = [...sim.world.query('cell')];
    console.log(`    Cells at frame 30: ${cellsAt30.length}`);

    const snapshot = saveSnapshot(sim);

    // Log position at frame 30
    const pos30 = [...snapshot.entityStates.values()][0];
    if (pos30) {
        console.log(`    Position at frame 30: (${pos30.x}, ${pos30.y})`);
    } else {
        console.log(`    No entities in snapshot!`);
    }

    // Continue with original input toward (500, 500)
    for (let i = 0; i < 30; i++) {
        stepSimulation(sim);
    }
    const hash1 = sim.world.getStateHash();

    // Get final position path 1
    const cells1 = [...sim.world.query('cell')];
    console.log(`    Cells after path 1: ${cells1.length}`);
    let finalPos1 = { x: 0, y: 0 };
    if (cells1.length > 0) {
        const entity1 = sim.world.getEntity(cells1[0]);
        if (entity1) {
            finalPos1 = { x: entity1.get(Transform2D).x, y: entity1.get(Transform2D).y };
            console.log(`    Path 1 final (toward 500,500): (${finalPos1.x}, ${finalPos1.y})`);
        }
    }

    // Rollback and apply different input - go BACKWARDS
    loadSnapshot(sim, snapshot);
    sim.world.setInput(1, { target: { x: 0, y: 0 } }); // Different target - opposite direction

    for (let i = 0; i < 30; i++) {
        stepSimulation(sim);
    }
    const hash2 = sim.world.getStateHash();

    // Get final position path 2
    const cells2 = [...sim.world.query('cell')];
    console.log(`    Cells after path 2: ${cells2.length}`);
    let finalPos2 = { x: 0, y: 0 };
    if (cells2.length > 0) {
        const entity2 = sim.world.getEntity(cells2[0]);
        if (entity2) {
            finalPos2 = { x: entity2.get(Transform2D).x, y: entity2.get(Transform2D).y };
            console.log(`    Path 2 final (toward 0,0): (${finalPos2.x}, ${finalPos2.y})`);
        }
    }

    console.log(`    Hash1: ${hash1}, Hash2: ${hash2}`);

    // Should be different because input changed
    return hash1 !== hash2;
});

// Test 3: RNG state preservation
console.log('\nTest 3: RNG State in Rollback');

test('RNG state is preserved across rollback', () => {
    const sim = createSimulation(12345);

    spawnCell(sim, 1, 100, 100);

    // Step to frame 30 and save
    for (let i = 0; i < 30; i++) {
        stepSimulation(sim);
    }
    const snapshot = saveSnapshot(sim);

    // Generate random numbers after frame 30
    const rand1_a = dRandom();
    const rand1_b = dRandom();

    // Rollback
    loadSnapshot(sim, snapshot);

    // Should get same random numbers
    const rand2_a = dRandom();
    const rand2_b = dRandom();

    if (rand1_a !== rand2_a || rand1_b !== rand2_b) {
        console.log(`    RNG mismatch: ${rand1_a}, ${rand1_b} vs ${rand2_a}, ${rand2_b}`);
    }

    return rand1_a === rand2_a && rand1_b === rand2_b;
});

// Test 4: Multi-client rollback
console.log('\nTest 4: Multi-Client Rollback');

test('Two clients stay in sync with rollback', () => {
    // Simulate two clients receiving same inputs
    const clientA = createSimulation(12345);
    const clientB = createSimulation(12345);

    // Both spawn same cell
    spawnCell(clientA, 1, 100, 100);
    spawnCell(clientB, 1, 100, 100);

    // Both receive input at frame 0
    clientA.world.setInput(1, { target: { x: 500, y: 500 } });
    clientB.world.setInput(1, { target: { x: 500, y: 500 } });

    // A advances normally
    for (let i = 0; i < 60; i++) {
        stepSimulation(clientA);
    }

    // B advances to frame 30, then "receives" late input and must rollback
    for (let i = 0; i < 30; i++) {
        stepSimulation(clientB);
    }
    const snapshotB = saveSnapshot(clientB);

    // B continues (predicting no change in input)
    for (let i = 0; i < 30; i++) {
        stepSimulation(clientB);
    }

    // B was already correct, so no rollback needed
    // Both should have same state
    const hashA = clientA.world.getStateHash();
    const hashB = clientB.world.getStateHash();

    if (hashA !== hashB) {
        console.log(`    Client hashes differ: A=${hashA}, B=${hashB}`);
    }

    return hashA === hashB;
});

test('Clients sync after receiving late input', () => {
    // Client A knows about input from frame 0
    // Client B receives input late (at frame 30)

    const clientA = createSimulation(12345);
    const clientB = createSimulation(12345);

    spawnCell(clientA, 1, 100, 100);
    spawnCell(clientB, 1, 100, 100);

    // A has the input from the start
    clientA.world.setInput(1, { target: { x: 500, y: 500 } });

    // B doesn't have input yet (stationary)
    // clientB has no input

    // Both advance to frame 30
    for (let i = 0; i < 30; i++) {
        stepSimulation(clientA);
        stepSimulation(clientB);
    }

    // At frame 30, B "receives" the input (which was originally for frame 0)
    // B must rollback to frame 0 and resimulate
    const snapshotB0 = saveSnapshot(clientB);

    // Actually, we need to save state at frame 0, not frame 30
    // Let's redo this test properly

    // Reset both clients
    seedRandom(12345);
    const cA = createSimulation(12345);
    seedRandom(12345);
    const cB = createSimulation(12345);

    spawnCell(cA, 1, 100, 100);
    spawnCell(cB, 1, 100, 100);

    // Save initial state for B's potential rollback
    const initialSnapshotB = saveSnapshot(cB);

    // A has input from start
    cA.world.setInput(1, { target: { x: 500, y: 500 } });

    // A advances to frame 60
    for (let i = 0; i < 60; i++) {
        stepSimulation(cA);
    }

    // B advances to frame 30 without input (wrong prediction)
    for (let i = 0; i < 30; i++) {
        stepSimulation(cB);
    }

    // B receives late input, rolls back to frame 0
    loadSnapshot(cB, initialSnapshotB);
    cB.world.setInput(1, { target: { x: 500, y: 500 } });

    // B resimulates to frame 60
    for (let i = 0; i < 60; i++) {
        stepSimulation(cB);
    }

    const hashA = cA.world.getStateHash();
    const hashB = cB.world.getStateHash();

    if (hashA !== hashB) {
        console.log(`    After rollback: A=${hashA}, B=${hashB}`);
    }

    return hashA === hashB;
});

// Test 5: Complex rollback scenario
console.log('\nTest 5: Complex Rollback');

test('Multiple rollbacks converge to same state', () => {
    // Two clients with delayed input delivery
    seedRandom(12345);
    const cA = createSimulation(12345);
    seedRandom(12345);
    const cB = createSimulation(12345);

    // Player 1 on client A, Player 2 on client B
    spawnCell(cA, 1, 100, 100);
    spawnCell(cA, 2, 500, 500);
    spawnCell(cB, 1, 100, 100);
    spawnCell(cB, 2, 500, 500);

    // Save snapshots periodically
    const snapshotsA: Snapshot[] = [];
    const snapshotsB: Snapshot[] = [];

    // Define inputs at specific frames
    const inputs: { frame: number; clientId: number; target: { x: number; y: number } }[] = [
        { frame: 0, clientId: 1, target: { x: 300, y: 300 } },
        { frame: 10, clientId: 2, target: { x: 300, y: 300 } },
        { frame: 20, clientId: 1, target: { x: 100, y: 500 } },
        { frame: 30, clientId: 2, target: { x: 500, y: 100 } },
    ];

    // A receives all inputs on time
    let inputIdx = 0;
    for (let frame = 0; frame < 60; frame++) {
        while (inputIdx < inputs.length && inputs[inputIdx].frame === frame) {
            const inp = inputs[inputIdx];
            cA.world.setInput(inp.clientId, { target: inp.target });
            inputIdx++;
        }
        stepSimulation(cA);
    }

    // B receives inputs with 10-frame delay, must rollback
    snapshotsB.push(saveSnapshot(cB));

    inputIdx = 0;
    for (let frame = 0; frame < 60; frame++) {
        // Receive inputs that are 10 frames old
        const delayedFrame = frame - 10;
        while (inputIdx < inputs.length && inputs[inputIdx].frame <= delayedFrame) {
            const inp = inputs[inputIdx];

            // Find snapshot at input frame
            const rollbackFrame = inputs[inputIdx].frame;

            // Simple approach: rollback to start and resimulate
            if (snapshotsB.length > 0 && rollbackFrame < frame) {
                const snap = snapshotsB[0]; // Use initial snapshot

                // Rollback
                loadSnapshot(cB, snap);

                // Apply all inputs up to this point
                let ridx = 0;
                while (ridx <= inputIdx) {
                    const rinp = inputs[ridx];
                    cB.world.setInput(rinp.clientId, { target: rinp.target });
                    ridx++;
                }

                // Resimulate to current frame
                for (let f = 0; f < frame; f++) {
                    stepSimulation(cB);
                }
            }

            cB.world.setInput(inp.clientId, { target: inp.target });
            inputIdx++;
        }

        stepSimulation(cB);
    }

    const hashA = cA.world.getStateHash();
    const hashB = cB.world.getStateHash();

    if (hashA !== hashB) {
        console.log(`    Complex scenario: A=${hashA}, B=${hashB}`);
    }

    return hashA === hashB;
});

// ============================================
// Summary
// ============================================

console.log('\n=== Results ===');
console.log(`Passed: ${passed}`);
console.log(`Failed: ${failed}`);

if (failed > 0) {
    console.log('\nROLLBACK ISSUES FOUND!');
    console.log('The rollback mechanism is causing desyncs.');
    process.exit(1);
} else {
    console.log('\nAll rollback tests passed!');
    process.exit(0);
}
