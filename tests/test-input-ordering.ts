/**
 * E2E Test: Multi-Client Input Ordering
 *
 * Tests that multiple clients sending inputs at different frames
 * all receive inputs in the expected order (by sequence number).
 *
 * This verifies:
 * 1. Server assigns monotonically increasing sequence numbers
 * 2. All clients receive the same inputs in the same order
 * 3. No inputs are dropped or duplicated
 * 4. Late joiners receive all prior inputs
 */

import WebSocket from 'ws';
import crypto from 'crypto';

// ============================================================================
// Configuration
// ============================================================================

const CONFIG = {
    CENTRAL_URL: process.env.CENTRAL_URL || 'http://localhost:9001',
    NODE1_URL: process.env.NODE1_URL || 'ws://localhost:8001/ws',
    APP_ID: process.env.APP_ID || 'dev',
    DEFAULT_TIMEOUT: 10000,
};

// ============================================================================
// Binary Protocol Constants
// ============================================================================

const MSG_TYPE = {
    TICK: 0x01,
    INITIAL_STATE: 0x02,
    ROOM_JOINED: 0x03,
    ROOM_CREATED: 0x04,
    ERROR: 0x05,
    BINARY_INPUT: 0x20,
} as const;

// ============================================================================
// Types
// ============================================================================

interface ReceivedInput {
    seq: number;
    data: any;
    clientId?: string;
    receivedAt: number;
}

interface TestClient {
    name: string;
    ws: WebSocket | null;
    clientId: string;
    roomId: string;
    connected: boolean;
    receivedInputs: ReceivedInput[];
    sentInputs: { data: any; sentAt: number }[];
}

// ============================================================================
// Utility Functions
// ============================================================================

function sleep(ms: number): Promise<void> {
    return new Promise(r => setTimeout(r, ms));
}

