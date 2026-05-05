declare module "tweakpane" {
  export type TpChangeEvent<T = unknown> = {
    value: T;
  };

  export type BindingApi<T = unknown> = {
    on(eventName: "change", handler: (event: TpChangeEvent<T>) => void): BindingApi<T>;
  };

  export type ButtonApi = {
    on(eventName: "click", handler: () => void): ButtonApi;
  };

  export type FolderApi = {
    addBinding<T extends Record<string, unknown>, K extends keyof T>(
      target: T,
      key: K,
      options?: Record<string, unknown>,
    ): BindingApi<T[K]>;
    addButton(options: { title: string }): ButtonApi;
  };

  export class Pane {
    constructor(config?: { container?: HTMLElement; title?: string });
    registerPlugin(plugin: unknown): void;
    addFolder(options: { title: string; expanded?: boolean }): FolderApi;
    addBinding<T extends Record<string, unknown>, K extends keyof T>(
      target: T,
      key: K,
      options?: Record<string, unknown>,
    ): BindingApi<T[K]>;
    addButton(options: { title: string }): ButtonApi;
    refresh(): void;
    dispose(): void;
  }
}

declare module "tweakpane-plugin-file-import" {
  export const css: string;
  export const id: string;
  export const plugins: unknown[];
}
