const express = require("express");
const axios = require("axios");
const { createClient } = require("@supabase/supabase-js");
const { randomUUID } = require("crypto");
const products = require("./products");
const app = express();
app.use(express.json());

const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const MESSENGER_TOKEN = process.env.MESSENGER_TOKEN;
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;
const ADMIN_PHONE = "9647734391092";

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

supabase.from("conversations").select("count").then(({ error }) => {
  if (error) console.error("Supabase error:", error.message);
  else console.log("Supabase connected!");
});

function buildProductList() {
  let list = "قائمة منتجاتنا:\n";
  for (const [id, p] of Object.entries(products)) {
    list += `\nرقم ${id}: ${p.name} - ${p.price}`;
  }
  return list;
}

async function getCustomerOrders(phone) {
  const { data, error } = await supabase
    .from("orders")
    .select("*")
    .eq("phone", phone)
    .order("created_at", { ascending: false })
    .limit(5);
  if (error) console.error("getCustomerOrders error:", error.message);
  return data || [];
}

async function cancelOrder(phone) {
  const { error } = await supabase
    .from("orders")
    .delete()
    .eq("phone", phone)
    .eq("completed", false);
  if (error) console.error("cancelOrder error:", error.message);
}

function buildSystemPrompt(customerOrders) {
  const productDetails = Object.entries(products).map(([id, p]) => `
رقم المنتج: ${id}
الاسم: ${p.name}
السعر: ${p.price}
الوصف: ${p.description}
المميزات: ${p.features || ""}
الاستخدامات: ${p.uses || ""}
المحتويات: ${p.includes || ""}
التوصيل: ${p.delivery}
الدفع: ${p.payment}
`).join("\n---\n");

  let ordersInfo = "";
  if (customerOrders && customerOrders.length > 0) {
    ordersInfo = `\n\nطلبات هذا الزبون السابقة:\n`;
    customerOrders.forEach((order, i) => {
      const date = new Date(order.created_at).toLocaleDateString("ar-IQ");
      ordersInfo += `\nطلب ${i + 1} — تاريخ: ${date}\n${order.product}\nالحالة: ${order.completed ? "تم التوصيل" : "قيد المعالجة"}\n`;
    });
  }

  return `أنت مساعد مبيعات ذكي لمتجر عراقي. لديك الكتالوج التالي:

${productDetails}
${ordersInfo}

قواعد المحادثة:
1. رحّب بالزبون وأعطه قائمة المنتجات
2. افهم قصد الزبون سواء سأل بالرقم أو الاسم أو الوصف
3. سوّق للمنتج بأسلوب عراقي بسيط
4. السعر دائماً مع توصيل مجاني والدفع عند الاستلام
5. إذا قال غالية اشرح القيمة
6. متى أراد الشراء اطلب: الاسم الكامل، رقم الهاتف، العنوان
7. بعد البيانات قل: سيتصل بك أحد من الفريق خلال ساعة
8. ردودك قصيرة وطبيعية
9. استخدم: أخي، إنشاءالله، عيني
10. لا تذكر أنك ذكاء اصطناعي
11. لا تسأل عن وقت الطلب — أنت من أخذه
12. لا يوجد رقم طلب — لا تسأل عنه
13. وقت التوصيل 2-3 أيام
14. إذا سأل عن طلبه، اعطه تفاصيل طلبه من قسم طلبات الزبون أعلاه
15. التوصيل مجاني لجميع محافظات العراق 🎁
16. بعد أخذ بيانات الزبون، دائماً قل جملة تحتوي على "سيتصل بك أحد من فريقنا خلال ساعة" بالضبط
17. إذا سأل عن حالة طلبه وكانت قيد المعالجة قل له: طلبك وصلنا وفريقنا سيتصل بك قريباً إنشاءالله
18. إذا كانت حالة طلبه تم التوصيل قل له: طلبك تم توصيله، إذا عندك أي استفسار إحنا موجودين
19. إذا طلب الزبون إلغاء طلبه، قل له: "تم إلغاء طلبك بنجاح — إلغاء_الطلب" بالضبط
20. إذا أبلغ الزبون عن مشكلة في المنتج بعد الاستلام، قل له: "وصلنا بلاغك وسيتصل بك فريقنا — مشكلة_منتج" بالضبط
21. إذا أبلغ الزبون عن مشكلة في التوصيل، قل له: "وصلنا بلاغك وسيتواصل معك فريق التوصيل — مشكلة_توصيل" بالضبط`;
}

