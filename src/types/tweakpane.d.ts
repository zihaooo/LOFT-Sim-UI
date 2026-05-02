declare module "tweakpane" {
  export type BindingApi = {
    on(eventName: "change", handler: () => void): BindingApi;
  };

  export type ButtonApi = {
    on(eventName: "click", handler: () => void): ButtonApi;
  };

  export class Pane {
    constructor(config?: { container?: HTMLElement; title?: string });
    addBinding<T extends Record<string, unknown>, K extends keyof T>(
      target: T,
      key: K,
      options?: Record<string, unknown>,
    ): BindingApi;
    addButton(options: { title: string }): ButtonApi;
    refresh(): void;
    dispose(): void;
  }
}
