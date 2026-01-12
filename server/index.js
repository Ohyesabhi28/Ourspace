const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    // Allow the deployed frontend (Netlify) and local dev
    origin: process.env.CLIENT_URL || "*",
    methods: ["GET", "POST"]
  }
});

const DB_FILE = path.join(__dirname, 'messages.json');

// Helper to load messages
function loadMessages() {
  try {
    if (fs.existsSync(DB_FILE)) {
      const data = fs.readFileSync(DB_FILE, 'utf8');
      return JSON.parse(data);
    }
  } catch (e) {
    console.error("Failed to load messages", e);
  }
  return [];
}

// Helper to save messages
function saveMessage(msg) {
  const messages = loadMessages();
  messages.push(msg);
  try {
    fs.writeFileSync(DB_FILE, JSON.stringify(messages, null, 2));
  } catch (e) {
    console.error("Failed to save message", e);
  }
}

app.use(cors());
app.use(express.json());

app.get('/', (req, res) => {
  res.send('OurSpace Server is Running (JSON Mode)');
});

app.get('/api/messages', (req, res) => {
  const messages = loadMessages();
  // Return last 100
  res.json(messages.slice(-100));
});

const USERS_FILE = path.join(__dirname, 'users.json');
const socketUserMap = new Map(); // socketId -> username

// Helper to load users
function loadUsers() {
  try {
    if (fs.existsSync(USERS_FILE)) {
      const data = fs.readFileSync(USERS_FILE, 'utf8');
      return JSON.parse(data);
    }
  } catch (e) {
    console.error("Failed to load users", e);
  }
  return {};
}

// Helper to save user status
function saveUserStatus(username, status) {
  const users = loadUsers();
  users[username] = { ...users[username], ...status };
  try {
    fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2));
  } catch (e) {
    console.error("Failed to save user status", e);
  }
  return users[username];
}

io.on('connection', (socket) => {
  console.log('User connected:', socket.id);

  socket.on('join_room', (room) => {
    socket.join(room);
  });

  // User Login / Status Tracking
  socket.on('user_login', (username) => {
    console.log(`User logged in: ${username}`);
    socketUserMap.set(socket.id, username);

    // Mark as online
    const userStatus = saveUserStatus(username, { online: true, lastSeen: null });

    // Broadcast to everyone (simplest for 2 users)
    io.emit('user_status_update', { username, status: userStatus });

    // Send current status of all users to the connecting user
    const allUsers = loadUsers();
    socket.emit('all_users_status', allUsers);
  });

  socket.on('user_logout', () => {
    const username = socketUserMap.get(socket.id);
    if (username) {
      console.log(`User logged out: ${username}`);
      const userStatus = saveUserStatus(username, { online: false, lastSeen: new Date().toISOString() });
      io.emit('user_status_update', { username, status: userStatus });
      socketUserMap.delete(socket.id);
    }
  });

  socket.on('send_message', (data) => {
    // data: { content, sender, type }
    const newMessage = {
      id: Date.now(),
      content: data.content,
      sender: data.sender,
      type: data.type || 'text',
      createdAt: new Date().toISOString()
    };

    saveMessage(newMessage);
    io.emit('receive_message', newMessage);

    // Telegram Notification (Only when Tulu texts)
    const normalizedSender = (data.sender || '').toLowerCase().trim();
    if (
      (normalizedSender === 'tulu' || normalizedSender === 'tulsi') &&
      process.env.TELEGRAM_BOT_TOKEN &&
      process.env.TELEGRAM_CHAT_ID
    ) {
      const text = `💌 New message from ${data.sender}:\n${data.type === 'image' ? '[Photo]' : data.content}`;
      const url = `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`;

      // Node 18+ has native fetch
      fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: process.env.TELEGRAM_CHAT_ID, text: text })
      }).catch(err => console.error("Telegram Error:", err));
    }
  });

  // Signaling for Video Call
  socket.on('call_user', (data) => {
    console.log(`Call signal from ${data.from} to room ourspace_global`);
    socket.to('ourspace_global').emit('call_incoming', { signal: data.signal, from: data.from });
  });

  socket.on('answer_call', (data) => {
    console.log("Call answered");
    socket.to('ourspace_global').emit('call_answered', { signal: data.signal });
  });

  socket.on('ice_candidate', (data) => {
    socket.to('ourspace_global').emit('ice_candidate', data);
  });

  socket.on('end_call', () => {
    socket.broadcast.emit('call_ended');
  });

  socket.on('disconnect', () => {
    console.log('User disconnected:', socket.id);
    const username = socketUserMap.get(socket.id);
    if (username) {
      console.log(`Marking ${username} offline`);
      const userStatus = saveUserStatus(username, { online: false, lastSeen: new Date().toISOString() });
      io.emit('user_status_update', { username, status: userStatus });
      socketUserMap.delete(socket.id);
    }
  });
});

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`SERVER RUNNING ON PORT ${PORT}`);
});
