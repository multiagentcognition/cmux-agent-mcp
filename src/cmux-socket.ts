/**
 * Persistent Unix socket transport for CMUX.
 *
 * Replaces execFileSync subprocess spawning with a single long-lived
 * Unix socket connection.  Protocol: newline-delimited JSON-RPC V2.
 *
 * Request:  {"id":"<uuid>","method":"<method>","params":{…}}\n
 * Response: {"id":"<uuid>","ok":true|false,"result":{…},"error":{…}}\n
 */

import { createConnection, Socket } from 'node:net';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';

// ---------------------------------------------------------------------------
// Socket client
// ---------------------------------------------------------------------------

type Pending = {
  resolve: (value: any) => void;
  reject: (reason: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

export class CmuxSocket {
  private socket: Socket | null = null;
  private pending = new Map<string, Pending>();
  private buffer = '';
  private connected = false;
  private socketPath: string;

  constructor(socketPath?: string) {
    this.socketPath =
      socketPath ??
      process.env['CMUX_SOCKET_PATH'] ??
      join(homedir(), 'Library', 'Application Support', 'cmux', 'cmux.sock');
  }

  // -- lifecycle ------------------------------------------------------------

  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.connected && this.socket) {
        resolve();
        return;
      }

      const sock = createConnection(this.socketPath);

      sock.on('connect', () => {
        this.socket = sock;
        this.connected = true;
        resolve();
      });

      sock.on('data', (chunk: Buffer) => {
        this.buffer += chunk.toString();
        this.drain();
      });

      sock.on('error', (e: Error) => {
        if (!this.connected) {
          reject(new Error(`CMUX socket unavailable at ${this.socketPath} — is CMUX running? (${e.message})`));
          return;
        }
        this.handleDisconnect();
      });

      sock.on('close', () => {
        this.handleDisconnect();
      });
    });
  }

  disconnect(): void {
    if (this.socket) {
      this.socket.destroy();
      this.socket = null;
    }
    this.connected = false;
    // Reject all pending requests
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new Error('Socket disconnected'));
    }
    this.pending.clear();
    this.buffer = '';
  }

  async probe(): Promise<boolean> {
    try {
      await this.connect();
      await this.call('system.ping', {});
      return true;
    } catch {
      return false;
    }
  }

  // -- RPC ------------------------------------------------------------------

  async call(method: string, params: Record<string, unknown>, timeoutMs = 30_000): Promise<any> {
    // Auto-reconnect if disconnected (up to 3 retries)
    if (!this.connected || !this.socket) {
      let lastErr: Error | undefined;
      for (let i = 0; i < 3; i++) {
        try {
          await this.connect();
          break;
        } catch (e: any) {
          lastErr = e;
          if (i < 2) await sleep(100 * (i + 1));
        }
      }
      if (!this.connected) {
        throw lastErr ?? new Error('CMUX socket unavailable — is CMUX running?');
      }
    }

    const id = randomUUID();

    return new Promise<any>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Socket call ${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      this.pending.set(id, { resolve, reject, timer });

      const msg = JSON.stringify({ id, method, params }) + '\n';
      this.socket!.write(msg, (err) => {
        if (err) {
          this.pending.delete(id);
          clearTimeout(timer);
          reject(new Error(`Socket write failed: ${err.message}`));
        }
      });
    });
  }

  // -- raw text protocol (sidebar commands) ----------------------------------

  /**
   * Send a raw text command on a dedicated short-lived socket connection.
   * Used for sidebar commands (set_status, sidebar_state, etc.) which use
   * a text protocol, not JSON-RPC.
   */
  async callRaw(text: string, timeoutMs = 5_000): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      const sock = createConnection(this.socketPath);
      let buf = '';
      let idleTimer: ReturnType<typeof setTimeout> | null = null;

      const finish = () => {
        if (idleTimer) clearTimeout(idleTimer);
        clearTimeout(hardTimer);
        sock.destroy();
        resolve(buf.trim());
      };

      // Hard timeout — return whatever we have
      const hardTimer = setTimeout(finish, timeoutMs);

      // After each data chunk, wait 50ms for more data. If no more
      // arrives, the response is complete. This handles multi-line
      // responses (sidebar_state) without waiting for the full timeout.
      const resetIdle = () => {
        if (idleTimer) clearTimeout(idleTimer);
        idleTimer = setTimeout(finish, 50);
      };

      sock.on('connect', () => {
        sock.write(text + '\n');
      });

      sock.on('data', (chunk: Buffer) => {
        buf += chunk.toString();
        // For simple OK/error responses, resolve immediately
        const trimmed = buf.trim();
        if (trimmed === 'OK' || trimmed.startsWith('Error:') || trimmed.startsWith('ERR')) {
          finish();
          return;
        }
        // For multi-line responses, use idle detection
        resetIdle();
      });

      sock.on('end', finish);

      sock.on('error', (e: Error) => {
        if (idleTimer) clearTimeout(idleTimer);
        clearTimeout(hardTimer);
        reject(new Error(`Raw socket call failed: ${e.message}`));
      });
    });
  }

  /**
   * Resolve a workspace ref (e.g. "workspace:209") to its UUID.
   * The sidebar raw protocol requires UUIDs, not refs.
   */
  async resolveWorkspaceUUID(workspaceRef?: string): Promise<string> {
    // Get all workspaces
    const result = await this.call('workspace.list', {});
    const workspaces: any[] = result.workspaces ?? [];

    if (workspaceRef) {
      const match = workspaces.find((w: any) => w.ref === workspaceRef);
      if (match) return match.id;
      throw new Error(`Workspace ${workspaceRef} not found`);
    }

    // No ref specified — use currently selected workspace
    const selected = workspaces.find((w: any) => w.selected);
    if (selected) return selected.id;
    if (workspaces.length > 0) return workspaces[0].id;
    throw new Error('No workspaces found');
  }

  // -- internal -------------------------------------------------------------

  private drain(): void {
    const lines = this.buffer.split('\n');
    // Keep the last (possibly incomplete) chunk in the buffer
    this.buffer = lines.pop() ?? '';

    for (const line of lines) {
      if (!line) continue;
      let msg: any;
      try {
        msg = JSON.parse(line);
      } catch {
        continue; // skip malformed lines
      }

      const p = this.pending.get(msg.id);
      if (!p) continue;

      this.pending.delete(msg.id);
      clearTimeout(p.timer);

      if (msg.ok === false) {
        p.reject(new Error(msg.error?.message ?? 'Socket call failed'));
      } else {
        p.resolve(msg.result);
      }
    }
  }

  private handleDisconnect(): void {
    this.connected = false;
    this.socket = null;
    // Reject all in-flight requests
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new Error('Socket disconnected'));
    }
    this.pending.clear();
    this.buffer = '';
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ---------------------------------------------------------------------------
// CLI-arg → socket-call translator
// ---------------------------------------------------------------------------

