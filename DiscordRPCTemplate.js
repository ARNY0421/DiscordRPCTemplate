const net = require('net');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const readline = require('readline');

const clientId = 'CLIENTID'; //plz enter ClientID
const clientSecret = 'CLIENTSECRET'; //plz enter ClientSecret
const TOKEN_PATH = path.join(__dirname, 'token.json');

const getIpcPath = (id) => `\\\\?\\pipe\\discord-ipc-${id}`;

function encode(op, data) {
    const payload = JSON.stringify(data);
    const len = Buffer.byteLength(payload);
    const packet = Buffer.alloc(8 + len);
    packet.writeInt32LE(op, 0);
    packet.writeInt32LE(len, 4);
    packet.write(payload, 8);
    return packet;
}

let socket;
let currentMute = false;

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

// --- 1. トークンをファイルから読み込む (失敗しても止まらない) ---
function loadSavedToken() {
    try {
        if (fs.existsSync(TOKEN_PATH)) {
            const data = JSON.parse(fs.readFileSync(TOKEN_PATH, 'utf-8'));
            return data.accessToken;
        }
    } catch (e) {
        console.log("保存されたトークンの読み込みに失敗しました。");
    }
    return null;
}

// --- 2. 認可コードをアクセストークンに交換する ---
async function exchangeCode(code) {
    console.log("トークンを交換中...");
    const response = await fetch('https://discord.com/api/v10/oauth2/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
            client_id: clientId,
            client_secret: clientSecret,
            grant_type: 'authorization_code',
            code: code,
            redirect_uri: 'http://127.0.0.1'
        })
    });
    const data = await response.json();

    if (data.access_token) {
        fs.writeFileSync(TOKEN_PATH, JSON.stringify({ accessToken: data.access_token }, null, 2));
        return data.access_token;
    }
    throw new Error("トークン交換に失敗しました");
}

async function start() {
    let accessToken = loadSavedToken();

    socket = net.createConnection(getIpcPath(0));

    socket.on('connect', () => {
        socket.write(encode(0, { v: 1, client_id: clientId }));
    });

    socket.on('data', async (data) => {
        try {
            const payload = JSON.parse(data.slice(8).toString());

            // A: 初期接続成功 -> 認証へ
            if (payload.evt === 'READY') {
                if (accessToken) {
                    console.log("既存トークンで認証を試みます...");
                    socket.write(encode(1, { cmd: 'AUTHENTICATE', args: { access_token: accessToken }, nonce: 'AUTH' }));
                } else {
                    console.log("トークンがないため、認証を開始します...");
                    socket.write(encode(1, { 
                        cmd: 'AUTHORIZE', 
                        args: { client_id: clientId, scopes: ['rpc', 'rpc.voice.write', 'rpc.voice.read'] }, 
                        nonce: 'AUTH_REQ' 
                    }));
                }
            }

            // B: ブラウザでの承認が完了し、Codeが届いた
            if (payload.cmd === 'AUTHORIZE' && payload.data.code) {
                try {
                    accessToken = await exchangeCode(payload.data.code);
                    // 新しいトークンで再度認証
                    socket.write(encode(1, { cmd: 'AUTHENTICATE', args: { access_token: accessToken }, nonce: 'AUTH' }));
                } catch (err) {
                    console.error("認証失敗:", err.message);
                }
            }

            // C: トークンが無効だった場合 (再取得へ)
            if (payload.evt === 'ERROR' && payload.data.code === 4001) {
                console.log("トークンが無効なため再取得します...");
                fs.unlinkSync(TOKEN_PATH); // 古いファイルを消す
                accessToken = null;
                socket.write(encode(1, { 
                    cmd: 'AUTHORIZE', 
                    args: { client_id: clientId, scopes: ['rpc', 'rpc.voice.write', 'rpc.voice.read'] }, 
                    nonce: 'AUTH_REQ' 
                }));
            }

            // D: 最終的なログイン成功
            if (payload.cmd === 'AUTHENTICATE' && !payload.evt) {
                console.log("\n>>> Discordログイン成功");
                socket.write(encode(1, { cmd: 'GET_VOICE_SETTINGS', args: {}, nonce: 'INIT' }));
                socket.write(encode(1, { cmd: 'SUBSCRIBE', evt: 'VOICE_SETTINGS_UPDATE', nonce: crypto.randomUUID() }));
            }

            // E: ミュート状態の更新
            if (payload.evt === 'VOICE_SETTINGS_UPDATE' || payload.nonce === 'INIT') {
                currentMute = payload.data.mute;
                process.stdout.write(`\r[現在: ${currentMute ? '● MUTE ' : '○ LIVE '}] Enterで切替: `);
            }

        } catch (e) { /* パースエラー無視 */ }
    });

    rl.on('line', () => {
        socket.write(encode(1, {
            cmd: 'SET_VOICE_SETTINGS',
            args: { mute: !currentMute },
            nonce: crypto.randomUUID()
        }));
    });
}

start();