const path = require("path");
const qrcode = require("qrcode-terminal");
const { Client, LocalAuth } = require("whatsapp-web.js");

const client = new Client({
  authStrategy: new LocalAuth({
    clientId: "celebration-bot",
    dataPath: path.join(__dirname, ".wwebjs_auth"),
  }),
  puppeteer: {
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  },
});

client.on("qr", (qr) => {
  console.log("\nScan this QR code if WhatsApp asks you to link again:\n");
  qrcode.generate(qr, { small: true });
});

client.on("ready", () => {
  console.log("\n✅ READY");
  console.log("Now send a message saying IDTEST in the WhatsApp group you want.");
});

client.on("message_create", (msg) => {
  const chatId = msg.fromMe ? msg.to : msg.from;

  if (chatId && chatId.endsWith("@g.us")) {
    console.log("\n==================================");
    console.log("MESSAGE:", msg.body);
    console.log("GROUP ID:", chatId);
    console.log("==================================\n");
  }
});

client.initialize();

