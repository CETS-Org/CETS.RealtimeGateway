import express from 'express';
import http from 'http';
import { Server } from 'socket.io';
import dotenv from 'dotenv';
import Redis from 'ioredis';

const app = express();
const server = http.createServer(app);
dotenv.config();

const allowedOriginsEnv = process.env.ALLOWED_ORIGINS;
const allowedOrigins = 
  allowedOriginsEnv.split(',').map((origin) => origin.trim()).filter(Boolean);

const io = new Server(server, {
  cors: {
    origin: allowedOrigins,
    methods: ['GET', 'POST']
  }
});

const redisUrl = process.env.REDIS_URL;
const redis = new Redis(redisUrl);

const REDIS_CHANNEL = 'notifications';

io.on('connection', (socket) => {
  const { userId } = socket.handshake.query;
  if (typeof userId === 'string' && userId.trim() !== '') {
    const room = `user:${userId.toUpperCase()}`;
    socket.join(room);
  }

  socket.on('disconnect', () => {
    // No-op for now
  });
});

redis.subscribe(REDIS_CHANNEL, (err) => {
  if (err) {
    console.error('Failed to subscribe to Redis channel', err);
  } else {
    console.log(`Subscribed to Redis channel: ${REDIS_CHANNEL}`);
  }
});

redis.on('message', (channel, message) => {
  if (channel !== REDIS_CHANNEL) return;

  try {
    const notification = JSON.parse(message);
    const userId = notification.userId;
    if (!userId) return;

    const room = `user:${String(userId).toUpperCase()}`;
    io.to(room).emit('notification', notification);
  } catch (error) {
    console.error('Failed to process notification message from Redis', error);
  }
});

const port = process.env.PORT;
server.listen(port, () => {
  console.log(`Notification gateway listening on port ${port}`);
});
