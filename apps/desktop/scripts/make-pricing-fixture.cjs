#!/usr/bin/env node
/**
 * Regenerates test/fixtures/pricing-page.png — the screenshot the macOS CI reads with
 * openkt-ocr and the vision model. Needs Playwright with a Chromium (not a dependency of
 * this app): PLAYWRIGHT=/path/to/node_modules/playwright node scripts/make-pricing-fixture.cjs
 * The company and its prices are invented.
 */
const { join } = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT || 'playwright');

const tier = (name, price, unit, blurb, items, featured) => `
  <section class="tier${featured ? ' featured' : ''}">
    <h2>${name}</h2>
    <p class="price">${price}<span> ${unit}</span></p>
    <p class="blurb">${blurb}</p>
    <ul>${items.map((i) => `<li>${i}</li>`).join('')}</ul>
    <a>${featured ? 'Start a 30-day trial' : 'Choose ' + name}</a>
  </section>`;

const html = `<!doctype html><meta charset="utf-8"><style>
  * { box-sizing: border-box; margin: 0; }
  body { font: 16px/1.5 Helvetica, Arial, sans-serif; color: #1c1917; background: #faf7f2; padding: 36px 44px; width: 1100px; }
  header { display: flex; justify-content: space-between; align-items: baseline; margin-bottom: 26px; }
  header b { font-size: 20px; } nav { color: #57534e; font-size: 15px; word-spacing: 14px; }
  h1 { font-size: 34px; margin-bottom: 6px; } .lede { color: #57534e; font-size: 18px; margin-bottom: 28px; }
  main { display: grid; grid-template-columns: repeat(3, 1fr); gap: 20px; }
  .tier { background: #fff; border: 1px solid #d6d3d1; border-radius: 10px; padding: 24px; }
  .featured { border: 2px solid #b45309; }
  h2 { font-size: 22px; } .price { font-size: 20px; font-weight: 700; margin: 8px 0; } .price span { font-weight: 400; }
  .blurb { font-size: 17px; font-weight: 600; margin-bottom: 10px; } ul { padding-left: 20px; margin-bottom: 18px; } li { margin: 4px 0; }
  a { display: inline-block; border: 1px solid #1c1917; border-radius: 6px; padding: 8px 14px; font-size: 15px; }
  footer { margin-top: 24px; color: #57534e; font-size: 15px; }
</style>
<header><b>Shelfwise</b><nav>Product Pricing Customers Docs</nav></header>
<h1>Pricing that follows your stores</h1>
<p class="lede">Three plans. Switch or cancel at any time.</p>
<main>
${tier('Starter', '$19', '/ seat / month', 'Per-seat billing', ['Up to 5 seats', 'One store', 'Email support'])}
${tier('Growth', '$49', '/ store / month', 'Per-store billing', ['Unlimited seats in every store', 'Shelf audits and planograms', 'Priority support'], true)}
${tier('Enterprise', 'Custom', 'annual contract', 'Chain-wide billing', ['More than 40 stores', 'Single sign-on and audit log', 'Dedicated success manager'])}
</main>
<footer>Prices in US dollars, billed monthly. Annual billing saves 15%.</footer>`;

(async () => {
  const browser = await chromium.launch(process.env.CHROMIUM ? { executablePath: process.env.CHROMIUM } : {});
  const page = await browser.newPage({ viewport: { width: 1100, height: 640 }, deviceScaleFactor: 1 });
  await page.setContent(html);
  const out = join(__dirname, '../test/fixtures/pricing-page.png');
  await page.screenshot({ path: out, fullPage: true });
  await browser.close();
  console.log(out);
})();