/** Map from CLI subcommand to socket method name */
const METHOD_MAP: Record<string, string> = {
  'ping': 'system.ping',
  'tree': 'system.tree',
  'identify': 'system.identify',

  'list-workspaces': 'workspace.list',
  'current-workspace': 'workspace.current',
  'new-workspace': 'workspace.create',
  'select-workspace': 'workspace.select',
  'close-workspace': 'workspace.close',
  'rename-workspace': 'workspace.action',
  'reorder-workspace': 'workspace.reorder',
  'move-workspace-to-window': 'workspace.move_to_window',

  'list-windows': 'window.list',
  'current-window': 'window.current',
  'new-window': 'window.create',
  'focus-window': 'window.focus',
  'close-window': 'window.close',
  'rename-window': 'workspace.action',

  'list-panes': 'pane.list',
  'list-pane-surfaces': 'pane.surfaces',
  'list-panels': 'surface.list',
  'new-pane': 'pane.create',
  'focus-pane': 'pane.focus',
  'resize-pane': 'pane.resize',
  'swap-pane': 'pane.swap',
  'break-pane': 'pane.break',
  'join-pane': 'pane.join',

  'new-surface': 'surface.create',
  'new-split': 'surface.split',
  'close-surface': 'surface.close',
  'move-surface': 'surface.move',
  'reorder-surface': 'surface.reorder',
  'drag-surface-to-split': 'surface.drag_to_split',

  'send': 'surface.send_text',
  'send-key': 'surface.send_key',
  'send-panel': 'surface.send_text',
  'send-key-panel': 'surface.send_key',
  'read-screen': 'surface.read_text',
  'capture-pane': 'surface.read_text',

  'rename-tab': 'tab.action',

  'notify': 'notification.create',
  'list-notifications': 'notification.list',
  'clear-notifications': 'notification.clear',

  // Browser subcommands are handled specially below
};

