// screen-time-mcp/index.js（整合版，包含屏幕时间 + AI触发拍照）
import express from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { createClient } from "@supabase/supabase-js";
import { z } from "zod";

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function makeServer() {
  const server = new McpServer({ name: "screen-time-memory", version: "3.0.0" });

  // ─── 屏幕时间工具 ───────────────────────────────────────

  server.tool("get_screen_time", "获取今天的屏幕使用时间和App排行", {}, async () => {
    const today = new Date().toISOString().split("T")[0];
    const { data: summary } = await supabase.from("daily_summary")
      .select("*").eq("date", today).single();
    const { data: apps } = await supabase.from("app_usage")
      .select("app_name,total_minutes").eq("date", today)
      .order("total_minutes", { ascending: false }).limit(15);
    const { count: unlocks } = await supabase.from("screen_sessions")
      .select("*", { count: "exact", head: true })
      .eq("event", "unlock").gte("created_at", today + "T00:00:00Z");

    const totalHours = summary ? (summary.screen_minutes / 60).toFixed(1) : "?";
    let text = `📱 今日屏幕时间：${totalHours}小时\n🔓 解锁次数：${unlocks ?? 0}次\n\n▼ App使用排行\n`;
    apps?.forEach(a => { text += `  ${a.app_name}：${a.total_minutes}分钟\n`; });
    return { content: [{ type: "text", text }] };
  });

  server.tool("get_week_trend", "获取最近7天的使用趋势", {}, async () => {
    const { data } = await supabase.from("daily_summary")
      .select("date,screen_minutes,unlock_count")
      .order("date", { ascending: false }).limit(7);
    const text = data?.map(d =>
      `${d.date}：${(d.screen_minutes/60).toFixed(1)}小时，解锁${d.unlock_count}次`
    ).join("\n") || "暂无数据";
    return { content: [{ type: "text", text: "最近7天：\n" + text }] };
  });

  // ─── 摄像头工具 ─────────────────────────────────────────

  server.tool(
    "request_snapshot",
    "让手机拍一张前置摄像头照片，等待拍摄完成后直接返回图片。手机需在线且App在运行。",
    {},
    async () => {
      // 1. 插入拍照命令
      const { error } = await supabase.from("commands")
        .insert({ type: "take_photo", status: "pending" });
      if (error) return { content: [{ type: "text", text: "发送拍照指令失败: " + error.message }] };

      // 2. 记录当前时间，用于判断是否有新照片
      const requestTime = new Date();

      // 3. 轮询等待（最多45秒，每3秒查一次）
      for (let i = 0; i < 40; i++) {
        await sleep(3000);
        const { data } = await supabase.from("snapshots")
          .select("*").order("taken_at", { ascending: false }).limit(1).single();

        if (data && new Date(data.taken_at) > new Date(requestTime - 5000)) {
          // 有新照片！下载并返回
          try {
            const imgRes = await fetch(data.url);
            if (imgRes.ok) {
              const buf = await imgRes.arrayBuffer();
              const base64 = Buffer.from(buf).toString("base64");
              return {
                content: [
                  { type: "text", text: `📷 拍摄时间：${new Date(data.taken_at).toLocaleString("zh-CN")}` },
                  { type: "image", data: base64, mimeType: "image/jpeg" }
                ]
              };
            }
          } catch (e) {
            return { content: [{ type: "text", text: `照片已拍摄：${data.url}` }] };
          }
        }
      }

      return { content: [{ type: "text", text: "⏱ 超时（45秒无响应）\n请确认：① 手机联网 ② App正在运行" }] };
    }
  );

  server.tool("get_latest_snapshot", "获取最新一张快照（不触发拍照）", {}, async () => {
    const { data } = await supabase.from("snapshots")
      .select("*").order("taken_at", { ascending: false }).limit(1).single();
    if (!data) return { content: [{ type: "text", text: "还没有任何快照" }] };
    try {
      const imgRes = await fetch(data.url);
      const base64 = Buffer.from(await imgRes.arrayBuffer()).toString("base64");
      return {
        content: [
          { type: "text", text: `拍摄时间：${new Date(data.taken_at).toLocaleString("zh-CN")}` },
          { type: "image", data: base64, mimeType: "image/jpeg" }
        ]
      };
    } catch {
      return { content: [{ type: "text", text: `最新快照 URL：${data.url}` }] };
    }
  });

  return server;
}

const app = express();

app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Headers", "*");
  res.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  if (req.method === "OPTIONS") return res.sendStatus(200);
  next();
});
app.use(express.json());
const sessions = {};

app.get("/sse", async (req, res) => {
  const t = new SSEServerTransport("/messages", res);
  sessions[t.sessionId] = t;
  await makeServer().connect(t);
  res.on("close", () => delete sessions[t.sessionId]);
});

app.post("/messages", async (req, res) => {
  const t = sessions[req.query.sessionId];
  if (!t) return res.status(404).end();
  await t.handlePostMessage(req, res, req.body);
});

app.get("/", (_, res) => res.send("Screen Time MCP v3 OK"));
app.listen(process.env.PORT || 3000, () => console.log("MCP running on", process.env.PORT || 3000));
