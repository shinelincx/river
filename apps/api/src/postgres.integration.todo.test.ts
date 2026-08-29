import { describe, it } from 'vitest';

describe('PostgreSQL + Testcontainers 集成待办', () => {
  it.todo('在隔离 PostgreSQL 容器中执行迁移，并验证事件与活跃手牌快照的原子写入');
  it.todo('从持久化快照和事件序列重建活跃手牌，并执行到期后的唯一自动动作');
  it.todo('以事务回滚隔离每个测试，并验证 10 天历史过期任务不会删除未到期材料');
});
