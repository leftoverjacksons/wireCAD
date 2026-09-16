declare module 'opencascade.js/dist/opencascade.wasm.js' {
  const factory: (options?: Record<string, unknown>) => Promise<unknown>;
  export default factory;
}