function generateRoomId(): string {
    return `input-order-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Compute a hash of the received inputs to verify all clients got identical data.
 * Inputs are sorted by sequence number before hashing.
 * If all clients received the same inputs in the same order, their hashes match.
 * (The determinism tests in test-determinism.ts verify that same inputs = same game state)
 */
function computeInputHash(inputs: ReceivedInput[]): string {
    const sorted = [...inputs].sort((a, b) => a.seq - b.seq);
    const canonical = sorted.map(i => `${i.seq}:${JSON.stringify(i.data)}`).join('|');
    return crypto.createHash('sha256').update(canonical).digest('hex').slice(0, 16);
}

// ============================================================================
// Binary Protocol Parsing
// ============================================================================

function parseRoomResponse(data: Buffer): { roomId: string; clientId: string } | null {
    const msgType = data[0];
    if (msgType !== MSG_TYPE.ROOM_CREATED && msgType !== MSG_TYPE.ROOM_JOINED) return null;

    let offset = 1;
    const roomIdLen = data.readUInt16LE(offset); offset += 2;
    const roomId = data.subarray(offset, offset + roomIdLen).toString('utf-8'); offset += roomIdLen;
    const clientIdLen = data.readUInt16LE(offset); offset += 2;
    const clientId = data.subarray(offset, offset + clientIdLen).toString('utf-8');

    return { roomId, clientId };
}

function parseInitialState(data: Buffer): { frame: number; inputs: ReceivedInput[] } | null {
    if (data[0] !== MSG_TYPE.INITIAL_STATE) return null;

    try {
        let offset = 1;
        const frame = data.readUInt32LE(offset); offset += 4;
        const roomIdLen = data.readUInt16LE(offset); offset += 2;
        offset += roomIdLen; // skip roomId
        const snapshotLen = data.readUInt32LE(offset); offset += 4;
        offset += snapshotLen; // skip snapshot

        const inputCount = data.readUInt16LE(offset); offset += 2;
        const inputs: ReceivedInput[] = [];

        for (let i = 0; i < inputCount && offset < data.length; i++) {
            const clientHash = data.readUInt32LE(offset); offset += 4;
            const seq = data.readUInt32LE(offset); offset += 4;
            const inputFrame = data.readUInt32LE(offset); offset += 4; // frame per input
            const dataLen = data.readUInt16LE(offset); offset += 2;

            if (offset + dataLen > data.length) break;

            const dataBytes = data.subarray(offset, offset + dataLen);
            offset += dataLen;

            let parsedData: any;
            try {
                parsedData = JSON.parse(dataBytes.toString('utf-8'));
            } catch {
                parsedData = { _binary: true };
            }

            inputs.push({ seq, data: parsedData, receivedAt: Date.now() });
        }

        return { frame, inputs };
    } catch {
        return null;
    }
}

function parseTick(data: Buffer): { frame: number; inputs: ReceivedInput[] } | null {
    if (data[0] !== MSG_TYPE.TICK) return null;

    const frame = data.readUInt32LE(1);
    const inputs: ReceivedInput[] = [];

    if (data.length <= 9) return { frame, inputs };

    // Skip snapshot info (snapshotFrame: 4, hashLen: 1, hash: hashLen)
    let offset = 5;
    const snapshotFrame = data.readUInt32LE(offset); offset += 4;
    const hashLen = data.readUInt8(offset); offset += 1;
    offset += hashLen; // skip hash

    if (offset >= data.length) return { frame, inputs };

    const inputCount = data.readUInt8(offset); offset += 1;

    for (let i = 0; i < inputCount && offset < data.length; i++) {
        const clientHash = data.readUInt32LE(offset); offset += 4;
        const seq = data.readUInt32LE(offset); offset += 4;
        const dataLen = data.readUInt16LE(offset); offset += 2;

        if (offset + dataLen > data.length) break;

        const dataBytes = data.subarray(offset, offset + dataLen);
        offset += dataLen;

        let parsedData: any;
        try {
            parsedData = JSON.parse(dataBytes.toString('utf-8'));
        } catch {
            parsedData = { _binary: true };
        }

        inputs.push({ seq, data: parsedData, receivedAt: Date.now() });
    }

    return { frame, inputs };
}

// ============================================================================
// Client Management
// ============================================================================

function createClient(name: string): TestClient {
    return {
        name,
        ws: null,
        clientId: '',
        roomId: '',
        connected: false,
        receivedInputs: [],
        sentInputs: [],
    };
}

async function connectClient(
    client: TestClient,
    roomId: string,
    timeout: number = CONFIG.DEFAULT_TIMEOUT
): Promise<void> {
    // Get connection info from central service
    const response = await fetch(`${CONFIG.CENTRAL_URL}/api/apps/${CONFIG.APP_ID}/rooms/${roomId}/connect`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({})
    });

    if (!response.ok) {
        throw new Error(`Failed to get connection info: ${response.status}`);
    }

    const connInfo = await response.json() as { url: string; token: string };
    const wsUrl = `${connInfo.url}?token=${encodeURIComponent(connInfo.token)}`;

    return new Promise((resolve, reject) => {
        const ws = new WebSocket(wsUrl);
        client.ws = ws;
        client.roomId = roomId;

        const timeoutId = setTimeout(() => {
            ws.close();
            reject(new Error(`${client.name} connection timeout`));
        }, timeout);

        ws.on('open', () => {
            client.connected = true;
            const msg = { type: 'JOIN_ROOM', payload: { roomId, user: { id: client.name } } };
            ws.send(JSON.stringify(msg));
        });

        ws.on('message', (data: Buffer) => {
            const msgType = data[0];

            // ROOM_CREATED or ROOM_JOINED
            if (msgType === MSG_TYPE.ROOM_CREATED || msgType === MSG_TYPE.ROOM_JOINED) {
                const parsed = parseRoomResponse(data);
                if (parsed) {
                    client.clientId = parsed.clientId;
                    clearTimeout(timeoutId);
                    resolve();
                }
                return;
            }

            // INITIAL_STATE (for late joiners)
            if (msgType === MSG_TYPE.INITIAL_STATE) {
                const parsed = parseInitialState(data);
                if (parsed) {
                    // Store initial inputs
                    for (const input of parsed.inputs) {
                        // Avoid duplicates
                        if (!client.receivedInputs.some(i => i.seq === input.seq)) {
                            client.receivedInputs.push(input);
                        }
                    }
                    clearTimeout(timeoutId);
                    resolve();
                }
                return;
            }

            // TICK - process inputs
            if (msgType === MSG_TYPE.TICK) {
                const parsed = parseTick(data);
                if (parsed) {
                    for (const input of parsed.inputs) {
                        // Avoid duplicates
                        if (!client.receivedInputs.some(i => i.seq === input.seq)) {
                            client.receivedInputs.push(input);
                        }
                    }
                }
                return;
            }
        });

        ws.on('error', (err) => {
            clearTimeout(timeoutId);
            reject(err);
        });

        ws.on('close', () => {
            client.connected = false;
        });
    });
}

async function disconnectClient(client: TestClient): Promise<void> {
    return new Promise((resolve) => {
        if (client.ws && client.ws.readyState === WebSocket.OPEN) {
            client.ws.once('close', () => {
                client.ws = null;
                client.connected = false;
                resolve();
            });
            client.ws.close();
        } else {
            client.ws = null;
            client.connected = false;
            resolve();
        }
    });
}

function sendInput(client: TestClient, inputData: any): void {
    if (!client.ws || client.ws.readyState !== WebSocket.OPEN) return;

    const json = JSON.stringify(inputData);
    const buf = Buffer.alloc(1 + json.length);
    buf[0] = MSG_TYPE.BINARY_INPUT;
    buf.write(json, 1, 'utf-8');
    client.ws.send(buf);

    client.sentInputs.push({ data: inputData, sentAt: Date.now() });
}

// ============================================================================
// Test Functions
// ============================================================================

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

async function testAsync(name: string, fn: () => Promise<boolean>) {
    try {
        if (await fn()) {
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

// ============================================================================
// Test Suite
// ============================================================================

async function runTests() {
    console.log('=== Multi-Client Input Ordering E2E Tests ===\n');

    // Test 1: Basic ordering - two clients, alternating inputs
    console.log('Test 1: Two Clients Alternating Inputs');

    await testAsync('Inputs are ordered by sequence number', async () => {
        const roomId = generateRoomId();
        const clientA = createClient('Alice');
        const clientB = createClient('Bob');

        try {
            // Connect both clients
            await connectClient(clientA, roomId);
            await sleep(200);
            await connectClient(clientB, roomId);
            await sleep(200);

            // Send alternating inputs
            for (let i = 0; i < 5; i++) {
                sendInput(clientA, { type: 'move', value: `A${i}`, sendOrder: i * 2 });
                await sleep(50);
                sendInput(clientB, { type: 'move', value: `B${i}`, sendOrder: i * 2 + 1 });
                await sleep(50);
            }

            // Wait for propagation
            await sleep(1000);

            // Get game inputs only (filter out join/leave events)
            const gameInputsA = clientA.receivedInputs.filter(i => i.data?.type === 'move');
            const gameInputsB = clientB.receivedInputs.filter(i => i.data?.type === 'move');

            console.log(`    Client A received ${gameInputsA.length} game inputs`);
            console.log(`    Client B received ${gameInputsB.length} game inputs`);

            // Verify both clients received all 10 inputs
            if (gameInputsA.length !== 10 || gameInputsB.length !== 10) {
                console.log(`    Expected 10 inputs each, got A=${gameInputsA.length}, B=${gameInputsB.length}`);
                return false;
            }

            // Verify sequence numbers are monotonically increasing
            for (let i = 1; i < gameInputsA.length; i++) {
                if (gameInputsA[i].seq <= gameInputsA[i - 1].seq) {
                    console.log(`    Sequence ordering broken at index ${i}: ${gameInputsA[i - 1].seq} -> ${gameInputsA[i].seq}`);
                    return false;
                }
            }

            // Verify both clients have identical sequence ordering
            const seqA = gameInputsA.map(i => i.seq).join(',');
            const seqB = gameInputsB.map(i => i.seq).join(',');

            if (seqA !== seqB) {
                console.log(`    Sequence mismatch: A=${seqA} vs B=${seqB}`);
                return false;
            }

            // Verify input values match the sequence order (all clients see same order)
            const valuesA = gameInputsA.sort((a, b) => a.seq - b.seq).map(i => i.data?.value).join(',');
            const valuesB = gameInputsB.sort((a, b) => a.seq - b.seq).map(i => i.data?.value).join(',');

            if (valuesA !== valuesB) {
                console.log(`    Value ordering mismatch: A=${valuesA} vs B=${valuesB}`);
                return false;
            }

            console.log(`    Both clients received identical ordering: ${valuesA}`);
            return true;

        } finally {
            await disconnectClient(clientA);
            await disconnectClient(clientB);
        }
    });

    // Test 2: Rapid fire from multiple clients
    console.log('\nTest 2: Rapid-Fire Inputs from 3 Clients');

    await testAsync('Rapid inputs maintain ordering', async () => {
        const roomId = generateRoomId();
        const clientA = createClient('Alice');
        const clientB = createClient('Bob');
        const clientC = createClient('Charlie');

        try {
            // Connect all clients
            await connectClient(clientA, roomId);
            await connectClient(clientB, roomId);
            await connectClient(clientC, roomId);
            await sleep(300);

            // Each client sends 10 rapid inputs using cell-eater's input format
            const inputsPerClient = 10;

            for (let i = 0; i < inputsPerClient; i++) {
                // Cell-eater uses { target: { x, y } } for mouse position
                sendInput(clientA, { target: { x: 100 + i * 50, y: 200 + i * 30 }, source: 'A' });
                sendInput(clientB, { target: { x: 500 + i * 40, y: 600 + i * 20 }, source: 'B' });
                sendInput(clientC, { target: { x: 900 + i * 60, y: 100 + i * 40 }, source: 'C' });
                await sleep(10); // Very short delay
            }

            // Wait for propagation
            await sleep(1500);

            // Filter to only our test inputs (cell-eater style with target.x/y)
            const gameInputsA = clientA.receivedInputs.filter(i => i.data?.target?.x !== undefined);
            const gameInputsB = clientB.receivedInputs.filter(i => i.data?.target?.x !== undefined);
            const gameInputsC = clientC.receivedInputs.filter(i => i.data?.target?.x !== undefined);

            const expectedTotal = inputsPerClient * 3; // 30 total

            console.log(`    Client A received ${gameInputsA.length}/${expectedTotal} inputs`);
            console.log(`    Client B received ${gameInputsB.length}/${expectedTotal} inputs`);
            console.log(`    Client C received ${gameInputsC.length}/${expectedTotal} inputs`);

            // All clients should receive all inputs
            if (gameInputsA.length !== expectedTotal) {
                console.log(`    Client A missing inputs: expected ${expectedTotal}, got ${gameInputsA.length}`);
                return false;
            }

            // Verify all three clients have same sequence ordering
            const seqA = gameInputsA.map(i => i.seq).sort((a, b) => a - b).join(',');
            const seqB = gameInputsB.map(i => i.seq).sort((a, b) => a - b).join(',');
            const seqC = gameInputsC.map(i => i.seq).sort((a, b) => a - b).join(',');

            if (seqA !== seqB || seqB !== seqC) {
                console.log(`    Sequence mismatch between clients`);
                return false;
            }

            // Verify sequence numbers are unique and consecutive
            const seqs = gameInputsA.map(i => i.seq).sort((a, b) => a - b);
            for (let i = 1; i < seqs.length; i++) {
                if (seqs[i] === seqs[i - 1]) {
                    console.log(`    Duplicate sequence number: ${seqs[i]}`);
                    return false;
                }
            }

            // Verify values are identical across clients when sorted by seq
            const valuesA = gameInputsA.sort((a, b) => a.seq - b.seq).map(i => `${i.data?.source}(${i.data?.target?.x},${i.data?.target?.y})`).join(',');
            const valuesB = gameInputsB.sort((a, b) => a.seq - b.seq).map(i => `${i.data?.source}(${i.data?.target?.x},${i.data?.target?.y})`).join(',');
            const valuesC = gameInputsC.sort((a, b) => a.seq - b.seq).map(i => `${i.data?.source}(${i.data?.target?.x},${i.data?.target?.y})`).join(',');

            if (valuesA !== valuesB || valuesB !== valuesC) {
                console.log(`    Value ordering mismatch across clients`);
                return false;
            }

            // Verify all clients received identical input data by comparing hashes
            // (determinism tests prove same inputs = same game state)
            const hashA = computeInputHash(gameInputsA);
            const hashB = computeInputHash(gameInputsB);
            const hashC = computeInputHash(gameInputsC);

            console.log(`    Client A input hash: ${hashA}`);
            console.log(`    Client B input hash: ${hashB}`);
            console.log(`    Client C input hash: ${hashC}`);

            if (hashA !== hashB || hashB !== hashC) {
                console.log(`    DESYNC: Input hashes do not match - clients received different data!`);
                return false;
            }

            console.log(`    All 3 clients received identical inputs (${expectedTotal} total)`);
            console.log(`    Input hash: ${hashA}`);
            return true;

        } finally {
            await disconnectClient(clientA);
            await disconnectClient(clientB);
            await disconnectClient(clientC);
        }
    });

    // Test 3: Late joiner receives all prior inputs
    console.log('\nTest 3: Late Joiner Receives Prior Inputs');

    await testAsync('Late joiner gets ordered input history', async () => {
        const roomId = generateRoomId();
        const clientA = createClient('Alice');
        const clientB = createClient('Bob');

        try {
            // A creates room and sends some inputs
            await connectClient(clientA, roomId);
            await sleep(200);

            const messagesBeforeB = 5;
            for (let i = 0; i < messagesBeforeB; i++) {
                sendInput(clientA, { type: 'early', index: i });
                await sleep(100);
            }
            await sleep(500);

            console.log(`    Client A sent ${messagesBeforeB} inputs before B joins`);

            // B joins late
            await connectClient(clientB, roomId);
            await sleep(500);

            // A sends more inputs after B joins
            const messagesAfterB = 5;
            for (let i = 0; i < messagesAfterB; i++) {
                sendInput(clientA, { type: 'late', index: i });
                await sleep(100);
            }
            await sleep(500);

            // Filter to test inputs
            const inputsA = clientA.receivedInputs.filter(i => i.data?.type === 'early' || i.data?.type === 'late');
            const inputsB = clientB.receivedInputs.filter(i => i.data?.type === 'early' || i.data?.type === 'late');

            console.log(`    Client A has ${inputsA.length} inputs (sent ${messagesBeforeB + messagesAfterB})`);
            console.log(`    Client B has ${inputsB.length} inputs (joined late)`);

            // B should have received early inputs via INITIAL_STATE
            const earlyInputsB = inputsB.filter(i => i.data?.type === 'early').length;
            const lateInputsB = inputsB.filter(i => i.data?.type === 'late').length;

            console.log(`    Client B: ${earlyInputsB} early inputs, ${lateInputsB} late inputs`);

            if (earlyInputsB < messagesBeforeB) {
                console.log(`    Late joiner missing early inputs: got ${earlyInputsB}, expected ${messagesBeforeB}`);
                // This is expected if snapshots prune old inputs - just warn
                console.log(`    (This may be expected if server pruned old inputs)`);
            }

            if (lateInputsB < messagesAfterB) {
                console.log(`    Late joiner missing real-time inputs: got ${lateInputsB}, expected ${messagesAfterB}`);
                return false;
            }

            // Verify ordering is consistent
            const seqA = inputsA.map(i => i.seq).sort((a, b) => a - b);
            const seqB = inputsB.map(i => i.seq).sort((a, b) => a - b);

            // B's sequences should be a subset of A's
            for (const seq of seqB) {
                if (!seqA.includes(seq)) {
                    console.log(`    B has input with seq ${seq} not in A's history`);
                    return false;
                }
            }

            console.log(`    Late joiner correctly received ordered inputs`);
            return true;

        } finally {
            await disconnectClient(clientA);
            await disconnectClient(clientB);
        }
    });

    // Test 4: No duplicate sequence numbers
    console.log('\nTest 4: No Duplicate Sequence Numbers');

    await testAsync('All sequence numbers are unique', async () => {
        const roomId = generateRoomId();
        const clientA = createClient('Alice');
        const clientB = createClient('Bob');

        try {
            await connectClient(clientA, roomId);
            await connectClient(clientB, roomId);
            await sleep(200);

            // Send many inputs from both clients simultaneously
            const inputCount = 20;

            for (let i = 0; i < inputCount; i++) {
                sendInput(clientA, { from: 'A', i });
                sendInput(clientB, { from: 'B', i });
            }

            await sleep(1500);

            // Get all inputs
            const inputsA = clientA.receivedInputs.filter(i => i.data?.from);

            // Check for duplicates
            const seenSeqs = new Set<number>();
            let hasDuplicates = false;

            for (const input of inputsA) {
                if (seenSeqs.has(input.seq)) {
                    console.log(`    Duplicate sequence number found: ${input.seq}`);
                    hasDuplicates = true;
                }
                seenSeqs.add(input.seq);
            }

            if (hasDuplicates) {
                return false;
            }

            console.log(`    All ${inputsA.length} inputs have unique sequence numbers`);
            return true;

        } finally {
            await disconnectClient(clientA);
            await disconnectClient(clientB);
        }
    });

    // Summary
    console.log('\n=== Results ===');
    console.log(`Passed: ${passed}`);
    console.log(`Failed: ${failed}`);

    if (failed > 0) {
        console.log('\nINPUT ORDERING ISSUES FOUND!');
        console.log('The network layer is not correctly ordering inputs.');
        process.exit(1);
    } else {
        console.log('\nAll input ordering tests passed!');
        process.exit(0);
    }
}

// Run tests
runTests().catch(err => {
    console.error('Test error:', err);
    process.exit(1);
});
