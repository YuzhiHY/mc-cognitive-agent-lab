module.exports.run = async ({ api, ctx }) => {
  const goal = ctx?.task?.goal || 'demo';
  api.chat(`[agent] goal=${goal}`);
  await api.sleep(300);
  return { done: true, note: 'hello sent' };
};