/**
 * Cell Eater - Agar.io style multiplayer game
 *
 * Build auto-transforms: Math.sqrt() -> dSqrt(), Math.random() -> dRandom()
 */

import {
    createGame,
    Game,
    Entity,
    Transform2D,
    Body2D,
    Player,
    Sprite,
    BODY_KINEMATIC,
    BODY_STATIC,
    SHAPE_CIRCLE,
    Simple2DRenderer,
    Physics2DSystem,
    InputPlugin,
    enableDebugUI,
} from 'modu-engine';

// ============================================
// Types
// ============================================

interface Camera {
    x: number;
    y: number;
    zoom: number;
    targetZoom: number;
    smoothing: number;
}

interface SpawnCellOptions {
    x?: number;
    y?: number;
    radius?: number;
    color?: string;
    vx?: number;
    vy?: number;
}

// ============================================
// Constants
// ============================================

const WORLD_WIDTH = 6000;
const WORLD_HEIGHT = 6000;

// Zoom settings
const BASE_ZOOM = 1.0;
const MIN_ZOOM = 0.35;
const ZOOM_SCALE_FACTOR = 0.004;

// Game constants
const SPEED = 200;
const INITIAL_RADIUS = 20;
const MAX_RADIUS = 200;
const EAT_RATIO = 1.2;
const FOOD_GROW = 0.05;
const PLAYER_GROW = 0.3;
const FOOD_COUNT = 800;
const MAX_FOOD = 1600;
const FOOD_SPAWN_CHANCE = 0.15;

// Split constants
const MIN_SPLIT_RADIUS = 15;
const SPLIT_VELOCITY = 15;
const MAX_CELLS_PER_PLAYER = 16;
const MERGE_DELAY_FRAMES = 600;

// Color palette
const COLORS = [
    '#ff6b6b', '#ff8e72', '#ffa94d', '#ffd43b', '#a9e34b', '#69db7c',
    '#38d9a9', '#3bc9db', '#4dabf7', '#748ffc', '#9775fa', '#da77f2',
    '#f783ac', '#e64980', '#d6336c', '#c2255c', '#ff4500', '#32cd32',
    '#1e90ff', '#ff1493', '#00ced1', '#ffa500', '#9400d3', '#00ff7f'
];

// ============================================
// Game State
// ============================================

let game: Game;
let renderer: Simple2DRenderer;
let physics: Physics2DSystem;
let input: InputPlugin;

let canvas: HTMLCanvasElement;
let minimapCanvas: HTMLCanvasElement;
let minimapCtx: CanvasRenderingContext2D;
let sizeDisplay: HTMLElement;
let WIDTH: number;
let HEIGHT: number;

const camera: Camera = {
    x: WORLD_WIDTH / 2,
    y: WORLD_HEIGHT / 2,
    zoom: 1,
    targetZoom: 1,
    smoothing: 0.08
};

let mouseX: number;
let mouseY: number;

// Track merge eligibility frame for each cell
const cellMergeFrame = new Map<number, number>();

// ============================================
// Helper Functions
// ============================================

function getLocalClientId(): number | null {
    const clientId = game.localClientId;
    if (!clientId || typeof clientId !== 'string') return null;
    return game.internClientId(clientId);
}

function getClientIdStr(numericId: number): string {
    return game.getClientIdString(numericId) || '';
}

function compareStrings(a: string, b: string): number {
    if (a < b) return -1;
    if (a > b) return 1;
    return 0;
}

function getPlayerCells(clientId: number): Entity[] {
    const cells: Entity[] = [];
    for (const cell of game.query('cell')) {
        if (cell.get(Player).clientId === clientId && !cell.destroyed) {
            cells.push(cell);
        }
    }
    return cells;
}

function spawnFood(): void {
    const colorStr = COLORS[(Math.random() * COLORS.length) | 0];
    const color = game.internString('color', colorStr);
    game.spawn('food', {
        x: 50 + (Math.random() * (WORLD_WIDTH - 100)) | 0,
        y: 50 + (Math.random() * (WORLD_HEIGHT - 100)) | 0,
        color
    });
}

