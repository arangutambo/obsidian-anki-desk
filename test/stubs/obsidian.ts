// Minimal stand-in so modules that import "obsidian" can be loaded under vitest.
export class Plugin {}
export class Modal {}
export class SuggestModal<T> { constructor(..._a: unknown[]) {} getSuggestions(_q: string): T[] { return []; } }
export class PluginSettingTab {}
export class Setting {}
export class Notice { constructor(_m: string) {} }
export const Platform = { isDesktopApp: true, isMobile: false };
export async function requestUrl(): Promise<{ text: string }> { return { text: "" }; }
