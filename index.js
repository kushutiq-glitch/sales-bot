const express = require("express");
const axios = require("axios");
const { createClient } = require("@supabase/supabase-js");
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

async function getConversation(phone) {
  const { data } = await supabase
    .from("conversations")
    .select("role, content")
    .eq("phone", phone)
    .order("created_at", { ascending: true })
    .limit(20);
  return data || [];
}

async function saveMessage(phone, role, content) {
  await supabase.from("conversations").insert({ phone, role, content });
}

async function isNewCustomer(phone) {
  const { data } = await supabase
    .from("conversations")
    .select("id")
    .eq("phone", phone)
    .limit(1);
  return !data || data.length === 0;
}

async function saveOrder(phone, orderText) {
  await supabase.from("orders").insert({ phone, product: orderText });
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

    // تجاهل رسائل الأدمن
    if (from === ADMIN_PHONE) return;

    const newCustomer = await isNewCustomer(from);

    if (newCustomer) {
      const welcomeMsg = `أهلاً وسهلاً! 😊\n\n${buildProductList()}\n\nأي منتج يهمك؟`;
      await sendWhatsApp(from, welcomeMsg);
      await saveMessage(from, "assistant", welcomeMsg);
      return;
    }

    await saveMessage(from, "user", text);
    const history = await getConversation(from);

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

    await saveMessage(from, "assistant", reply);
    await sendWhatsApp(from, reply);

    // إذا اكتمل الطلب — أرسل إشعار للأدمن
    if (reply.includes("سيتصل بك") || reply.includes("استلمت بياناتك")) {
      const lastMessages = history.slice(-6);
      const orderSummary = lastMessages
        .filter(m => m.role === "user")
        .map(m => m.content)
        .join("\n");

      await saveOrder(from, orderSummary);
      await notifyAdmin(`رقم الزبون: ${from}\n\nتفاصيل الطلب:\n${orderSummary}`);
    }

  } catch (err) {
    console.error("Error:", err.response?.data || err.message);
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Bot running on port ${PORT}`));