function spawnCell(clientId: string, options: SpawnCellOptions = {}): Entity {
    const colorStr = options.color || COLORS[(Math.random() * COLORS.length) | 0];
    const color = game.internString('color', colorStr);
    const radius = options.radius || INITIAL_RADIUS;

    const entity = game.spawn('cell', {
        x: options.x ?? (100 + (Math.random() * (WORLD_WIDTH - 200)) | 0),
        y: options.y ?? (100 + (Math.random() * (WORLD_HEIGHT - 200)) | 0),
        clientId,
        color
    });

    if (options.radius) {
        const sprite = entity.get(Sprite);
        const body = entity.get(Body2D);
        sprite.radius = radius;
        body.radius = radius;
    }

    if (options.vx !== undefined || options.vy !== undefined) {
        const body = entity.get(Body2D);
        body.vx = options.vx || 0;
        body.vy = options.vy || 0;
    }

    return entity;
}

function worldToScreen(worldX: number, worldY: number): { x: number; y: number } {
    return {
        x: (worldX - camera.x) * camera.zoom + WIDTH / 2,
        y: (worldY - camera.y) * camera.zoom + HEIGHT / 2
    };
}

function lightenColor(hex: string, percent: number): string {
    const num = parseInt(hex.slice(1), 16);
    const r = Math.min(255, (num >> 16) + percent);
    const g = Math.min(255, ((num >> 8) & 0x00FF) + percent);
    const b = Math.min(255, (num & 0x0000FF) + percent);
    return `rgb(${r},${g},${b})`;
}

function darkenColor(hex: string, percent: number): string {
    const num = parseInt(hex.slice(1), 16);
    const r = Math.max(0, (num >> 16) - percent);
    const g = Math.max(0, ((num >> 8) & 0x00FF) - percent);
    const b = Math.max(0, (num & 0x0000FF) - percent);
    return `rgb(${r},${g},${b})`;
}

// ============================================
// Systems
// ============================================

