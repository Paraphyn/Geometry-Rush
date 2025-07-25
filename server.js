const express = require('express');
const http = require('http');
const socketIo = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = socketIo(server);

app.use(express.static('public')); // Serve client files (index.html)

const ENEMY_TYPES = {
    square: { health: 200, speed: 4, size: 30, points: 5, damage: 15 },
    triangle: { health: 50, speed: 6.5, size: 15, points: 10, damage: 25 },
    octagon: { health: 800, speed: 1, size: 50, points: 50, damage: 50 }
};

let gameState = {
    players: {}, // { socketId: { id, x, y, health, score, railgunCharge } }
    enemies: [], // { id, x, y, type, health }
    bullets: [], // { id, x, y, dx, dy, ownerId }
    enemyBullets: [], // { id, x, y, dx, dy }
    lastEnemySpawn: Date.now(),
    enemySpawnRate: 2000,
    enemiesKilled: 0,
    gameOver: false
};

let lastUpdate = Date.now();

io.on('connection', (socket) => {
    console.log(`Player connected: ${socket.id}`);

    // Initialize player
    gameState.players[socket.id] = {
        id: socket.id,
        x: 400, // Default canvas center (adjusted on client)
        y: 300,
        health: 100,
        score: 0,
        railgunCharge: 0
    };

    // Send initial state
    socket.emit('init', { playerId: socket.id, gameState });

    socket.on('input', (input) => {
        if (gameState.gameOver) return;
        const player = gameState.players[socket.id];
        if (!player || player.health <= 0) return;

        // Update player position based on input
        let newX = player.x, newY = player.y;
        const speed = 5;
        if (input.keys.w) newY -= speed;
        if (input.keys.s) newY += speed;
        if (input.keys.a) newX -= speed;
        if (input.keys.d) newX += speed;
        if (input.joystick.x || input.joystick.y) {
            newX += input.joystick.x * speed;
            newY += input.joystick.y * speed;
        }
        // Clamp to canvas (800x600 default, adjusted on client)
        player.x = Math.max(20, Math.min(800 - 20, newX));
        player.y = Math.max(20, Math.min(600 - 20, newY));

        // Handle shooting
        if (input.mouse.down && input.lastShot + 250 <= Date.now()) {
            const dx = input.mouse.x - player.x;
            const dy = input.mouse.y - player.y;
            const dist = Math.sqrt(dx * dx + dy * dy);
            if (dist > 0) {
                gameState.bullets.push({
                    id: `${socket.id}-${Date.now()}`,
                    x: player.x,
                    y: player.y,
                    dx: (dx / dist) * 8,
                    dy: (dy / dist) * 8,
                    life: 100,
                    ownerId: socket.id
                });
                input.lastShot = Date.now();
            }
        }

        // Handle Railgun
        if (input.mouse.rightDown) {
            player.railgunCharge = Math.min(1, player.railgunCharge + (1000 / 60 / 5000));
        } else if (player.railgunCharge > 0) {
            const dx = input.mouse.x - player.x;
            const dy = input.mouse.y - player.y;
            const dist = Math.sqrt(dx * dx + dy * dy);
            if (dist > 0) {
                const maxDist = 1000; // Approx canvas diagonal
                const endX = player.x + (dx / dist) * maxDist;
                const endY = player.y + (dy / dist) * maxDist;
                const damage = player.railgunCharge <= 0.05 ? 5 : 5 + (300 - 5) * (player.railgunCharge - 0.05) / (1 - 0.05);
                gameState.bullets.push({
                    id: `${socket.id}-${Date.now()}`,
                    type: 'railgun',
                    x: player.x,
                    y: player.y,
                    endX: endX,
                    endY: endY,
                    damage: damage,
                    life: 60,
                    ownerId: socket.id,
                    hitEnemies: []
                });
                player.railgunCharge = 0;
            }
        }
    });

    socket.on('disconnect', () => {
        console.log(`Player disconnected: ${socket.id}`);
        delete gameState.players[socket.id];
        if (Object.keys(gameState.players).length === 0) {
            // Reset game state if no players remain
            gameState = {
                players: {},
                enemies: [],
                bullets: [],
                enemyBullets: [],
                lastEnemySpawn: Date.now(),
                enemySpawnRate: 2000,
                enemiesKilled: 0,
                gameOver: false
            };
        }
    });
});

