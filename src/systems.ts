/**
 * Cell Eater - Game Systems
 */

import * as modu from 'modu-engine';
import { SpawnCellOptions } from './types';
import {
    WORLD_WIDTH,
    WORLD_HEIGHT,
    SPEED,
    INITIAL_RADIUS,
    MAX_RADIUS,
    EAT_RATIO,
    FOOD_GROW,
    PLAYER_GROW,
    MAX_FOOD,
    FOOD_SPAWN_CHANCE,
    MIN_SPLIT_RADIUS,
    SPLIT_VELOCITY,
    SPLIT_CONTROL_DELAY,
    MAX_CELLS_PER_PLAYER,
    MERGE_DELAY_FRAMES,
    COLORS,
} from './constants';

// Track merge eligibility frame for each cell
export const cellMergeFrame = new Map<number, number>();
export const cellSplitFrame = new Map<number, number>();

// Helper functions
function getClientIdStr(game: modu.Game, numericId: number): string {
    return game.getClientIdString(numericId) || '';
}

function compareStrings(a: string, b: string): number {
    if (a < b) return -1;
    if (a > b) return 1;
    return 0;
}

export function getPlayerCells(game: modu.Game, clientId: number): modu.Entity[] {
    const cells: modu.Entity[] = [];
    for (const cell of game.query('cell')) {
        if (cell.get(modu.Player).clientId === clientId && !cell.destroyed) {
            cells.push(cell);
        }
    }
    return cells;
}

export function spawnFood(game: modu.Game): void {
    const colorStr = COLORS[(Math.random() * COLORS.length) | 0];
    const color = game.internString('color', colorStr);
    game.spawn('food', {
        x: 50 + (Math.random() * (WORLD_WIDTH - 100)) | 0,
        y: 50 + (Math.random() * (WORLD_HEIGHT - 100)) | 0,
        color
    });
}

export function spawnCell(game: modu.Game, clientId: string, options: SpawnCellOptions = {}): modu.Entity {
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
        const sprite = entity.get(modu.Sprite);
        const body = entity.get(modu.Body2D);
        sprite.radius = radius;
        body.radius = radius;
    }

    if (options.vx !== undefined || options.vy !== undefined) {
        const body = entity.get(modu.Body2D);
        body.vx = options.vx || 0;
        body.vy = options.vy || 0;
    }

    return entity;
}

