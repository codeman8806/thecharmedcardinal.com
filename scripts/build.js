/**
 * build.js — Puppeteer v24 compatible Etsy scraper + static site generator
 */

const fs = require("fs");
const path = require("path");
const https = require("https");
const puppeteer = require("puppeteer");
const xml2js = require("xml2js");

const DOMAIN = "https://thecharmedcardinal.com";
const SHOP_RSS = "https://www.etsy.com/shop/thecharmedcardinal/rss";

const OUT_ROOT = path.join(__dirname, "..");
const ASSET_DIR = path.join(OUT_ROOT, "assets", "products");

if (!fs.existsSync(ASSET_DIR)) fs.mkdirSync(ASSET_DIR, { recursive: true });

// ------------------------------
// HELPERS
// ------------------------------

function sleep(ms) {
  return new Promise((res) => setTimeout(res, ms));
}

async function fetchRSS() {
  console.log(`→ Fetching Etsy RSS: ${SHOP_RSS}`);

  return new Promise((resolve, reject) => {
    https.get(SHOP_RSS, (res) => {
      let body = "";
      res.on("data", (d) => (body += d));
      res.on("end", () => {
        xml2js.parseString(body, (err, result) => {
          if (err) return reject(err);
          try {
            const items = result?.rss?.channel?.[0]?.item || [];
            const urls = items
              .map((it) => it.link?.[0])
              .filter(Boolean)
              .map((u) => u.replace(/\?.*$/, ""));
            resolve(urls);
          } catch (e) {
            reject(e);
          }
        });
      });
    }).on("error", reject);
  });
}

function downloadImage(url, dest) {
  return new Promise((resolve, reject) => {
    const out = fs.createWriteStream(dest);
    https
      .get(url, (res) => {
        if (res.statusCode !== 200) {
          return reject(new Error(`Bad status: ${res.statusCode}`));
        }
        res.pipe(out);
        out.on("finish", () => out.close(() => resolve(dest)));
      })
      .on("error", reject);
  });
}

// ------------------------------
// SCRAPER
// ------------------------------

async function scrapeListing(listingUrl, browser) {
  console.log(`→ Scraping listing via Puppeteer: ${listingUrl}`);

  const page = await browser.newPage();

  // ETSY ANTI-BOT BYPASSES
  await page.setViewport({ width: 1920, height: 1080 });

  await page.setUserAgent(
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
      "(KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36"
  );

  await page.setExtraHTTPHeaders({
    "sec-ch-ua": '"Chromium";v="123", "Not A;Brand";v="99"',
    "sec-ch-ua-mobile": "?0",
    "sec-ch-ua-platform": "Windows",
    "Accept-Language": "en-US,en;q=0.9",
  });

  await page.goto(listingUrl, {
    waitUntil: "networkidle2",
    timeout: 60000,
  });

  // Scroll to load all lazy images
  for (let i = 0; i < 6; i++) {
    await page.evaluate(() => window.scrollBy(0, window.innerHeight));
    await sleep(1200);
  }

  const ogTitle = await page
    .$eval('meta[property="og:title"]', (e) => e.content)
    .catch(() => null);

  const ogDesc = await page
    .$eval('meta[property="og:description"]', (e) => e.content)
    .catch(() => null);

  let product = {
    title: (ogTitle || "").replace(/\s+-\s+Etsy\s*$/i, ""),
    description: ogDesc || "",
    id: "",
    slug: "",
    images: [],
    etsy: listingUrl,
    type: "",
    tags: [],
  };

  // ID
  const idMatch = listingUrl.match(/\/listing\/(\d+)/);
  product.id = idMatch ? idMatch[1] : String(Date.now());

  // Slug
  product.slug =
    product.title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") + "-" + product.id;

  // Determine product type
  const t = (product.title + " " + product.description).toLowerCase();
  product.type = t.includes("pattern") || t.includes("seamless")
    ? "digital-pattern"
    : "garden-flag";

  // Try multiple image selectors
  let imageUrls = await page.$$eval(
    [
      'img[src*="i.etsystatic.com"]',
      'img[data-src*="i.etsystatic.com"]',
      '.carousel-pane img',
      'img[loading="lazy"]',
    ].join(","),
    (imgs) =>
      imgs
        .map((i) => i.src || i.getAttribute("data-src"))
        .filter(Boolean)
        .map((u) => u.replace(/il_\d+x\d+/, "il_794xN"))
  );

  // Remove duplicates
  imageUrls = [...new Set(imageUrls)];

  if (!imageUrls.length) {
    console.log("❌ No images found");
  } else {
    console.log("🖼 Found images:", imageUrls.length);
  }

  product.images = imageUrls;

  return product;
}

