const state = {
  token: localStorage.getItem("private_chat_token"),
  user: null,
  rooms: [],
  activeRoom: null,
  socket: null,
  authMode: "login",
};

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];

function showToast(message) {
  const toast = $("#toast");
  toast.textContent = message;
  toast.classList.add("show");
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => toast.classList.remove("show"), 2800);
}

async function api(path, options = {}) {
  const headers = { "Content-Type": "application/json", ...(options.headers || {}) };
  if (state.token) headers.Authorization = `Bearer ${state.token}`;
  const response = await fetch(path, { ...options, headers });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || "请求失败");
  return body;
}

function setAuthMode(mode) {
  state.authMode = mode;
  $$(".tab").forEach((tab) => tab.classList.toggle("active", tab.dataset.authTab === mode));
  $("#auth-submit-label").textContent = mode === "login" ? "进入聊天室" : "创建账号";
  $("#auth-password").autocomplete = mode === "login" ? "current-password" : "new-password";
}

function initials(name) {
  return (name || "?").slice(0, 1).toUpperCase();
}

function formatTime(iso) {
  return new Date(iso).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.ceil(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function renderUser() {
  $("#current-username").textContent = state.user.username;
  $("#user-avatar").textContent = initials(state.user.username);
}

function renderRooms() {
  const list = $("#room-list");
  list.innerHTML = "";
  if (!state.rooms.length) {
    list.innerHTML = `<div class="empty-room-note">还没有房间</div>`;
  }
  state.rooms.forEach((room) => {
    const button = document.createElement("button");
    button.className = `room-item ${state.activeRoom?.id === room.id ? "active" : ""}`;
    button.innerHTML = `<span class="hash">#</span><span>${escapeHtml(room.name)}</span><span class="room-count">${room.memberCount}</span>`;
    button.addEventListener("click", () => selectRoom(room.id));
    list.appendChild(button);
  });
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" })[char]);
}

async function loadRooms() {
  const data = await api("/api/rooms");
  state.rooms = data.rooms;
  renderRooms();
  if (state.rooms.length && !state.activeRoom) selectRoom(state.rooms[0].id);
}

function connectSocket() {
  if (state.socket) state.socket.close();
  const protocol = location.protocol === "https:" ? "wss" : "ws";
  state.socket = new WebSocket(`${protocol}://${location.host}/ws?token=${encodeURIComponent(state.token)}`);
  state.socket.addEventListener("open", () => {
    if (state.activeRoom) {
      state.socket.send(JSON.stringify({ type: "subscribe", roomId: state.activeRoom.id }));
    }
  });
  state.socket.addEventListener("message", (event) => {
    const payload = JSON.parse(event.data);
    if (payload.type === "message" && payload.message.roomId === state.activeRoom?.id) appendMessage(payload.message);
    if (payload.type === "moderation" && state.activeRoom?.id) appendSystem(`${payload.username} ${payload.action === "mute" ? `被禁言 ${payload.minutes} 分钟` : "被解除禁言"}`);
    if (payload.type === "member_kicked") {
      appendSystem(`${payload.username} 已被移出房间`);
      refreshActiveRoom();
    }
    if (payload.type === "kicked" && payload.roomId === state.activeRoom?.id) {
      showToast("你已被房主移出这个房间");
      state.activeRoom = null;
      loadRooms();
      resetChat();
    }
    if (payload.type === "room_updated" && payload.room.id === state.activeRoom?.id) {
      state.activeRoom = payload.room;
      renderHeader();
    }
    if (payload.type === "member_joined" && state.activeRoom?.isOwner) refreshActiveRoom();
    if (payload.type === "error") showToast(payload.message);
  });
  state.socket.addEventListener("close", () => {
    if (state.token) setTimeout(connectSocket, 800);
  });
}

async function selectRoom(roomId) {
  try {
    const [roomData, messagesData] = await Promise.all([
      api(`/api/rooms/${roomId}`),
      api(`/api/rooms/${roomId}/messages`),
    ]);
    state.activeRoom = roomData.room;
    renderRooms();
    renderHeader();
    const list = $("#message-list");
    list.innerHTML = "";
    $("#empty-chat").classList.add("hidden");
    list.classList.remove("hidden");
    $("#message-form").classList.remove("hidden");
    messagesData.messages.forEach(appendMessage);
    list.scrollTop = list.scrollHeight;
    if (state.socket?.readyState === WebSocket.OPEN) state.socket.send(JSON.stringify({ type: "subscribe", roomId }));
  } catch (error) {
    showToast(error.message);
  }
}

function renderHeader() {
  const room = state.activeRoom;
  if (!room) return;
  $("#room-name").textContent = room.name;
  $("#room-meta").textContent = `${room.memberCount} 位成员 · ${room.isOwner ? "你是房主" : "私密房间"}`;
  $("#owner-tools").classList.toggle("hidden", !room.isOwner);
  $("#members-panel").classList.add("hidden");
}

function resetChat() {
  $("#room-name").textContent = "选择一个房间";
  $("#room-meta").textContent = "从左侧进入或创建房间";
  $("#owner-tools").classList.add("hidden");
  $("#message-list").classList.add("hidden");
  $("#message-form").classList.add("hidden");
  $("#empty-chat").classList.remove("hidden");
  renderRooms();
}

function appendMessage(message) {
  const list = $("#message-list");
  const mine = message.userId === state.user.id;
  const row = document.createElement("div");
  row.className = `message-row ${mine ? "mine" : ""}`;
  const attachment = message.attachment
    ? `<a href="#" class="attachment-link" data-file-id="${escapeHtml(message.attachment.id)}"><span class="attachment-icon">⌕</span><span>${escapeHtml(message.attachment.originalName)}<small> · ${formatBytes(message.attachment.size)}</small></span></a>`
    : "";
  const text = message.text ? `<div class="bubble">${escapeHtml(message.text)}</div>` : "";
  row.innerHTML = `<div class="message-avatar">${initials(message.username)}</div><div class="message-content"><div class="message-meta"><strong>${escapeHtml(message.username)}</strong><time>${formatTime(message.createdAt)}</time></div>${text}${attachment}</div>`;
  row.querySelector(".attachment-link")?.addEventListener("click", async (event) => {
    event.preventDefault();
    const link = event.currentTarget;
    link.classList.add("loading");
    try {
      const response = await fetch(`/api/files/${encodeURIComponent(link.dataset.fileId)}`, { headers: { Authorization: `Bearer ${state.token}` } });
      if (!response.ok) throw new Error("文件下载失败");
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = message.attachment.originalName;
      anchor.click();
      URL.revokeObjectURL(url);
    } catch (error) { showToast(error.message); } finally { link.classList.remove("loading"); }
  });
  list.appendChild(row);
  list.scrollTop = list.scrollHeight;
}

function appendSystem(text) {
  const node = document.createElement("div");
  node.className = "system-message";
  node.textContent = text;
  $("#message-list").appendChild(node);
  $("#message-list").scrollTop = $("#message-list").scrollHeight;
}

async function refreshActiveRoom() {
  if (!state.activeRoom) return;
  const data = await api(`/api/rooms/${state.activeRoom.id}`);
  state.activeRoom = data.room;
  renderHeader();
  if (!$("#members-panel").classList.contains("hidden")) renderMembers();
}

function renderMembers() {
  const list = $("#members-list");
  list.innerHTML = "";
  state.activeRoom.members.forEach((member) => {
    const item = document.createElement("div");
    item.className = "member-card";
    const isOwner = member.role === "owner";
    const isMuted = member.mutedUntil && new Date(member.mutedUntil).getTime() > Date.now();
    item.innerHTML = `<div class="avatar">${initials(member.username)}</div><div class="member-info"><strong>${escapeHtml(member.username)}</strong><small>${isOwner ? "房主" : isMuted ? "已禁言" : "成员"}</small></div>${isOwner ? "" : `<button class="member-action mute-action">${isMuted ? "解禁" : "禁言"}</button><button class="member-action kick-action">移除</button>`}`;
    item.querySelector(".mute-action")?.addEventListener("click", async () => {
      try { await api(`/api/rooms/${state.activeRoom.id}/members/${member.id}/mute`, { method: "POST", body: JSON.stringify({ minutes: 10 }) }); await refreshActiveRoom(); showToast(isMuted ? "已解除禁言" : "已禁言 10 分钟"); } catch (error) { showToast(error.message); }
    });
    item.querySelector(".kick-action")?.addEventListener("click", async () => {
      if (!confirm(`确定要将 ${member.username} 移出房间吗？`)) return;
      try { await api(`/api/rooms/${state.activeRoom.id}/members/${member.id}`, { method: "DELETE" }); await refreshActiveRoom(); showToast("成员已移除"); } catch (error) { showToast(error.message); }
    });
    list.appendChild(item);
  });
}

async function enterApp() {
  try {
    const data = await api("/api/me");
    state.user = data.user;
    $("#auth-view").classList.add("hidden");
    $("#app-view").classList.remove("hidden");
    renderUser();
    await loadRooms();
    connectSocket();
  } catch {
    localStorage.removeItem("private_chat_token");
    state.token = null;
  }
}

$("#auth-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const button = event.currentTarget.querySelector("button[type=submit]");
  button.disabled = true;
  try {
    const path = state.authMode === "login" ? "/api/auth/login" : "/api/auth/register";
    const data = await api(path, { method: "POST", body: JSON.stringify({ username: $("#auth-username").value, password: $("#auth-password").value }) });
    state.token = data.token;
    localStorage.setItem("private_chat_token", state.token);
    await enterApp();
  } catch (error) { showToast(error.message); } finally { button.disabled = false; }
});

$$(".tab").forEach((tab) => tab.addEventListener("click", () => setAuthMode(tab.dataset.authTab)));

$("#message-form").addEventListener("submit", (event) => {
  event.preventDefault();
  const input = $("#message-input");
  const text = input.value.trim();
  if (!text || !state.activeRoom || state.socket?.readyState !== WebSocket.OPEN) return;
  state.socket.send(JSON.stringify({ type: "message", roomId: state.activeRoom.id, text }));
  input.value = "";
});

$("#file-input").addEventListener("change", async (event) => {
  const file = event.target.files[0];
  if (!file || !state.activeRoom) return;
  if (file.size > 10 * 1024 * 1024) {
    showToast("文件不能超过 10MB");
    event.target.value = "";
    return;
  }
  const formData = new FormData();
  formData.append("file", file);
  showToast("文件上传中…");
  try {
    const response = await fetch(`/api/rooms/${state.activeRoom.id}/upload`, { method: "POST", headers: { Authorization: `Bearer ${state.token}` }, body: formData });
    const body = await response.json();
    if (!response.ok) throw new Error(body.error || "文件上传失败");
    showToast("文件已发送");
  } catch (error) { showToast(error.message); } finally { event.target.value = ""; }
});

$("#new-room-button").addEventListener("click", () => $("#room-dialog").showModal());
$("#join-floating").addEventListener("click", () => $("#join-dialog").showModal());

$("#room-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    const data = await api("/api/rooms", { method: "POST", body: JSON.stringify({ name: $("#room-name-input").value }) });
    $("#room-dialog").close();
    $("#room-name-input").value = "";
    await loadRooms();
    await selectRoom(data.room.id);
    showToast("房间创建成功，邀请码已生成");
    navigator.clipboard?.writeText(data.room.inviteCode);
  } catch (error) { showToast(error.message); }
});

$("#join-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    const data = await api("/api/rooms/join", { method: "POST", body: JSON.stringify({ inviteCode: $("#invite-input").value }) });
    $("#join-dialog").close();
    $("#invite-input").value = "";
    await loadRooms();
    await selectRoom(data.room.id);
    showToast("已加入私密房间");
  } catch (error) { showToast(error.message); }
});

$("#invite-button").addEventListener("click", async () => {
  if (!state.activeRoom) return;
  await navigator.clipboard?.writeText(state.activeRoom.inviteCode);
  showToast(`邀请码 ${state.activeRoom.inviteCode} 已复制`);
});

$("#members-button").addEventListener("click", () => {
  $("#members-panel").classList.remove("hidden");
  renderMembers();
});
$("#close-members").addEventListener("click", () => $("#members-panel").classList.add("hidden"));
$("#logout-button").addEventListener("click", async () => {
  try { await api("/api/auth/logout", { method: "POST" }); } catch {}
  localStorage.removeItem("private_chat_token");
  location.reload();
});

if (state.token) enterApp();
