/**
 * The host's capabilities, for code that has already established it has them.
 *
 * Most callers ask first — `capabilities.hostTools`, or a `null` check — and
 * then use the thing. Written as two separate `resolveBridge()` calls that is
 * two separate expressions, and the compiler cannot know the second refers to
 * what the first checked. These say "I have asked, give it to me", and if the
 * answer turns out to be no they throw a sentence instead of a `TypeError` on
 * a property of null.
 *
 * They are not a way to skip asking. A screen that calls one without checking
 * has a bug, and it will say so.
 */
import { resolveBridge } from './index';
import type {
  AppToolsAPI,
  DriveTransferAPI,
  ExplorerAPI,
  ExtensionsAPI,
  HostToolsAPI,
  MCPAPI,
} from './types';

function must<T>(value: T | null, what: string): T {
  if (!value) throw new Error(`this host does not provide ${what}`);
  return value;
}

/** The filesystem of the machine the renderer is displayed on. */
export const requireFiles = (): ExplorerAPI => must(resolveBridge().files, 'a local filesystem');
/** Streamed uploads and downloads, which the renderer must not do itself. */
export const requireTransfers = (): DriveTransferAPI => must(resolveBridge().transfers, 'file transfers');
/** Tools the assistant runs against this machine, behind an approval. */
export const requireHostTools = (): HostToolsAPI => must(resolveBridge().hostTools, 'host tools');
/** The tools that drive the app itself. */
export const requireAppTools = (): AppToolsAPI => must(resolveBridge().appTools, 'app tools');
/** MCP servers started here as child processes. */
export const requireMcp = (): MCPAPI => must(resolveBridge().mcp, 'locally started MCP servers');
/** Installing and launching other applications on this machine. */
export const requireExtensions = (): ExtensionsAPI => must(resolveBridge().extensions, 'installing other applications');
