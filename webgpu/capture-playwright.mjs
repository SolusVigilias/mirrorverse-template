import { chromium } from "playwright";
import fs from "fs";
import path from "path";

const OUT = path.join(".", "out", "frames");
fs.mkdirSync(OUT, { recursive: true });

const frames = 30;

const browser = await chromium.launch({
  headless: true,
  executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe",
  args: [
    "--enable-unsafe-webgpu",
    "--disable-dawn-features=disallow_unsafe_apis",
    "--use-angle=d3d11"
  ]
});

const page = await browser.newPage({
  viewport: { width: 512, height: 512 }
});
page.on("console", msg => {
  console.log("[browser]", msg.type(), msg.text());
});

page.on("pageerror", err => {
  console.log("[pageerror]", err);
});
await page.goto(
  "http://127.0.0.1:8080/webgpu/capture.html",
  { waitUntil: "networkidle" }
);

await page.waitForFunction(() => window.webgpuReady === true);

for (let i = 0; i < frames; i++) {
  await page.evaluate(async () => {
    return await window.renderFrame();
  });
  await page.screenshot({
    path: path.join(OUT, `${String(i).padStart(4, "0")}.png`)
  });

  console.log("frame", i);
}

await browser.close();
console.log("done");