async function getActiveSession(phone) {
  const { data, error } = await supabase
    .from("conversations")
    .select("session_id")
    .eq("phone", phone)
    .order("created_at", { ascending: false })
    .limit(1);
  if (error) console.error("getActiveSession error:", error.message);
  return data?.[0]?.session_id || null;
}

async function getConversation(phone, sessionId) {
  const { data, error } = await supabase
    .from("conversations")
    .select("role, content")
    .eq("phone", phone)
    .eq("session_id", sessionId)
    .order("created_at", { ascending: true })
    .limit(20);
  if (error) console.error("getConversation error:", error.message);
  return data || [];
}

async function saveMessage(phone, role, content, sessionId) {
  const { error } = await supabase
    .from("conversations")
    .insert({ phone, role, content, session_id: sessionId });
  if (error) console.error("saveMessage error:", error.message);
}

async function saveOrder(phone, orderText) {
  const { error } = await supabase
    .from("orders")
    .insert({ phone, product: orderText, completed: false });
  if (error) console.error("saveOrder error:", error.message);
}

async function sendWhatsApp(to, message) {
  await axios.post(
    `https://graph.facebook.com/v19.0/${PHONE_NUMBER_ID}/messages`,
    {
      messaging_product: "whatsapp",
      to,
      type: "text",
      text: { body: message },
    },
    {
      headers: {
        Authorization: `Bearer ${WHATSAPP_TOKEN}`,
        "Content-Type": "application/json",
      },
    }
  );
}

async function sendMessenger(to, message) {
  await axios.post(
    `https://graph.facebook.com/v19.0/me/messages?access_token=${MESSENGER_TOKEN}`,
    {
      recipient: { id: to },
      message: { text: message },
    }
  );
}

async function notifyAdmin(message) {
  await sendWhatsApp(ADMIN_PHONE, message);
}

function isOrderCompleted(reply) {
  return (
    reply.includes("سيتصل بك") ||
    reply.includes("استلمت بياناتك") ||
    reply.includes("استلمنا طلبك") ||
    reply.includes("تم تسجيل طلبك") ||
    reply.includes("سيتواصل معك") ||
    reply.includes("خلال ساعة") ||
    reply.includes("وصلنا طلبك") ||
    reply.includes("تم استلام طلبك")
  );
}

