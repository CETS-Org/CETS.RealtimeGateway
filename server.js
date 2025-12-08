import express from 'express';
import http from 'http';
import { Server } from 'socket.io';
import dotenv from 'dotenv';
import Redis from 'ioredis';
import { createAdapter } from '@socket.io/redis-adapter'; // Import Adapter

const app = express();
const server = http.createServer(app);
dotenv.config();

// Config Port
const port = process.env.PORT || 5001;

// Config Redis URL
const redisUrl = process.env.REDIS_URL || 'redis://localhost:6379';

// --- 1. SETUP REDIS CLIENTS FOR ADAPTER (Scaling Logic) ---
// We need two separate connections for the Adapter: Pub and Sub
const pubClient = new Redis(redisUrl);
const subClient = pubClient.duplicate();

// --- 2. SETUP MANUAL REDIS CLIENT (Backend Listener) ---
// We keep your original client to listen to the C# API specifically
const backendListener = new Redis(redisUrl);

// Config CORS
const allowedOriginsEnv = process.env.ALLOWED_ORIGINS || "*";
const allowedOrigins = allowedOriginsEnv === "*" 
  ? "*" 
  : allowedOriginsEnv.split(',').map((origin) => origin.trim()).filter(Boolean);

const io = new Server(server, {
  cors: {
    origin: allowedOrigins,
    methods: ['GET', 'POST']
  }
});

// --- 3. APPLY THE ADAPTER ---
// This allows Container A to talk to Container B automatically
Promise.all([pubClient.connect(), subClient.connect()]).then(() => {
  io.adapter(createAdapter(pubClient, subClient));
  console.log('✅ Redis Adapter connected (Scaling enabled)');
});

// Định nghĩa tên các kênh Redis
const CHANNEL_NOTIFICATION = 'notifications';
const CHANNEL_CHAT = 'chat_messages';

io.on('connection', (socket) => {
  const { userId } = socket.handshake.query;
  console.log(`User connected: ${userId || 'Anonymous'} (${socket.id})`);

  if (typeof userId === 'string' && userId.trim() !== '') {
    const room = `user:${userId.toUpperCase()}`;
    socket.join(room);
  }

  socket.on('disconnect', () => {
    // console.log('User disconnected');
  });
});

// --- 4. SUBSCRIBE CẢ 2 KÊNH (KEEPING YOUR LOGIC) ---
// This listens for messages coming from your C# / .NET Backend
backendListener.subscribe(CHANNEL_NOTIFICATION, CHANNEL_CHAT, (err, count) => {
  if (err) {
    console.error('❌ Failed to subscribe to Redis channel', err);
  } else {
    console.log(`✅ Subscribed to ${count} Redis channels: ${CHANNEL_NOTIFICATION}, ${CHANNEL_CHAT}`);
  }
});

// --- 5. XỬ LÝ TIN NHẮN TỪ BACKEND ---
backendListener.on('message', (channel, message) => {
  try {
    const data = JSON.parse(message);

    // A. Xử lý Notification
    if (channel === CHANNEL_NOTIFICATION) {
      const userId = data.userId || data.UserId;
      if (!userId) return;

      const room = `user:${String(userId).toUpperCase()}`;
      
      // When using the Adapter, io.to().emit() works across ALL servers!
      io.to(room).emit('notification', data);
    } 
    
    // B. Xử lý Chat
    else if (channel === CHANNEL_CHAT) {
      // Broadcast to everyone on ALL servers
      io.emit('receive_message', data);
    }

  } catch (error) {
    console.error(`❌ Failed to process message from channel ${channel}`, error);
  }
});

server.listen(port, () => {
  console.log(`🚀 Realtime Gateway listening on port ${port}`);
});