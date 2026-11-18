// 示例场景：验证 fixture 插件的工具注册、守卫拒绝与真执行。
export default async ({ ctx, defs, step }) => {
  step('P0 官方服务挂载（ToolsService）', !!(ctx.tools && typeof ctx.tools.checkGuards === 'function'));
  const names = defs.map(d => d.name);
  step('P0 fixture.echo 注册在案（官方 definitions() 可见）', names.includes('fixture.echo'), names.join(','));
  const def = defs.find(d => d.name === 'fixture.echo');
  step('P0 定义带 schema + execute + render',
    !!(def && def.parameters && def.parameters.properties && def.parameters.properties.message && typeof def.execute === 'function' && def.output && typeof def.output.render === 'function'));
  const deny = ctx.tools.checkGuards({ name: 'fixture.echo', args: { message: 'DENY_ME' } });
  step('P1 官方守卫链拒绝 DENY_ME',
    String((deny && deny.info && deny.info.code) || '').includes('FIXTURE_DENY') || String((deny && deny.reason) || '').includes('FIXTURE_DENY'),
    '模型可见: ' + (deny ? 'Error: ' + String(deny.reason).slice(0, 60) : '(放行了!)'));
  const out = await def.execute({ message: 'hello lab' }, { name: 'fixture.echo' });
  step('P2 真执行回显', out && out.echo === 'hello lab' && out.ok === true, JSON.stringify(out));
};
