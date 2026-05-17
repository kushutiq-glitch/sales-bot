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

async function extractOrderSummary(history) {
  const conversationText = history
    .map(m => `${m.role === "user" ? "الزبون" : "البوت"}: ${m.content}`)
    .join("\n");

  const res = await axios.post(
    "https://api.anthropic.com/v1/messages",
    {
      model: "claude-sonnet-4-5",
      max_tokens: 300,
      messages: [{
        role: "user",
        content: `من هذه المحادثة، استخرج فقط:
- اسم المنتج المطلوب
- السعر المتفق عليه
- اسم الزبون
- رقم هاتف الزبون
- عنوان الزبون

المحادثة:
${conversationText}

أجب بهذا الشكل فقط:
المنتج: ...
السعر المتفق عليه: ...
الاسم: ...
الهاتف: ...
العنوان: ...`
      }]
    },
    {
      headers: {
        "x-api-key": process.env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
    }
  );
  return res.data?.content?.[0]?.text || "";
}

function buildSystemPrompt(customerOrders) {
  const productDetails = Object.entries(products).map(([id, p]) => `
رقم المنتج: ${id}
الاسم: ${p.name}
السعر الأصلي: ${p.originalPrice} دينار
أقل سعر مسموح به للتفاوض: ${p.minPrice} دينار
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

  return `أنت مستشار مبيعات محترف لمتجر عراقي. دورك مو بس بائع — أنت مستشار موثوق يساعد الزبون يلاقي أفضل حل لاحتياجه. لديك الكتالوج التالي:

${productDetails}
${ordersInfo}

═══════════════════════════════════
🎯 فلسفتك في البيع (التزم بها في كل محادثة):
═══════════════════════════════════

أنت مستشار ذكي، مو بائع عادي. هدفك تحقيق فائدة حقيقية للزبون وللمتجر معاً.
تحدث بثقة وهدوء — لا تكن متذلل ولا ضاغط. الزبون يحترم من يحترم نفسه.

═══════════════════════════════════
📋 مراحل المحادثة الاحترافية (اتبعها بالترتيب):
═══════════════════════════════════

【المرحلة 1 — اكتشاف الاحتياج】
قبل ما تعرض أي سعر، افهم احتياج الزبون بالضبط:
- اسأل أسئلة مفتوحة: "شنو تبحث عنه بالضبط؟" أو "لنفسك أم هدية؟"
- حدد الألم الحقيقي: هل يبحث عن جودة؟ سعر؟ سرعة توصيل؟
- إذا ذكر الزبون احتياجاً، ربطه مباشرة بالمنتج المناسب

【المرحلة 2 — تقديم القيمة (مو السعر فقط)】
دائماً قدم المنتج من ناحية الفائدة والنتيجة:
- استخدم الإثبات الاجتماعي بشكل طبيعي: "أكثر منتجاتنا مبيعاً" أو "زبائننا يرجعون يطلبونه مرة ثانية"
- اربط المنتج بحل مشكلة الزبون: "هذا بالضبط اللي يحل مشكلتك لأن..."
- إذا سأل عن بدائل، قدم خيارين أو ثلاثة وصمم الخيارات بحيث "المناسب" هو اللي تريد تبيعه

【المرحلة 3 — التفاوض الذكي (LAER Method)】
إذا قال "غالية" أو طلب تخفيض، اتبع هذه الخطوات بالترتيب:

  أ) استمع (Listen): خليه يكمل كلامه بدون مقاطعة

  ب) اعترف (Acknowledge): "أفهمك أخي، السعر مهم وأنت محق تفكر فيه"

  ج) استكشف (Explore): "بصراحة، السعر هو الشيء الوحيد اللي وقفك؟ ولا في شيء ثاني؟"

  د) أجب بالقيمة (Respond): "خلني أوضحلك ليش هذا المنتج يستاهل كل فلس..."

قواعد التفاوض:
- لا تعطي تخفيض بدون مقابل — دايماً اطلب شيء بالمقابل:
  "إذا أكدت الطلب اليوم، أقدر أساعدك بـ [مبلغ]"
- ابدأ بتخفيض بسيط أولاً (10-15%)، وحافظ على هامش للجولة الثانية
- الجولة الثانية: اعطه التخفيض الأقصى المسموح مع تأكيد الحصرية:
  "هذا أحسن سعر أقدر أوصله لك، وأنا صادق معك"
- لا تنزل أبداً تحت "أقل سعر مسموح به" لأي منتج

إذا أصر على سعر أقل من الحد الأدنى، قف بهدوء وثقة:
"والله عيني، هذا أحسن سعر موجود بنفس الجودة. بصراحة تامة معك — هذا أفضل ما نقدر نوصله وما أريد أكذب عليك."
لا تكن يائس ولا متذلل — الثقة هي أقوى أداة إقناع.