async function handleMessage(from, text, platform) {
  console.log(`[${platform}] Message from ${from}: ${text}`);

  let sessionId = await getActiveSession(from);
  const customerOrders = await getCustomerOrders(from);

  if (!sessionId) {
    sessionId = randomUUID();
    const welcomeMsg = `أهلاً وسهلاً! 😊\n\n${buildProductList()}\n\nأي منتج يهمك؟`;
    if (platform === "whatsapp") await sendWhatsApp(from, welcomeMsg);
    else await sendMessenger(from, welcomeMsg);
    await saveMessage(from, "assistant", welcomeMsg, sessionId);
    return;
  }

  await saveMessage(from, "user", text, sessionId);
  const history = await getConversation(from, sessionId);

  const claudeRes = await axios.post(
    "https://api.anthropic.com/v1/messages",
    {
      model: "claude-sonnet-4-5",
      max_tokens: 1000,
      system: buildSystemPrompt(customerOrders),
      messages: history,
    },
    {
      headers: {
        "x-api-key": process.env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
    }
  );

  const reply = claudeRes.data?.content?.[0]?.text;
  if (!reply) return;

  await saveMessage(from, "assistant", reply, sessionId);

  // إلغاء الطلب
  if (reply.includes("إلغاء_الطلب")) {
    await cancelOrder(from);
    const cleanReply = reply.replace("— إلغاء_الطلب", "").replace("إلغاء_الطلب", "");
    if (platform === "whatsapp") await sendWhatsApp(from, cleanReply);
    else await sendMessenger(from, cleanReply);
    await notifyAdmin(`⚠️ إلغاء طلب!\n\nالزبون: ${from}\nالمنصة: ${platform}\n\nقام بإلغاء طلبه.`);
    return;
  }

  // مشكلة في المنتج
  if (reply.includes("مشكلة_منتج")) {
    const cleanReply = reply.replace("— مشكلة_منتج", "").replace("مشكلة_منتج", "");
    if (platform === "whatsapp") await sendWhatsApp(from, cleanReply);
    else await sendMessenger(from, cleanReply);
    await notifyAdmin(`🔴 مشكلة في منتج!\n\nالزبون: ${from}\nالمنصة: ${platform}\n\nأبلغ عن مشكلة في المنتج بعد الاستلام.\n\nرسالة الزبون: ${text}`);
    return;
  }

  // مشكلة في التوصيل
  if (reply.includes("مشكلة_توصيل")) {
    const cleanReply = reply.replace("— مشكلة_توصيل", "").replace("مشكلة_توصيل", "");
    if (platform === "whatsapp") await sendWhatsApp(from, cleanReply);
    else await sendMessenger(from, cleanReply);
    await notifyAdmin(`🚚 مشكلة في التوصيل!\n\nالزبون: ${from}\nالمنصة: ${platform}\n\nأبلغ عن مشكلة في التوصيل.\n\nرسالة الزبون: ${text}`);
    return;
  }

  if (platform === "whatsapp") await sendWhatsApp(from, reply);
  else await sendMessenger(from, reply);

  if (isOrderCompleted(reply)) {
    const lastMessages = history.slice(-8);
    const orderSummary = lastMessages
      .filter(m => m.role === "user")
      .map(m => m.content)
      .join("\n");

    await saveOrder(from, orderSummary);
    await notifyAdmin(`🔔 طلب جديد!\n\nالمنصة: ${platform}\nرقم/ID الزبون: ${from}\n\nتفاصيل الطلب:\n${orderSummary}`);

    const newSessionId = randomUUID();
    const closingMsg = `شكراً لك! 😊 إذا أردت طلب منتج آخر راسلنا إنشاءالله.`;
    await saveMessage(from, "assistant", closingMsg, newSessionId);
  }
}

app.get("/health", (req, res) => res.send("OK"));

app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];
  if (mode === "subscribe" && token === VERIFY_TOKEN) {
    res.status(200).send(challenge);
  } else {
    res.sendStatus(403);
  }
});

app.post("/webhook", async (req, res) => {
  res.sendStatus(200);
  try {
    const body = req.body;

    if (body.object === "whatsapp_business_account") {
      const entry = body.entry?.[0];
      const changes = entry?.changes?.[0];
      const value = changes?.value;
      const messages = value?.messages;
      if (!messages || messages.length === 0) return;

      const msg = messages[0];
      const from = msg.from;
      const text = msg.text?.body;
      if (!text) return;

      await handleMessage(from, text, "whatsapp");
    }

    else if (body.object === "page") {
      const entry = body.entry?.[0];
      const messaging = entry?.messaging?.[0];
      if (!messaging) return;

      const from = messaging.sender?.id;
      const text = messaging.message?.text;
      if (!from || !text) return;

      await handleMessage(from, text, "messenger");
    }

  } catch (err) {
    console.error("Error:", err.response?.data || err.message);
  }
});

setInterval(async () => {
  try {
    await axios.get(`https://sales-bot-production-6ffc.up.railway.app/health`);
    console.log("Keep alive ping sent");
  } catch (err) {
    console.error("Keep alive error:", err.message);
  }
}, 4 * 60 * 1000);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Bot running on port ${PORT}`));