/** CLI flags that map to socket param names */
const FLAG_MAP: Record<string, { param: string; type: 'string' | 'int' | 'bool' }> = {
  '--workspace': { param: 'workspace_id', type: 'string' },
  '--surface': { param: 'surface_id', type: 'string' },
  '--pane': { param: 'pane_id', type: 'string' },
  '--panel': { param: 'surface_id', type: 'string' }, // panels are surfaces
  '--window': { param: 'window_id', type: 'string' },
  '--tab': { param: 'tab_id', type: 'string' },
  '--target-pane': { param: 'target_pane_id', type: 'string' },
  '--cwd': { param: 'cwd', type: 'string' },
  '--command': { param: 'command', type: 'string' },
  '--lines': { param: 'lines', type: 'int' },
  '--scrollback': { param: 'scrollback', type: 'bool' },
  '--all': { param: 'all', type: 'bool' },
  '--json': { param: '_json', type: 'bool' }, // ignored
  '--direction': { param: 'direction', type: 'string' },
  '--type': { param: 'type', type: 'string' },
  '--url': { param: 'url', type: 'string' },
  '--title': { param: 'title', type: 'string' },
  '--subtitle': { param: 'subtitle', type: 'string' },
  '--body': { param: 'body', type: 'string' },
  '--icon': { param: 'icon', type: 'string' },
  '--color': { param: 'color', type: 'string' },
  '--level': { param: 'level', type: 'string' },
  '--source': { param: 'source', type: 'string' },
  '--label': { param: 'label', type: 'string' },
  '--amount': { param: 'amount', type: 'int' },
  '--index': { param: 'index', type: 'int' },
  '--before': { param: 'before', type: 'string' },
  '--after': { param: 'after', type: 'string' },
  '--focus': { param: 'focus', type: 'string' },
  '--out': { param: 'out', type: 'string' },
  '--interactive': { param: 'interactive', type: 'bool' },
  '--compact': { param: 'compact', type: 'bool' },
  '--max-depth': { param: 'max_depth', type: 'int' },
  '--selector': { param: 'selector', type: 'string' },
  '--text': { param: 'text', type: 'string' },
  '--url-contains': { param: 'url_contains', type: 'string' },
  '--load-state': { param: 'load_state', type: 'string' },
  '--timeout-ms': { param: 'timeout_ms', type: 'int' },
  '--content': { param: 'content', type: 'bool' },
  '--select': { param: 'select', type: 'bool' },
};

/** Commands that use the raw text sidebar protocol */
const RAW_SIDEBAR_COMMANDS = new Set([
  'set-status', 'clear-status', 'list-status',
  'set-progress', 'clear-progress',
  'log',
  'sidebar-state',
]);

/** Browser CLI subcommands → socket method mapping */
const BROWSER_METHOD_MAP: Record<string, string> = {
  'open': 'browser.open_split',
  'goto': 'browser.navigate',
  'back': 'browser.back',
  'forward': 'browser.forward',
  'reload': 'browser.reload',
  'snapshot': 'browser.snapshot',
  'screenshot': 'browser.screenshot',
  'eval': 'browser.eval',
  'click': 'browser.click',
  'fill': 'browser.fill',
  'type': 'browser.type',
  'wait': 'browser.wait',
  'get': 'browser.get.text',  // will be refined by property arg
  'tab': 'browser.tab.list', // will be refined by action arg
  'console': 'browser.console.list',
  'errors': 'browser.errors.list',
};

export type SocketCall =
  | { kind: 'json'; method: string; params: Record<string, unknown> }
  | { kind: 'raw'; rawCommand: string; workspaceRef?: string };

/**
 * Translate CLI args like ['send', '--surface', 'surface:8', 'hello']
 * into a SocketCall.
 *
 * Returns null only if the command is completely unrecognized.
 */
