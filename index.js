const express = require("express");
const axios = require("axios");
const { createClient } = require("@supabase/supabase-js");
const { randomUUID } = require("crypto");
const products = require("./products");
const app = express();
app.use(express.json());

const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;
const ADMIN_PHONE = "9647734391092";

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

// اختبار اتصال Supabase عند البداية
supabase.from("conversations").select("count").then(({ data, error }) => {
  if (error) console.error("Supabase connection error:", error.message);
  else console.log("Supabase connected successfully!");
});

function buildProductList() {
  let list = "قائمة منتجاتنا:\n";
  for (const [id, p] of Object.entries(products)) {
    list += `\nرقم ${id}: ${p.name} - ${p.price}`;
  }
  return list;
}

function buildSystemPrompt() {
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

  return `أنت مساعد مبيعات ذكي لمتجر عراقي. لديك الكتالوج التالي:

${productDetails}

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
11. أنت تعلم متى استلمت الطلب لأنك أنت من أخذه — لا تسأل الزبون عن وقت الطلب
12. لا يوجد رقم طلب في نظامنا — لا تسأل عنه أبداً
13. وقت التوصيل المعتاد 2-3 أيام عمل داخل العراق
14. إذا سأل عن طلبه قل له: طلبك وصلنا وسيتصل بك فريقنا قريباً للتأكيد
15. إذا سأل عن أجرة التوصيل أو سعر الشحن قل له: التوصيل مجاني لجميع محافظات العراق 🎁`;
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
      to: to,
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

async function notifyAdmin(orderInfo) {
  const msg = `🔔 طلب جديد!\n\n${orderInfo}\n\nافتح Supabase لرؤية كل الطلبات.`;
  await sendWhatsApp(ADMIN_PHONE, msg);
}

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
    const entry = req.body.entry?.[0];
    const changes = entry?.changes?.[0];
    const value = changes?.value;
    const messages = value?.messages;
    if (!messages || messages.length === 0) return;

    const msg = messages[0];
    const from = msg.from;
    const text = msg.text?.body;
    if (!text) return;

    console.log(`Message from ${from}: ${text}`);

    if (from === ADMIN_PHONE) return;

    let sessionId = await getActiveSession(from);
    console.log(`Session ID for ${from}: ${sessionId}`);

    if (!sessionId) {
      sessionId = randomUUID();
      console.log(`New session created: ${sessionId}`);
      const welcomeMsg = `أهلاً وسهلاً! 😊\n\n${buildProductList()}\n\nأي منتج يهمك؟`;
      await sendWhatsApp(from, welcomeMsg);
      await saveMessage(from, "assistant", welcomeMsg, sessionId);
      return;
    }

    await saveMessage(from, "user", text, sessionId);
    const history = await getConversation(from, sessionId);
    console.log(`History length: ${history.length}`);

    const claudeRes = await axios.post(
      "https://api.anthropic.com/v1/messages",
      {
        model: "claude-sonnet-4-5",
        max_tokens: 1000,
        system: buildSystemPrompt(),
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
    await sendWhatsApp(from, reply);

    if (reply.includes("سيتصل بك") || reply.includes("استلمت بياناتك")) {
      const lastMessages = history.slice(-6);
      const orderSummary = lastMessages
        .filter(m => m.role === "user")
        .map(m => m.content)
        .join("\n");

      await saveOrder(from, orderSummary);
      await notifyAdmin(`رقم الزبون: ${from}\n\nتفاصيل الطلب:\n${orderSummary}`);

      const newSessionId = randomUUID();
      const closingMsg = `شكراً لك! 😊 إذا أردت طلب منتج آخر في المستقبل، راسلنا وإحنا بالخدمة إنشاءالله.`;
      await saveMessage(from, "assistant", closingMsg, newSessionId);
    }

  } catch (err) {
    console.error("Error full:", JSON.stringify(err.response?.data || err.message));
    console.error("Error stack:", err.stack);
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Bot running on port ${PORT}`));
