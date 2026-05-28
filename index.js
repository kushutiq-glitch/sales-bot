const express = require("express");
const axios = require("axios");
const { createClient } = require("@supabase/supabase-js");
const { randomUUID } = require("crypto");
const rateLimit = require("express-rate-limit");
const products = require("./products");
 
const app = express();
app.use(express.json());
 
// ═══════════════════════════════════════════
// متغيرات البيئة
// ═══════════════════════════════════════════
const VERIFY_TOKEN    = process.env.VERIFY_TOKEN;
const WHATSAPP_TOKEN  = process.env.WHATSAPP_TOKEN;
const MESSENGER_TOKEN = process.env.MESSENGER_TOKEN;
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;
const ADMIN_PHONE     = process.env.ADMIN_PHONE || "9647734391092";
 
// ═══════════════════════════════════════════
// Supabase
// ═══════════════════════════════════════════
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);
 
supabase.from("conversations").select("count").then(({ error }) => {
  if (error) console.error("Supabase error:", error.message);
  else console.log("✅ Supabase connected!");
});
 
// ═══════════════════════════════════════════
// FIX #1: Rate Limiting — حماية من الإساءة وتوفير رصيد Anthropic
// ═══════════════════════════════════════════
const webhookLimiter = rateLimit({
  windowMs: 60 * 1000,        // نافذة دقيقة واحدة
  max: 30,                     // أقصى 30 طلب في الدقيقة لكل IP
  standardHeaders: true,
  legacyHeaders: false,
  message: "Too many requests",
  skip: (req) => {
    // تجاهل طلبات GET (التحقق من الـ webhook)
    return req.method === "GET";
  }
});
 
app.use("/webhook", webhookLimiter);
 
// ═══════════════════════════════════════════
// FIX #2: Deduplication — منع معالجة نفس الرسالة مرتين
// ═══════════════════════════════════════════
const processedMessages = new Map(); // message_id -> timestamp
 
function isDuplicate(messageId) {
  if (!messageId) return false;
  if (processedMessages.has(messageId)) return true;
  processedMessages.set(messageId, Date.now());
  return false;
}
 
// تنظيف الـ cache كل 10 دقائق — نحتفظ فقط بـ IDs آخر 10 دقائق
setInterval(() => {
  const tenMinutesAgo = Date.now() - 10 * 60 * 1000;
  for (const [id, ts] of processedMessages.entries()) {
    if (ts < tenMinutesAgo) processedMessages.delete(id);
  }
}, 10 * 60 * 1000);
 
// ═══════════════════════════════════════════
// FIX #3: كشف انتهاء WHATSAPP_TOKEN وإشعار الأدمن
// ═══════════════════════════════════════════
let tokenExpiredAlerted = false;
 
async function sendWhatsApp(to, message) {
  try {
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
    // إذا نجحت، نعيد وضع العلم
    tokenExpiredAlerted = false;
  } catch (err) {
    const status = err.response?.status;
    const errCode = err.response?.data?.error?.code;
 
    // كود 190 = token منتهي أو غير صالح
    if (status === 401 || errCode === 190) {
      console.error("🔴 WHATSAPP_TOKEN منتهي أو غير صالح!");
 
      // نرسل إشعار للأدمن عبر ماسنجر لأن واتساب لا يعمل
      if (!tokenExpiredAlerted) {
        tokenExpiredAlerted = true;
        await notifyAdminMessenger(
          "🚨 تنبيه عاجل!\n\nWHATSAPP_TOKEN انتهى أو غير صالح.\nيجب تجديده الآن من Meta Developer Console.\n\nالبوت متوقف عن الرد على واتساب حتى يتم التجديد."
        );
      }
    } else {
      console.error("sendWhatsApp error:", err.response?.data || err.message);
    }
    throw err;
  }
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
  try {
    await sendWhatsApp(ADMIN_PHONE, message);
  } catch {
    // إذا فشل واتساب، جرب ماسنجر
    await notifyAdminMessenger(message).catch(console.error);
  }
}
 
async function notifyAdminMessenger(message) {
  const ADMIN_MESSENGER_ID = process.env.ADMIN_MESSENGER_ID;
  if (!ADMIN_MESSENGER_ID) return;
  await sendMessenger(ADMIN_MESSENGER_ID, message).catch(console.error);
}
 
// ═══════════════════════════════════════════
// FIX #4: Session Expiry — الجلسة تنتهي بعد 24 ساعة من آخر رسالة
// ═══════════════════════════════════════════
const SESSION_TIMEOUT_HOURS = 24;
 
