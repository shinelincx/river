import { test } from '@playwright/test';

test.describe('私人牌局浏览器验收待办', () => {
  test('新设备在有效邀请深链中创建游客身份并加入私人房', () => {
    test.skip(true, 'TODO: 深链加入流程尚未实现');
  });

  test('房主与受邀玩家在独立 Cookie 上下文中只看到各自允许的积分与手牌信息', () => {
    test.skip(true, 'TODO: 完整的多浏览器房间流程尚未实现');
  });

  test('关闭或轮换邀请码后，旧深链不能创建新成员', () => {
    test.skip(true, 'TODO: 邀请码轮换与深链尚未实现');
  });

  test('6 人和 9 人桌在 Chromium 桌面与移动视口中保持本地玩家底部和物理座位稳定', () => {
    test.skip(true, 'TODO: 可验收的座位状态机尚未实现');
  });
});