export function cliArgsToSocketCall(args: string[]): SocketCall | null {
  if (args.length === 0) return null;

  const command = args[0];

  // Handle browser subcommands
  if (command === 'browser') {
    return translateBrowserArgs(args.slice(1));
  }

  // Handle raw sidebar protocol commands
  if (RAW_SIDEBAR_COMMANDS.has(command)) {
    return translateSidebarArgs(command, args.slice(1));
  }

  const method = METHOD_MAP[command];
  if (!method) return null;

  // Parse flags and positional args
  const params: Record<string, unknown> = {};
  const positionals: string[] = [];
  let i = 1;

  while (i < args.length) {
    const arg = args[i];
    if (arg === '--') {
      // Everything after -- is positional
      positionals.push(...args.slice(i + 1));
      break;
    }

    const flagDef = FLAG_MAP[arg];
    if (flagDef) {
      if (flagDef.type === 'bool') {
        params[flagDef.param] = true;
        i++;
      } else {
        i++;
        const val = args[i];
        if (val === undefined) { i++; continue; }
        if (flagDef.param === '_json') { i++; continue; } // skip --json
        params[flagDef.param] = flagDef.type === 'int' ? parseInt(val, 10) : val;
        i++;
      }
    } else if (arg.startsWith('-') && arg.length === 2) {
      // Single-char flags like -L, -R, -U, -D for resize
      params['direction_flag'] = arg.slice(1);
      i++;
    } else {
      positionals.push(arg);
      i++;
    }
  }

  // Handle command-specific positional args and adjustments
  applyPositionals(command, method, params, positionals);

  return { kind: 'json', method, params };
}

/**
 * Apply positional arguments and command-specific param adjustments.
 */
function applyPositionals(
  command: string,
  _method: string,
  params: Record<string, unknown>,
  positionals: string[],
): void {
  switch (command) {
    case 'send':
    case 'send-panel':
      // Last positional is text
      if (positionals.length > 0) params['text'] = positionals[positionals.length - 1];
      break;

    case 'send-key':
    case 'send-key-panel':
      // Last positional is key name
      if (positionals.length > 0) params['key'] = positionals[positionals.length - 1];
      break;

    case 'rename-workspace':
      // Positional is title
      if (positionals.length > 0) params['title'] = positionals[positionals.length - 1];
      params['action'] = 'rename';
      break;

    case 'rename-window':
      if (positionals.length > 0) params['title'] = positionals[positionals.length - 1];
      params['action'] = 'rename_window';
      break;

    case 'rename-tab':
      if (positionals.length > 0) params['title'] = positionals[positionals.length - 1];
      params['action'] = 'rename';
      break;

    case 'new-split':
    case 'drag-surface-to-split':
      // First positional is direction
      if (positionals.length > 0) params['direction'] = positionals[0];
      break;

    case 'new-workspace':
      // Positional might be title
      if (positionals.length > 0) params['title'] = positionals[0];
      break;

    case 'resize-pane': {
      // Convert -L/-R/-U/-D flag to direction param
      const df = params['direction_flag'];
      if (df) {
        const dirMap: Record<string, string> = { L: 'left', R: 'right', U: 'up', D: 'down' };
        params['direction'] = dirMap[df as string] ?? df;
        delete params['direction_flag'];
      }
      break;
    }

    case 'find-window':
      if (positionals.length > 0) params['query'] = positionals[0];
      break;

    default:
      // For other commands, add positionals generically
      if (positionals.length === 1) {
        // Single positional — usually a text/title/query value
        if (!params['text'] && !params['title']) {
          params['text'] = positionals[0];
        }
      }
      break;
  }
}

/**
 * Translate browser subcommand args.
 */
