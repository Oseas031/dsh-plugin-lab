// 示例插件：最小可用目标，供 lab 验收演示与自测使用（无任何外部依赖）。
export const name = 'fixture-echo';
export const inject = ['tools'];
export function apply(ctx, config = {}) {
  ctx.tools.register({
    name: 'fixture.echo',
    description: '示例工具：回显消息；消息为 DENY_ME 时触发守卫拒绝',
    parameters: { type: 'object', properties: { message: { type: 'string' } }, required: ['message'], additionalProperties: false },
    output: {
      schema: { type: 'object', properties: { echo: { type: 'string' }, ok: { type: 'boolean' } }, required: ['echo', 'ok'], additionalProperties: false },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    async execute(args) { return { echo: args.message, ok: true }; },
  });
  ctx.tools.guard((exec) => {
    if (String(exec?.name ?? '').toLowerCase() === 'fixture.echo' && String(exec?.args?.message ?? '') === 'DENY_ME')
      return { reason: 'FIXTURE_DENY: 示例守卫拒绝 DENY_ME 消息', info: { code: 'FIXTURE_DENY' } };
    return undefined;
  });
}
export default { name, inject, apply };
