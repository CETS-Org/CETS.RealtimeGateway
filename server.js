import express from 'express';
import http from 'http';
import { Server } from 'socket.io';
import dotenv from 'dotenv';
import Redis from 'ioredis';

const app = express();
const server = http.createServer(app);
dotenv.config();

// Cấu hình CORS
const allowedOriginsEnv = process.env.ALLOWED_ORIGINS || "*"; // Fallback nếu quên config
const allowedOrigins = allowedOriginsEnv === "*" 
  ? "*" 
  : allowedOriginsEnv.split(',').map((origin) => origin.trim()).filter(Boolean);

const io = new Server(server, {
  cors: {
    origin: allowedOrigins,
    methods: ['GET', 'POST']
  }
});

// Kết nối Redis
const redisUrl = process.env.REDIS_URL || 'redis://localhost:6379'; // Fallback local
const redis = new Redis(redisUrl);

// Định nghĩa tên các kênh Redis
const CHANNEL_NOTIFICATION = 'notifications';
const CHANNEL_CHAT = 'chat_messages';

io.on('connection', (socket) => {
  const { userId } = socket.handshake.query;
  console.log(`User connected: ${userId || 'Anonymous'} (${socket.id})`);

  // Join room riêng cho user để nhận thông báo cá nhân
  if (typeof userId === 'string' && userId.trim() !== '') {
    // Chuẩn hóa ID về dạng UpperCase để khớp với logic gửi của bạn
    const room = `user:${userId.toUpperCase()}`;
    socket.join(room);
  }

  socket.on('disconnect', () => {
    // console.log('User disconnected');
  });
});

// --- 1. SUBSCRIBE CẢ 2 KÊNH ---
redis.subscribe(CHANNEL_NOTIFICATION, CHANNEL_CHAT, (err, count) => {
  if (err) {
    console.error('Failed to subscribe to Redis channel', err);
  } else {
    console.log(`Subscribed to ${count} Redis channels: ${CHANNEL_NOTIFICATION}, ${CHANNEL_CHAT}`);
  }
});

// --- 2. XỬ LÝ TIN NHẮN TỪ REDIS ---
redis.on('message', (channel, message) => {
  try {
    const data = JSON.parse(message);

    // A. Xử lý Notification
    if (channel === CHANNEL_NOTIFICATION) {
      const userId = data.userId || data.UserId; // Handle case sensitivity
      if (!userId) return;

      const room = `user:${String(userId).toUpperCase()}`;
      // Gửi sự kiện 'notification' vào room riêng của user
      io.to(room).emit('notification', data);
    } 
    
    // B. Xử lý Chat (Thêm mới)
    else if (channel === CHANNEL_CHAT) {
      // Gửi sự kiện 'receive_message' cho tất cả client
      // Frontend sẽ tự lọc xem tin nhắn có thuộc phòng đang mở không
      io.emit('receive_message', data);
    }

  } catch (error) {
    console.error(`Failed to process message from channel ${channel}`, error);
  }
});

const port = process.env.PORT || 5001;
server.listen(port, () => {
  console.log(`Realtime Gateway listening on port ${port}`);
});