function translateBrowserArgs(args: string[]): SocketCall | null {
  // Parse out --surface flag first
  const params: Record<string, unknown> = {};
  const remaining: string[] = [];

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--surface' && i + 1 < args.length) {
      params['surface_id'] = args[i + 1];
      i++;
    } else {
      remaining.push(args[i]);
    }
  }

  if (remaining.length === 0) return null;

  const subCommand = remaining[0];
  let method = BROWSER_METHOD_MAP[subCommand];
  if (!method) return null;

  const positionals = remaining.slice(1);

  // Parse remaining flags from positionals
  const extraPositionals: string[] = [];
  for (let i = 0; i < positionals.length; i++) {
    const flagDef = FLAG_MAP[positionals[i]];
    if (flagDef) {
      if (flagDef.type === 'bool') {
        params[flagDef.param] = true;
      } else if (i + 1 < positionals.length) {
        i++;
        params[flagDef.param] = flagDef.type === 'int' ? parseInt(positionals[i], 10) : positionals[i];
      }
    } else {
      extraPositionals.push(positionals[i]);
    }
  }

  // Command-specific positional handling
  switch (subCommand) {
    case 'goto':
      method = 'browser.navigate';
      if (extraPositionals.length > 0) params['url'] = extraPositionals[0];
      break;
    case 'open':
      if (extraPositionals.length > 0) params['url'] = extraPositionals[0];
      break;
    case 'eval':
      if (extraPositionals.length > 0) params['script'] = extraPositionals[0];
      break;
    case 'click':
      if (extraPositionals.length > 0) params['selector'] = extraPositionals[0];
      break;
    case 'fill':
      if (extraPositionals.length > 0) params['selector'] = extraPositionals[0];
      if (extraPositionals.length > 1) params['value'] = extraPositionals[1];
      break;
    case 'type':
      if (extraPositionals.length > 0) params['selector'] = extraPositionals[0];
      if (extraPositionals.length > 1) params['text'] = extraPositionals[1];
      break;
    case 'get': {
      // get <property> [selector] [attribute]
      const prop = extraPositionals[0];
      if (prop) {
        const getMethodMap: Record<string, string> = {
          url: 'browser.url.get',
          title: 'browser.get.title',
          text: 'browser.get.text',
          html: 'browser.get.html',
          value: 'browser.get.value',
          attr: 'browser.get.attr',
          count: 'browser.get.count',
          box: 'browser.get.box',
          styles: 'browser.get.styles',
        };
        method = getMethodMap[prop] ?? `browser.get.${prop}`;
      }
      if (extraPositionals.length > 1) params['selector'] = extraPositionals[1];
      if (extraPositionals.length > 2) params['attribute'] = extraPositionals[2];
      break;
    }
    case 'tab': {
      // tab <action> [index]
      const action = extraPositionals[0];
      if (action) {
        const tabMethodMap: Record<string, string> = {
          new: 'browser.tab.new',
          list: 'browser.tab.list',
          switch: 'browser.tab.switch',
          close: 'browser.tab.close',
        };
        method = tabMethodMap[action] ?? `browser.tab.${action}`;
      }
      if (extraPositionals.length > 1) params['tab_index'] = extraPositionals[1];
      break;
    }
    case 'console':
    case 'errors': {
      // console/errors <action>
      const action = extraPositionals[0];
      if (action === 'clear') {
        method = subCommand === 'console' ? 'browser.console.clear' : 'browser.errors.list';
      }
      break;
    }
    case 'snapshot':
      // Flags already parsed above (--interactive, --compact, --max-depth, --selector)
      break;
    case 'screenshot':
      // --out already parsed
      break;
    case 'wait':
      // All params come from flags, already parsed
      break;
  }

  return { kind: 'json', method, params };
}

// ---------------------------------------------------------------------------
// Sidebar raw text protocol translator
// ---------------------------------------------------------------------------

/**
 * Translate sidebar CLI commands into raw text socket calls.
 *
 * The sidebar protocol uses raw text on the same Unix socket:
 *   set_status key "value" --tab=<UUID>
 *   list_status --tab=<UUID>
 *   sidebar_state --tab=<UUID>
 * etc.
 *
 * The workspace ref must be resolved to a UUID before sending.
 * This resolution happens in cmux() in cmux-mcp.ts, not here.
 * We return { kind: 'raw', rawCommand, workspaceRef } and let
 * the caller handle UUID resolution + sending.
 */