async function getActiveSession(phone) {
  const { data, error } = await supabase
    .from("conversations")
    .select("session_id, created_at")
    .eq("phone", phone)
    .order("created_at", { ascending: false })
    .limit(1);
 
  if (error) { console.error("getActiveSession error:", error.message); return null; }
  if (!data || data.length === 0) return null;
 
  const lastMsgTime = new Date(data[0].created_at);
  const hoursSince = (Date.now() - lastMsgTime.getTime()) / (1000 * 60 * 60);
 
  if (hoursSince > SESSION_TIMEOUT_HOURS) {
    console.log(`Session expired for ${phone} (${hoursSince.toFixed(1)}h ago)`);
    return null; // جلسة منتهية — ابدأ من جديد
  }
 
  return data[0].session_id;
}
 
// ═══════════════════════════════════════════
// FIX #5: حد طول الرسائل — توفير رصيد Claude
// ═══════════════════════════════════════════
const MAX_MESSAGE_LENGTH = 1000; // حرف
 
function truncateMessage(text) {
  if (!text) return text;
  if (text.length <= MAX_MESSAGE_LENGTH) return text;
  return text.substring(0, MAX_MESSAGE_LENGTH) + "... [تم اختصار الرسالة]";
}
 
// ═══════════════════════════════════════════
// دوال قاعدة البيانات
// ═══════════════════════════════════════════
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
 
// ═══════════════════════════════════════════
// استخراج ملخص الطلب
// ═══════════════════════════════════════════
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
 
// ═══════════════════════════════════════════
// System Prompt
// ═══════════════════════════════════════════
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
- لا تعطي تخفيض بدون مقابل — دايماً اطلب شيء بالمقابل
- ابدأ بتخفيض بسيط أولاً (10-15%)، وحافظ على هامش للجولة الثانية
- لا تنزل أبداً تحت "أقل سعر مسموح به" لأي منتج
 
【المرحلة 4 — الإغلاق الناجح (Win-Win Close)】
- لخّص القيمة قبل الإغلاق
- اطرح سؤال الإغلاق بثقة: "شتسمي؟ وعندي عنوان التوصيل؟"
- بعد الإغلاق عزز قرار الزبون: "اختيار صح والله، ما تندم 👍"
 
⛔ قاعدة حاسمة — لا تخالفها أبداً:
إذا قال الزبون أي جملة تدل على الموافقة مثل: "موافق"، "اشتري"، "ممتاز"، "اتفقنا"، "تمام"، "اوكي"، "يلا"، أو أي صياغة مشابهة — توقف فوراً عن كل نقاش أو تسويق. انتقل مباشرة لطلب بيانات التوصيل.
 
═══════════════════════════════════
📞 قواعد تشغيلية (لا تخالفها):
═══════════════════════════════════
 
1. رحّب بالزبون وأعطه قائمة المنتجات
2. السعر الأصلي مع توصيل مجاني والدفع عند الاستلام
3. متى أراد الشراء اطلب: الاسم الكامل، رقم الهاتف، العنوان
4. بعد البيانات قل: "سيتصل بك أحد من الفريق خلال ساعة" بالضبط
5. ردودك قصيرة وطبيعية — لا تطول أكثر من اللازم
6. لا تذكر أنك ذكاء اصطناعي (إلا إذا سألك مباشرة)
7. وقت التوصيل 2-3 أيام
8. التوصيل مجاني لجميع محافظات العراق 🎁
9. إذا طلب الزبون إلغاء طلبه، قل: "تم إلغاء طلبك بنجاح — إلغاء_الطلب"
10. إذا أبلغ عن مشكلة في المنتج: "وصلنا بلاغك — مشكلة_منتج"
11. إذا أبلغ عن مشكلة في التوصيل: "وصلنا بلاغك — مشكلة_توصيل"
12. إذا سألك "هل أنت شخص حقيقي": "أنا مساعد المتجر الآلي 😊"
13. حدد جنس الزبون: ذكر = أخي/عيني، أنثى = أختي/عيني، غير معروف = عيني
14. تحدث دائماً باللهجة العراقية فقط`;
}
 
// ═══════════════════════════════════════════
// دوال مساعدة
// ═══════════════════════════════════════════
function isOrderCompleted(reply) {
  return (
    reply.includes("سيتصل بك") ||
    reply.includes("استلمت بياناتك") ||
    reply.includes("استلمنا طلبك") ||
    reply.includes("تم تسجيل طلبك") ||
    reply.includes("خلال ساعة") ||
    reply.includes("وصلنا طلبك") ||
    reply.includes("تم استلام طلبك")
  );
}
 
function isPurchaseConfirmation(text) {
  const phrases = [
    "موافق","موافقة","اشتري","اشترى","خذ بياناتي","اتفقنا",
    "تمام اشتري","ممتاز","حسناً","اوكي","okay","ok","نعم اشتري",
    "ابي اشتري","أبي اشتري","ريد اشتري","خلاص اشتري","اوك اشتري",
    "يلا اشتري","خذ معلوماتي","سجل طلبي","اكمل","أكمل","نكمل"
  ];
  const lower = text.toLowerCase();
  return phrases.some(p => lower.includes(p));
}
 
// ═══════════════════════════════════════════
// FIX #6: إحصائيات يومية — تقرير الصباح للأدمن
// ═══════════════════════════════════════════
async function sendDailyReport() {
  try {
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    yesterday.setHours(0, 0, 0, 0);
    const today = new Date();
    today.setHours(0, 0, 0, 0);
 
    // عدد المحادثات الفريدة أمس
    const { data: convData } = await supabase
      .from("conversations")
      .select("phone")
      .gte("created_at", yesterday.toISOString())
      .lt("created_at", today.toISOString());
 
    const uniqueConversations = new Set(convData?.map(c => c.phone) || []).size;
 
    // الطلبات أمس
    const { data: ordersData } = await supabase
      .from("orders")
      .select("*")
      .gte("created_at", yesterday.toISOString())
      .lt("created_at", today.toISOString());
 
    const totalOrders = ordersData?.length || 0;
 
    // أكثر منتج مطلوب
    const productCount = {};
    ordersData?.forEach(o => {
      const match = o.product?.match(/المنتج:\s*(.+)/);
      if (match) {
        const name = match[1].trim();
        productCount[name] = (productCount[name] || 0) + 1;
      }
    });
    const topProduct = Object.entries(productCount).sort((a,b)=>b[1]-a[1])[0];
 
    const report = `📊 تقرير يومي — ${yesterday.toLocaleDateString("ar-IQ")}
 
