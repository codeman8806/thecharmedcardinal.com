/**
 * build.js — FULL PRODUCTION VERSION
 * Etsy-safe Puppeteer scraper + static site generator
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
// FETCH HELPERS
// ------------------------------

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
              .map((u) => u.replace(/\?.*$/, "")); // strip query params
            resolve(urls);
          } catch (e) {
            reject(e);
          }
        });
      });
    }).on("error", reject);
  });
}

// ------------------------------
// IMAGE DOWNLOADER
// ------------------------------

function downloadImage(url, dest) {
  return new Promise((resolve, reject) => {
    const out = fs.createWriteStream(dest);
    https
      .get(url, (res) => {
        if (res.statusCode !== 200) {
          return reject(new Error(`Bad status: ${res.statusCode}`));
        }
        res.pipe(out);
        out.on("finish", () => {
          out.close(() => resolve(dest));
        });
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

  // FULL BROWSER EMULATION
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

  // Scroll to load lazy images
  for (let i = 0; i < 6; i++) {
    await page.evaluate(() => window.scrollBy(0, window.innerHeight));
    await page.waitForTimeout(900);
  }

  // Try JSON-LD
  let ld = null;
  try {
    ld = await page.$$eval('script[type="application/ld+json"]', (nodes) =>
      nodes.map((n) => n.innerText)
    );
  } catch {}

  let product = {
    title: "",
    description: "",
    images: [],
    id: "",
    slug: "",
    etsy: listingUrl,
    type: "",
    tags: [],
  };

  // Extract title & description
  const ogTitle = await page.$eval('meta[property="og:title"]', e => e.content).catch(()=>null);
  const ogDesc  = await page.$eval('meta[property="og:description"]', e => e.content).catch(()=>null);

  product.title = (ogTitle || "").replace(/\s+-\s+Etsy\s*$/i, "");
  product.description = ogDesc || "";

  // Extract ID
  const idMatch = listingUrl.match(/\/listing\/(\d+)/);
  product.id = idMatch ? idMatch[1] : String(Date.now());

  // Slug
  product.slug =
    product.title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") + "-" + product.id;

  // Determine type
  const text = (product.title + " " + product.description).toLowerCase();
  if (text.includes("pattern") || text.includes("seamless")) product.type = "digital-pattern";
  else product.type = "garden-flag";

  // IMAGE EXTRACTION — DEEP CAROUSEL SCRAPER
  let imageUrls = await page.$$eval(
    'img[src*="i.etsystatic.com"], img[data-src*="i.etsystatic.com"]',
    (imgs) =>
      imgs
        .map((i) => i.src || i.dataset.src)
        .filter(Boolean)
        .map((u) => u.replace(/il_\d+x\d+/, "il_794xN")) // request biggest
  );

  // Remove duplicates & sanitize
  imageUrls = [...new Set(imageUrls)];

  if (imageUrls.length === 0) {
    console.log("❌ No product image found in DOM.");
  } else {
    console.log("🖼 Found images:", imageUrls.length);
  }

  product.images = imageUrls;

  return product;
}

// ------------------------------
// HTML GENERATORS
// ------------------------------

function renderLayout({ title, description, canonical, bodyHtml, ogImage }) {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>${title}</title>
  <meta name="description" content="${description}" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <link rel="canonical" href="${canonical}" />

  <link rel="stylesheet" href="/styles.css" />
  <link rel="icon" href="/assets/favicon.png" />

  <meta property="og:title" content="${title}" />
  <meta property="og:description" content="${description}" />
  <meta property="og:image" content="${ogImage}" />
  <meta property="og:type" content="product" />

</head>
<body>
<header>
  <a href="/">The Charmed Cardinal</a>
</header>

<main>
${bodyHtml}
</main>

<footer>
  <p>© The Charmed Cardinal</p>
</footer>

</body>
</html>`;
}

function productPage(product) {
  const mainImg = product.images[0]
    ? `/assets/products/${product.slug}.jpg`
    : "/assets/product-placeholder.jpg";

  const canonical = `${DOMAIN}/products/${product.slug}.html`;

  const body = `
  <h1>${product.title}</h1>
  <img src="${mainImg}" alt="${product.title}" style="max-width:100%;border-radius:12px;" />
  <p>${product.description}</p>
  <p><a href="${product.etsy}" target="_blank">View on Etsy →</a></p>
  `;

  return renderLayout({
    title: product.title + " | The Charmed Cardinal",
    description: product.description,
    canonical,
    bodyHtml: body,
    ogImage: mainImg.startsWith("http") ? mainImg : DOMAIN + mainImg,
  });
}

// ------------------------------
// BUILD PIPELINE
// ------------------------------

async function build() {
  try {
    console.log("\n🚀 BUILD START\n");

    // Load RSS URLs
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

      // Download first image if available
      if (p.images.length > 0) {
        const imgUrl = p.images[0];
        const dest = path.join(ASSET_DIR, `${p.slug}.jpg`);
        try {
          await downloadImage(imgUrl, dest);
        } catch (e) {
          console.log("⚠ Image download failed:", e.message);
        }
      }
    }

    await browser.close();

    // Save products.json
    fs.writeFileSync(
      path.join(OUT_ROOT, "data", "products.json"),
      JSON.stringify(products, null, 2)
    );
    console.log("✓ Saved products.json\n");

    // Build product pages
    for (const p of products) {
      const html = productPage(p);
      fs.writeFileSync(
        path.join(OUT_ROOT, "products", `${p.slug}.html`),
        html
      );
    }

    // Sitemap
    let sitemap = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n`;

    for (const p of products) {
      sitemap += `<url><loc>${DOMAIN}/products/${p.slug}.html</loc></url>\n`;
    }

    sitemap += `</urlset>`;
    fs.writeFileSync(path.join(OUT_ROOT, "sitemap.xml"), sitemap);
    console.log("✓ Sitemap built.\n");

    console.log("✅ BUILD COMPLETE — full site generated with images.\n");

  } catch (e) {
    console.error("❌ BUILD FAILED:", e);
    process.exit(1);
  }
}

build();