export function setupSystems(game: modu.Game): void {
    // Movement system with integrated repulsion
    game.addSystem(() => {
        const playerCells = new Map<number, modu.Entity[]>();
        const allCells = [...game.query('cell')].sort((a, b) => a.id - b.id);

        for (const cell of allCells) {
            if (cell.destroyed) continue;
            const cid = cell.get(modu.Player).clientId;
            if (cid === undefined || cid === null) continue;
            if (!playerCells.has(cid)) playerCells.set(cid, []);
            playerCells.get(cid)!.push(cell);
        }

        // DEBUG: Log cell counts
        if (game.world.frame % 60 === 0) {
            for (const [cid, cells] of playerCells) {
                if (cells.length > 1) console.log(`[SPLIT] cid=${cid} cells=${cells.length}`);
            }
        }

        const repulsion = new Map<number, { vx: number; vy: number }>();
        const sortedPlayers = [...playerCells.entries()].sort((a, b) =>
            compareStrings(getClientIdStr(game, a[0]), getClientIdStr(game, b[0]))
        );

        for (const [, siblings] of sortedPlayers) {
            for (const cell of siblings) {
                repulsion.set(cell.id, { vx: 0, vy: 0 });
            }

            if (siblings.length < 2) continue;

            for (let i = 0; i < siblings.length; i++) {
                const cellA = siblings[i];
                const tA = cellA.get(modu.Transform2D);
                const sA = cellA.get(modu.Sprite);

                for (let j = i + 1; j < siblings.length; j++) {
                    const cellB = siblings[j];
                    const tB = cellB.get(modu.Transform2D);
                    const sB = cellB.get(modu.Sprite);

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
                const sprite = cell.get(modu.Sprite);
                const transform = cell.get(modu.Transform2D);
                const body = cell.get(modu.Body2D);

                let vx = 0, vy = 0;

                if (playerInput?.target) {
                    const dx = playerInput.target.x - transform.x;
                    const dy = playerInput.target.y - transform.y;
                    const distSq = dx * dx + dy * dy;
                    const dist = Math.sqrt(distSq) || 1;

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

                // Don't override velocity for recently split cells
                const splitFrame = cellSplitFrame.get(cell.id) || 0;
                const framesSinceSplit = game.world.frame - splitFrame;
                if (framesSinceSplit > SPLIT_CONTROL_DELAY) {
                    body.vx = vx;
                    body.vy = vy;
                }

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
            spawnFood(game);
        }
    }, { phase: 'update' });

    // Split system
    game.addSystem(() => {
        const playerCells = new Map<number, modu.Entity[]>();
        const allCells = [...game.query('cell')].sort((a, b) => a.id - b.id);

        for (const cell of allCells) {
            if (cell.destroyed) continue;
            const clientId = cell.get(modu.Player).clientId;
            if (clientId === undefined || clientId === null) continue;
            if (!playerCells.has(clientId)) playerCells.set(clientId, []);
            playerCells.get(clientId)!.push(cell);
        }

        const sortedPlayers = [...playerCells.entries()].sort((a, b) =>
            compareStrings(getClientIdStr(game, a[0]), getClientIdStr(game, b[0]))
        );

        for (const [clientId, cells] of sortedPlayers) {
            const playerInput = game.world.getInput(clientId);

            if (!playerInput?.split || !playerInput?.target) continue;
            if (cells.length >= MAX_CELLS_PER_PLAYER) continue;

            const cellsToSplit = cells
                .filter(c => c.get(modu.Sprite).radius >= MIN_SPLIT_RADIUS)
                .slice(0, MAX_CELLS_PER_PLAYER - cells.length);

            for (const cell of cellsToSplit) {
                const transform = cell.get(modu.Transform2D);
                const sprite = cell.get(modu.Sprite);
                const body = cell.get(modu.Body2D);
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

                const newCell = spawnCell(game, clientIdStr, {
                    x: transform.x + dirX * newRadius * 2,
                    y: transform.y + dirY * newRadius * 2,
                    radius: newRadius,
                    color: colorStr,
                    vx: dirX * SPLIT_VELOCITY,
                    vy: dirY * SPLIT_VELOCITY
                });

                const mergeFrame = game.world.frame + MERGE_DELAY_FRAMES;
                cellMergeFrame.set(cell.id, mergeFrame);
                cellSplitFrame.set(cell.id, game.world.frame);
                cellMergeFrame.set(newCell.id, mergeFrame);
                cellSplitFrame.set(newCell.id, game.world.frame);
            }
        }
    }, { phase: 'update' });

    // Merge system
    game.addSystem(() => {
        const currentFrame = game.world.frame;
        const playerCells = new Map<number, modu.Entity[]>();
        const allCells = [...game.query('cell')].sort((a, b) => a.id - b.id);

        for (const cell of allCells) {
            if (cell.destroyed) continue;
            const clientId = cell.get(modu.Player).clientId;
            if (clientId === undefined || clientId === null) continue;
            if (!playerCells.has(clientId)) playerCells.set(clientId, []);
            playerCells.get(clientId)!.push(cell);
        }

        const sortedPlayers = [...playerCells.entries()].sort((a, b) =>
            compareStrings(getClientIdStr(game, a[0]), getClientIdStr(game, b[0]))
        );

        for (const [, cells] of sortedPlayers) {
            if (cells.length < 2) continue;

            cells.sort((a, b) => {
                const radiusDiff = b.get(modu.Sprite).radius - a.get(modu.Sprite).radius;
                return radiusDiff !== 0 ? radiusDiff : a.id - b.id;
            });

            for (let i = 0; i < cells.length; i++) {
                const cellA = cells[i];
                if (cellA.destroyed) continue;

                const tA = cellA.get(modu.Transform2D);
                const sA = cellA.get(modu.Sprite);

                for (let j = i + 1; j < cells.length; j++) {
                    const cellB = cells[j];
                    if (cellB.destroyed) continue;

                    const mergeFrameA = cellMergeFrame.get(cellA.id) || 0;
                    const mergeFrameB = cellMergeFrame.get(cellB.id) || 0;
                    if (currentFrame < mergeFrameA || currentFrame < mergeFrameB) continue;

                    const tB = cellB.get(modu.Transform2D);
                    const sB = cellB.get(modu.Sprite);

                    const dx = tA.x - tB.x;
                    const dy = tA.y - tB.y;
                    const dist = Math.sqrt(dx * dx + dy * dy);
                    const mergeThreshold = (sA.radius + sB.radius) * 0.5;

                    if (dist < mergeThreshold) {
                        const areaA = sA.radius * sA.radius;
                        const areaB = sB.radius * sB.radius;
                        const newRadius = Math.min(Math.sqrt(areaA + areaB), MAX_RADIUS);

                        sA.radius = newRadius;
                        cellA.get(modu.Body2D).radius = newRadius;
                        cellB.destroy();
                        cellMergeFrame.delete(cellB.id);
                    }
                }
            }
        }
    }, { phase: 'update' });
}

export function setupCollisions(game: modu.Game, physics: modu.Physics2DSystem): void {
    // Cell eats food
    physics.onCollision('cell', 'food', (cell, food) => {
        if (food.destroyed) return;
        const sprite = cell.get(modu.Sprite);
        const foodSprite = food.get(modu.Sprite);
        sprite.radius = Math.min(sprite.radius + foodSprite.radius * FOOD_GROW, MAX_RADIUS);
        cell.get(modu.Body2D).radius = sprite.radius;
        food.destroy();
    });

    // Cell eats smaller cell (different players only)
    physics.onCollision('cell', 'cell', (cellA, cellB) => {
        if (cellA.get(modu.Player).clientId === cellB.get(modu.Player).clientId) return;

        const eaterSprite = cellA.get(modu.Sprite);
        const preySprite = cellB.get(modu.Sprite);
        if (eaterSprite.radius > preySprite.radius * EAT_RATIO) {
            eaterSprite.radius = Math.min(eaterSprite.radius + preySprite.radius * PLAYER_GROW, MAX_RADIUS);
            cellA.get(modu.Body2D).radius = eaterSprite.radius;
            cellB.destroy();
            cellMergeFrame.delete(cellB.id);
        }
    });
}