// Server-side game loop (~30 FPS)
setInterval(() => {
    if (gameState.gameOver) return;

    const now = Date.now();
    // Spawn enemies
    if (now - gameState.lastEnemySpawn > gameState.enemySpawnRate) {
        const side = Math.floor(Math.random() * 4);
        const margin = 30;
        let x, y;
        switch (side) {
            case 0: x = Math.random() * 800; y = -margin; break;
            case 1: x = 800 + margin; y = Math.random() * 600; break;
            case 2: x = Math.random() * 800; y = 600 + margin; break;
            case 3: x = -margin; y = Math.random() * 600; break;
        }
        const types = Object.keys(ENEMY_TYPES);
        const type = types[Math.floor(Math.random() * types.length)];
        gameState.enemies.push({
            id: `enemy-${Date.now()}-${Math.random()}`,
            x, y, type,
            health: ENEMY_TYPES[type].health,
            maxHealth: ENEMY_TYPES[type].health,
            lastShot: now
        });
        gameState.lastEnemySpawn = now;
        gameState.enemySpawnRate = Math.max(500, gameState.enemySpawnRate * 0.99);
    }

    // Update enemies
    gameState.enemies = gameState.enemies.filter(enemy => {
        let minDist = Infinity;
        for (const playerId in gameState.players) {
            const player = gameState.players[playerId];
            const dx = player.x - enemy.x;
            const dy = player.y - enemy.y;
            const dist = Math.sqrt(dx * dx + dy * dy);
            minDist = Math.min(minDist, dist);
            if (dist > 0) {
                const speed = ENEMY_TYPES[enemy.type].speed;
                enemy.x += (dx / dist) * speed;
                enemy.y += (dy / dist) * speed;
            }
        }
        // Enemy shoots (octagons only)
        if (enemy.type === 'octagon' && now - enemy.lastShot >= 4000) {
            const targetPlayer = Object.values(gameState.players)[0];
            if (targetPlayer) {
                const dx = targetPlayer.x - enemy.x;
                const dy = targetPlayer.y - enemy.y;
                const dist = Math.sqrt(dx * dx + dy * dy);
                if (dist > 0) {
                    gameState.enemyBullets.push({
                        id: `ebullet-${Date.now()}-${Math.random()}`,
                        x: enemy.x,
                        y: enemy.y,
                        dx: (dx / dist) * 8,
                        dy: (dy / dist) * 8,
                        life: 100
                    });
                    enemy.lastShot = now;
                }
            }
        }
        // Check collisions with players
        for (const playerId in gameState.players) {
            const player = gameState.players[playerId];
            if (player.health <= 0) continue;
            const dist = Math.sqrt((player.x - enemy.x) ** 2 + (player.y - enemy.y) ** 2);
            if (dist < ENEMY_TYPES[enemy.type].size + 20) {
                player.health = Math.max(0, player.health - ENEMY_TYPES[enemy.type].damage);
                return false; // Enemy dies on contact
            }
        }
        return enemy.health > 0 && minDist > 0;
    });

    // Update bullets
    gameState.bullets = gameState.bullets.filter(bullet => {
        bullet.x += bullet.dx || 0;
        bullet.y += bullet.dy || 0;
        bullet.life--;
        return bullet.x >= 0 && bullet.x <= 800 && bullet.y >= 0 && bullet.y <= 600 && bullet.life > 0;
    });

    // Update enemy bullets
    gameState.enemyBullets = gameState.enemyBullets.filter(bullet => {
        bullet.x += bullet.dx;
        bullet.y += bullet.dy;
        bullet.life--;
        for (const playerId in gameState.players) {
            const player = gameState.players[playerId];
            if (player.health <= 0) continue;
            const dist = Math.sqrt((bullet.x - player.x) ** 2 + (bullet.y - player.y) ** 2);
            if (dist < 6 + 20) {
                player.health = Math.max(0, player.health - 15);
                return false;
            }
        }
        return bullet.x >= 0 && bullet.x <= 800 && bullet.y >= 0 && bullet.y <= 600 && bullet.life > 0;
    });

    // Check bullet-enemy collisions
    for (let i = gameState.enemies.length - 1; i >= 0; i--) {
        const enemy = gameState.enemies[i];
        for (let j = gameState.bullets.length - 1; j >= 0; j--) {
            const bullet = gameState.bullets[j];
            if (bullet.type === 'railgun') {
                // Railgun collision (line segment)
                const p1 = { x: bullet.x, y: bullet.y };
                const p2 = { x: bullet.endX, y: bullet.endY };
                const p3 = { x: enemy.x, y: enemy.y };
                const radius = ENEMY_TYPES[enemy.type].size;
                const dx = p2.x - p1.x;
                const dy = p2.y - p1.y;
                const len = Math.sqrt(dx * dx + dy * dy);
                const dot = ((p3.x - p1.x) * dx + (p3.y - p1.y) * dy) / (len * len);
                const closestX = p1.x + dot * dx;
                const closestY = p1.y + dot * dy;
                const distX = p3.x - closestX;
                const distY = p3.y - closestY;
                const distance = Math.sqrt(distX * distX + distY * distY);
                if (distance <= radius && dot >= 0 && dot <= 1 && !bullet.hitEnemies.includes(enemy.id)) {
                    enemy.health -= bullet.damage;
                    bullet.hit FestaiveEnemies.push(enemy.id);
                    if (enemy.health <= 0) {
                        gameState.enemies.splice(i, 1);
                        gameState.enemiesKilled++;
                        for (const playerId in gameState.players) {
                            gameState.players[playerId].score += ENEMY_TYPES[enemy.type].points;
                        }
                    }
                }
            } else {
                // Regular bullet collision
                const dist = Math.sqrt((bullet.x - enemy.x) ** 2 + (bullet.y - enemy.y) ** 2);
                if (dist < 4 + ENEMY_TYPES[enemy.type].size) {
                    enemy.health -= 50;
                    gameState.bullets.splice(j, 1);
                    if (enemy.health <= 0) {
                        gameState.enemies.splice(i, 1);
                        gameState.enemiesKilled++;
                        for (const playerId in gameState.players) {
                            gameState.players[playerId].score += ENEMY_TYPES[enemy.type].points;
                        }
                    }
                }
            }
        }
    }

    // Check game over
    const allDead = Object.values(gameState.players).every(p => p.health <= 0);
    if (allDead && !gameState.gameOver) {
        gameState.gameOver = true;
    }

    // Broadcast state
    io.emit('update', gameState);
}, 1000 / 30);

server.listen(3000, () => {
    console.log('Server running on port 3000');
});
