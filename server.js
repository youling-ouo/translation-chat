require('dotenv').config(); // 載入環境變數
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
// 引入 Discord 機器人套件
const { Client, GatewayIntentBits, ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder } = require('discord.js');

// 1. 引入 Firebase Admin SDK
const { initializeApp, cert } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// --- Firebase 初始化 ---
let serviceAccount;
if (process.env.FIREBASE_SERVICE_ACCOUNT) {
    serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
} else {
    serviceAccount = require('./serviceAccountKey.json');
}

initializeApp({
    credential: cert(serviceAccount)
});

const db = getFirestore(undefined, 'default');
const dictDocRef = db.collection('dictionary').doc('main');
// ------------------------

// 啟動 Discord 機器人
const discordClient = new Client({ intents: [GatewayIntentBits.Guilds] });
discordClient.login(process.env.DISCORD_TOKEN);

discordClient.once('ready', () => {
    console.log(`🤖 Discord 機器人已上線: ${discordClient.user.tag}`);
});

app.use(express.json());

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

// --- 修改：直接從 Firebase 讀取字典檔傳給前端 ---
app.get('/dict.json', async (req, res) => {
    try {
        const doc = await dictDocRef.get();
        if (doc.exists) {
            console.log("資料庫讀取結果:", doc.data());
            res.json(doc.data());
        } else {
            res.json({}); // 若資料庫內無資料則回傳空物件
        }
    } catch (err) {
        console.error('從 Firebase 讀取字典失敗:', err);
        res.status(500).json({ error: '無法取得字典檔' });
    }
});

// --- 修改：寫入新用語到 Firebase ---
async function updateFirebaseDict(cnTerm, twTerm) {
    // 使用 { merge: true }，只會新增/更新該欄位，不會覆蓋整份資料
    await dictDocRef.set({
        [cnTerm]: twTerm
    }, { merge: true });
}

// --- 接收前端回報，並發送附帶按鈕的 Discord 訊息 (維持原樣) ---
app.post('/api/report', async (req, res) => {
    const { type, cnTerm, twTerm } = req.body;
    
    try {
        const channel = await discordClient.channels.fetch(process.env.DISCORD_CHANNEL_ID);
        
        // 建立訊息卡片
        const embed = new EmbedBuilder()
            .setTitle("🚨 收到新的用語回報")
            .setColor(0x3498db)
            .addFields(
                { name: "回報類型", value: type === 'missing' ? '缺少用語' : '錯誤用語', inline: true },
                { name: "中國用語", value: cnTerm, inline: true },
                { name: "台灣用語", value: twTerm, inline: true }
            );

        // 建立 同意 / 不同意 按鈕
        const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setCustomId(`approve_${cnTerm}_${twTerm}`)
                .setLabel('✅ 同意並自動加入字典')
                .setStyle(ButtonStyle.Success),
            new ButtonBuilder()
                .setCustomId(`reject_${cnTerm}_${twTerm}`)
                .setLabel('❌ 拒絕')
                .setStyle(ButtonStyle.Danger)
        );

        await channel.send({ embeds: [embed], components: [row] });
        res.json({ success: true, message: '回報成功' });
    } catch (err) {
        console.error('發送 Discord 失敗:', err);
        res.status(500).json({ success: false });
    }
});

// --- 監聽 Discord 按紐動作 ---
discordClient.on('interactionCreate', async interaction => {
    if (!interaction.isButton()) return;

    const customId = interaction.customId;
    const [action, cnTerm, twTerm] = customId.split('_');

    if (action === 'approve') {
        await interaction.deferUpdate(); 
        
        try {
            // 呼叫寫入 Firebase 函式
            await updateFirebaseDict(cnTerm, twTerm);
            
            // 修改原始訊息（注意：換成 Firebase 後是「即時生效」！）
            await interaction.editReply({ 
                content: `🎉 **已自動將 \`${cnTerm} ->${twTerm}\` 加入 Firebase 字典！**\n(前端網頁重新整理即可立刻看到效果)`, 
                embeds: [], components: [] 
            });
        } catch (error) {
            console.error("更新 Firebase 失敗:", error);
            await interaction.editReply({ content: "⚠️ 更新 Firebase 失敗，請檢查權限設定！", components: [] });
        }
    } else if (action === 'reject') {
        await interaction.update({ 
            content: `🚫 **已拒絕** \`${cnTerm} ->${twTerm}\` 的回報。`, 
            embeds: [], components: [] 
        });
    }
});

// --- Socket.io 邏輯 (完全維持原樣) ---
const activeRooms = new Map();
const socketInfo = new Map();

io.on('connection', (socket) => {
    socket.on('createRoom', (data) => {
        const room = Math.random().toString(36).substring(2, 10);
        activeRooms.set(room, new Set([socket.id]));
        socketInfo.set(socket.id, { room, id: data.id });
        socket.join(room);
        socket.emit('roomCreated', { room });
        socket.emit('sysMessage', `您已成功建立並加入聊天室。`);
    });

    socket.on('joinRoom', (data) => {
        const { room, id } = data;
        if (!activeRooms.has(room)) {
            socket.emit('roomError', '此聊天室已經失效或不存在！');
            return;
        }
        activeRooms.get(room).add(socket.id);
        socketInfo.set(socket.id, { room, id });
        socket.join(room);
        socket.to(room).emit('sysMessage', `${id} 已匿名加入聊天室`);
        socket.emit('sysMessage', `您已成功加入聊天室。`);
    });

    socket.on('sendMessage', (data) => {
        io.to(data.room).emit('receiveMessage', { id: data.id, text: data.text });
    });

    socket.on('disconnect', () => {
        const info = socketInfo.get(socket.id);
        if (info) {
            const { room, id } = info;
            socket.to(room).emit('sysMessage', `${id} 已離開聊天室`);
            const roomUsers = activeRooms.get(room);
            if (roomUsers) {
                roomUsers.delete(socket.id);
                if (roomUsers.size === 0) activeRooms.delete(room);
            }
            socketInfo.delete(socket.id);
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`伺服器已啟動: http://localhost:${PORT}`);
});