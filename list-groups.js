require("dotenv").config();
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
  console.log("\nScan the QR code if requested:\n");
  qrcode.generate(qr, { small: true });
});

client.on("ready", async () => {
  const chats = await client.getChats();
  const groups = chats
    .filter((chat) => chat.isGroup)
    .sort((a, b) => a.name.localeCompare(b.name));

  console.log("\nYour WhatsApp groups:\n");
  for (const group of groups) {
    console.log(`${group.name}\n  ${group.id._serialized}\n`);
  }

  await client.destroy();
  process.exit(0);
});

client.initialize();
