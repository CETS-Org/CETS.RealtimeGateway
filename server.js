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
// Use lazyConnect to control connection lifecycle and avoid double-connect errors
const redisOptions = { lazyConnect: true };
const pubClient = new Redis(redisUrl, redisOptions);
const subClient = new Redis(redisUrl, redisOptions);

// --- 2. SETUP MANUAL REDIS CLIENT (Backend Listener) ---
// Dedicated client for backend notifications
const backendListener = new Redis(redisUrl, redisOptions);

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
// Connect clients explicitly (lazyConnect) and handle errors
Promise.all([pubClient.connect(), subClient.connect(), backendListener.connect()])
  .then(() => {
    io.adapter(createAdapter(pubClient, subClient));
    console.log('✅ Redis Adapter connected (Scaling enabled)');

    // Subscribe after connections are ready
    backendListener.subscribe(CHANNEL_NOTIFICATION, CHANNEL_CHAT, (err, count) => {
      if (err) {
        console.error('❌ Failed to subscribe to Redis channel', err);
      } else {
        console.log(`✅ Subscribed to ${count} Redis channels: ${CHANNEL_NOTIFICATION}, ${CHANNEL_CHAT}`);
      }
    });
  })
  .catch((err) => {
    console.error('❌ Redis connection failed', err);
    process.exit(1);
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