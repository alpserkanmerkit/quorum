// Screenshots of the four demo screens in light and dark: node scripts/capture-screens.mjs [outDir]
// Boots `npm run demo` (mock data, auto-login), waits for its READY line, captures, shuts it down.
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { chromium } from '@playwright/test';

const outDir = process.argv[2] ?? 'docs/screens';
const ROUTES = [
  ['dashboard', '/dashboard', 'Live Intelligence Feed'],
  ['portfolio', '/portfolio', 'Live Portfolio'],
  ['boardroom', '/war-room', 'Strategy Boardroom'],
  ['compliance', '/compliance', 'Compliance Centre'],
];

mkdirSync(outDir, { recursive: true });
// Own process group, so the whole demo tree (npm -> tsx -> api + vite) is stopped together.
const demo = spawn('npm', ['run', 'demo'], { stdio: ['ignore', 'pipe', 'inherit'], detached: true });
const stopDemo = () => { try { process.kill(-demo.pid, 'SIGTERM'); } catch { /* already gone */ } };
process.on('exit', stopDemo);

let browser;
try {
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('demo did not print READY within 120 s')), 120_000);
    demo.stdout.on('data', (chunk) => {
      if (/\[demo\] READY/.test(String(chunk))) { clearTimeout(timer); resolve(); }
    });
    demo.on('exit', (code) => reject(new Error(`demo exited early (${code})`)));
  });
  browser = await chromium.launch();
  for (const scheme of ['light', 'dark']) {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, colorScheme: scheme });
    // Desk spec: dark navy is the default; the light theme is opt-in via [data-theme=light] (print/reports).
    // Light theme is opt-in via [data-theme=light]; the TanStack Query devtools button is hidden in screenshots only.
    const applyTheme = async () => {
      if (scheme === 'light') await page.evaluate(() => { document.documentElement.dataset.theme = 'light'; });
      await page.addStyleTag({ content: '.tsqd-open-btn-container{display:none !important}' });
    };
    for (const [name, path, heading] of ROUTES) {
      await page.goto(`http://127.0.0.1:3000${path}`);
      await page.getByRole('heading', { name: heading }).waitFor();
      await applyTheme();
      await page.waitForTimeout(800); // let charts and fonts settle
      const file = `${outDir}/${name}-${scheme}.png`;
      await page.screenshot({ path: file });
      console.log(file);
    }
    // The boardroom's op-ed layout only appears once a debate has run: start one from the first quick topic.
    await page.goto('http://127.0.0.1:3000/war-room');
    await page.locator('[data-testid^="war-room-topic-"]').first().click();
    const initiate = page.getByRole('button', { name: 'Initiate Debate' });
    if (await initiate.isEnabled().catch(() => false)) await initiate.click();
    await page.getByRole('heading', { name: 'Editorial Board Decision' }).waitFor({ timeout: 60_000 });
    await applyTheme();
    await page.waitForTimeout(800);
    const debateFile = `${outDir}/boardroom-debate-${scheme}.png`;
    await page.screenshot({ path: debateFile, fullPage: true });
    console.log(debateFile);
    await page.close();
  }
} finally {
  await browser?.close();
  stopDemo();
}