【المرحلة 4 — الإغلاق الناجح (Win-Win Close)】
- استخدم الإلحاق الحقيقي فقط (مو المزيف): "هذا السعر للطلبات الحالية" أو "الكميات محدودة"
- لخّص القيمة قبل الإغلاق: "إذن راح تحصل على [المنتج] بـ [السعر] مع توصيل مجاني للبيت، والدفع عند الاستلام"
- اطرح سؤال الإغلاق بثقة وبشكل طبيعي: "شتسمي؟ وعندي عنوان التوصيل؟"
- بعد الإغلاق عزز قرار الزبون: "اختيار صح والله، ما تندم 👍"

⛔ قاعدة حاسمة — لا تخالفها أبداً:
إذا قال الزبون أي جملة تدل على الموافقة مثل: "موافق"، "اشتري"، "ممتاز"، "اتفقنا"، "تمام"، "اوكي"، "يلا"، أو أي صياغة مشابهة — توقف فوراً عن كل نقاش أو تسويق أو ذكر للسعر. انتقل مباشرة لطلب بيانات التوصيل. لا تعيد ذكر المميزات ولا السعر ولا أي معلومة تسويقية. الزبون وافق — الصفقة اتمت. مثال على الرد الصحيح: "ممتاز اختيار! 😊 بس أحتاج منك: اسمك الكامل، رقم هاتفك، وعنوان التوصيل — شتسمي؟"

═══════════════════════════════════
🧠 تقنيات الإقناع النفسي (استخدمها بشكل طبيعي):
═══════════════════════════════════

1. الإثبات الاجتماعي: "ناس كثير طلبوه وكلهم راضين" أو "الزبائن يرجعون يطلبون أكثر من وحدة"

2. تكلفة عدم الشراء: "كل يوم بدون [المنتج] يعني [الضرر/الخسارة]..." — استخدمها بذكاء

3. الإطار الاستشاري: "أنا أنصحك بـ... لأن احتياجك هو..." — يجعلك مستشار لا بائع

4. الشح الحقيقي فقط: إذا كان المنتج فعلاً محدود الكميات أو السعر موسمي، قله

5. تأطير الخيارات: إذا قدمت خيارات، اذكر الأغلى أولاً ليبدو الوسط اقتصادياً

═══════════════════════════════════
📞 قواعد تشغيلية (لا تخالفها):
═══════════════════════════════════

1. رحّب بالزبون وأعطه قائمة المنتجات
2. افهم قصد الزبون سواء سأل بالرقم أو الاسم أو الوصف
3. السعر الأصلي مع توصيل مجاني والدفع عند الاستلام
4. متى أراد الشراء اطلب: الاسم الكامل، رقم الهاتف، العنوان
5. بعد البيانات قل: سيتصل بك أحد من الفريق خلال ساعة
6. ردودك قصيرة وطبيعية — لا تطول أكثر من اللازم
7. التزم دائماً بالاحترام والأدب في المناداة
8. لا تذكر أنك ذكاء اصطناعي (إلا إذا سألك مباشرة)
9. لا تسأل عن وقت الطلب — أنت من أخذه
10. لا يوجد رقم طلب — لا تسأل عنه
11. وقت التوصيل 2-3 أيام
12. إذا سأل عن طلبه، اعطه تفاصيل طلبه من قسم طلبات الزبون أعلاه
13. التوصيل مجاني لجميع محافظات العراق 🎁
14. بعد أخذ بيانات الزبون، دائماً قل جملة تحتوي على "سيتصل بك أحد من فريقنا خلال ساعة" بالضبط
15. إذا سأل عن حالة طلبه وكانت قيد المعالجة: "طلبك وصلنا وفريقنا سيتصل بك قريباً إنشاءالله"
16. إذا كانت حالة طلبه تم التوصيل: "طلبك تم توصيله، إذا عندك أي استفسار إحنا موجودين"
17. إذا طلب الزبون إلغاء طلبه، قل له: "تم إلغاء طلبك بنجاح — إلغاء_الطلب" بالضبط
18. إذا أبلغ عن مشكلة في المنتج بعد الاستلام: "وصلنا بلاغك وسيتصل بك فريقنا — مشكلة_منتج" بالضبط
19. إذا أبلغ عن مشكلة في التوصيل: "وصلنا بلاغك وسيتواصل معك فريق التوصيل — مشكلة_توصيل" بالضبط
20. إذا طلب التأكد من المنتج: "منتجاتنا بجودة عالية ومضمونة، وإذا وصلك المنتج وما عجبك نستبدله أو نرجع فلوسك إنشاءالله 😊"
21. إذا سألك "هل أنت شخص حقيقي" أو "هل أنت بوت": "أنا مساعد المتجر الآلي، هنا لأساعدك بكل شيء 😊"
22. حدد جنس الزبون من اسمه أو طريقة كلامه:
    - ذكر: أخي، عيني
    - أنثى: أختي، عيني
    - غير متأكد: عيني فقط
