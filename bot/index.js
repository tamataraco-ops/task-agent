const { Client, GatewayIntentBits } = require('discord.js');
const { createClient } = require('@supabase/supabase-js');
const cron = require('node-cron');
const express = require('express');

// ── 環境変数 ──────────────────────────────────────────────────
const {
  DISCORD_TOKEN,
  DISCORD_CHANNEL_ID,   // タスク登録を受け付けるチャンネルID
  DISCORD_WEBHOOK_URL,  // リマインド通知先
  SUPABASE_URL,
  SUPABASE_KEY,
} = process.env;

// ── Supabase ─────────────────────────────────────────────────
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// ── Discord Bot ───────────────────────────────────────────────
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.DirectMessages,
  ],
  partials: ['CHANNEL'],
});

client.once('ready', () => {
  console.log(`✅ Bot起動: ${client.user.tag}`);
});

client.on('messageCreate', async (msg) => {
  if (msg.author.bot) return;

  // 監視チャンネルまたはDMのみ受け付け
  const isDM = msg.channel.type === 1;
  const isChannel = msg.channelId === DISCORD_CHANNEL_ID;
  if (!isDM && !isChannel) return;

  const text = msg.content.trim();
  if (!text || text.startsWith('#')) return;
  // !で始まる1行メッセージはタスク登録対象外（コマンド処理後もガード）
  const isCommand = /^![a-zA-Z]/.test(text);

  // ── コマンド ────────────────────────────────────────────────
  if (text === '!tasks' || text === '!list') {
    const { data } = await supabase
      .from('tasks')
      .select('*')
      .eq('done', false)
      .order('deadline', { ascending: true, nullsFirst: false });

    if (!data || !data.length) {
      await msg.reply('📋 未処理タスクはありません。');
      return;
    }
    const lines = data.map((t, i) => {
      const d = t.deadline ? ` / ${fmtDate(t.deadline)}` : '';
      const ov = t.deadline && new Date(t.deadline) < new Date() ? ' 🚨' : '';
      return `${i + 1}. **${t.name}** (${t.requester || '担当者未設定'}${d})${ov}`;
    });
    await msg.reply('📋 未処理タスク一覧:\n' + lines.join('\n'));
    return;
  }

  if (text === '!c' || text === '!help') {
    await msg.reply([
      '**タスク管理Bot の使い方**',
      '```',
      'タスク名',
      '依頼者（省略可）',
      'yyyy/m/d または m/d（日付・省略可）',
      'hh:mm（時刻・省略可）',
      'https://...（URL・省略可）',
      '```',
      '例：',
      '```',
      '議事録作成',
      '田中さん',
      '2026/5/10',
      '15:00',
      'https://example.com',
      '```',
      '',
      '**コマンド**',
      '`!tasks` — 未処理タスク一覧',
      '`!done 1` — 1番のタスクを完了にする',
      '`!c` / `!help` — このコマンド一覧',
    ].join('\n'));
    return;
  }

  // !done N でタスク完了
  const doneMatch = text.match(/^!done\s+(\d+)$/);
  if (doneMatch) {
    const n = parseInt(doneMatch[1]) - 1;
    const { data } = await supabase
      .from('tasks')
      .select('*')
      .eq('done', false)
      .order('deadline', { ascending: true, nullsFirst: false });
    if (!data || n < 0 || n >= data.length) {
      await msg.reply('❌ 番号が正しくありません。`!tasks` で一覧を確認してください。');
      return;
    }
    const task = data[n];
    await supabase.from('tasks').update({ done: true }).eq('id', task.id);
    await msg.reply(`✅ 完了しました：**${task.name}**`);
    return;
  }

  // ── タスク登録 ───────────────────────────────────────────────
  if (isCommand) {
    await msg.reply('❓ 不明なコマンドです。`!c` でコマンド一覧を確認してください。');
    return;
  }
  const task = parseTask(text);
  if (!task) {
    await msg.reply([
      '❌ 1行目にタスク名を入力してください。',
      '```',
      'タスク名',
      '依頼者（省略可）',
      'yyyy/m/d または m/d（日付・省略可）',
      'hh:mm（時刻・省略可）',
      'https://...（URL・省略可）',
      '```',
      '`!help` でヘルプを表示できます。',
    ].join('\n'));
    return;
  }

  const { error } = await supabase.from('tasks').insert(task);
  if (error) {
    console.error('Insert error:', error);
    await msg.reply('❌ 保存に失敗しました。しばらく後でお試しください。');
    return;
  }

  const ds = task.deadline ? `期限：${fmtDate(task.deadline)}` : '期限なし';
  await msg.reply(
    `✅ タスクを登録しました！\n**${task.name}** / ${task.requester || '担当者未設定'} / ${ds}`
  );
});

