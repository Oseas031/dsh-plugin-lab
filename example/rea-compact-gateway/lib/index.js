/**
 * dsh-mcp-compact-gateway — 试验用 bundle。
 * 真正的工具面由 dsh.patch.yml 里的 @deepseek-ai/dsh-mcp-client 条目提供（它连 gateway.mjs）；
 * 本入口只负责让包可被 dsh plugin add 识别，不做别的事。
 */
export const name = 'rea-compact-gateway';
export const inject = [];
export function apply() {}
export default { name, inject, apply };
