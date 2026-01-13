const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const { PrismaClient } = require('@prisma/client');
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

const prisma = new PrismaClient();

// Helper to save messages
async function saveMessage(msg) {
  try {
    await prisma.message.create({
      data: {
        content: msg.content,
        sender: msg.sender,
        type: msg.type,
        createdAt: msg.createdAt, // Ensure date is passed or let DB handle default
      }
    });
  } catch (e) {
    console.error("Failed to save message", e);
  }
}

// Helper to update user status
async function saveUserStatus(username, status) {
  try {
    const user = await prisma.user.upsert({
      where: { username: username },
      update: {
        online: status.online,
        lastSeen: status.lastSeen ? new Date(status.lastSeen) : null,
      },
      create: {
        username: username,
        online: status.online,
        lastSeen: status.lastSeen ? new Date(status.lastSeen) : null,
      },
    });
    return user;
  } catch (e) {
    console.error("Failed to save user status", e);
    return { online: false, lastSeen: null };
  }
}

app.use(cors());
app.use(express.json());

app.get('/', (req, res) => {
  res.send('OurSpace Server is Running (PostgreSQL Mode)');
});

app.get('/api/messages', async (req, res) => {
  try {
    const messages = await prisma.message.findMany({
      orderBy: { createdAt: 'asc' }, // Get global history in order
      take: 100 // Limit to last 100 for performance
    });
    res.json(messages);
  } catch (e) {
    console.error("Failed to fetch messages", e);
    res.status(500).json({ error: "Failed to fetch messages" });
  }
});

const socketUserMap = new Map(); // socketId -> username

io.on('connection', (socket) => {
  console.log('User connected:', socket.id);

  socket.on('join_room', (room) => {
    socket.join(room);
  });

  // User Login / Status Tracking
  socket.on('user_login', async (username) => {
    console.log(`User logged in: ${username}`);
    socketUserMap.set(socket.id, username);

    // Mark as online
    const userStatus = await saveUserStatus(username, { online: true, lastSeen: null });

    // Broadcast to everyone
    io.emit('user_status_update', { username, status: userStatus });

    // Send current status of all users to the connecting user
    try {
      const allUsersList = await prisma.user.findMany();
      const allUsersMap = {};
      allUsersList.forEach(u => {
        allUsersMap[u.username] = u;
      });
      socket.emit('all_users_status', allUsersMap);
    } catch (e) {
      console.error("Failed to load users", e);
    }
  });

  socket.on('user_logout', async () => {
    const username = socketUserMap.get(socket.id);
    if (username) {
      console.log(`User logged out: ${username}`);
      const userStatus = await saveUserStatus(username, { online: false, lastSeen: new Date().toISOString() });
      io.emit('user_status_update', { username, status: userStatus });
      socketUserMap.delete(socket.id);
    }
  });

  socket.on('send_message', async (data) => {
    // data: { content, sender, type }
    const newMessage = {
      content: data.content,
      sender: data.sender,
      type: data.type || 'text',
      createdAt: new Date()
    };

    // Optimistically update clients with a temp ID or similar, but here we just emit what we got
    // Note: Database ID will be generated, but for real-time we might send `Date.now()` as ID if client needs it immediately
    const messageForClient = { ...newMessage, id: Date.now(), createdAt: newMessage.createdAt.toISOString() };

    io.emit('receive_message', messageForClient); // Send immediately for responsiveness

    await saveMessage(newMessage); // Save to DB asynchronously

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

  socket.on('disconnect', async () => {
    console.log('User disconnected:', socket.id);
    const username = socketUserMap.get(socket.id);
    if (username) {
      console.log(`Marking ${username} offline`);
      const userStatus = await saveUserStatus(username, { online: false, lastSeen: new Date().toISOString() });
      io.emit('user_status_update', { username, status: userStatus });
      socketUserMap.delete(socket.id);
    }
  });
});

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`SERVER RUNNING ON PORT ${PORT}`);
});
