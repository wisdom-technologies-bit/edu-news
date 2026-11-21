/**
 * Ambient declarations for optional dependencies.
 *
 * These modules are intentionally not installed by default:
 *   • `playwright` pulls a ~300 MB browser download and is only needed when
 *     ENABLE_BROWSER_RENDERER=true (Guardian Nigeria, TheCable).
 *   • `turndown-plugin-gfm` ships no type declarations.
 *
 * Declaring them here keeps `tsc` happy without forcing the download on
 * everyone who deploys the API.
 */

declare module 'playwright' {
  export interface PlaywrightPage {
    goto(url: string, options?: { waitUntil?: string; timeout?: number }): Promise<unknown>;
    waitForTimeout(ms: number): Promise<void>;
    content(): Promise<string>;
    url(): string;
  }

  export interface PlaywrightContext {
    newPage(): Promise<PlaywrightPage>;
  }

  export interface PlaywrightBrowser {
    newContext(options?: Record<string, unknown>): Promise<PlaywrightContext>;
    close(): Promise<void>;
  }

  export const chromium: {
    launch(options?: Record<string, unknown>): Promise<PlaywrightBrowser>;
  };
}

declare module 'turndown-plugin-gfm' {
  import type TurndownService from 'turndown';

  export const gfm: TurndownService.Plugin;
  export const tables: TurndownService.Plugin;
  export const strikethrough: TurndownService.Plugin;
  export const taskListItems: TurndownService.Plugin;
  export const highlightedCodeBlock: TurndownService.Plugin;
}
