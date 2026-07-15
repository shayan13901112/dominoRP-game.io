const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const cors = require('cors');
const fs = require('fs');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
    cors: { origin: "*", methods: ["GET", "POST"] }
});

app.use(cors());
app.use(express.json());
app.use(express.static('public'));

const USERS_FILE = path.join(__dirname, 'users.json');

function loadUsers() {
    try {
        if (fs.existsSync(USERS_FILE)) {
            return JSON.parse(fs.readFileSync(USERS_FILE, 'utf8'));
        }
    } catch (e) {}
    return {};
}

function saveUsers(users) {
    fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2));
}

app.post('/api/register', (req, res) => {
    const { username, password } = req.body;
    const users = loadUsers();
    
    if (users[username]) {
        return res.status(400).json({ error: 'این نام کاربری قبلاً ثبت شده است.' });
    }
    
    users[username] = {
        password: password,
        wins: 0,
        losses: 0,
        score: 0,
        avatar: ['😎', '😊', '🤩', '🦁', '🔥', '⭐', '💎', '🎯'][Math.floor(Math.random() * 8)]
    };
    saveUsers(users);
    res.json({ success: true, user: { username, ...users[username] } });
});

app.post('/api/login', (req, res) => {
    const { username, password } = req.body;
    const users = loadUsers();
    
    if (!users[username] || users[username].password !== password) {
        return res.status(400).json({ error: 'نام کاربری یا رمز عبور اشتباه است.' });
    }
    res.json({ success: true, user: { username, ...users[username] } });
});

app.get('/api/leaderboard', (req, res) => {
    const users = loadUsers();
    const list = Object.entries(users).map(([username, data]) => ({
        username,
        score: data.score || 0,
        wins: data.wins || 0,
        avatar: data.avatar || '😎'
    }));
    list.sort((a, b) => b.score - a.score);
    res.json(list.slice(0, 10));
});

app.post('/api/update-stats', (req, res) => {
    const { username, won } = req.body;
    const users = loadUsers();
    
    if (users[username]) {
        if (won) {
            users[username].wins = (users[username].wins || 0) + 1;
            users[username].score = (users[username].score || 0) + 10;
        } else {
            users[username].losses = (users[username].losses || 0) + 1;
            users[username].score = Math.max(0, (users[username].score || 0) - 2);
        }
        saveUsers(users);
        res.json({ success: true, user: { username, ...users[username] } });
    } else {
        res.status(404).json({ error: 'کاربر یافت نشد.' });
    }
});

// ============================================
// Socket.IO برای بازی آنلاین
// ============================================
const rooms = {};
const onlineUsers = {};

