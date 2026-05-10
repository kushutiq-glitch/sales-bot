const express = require("express");
const axios = require("axios");
const products = require("./products");
const app = express();
app.use(express.json());

const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;

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
10. لا تذكر أنك ذكاء اصطناعي`;
}

const conversations = {};
const completedOrders = new Set();

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

    if (!conversations[from]) {
      conversations[from] = [];
      const welcomeMsg = `أهلاً وسهلاً! 😊\n\n${buildProductList()}\n\nأي منتج يهمك؟`;
      await sendWhatsApp(from, welcomeMsg);
      conversations[from].push({ role: "assistant", content: welcomeMsg });
    }

    if (completedOrders.has(from)) {
  await sendWhatsApp(from, "أهلاً مجدداً أخي! 😊 هل تريد طلب منتج آخر؟");
  completedOrders.delete(from);
  conversations[from] = [];
  return;
}

    if (conversations[from].length > 20) {
      conversations[from] = conversations[from].slice(-20);
    }

    const claudeRes = await axios.post(
      "https://api.anthropic.com/v1/messages",
      {
        model: "claude-sonnet-4-5",
        max_tokens: 1000,
        system: buildSystemPrompt(),
        messages: conversations[from],
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
    conversations[from].push({ role: "assistant", content: reply });
    if (reply.includes("سيتصل بك") || reply.includes("استلمت بياناتك")) {
  completedOrders.add(from);
}

  } catch (err) {
    console.error("Error:", err.response?.data || err.message);
  }
});

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

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Bot running on port ${PORT}`));
