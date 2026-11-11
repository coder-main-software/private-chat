const http = require("http");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const express = require("express");
const multer = require("multer");
const { WebSocketServer } = require("ws");

const PORT = process.env.PORT || 3000;
const DATA_DIR = path.join(__dirname, "data");
const DATA_FILE = path.join(DATA_DIR, "store.json");
const UPLOAD_DIR = path.join(DATA_DIR, "uploads");

fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(UPLOAD_DIR, { recursive: true });
if (!fs.existsSync(DATA_FILE)) {
  fs.writeFileSync(DATA_FILE, JSON.stringify({ users: [], rooms: [], messages: [] }, null, 2));
}

let store = JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
const sessions = new Map();
const sockets = new Map();

function save() {
  const tempFile = `${DATA_FILE}.tmp`;
  const backupFile = `${DATA_FILE}.bak`;
  const content = JSON.stringify(store, null, 2);
  const file = fs.openSync(tempFile, "w");
  try {
    fs.writeFileSync(file, content, "utf8");
    fs.fsyncSync(file);
  } finally {
    fs.closeSync(file);
  }
  if (fs.existsSync(DATA_FILE)) fs.copyFileSync(DATA_FILE, backupFile);
  fs.renameSync(tempFile, DATA_FILE);
}

function id(prefix) {
  return `${prefix}_${crypto.randomBytes(10).toString("hex")}`;
}

function now() {
  return new Date().toISOString();
}

function cleanUsername(value) {
  return String(value || "").trim().replace(/\s+/g, " ").slice(0, 24);
}

function cleanRoomName(value) {
  return String(value || "").trim().replace(/\s+/g, " ").slice(0, 42);
}

function hashPassword(password, salt = crypto.randomBytes(16).toString("hex")) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(String(password), salt, 64, (error, derivedKey) => {
      if (error) reject(error);
      else resolve(`${salt}:${derivedKey.toString("hex")}`);
    });
  });
}

function verifyPassword(password, stored) {
  return new Promise((resolve, reject) => {
    const [salt, key] = String(stored).split(":");
    crypto.scrypt(String(password), salt, 64, (error, derivedKey) => {
      if (error) return reject(error);
      const expected = Buffer.from(key, "hex");
      resolve(expected.length === derivedKey.length && crypto.timingSafeEqual(expected, derivedKey));
    });
  });
}

function safeUser(user) {
  return { id: user.id, username: user.username, createdAt: user.createdAt };
}

function safeRoom(room, userId) {
  const memberIds = Object.keys(room.members);
  const isOwner = room.ownerId === userId;
  return {
    id: room.id,
    name: room.name,
    ownerId: room.ownerId,
    isOwner,
    memberCount: memberIds.length,
    joined: memberIds.includes(userId),
    inviteCode: isOwner ? room.inviteCode : undefined,
    members: isOwner
      ? memberIds.map((memberId) => {
          const member = store.users.find((user) => user.id === memberId);
          const membership = room.members[memberId];
          return {
            id: memberId,
            username: member?.username || "已删除用户",
            role: membership.role,
            mutedUntil: membership.mutedUntil || null,
          };
        })
      : undefined,
  };
}

function userFromToken(token) {
  const userId = sessions.get(token);
  return store.users.find((user) => user.id === userId);
}

function auth(req, res, next) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  const user = userFromToken(token);
  if (!user) return res.status(401).json({ error: "请先登录" });
  req.user = user;
  req.token = token;
  next();
}

function getRoom(req, res) {
  const room = store.rooms.find((item) => item.id === req.params.roomId);
  if (!room) {
    res.status(404).json({ error: "房间不存在" });
    return null;
  }
  return room;
}

function requireMember(room, user, res) {
  if (!room.members[user.id]) {
    res.status(403).json({ error: "你不在这个私密房间里" });
    return false;
  }
  return true;
}

function requireOwner(room, user, res) {
  if (room.ownerId !== user.id) {
    res.status(403).json({ error: "只有房间管理员可以执行这个操作" });
    return false;
  }
  return true;
}

function broadcast(roomId, payload) {
  const subscribers = sockets.get(roomId);
  if (!subscribers) return;
  const data = JSON.stringify(payload);
  for (const socket of subscribers) {
    if (socket.readyState === 1) socket.send(data);
  }
}

const upload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, callback) => callback(null, UPLOAD_DIR),
    filename: (_req, file, callback) => {
      const extension = path.extname(file.originalname).slice(0, 12).replace(/[^a-zA-Z0-9.]/g, "");
      callback(null, `${crypto.randomBytes(16).toString("hex")}${extension}`);
    },
  }),
  limits: { fileSize: 10 * 1024 * 1024 },
});

function sendToUser(userId, payload) {
  for (const socket of sockets.values()) {
    for (const client of socket) {
      if (client.userId === userId && client.readyState === 1) {
        client.send(JSON.stringify(payload));
      }
    }
  }
}

function removeSocketFromRooms(socket) {
  for (const [roomId, subscribers] of sockets.entries()) {
    subscribers.delete(socket);
    if (!subscribers.size) sockets.delete(roomId);
  }
}