// ------------------------------
// PAGE TEMPLATES
// ------------------------------

function renderLayout({ title, description, canonical, bodyHtml, ogImage }) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${title}</title>
<meta name="description" content="${description}">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="canonical" href="${canonical}">
<link rel="stylesheet" href="/styles.css">
<link rel="icon" href="/assets/favicon.png">

<meta property="og:title" content="${title}">
<meta property="og:description" content="${description}">
<meta property="og:image" content="${ogImage}">
<meta property="og:type" content="product">

</head>
<body>
<header><a href="/">The Charmed Cardinal</a></header>

<main>
${bodyHtml}
</main>

<footer>
<p>© The Charmed Cardinal</p>
</footer>

</body>
</html>`;
}

function productPage(p) {
  const mainImg = p.images[0]
    ? `/assets/products/${p.slug}.jpg`
    : "/assets/product-placeholder.jpg";

  const canonical = `${DOMAIN}/products/${p.slug}.html`;

  const body = `
<h1>${p.title}</h1>
<img src="${mainImg}" alt="${p.title}" style="max-width:100%;border-radius:12px;">
<p>${p.description}</p>
<p><a href="${p.etsy}" target="_blank">View on Etsy →</a></p>
`;

  return renderLayout({
    title: p.title + " | The Charmed Cardinal",
    description: p.description,
    canonical,
    bodyHtml: body,
    ogImage: DOMAIN + mainImg,
  });
}

// ------------------------------
// BUILD PIPELINE
// ------------------------------

async function build() {
  try {
    console.log("\n🚀 BUILD START\n");

    const urls = await fetchRSS();
    console.log(`✓ RSS listings: ${urls.length}`);

    const browser = await puppeteer.launch({
      headless: "new",
      args: ["--no-sandbox", "--disable-setuid-sandbox"],
    });

    let products = [];

    for (const url of urls) {
      const p = await scrapeListing(url, browser);
      products.push(p);

      if (p.images.length > 0) {
        const dest = path.join(ASSET_DIR, `${p.slug}.jpg`);
        try {
          await downloadImage(p.images[0], dest);
        } catch (e) {
          console.log("⚠ Image download failed:", e.message);
        }
      }
    }

    await browser.close();

    fs.writeFileSync(
      path.join(OUT_ROOT, "data", "products.json"),
      JSON.stringify(products, null, 2)
    );
    console.log("✓ Saved products.json\n");

    for (const p of products) {
      fs.writeFileSync(
        path.join(OUT_ROOT, "products", `${p.slug}.html`),
        productPage(p)
      );
    }

    let sitemap = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n`;
    for (const p of products) {
      sitemap += `<url><loc>${DOMAIN}/products/${p.slug}.html</loc></url>\n`;
    }
    sitemap += `</urlset>`;

    fs.writeFileSync(path.join(OUT_ROOT, "sitemap.xml"), sitemap);
    console.log("✓ Sitemap built.\n");

    console.log("✅ BUILD COMPLETE — images + pages generated.\n");
  } catch (e) {
    console.error("❌ BUILD FAILED:", e);
    process.exit(1);
  }
}

build();
