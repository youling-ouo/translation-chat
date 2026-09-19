require('dotenv').config(); // 載入環境變數
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
// 引入 Discord 機器人套件
const { Client, GatewayIntentBits, ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder } = require('discord.js');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// --- 這裡要填上你的 GitHub 資訊 ---
const GITHUB_OWNER = 'youling-ouo'; // 例如：youling-ouo
const GITHUB_REPO = 'translation-chat';      // 例如：translation-chat
const GITHUB_BRANCH = 'main';            // 通常是 main 或 master
// ---------------------------------

// 啟動 Discord 機器人
const discordClient = new Client({ intents: [GatewayIntentBits.Guilds] });
discordClient.login(process.env.DISCORD_TOKEN);

discordClient.once('ready', () => {
    console.log(`🤖 Discord 機器人已上線: ${discordClient.user.tag}`);
});

app.use(express.json());

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/dict.json', (req, res) => res.sendFile(path.join(__dirname, 'dict.json')));

// --- 核心功能：透過 API 修改 GitHub 檔案 ---
async function updateGitHubDict(cnTerm, twTerm) {
    const token = process.env.GITHUB_TOKEN;
    const url = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/dict.json`;

    // 1. 取得目前的 dict.json 檔案與它的 sha (版本代號)
    const getRes = await fetch(`${url}?ref=${GITHUB_BRANCH}`, {
        headers: { 'Authorization': `Bearer ${token}` }
    });
    const fileData = await getRes.json();
    
    // 2. 解碼並轉換為 JSON
    const contentStr = Buffer.from(fileData.content, 'base64').toString('utf8');
    const dict = JSON.parse(contentStr);

    // 3. 加入新單字
    dict[cnTerm] = twTerm;

    // 4. 重新編碼為 base64
    const newContentBase64 = Buffer.from(JSON.stringify(dict, null, 4), 'utf8').toString('base64');

    // 5. 將修改後的檔案推回 GitHub
    await fetch(url, {
        method: 'PUT',
        headers: { 
            'Authorization': `Bearer ${token}`, 
            'Content-Type': 'application/json' 
        },
        body: JSON.stringify({
            message: `🤖 Discord 機器人自動新增用語：${cnTerm} -> ${twTerm}`,
            content: newContentBase64,
            sha: fileData.sha,
            branch: GITHUB_BRANCH
        })
    });
}

// --- 接收前端回報，並發送附帶按鈕的 Discord 訊息 ---
app.post('/api/report', async (req, res) => {
    const { type, cnTerm, twTerm } = req.body;
    
    try {
        const channel = await discordClient.channels.fetch(process.env.DISCORD_CHANNEL_ID);
        
        // 建立漂亮的訊息卡片
        const embed = new EmbedBuilder()
            .setTitle("🚨 收到新的用語回報")
            .setColor(0x3498db)
            .addFields(
                { name: "回報類型", value: type === 'missing' ? '缺少用語' : '錯誤用語', inline: true },
                { name: "中國用語", value: cnTerm, inline: true },
                { name: "台灣用語", value: twTerm, inline: true }
            );

        // 建立 同意 / 不同意 按鈕
        // customId 格式我們自訂為 "approve_視頻_影片" 或 "reject_視頻_影片"
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

// --- 監聽你在 Discord 按下按鈕的動作 ---
discordClient.on('interactionCreate', async interaction => {
    if (!interaction.isButton()) return; // 如果不是按鈕動作就不管

    const customId = interaction.customId;
    const [action, cnTerm, twTerm] = customId.split('_'); // 拆解剛才藏在按鈕裡的單字

    if (action === 'approve') {
        // 先告訴 Discord "處理中，請稍候"，因為改 GitHub 需要幾秒鐘
        await interaction.deferUpdate(); 
        
        try {
            await updateGitHubDict(cnTerm, twTerm);
            // 修改原始訊息，把按鈕拿掉，避免重複按
            await interaction.editReply({ 
                content: `🎉 **已自動將 \`${cnTerm} ->${twTerm}\` 加入 GitHub 字典！**\n(Render 將會在 1~2 分鐘內自動更新網站)`, 
                embeds: [], components: [] 
            });
        } catch (error) {
            console.error("更新 GitHub 失敗:", error);
            await interaction.editReply({ content: "⚠️ 更新 GitHub 失敗，請檢查 Token 權限！", components: [] });
        }
    } else if (action === 'reject') {
        // 如果拒絕，直接修改訊息
        await interaction.update({ 
            content: `🚫 **已拒絕** \`${cnTerm} ->${twTerm}\` 的回報。`, 
            embeds: [], components: [] 
        });
    }
});


// (這下面是原本的 socket.io 聊天室邏輯，維持不變)
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