function translateSidebarArgs(command: string, remaining: string[]): SocketCall {
  // Parse --workspace flag from remaining args
  let workspaceRef: string | undefined;
  const filteredArgs: string[] = [];

  for (let i = 0; i < remaining.length; i++) {
    if (remaining[i] === '--workspace' && i + 1 < remaining.length) {
      workspaceRef = remaining[i + 1];
      i++;
    } else if (remaining[i] === '--') {
      // Everything after -- is positional
      filteredArgs.push(...remaining.slice(i));
      break;
    } else {
      filteredArgs.push(remaining[i]);
    }
  }

  // Convert CLI command to raw protocol command name (hyphens → underscores)
  const rawCmd = command.replace(/-/g, '_');

  // Build the raw command string (UUID placeholder will be filled by caller)
  // Format: command_name [args...] --tab=<UUID>
  let raw: string;

  switch (command) {
    case 'set-status': {
      // set-status key value [--icon icon] [--color color]
      const key = filteredArgs[0] ?? '';
      const value = filteredArgs[1] ?? '';
      const extras: string[] = [];
      for (let i = 2; i < filteredArgs.length; i++) {
        if (filteredArgs[i] === '--icon' && i + 1 < filteredArgs.length) {
          extras.push(`--icon=${filteredArgs[++i]}`);
        } else if (filteredArgs[i] === '--color' && i + 1 < filteredArgs.length) {
          extras.push(`--color=${filteredArgs[++i]}`);
        }
      }
      raw = `${rawCmd} ${key} ${quoteIfNeeded(value)}${extras.length ? ' ' + extras.join(' ') : ''}`;
      break;
    }
    case 'clear-status': {
      // clear-status key
      const key = filteredArgs[0] ?? '';
      raw = `${rawCmd} ${key}`;
      break;
    }
    case 'list-status':
      raw = rawCmd;
      break;
    case 'set-progress': {
      // set-progress 0.5 [--label text]
      const value = filteredArgs[0] ?? '0';
      const labelIdx = filteredArgs.indexOf('--label');
      const label = labelIdx >= 0 ? filteredArgs[labelIdx + 1] : undefined;
      raw = `${rawCmd} ${value}${label ? ' --label=' + quoteIfNeeded(label) : ''}`;
      break;
    }
    case 'clear-progress':
      raw = rawCmd;
      break;
    case 'log': {
      // log [--level level] [--source source] -- message
      const extras: string[] = [];
      let message = '';
      let hitDash = false;
      for (let i = 0; i < filteredArgs.length; i++) {
        if (filteredArgs[i] === '--') { hitDash = true; continue; }
        if (hitDash) { message += (message ? ' ' : '') + filteredArgs[i]; continue; }
        if (filteredArgs[i] === '--level' && i + 1 < filteredArgs.length) {
          extras.push(`--level=${filteredArgs[++i]}`);
        } else if (filteredArgs[i] === '--source' && i + 1 < filteredArgs.length) {
          extras.push(`--source=${filteredArgs[++i]}`);
        } else {
          message += (message ? ' ' : '') + filteredArgs[i];
        }
      }
      raw = `${rawCmd}${extras.length ? ' ' + extras.join(' ') : ''} -- ${quoteIfNeeded(message)}`;
      break;
    }
    case 'sidebar-state':
      raw = rawCmd;
      break;
    default:
      raw = `${rawCmd} ${filteredArgs.join(' ')}`;
  }

  return { kind: 'raw', rawCommand: raw.trim(), workspaceRef };
}

function quoteIfNeeded(s: string): string {
  if (s.includes(' ') || s.includes('"') || s.includes("'")) {
    return `"${s.replace(/"/g, '\\"')}"`;
  }
  return s;
}

// ---------------------------------------------------------------------------
// Response formatter
// ---------------------------------------------------------------------------

/**
 * Convert a socket JSON response to the string format that cmux() callers expect.
 */
export function formatResponse(method: string, result: any): string {
  if (result === undefined || result === null) return 'OK';

  switch (method) {
    case 'system.ping':
      return 'PONG';

    case 'surface.read_text':
      return typeof result.text === 'string' ? result.text : JSON.stringify(result, null, 2);

    case 'surface.send_text':
    case 'surface.send_key':
      // Include ref info so callers can extract refs if needed
      if (result.workspace_ref || result.surface_ref) {
        return `OK ${result.surface_ref ?? ''}`.trim();
      }
      return 'OK';

    case 'workspace.create': {
      const ref = result.workspace_ref ?? '';
      return `OK ${ref}`.trim();
    }

    case 'workspace.action':
      return result.title ? `OK ${result.workspace_ref ?? ''}` : JSON.stringify(result, null, 2);

    case 'surface.split':
    case 'surface.create':
    case 'pane.create': {
      const ref = result.surface_ref ?? result.pane_ref ?? '';
      return `OK ${ref}`.trim();
    }

    case 'surface.close':
    case 'surface.move':
    case 'surface.reorder':
    case 'surface.drag_to_split':
    case 'workspace.select':
    case 'workspace.close':
    case 'workspace.reorder':
    case 'workspace.move_to_window':
    case 'window.focus':
    case 'window.close':
    case 'pane.focus':
    case 'pane.resize':
    case 'pane.swap':
    case 'pane.break':
    case 'pane.join':
    case 'notification.create':
    case 'notification.clear':
    case 'tab.action':
      return `OK ${result.workspace_ref ?? result.surface_ref ?? ''}`.trim();

    default:
      // For list/tree/identify/etc, return JSON — regex parsers like
      // workspace:\d+ still match inside JSON strings
      return JSON.stringify(result, null, 2);
  }
}