👥 المحادثات الفريدة: ${uniqueConversations}
🛒 الطلبات الجديدة: ${totalOrders}
${topProduct ? `⭐ أكثر منتج مطلوب: ${topProduct[0]} (${topProduct[1]} طلبات)` : ""}
 
━━━━━━━━━━━━━━━
بوت المبيعات 🤖`;
 
    await notifyAdmin(report);
    console.log("✅ Daily report sent");
  } catch (err) {
    console.error("Daily report error:", err.message);
  }
}
 
// إرسال التقرير كل يوم الساعة 9 صباحاً (توقيت بغداد UTC+3 = 6 UTC)
function scheduleDailyReport() {
  const now = new Date();
  const next9am = new Date();
  next9am.setUTCHours(6, 0, 0, 0); // 9 صباحاً بتوقيت بغداد
  if (next9am <= now) next9am.setDate(next9am.getDate() + 1);
  const msUntil9am = next9am - now;
 
  setTimeout(() => {
    sendDailyReport();
    setInterval(sendDailyReport, 24 * 60 * 60 * 1000); // كل 24 ساعة
  }, msUntil9am);
 
  console.log(`📅 التقرير اليومي مجدول بعد ${Math.round(msUntil9am/60000)} دقيقة`);
}
 
scheduleDailyReport();
 
// ═══════════════════════════════════════════
// المعالج الرئيسي للرسائل
// FIX #3: async processing — نرد 200 فوراً ونعالج في الخلفية
// ═══════════════════════════════════════════
async function handleMessage(from, text, platform) {
  console.log(`[${platform}] Message from ${from}: ${text?.substring(0, 50)}`);
 
  // FIX #5: اختصار الرسائل الطويلة
  const safeText = truncateMessage(text);
 
  let sessionId = await getActiveSession(from);
  const customerOrders = await getCustomerOrders(from);
 
  if (!sessionId) {
    sessionId = randomUUID();
    const welcomeMsg = `أهلاً وسهلاً! 😊\n\n${buildProductList()}\n\nشنو يهمك من هذي المنتجات؟ أو إذا عندك سؤال أنا هنا أساعدك 🙋`;
    if (platform === "whatsapp") await sendWhatsApp(from, welcomeMsg).catch(console.error);
    else await sendMessenger(from, welcomeMsg).catch(console.error);
    await saveMessage(from, "assistant", welcomeMsg, sessionId);
    return;
  }
 
  await saveMessage(from, "user", safeText, sessionId);
  const history = await getConversation(from, sessionId);
 
  const purchaseConfirmed = isPurchaseConfirmation(safeText);
  const closingDirective = purchaseConfirmed
    ? `\n\n🚨 تعليمات فورية: الزبون وافق على الشراء. توقف عن التفاوض فوراً. اطلب: الاسم الكامل، رقم الهاتف، العنوان.`
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
 
  // معالجة الحالات الخاصة
  if (reply.includes("إلغاء_الطلب")) {
    await cancelOrder(from);
    const cleanReply = reply.replace(/—?\s*إلغاء_الطلب/g, "").trim();
    if (platform === "whatsapp") await sendWhatsApp(from, cleanReply).catch(console.error);
    else await sendMessenger(from, cleanReply).catch(console.error);
    await notifyAdmin(`⚠️ إلغاء طلب!\n\nالزبون: ${from}\nالمنصة: ${platform}`);
    return;
  }
 
  if (reply.includes("مشكلة_منتج")) {
    const cleanReply = reply.replace(/—?\s*مشكلة_منتج/g, "").trim();
    if (platform === "whatsapp") await sendWhatsApp(from, cleanReply).catch(console.error);
    else await sendMessenger(from, cleanReply).catch(console.error);
    await notifyAdmin(`🔴 مشكلة في منتج!\n\nالزبون: ${from}\nالمنصة: ${platform}\n\nرسالة: ${safeText}`);
    return;
  }
 
  if (reply.includes("مشكلة_توصيل")) {
    const cleanReply = reply.replace(/—?\s*مشكلة_توصيل/g, "").trim();
    if (platform === "whatsapp") await sendWhatsApp(from, cleanReply).catch(console.error);
    else await sendMessenger(from, cleanReply).catch(console.error);
    await notifyAdmin(`🚚 مشكلة في التوصيل!\n\nالزبون: ${from}\nالمنصة: ${platform}\n\nرسالة: ${safeText}`);
    return;
  }
 
  if (platform === "whatsapp") await sendWhatsApp(from, reply).catch(console.error);
  else await sendMessenger(from, reply).catch(console.error);
 
  if (isOrderCompleted(reply)) {
    const fullHistory = await getConversation(from, sessionId);
    const orderSummary = await extractOrderSummary(fullHistory);
    await saveOrder(from, orderSummary);
    await notifyAdmin(`🔔 طلب جديد!\n\nالمنصة: ${platform}\nرقم الزبون: ${from}\n\n${orderSummary}`);
 
    // ابدأ جلسة جديدة بعد اكتمال الطلب
    const newSessionId = randomUUID();
    const closingMsg = "شكراً لك! 😊 إذا أردت طلب منتج آخر راسلنا إنشاءالله.";
    await saveMessage(from, "assistant", closingMsg, newSessionId);
  }
}
 
// ═══════════════════════════════════════════
// Routes
// ═══════════════════════════════════════════
app.get("/health", (req, res) => res.json({ status: "OK", timestamp: new Date() }));
 
app.get("/webhook", (req, res) => {
  const mode      = req.query["hub.mode"];
  const token     = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];
  if (mode === "subscribe" && token === VERIFY_TOKEN) {
    res.status(200).send(challenge);
  } else {
    res.sendStatus(403);
  }
});
 
// FIX #3: رد 200 فوري + معالجة async في الخلفية
app.post("/webhook", (req, res) => {
  res.sendStatus(200); // رد فوري قبل أي معالجة
 
  // معالجة في الخلفية بدون await
  (async () => {
    try {
      const body = req.body;
 
      if (body.object === "whatsapp_business_account") {
        const msg = body.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
        if (!msg || !msg.text?.body) return;
 
        // FIX #2: Deduplication
        if (isDuplicate(msg.id)) {
          console.log(`Duplicate message skipped: ${msg.id}`);
          return;
        }
 
        await handleMessage(msg.from, msg.text.body, "whatsapp");
      }
 
      else if (body.object === "page") {
        const messaging = body.entry?.[0]?.messaging?.[0];
        if (!messaging) return;
 
        const from = messaging.sender?.id;
        const text = messaging.message?.text;
        const msgId = messaging.message?.mid;
        if (!from || !text) return;
 
        // FIX #2: Deduplication للماسنجر
        if (isDuplicate(msgId)) {
          console.log(`Duplicate messenger message skipped: ${msgId}`);
          return;
        }
 
        await handleMessage(from, text, "messenger");
      }
 
    } catch (err) {
      console.error("Webhook processing error:", err.response?.data || err.message);
    }
  })();
});
 
// ═══════════════════════════════════════════
// FIX #6: Keep Alive — فقط إذا كان Railway ينام (اختياري)
// Railway الحديث لا ينام، لكن نحتفظ بالـ ping كل 14 دقيقة فقط
// ═══════════════════════════════════════════
const BOT_URL = process.env.BOT_URL || "https://sales-bot-production-6ffc.up.railway.app";
 
setInterval(async () => {
  try {
    await axios.get(`${BOT_URL}/health`, { timeout: 5000 });
    // لا نطبع شيء لتنظيف الـ logs
  } catch (err) {
    console.error("Keep alive error:", err.message);
  }
}, 14 * 60 * 1000); // كل 14 دقيقة بدل 4 (أكثر كفاءة)
 
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🤖 Bot running on port ${PORT}`));