const app = express();
app.use(express.json({ limit: "32kb" }));
app.use(express.static(path.join(__dirname, "public")));
app.get("/health", (_req, res) => res.json({ ok: true, service: "private-realtime-chat" }));

app.post("/api/auth/register", async (req, res) => {
  const username = cleanUsername(req.body.username);
  const password = String(req.body.password || "");
  if (username.length < 2 || username.length > 24) {
    return res.status(400).json({ error: "昵称需要 2-24 个字符" });
  }
  if (password.length < 6) return res.status(400).json({ error: "密码至少 6 位" });
  if (store.users.some((user) => user.username.toLowerCase() === username.toLowerCase())) {
    return res.status(409).json({ error: "这个昵称已经被使用" });
  }
  const user = { id: id("usr"), username, passwordHash: await hashPassword(password), createdAt: now() };
  store.users.push(user);
  save();
  const token = crypto.randomBytes(32).toString("hex");
  sessions.set(token, user.id);
  res.json({ token, user: safeUser(user) });
});

app.post("/api/auth/login", async (req, res) => {
  const username = cleanUsername(req.body.username);
  const password = String(req.body.password || "");
  const user = store.users.find((item) => item.username.toLowerCase() === username.toLowerCase());
  if (!user || !(await verifyPassword(password, user.passwordHash))) {
    return res.status(401).json({ error: "昵称或密码不正确" });
  }
  const token = crypto.randomBytes(32).toString("hex");
  sessions.set(token, user.id);
  res.json({ token, user: safeUser(user) });
});

app.post("/api/auth/logout", auth, (req, res) => {
  sessions.delete(req.token);
  res.json({ ok: true });
});

app.get("/api/me", auth, (req, res) => res.json({ user: safeUser(req.user) }));

app.get("/api/rooms", auth, (req, res) => {
  const rooms = store.rooms
    .filter((room) => room.members[req.user.id])
    .map((room) => safeRoom(room, req.user.id));
  res.json({ rooms });
});

app.post("/api/rooms", auth, (req, res) => {
  const name = cleanRoomName(req.body.name);
  if (name.length < 2) return res.status(400).json({ error: "房间名至少 2 个字符" });
  const room = {
    id: id("room"),
    name,
    ownerId: req.user.id,
    inviteCode: crypto.randomBytes(5).toString("hex").toUpperCase(),
    createdAt: now(),
    members: { [req.user.id]: { role: "owner", mutedUntil: null, joinedAt: now() } },
  };
  store.rooms.push(room);
  save();
  res.status(201).json({ room: safeRoom(room, req.user.id) });
});

app.post("/api/rooms/join", auth, (req, res) => {
  const inviteCode = String(req.body.inviteCode || "").trim().toUpperCase();
  const room = store.rooms.find((item) => item.inviteCode === inviteCode);
  if (!room) return res.status(404).json({ error: "邀请码无效" });
  if (!room.members[req.user.id]) {
    room.members[req.user.id] = { role: "member", mutedUntil: null, joinedAt: now() };
    save();
    broadcast(room.id, { type: "member_joined", user: safeUser(req.user) });
  }
  res.json({ room: safeRoom(room, req.user.id) });
});

app.get("/api/rooms/:roomId", auth, (req, res) => {
  const room = getRoom(req, res);
  if (!room || !requireMember(room, req.user, res)) return;
  res.json({ room: safeRoom(room, req.user.id) });
});

app.get("/api/rooms/:roomId/messages", auth, (req, res) => {
  const room = getRoom(req, res);
  if (!room || !requireMember(room, req.user, res)) return;
  const messages = store.messages
    .filter((message) => message.roomId === room.id)
    .slice(-100);
  res.json({ messages });
});

app.post("/api/rooms/:roomId/upload", auth, (req, res) => {
  upload.single("file")(req, res, (error) => {
    if (error instanceof multer.MulterError && error.code === "LIMIT_FILE_SIZE") {
      return res.status(413).json({ error: "文件不能超过 10MB" });
    }
    if (error) return res.status(400).json({ error: "文件上传失败" });
    const room = getRoom(req, res);
    if (!room || !requireMember(room, req.user, res)) {
      if (req.file) fs.rmSync(req.file.path, { force: true });
      return;
    }
    const membership = room.members[req.user.id];
    if (membership.mutedUntil && membership.mutedUntil > Date.now()) {
      fs.rmSync(req.file.path, { force: true });
      return res.status(403).json({ error: "你已被禁言，暂时不能发送文件" });
    }
    if (!req.file) return res.status(400).json({ error: "请选择要发送的文件" });
    const attachment = {
      id: id("file"),
      originalName: req.file.originalname.slice(0, 180),
      mimeType: req.file.mimetype || "application/octet-stream",
      size: req.file.size,
      storageName: req.file.filename,
    };
    const message = {
      id: id("msg"),
      roomId: room.id,
      userId: req.user.id,
      username: req.user.username,
      text: "",
      attachment,
      createdAt: now(),
    };
    store.messages.push(message);
    if (store.messages.length > 5000) store.messages = store.messages.slice(-5000);
    save();
    broadcast(room.id, { type: "message", message });
    res.status(201).json({ message });
  });
});