// ── パース（改行区切り） ─────────────────────────────────────
// 書式:
//   タスク名        ← 1行目 必須
//   依頼者          ← 2行目 省略可
//   5/10 15:00      ← 日付っぽい行 省略可
//   https://...     ← httpで始まる行 省略可
// 書式（改行区切り）:
//   タスク名           ← 必須
//   依頼者             ← 省略可
//   yyyy/m/d または m/d ← 省略可
//   hh:mm              ← 省略可（日付行の次に書く）
//   https://...        ← 省略可
function parseTask(text) {
  const lines = text.split(/\n/).map((s) => s.trim()).filter(Boolean);
  if (!lines[0]) return null;
  const name = lines[0];
  let requester = '', url = '';
  let dateStr = null, timeStr = null;

  for (let i = 1; i < lines.length; i++) {
    const l = lines[i];

    // URL
    if (l.startsWith('http')) { url = l; continue; }

    // 時刻のみ: hh:mm
    const timeOnly = l.match(/^(\d{1,2}):(\d{2})$/);
    if (timeOnly) { timeStr = l; continue; }

    // 日付: yyyy/m/d または m/d
    const dateMatch = l.match(/^(?:(\d{4})\/)?(\d{1,2})\/(\d{1,2})$/);
    if (dateMatch) { dateStr = l; continue; }

    // 依頼者（上記どれにも当たらない最初の行）
    if (!requester) requester = l;
  }

  let deadline = null;
  if (dateStr) {
    const dm = dateStr.match(/^(?:(\d{4})\/)?(\d{1,2})\/(\d{1,2})$/);
    const now = new Date();
    const year  = dm[1] ? +dm[1] : now.getFullYear();
    const month = +dm[2] - 1;
    const day   = +dm[3];
    let hour = 23, min = 59;
    if (timeStr) {
      const tm = timeStr.match(/^(\d{1,2}):(\d{2})$/);
      hour = +tm[1]; min = +tm[2];
    }
    // RenderサーバーはUTC動作のため、JST(UTC+9)として扱い9時間分オフセット
    const jstOffset = 9 * 60; // 分
    const localMs = Date.UTC(year, month, day, hour, min, 0) - jstOffset * 60 * 1000;
    deadline = new Date(localMs).toISOString();
  }

  return { name, requester, deadline, url, done: false, reminded: false, last_overdue: null };
}

function fmtDate(iso) {
  const d = new Date(iso);
  return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

// ── Webhook送信 ───────────────────────────────────────────────
async function sendWebhook(msg) {
  if (!DISCORD_WEBHOOK_URL) return;
  try {
    await fetch(DISCORD_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: msg }),
    });
  } catch (e) { console.error('Webhook error:', e); }
}

// ── リマインダー（毎分チェック） ─────────────────────────────
cron.schedule('* * * * *', async () => {
  const now = new Date();

  // 期限1時間前チェック
  const soon = new Date(now.getTime() + 60 * 60 * 1000);
  const { data: toRemind } = await supabase
    .from('tasks')
    .select('*')
    .eq('done', false)
    .eq('reminded', false)
    .lte('deadline', soon.toISOString())
    .gt('deadline', now.toISOString());

  for (const t of (toRemind || [])) {
    await sendWebhook(
      `⏰ **リマインド**\nタスク「${t.name}」の期限まで約1時間です！\n依頼者：${t.requester || '未設定'}\n期限：${fmtDate(t.deadline)}${t.url ? '\n参考：' + t.url : ''}`
    );
    await supabase.from('tasks').update({ reminded: true }).eq('id', t.id);
  }

  // 期限超過チェック（1時間ごと再通知）
  const hourAgo = new Date(now.getTime() - 60 * 60 * 1000);
  const { data: overdue } = await supabase
    .from('tasks')
    .select('*')
    .eq('done', false)
    .lt('deadline', now.toISOString())
    .or(`last_overdue.is.null,last_overdue.lte.${hourAgo.toISOString()}`);

  for (const t of (overdue || [])) {
    const h = Math.floor((now - new Date(t.deadline)) / 3600000);
    await sendWebhook(
      `🚨 **期限超過**\nタスク「${t.name}」が${h}時間超過しています！\n依頼者：${t.requester || '未設定'}\n期限：${fmtDate(t.deadline)}${t.url ? '\n参考：' + t.url : ''}`
    );
    await supabase.from('tasks').update({ last_overdue: now.toISOString() }).eq('id', t.id);
  }
});

// ── Expressサーバー（Renderのヘルスチェック兼スリープ防止） ──
const app = express();
app.get('/', (_, res) => res.send('Task Agent Bot is running.'));
app.get('/health', (_, res) => res.json({ status: 'ok', time: new Date().toISOString() }));
app.listen(process.env.PORT || 3000, () => console.log('HTTP server ready'));

// ── Bot起動 ──────────────────────────────────────────────────
client.login(DISCORD_TOKEN);