io.on('connection', (socket) => {
    console.log('🔌 کاربر جدید متصل شد:', socket.id);
    
    socket.on('user-join', (username) => {
        onlineUsers[username] = socket.id;
        socket.username = username;
        io.emit('online-users', Object.keys(onlineUsers));
        io.emit('system-message', `👋 ${username} وارد بازی شد!`);
    });
    
    socket.on('create-room', () => {
        const roomId = Math.random().toString(36).substring(2, 8).toUpperCase();
        rooms[roomId] = {
            id: roomId,
            players: [socket.username],
            table: [],
            hands: {},
            currentPlayer: 0,
            gameStarted: false,
            gameOver: false
        };
        socket.join(roomId);
        socket.roomId = roomId;
        socket.emit('room-created', { roomId });
        io.to(roomId).emit('room-update', rooms[roomId]);
        console.log(`🏠 اتاق جدید: ${roomId} توسط ${socket.username}`);
    });
    
    socket.on('join-room', (roomId) => {
        roomId = roomId.toUpperCase();
        if (!rooms[roomId]) {
            socket.emit('error', 'اتاق وجود ندارد!');
            return;
        }
        if (rooms[roomId].players.length >= 4) {
            socket.emit('error', 'اتاق پر است!');
            return;
        }
        if (rooms[roomId].gameStarted) {
            socket.emit('error', 'بازی شروع شده است!');
            return;
        }
        
        rooms[roomId].players.push(socket.username);
        socket.join(roomId);
        socket.roomId = roomId;
        io.to(roomId).emit('room-update', rooms[roomId]);
        io.emit('system-message', `👤 ${socket.username} به اتاق ${roomId} پیوست!`);
    });
    
    socket.on('start-game', () => {
        const roomId = socket.roomId;
        if (!roomId || !rooms[roomId]) return;
        const room = rooms[roomId];
        
        if (room.players.length < 2) {
            socket.emit('error', 'حداقل ۲ بازیکن نیاز است!');
            return;
        }
        
        room.gameStarted = true;
        room.currentPlayer = 0;
        
        const allTiles = [];
        for (let i = 0; i <= 6; i++) {
            for (let j = i; j <= 6; j++) {
                allTiles.push([i, j]);
            }
        }
        for (let i = allTiles.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [allTiles[i], allTiles[j]] = [allTiles[j], allTiles[i]];
        }
        
        const perPlayer = Math.floor(7 / room.players.length);
        let idx = 0;
        room.players.forEach((player) => {
            room.hands[player] = allTiles.slice(idx, idx + perPlayer);
            idx += perPlayer;
        });
        
        room.table = [];
        const firstPlayer = room.players[0];
        const firstTile = room.hands[firstPlayer].pop();
        room.table.push(firstTile);
        
        io.to(roomId).emit('game-started', room);
        io.to(roomId).emit('room-update', room);
    });
    
    socket.on('play-tile', ({ tile, index }) => {
        const roomId = socket.roomId;
        if (!roomId || !rooms[roomId]) return;
        const room = rooms[roomId];
        const username = socket.username;
        
        if (room.gameOver || room.players[room.currentPlayer] !== username) {
            socket.emit('error', 'نوبت شما نیست!');
            return;
        }
        
        const hand = room.hands[username];
        if (index < 0 || index >= hand.length) return;
        
        const [l, r] = hand[index];
        if (room.table.length > 0) {
            const leftEnd = room.table[0][0];
            const rightEnd = room.table[room.table.length - 1][1];
            if (!(l === leftEnd || r === leftEnd || l === rightEnd || r === rightEnd)) {
                socket.emit('error', 'این مهره قابل گذاشتن نیست!');
                return;
            }
        }
        
        hand.splice(index, 1);
        const leftEnd = room.table[0][0];
        const rightEnd = room.table[room.table.length - 1][1];
        
        if (r === leftEnd) {
            room.table.unshift([r, l]);
        } else if (l === leftEnd) {
            room.table.unshift([l, r]);
        } else if (l === rightEnd) {
            room.table.push([l, r]);
        } else if (r === rightEnd) {
            room.table.push([r, l]);
        }
        
        if (hand.length === 0) {
            room.gameOver = true;
            io.to(roomId).emit('game-over', { winner: username, room });
            io.emit('system-message', `🏆 ${username} برنده بازی شد!`);
            return;
        }
        
        room.currentPlayer = (room.currentPlayer + 1) % room.players.length;
        io.to(roomId).emit('room-update', room);
        io.to(roomId).emit('turn-change', { currentPlayer: room.players[room.currentPlayer] });
    });
    
    socket.on('chat-message', (message) => {
        const roomId = socket.roomId;
        if (roomId && rooms[roomId]) {
            io.to(roomId).emit('chat-message', {
                username: socket.username,
                message: message
            });
        }
    });
    
    socket.on('disconnect', () => {
        const username = socket.username;
        if (username) {
            delete onlineUsers[username];
            io.emit('online-users', Object.keys(onlineUsers));
            io.emit('system-message', `👋 ${username} از بازی خارج شد.`);
        }
        if (socket.roomId && rooms[socket.roomId]) {
            const room = rooms[socket.roomId];
            room.players = room.players.filter(p => p !== username);
            if (room.players.length === 0) {
                delete rooms[socket.roomId];
            } else {
                io.to(socket.roomId).emit('room-update', room);
            }
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`🚀 سرور دومینو روی پورت ${PORT} راه‌اندازی شد!`);
});