app.get("/api/files/:fileId", auth, (req, res) => {
  const message = store.messages.find((item) => item.attachment?.id === req.params.fileId);
  if (!message) return res.status(404).json({ error: "文件不存在" });
  const room = store.rooms.find((item) => item.id === message.roomId);
  if (!room || !room.members[req.user.id]) return res.status(403).json({ error: "无权访问这个文件" });
  const filePath = path.join(UPLOAD_DIR, message.attachment.storageName);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: "文件已被清理" });
  res.download(filePath, message.attachment.originalName);
});

app.post("/api/rooms/:roomId/members/:memberId/mute", auth, (req, res) => {
  const room = getRoom(req, res);
  if (!room || !requireOwner(room, req.user, res)) return;
  const member = room.members[req.params.memberId];
  if (!member) return res.status(404).json({ error: "成员不存在" });
  if (req.params.memberId === room.ownerId) return res.status(400).json({ error: "管理员不能禁言自己" });
  const minutes = Math.max(1, Math.min(24 * 60, Number(req.body.minutes) || 10));
  member.mutedUntil = member.mutedUntil ? null : Date.now() + minutes * 60 * 1000;
  save();
  const target = store.users.find((user) => user.id === req.params.memberId);
  const muted = Boolean(member.mutedUntil);
  broadcast(room.id, {
    type: "moderation",
    action: muted ? "mute" : "unmute",
    username: target?.username || "成员",
    minutes: muted ? minutes : 0,
  });
  sendToUser(req.params.memberId, { type: "room_updated", room: safeRoom(room, req.params.memberId) });
  res.json({ room: safeRoom(room, req.user.id) });
});

app.delete("/api/rooms/:roomId/members/:memberId", auth, (req, res) => {
  const room = getRoom(req, res);
  if (!room || !requireOwner(room, req.user, res)) return;
  if (req.params.memberId === room.ownerId) return res.status(400).json({ error: "管理员不能踢出自己" });
  if (!room.members[req.params.memberId]) return res.status(404).json({ error: "成员不存在" });
  const target = store.users.find((user) => user.id === req.params.memberId);
  delete room.members[req.params.memberId];
  save();
  broadcast(room.id, { type: "member_kicked", username: target?.username || "成员" });
  sendToUser(req.params.memberId, { type: "kicked", roomId: room.id, roomName: room.name });
  res.json({ room: safeRoom(room, req.user.id) });
});

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: "/ws" });

function markSocketAlive() {
  this.isAlive = true;
}

wss.on("connection", (socket, request) => {
  const url = new URL(request.url, `http://${request.headers.host}`);
  const token = url.searchParams.get("token");
  const user = userFromToken(token);
  if (!user) {
    socket.close(1008, "未登录");
    return;
  }
  socket.userId = user.id;
  socket.isAlive = true;
  socket.subscriptions = new Set();
  socket.on("pong", markSocketAlive);

  socket.on("message", (raw) => {
    let payload;
    try {
      payload = JSON.parse(raw.toString());
    } catch {
      return;
    }
    const room = store.rooms.find((item) => item.id === payload.roomId);
    if (!room || !room.members[user.id]) return;

    if (payload.type === "subscribe") {
      let subscribers = sockets.get(room.id);
      if (!subscribers) sockets.set(room.id, (subscribers = new Set()));
      subscribers.add(socket);
      socket.subscriptions.add(room.id);
      return;
    }

    if (payload.type !== "message") return;
    const text = String(payload.text || "").trim().slice(0, 2000);
    if (!text) return;
    const membership = room.members[user.id];
    if (membership.mutedUntil && membership.mutedUntil > Date.now()) {
      socket.send(JSON.stringify({
        type: "error",
        message: `你已被禁言至 ${new Date(membership.mutedUntil).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })}`,
      }));
      return;
    }
    if (membership.mutedUntil && membership.mutedUntil <= Date.now()) {
      membership.mutedUntil = null;
      save();
    }
    const message = {
      id: id("msg"),
      roomId: room.id,
      userId: user.id,
      username: user.username,
      text,
      createdAt: now(),
    };
    store.messages.push(message);
    if (store.messages.length > 5000) store.messages = store.messages.slice(-5000);
    save();
    broadcast(room.id, { type: "message", message });
  });

  socket.on("close", () => removeSocketFromRooms(socket));
});

const heartbeatInterval = setInterval(() => {
  for (const socket of wss.clients) {
    if (socket.isAlive === false) {
      socket.terminate();
      continue;
    }
    socket.isAlive = false;
    socket.ping();
  }
}, 30000);

wss.on("close", () => clearInterval(heartbeatInterval));

app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

server.listen(PORT, () => {
  console.log(`Private chat running at http://localhost:${PORT}`);
});