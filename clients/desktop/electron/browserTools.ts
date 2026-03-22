/**
 * Browser automation tools — Playwright-based browser control for agents.
 *
 * Manages a singleton Chromium browser instance. browser_open requires
 * user approval; all other tools auto-execute once the session is active.
 */

import { ipcMain, dialog, BrowserWindow } from 'electron';
import type { Browser, Page } from 'playwright';

// Lazy-load playwright to avoid bundler resolving its deep dependency tree
async function getChromium() {
  const pw = await import('playwright');
  return pw.chromium;
}

// --- Singleton browser state ---

let browser: Browser | null = null;
let page: Page | null = null;

// --- Tool schemas ---

interface ToolSchema {
  type: string;
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

const BROWSER_TOOL_NAMES = new Set([
  'browser_open', 'browser_close',
  'browser_navigate', 'browser_back', 'browser_forward', 'browser_reload',
  'browser_click', 'browser_type', 'browser_select', 'browser_scroll', 'browser_press_key',
  'browser_get_text', 'browser_get_html', 'browser_screenshot', 'browser_get_url',
  'browser_evaluate',
]);

function getBrowserToolSchemas(): ToolSchema[] {
  return [
    // --- Session ---
    {
      type: 'function',
      function: {
        name: 'browser_open',
        description: 'Launch a browser and navigate to a URL. Requires user approval.',
        parameters: {
          type: 'object',
          properties: {
            url: { type: 'string', description: 'URL to open.' },
            headless: { type: 'boolean', description: 'Run headless (default: false, so user can see).' },
          },
          required: ['url'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'browser_close',
        description: 'Close the browser session.',
        parameters: { type: 'object', properties: {}, required: [] },
      },
    },
    // --- Navigation ---
    {
      type: 'function',
      function: {
        name: 'browser_navigate',
        description: 'Navigate to a URL in the current browser session.',
        parameters: {
          type: 'object',
          properties: {
            url: { type: 'string', description: 'URL to navigate to.' },
            wait_until: {
              type: 'string',
              enum: ['load', 'domcontentloaded', 'networkidle'],
              description: 'When to consider navigation done (default: "load").',
            },
          },
          required: ['url'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'browser_back',
        description: 'Go back in browser history.',
        parameters: { type: 'object', properties: {}, required: [] },
      },
    },
    {
      type: 'function',
      function: {
        name: 'browser_forward',
        description: 'Go forward in browser history.',
        parameters: { type: 'object', properties: {}, required: [] },
      },
    },
    {
      type: 'function',
      function: {
        name: 'browser_reload',
        description: 'Reload the current page.',
        parameters: { type: 'object', properties: {}, required: [] },
      },
    },
    // --- Interaction ---
    {
      type: 'function',
      function: {
        name: 'browser_click',
        description: 'Click an element on the page. Supports CSS selectors and text selectors like "text=Click me".',
        parameters: {
          type: 'object',
          properties: {
            selector: { type: 'string', description: 'CSS selector or Playwright selector (e.g. "text=Submit", "#btn", "a.link").' },
          },
          required: ['selector'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'browser_type',
        description: 'Type text into an input element.',
        parameters: {
          type: 'object',
          properties: {
            selector: { type: 'string', description: 'CSS selector for the input element.' },
            text: { type: 'string', description: 'Text to type.' },
            clear: { type: 'boolean', description: 'Clear the field before typing (default: false).' },
          },
          required: ['selector', 'text'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'browser_select',
        description: 'Select an option from a dropdown.',
        parameters: {
          type: 'object',
          properties: {
            selector: { type: 'string', description: 'CSS selector for the select element.' },
            value: { type: 'string', description: 'Option value to select.' },
          },
          required: ['selector', 'value'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'browser_scroll',
        description: 'Scroll the page up or down.',
        parameters: {
          type: 'object',
          properties: {
            direction: { type: 'string', enum: ['up', 'down'], description: 'Scroll direction.' },
            amount: { type: 'integer', description: 'Pixels to scroll (default: 500).' },
          },
          required: ['direction'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'browser_press_key',
        description: 'Press a keyboard key (e.g. "Enter", "Tab", "Escape", "ArrowDown").',
        parameters: {
          type: 'object',
          properties: {
            key: { type: 'string', description: 'Key to press (Playwright key name).' },
          },
          required: ['key'],
        },
      },
    },
    // --- Content extraction ---
    {
      type: 'function',
      function: {
        name: 'browser_get_text',
        description: 'Get visible text content from the page or a specific element.',
        parameters: {
          type: 'object',
          properties: {
            selector: { type: 'string', description: 'CSS selector (default: page body text).' },
          },
          required: [],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'browser_get_html',
        description: 'Get the HTML of an element or the full page.',
        parameters: {
          type: 'object',
          properties: {
            selector: { type: 'string', description: 'CSS selector (default: full page).' },
          },
          required: [],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'browser_screenshot',
        description: 'Take a screenshot of the current page. Returns base64 PNG.',
        parameters: { type: 'object', properties: {}, required: [] },
      },
    },
    {
      type: 'function',
      function: {
        name: 'browser_get_url',
        description: 'Get the current page URL and title.',
        parameters: { type: 'object', properties: {}, required: [] },
      },
    },
    // --- JavaScript ---
    {
      type: 'function',
      function: {
        name: 'browser_evaluate',
        description: 'Execute JavaScript in the page context and return the result.',
        parameters: {
          type: 'object',
          properties: {
            script: { type: 'string', description: 'JavaScript code to evaluate.' },
          },
          required: ['script'],
        },
      },
    },
  ];
}

// --- Helpers ---

type ToolResult = { content: string; isError: boolean };

function ok(data: unknown): ToolResult {
  return { content: JSON.stringify(data), isError: false };
}

function err(message: string): ToolResult {
  return { content: JSON.stringify({ error: message }), isError: true };
}

function requirePage(): Page | ToolResult {
  if (!page || !browser) {
    return err('No browser session. Call browser_open first.');
  }
  return page;
}

const MAX_TEXT_LENGTH = 50000; // Cap text extraction

// --- Tool execution ---

async function executeBrowserOpen(args: Record<string, unknown>): Promise<ToolResult> {
  const url = args.url as string;
  if (!url) return err('url is required.');

  // Show approval dialog
  const mainWindow = BrowserWindow.getAllWindows().find(w => !w.isDestroyed());
  if (mainWindow) {
    const approval = await dialog.showMessageBox(mainWindow, {
      type: 'question',
      title: 'Browser Launch Approval',
      message: 'An agent wants to open a web browser:',
      detail: `URL: ${url}\nHeadless: ${args.headless ? 'yes' : 'no (visible)'}`,
      buttons: ['Deny', 'Approve'],
      defaultId: 0,
      cancelId: 0,
    });
    if (approval.response !== 1) {
      return err('Browser launch denied by user.');
    }
  }

  // Close existing session if any
  if (browser) {
    try { await browser.close(); } catch {}
    browser = null;
    page = null;
  }

  const headless = args.headless === true;
  const chromium = await getChromium();
  browser = await chromium.launch({ headless });
  const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  page = await context.newPage();
  await page.goto(url, { waitUntil: 'load', timeout: 30000 });

  return ok({ status: 'ok', url: page.url(), title: await page.title() });
}

async function executeBrowserClose(): Promise<ToolResult> {
  if (browser) {
    try { await browser.close(); } catch {}
    browser = null;
    page = null;
  }
  return ok({ status: 'ok', message: 'Browser closed.' });
}

async function executeBrowserNavigate(args: Record<string, unknown>): Promise<ToolResult> {
  const p = requirePage();
  if ('isError' in p) return p as ToolResult;

  const url = args.url as string;
  if (!url) return err('url is required.');

  const waitUntil = (args.wait_until as 'load' | 'domcontentloaded' | 'networkidle') || 'load';
  await p.goto(url, { waitUntil, timeout: 30000 });
  return ok({ url: p.url(), title: await p.title() });
}

async function executeBrowserBack(): Promise<ToolResult> {
  const p = requirePage();
  if ('isError' in p) return p as ToolResult;
  await p.goBack({ timeout: 15000 });
  return ok({ url: p.url(), title: await p.title() });
}

async function executeBrowserForward(): Promise<ToolResult> {
  const p = requirePage();
  if ('isError' in p) return p as ToolResult;
  await p.goForward({ timeout: 15000 });
  return ok({ url: p.url(), title: await p.title() });
}

async function executeBrowserReload(): Promise<ToolResult> {
  const p = requirePage();
  if ('isError' in p) return p as ToolResult;
  await p.reload({ timeout: 15000 });
  return ok({ url: p.url(), title: await p.title() });
}

async function executeBrowserClick(args: Record<string, unknown>): Promise<ToolResult> {
  const p = requirePage();
  if ('isError' in p) return p as ToolResult;

  const selector = args.selector as string;
  if (!selector) return err('selector is required.');
  await p.click(selector, { timeout: 10000 });
  return ok({ status: 'ok', clicked: selector });
}

async function executeBrowserType(args: Record<string, unknown>): Promise<ToolResult> {
  const p = requirePage();
  if ('isError' in p) return p as ToolResult;

  const selector = args.selector as string;
  const text = args.text as string;
  if (!selector) return err('selector is required.');
  if (text === undefined) return err('text is required.');

  if (args.clear) {
    await p.fill(selector, '', { timeout: 10000 });
  }
  await p.fill(selector, text, { timeout: 10000 });
  return ok({ status: 'ok', selector, typed: text.length + ' chars' });
}

async function executeBrowserSelect(args: Record<string, unknown>): Promise<ToolResult> {
  const p = requirePage();
  if ('isError' in p) return p as ToolResult;

  const selector = args.selector as string;
  const value = args.value as string;
  if (!selector) return err('selector is required.');
  if (!value) return err('value is required.');

  await p.selectOption(selector, value, { timeout: 10000 });
  return ok({ status: 'ok', selector, selected: value });
}

async function executeBrowserScroll(args: Record<string, unknown>): Promise<ToolResult> {
  const p = requirePage();
  if ('isError' in p) return p as ToolResult;

  const direction = args.direction as string;
  if (!direction) return err('direction is required.');
  const amount = typeof args.amount === 'number' ? args.amount : 500;
  const delta = direction === 'up' ? -amount : amount;

  await p.evaluate((d) => window.scrollBy(0, d), delta);
  return ok({ status: 'ok', scrolled: `${direction} ${amount}px` });
}

async function executeBrowserPressKey(args: Record<string, unknown>): Promise<ToolResult> {
  const p = requirePage();
  if ('isError' in p) return p as ToolResult;

  const key = args.key as string;
  if (!key) return err('key is required.');
  await p.keyboard.press(key);
  return ok({ status: 'ok', pressed: key });
}

async function executeBrowserGetText(args: Record<string, unknown>): Promise<ToolResult> {
  const p = requirePage();
  if ('isError' in p) return p as ToolResult;

  const selector = args.selector as string;
  let text: string;
  if (selector) {
    text = (await p.textContent(selector, { timeout: 10000 })) || '';
  } else {
    text = (await p.textContent('body')) || '';
  }

  if (text.length > MAX_TEXT_LENGTH) {
    text = text.substring(0, MAX_TEXT_LENGTH) + '\n...(truncated)';
  }
  return ok({ text });
}

async function executeBrowserGetHtml(args: Record<string, unknown>): Promise<ToolResult> {
  const p = requirePage();
  if ('isError' in p) return p as ToolResult;

  const selector = args.selector as string;
  let html: string;
  if (selector) {
    html = await p.innerHTML(selector, { timeout: 10000 });
  } else {
    html = await p.content();
  }

  if (html.length > MAX_TEXT_LENGTH) {
    html = html.substring(0, MAX_TEXT_LENGTH) + '\n...(truncated)';
  }
  return ok({ html });
}

async function executeBrowserScreenshot(): Promise<ToolResult> {
  const p = requirePage();
  if ('isError' in p) return p as ToolResult;

  const buffer = await p.screenshot({ type: 'png', fullPage: false });
  const base64 = buffer.toString('base64');
  return ok({ screenshot: base64, format: 'png' });
}

async function executeBrowserGetUrl(): Promise<ToolResult> {
  const p = requirePage();
  if ('isError' in p) return p as ToolResult;

  return ok({ url: p.url(), title: await p.title() });
}

async function executeBrowserEvaluate(args: Record<string, unknown>): Promise<ToolResult> {
  const p = requirePage();
  if ('isError' in p) return p as ToolResult;

  const script = args.script as string;
  if (!script) return err('script is required.');

  const result = await p.evaluate(script);
  return ok({ result });
}

// --- Dispatch ---

async function executeBrowserTool(
  name: string,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  try {
    switch (name) {
      case 'browser_open': return await executeBrowserOpen(args);
      case 'browser_close': return await executeBrowserClose();
      case 'browser_navigate': return await executeBrowserNavigate(args);
      case 'browser_back': return await executeBrowserBack();
      case 'browser_forward': return await executeBrowserForward();
      case 'browser_reload': return await executeBrowserReload();
      case 'browser_click': return await executeBrowserClick(args);
      case 'browser_type': return await executeBrowserType(args);
      case 'browser_select': return await executeBrowserSelect(args);
      case 'browser_scroll': return await executeBrowserScroll(args);
      case 'browser_press_key': return await executeBrowserPressKey(args);
      case 'browser_get_text': return await executeBrowserGetText(args);
      case 'browser_get_html': return await executeBrowserGetHtml(args);
      case 'browser_screenshot': return await executeBrowserScreenshot();
      case 'browser_get_url': return await executeBrowserGetUrl();
      case 'browser_evaluate': return await executeBrowserEvaluate(args);
      default: return err(`Unknown browser tool: ${name}`);
    }
  } catch (e: any) {
    return err(e.message || String(e));
  }
}

// --- IPC registration ---

export function registerBrowserToolIPC(): void {
  ipcMain.handle('browser-tools:list-tools', () => {
    return getBrowserToolSchemas();
  });

  ipcMain.handle('browser-tools:is-browser-tool', (_event, name: string) => {
    return BROWSER_TOOL_NAMES.has(name);
  });

  ipcMain.handle(
    'browser-tools:call-tool',
    async (_event, name: string, args: Record<string, unknown>) => {
      return executeBrowserTool(name, args);
    },
  );
}

export async function cleanupBrowser(): Promise<void> {
  if (browser) {
    try { await browser.close(); } catch {}
    browser = null;
    page = null;
  }
}

export { BROWSER_TOOL_NAMES, getBrowserToolSchemas };