function setupSystems(): void {
    // Movement system with integrated repulsion
    game.addSystem(() => {
        const playerCells = new Map<number, Entity[]>();
        const allCells = [...game.query('cell')].sort((a, b) => a.id - b.id);

        for (const cell of allCells) {
            if (cell.destroyed) continue;
            const cid = cell.get(Player).clientId;
            if (cid === undefined || cid === null) continue;
            if (!playerCells.has(cid)) playerCells.set(cid, []);
            playerCells.get(cid)!.push(cell);
        }

        const repulsion = new Map<number, { vx: number; vy: number }>();
        const sortedPlayers = [...playerCells.entries()].sort((a, b) =>
            compareStrings(getClientIdStr(a[0]), getClientIdStr(b[0]))
        );

        for (const [, siblings] of sortedPlayers) {
            for (const cell of siblings) {
                repulsion.set(cell.id, { vx: 0, vy: 0 });
            }

            if (siblings.length < 2) continue;

            for (let i = 0; i < siblings.length; i++) {
                const cellA = siblings[i];
                const tA = cellA.get(Transform2D);
                const sA = cellA.get(Sprite);

                for (let j = i + 1; j < siblings.length; j++) {
                    const cellB = siblings[j];
                    const tB = cellB.get(Transform2D);
                    const sB = cellB.get(Sprite);

                    const dx = tA.x - tB.x;
                    const dy = tA.y - tB.y;
                    const distSq = dx * dx + dy * dy;
                    const minDist = sA.radius + sB.radius;
                    const minDistSq = minDist * minDist;

                    if (distSq < minDistSq && distSq > 1) {
                        const dist = Math.sqrt(distSq) || 1;
                        const overlap = minDist - dist;
                        const pushForce = (overlap * 0.3) + 1;
                        const nx = dx / dist;
                        const ny = dy / dist;

                        const repA = repulsion.get(cellA.id)!;
                        const repB = repulsion.get(cellB.id)!;
                        repA.vx += nx * pushForce;
                        repA.vy += ny * pushForce;
                        repB.vx -= nx * pushForce;
                        repB.vy -= ny * pushForce;
                    }
                }
            }
        }

        for (const [clientId, cells] of sortedPlayers) {
            const playerInput = game.world.getInput(clientId);

            for (const cell of cells) {


            for (const cell of cells) {
                const sprite = cell.get(Sprite);
                const transform = cell.get(Transform2D);
                const body = cell.get(Body2D);

                let vx = 0, vy = 0;

                if (playerInput?.target) {
                    const dx = playerInput.target.x - transform.x;
                    const dy = playerInput.target.y - transform.y;
                    const distSq = dx * dx + dy * dy;
                    const dist = Math.sqrt(distSq) || 1;


                    // Stop only when very close to target
                    const stopDist = sprite.radius * 0.2;
                    if (dist > stopDist) {
                        vx = (dx / dist) * SPEED;
                        vy = (dy / dist) * SPEED;
                    }
                }

                const rep = repulsion.get(cell.id);
                if (rep) {
                    vx += rep.vx;
                    vy += rep.vy;
                }

                body.vx = vx;
                body.vy = vy;

                const r = sprite.radius;
                transform.x = Math.max(r, Math.min(WORLD_WIDTH - r, transform.x));
                transform.y = Math.max(r, Math.min(WORLD_HEIGHT - r, transform.y));
            }
        }
    }, { phase: 'update' });

    // Food spawning system
    game.addSystem(() => {
        const shouldSpawn = Math.random() < FOOD_SPAWN_CHANCE;
        if (shouldSpawn && game.getEntitiesByType('food').length < MAX_FOOD) {
            spawnFood();
        }
    }, { phase: 'update' });

    // Split system
    game.addSystem(() => {
        const playerCells = new Map<number, Entity[]>();
        const allCells = [...game.query('cell')].sort((a, b) => a.id - b.id);

        for (const cell of allCells) {
            if (cell.destroyed) continue;
            const clientId = cell.get(Player).clientId;
            if (clientId === undefined || clientId === null) continue;
            if (!playerCells.has(clientId)) playerCells.set(clientId, []);
            playerCells.get(clientId)!.push(cell);
        }

        const sortedPlayers = [...playerCells.entries()].sort((a, b) =>
            compareStrings(getClientIdStr(a[0]), getClientIdStr(b[0]))
        );

        for (const [clientId, cells] of sortedPlayers) {
            const playerInput = game.world.getInput(clientId);

            for (const cell of cells) {

            if (!playerInput?.split || !playerInput?.target) continue;
            if (cells.length >= MAX_CELLS_PER_PLAYER) continue;

            const cellsToSplit = cells
                .filter(c => c.get(Sprite).radius >= MIN_SPLIT_RADIUS)
                .slice(0, MAX_CELLS_PER_PLAYER - cells.length);

            for (const cell of cellsToSplit) {
                const transform = cell.get(Transform2D);
                const sprite = cell.get(Sprite);
                const body = cell.get(Body2D);
                const colorStr = game.getString('color', sprite.color);

                const dx = playerInput.target.x - transform.x;
                const dy = playerInput.target.y - transform.y;
                const dist = Math.sqrt(dx * dx + dy * dy);
                const dirX = dist > 0 ? dx / dist : 0;
                const dirY = dist > 0 ? dy / dist : 1;

                const newRadius = sprite.radius / Math.SQRT2;

                sprite.radius = newRadius;
                body.radius = newRadius;

                const clientIdStr = game.getClientIdString(clientId);
                if (!clientIdStr) continue;

                const newCell = spawnCell(clientIdStr, {
                    x: transform.x + dirX * newRadius * 2,
                    y: transform.y + dirY * newRadius * 2,
                    radius: newRadius,
                    color: colorStr,
                    vx: dirX * SPLIT_VELOCITY,
                    vy: dirY * SPLIT_VELOCITY
                });

                const mergeFrame = game.world.frame + MERGE_DELAY_FRAMES;
                cellMergeFrame.set(cell.id, mergeFrame);
                cellMergeFrame.set(newCell.id, mergeFrame);
            }
        }
    }, { phase: 'update' });

    // Merge system
    game.addSystem(() => {
        const currentFrame = game.world.frame;
        const playerCells = new Map<number, Entity[]>();
        const allCells = [...game.query('cell')].sort((a, b) => a.id - b.id);

        for (const cell of allCells) {
            if (cell.destroyed) continue;
            const clientId = cell.get(Player).clientId;
            if (clientId === undefined || clientId === null) continue;
            if (!playerCells.has(clientId)) playerCells.set(clientId, []);
            playerCells.get(clientId)!.push(cell);
        }

        const sortedPlayers = [...playerCells.entries()].sort((a, b) =>
            compareStrings(getClientIdStr(a[0]), getClientIdStr(b[0]))
        );

        for (const [, cells] of sortedPlayers) {
            if (cells.length < 2) continue;

            cells.sort((a, b) => {
                const radiusDiff = b.get(Sprite).radius - a.get(Sprite).radius;
                return radiusDiff !== 0 ? radiusDiff : a.id - b.id;
            });

            for (let i = 0; i < cells.length; i++) {
                const cellA = cells[i];
                if (cellA.destroyed) continue;

                const tA = cellA.get(Transform2D);
                const sA = cellA.get(Sprite);

                for (let j = i + 1; j < cells.length; j++) {
                    const cellB = cells[j];
                    if (cellB.destroyed) continue;

                    const mergeFrameA = cellMergeFrame.get(cellA.id) || 0;
                    const mergeFrameB = cellMergeFrame.get(cellB.id) || 0;
                    if (currentFrame < mergeFrameA || currentFrame < mergeFrameB) continue;

                    const tB = cellB.get(Transform2D);
                    const sB = cellB.get(Sprite);

                    const dx = tA.x - tB.x;
                    const dy = tA.y - tB.y;
                    const dist = Math.sqrt(dx * dx + dy * dy);
                    const mergeThreshold = (sA.radius + sB.radius) * 0.5;

                    if (dist < mergeThreshold) {
                        const areaA = sA.radius * sA.radius;
                        const areaB = sB.radius * sB.radius;
                        const newRadius = Math.min(Math.sqrt(areaA + areaB), MAX_RADIUS);

                        sA.radius = newRadius;
                        cellA.get(Body2D).radius = newRadius;
                        cellB.destroy();
                        cellMergeFrame.delete(cellB.id);
                    }
                }
            }
        }
    }, { phase: 'update' });
}

// ============================================
// Collision Handlers
// ============================================

function setupCollisions(): void {
    // Cell eats food
    physics.onCollision('cell', 'food', (cell, food) => {
        if (food.destroyed) return;
        const sprite = cell.get(Sprite);
        const foodSprite = food.get(Sprite);
        sprite.radius = Math.min(sprite.radius + foodSprite.radius * FOOD_GROW, MAX_RADIUS);
        cell.get(Body2D).radius = sprite.radius;
        food.destroy();
    });

    // Cell eats smaller cell (different players only)
    physics.onCollision('cell', 'cell', (cellA, cellB) => {
        if (cellA.get(Player).clientId === cellB.get(Player).clientId) return;

        const eaterSprite = cellA.get(Sprite);
        const preySprite = cellB.get(Sprite);
        if (eaterSprite.radius > preySprite.radius * EAT_RATIO) {
            eaterSprite.radius = Math.min(eaterSprite.radius + preySprite.radius * PLAYER_GROW, MAX_RADIUS);
            cellA.get(Body2D).radius = eaterSprite.radius;
            cellB.destroy();
            cellMergeFrame.delete(cellB.id);
        }
    });
}

// ============================================
// Camera & Rendering
// ============================================

function updateCamera(): void {
    const localId = getLocalClientId();
    if (localId === null) return;

    const cells = getPlayerCells(localId);
    if (cells.length === 0) return;

    let totalArea = 0;
    let centerX = 0;
    let centerY = 0;
    let totalRadius = 0;

    for (const cell of cells) {
        const transform = cell.get(Transform2D);
        const sprite = cell.get(Sprite);
        const area = sprite.radius * sprite.radius;

        centerX += transform.x * area;
        centerY += transform.y * area;
        totalArea += area;
        totalRadius += sprite.radius;
    }

    if (totalArea > 0) {
        centerX /= totalArea;
        centerY /= totalArea;

        camera.x += (centerX - camera.x) * 0.15;
        camera.y += (centerY - camera.y) * 0.15;

        const avgRadius = totalRadius / cells.length;
        camera.targetZoom = Math.max(MIN_ZOOM, BASE_ZOOM - (avgRadius - INITIAL_RADIUS) * ZOOM_SCALE_FACTOR);

        if (cells.length > 1) {
            let maxDist = 0;
            for (const cell of cells) {
                const t = cell.get(Transform2D);
                // Note: Math.sqrt OK here - this is render code, not simulation
                const dist = Math.sqrt((t.x - centerX) ** 2 + (t.y - centerY) ** 2);
                maxDist = Math.max(maxDist, dist);
            }
            const spreadZoom = Math.max(0.3, 1 - maxDist / 800);
            camera.targetZoom = Math.min(camera.targetZoom, spreadZoom);
        }

        camera.zoom += (camera.targetZoom - camera.zoom) * camera.smoothing;
    }
}

function renderWithCamera(): void {
    const ctx = renderer.context;
    const alpha = game.getRenderAlpha();

    updateCamera();

    let camX = camera.x, camY = camera.y;
    const localId = getLocalClientId();
    if (localId !== null) {
        const cells = getPlayerCells(localId);
        if (cells.length > 0) {
            let totalArea = 0;
            let centerX = 0;
            let centerY = 0;

            for (const cell of cells) {
                if (cell.destroyed || !cell.render) continue;
                cell.interpolate(alpha);
                const sprite = cell.get(Sprite);
                const area = sprite.radius * sprite.radius;
                centerX += cell.render.interpX * area;
                centerY += cell.render.interpY * area;
                totalArea += area;
            }

            if (totalArea > 0) {
                camX = centerX / totalArea;
                camY = centerY / totalArea;
            }
        }
    }

    // Clear canvas
    ctx.fillStyle = '#f2f2f2';
    ctx.fillRect(0, 0, WIDTH, HEIGHT);

    ctx.save();
    ctx.translate(WIDTH / 2, HEIGHT / 2);
    ctx.scale(camera.zoom, camera.zoom);
    ctx.translate(-camX, -camY);

    // Draw grid
    ctx.strokeStyle = '#e0e0e0';
    ctx.lineWidth = 1 / camera.zoom;
    const gridSize = 100;
    const startX = Math.floor((camX - WIDTH / 2 / camera.zoom) / gridSize) * gridSize;
    const startY = Math.floor((camY - HEIGHT / 2 / camera.zoom) / gridSize) * gridSize;
    const endX = camX + WIDTH / 2 / camera.zoom;
    const endY = camY + HEIGHT / 2 / camera.zoom;

    for (let x = startX; x <= endX; x += gridSize) {
        if (x >= 0 && x <= WORLD_WIDTH) {
            ctx.beginPath();
            ctx.moveTo(x, Math.max(0, startY));
            ctx.lineTo(x, Math.min(WORLD_HEIGHT, endY));
            ctx.stroke();
        }
    }
    for (let y = startY; y <= endY; y += gridSize) {
        if (y >= 0 && y <= WORLD_HEIGHT) {
            ctx.beginPath();
            ctx.moveTo(Math.max(0, startX), y);
            ctx.lineTo(Math.min(WORLD_WIDTH, endX), y);
            ctx.stroke();
        }
    }

    // Draw world boundary
    ctx.strokeStyle = '#ccc';
    ctx.lineWidth = 4 / camera.zoom;
    ctx.strokeRect(0, 0, WORLD_WIDTH, WORLD_HEIGHT);

    // Collect and sort entities by layer
    const entities: { entity: Entity; layer: number }[] = [];
    for (const entity of game.getAllEntities()) {
        if (entity.destroyed) continue;
        try {
            const sprite = entity.get(Sprite);
            if (sprite && sprite.visible) {
                entity.interpolate(alpha);
                entities.push({ entity, layer: sprite.layer });
            }
        } catch {}
    }
    entities.sort((a, b) => a.layer - b.layer);

    // Draw entities
    for (const { entity } of entities) {
        const sprite = entity.get(Sprite);
        const x = entity.render.interpX + sprite.offsetX;
        const y = entity.render.interpY + sprite.offsetY;

        const screenPos = worldToScreen(x, y);
        const screenRadius = sprite.radius * camera.zoom;
        if (screenPos.x + screenRadius < 0 || screenPos.x - screenRadius > WIDTH ||
            screenPos.y + screenRadius < 0 || screenPos.y - screenRadius > HEIGHT) {
            continue;
        }

        const colorStr = game.getString('color', sprite.color) || '#fff';

        if (sprite.shape === SHAPE_CIRCLE) {
            const r = sprite.radius;
            const isCell = sprite.layer === 1;

            if (isCell && r > 10) {
                const gradient = ctx.createRadialGradient(x - r * 0.3, y - r * 0.3, 0, x, y, r);
                gradient.addColorStop(0, lightenColor(colorStr, 40));
                gradient.addColorStop(0.7, colorStr);
                gradient.addColorStop(1, darkenColor(colorStr, 20));

                ctx.fillStyle = gradient;
                ctx.beginPath();
                ctx.arc(x, y, r, 0, Math.PI * 2);
                ctx.fill();

                ctx.strokeStyle = darkenColor(colorStr, 30);
                ctx.lineWidth = Math.max(2, r * 0.08);
                ctx.stroke();

                ctx.fillStyle = 'rgba(255, 255, 255, 0.3)';
                ctx.beginPath();
                ctx.arc(x - r * 0.25, y - r * 0.25, r * 0.25, 0, Math.PI * 2);
                ctx.fill();
            } else {
                ctx.fillStyle = colorStr;
                ctx.beginPath();
                ctx.arc(x, y, r, 0, Math.PI * 2);
                ctx.fill();
            }
        }
    }

    ctx.restore();

    renderMinimap();

    // Update size display
    if (localId !== null) {
        const cells = getPlayerCells(localId);
        const totalRadius = cells.reduce((sum, c) => sum + c.get(Sprite).radius, 0);
        sizeDisplay.textContent = `Size: ${Math.floor(totalRadius)}`;
    }
}

function renderMinimap(): void {
    const mmW = minimapCanvas.width;
    const mmH = minimapCanvas.height;
    const scaleX = mmW / WORLD_WIDTH;
    const scaleY = mmH / WORLD_HEIGHT;

    minimapCtx.fillStyle = 'rgba(17, 17, 17, 0.9)';
    minimapCtx.fillRect(0, 0, mmW, mmH);

    minimapCtx.strokeStyle = '#333';
    minimapCtx.lineWidth = 1;
    minimapCtx.strokeRect(0, 0, mmW, mmH);

    for (const entity of game.getAllEntities()) {
        if (entity.destroyed) continue;
        try {
            const sprite = entity.get(Sprite);
            if (!sprite || !sprite.visible) continue;

            const transform = entity.get(Transform2D);
            const x = transform.x * scaleX;
            const y = transform.y * scaleY;

            const isFood = sprite.layer === 0;
            const radius = isFood ? 1 : Math.max(3, sprite.radius * scaleX * 1.5);

            const colorStr = game.getString('color', sprite.color) || '#fff';
            minimapCtx.fillStyle = isFood ? 'rgba(255,255,255,0.3)' : colorStr;
            minimapCtx.beginPath();
            minimapCtx.arc(x, y, radius, 0, Math.PI * 2);
            minimapCtx.fill();
        } catch {}
    }

    const viewLeft = (camera.x - WIDTH / 2 / camera.zoom) * scaleX;
    const viewTop = (camera.y - HEIGHT / 2 / camera.zoom) * scaleY;
    const viewWidth = (WIDTH / camera.zoom) * scaleX;
    const viewHeight = (HEIGHT / camera.zoom) * scaleY;

    minimapCtx.strokeStyle = '#fff';
    minimapCtx.lineWidth = 1;
    minimapCtx.strokeRect(viewLeft, viewTop, viewWidth, viewHeight);

    const localId = getLocalClientId();
    if (localId !== null) {
        const cells = getPlayerCells(localId);
        for (const cell of cells) {
            if (cell.destroyed) continue;
            const transform = cell.get(Transform2D);
            const x = transform.x * scaleX;
            const y = transform.y * scaleY;

            minimapCtx.strokeStyle = '#fff';
            minimapCtx.lineWidth = 2;
            minimapCtx.beginPath();
            minimapCtx.arc(x, y, 5, 0, Math.PI * 2);
            minimapCtx.stroke();
        }
    }
}

// ============================================
// Input Setup
// ============================================

function setupInput(): void {
    mouseX = WIDTH / 2;
    mouseY = HEIGHT / 2;

    canvas.addEventListener('mousemove', (e) => {
        const rect = canvas.getBoundingClientRect();
        mouseX = e.clientX - rect.left;
        mouseY = e.clientY - rect.top;
    });

    input.action('target', {
        type: 'vector',
        bindings: [() => {
            const worldX = (mouseX - WIDTH / 2) / camera.zoom + camera.x;
            const worldY = (mouseY - HEIGHT / 2) / camera.zoom + camera.y;
            return { x: worldX, y: worldY };
        }]
    });

    input.action('split', {
        type: 'button',
        bindings: ['key: ']
    });
}

// ============================================
// Entity Definitions
// ============================================

function defineEntities(): void {
    game.defineEntity('cell')
        .with(Transform2D)
        .with(Sprite, { shape: SHAPE_CIRCLE, radius: INITIAL_RADIUS, layer: 1 })
        .with(Body2D, { shapeType: SHAPE_CIRCLE, radius: INITIAL_RADIUS, bodyType: BODY_KINEMATIC })
        .with(Player)
        .register();

    game.defineEntity('food')
        .with(Transform2D)
        .with(Sprite, { shape: SHAPE_CIRCLE, radius: 8, layer: 0 })
        .with(Body2D, { shapeType: SHAPE_CIRCLE, radius: 8, bodyType: BODY_STATIC })
        .register();
}

// ============================================
// Main Entry Point
// ============================================

export function initGame(): void {
    canvas = document.getElementById('game') as HTMLCanvasElement;
    minimapCanvas = document.getElementById('minimap') as HTMLCanvasElement;
    minimapCtx = minimapCanvas.getContext('2d')!;
    sizeDisplay = document.getElementById('size-display')!;
    WIDTH = canvas.width;
    HEIGHT = canvas.height;

    game = createGame();
    renderer = game.addPlugin(Simple2DRenderer, canvas);
    physics = game.addPlugin(Physics2DSystem, { gravity: { x: 0, y: 0 } });
    input = game.addPlugin(InputPlugin, canvas);

    // Expose for debugging
    (window as any).game = game;

    defineEntities();
    setupCollisions();
    setupSystems();
    setupInput();

    renderer.render = renderWithCamera;

    game.connect('cell-eater-ecs', {
        onRoomCreate() {
            console.log('[cell-eater] onRoomCreate');
            for (let i = 0; i < FOOD_COUNT; i++) spawnFood();
        },
        onConnect(clientId: string) {
            console.log('[cell-eater] onConnect:', clientId);
            spawnCell(clientId);

            if (clientId === game.localClientId) {
                const player = game.getEntityByClientId(clientId);
                if (player) {
                    const t = player.get(Transform2D);
                    camera.x = t.x;
                    camera.y = t.y;
                }
            }
        },
        onDisconnect(clientId: string) {
            console.log('[cell-eater] onDisconnect:', clientId);
            const internedId = game.internClientId(clientId);
            for (const cell of getPlayerCells(internedId)) {
                cell.destroy();
                cellMergeFrame.delete(cell.id);
            }
        }
    });

    enableDebugUI(game);
}

// Auto-init when DOM is ready
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initGame);
} else {
    initGame();
}