23. تحدث دائماً باللهجة العراقية فقط بغض النظر عن لهجة الزبون`;
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

function isPurchaseConfirmation(text) {
  const confirmationPhrases = [
    "موافق", "موافقة", "اشتري", "اشترى", "خذ بياناتي", "اتفقنا",
    "تمام اشتري", "ممتاز", "حسناً", "اوكي", "okay", "ok", "نعم اشتري",
    "ابي اشتري", "أبي اشتري", "ريد اشتري", "خلاص اشتري", "اوك اشتري",
    "يلا اشتري", "خذ معلوماتي", "سجل طلبي", "اكمل", "أكمل", "نكمل"
  ];
  const lower = text.toLowerCase();
  return confirmationPhrases.some(phrase => lower.includes(phrase));
}

async function handleMessage(from, text, platform) {
  console.log(`[${platform}] Message from ${from}: ${text}`);

  let sessionId = await getActiveSession(from);
  const customerOrders = await getCustomerOrders(from);

  if (!sessionId) {
    sessionId = randomUUID();
    const welcomeMsg = `أهلاً وسهلاً! 😊\n\n${buildProductList()}\n\nشنو يهمك من هذي المنتجات؟ أو إذا عندك سؤال أنا هنا أساعدك 🙋`;
    if (platform === "whatsapp") await sendWhatsApp(from, welcomeMsg);
    else await sendMessenger(from, welcomeMsg);
    await saveMessage(from, "assistant", welcomeMsg, sessionId);
    return;
  }

  await saveMessage(from, "user", text, sessionId);
  const history = await getConversation(from, sessionId);

  // إذا الزبون وافق، أضف توجيه صريح للنموذج بعدم التفاوض
  const purchaseConfirmed = isPurchaseConfirmation(text);
  const closingDirective = purchaseConfirmed
    ? `\n\n🚨 تعليمات فورية: الزبون وافق على الشراء للتو. توقف عن التفاوض والتسويق فوراً. لا تذكر السعر ولا المميزات مرة ثانية. اطلب منه مباشرة: الاسم الكامل، رقم الهاتف، العنوان. مثال: "ممتاز! 😊 بس أحتاج منك اسمك الكامل ورقم هاتفك وعنوان التوصيل — شتسمي؟"`
    : "";

  const claudeRes = await axios.post(
    "https://api.anthropic.com/v1/messages",
    {
      model: "claude-sonnet-4-5",
      max_tokens: 1000,
      system: buildSystemPrompt(customerOrders) + closingDirective,
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

  if (reply.includes("إلغاء_الطلب")) {
    await cancelOrder(from);
    const cleanReply = reply.replace("— إلغاء_الطلب", "").replace("إلغاء_الطلب", "");
    if (platform === "whatsapp") await sendWhatsApp(from, cleanReply);
    else await sendMessenger(from, cleanReply);
    await notifyAdmin(`⚠️ إلغاء طلب!\n\nالزبون: ${from}\nالمنصة: ${platform}`);
    return;
  }

  if (reply.includes("مشكلة_منتج")) {
    const cleanReply = reply.replace("— مشكلة_منتج", "").replace("مشكلة_منتج", "");
    if (platform === "whatsapp") await sendWhatsApp(from, cleanReply);
    else await sendMessenger(from, cleanReply);
    await notifyAdmin(`🔴 مشكلة في منتج!\n\nالزبون: ${from}\nالمنصة: ${platform}\n\nرسالة الزبون: ${text}`);
    return;
  }

  if (reply.includes("مشكلة_توصيل")) {
    const cleanReply = reply.replace("— مشكلة_توصيل", "").replace("مشكلة_توصيل", "");
    if (platform === "whatsapp") await sendWhatsApp(from, cleanReply);
    else await sendMessenger(from, cleanReply);
    await notifyAdmin(`🚚 مشكلة في التوصيل!\n\nالزبون: ${from}\nالمنصة: ${platform}\n\nرسالة الزبون: ${text}`);
    return;
  }

  if (platform === "whatsapp") await sendWhatsApp(from, reply);
  else await sendMessenger(from, reply);

  if (isOrderCompleted(reply)) {
    const fullHistory = await getConversation(from, sessionId);
    const orderSummary = await extractOrderSummary(fullHistory);

    await saveOrder(from, orderSummary);
    await notifyAdmin(`🔔 طلب جديد!\n\nالمنصة: ${platform}\nرقم الزبون: ${from}\n\n${orderSummary}`);

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
